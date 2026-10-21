import OpenAI from "openai";
import type { ChatRequest, ChatResult, EngineAdapter } from "./types.js";

// OpenCode Zen — free model gateway, OpenAI-compatible.
// Base URL: https://opencode.ai/zen/v1
// Free ids are promotional and can change; keep them in one place.

const BASE_URL = "https://opencode.ai/zen/v1";

export const ZEN_BIG_PICKLE = "big-pickle";
export const ZEN_LING_FLASH = "ling-flash-free";
export const ZEN_MIMO = "mimo-free";
export const ZEN_NEMOTRON_ULTRA = "nemotron-3-ultra-free";
export const ZEN_NEMOTRON_LIGHTNING = "nemotron-3-lightning-free";

export function zenAdapter(model: string): EngineAdapter {
  const id = `zen:${model}`;
  return {
    id,
    async chat(req: ChatRequest): Promise<ChatResult> {
      const apiKey = process.env.OPENCODE_API_KEY;
      if (!apiKey) throw new Error("OPENCODE_API_KEY is not set");
      const client = new OpenAI({ baseURL: BASE_URL, apiKey, timeout: 30_000 });
      const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
      if (req.system) messages.push({ role: "system", content: req.system });
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
