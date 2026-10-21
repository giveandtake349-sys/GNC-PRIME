import OpenAI from "openai";
import {
  PartialStreamError,
  StreamAbortedError,
  type ChatRequest,
  type ChatResult,
  type EngineAdapter,
  type TokenSink,
} from "./types.js";

// OpenCode Zen — model gateway, OpenAI-compatible.
// Base URL: https://opencode.ai/zen/v1
//
// STATUS (verified live 2026-10-22): since September 2026 OpenCode gates
// its FREE tier to calls made from inside the OpenCode app — direct API
// calls from a server get FreeTierError ("OpenCode's free tier can only be
// used from within OpenCode"). So these adapters currently fail over and
// exist only as last-resort fallbacks; paid Zen models (prepaid balance)
// would work through the same code. Ids below match the live /v1/models
// catalog as of 2026-10-22; free ids are promotional and rotate.

const BASE_URL = "https://opencode.ai/zen/v1";

export const ZEN_BIG_PICKLE = "big-pickle";
export const ZEN_MIMO_FLASH = "mimo-v2.6-flash-free";
export const ZEN_DEEPSEEK_FLASH = "deepseek-v4.1-flash-free";
export const ZEN_NEMOTRON_LIGHTNING = "nemotron-3.5-lightning-free";

function buildMessages(
  req: ChatRequest,
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
  if (req.system) messages.push({ role: "system", content: req.system });
  for (const turn of req.history ?? []) {
    messages.push({ role: turn.role, content: turn.content });
  }
  messages.push({ role: "user", content: req.message });
  return messages;
}

// Streaming guard: the model must produce its FIRST token within this
// window (response headers + first chunk), same rule as the Gemini chain.
const FIRST_TOKEN_MS = 15_000;

function withDeadline<T>(
  p: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(
        () => reject(new Error(`Timeout after ${ms}ms: ${label}`)),
        ms,
      ),
    ),
  ]);
}

export function zenAdapter(model: string): EngineAdapter {
  const id = `zen:${model}`;
  return {
    id,

    async chat(req: ChatRequest): Promise<ChatResult> {
      const apiKey = process.env.OPENCODE_API_KEY;
      if (!apiKey) throw new Error("OPENCODE_API_KEY is not set");
      const client = new OpenAI({ baseURL: BASE_URL, apiKey, timeout: 30_000 });
      const messages = buildMessages(req);
      const res = await client.chat.completions.create({ model, messages });
      const reply = res.choices[0]?.message?.content ?? "";
      if (!reply) throw new Error(`Empty reply from ${id}`);
      return {
        reply,
        engineUsed: id,
        tokensIn: res.usage?.prompt_tokens,
        tokensOut: res.usage?.completion_tokens,
      };
    },

    // Streaming twin of chat(): single model id, same first-token rule —
    // fail before the first token and the router moves on; die after it
    // and the failure surfaces as a PartialStreamError.
    async streamChat(req: ChatRequest, onToken: TokenSink): Promise<ChatResult> {
      const apiKey = process.env.OPENCODE_API_KEY;
      if (!apiKey) throw new Error("OPENCODE_API_KEY is not set");
      const client = new OpenAI({ baseURL: BASE_URL, apiKey, timeout: 60_000 });
      const messages = buildMessages(req);

      const deadlineAt = Date.now() + FIRST_TOKEN_MS;
      const remaining = () => Math.max(1, deadlineAt - Date.now());
      const ac = new AbortController();

      const streamPromise = client.chat.completions.create(
        { model, messages, stream: true },
        { signal: ac.signal },
      );
      streamPromise.catch(() => {});
      let stream: Awaited<typeof streamPromise>;
      try {
        stream = await withDeadline(
          streamPromise,
          remaining(),
          `first token from ${model}`,
        );
      } catch (err) {
        ac.abort();
        throw err;
      }

      const iterator = stream[Symbol.asyncIterator]();
      const firstNext = iterator.next();
      firstNext.catch(() => {});
      let step: Awaited<typeof firstNext>;
      try {
        step = await withDeadline(
          firstNext,
          remaining(),
          `first token from ${model}`,
        );
      } catch (err) {
        stream.controller.abort();
        throw err;
      }

      let emitted = "";
      let tokensIn: number | undefined;
      let tokensOut: number | undefined;
      while (!step.done) {
        const chunk = step.value;
        if (chunk.usage) {
          tokensIn = chunk.usage.prompt_tokens;
          tokensOut = chunk.usage.completion_tokens;
        }
        const text = chunk.choices[0]?.delta?.content ?? "";
        if (text) {
          emitted += text;
          if (onToken(text) === false) {
            stream.controller.abort();
            throw new StreamAbortedError();
          }
        }
        try {
          step = await iterator.next();
        } catch (err) {
          if (!emitted) throw err;
          throw new PartialStreamError(
            `${model}: ${err instanceof Error ? err.message : String(err)}`,
            emitted,
            id,
          );
        }
      }
      if (!emitted) throw new Error(`Empty reply from ${id}`);
      return { reply: emitted, engineUsed: id, tokensIn, tokensOut };
    },
  };
}
