import {
  geminiAdapter,
  GEMINI_MODEL_CHAIN,
  GEMINI_LITE_CHAIN,
} from "./gemini.js";
import {
  zenAdapter,
  ZEN_BIG_PICKLE,
  ZEN_MIMO_FLASH,
  ZEN_DEEPSEEK_FLASH,
  ZEN_NEMOTRON_LIGHTNING,
} from "./zen.js";
import type {
  ChatHistoryEntry,
  ChatResult,
  EngineAdapter,
  GncModelId,
} from "./types.js";

// Fallback router — blueprint section 3.
// Try engines in order; on any error (429 / 5xx / timeout / empty reply)
// move to the next one. A failed engine goes into a 10-minute cooldown and
// is skipped while cooling down. Timeout per attempt: 30s (also set on the
// OpenAI clients in the adapters).

const TIMEOUT_MS = 30_000;
const COOLDOWN_MS = 10 * 60_000;

const cooldownUntil = new Map<string, number>();

const ROUTES: Record<GncModelId, EngineAdapter[]> = {
  // Engine reality (verified live 2026-10-22): Gemini is the only free
  // engine reachable from a server — OpenCode gates its Zen free tier to
  // the OpenCode app itself, so Zen adapters are trailing last-resorts
  // only. Every GNC model is Gemini-first; the Gemini adapter itself walks
  // a chain of model ids, so a retired id no longer breaks a route.
  // GNC-Think and GNC-1 ask Gemini for deeper reasoning via
  // reasoning_effort; GNC-Lite prefers the flash-lite ids.
  "gnc-1": [
    geminiAdapter(GEMINI_MODEL_CHAIN, { reasoningEffort: "medium" }),
    zenAdapter(ZEN_BIG_PICKLE),
    zenAdapter(ZEN_NEMOTRON_LIGHTNING),
  ],
  "gnc-flash": [
    geminiAdapter(),
    zenAdapter(ZEN_MIMO_FLASH),
    zenAdapter(ZEN_DEEPSEEK_FLASH),
  ],
  "gnc-code": [
    geminiAdapter(),
    zenAdapter(ZEN_BIG_PICKLE),
    zenAdapter(ZEN_DEEPSEEK_FLASH),
  ],
  "gnc-think": [
    geminiAdapter(GEMINI_MODEL_CHAIN, { reasoningEffort: "high" }),
    zenAdapter(ZEN_NEMOTRON_LIGHTNING),
  ],
  "gnc-vision": [geminiAdapter()],
  "gnc-lite": [
    geminiAdapter(GEMINI_LITE_CHAIN),
    zenAdapter(ZEN_MIMO_FLASH),
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

export interface RouteChatOptions {
  /** Prior conversation turns (oldest first) for multi-turn context. */
  history?: ChatHistoryEntry[];
  /** Extra instructions (e.g. recalled memories) appended to the model's system prompt. */
  extraSystem?: string;
}

export async function routeChat(
  model: GncModelId,
  message: string,
  opts: RouteChatOptions = {},
): Promise<ChatResult> {
  const adapters = ROUTES[model];
  if (!adapters) throw new Error(`Unknown GNC model: ${model as string}`);
  let system = SYSTEM_PROMPTS[model];
  if (opts.extraSystem) system = `${system}\n\n${opts.extraSystem}`;
  const errors: string[] = [];

  for (const adapter of adapters) {
    const until = cooldownUntil.get(adapter.id) ?? 0;
    if (Date.now() < until) {
      errors.push(`${adapter.id}: in cooldown`);
      continue;
    }
    try {
      return await withTimeout(
        adapter.chat({ message, system, history: opts.history }),
        TIMEOUT_MS,
        adapter.id,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${adapter.id}: ${msg}`);
      cooldownUntil.set(adapter.id, Date.now() + COOLDOWN_MS);
    }
  }
  throw new Error(`All engines failed for ${model} — ${errors.join(" | ")}`);
}
