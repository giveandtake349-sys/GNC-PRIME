import OpenAI from "openai";
import type { ChatRequest, ChatResult, EngineAdapter } from "./types.js";

// Gemini via its OpenAI-compatible endpoint (Google AI Studio key).
// Base URL: https://generativelanguage.googleapis.com/v1beta/openai/

const BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/";

export const GEMINI_FLASH_MODEL = "gemini-2.5-flash";

export function geminiAdapter(model: string = GEMINI_FLASH_MODEL): EngineAdapter {
  const id = `gemini:${model}`;
  return {
    id,
    async chat(req: ChatRequest): Promise<ChatResult> {
      const apiKey = process.env.GEMINI_GROUND_API_KEY;
      if (!apiKey) throw new Error("GEMINI_GROUND_API_KEY is not set");
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
