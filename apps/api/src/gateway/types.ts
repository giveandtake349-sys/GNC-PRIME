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
 * Sink for streamed tokens. Return `false` to stop generation (used when
 * the consumer went away, e.g. the SSE client disconnected); returning
 * nothing/`true` keeps the stream going.
 */
export type TokenSink = (token: string) => boolean | void;

/**
 * A stream that died AFTER at least one token was already emitted to the
 * consumer. The partial text has been seen by the user, so the router must
 * never fall back to another engine (that would restart the reply); the
 * route turns this into an SSE error event flagged `partial` and does NOT
 * persist the partial reply.
 */
export class PartialStreamError extends Error {
  readonly partialReply: string;
  readonly engineUsed: string;
  constructor(message: string, partialReply: string, engineUsed: string) {
    super(message);
    this.name = "PartialStreamError";
    this.partialReply = partialReply;
    this.engineUsed = engineUsed;
  }
}

/**
 * The consumer asked us to stop mid-stream (client disconnected). Never a
 * failure: no cooldown, no fallback, nothing persisted.
 */
export class StreamAbortedError extends Error {
  constructor() {
    super("Stream aborted by consumer");
    this.name = "StreamAbortedError";
  }
}

/**
 * One callable engine model. `id` is the internal engine identifier in the
 * form "<provider>:<model>", e.g. "zen:big-pickle".
 */
export interface EngineAdapter {
  readonly id: string;
  chat(req: ChatRequest): Promise<ChatResult>;
  /**
   * Optional streaming variant of `chat`. Implementations must call
   * `onToken` for every token as it arrives, resolve with the full reply,
   * throw `PartialStreamError` if the stream dies after a token was
   * emitted, and throw `StreamAbortedError` when the sink returns false.
   */
  streamChat?(req: ChatRequest, onToken: TokenSink): Promise<ChatResult>;
}
