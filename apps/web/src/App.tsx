import { useRef, useState } from "react";

const MODELS = [
  { id: "gnc-1", label: "GNC-1" },
  { id: "gnc-flash", label: "GNC-Flash" },
  { id: "gnc-code", label: "GNC-Code" },
  { id: "gnc-think", label: "GNC-Think" },
  { id: "gnc-vision", label: "GNC-Vision" },
  { id: "gnc-lite", label: "GNC-Lite" },
] as const;

type ModelId = (typeof MODELS)[number]["id"];

interface Msg {
  role: "me" | "ai";
  text: string;
  who?: string;
  error?: boolean;
}

export function App() {
  const [model, setModel] = useState<ModelId>("gnc-1");
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const modelLabel = MODELS.find((m) => m.id === model)?.label ?? model;

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    setBusy(true);
    setMessages((prev) => [...prev, { role: "me", text, who: "You" }]);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // Dev-only auth bypass (API must run with DEV_AUTH=1 locally).
          "x-dev-user": "dev",
        },
        body: JSON.stringify({ model, message: text }),
      });
      const data = (await res.json()) as { reply?: string; error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setMessages((prev) => [
        ...prev,
        { role: "ai", text: data.reply ?? "", who: modelLabel },
      ]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setMessages((prev) => [
        ...prev,
        { role: "ai", text: msg, who: modelLabel, error: true },
      ]);
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  }

  return (
    <div className="app">
      <header className="top">
        <div className="logo">GNC</div>
        <div>
          <h1>
            GNC <span>GROUND</span>
          </h1>
          <p>Chat Ground · all GNC models in one place</p>
        </div>
      </header>

      <div className="model-row">
        <label htmlFor="model">Model</label>
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

      <div className="messages">
        {messages.length === 0 && (
          <p className="empty">
            Pick a GNC model and say hello. GNC-1 is the flagship agent;
            GNC-Flash is fast for everyday chat; GNC-Code is for coding.
          </p>
        )}
        {messages.map((m, i) => (
          <div
            key={i}
            className={`msg ${m.role}${m.error ? " error" : ""}`}
          >
            <div className="who">{m.who}</div>
            {m.text}
          </div>
        ))}
        {busy && (
          <div className="msg ai">
            <div className="who">{modelLabel}</div>
            Thinking…
          </div>
        )}
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
        <button className="send" onClick={() => void send()} disabled={busy}>
          ↑
        </button>
      </div>
    </div>
  );
}
