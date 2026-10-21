import OpenAI from "openai";
import type { ChatRequest, ChatResult, EngineAdapter } from "./types.js";

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

export function zenAdapter(model: string): EngineAdapter {
  const id = `zen:${model}`;
  return {
    id,
    async chat(req: ChatRequest): Promise<ChatResult> {
      const apiKey = process.env.OPENCODE_API_KEY;
      if (!apiKey) throw new Error("OPENCODE_API_KEY is not set");
      const client = new OpenAI({ baseURL: BASE_URL, apiKey, timeout: 30_000 });
      const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] =
        [];
      if (req.system) messages.push({ role: "system", content: req.system });
      for (const turn of req.history ?? []) {
        messages.push({ role: turn.role, content: turn.content });
      }
      messages.push({ role: "user", content: req.message });
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
  };
}
