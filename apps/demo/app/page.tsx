"use client";

import { useChat } from "@ai-sdk/react";
import { useState } from "react";

const examples = [
  "List all users and tell me who lives in the smallest city.",
  "Read user 1's metadata, then show me the title of their first post.",
  "Find all completed todos for user 3.",
  "How many photos are in user 2's first album?",
];

interface ToolPart {
  type: string;
  toolName?: string;
  input?: { command?: string };
  output?: { stdout?: string; mode?: string; durationMs?: number; exitCode?: number };
}

export default function Home() {
  const [input, setInput] = useState("");
  const { messages, sendMessage, status } = useChat();
  const isBusy = status === "submitted" || status === "streaming";

  const onSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!input.trim() || isBusy) return;
    sendMessage({ text: input });
    setInput("");
  };

  return (
    <main>
      <h1>llm-fuse</h1>
      <p className="tagline">
        an LLM agent navigates an HTTP API as a filesystem (ls / cat / invoke)
      </p>

      <div className="panel">
        <div className="panel-title">demo provider — jsonplaceholder.typicode.com</div>
        <div style={{ fontSize: 12, color: "#aaa" }}>
          mount: <code>/api</code> · routes declared in
          <code> packages/provider-jsonplaceholder/src/index.ts</code>
        </div>
      </div>

      <div className="panel">
        <div className="panel-title">conversation</div>
        <div className="messages">
          {messages.length === 0 && (
            <div style={{ color: "#666", fontSize: 12 }}>
              Ask the agent something. It will issue llmfuse shell commands to answer.
            </div>
          )}
          {messages.map((m) => (
            <div
              key={m.id}
              className={m.role === "user" ? "bubble bubble-user" : "bubble bubble-assistant"}
            >
              {m.parts.map((part, i) => {
                if (part.type === "text") {
                  return <span key={i}>{part.text}</span>;
                }
                const p = part as ToolPart;
                if (p.type?.startsWith("tool-")) {
                  const cmd = p.input?.command ?? "...";
                  const out = p.output;
                  return (
                    <div key={i} className="tool-call">
                      <div>
                        <span className="cmd">$ llmfuse {cmd}</span>
                        {out?.mode && (
                          <span style={{ marginLeft: 8, color: "#666" }}>
                            [{out.mode} · {out.durationMs}ms · exit {out.exitCode}]
                          </span>
                        )}
                      </div>
                      {out?.stdout && <pre>{out.stdout}</pre>}
                    </div>
                  );
                }
                return null;
              })}
            </div>
          ))}
        </div>

        <form onSubmit={onSubmit}>
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask the agent..."
            disabled={isBusy}
          />
          <button type="submit" disabled={isBusy || !input.trim()}>
            {isBusy ? "..." : "send"}
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
