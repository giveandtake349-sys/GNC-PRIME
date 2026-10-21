// GNC model gateway — shared types.
//
// The UI only ever sees GNC model ids. Which engine actually answers is an
// internal detail recorded as `engineUsed` and never shown to the user.

export type GncModelId =
  | "gnc-1"
  | "gnc-flash"
  | "gnc-code"
  | "gnc-think"
  | "gnc-vision"
  | "gnc-lite";

export const GNC_MODELS: { id: GncModelId; label: string }[] = [
  { id: "gnc-1", label: "GNC-1" },
  { id: "gnc-flash", label: "GNC-Flash" },
  { id: "gnc-code", label: "GNC-Code" },
  { id: "gnc-think", label: "GNC-Think" },
  { id: "gnc-vision", label: "GNC-Vision" },
  { id: "gnc-lite", label: "GNC-Lite" },
];

export interface ChatHistoryEntry {
  role: "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  message: string;
  system?: string;
  /** Prior conversation turns, oldest first; the new `message` follows them. */
  history?: ChatHistoryEntry[];
}

export interface ChatResult {
  reply: string;
  /** Internal engine model id that produced the reply, e.g. "gemini:gemini-2.5-flash". */
  engineUsed: string;
  tokensIn?: number;
  tokensOut?: number;
}

/**
 * One callable engine model. `id` is the internal engine identifier in the
 * form "<provider>:<model>", e.g. "zen:big-pickle".
 */
export interface EngineAdapter {
  readonly id: string;
  chat(req: ChatRequest): Promise<ChatResult>;
}
