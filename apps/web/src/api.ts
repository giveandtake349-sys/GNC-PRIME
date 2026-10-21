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
