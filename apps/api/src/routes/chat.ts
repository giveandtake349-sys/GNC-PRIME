import { Router, type Response } from "express";
import { realUser, requireAuth, type AuthedRequest } from "../auth.js";
import { query } from "../db.js";
import { routeChat, routeChatStream } from "../gateway/router.js";
import {
  GNC_MODELS,
  PartialStreamError,
  StreamAbortedError,
  type ChatHistoryEntry,
  type ChatResult,
  type GncModelId,
  type TokenSink,
} from "../gateway/types.js";
import { extractAndStoreMemories, recallMemories } from "../memory.js";

export const chatRouter = Router();

// POST /api/chat and POST /api/chat/stream — behind requireAuth
// (Build Step 3), sharing one pipeline:
// - Dev mode (DEV_AUTH bypass): stateless — no DB reads or writes.
// - Real account: daily-cap check → conversation (existing, ownership
//   checked, or new) → last-10 history → memory recall → gateway →
//   persist both messages + usage → fire-and-forget memory extraction.
// /api/chat answers with one JSON body: { reply, engineUsed,
// conversationId, assistantMessageId } (ids are null in dev mode).
// /api/chat/stream runs the SAME pipeline, then switches to SSE:
//   data: {"type":"token","t":...}            per streamed token
//   data: {"type":"done","engineUsed","conversationId","assistantMessageId"}
//   data: {"type":"error","error",...}        ("partial":true when the
//   reply died mid-stream; partial replies are never persisted)
// Every failure BEFORE the stream opens (auth, validation, cap, unknown
// conversation, DB) stays a plain JSON error with its usual status.

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function serverError(res: Response, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  console.error("chat route error:", msg);
  if (!res.headersSent) res.status(500).json({ error: msg });
}

type ChatBody = {
  model?: string;
  message?: string;
  conversationId?: string;
};

type ParsedBody =
  | {
      ok: true;
      modelId: GncModelId;
      message: string;
      conversationId?: string;
    }
  | { ok: false; error: string };

function parseChatBody(req: AuthedRequest): ParsedBody {
  const { model, message, conversationId } = (req.body ?? {}) as ChatBody;
  if (!message || typeof message !== "string") {
    return { ok: false, error: "message is required" };
  }
  const modelId = (model ?? "gnc-flash") as GncModelId;
  if (!GNC_MODELS.some((m) => m.id === modelId)) {
    return { ok: false, error: `Unknown model: ${modelId}` };
  }
  return {
    ok: true,
    modelId,
    message,
    conversationId:
      typeof conversationId === "string" ? conversationId : undefined,
  };
}

/* ------------------------------------------------------------------ */
/* Shared real-account pipeline (steps a–d) and persistence (f–g)      */
/* ------------------------------------------------------------------ */

type PreparedChat =
  | {
      ok: true;
      convId: string;
      history: ChatHistoryEntry[];
      extraSystem?: string;
    }
  | { ok: false; status: number; error: string };

async function prepareRealChat(
  userId: string,
  email: string,
  modelId: GncModelId,
  message: string,
  conversationId?: string,
): Promise<PreparedChat> {
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
      return {
        ok: false,
        status: 429,
        error: "Daily free limit reached. Come back tomorrow.",
      };
    }
  }

  // (b) Conversation: existing (ownership-checked) or new.
  let convId: string;
  if (conversationId) {
    if (!UUID_RE.test(conversationId)) {
      return { ok: false, status: 404, error: "Conversation not found" };
    }
    const owned = await query<{ id: string }>(
      "select id from public.conversations where id = $1 and user_id = $2",
      [conversationId, userId],
    );
    if (!owned.rows[0]) {
      return { ok: false, status: 404, error: "Conversation not found" };
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

  return { ok: true, convId, history, extraSystem };
}

/**
 * (f) Persist both messages, touch the conversation, count usage.
 * (g) Kick off memory extraction without awaiting it.
 * Returns the assistant message id.
 */
async function persistExchange(
  userId: string,
  convId: string,
  message: string,
  result: ChatResult,
): Promise<string> {
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
  void extractAndStoreMemories(userId, message, userMsg.rows[0].id).catch(
    () => {},
  );

  return assistantMsg.rows[0].id;
}

/* ------------------------------------------------------------------ */
/* POST /api/chat — one JSON answer                                    */
/* ------------------------------------------------------------------ */

chatRouter.post(
  "/chat",
  requireAuth,
  async (req: AuthedRequest, res: Response) => {
    const parsed = parseChatBody(req);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    const { modelId, message, conversationId } = parsed;

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
      const prep = await prepareRealChat(
        userId,
        email,
        modelId,
        message,
        conversationId,
      );
      if (!prep.ok) {
        res.status(prep.status).json({ error: prep.error });
        return;
      }

      // (e) Gateway call.
      let result: ChatResult;
      try {
        result = await routeChat(modelId, message, {
          history: prep.history,
          extraSystem: prep.extraSystem,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        res.status(502).json({ error: msg });
        return;
      }

      const assistantMessageId = await persistExchange(
        userId,
        prep.convId,
        message,
        result,
      );

      res.json({
        reply: result.reply,
        engineUsed: result.engineUsed,
        conversationId: prep.convId,
        assistantMessageId,
      });
    } catch (err) {
      serverError(res, err);
    }
  },
);

/* ------------------------------------------------------------------ */
/* POST /api/chat/stream — SSE token stream                            */
/* ------------------------------------------------------------------ */

type PersistFn = (result: ChatResult) => Promise<{
  conversationId: string | null;
  assistantMessageId: string | null;
}>;

function endQuietly(res: Response): void {
  if (!res.writableEnded) {
    try {
      res.end();
    } catch {
      // Socket already gone.
    }
  }
}

/**
 * Switch the response to SSE and stream one exchange. `persist` runs only
 * after a complete, still-connected reply; pass null in dev mode (done
 * event then carries null ids).
 */
async function streamChatResponse(
  res: Response,
  args: {
    modelId: GncModelId;
    message: string;
    history?: ChatHistoryEntry[];
    extraSystem?: string;
    persist: PersistFn | null;
  },
): Promise<void> {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  // The response 'close' event fires when the connection dies before the
  // response completes — that flag is what stops generation and keeps a
  // half-shown exchange out of the database.
  let disconnected = false;
  res.on("close", () => {
    disconnected = true;
  });

  const send = (payload: Record<string, unknown>): void => {
    if (disconnected || res.writableEnded) return;
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };
  const onToken: TokenSink = (t) => {
    if (disconnected) return false;
    send({ type: "token", t });
    return true;
  };

  try {
    const result = await routeChatStream(
      args.modelId,
      args.message,
      { history: args.history, extraSystem: args.extraSystem },
      onToken,
    );
    if (disconnected) {
      endQuietly(res);
      return;
    }

    let conversationId: string | null = null;
    let assistantMessageId: string | null = null;
    if (args.persist) {
      try {
        const saved = await args.persist(result);
        conversationId = saved.conversationId;
        assistantMessageId = saved.assistantMessageId;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("chat stream persist error:", msg);
        send({
          type: "error",
          error: `Reply received but could not be saved: ${msg}`,
        });
        endQuietly(res);
        return;
      }
    }

    send({
      type: "done",
      engineUsed: result.engineUsed,
      conversationId,
      assistantMessageId,
    });
    endQuietly(res);
  } catch (err) {
    if (err instanceof StreamAbortedError || disconnected) {
      endQuietly(res);
      return;
    }
    if (err instanceof PartialStreamError) {
      // Part of this reply is already on the user's screen and the rest
      // is lost; the partial text is deliberately NOT persisted.
      send({ type: "error", error: err.message, partial: true });
      endQuietly(res);
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    send({ type: "error", error: msg });
    endQuietly(res);
  }
}

chatRouter.post(
  "/chat/stream",
  requireAuth,
  async (req: AuthedRequest, res: Response) => {
    const parsed = parseChatBody(req);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    const { modelId, message, conversationId } = parsed;

    // ---- Dev mode: stateless stream, no DB. ----
    if (req.user?.dev) {
      await streamChatResponse(res, { modelId, message, persist: null });
      return;
    }

    const me = realUser(req);
    if (!me) {
      res.status(401).json({ error: "A signed-in account is required" });
      return;
    }

    // Pipeline runs BEFORE the SSE switch: its failures (cap 429,
    // unknown conversation 404, DB 500) stay plain JSON responses.
    let prep: PreparedChat;
    try {
      prep = await prepareRealChat(
        me.userId,
        me.email,
        modelId,
        message,
        conversationId,
      );
    } catch (err) {
      serverError(res, err);
      return;
    }
    if (!prep.ok) {
      res.status(prep.status).json({ error: prep.error });
      return;
    }

    const convId = prep.convId;
    await streamChatResponse(res, {
      modelId,
      message,
      history: prep.history,
      extraSystem: prep.extraSystem,
      persist: async (result) => ({
        conversationId: convId,
        assistantMessageId: await persistExchange(
          me.userId,
          convId,
          message,
          result,
        ),
      }),
    });
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
