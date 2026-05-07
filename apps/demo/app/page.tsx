"use client";

import { useChat } from "@ai-sdk/react";
import { useEffect, useRef, useState } from "react";

const examples = [
  "List all users and tell me who lives in the smallest city.",
  "Read user 1's metadata, then show me the title of their first post.",
  "Find all completed todos for user 3.",
  "How many photos are in user 2's first album?",
];

const PRIMARY_MODEL = "openai/gpt-oss-120b:free";
const FALLBACKS = [
  "z-ai/glm-4.5-air:free",
  "meta-llama/llama-3.3-70b-instruct:free",
];

interface ToolPart {
  type: string;
  state?:
    | "input-streaming"
    | "input-available"
    | "output-available"
    | "output-error";
  input?: { command?: string };
  output?: {
    stdout?: string;
    stderr?: string;
    mode?: string;
    durationMs?: number;
    exitCode?: number;
  };
  errorText?: string;
}

interface ReasoningPart {
  type: "reasoning";
  text: string;
}

interface TextPart {
  type: "text";
  text: string;
}

const stateBadge: Record<
  string,
  { label: string; color: string; bg: string }
> = {
  "input-streaming": { label: "drafting", color: "#9ca3af", bg: "#1f2937" },
  "input-available": { label: "executing", color: "#fbbf24", bg: "#3a2e0a" },
  "output-available": { label: "done", color: "#34d399", bg: "#0d2a1f" },
  "output-error": { label: "error", color: "#f87171", bg: "#3a0d0d" },
};

function ToolCallView({ part }: { part: ToolPart }) {
  const cmd = part.input?.command ?? "…";
  const state = part.state ?? "input-streaming";
  const badge = stateBadge[state] ?? stateBadge["input-streaming"];
  const out = part.output;

  return (
    <div className="tool-call">
      <div className="tool-call-header">
        <span className="cmd">$ llmfuse {cmd}</span>
        <span
          className="state-badge"
          style={{ color: badge.color, background: badge.bg, borderColor: badge.color }}
        >
          {state === "input-available" && <span className="dot-pulse" />}
          {badge.label}
          {out?.mode && (
            <>
              {" · "}
              {out.mode}
              {" · "}
              {out.durationMs}ms{" · exit "}
              {out.exitCode}
            </>
          )}
        </span>
      </div>
      {out?.stdout && <pre className="tool-stdout">{out.stdout}</pre>}
      {out?.stderr && <pre className="tool-stderr">{out.stderr}</pre>}
      {part.errorText && <pre className="tool-stderr">{part.errorText}</pre>}
    </div>
  );
}

function ReasoningView({ part }: { part: ReasoningPart }) {
  return (
    <details className="reasoning">
      <summary>💭 reasoning</summary>
      <div className="reasoning-body">{part.text}</div>
    </details>
  );
}

export default function Home() {
  const [input, setInput] = useState("");
  const { messages, sendMessage, status, error, regenerate, stop } = useChat();
  const isBusy = status === "submitted" || status === "streaming";
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = scrollerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, status]);

  const onSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!input.trim() || isBusy) return;
    sendMessage({ text: input });
    setInput("");
  };

  return (
    <main>
      <header>
        <h1>llm-fuse</h1>
        <p className="tagline">
          an LLM agent navigates an HTTP API as a filesystem (ls / cat / invoke)
        </p>
      </header>

      <div className="panel meta">
        <div className="meta-row">
          <span className="meta-key">provider</span>
          <span className="meta-val">jsonplaceholder.typicode.com</span>
        </div>
        <div className="meta-row">
          <span className="meta-key">mount</span>
          <span className="meta-val">
            <code>/api</code> · <code>packages/provider-jsonplaceholder/src/index.ts</code>
          </span>
        </div>
        <div className="meta-row">
          <span className="meta-key">model</span>
          <span className="meta-val">
            <code>{PRIMARY_MODEL}</code>{" "}
            <span className="muted">(fallback: {FALLBACKS.join(", ")})</span>
          </span>
        </div>
        <div className="meta-row">
          <span className="meta-key">tool</span>
          <span className="meta-val">
            <code>llmfuse(command)</code> → spawns Vercel Sandbox microVM
          </span>
        </div>
      </div>

      <div className="panel chat-panel">
        <div className="panel-title">
          conversation
          {status === "submitted" && (
            <span className="status-badge thinking">
              <span className="dot-pulse" />
              thinking
            </span>
          )}
          {status === "streaming" && (
            <span className="status-badge streaming">
              <span className="dot-pulse" />
              streaming
            </span>
          )}
          {isBusy && (
            <button type="button" className="stop-btn" onClick={() => stop()}>
              stop
            </button>
          )}
        </div>

        <div className="messages" ref={scrollerRef}>
          {messages.length === 0 && (
            <div className="empty-state">
              Ask the agent something. It will issue <code>llmfuse</code> shell
              commands inside a Vercel Sandbox microVM to answer.
            </div>
          )}
          {messages.map((m) => (
            <div
              key={m.id}
              className={
                m.role === "user" ? "bubble bubble-user" : "bubble bubble-assistant"
              }
            >
              {m.parts.map((part, i) => {
                if (part.type === "text") {
                  const tp = part as TextPart;
                  return (
                    <span key={i} className="text-part">
                      {tp.text}
                    </span>
                  );
                }
                if (part.type === "reasoning") {
                  return <ReasoningView key={i} part={part as ReasoningPart} />;
                }
                const p = part as ToolPart;
                if (p.type?.startsWith("tool-")) {
                  return <ToolCallView key={i} part={p} />;
                }
                return null;
              })}
            </div>
          ))}
          {error && (
            <div className="error-bar">
              <div>
                <strong>⚠ Error:</strong> {error.message}
              </div>
              <button
                type="button"
                className="retry-btn"
                onClick={() => regenerate()}
              >
                retry
              </button>
            </div>
          )}
        </div>

        <form onSubmit={onSubmit}>
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={isBusy ? "agent is working…" : "Ask the agent…"}
            disabled={isBusy}
            autoFocus
          />
          <button type="submit" disabled={isBusy || !input.trim()}>
            {isBusy ? "…" : "send"}
          </button>
        </form>

        <div className="examples">
          {examples.map((ex) => (
            <button
              key={ex}
              type="button"
              className="example"
              onClick={() => setInput(ex)}
              disabled={isBusy}
            >
              {ex}
            </button>
          ))}
        </div>
      </div>
    </main>
  );
}
