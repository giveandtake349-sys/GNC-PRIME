import { query } from "./db.js";
import { geminiAdapter, GEMINI_LITE_CHAIN } from "./gateway/gemini.js";

// Per-user memory on Neon pgvector (Build Step 3).
//
// Everything here is FAIL-SOFT by design: memory must never break chat.
// Embedding misses, extraction garbage, or DB errors all degrade to
// "no memory" and are only logged.

const EMBED_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent";

/** Embed text into a 768-dim vector, or null on any failure. */
export async function embedText(text: string): Promise<number[] | null> {
  const apiKey = process.env.GEMINI_GROUND_API_KEY;
  if (!apiKey || !text.trim()) return null;
  try {
    const res = await fetch(EMBED_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        content: { parts: [{ text }] },
        outputDimensionality: 768,
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      embedding?: { values?: unknown };
    };
    const values = data.embedding?.values;
    if (!Array.isArray(values) || values.length !== 768) return null;
    if (!values.every((v) => typeof v === "number")) return null;
    return values as number[];
  } catch {
    return null;
  }
}

export interface MemoryRow {
  id: string;
  kind: string;
  text: string;
  similarity: number;
}

function vectorLiteral(values: number[]): string {
  return `[${values.join(",")}]`;
}

/** Top memories similar to the text (similarity > 0.55), or [] on failure. */
export async function recallMemories(
  userId: string,
  text: string,
): Promise<MemoryRow[]> {
  try {
    const vec = await embedText(text);
    if (!vec) return [];
    const result = await query<MemoryRow>(
      "select id, kind, text, similarity from public.match_memories($1, $2::vector, 5)",
      [userId, vectorLiteral(vec)],
    );
    return result.rows.filter((r) => Number(r.similarity) > 0.55);
  } catch (err) {
    console.error("recallMemories failed:", err);
    return [];
  }
}

// Cheap keyword gate so extraction (an LLM call) only runs on messages
// that plausibly state something personal. Mixed Bangla/Banglish + English.
const MEMORY_GATE_WORDS = [
  "ami",
  "আমি",
  "amar",
  "আমার",
  "my ",
  "i am",
  "i'm",
  "remember",
  "mone",
  "পছন্দ",
  "like",
  "love",
  "hate",
  "live",
  "থাকি",
  "job",
  "কাজ",
  "name",
  "নাম",
  "kori",
  "করি",
];

const EXTRACT_SYSTEM =
  "You extract durable personal facts about the user from their message (name, home, job, preferences, projects, people). " +
  "Respond with ONLY a JSON array of short factual strings in English, at most 3 items, e.g. [\"User's name is Rahim\", \"User lives in Dhaka\"]. " +
  "If the message contains no durable personal fact, respond with exactly []. No explanations, no markdown, no other text.";

/**
 * Extract up to 3 durable facts from a user message and store them as
 * memories. Fire-and-forget from the chat route: never throws.
 */
export async function extractAndStoreMemories(
  userId: string,
  userMessage: string,
  sourceMsgId: string | null,
): Promise<void> {
  try {
    const lower = userMessage.toLowerCase();
    if (!MEMORY_GATE_WORDS.some((w) => lower.includes(w))) return;

    const adapter = geminiAdapter(GEMINI_LITE_CHAIN);
    const result = await adapter.chat({
      message: userMessage,
      system: EXTRACT_SYSTEM,
    });

    const start = result.reply.indexOf("[");
    const end = result.reply.lastIndexOf("]");
    if (start === -1 || end === -1 || end < start) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.reply.slice(start, end + 1));
    } catch {
      return;
    }
    if (!Array.isArray(parsed)) return;
    const facts = parsed
      .filter((f): f is string => typeof f === "string")
      .map((f) => f.trim())
      .filter((f) => f.length > 0 && f.length <= 300)
      .slice(0, 3);

    for (const fact of facts) {
      const vec = await embedText(fact);
      if (!vec) continue;
      await query(
        "insert into public.memories (user_id, kind, text, embedding, source_msg_id) values ($1, 'fact', $2, $3::vector, $4)",
        [userId, fact, vectorLiteral(vec), sourceMsgId],
      );
    }
  } catch (err) {
    console.error("extractAndStoreMemories failed:", err);
  }
}
