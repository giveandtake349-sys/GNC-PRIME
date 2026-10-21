import { Router, type Response } from "express";
import { realUser, requireAuth, type AuthedRequest } from "../auth.js";
import { query } from "../db.js";

export const conversationsRouter = Router();

// Conversation history (Build Step 3) — mounted at /api/conversations.
// Real accounts only (dev mode is stateless and keeps no history).
// GET /              → the user's conversations, most recent first
// GET /:id/messages  → one conversation's messages, oldest first

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function serverError(res: Response, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  console.error("conversations route error:", msg);
  res.status(500).json({ error: msg });
}

type ConvRow = {
  id: string;
  title: string | null;
  gnc_model: string;
  updated_at: string;
};

type MsgRow = {
  id: string;
  role: string;
  content: string;
  engine_used: string | null;
  rating: number | null;
  created_at: string;
};

conversationsRouter.get(
  "/",
  requireAuth,
  async (req: AuthedRequest, res: Response) => {
    const me = realUser(req);
    if (!me) {
      res.status(401).json({ error: "A signed-in account is required" });
      return;
    }
    try {
      const result = await query<ConvRow>(
        "select id, title, gnc_model, updated_at from public.conversations where user_id = $1 order by updated_at desc",
        [me.userId],
      );
      res.json({ conversations: result.rows });
    } catch (err) {
      serverError(res, err);
    }
  },
);

conversationsRouter.get(
  "/:id/messages",
  requireAuth,
  async (req: AuthedRequest, res: Response) => {
    const me = realUser(req);
    if (!me) {
      res.status(401).json({ error: "A signed-in account is required" });
      return;
    }
    const convId = typeof req.params.id === "string" ? req.params.id : "";
    if (!UUID_RE.test(convId)) {
      res.status(404).json({ error: "Conversation not found" });
      return;
    }
    try {
      const owned = await query<{ id: string }>(
        "select id from public.conversations where id = $1 and user_id = $2",
        [convId, me.userId],
      );
      if (!owned.rows[0]) {
        res.status(404).json({ error: "Conversation not found" });
        return;
      }
      const result = await query<MsgRow>(
        "select id, role, content, engine_used, rating, created_at from public.messages where conversation_id = $1 order by created_at asc",
        [convId],
      );
      res.json({ messages: result.rows });
    } catch (err) {
      serverError(res, err);
    }
  },
);
