// API client for the GNC Ground web app (Build Step 3).
// The JWT lives in localStorage under "gnc_token" and rides along as an
// Authorization: Bearer header on every call.

const TOKEN_KEY = "gnc_token";

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // Storage unavailable (private mode etc.) — session just won't persist.
  }
}

export function clearToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    // ignore
  }
}

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** The `done` event that closes a successful /api/chat/stream exchange. */
export interface StreamDone {
  engineUsed: string;
  conversationId: string | null;
  assistantMessageId: string | null;
}

/**
 * A streaming failure. `tokensSeen` counts the tokens that were already
 * delivered to the UI; `partial` means the reply died mid-stream (the
 * partial text on screen was not saved server-side).
 */
export class StreamError extends Error {
  tokensSeen: number;
  partial: boolean;
  constructor(
    message: string,
    opts: { tokensSeen: number; partial: boolean },
  ) {
    super(message);
    this.tokensSeen = opts.tokensSeen;
    this.partial = opts.partial;
  }
}

interface StreamEvent {
  type?: string;
  t?: string;
  error?: string;
  partial?: boolean;
  engineUsed?: string;
  conversationId?: string | null;
  assistantMessageId?: string | null;
}

/**
 * POST /api/chat/stream and consume its SSE events, handing each token to
 * `onToken` as it arrives. Resolves with the `done` event payload.
 * Throws ApiError for HTTP-level failures (before any token, so callers
 * may fall back to /api/chat) and StreamError for in-stream failures.
 */
export async function streamChat(
  body: { model: string; message: string; conversationId?: string },
  onToken: (t: string) => void,
): Promise<StreamDone> {
  const token = getToken();
  let res: Response;
  try {
    res = await fetch("/api/chat/stream", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new StreamError(
      err instanceof Error ? err.message : String(err),
      { tokensSeen: 0, partial: false },
    );
  }
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(data.error ?? `HTTP ${res.status}`, res.status);
  }
  if (!res.body) {
    throw new StreamError("This browser cannot read streamed replies", {
      tokensSeen: 0,
      partial: false,
    });
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let tokensSeen = 0;
  // Terminal events are collected in arrays: plain `let` variables assigned
  // only inside the handleLine closure get narrowed to `null` by TS.
  const doneEvents: StreamDone[] = [];
  const errorEvents: { message: string; partial: boolean }[] = [];

  const handleLine = (line: string) => {
    const trimmed = line.replace(/\r$/, "");
    if (!trimmed.startsWith("data:")) return;
    const json = trimmed.slice("data:".length).trim();
    if (!json) return;
    let evt: StreamEvent;
    try {
      evt = JSON.parse(json) as StreamEvent;
    } catch {
      return;
    }
    if (evt.type === "token" && typeof evt.t === "string") {
      tokensSeen += 1;
      onToken(evt.t);
    } else if (evt.type === "done") {
      doneEvents.push({
        engineUsed: evt.engineUsed ?? "",
        conversationId: evt.conversationId ?? null,
        assistantMessageId: evt.assistantMessageId ?? null,
      });
    } else if (evt.type === "error") {
      errorEvents.push({
        message: evt.error ?? "The stream failed",
        partial: evt.partial === true,
      });
    }
  };

  for (;;) {
    const { value, done: readerDone } = await reader.read();
    if (readerDone) break;
    buffer += decoder.decode(value, { stream: true });
    // SSE lines can split across chunks; consume only complete lines.
    let idx = buffer.indexOf("\n");
    while (idx >= 0) {
      handleLine(buffer.slice(0, idx));
      buffer = buffer.slice(idx + 1);
      idx = buffer.indexOf("\n");
    }
  }
  buffer += decoder.decode();
  if (buffer) handleLine(buffer);

  if (doneEvents.length > 0) return doneEvents[0];
  if (errorEvents.length > 0) {
    throw new StreamError(errorEvents[0].message, {
      tokensSeen,
      partial: errorEvents[0].partial,
    });
  }
  throw new StreamError("The reply stream ended unexpectedly", {
    tokensSeen,
    partial: tokensSeen > 0,
  });
}

interface ApiFetchOptions {
  method?: string;
  body?: unknown;
}

/**
 * JSON fetch against the API (same origin — Vercel rewrites /api/* to the
 * API in production, Vite proxies it in dev). Throws ApiError carrying the
 * server's error message on any non-2xx response.
 */
export async function apiFetch<T = Record<string, unknown>>(
  path: string,
  opts: ApiFetchOptions = {},
): Promise<T> {
  const token = getToken();
  const res = await fetch(path, {
    method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) {
    throw new ApiError(data.error ?? `HTTP ${res.status}`, res.status);
  }
  return data as T;
}
