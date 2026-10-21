import { Router, type Response } from "express";
import { realUser, requireAuth, type AuthedRequest } from "../auth.js";
import { query } from "../db.js";
import { routeChat } from "../gateway/router.js";
import {
  GNC_MODELS,
  type ChatHistoryEntry,
  type GncModelId,
} from "../gateway/types.js";
import { extractAndStoreMemories, recallMemories } from "../memory.js";

export const chatRouter = Router();

// POST /api/chat — behind requireAuth (Build Step 3).
// - Dev mode (DEV_AUTH bypass): stateless, exactly the Step 1–2 behavior —
//   no DB reads or writes.
// - Real account: daily-cap check → conversation (existing, ownership
//   checked, or new) → last-10 history → memory recall → gateway →
//   persist both messages + usage → fire-and-forget memory extraction.
// Response: { reply, engineUsed, conversationId, assistantMessageId }
// (conversationId / assistantMessageId are null in dev mode).

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function serverError(res: Response, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  console.error("chat route error:", msg);
  res.status(500).json({ error: msg });
}

type ChatBody = {
  model?: string;
  message?: string;
  conversationId?: string;
};

chatRouter.post(
  "/chat",
  requireAuth,
  async (req: AuthedRequest, res: Response) => {
    const { model, message, conversationId } = (req.body ?? {}) as ChatBody;
    if (!message || typeof message !== "string") {
      res.status(400).json({ error: "message is required" });
      return;
    }
    const modelId = (model ?? "gnc-flash") as GncModelId;
    if (!GNC_MODELS.some((m) => m.id === modelId)) {
      res.status(400).json({ error: `Unknown model: ${modelId}` });
      return;
    }

    // ---- Dev mode: stateless passthrough, no DB. ----
    if (req.user?.dev) {
      try {
        const result = await routeChat(modelId, message);
        res.json({
          reply: result.reply,
          engineUsed: result.engineUsed,
          conversationId: null,
          assistantMessageId: null,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        res.status(502).json({ error: msg });
      }
      return;
    }

    const me = realUser(req);
    if (!me) {
      res.status(401).json({ error: "A signed-in account is required" });
      return;
    }
    const { userId, email } = me;

    try {
      // (a) Daily usage cap for free accounts (owner is exempt).
      const userRows = await query<{ plan: string }>(
        "select plan from public.users where id = $1",
        [userId],
      );
      const plan = userRows.rows[0]?.plan ?? "free";
      const cap = Number.parseInt(process.env.DAILY_MSG_CAP || "20", 10);
      const isOwner =
        !!process.env.OWNER_EMAIL && email === process.env.OWNER_EMAIL;
      if (!isOwner && plan === "free") {
        const usage = await query<{ msg_count: number }>(
          "select msg_count from public.usage_daily where user_id = $1 and day = current_date",
          [userId],
        );
        const count = usage.rows[0]?.msg_count ?? 0;
        if (count >= cap) {
          res.status(429).json({
            error: "Daily free limit reached. Come back tomorrow.",
          });
          return;
        }
      }

      // (b) Conversation: existing (ownership-checked) or new.
      let convId: string;
      if (conversationId) {
        if (!UUID_RE.test(conversationId)) {
          res.status(404).json({ error: "Conversation not found" });
          return;
        }
        const owned = await query<{ id: string }>(
          "select id from public.conversations where id = $1 and user_id = $2",
          [conversationId, userId],
        );
        if (!owned.rows[0]) {
          res.status(404).json({ error: "Conversation not found" });
          return;
        }
        convId = owned.rows[0].id;
      } else {
        const inserted = await query<{ id: string }>(
          "insert into public.conversations (user_id, title, gnc_model, mode) values ($1, $2, $3, 'chat') returning id",
          [userId, message.slice(0, 60), modelId],
        );
        convId = inserted.rows[0].id;
      }

      // (c) History: last 10 messages, oldest → newest.
      const histRows = await query<{ role: string; content: string }>(
        "select role, content from public.messages where conversation_id = $1 order by created_at desc limit 10",
        [convId],
      );
      const history: ChatHistoryEntry[] = histRows.rows
        .reverse()
        .filter((r) => r.role === "user" || r.role === "assistant")
        .map((r) => ({
          role: r.role as "user" | "assistant",
          content: r.content,
        }));

      // (d) Memory recall → extra system context.
      const memories = await recallMemories(userId, message);
      const extraSystem =
        memories.length > 0
          ? "Things you remember about this user (use naturally, do not mention this list):\n" +
            memories.map((m) => `- ${m.text}`).join("\n")
          : undefined;

      // (e) Gateway call.
      let result;
      try {
        result = await routeChat(modelId, message, { history, extraSystem });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        res.status(502).json({ error: msg });
        return;
      }

      // (f) Persist both messages, touch the conversation, count usage.
      const userMsg = await query<{ id: string }>(
        "insert into public.messages (conversation_id, role, content) values ($1, 'user', $2) returning id",
        [convId, message],
      );
      const assistantMsg = await query<{ id: string }>(
        "insert into public.messages (conversation_id, role, content, engine_used, tokens_in, tokens_out) values ($1, 'assistant', $2, $3, $4, $5) returning id",
        [
          convId,
          result.reply,
          result.engineUsed,
          result.tokensIn ?? null,
          result.tokensOut ?? null,
        ],
      );
      await query(
        "update public.conversations set updated_at = now() where id = $1",
        [convId],
      );
      const totalTokens = (result.tokensIn ?? 0) + (result.tokensOut ?? 0);
      await query(
        `insert into public.usage_daily (user_id, day, msg_count, tokens)
         values ($1, current_date, 1, $2)
         on conflict (user_id, day) do update
           set msg_count = public.usage_daily.msg_count + 1,
               tokens = public.usage_daily.tokens + excluded.tokens`,
        [userId, totalTokens],
      );

      // (g) Memory extraction — fire-and-forget, never blocks the reply.
      void extractAndStoreMemories(
        userId,
        message,
        userMsg.rows[0].id,
      ).catch(() => {});

      res.json({
        reply: result.reply,
        engineUsed: result.engineUsed,
        conversationId: convId,
        assistantMessageId: assistantMsg.rows[0].id,
      });
    } catch (err) {
      serverError(res, err);
    }
  },
);

// POST /api/messages/:id/rating { rating: 1 | -1 } — real accounts only.
// The update only lands when the message's conversation belongs to the user.
chatRouter.post(
  "/messages/:id/rating",
  requireAuth,
  async (req: AuthedRequest, res: Response) => {
    const me = realUser(req);
    if (!me) {
      res.status(401).json({ error: "A signed-in account is required" });
      return;
    }
    const { rating } = (req.body ?? {}) as { rating?: number };
    if (rating !== 1 && rating !== -1) {
      res.status(400).json({ error: "rating must be 1 or -1" });
      return;
    }
    const messageId =
      typeof req.params.id === "string" ? req.params.id : "";
    if (!UUID_RE.test(messageId)) {
      res.status(404).json({ error: "Message not found" });
      return;
    }
    try {
      const updated = await query(
        `update public.messages m set rating = $1
         where m.id = $2
           and exists (
             select 1 from public.conversations c
             where c.id = m.conversation_id and c.user_id = $3
           )`,
        [rating, messageId, me.userId],
      );
      if (updated.rowCount === 0) {
        res.status(404).json({ error: "Message not found" });
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      serverError(res, err);
    }
  },
);
