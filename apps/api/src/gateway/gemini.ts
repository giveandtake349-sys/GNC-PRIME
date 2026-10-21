import OpenAI from "openai";
import {
  PartialStreamError,
  StreamAbortedError,
  type ChatRequest,
  type ChatResult,
  type EngineAdapter,
  type TokenSink,
} from "./types.js";

// Gemini via its OpenAI-compatible endpoint (Google AI Studio key).
// Base URL: https://generativelanguage.googleapis.com/v1beta/openai/
//
// Model ids rotate fast: gemini-2.5-flash was retired for new AI Studio
// users and returns 404. So this adapter walks a CHAIN of ids and uses the
// first one the key can actually reach. Setting the GEMINI_MODEL env var at
// deploy time puts that id at the front of the chain — no code change
// needed when Google rotates ids again.

const BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/";

export const GEMINI_MODEL_CHAIN = [
  "gemini-3.8-flash",
  "gemini-3.5-flash",
  "gemini-3-flash",
  "gemini-2.5-flash",
];

export const GEMINI_LITE_CHAIN = [
  "gemini-3.5-flash-lite",
  "gemini-3.5-flash",
  "gemini-3-flash",
];

export interface GeminiOptions {
  reasoningEffort?: "low" | "medium" | "high";
}

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

// Streaming guard: a model id must produce its FIRST token within this
// window (response headers + first chunk); otherwise the chain moves on.
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

export function geminiAdapter(
  chain: string[] = GEMINI_MODEL_CHAIN,
  opts: GeminiOptions = {},
): EngineAdapter {
  const override = process.env.GEMINI_MODEL;
  const models = override
    ? [override, ...chain.filter((m) => m !== override)]
    : chain;

  function makeClient(apiKey: string, timeout: number): OpenAI {
    return new OpenAI({ baseURL: BASE_URL, apiKey, timeout });
  }

  return {
    id: `gemini:${models[0]}`,

    async chat(req: ChatRequest): Promise<ChatResult> {
      const apiKey = process.env.GEMINI_GROUND_API_KEY;
      if (!apiKey) throw new Error("GEMINI_GROUND_API_KEY is not set");
      // 12s per id: the chain has 4 ids, so the whole chain fits inside
      // the router's 60s budget even if the first ids hang.
      const client = makeClient(apiKey, 12_000);
      const messages = buildMessages(req);

      const errors: string[] = [];
      for (const model of models) {
        try {
          const res = await client.chat.completions.create({
            model,
            messages,
            ...(opts.reasoningEffort
              ? { reasoning_effort: opts.reasoningEffort }
              : {}),
          });
          const reply = res.choices[0]?.message?.content ?? "";
          if (!reply) throw new Error("empty reply");
          return {
            reply,
            engineUsed: `gemini:${model}`,
            tokensIn: res.usage?.prompt_tokens,
            tokensOut: res.usage?.completion_tokens,
          };
        } catch (err) {
          errors.push(
            `${model}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      throw new Error(`All Gemini ids failed — ${errors.join(" | ")}`);
    },

    // Streaming twin of chat(): same id chain, but an id only "wins" by
    // producing a first token within FIRST_TOKEN_MS. Once tokens are
    // flowing the id is never abandoned — a later failure surfaces as a
    // PartialStreamError instead of silently restarting the reply.
    async streamChat(req: ChatRequest, onToken: TokenSink): Promise<ChatResult> {
      const apiKey = process.env.GEMINI_GROUND_API_KEY;
      if (!apiKey) throw new Error("GEMINI_GROUND_API_KEY is not set");
      const client = makeClient(apiKey, 60_000);
      const messages = buildMessages(req);

      const errors: string[] = [];
      for (const model of models) {
        const engineUsed = `gemini:${model}`;
        const ac = new AbortController();
        let emitted = "";
        try {
          const deadlineAt = Date.now() + FIRST_TOKEN_MS;
          const remaining = () => Math.max(1, deadlineAt - Date.now());

          const streamPromise = client.chat.completions.create(
            {
              model,
              messages,
              stream: true,
              ...(opts.reasoningEffort
                ? { reasoning_effort: opts.reasoningEffort }
                : {}),
            },
            { signal: ac.signal },
          );
          // If the deadline wins the race we abandon this promise; keep a
          // handler attached so its later rejection is never "unhandled".
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
                engineUsed,
              );
            }
          }
          if (!emitted) throw new Error("empty reply");
          return { reply: emitted, engineUsed, tokensIn, tokensOut };
        } catch (err) {
          if (
            err instanceof StreamAbortedError ||
            err instanceof PartialStreamError
          ) {
            throw err;
          }
          errors.push(
            `${model}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      throw new Error(`All Gemini ids failed — ${errors.join(" | ")}`);
    },
  };
}
