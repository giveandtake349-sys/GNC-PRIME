import { geminiAdapter, GEMINI_FLASH_MODEL } from "./gemini.js";
import {
  zenAdapter,
  ZEN_BIG_PICKLE,
  ZEN_LING_FLASH,
  ZEN_MIMO,
  ZEN_NEMOTRON_ULTRA,
  ZEN_NEMOTRON_LIGHTNING,
} from "./zen.js";
import type { ChatResult, EngineAdapter, GncModelId } from "./types.js";

// Fallback router — blueprint section 3.
// Try engines in order; on any error (429 / 5xx / timeout / empty reply)
// move to the next one. A failed engine goes into a 10-minute cooldown and
// is skipped while cooling down. Timeout per attempt: 30s (also set on the
// OpenAI clients in the adapters).

const TIMEOUT_MS = 30_000;
const COOLDOWN_MS = 10 * 60_000;

const cooldownUntil = new Map<string, number>();

const ROUTES: Record<GncModelId, EngineAdapter[]> = {
  // Blueprint: Gemini (best available) -> Nemotron Ultra -> Gemini Flash.
  // Only the Flash Gemini adapter exists in this step, so: Gemini Flash ->
  // Nemotron Ultra -> Nemotron Lightning.
  "gnc-1": [
    geminiAdapter(GEMINI_FLASH_MODEL),
    zenAdapter(ZEN_NEMOTRON_ULTRA),
    zenAdapter(ZEN_NEMOTRON_LIGHTNING),
  ],
  "gnc-flash": [
    geminiAdapter(GEMINI_FLASH_MODEL),
    zenAdapter(ZEN_LING_FLASH),
    zenAdapter(ZEN_MIMO),
  ],
  "gnc-code": [
    zenAdapter(ZEN_BIG_PICKLE),
    geminiAdapter(GEMINI_FLASH_MODEL),
    zenAdapter(ZEN_NEMOTRON_LIGHTNING),
  ],
  "gnc-think": [zenAdapter(ZEN_NEMOTRON_ULTRA), geminiAdapter(GEMINI_FLASH_MODEL)],
  "gnc-vision": [geminiAdapter(GEMINI_FLASH_MODEL)],
  "gnc-lite": [
    zenAdapter(ZEN_MIMO),
    zenAdapter(ZEN_LING_FLASH),
    geminiAdapter(GEMINI_FLASH_MODEL),
  ],
};

// Short system prompts — blueprint section 7 (draft policy).
const SYSTEM_PROMPTS: Record<GncModelId, string> = {
  "gnc-1":
    "You are GNC-1, an agent. Answer in the user's language. Break work into steps, verify rather than guess, never name the engine or provider behind you, and never invent facts — if you do not know, say so.",
  "gnc-flash":
    "You are GNC-Flash. Answer in the user's language, quickly and clearly. Never name the engine or provider behind you, and never invent facts.",
  "gnc-code":
    "You are GNC-Code, a coding specialist. Answer in the user's language. Give complete, runnable code with brief explanations; when something is wrong, explain the cause and the fix. Never name the engine or provider behind you.",
  "gnc-think":
    "You are GNC-Think for deep reasoning. Answer in the user's language, think carefully before concluding, and never invent facts. Never name the engine or provider behind you.",
  "gnc-vision":
    "You are GNC-Vision. Describe only what is actually in the image or video; do not guess at things that are not visible. Answer in the user's language.",
  "gnc-lite":
    "You are GNC-Lite. Give short, fast answers in the user's language. Never name the engine or provider behind you.",
};

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout after ${ms}ms: ${label}`)), ms),
    ),
  ]);
}

export async function routeChat(
  model: GncModelId,
  message: string,
): Promise<ChatResult> {
  const adapters = ROUTES[model];
  if (!adapters) throw new Error(`Unknown GNC model: ${model as string}`);
  const system = SYSTEM_PROMPTS[model];
  const errors: string[] = [];

  for (const adapter of adapters) {
    const until = cooldownUntil.get(adapter.id) ?? 0;
    if (Date.now() < until) {
      errors.push(`${adapter.id}: in cooldown`);
      continue;
    }
    try {
      return await withTimeout(adapter.chat({ message, system }), TIMEOUT_MS, adapter.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${adapter.id}: ${msg}`);
      cooldownUntil.set(adapter.id, Date.now() + COOLDOWN_MS);
    }
  }
  throw new Error(`All engines failed for ${model} — ${errors.join(" | ")}`);
}
