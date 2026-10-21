import { Router, type Response } from "express";
import {
  comparePassword,
  hashPassword,
  realUser,
  requireAuth,
  signToken,
  type AuthedRequest,
} from "../auth.js";
import { query } from "../db.js";

export const authRouter = Router();

// Auth routes (Build Step 3) — mounted at /api/auth.
// POST /register · POST /login · POST /google · GET /me
// Every handler converts unexpected failures (e.g. DATABASE_URL unset)
// into a clean 500 JSON error instead of crashing the server.

interface UserRow {
  id: string;
  email: string;
  display_name: string | null;
  plan: string;
  password_hash?: string | null;
  google_id?: string | null;
  created_at?: string;
}

function publicUser(row: UserRow) {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    plan: row.plan,
  };
}

function serverError(res: Response, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  console.error("auth route error:", msg);
  res.status(500).json({ error: msg });
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

authRouter.post("/register", async (req: AuthedRequest, res: Response) => {
  const { email, password, displayName } = (req.body ?? {}) as {
    email?: string;
    password?: string;
    displayName?: string;
  };
  if (!email || typeof email !== "string" || !EMAIL_RE.test(email.trim())) {
    res.status(400).json({ error: "A valid email is required" });
    return;
  }
  if (!password || typeof password !== "string" || password.length < 8) {
    res.status(400).json({ error: "Password must be at least 8 characters" });
    return;
  }
  const cleanEmail = email.trim().toLowerCase();
  try {
    const existing = await query<UserRow>(
      "select id from public.users where email = $1",
      [cleanEmail],
    );
    if (existing.rows.length > 0) {
      res
        .status(409)
        .json({ error: "An account with this email already exists" });
      return;
    }
    const passwordHash = await hashPassword(password);
    const inserted = await query<UserRow>(
      "insert into public.users (email, password_hash, display_name, plan) values ($1, $2, $3, 'free') returning id, email, display_name, plan",
      [
        cleanEmail,
        passwordHash,
        typeof displayName === "string" && displayName.trim()
          ? displayName.trim()
          : null,
      ],
    );
    const user = inserted.rows[0];
    res.json({ token: signToken(user.id, user.email), user: publicUser(user) });
  } catch (err) {
    serverError(res, err);
  }
});

authRouter.post("/login", async (req: AuthedRequest, res: Response) => {
  const { email, password } = (req.body ?? {}) as {
    email?: string;
    password?: string;
  };
  if (!email || typeof email !== "string" || !password) {
    res.status(400).json({ error: "Email and password are required" });
    return;
  }
  try {
    const found = await query<UserRow>(
      "select id, email, display_name, plan, password_hash from public.users where email = $1",
      [email.trim().toLowerCase()],
    );
    const user = found.rows[0];
    if (!user) {
      res.status(401).json({ error: "Invalid email or password" });
      return;
    }
    if (!user.password_hash) {
      res.status(400).json({ error: "This account uses Google sign-in" });
      return;
    }
    const ok = await comparePassword(password, user.password_hash);
    if (!ok) {
      res.status(401).json({ error: "Invalid email or password" });
      return;
    }
    res.json({ token: signToken(user.id, user.email), user: publicUser(user) });
  } catch (err) {
    serverError(res, err);
  }
});

authRouter.post("/google", async (req: AuthedRequest, res: Response) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    res.status(501).json({ error: "Google sign-in is not configured yet" });
    return;
  }
  const { idToken } = (req.body ?? {}) as { idToken?: string };
  if (!idToken || typeof idToken !== "string") {
    res.status(400).json({ error: "idToken is required" });
    return;
  }
  try {
    const tokenRes = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`,
    );
    if (!tokenRes.ok) {
      res.status(401).json({ error: "Invalid Google token" });
      return;
    }
    const info = (await tokenRes.json()) as {
      aud?: string;
      sub?: string;
      email?: string;
      email_verified?: string;
      name?: string;
    };
    if (info.aud !== clientId) {
      res.status(401).json({ error: "Google token was issued for another app" });
      return;
    }
    if (info.email_verified !== "true" || !info.email || !info.sub) {
      res.status(401).json({ error: "Google account email is not verified" });
      return;
    }
    const email = info.email.toLowerCase();

    // 1) Known Google identity.
    let found = await query<UserRow>(
      "select id, email, display_name, plan from public.users where google_id = $1",
      [info.sub],
    );
    let user = found.rows[0];
    if (!user) {
      // 2) Existing email account → link the Google identity to it.
      found = await query<UserRow>(
        "select id, email, display_name, plan from public.users where email = $1",
        [email],
      );
      user = found.rows[0];
      if (user) {
        await query("update public.users set google_id = $1 where id = $2", [
          info.sub,
          user.id,
        ]);
      } else {
        // 3) Brand-new account (no password — Google sign-in only).
        const inserted = await query<UserRow>(
          "insert into public.users (email, google_id, display_name, plan) values ($1, $2, $3, 'free') returning id, email, display_name, plan",
          [email, info.sub, info.name ?? null],
        );
        user = inserted.rows[0];
      }
    }
    res.json({ token: signToken(user.id, user.email), user: publicUser(user) });
  } catch (err) {
    serverError(res, err);
  }
});

authRouter.get("/me", requireAuth, async (req: AuthedRequest, res: Response) => {
  const me = realUser(req);
  if (!me) {
    res.status(401).json({ error: "A signed-in account is required" });
    return;
  }
  try {
    const found = await query<UserRow>(
      "select id, email, display_name, plan, created_at from public.users where id = $1",
      [me.userId],
    );
    const user = found.rows[0];
    if (!user) {
      res.status(404).json({ error: "Account not found" });
      return;
    }
    res.json({
      user: { ...publicUser(user), createdAt: user.created_at ?? null },
    });
  } catch (err) {
    serverError(res, err);
  }
});
