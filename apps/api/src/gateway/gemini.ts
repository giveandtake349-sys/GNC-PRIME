import OpenAI from "openai";
import type { ChatRequest, ChatResult, EngineAdapter } from "./types.js";

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

export function geminiAdapter(
  chain: string[] = GEMINI_MODEL_CHAIN,
  opts: GeminiOptions = {},
): EngineAdapter {
  const override = process.env.GEMINI_MODEL;
  const models = override
    ? [override, ...chain.filter((m) => m !== override)]
    : chain;
  return {
    id: `gemini:${models[0]}`,
    async chat(req: ChatRequest): Promise<ChatResult> {
      const apiKey = process.env.GEMINI_GROUND_API_KEY;
      if (!apiKey) throw new Error("GEMINI_GROUND_API_KEY is not set");
      const client = new OpenAI({ baseURL: BASE_URL, apiKey, timeout: 30_000 });
      const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] =
        [];
      if (req.system) messages.push({ role: "system", content: req.system });
      for (const turn of req.history ?? []) {
        messages.push({ role: turn.role, content: turn.content });
      }
      messages.push({ role: "user", content: req.message });

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
  };
}
