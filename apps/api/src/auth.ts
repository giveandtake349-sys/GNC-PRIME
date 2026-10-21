import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import type { NextFunction, Request, Response } from "express";

// Own JWT auth (Build Step 3). Tokens are signed with JWT_SECRET, carry
// { sub: userId, email } and live 7 days. Passwords are bcrypt-hashed
// (10 rounds) in the users table's password_hash column; Google accounts
// have password_hash = null.

export interface AuthedUser {
  userId?: string;
  email?: string;
  /** True only for the stateless DEV_AUTH bypass (no DB identity). */
  dev?: boolean;
}

export interface AuthedRequest extends Request {
  user?: AuthedUser;
}

const SEVEN_DAYS_SECONDS = 7 * 24 * 60 * 60;

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

export async function comparePassword(
  password: string,
  passwordHash: string,
): Promise<boolean> {
  return bcrypt.compare(password, passwordHash);
}

function jwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET is not set");
  return secret;
}

export function signToken(userId: string, email: string): string {
  return jwt.sign({ sub: userId, email }, jwtSecret(), {
    expiresIn: SEVEN_DAYS_SECONDS,
  });
}

export function verifyToken(token: string): { userId: string; email: string } {
  const decoded = jwt.verify(token, jwtSecret());
  if (typeof decoded === "string" || !decoded.sub) {
    throw new Error("Invalid token");
  }
  return {
    userId: decoded.sub,
    email: typeof decoded.email === "string" ? decoded.email : "",
  };
}

/**
 * Gate for authenticated routes:
 * 1. `Authorization: Bearer <jwt>` → req.user = { userId, email }.
 * 2. Else, DEV_AUTH=1 + `x-dev-user` header → req.user = { dev: true }
 *    (stateless dev mode: gateway works, DB routes refuse — see realUser).
 * 3. Otherwise 401.
 */
export function requireAuth(
  req: AuthedRequest,
  res: Response,
  next: NextFunction,
): void {
  const header = req.header("authorization");
  if (header && header.startsWith("Bearer ")) {
    const token = header.slice("Bearer ".length).trim();
    try {
      const { userId, email } = verifyToken(token);
      req.user = { userId, email };
      next();
      return;
    } catch {
      res.status(401).json({ error: "Invalid or expired token" });
      return;
    }
  }
  if (process.env.DEV_AUTH === "1" && req.header("x-dev-user")) {
    req.user = { dev: true };
    next();
    return;
  }
  res.status(401).json({ error: "Authentication required" });
}

/** The signed-in account behind the request, or null (dev mode / none). */
export function realUser(
  req: AuthedRequest,
): { userId: string; email: string } | null {
  if (!req.user || req.user.dev || !req.user.userId) return null;
  return { userId: req.user.userId, email: req.user.email ?? "" };
}
