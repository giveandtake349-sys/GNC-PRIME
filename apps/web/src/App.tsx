import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  ApiError,
  StreamError,
  apiFetch,
  clearToken,
  getToken,
  setToken,
  streamChat,
} from "./api";

const MODELS = [
  { id: "gnc-1", label: "GNC-1" },
  { id: "gnc-flash", label: "GNC-Flash" },
  { id: "gnc-code", label: "GNC-Code" },
  { id: "gnc-think", label: "GNC-Think" },
  { id: "gnc-vision", label: "GNC-Vision" },
  { id: "gnc-lite", label: "GNC-Lite" },
] as const;

type ModelId = (typeof MODELS)[number]["id"];

interface UserInfo {
  id: string;
  email: string;
  displayName: string | null;
  plan: string;
}

interface AuthResponse {
  token: string;
  user: UserInfo;
}

interface ConversationSummary {
  id: string;
  title: string | null;
  gnc_model: string;
  updated_at: string;
}

interface StoredMessage {
  id: string;
  role: string;
  content: string;
  engine_used: string | null;
  rating: number | null;
  created_at: string;
}

interface ChatResponse {
  reply: string;
  engineUsed: string;
  conversationId: string | null;
  assistantMessageId: string | null;
}

interface Msg {
  id?: string;
  /** Local-only key for a message that has no server id (yet). */
  tempId?: string;
  role: "me" | "ai";
  text: string;
  who?: string;
  error?: boolean;
  rating?: number | null;
  /** True while this bubble is still receiving streamed tokens. */
  streaming?: boolean;
  /** True when the stream died mid-reply; the text shown was not saved. */
  partial?: boolean;
}

function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const mins = Math.floor((Date.now() - then) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

/* ------------------------------------------------------------------ */
/* Google sign-in (only rendered when VITE_GOOGLE_CLIENT_ID is set)    */
/* ------------------------------------------------------------------ */

interface GoogleCredentialResponse {
  credential?: string;
}

interface GoogleIdApi {
  initialize: (cfg: {
    client_id: string;
    callback: (resp: GoogleCredentialResponse) => void;
  }) => void;
  renderButton: (el: HTMLElement, opts: Record<string, unknown>) => void;
}

declare global {
  interface Window {
    google?: { accounts: { id: GoogleIdApi } };
  }
}

const GOOGLE_CLIENT_ID =
  (import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined) || undefined;

/* ------------------------------------------------------------------ */
/* Auth screen                                                         */
/* ------------------------------------------------------------------ */

function AuthScreen({ onAuthed }: { onAuthed: (token: string) => void }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const googleBtnRef = useRef<HTMLDivElement>(null);

  const handleGoogle = useCallback(
    async (resp: GoogleCredentialResponse) => {
      if (!resp.credential) return;
      setError("");
      try {
        const data = await apiFetch<AuthResponse>("/api/auth/google", {
          body: { idToken: resp.credential },
        });
        onAuthed(data.token);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [onAuthed],
  );

  useEffect(() => {
    if (!GOOGLE_CLIENT_ID) return;
    const init = () => {
      const idApi = window.google?.accounts?.id;
      if (!idApi || !googleBtnRef.current) return;
      idApi.initialize({
        client_id: GOOGLE_CLIENT_ID,
        callback: (resp) => void handleGoogle(resp),
      });
      idApi.renderButton(googleBtnRef.current, {
        theme: "filled_black",
        size: "large",
        shape: "pill",
        text: "signin_with",
      });
    };
    if (window.google?.accounts?.id) {
      init();
      return;
    }
    const existing = document.querySelector<HTMLScriptElement>(
      'script[src="https://accounts.google.com/gsi/client"]',
    );
    if (existing) {
      existing.addEventListener("load", init);
      return;
    }
    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.defer = true;
    script.onload = init;
    document.head.appendChild(script);
  }, [handleGoogle]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const data = await apiFetch<AuthResponse>(
        mode === "login" ? "/api/auth/login" : "/api/auth/register",
        {
          body:
            mode === "login"
              ? { email, password }
              : {
                  email,
                  password,
                  displayName: displayName.trim() || undefined,
                },
        },
      );
      onAuthed(data.token);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app">
      <header className="top">
        <img className="logo-img" src="/gnc-logo.webp" alt="GNC AI logo" />
        <div>
          <h1>
            GNC <span>AI</span>
          </h1>
          <p>Created by AstroX</p>
        </div>
      </header>

      <div className="auth-card">
        <h2>{mode === "login" ? "Welcome back" : "Create your account"}</h2>
        <p className="auth-sub">
          {mode === "login"
            ? "Log in to pick up your chats — history and memory included."
            : "One free account for every GNC model, with chat history and memory that remembers you."}
        </p>
        <form onSubmit={(e) => void submit(e)}>
          {mode === "register" && (
            <input
              className="auth-input"
              placeholder="Display name (optional)"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              autoComplete="name"
            />
          )}
          <input
            className="auth-input"
            type="email"
            placeholder="Email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
          />
          <input
            className="auth-input"
            type="password"
            placeholder="Password"
            required
            minLength={mode === "register" ? 8 : undefined}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === "login" ? "current-password" : "new-password"}
          />
          {error && <p className="auth-error">{error}</p>}
          <button className="auth-submit" type="submit" disabled={busy}>
            {busy
              ? "Please wait…"
              : mode === "login"
                ? "Log in"
                : "Create account"}
          </button>
        </form>

        {GOOGLE_CLIENT_ID && (
          <>
            <div className="auth-or">
              <span>or</span>
            </div>
            <div className="google-slot" ref={googleBtnRef} />
          </>
        )}

        <p className="auth-toggle">
          {mode === "login" ? "New to GNC Ground? " : "Already have an account? "}
          <button
            type="button"
            className="link-btn"
            onClick={() => {
              setMode(mode === "login" ? "register" : "login");
              setError("");
            }}
          >
            {mode === "login" ? "Create an account" : "Log in"}
          </button>
        </p>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Chat screen                                                         */
/* ------------------------------------------------------------------ */

function ChatScreen({ onLogout }: { onLogout: () => void }) {
  const [model, setModel] = useState<ModelId>("gnc-1");
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [me, setMe] = useState<UserInfo | null>(null);
  const [conversations, setConversations] = useState<ConversationSummary[]>(
    [],
  );
  const [activeId, setActiveId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  // Incremented on every send and on every conversation switch, so a
  // stream that finishes late can never write into another chat's view.
  const sendSeqRef = useRef(0);

  const modelLabel = MODELS.find((m) => m.id === model)?.label ?? model;

  /** Whether the message list is scrolled (nearly) to the newest content. */
  const stickToBottom = useCallback(() => {
    const el = messagesRef.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 160;
  }, []);

  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      const el = messagesRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }, []);

  const refreshConversations = useCallback(async () => {
    try {
      const data = await apiFetch<{ conversations: ConversationSummary[] }>(
        "/api/conversations",
      );
      setConversations(data.conversations);
    } catch {
      // List is best-effort; chat itself keeps working.
    }
  }, []);

  useEffect(() => {
    void refreshConversations();
  }, [refreshConversations]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await apiFetch<{ user: UserInfo }>("/api/auth/me");
        if (!cancelled) setMe(data.user);
      } catch (err) {
        // Fail-soft for display purposes — but a 401 means the token is
        // dead, so return to the auth screen.
        if (err instanceof ApiError && err.status === 401) onLogout();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [onLogout]);

  async function openConversation(conv: ConversationSummary) {
    setSidebarOpen(false);
    if (conv.id === activeId) return;
    sendSeqRef.current += 1;
    setActiveId(conv.id);
    const convModel = MODELS.find((m) => m.id === conv.gnc_model);
    if (convModel) setModel(convModel.id);
    setMessages([]);
    try {
      const data = await apiFetch<{ messages: StoredMessage[] }>(
        `/api/conversations/${conv.id}/messages`,
      );
      const label = convModel?.label ?? "GNC";
      setMessages(
        data.messages
          .filter((m) => m.role === "user" || m.role === "assistant")
          .map((m) => ({
            id: m.id,
            role: m.role === "user" ? ("me" as const) : ("ai" as const),
            text: m.content,
            who: m.role === "user" ? "You" : label,
            rating: m.rating,
          })),
      );
    } catch (err) {
      setMessages([
        {
          role: "ai",
          text: err instanceof Error ? err.message : String(err),
          who: "GNC",
          error: true,
        },
      ]);
    }
  }

  function newChat() {
    sendSeqRef.current += 1;
    setActiveId(null);
    setMessages([]);
    setSidebarOpen(false);
    inputRef.current?.focus();
  }

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    const seq = (sendSeqRef.current += 1);
    const tempId = `tmp-${seq}`;
    const isCurrent = () => sendSeqRef.current === seq;
    setInput("");
    setBusy(true);
    // The assistant bubble appears immediately in a "typing" state and
    // fills in token by token as the stream arrives.
    setMessages((prev) => [
      ...prev,
      { role: "me", text, who: "You" },
      {
        role: "ai",
        tempId,
        text: "",
        who: modelLabel,
        rating: null,
        streaming: true,
      },
    ]);
    scrollToBottom();

    const patchBubble = (patch: Partial<Msg>) => {
      setMessages((prev) =>
        prev.map((m) => (m.tempId === tempId ? { ...m, ...patch } : m)),
      );
    };
    const adoptConversation = (conversationId: string | null) => {
      if (!activeId && conversationId) setActiveId(conversationId);
      void refreshConversations();
    };

    try {
      const done = await streamChat(
        {
          model,
          message: text,
          ...(activeId ? { conversationId: activeId } : {}),
        },
        (t) => {
          if (!isCurrent()) return;
          const stick = stickToBottom();
          setMessages((prev) =>
            prev.map((m) =>
              m.tempId === tempId ? { ...m, text: m.text + t } : m,
            ),
          );
          if (stick) scrollToBottom();
        },
      );
      if (!isCurrent()) return;
      patchBubble({
        id: done.assistantMessageId ?? undefined,
        streaming: false,
        rating: null,
      });
      adoptConversation(done.conversationId);
    } catch (err) {
      if (!isCurrent()) return;
      if (err instanceof ApiError && err.status === 401) {
        onLogout();
        return;
      }
      const streamErr = err instanceof StreamError ? err : null;
      if (streamErr && (streamErr.partial || streamErr.tokensSeen > 0)) {
        // Part of the reply is already on screen: keep it, flag it as cut
        // off (it was not saved) and do NOT retry — a retry would
        // duplicate the text.
        patchBubble({ streaming: false, partial: true });
      } else {
        // Nothing was shown yet (HTTP failure or a stream that died
        // before its first token): one fallback to the classic endpoint.
        try {
          const data = await apiFetch<ChatResponse>("/api/chat", {
            body: {
              model,
              message: text,
              ...(activeId ? { conversationId: activeId } : {}),
            },
          });
          if (!isCurrent()) return;
          patchBubble({
            id: data.assistantMessageId ?? undefined,
            text: data.reply,
            streaming: false,
            rating: null,
          });
          adoptConversation(data.conversationId);
        } catch (err2) {
          if (!isCurrent()) return;
          if (err2 instanceof ApiError && err2.status === 401) {
            onLogout();
            return;
          }
          const msg = err2 instanceof Error ? err2.message : String(err2);
          patchBubble({ text: msg, streaming: false, error: true });
        }
      }
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  }

  async function rate(msg: Msg, rating: 1 | -1) {
    if (!msg.id) return;
    const id = msg.id;
    setMessages((prev) =>
      prev.map((m) => (m.id === id ? { ...m, rating } : m)),
    );
    try {
      await apiFetch(`/api/messages/${id}/rating`, { body: { rating } });
    } catch {
      // Rating is best-effort; the optimistic state stays.
    }
  }

  return (
    <div className="app wide">
      <header className="top">
        <button
          className="menu-btn"
          onClick={() => setSidebarOpen((o) => !o)}
          aria-label="Open menu"
        >
          ☰
        </button>
        <button className="new-chat-top" onClick={newChat} aria-label="New chat">
          ✎
        </button>
      </header>

      <div className="chat-body">
        <aside className={`sidebar${sidebarOpen ? " open" : ""}`}>
          <button
            className="menu-close"
            onClick={() => setSidebarOpen(false)}
            aria-label="Close menu"
          >
            × Close
          </button>
          <button className="new-chat" onClick={newChat}>
            + New Chat
          </button>
          <div className="menu-section">
            <div className="menu-label">Model</div>
            <select
              id="model"
              value={model}
              onChange={(e) => setModel(e.target.value as ModelId)}
            >
              {MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>
          <div className="menu-label">History</div>
          <div className="conv-list">
            {conversations.length === 0 && (
              <p className="conv-empty">
                No chats yet.
                <br />
                Your conversations will appear here.
              </p>
            )}
            {conversations.map((c) => (
              <button
                key={c.id}
                className={`conv-item${c.id === activeId ? " active" : ""}`}
                onClick={() => void openConversation(c)}
              >
                <span className="conv-title">{c.title || "Untitled chat"}</span>
                <span className="conv-date">{timeAgo(c.updated_at)}</span>
              </button>
            ))}
          </div>
          <div className="menu-section">
            <div className="menu-label">Profile</div>
            <p className="menu-text">{me?.email ?? ""}</p>
            <p className="menu-text">
              Plan: {me?.plan ?? ""} — daily message cap applies
            </p>
            <p className="menu-text">Created by AstroX</p>
            <button className="logout-btn" onClick={onLogout}>
              Logout
            </button>
          </div>
        </aside>

        <section className="main-col">
          <div className="messages" ref={messagesRef}>
            {messages.length === 0 && (
              <div className="empty-hero">
                <img
                  className="hero-logo"
                  src="/gnc-logo.webp"
                  alt="GNC AI logo"
                />
                <p className="hero-text">Let&apos;s Do Something Together?</p>
              </div>
            )}
            {messages.map((m, i) => (
              <div
                key={m.id ?? m.tempId ?? i}
                className={`msg ${m.role}${m.error ? " error" : ""}`}
              >
                {m.role === "ai" && <div className="who">{m.who}</div>}
                {m.streaming && !m.text ? (
                  <span className="typing">Typing…</span>
                ) : (
                  m.text
                )}
                {m.partial && (
                  <div className="partial-note">
                    Reply stopped early — it was not saved.
                  </div>
                )}
                {m.role === "ai" && m.id && !m.error && (
                  <div className="rate-row">
                    <button
                      className={`rate-btn${m.rating === 1 ? " active" : ""}`}
                      onClick={() => void rate(m, 1)}
                      title="Good answer"
                    >
                      👍
                    </button>
                    <button
                      className={`rate-btn${m.rating === -1 ? " active" : ""}`}
                      onClick={() => void rate(m, -1)}
                      title="Bad answer"
                    >
                      👎
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>

          <div className="composer">
            <input
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void send();
              }}
              placeholder="Ask GNC anything…"
            />
            <button
              className="send"
              onClick={() => void send()}
              disabled={busy}
            >
              ↑
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Root                                                                */
/* ------------------------------------------------------------------ */

export function App() {
  const [token, setTokenState] = useState<string | null>(() => getToken());

  const handleAuthed = useCallback((t: string) => {
    setToken(t);
    setTokenState(t);
  }, []);

  const handleLogout = useCallback(() => {
    clearToken();
    setTokenState(null);
  }, []);

  if (!token) return <AuthScreen onAuthed={handleAuthed} />;
  return <ChatScreen onLogout={handleLogout} />;
}
