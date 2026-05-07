import { spawn } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import type { LlmFuseRuntime } from "@llm-fuse/core";
import { runCommand } from "./index.js";

const VOCAB = new Set([
  "ls",
  "cat",
  "stat",
  "tree",
  "invoke",
  "help",
  "?",
]);

const EXIT = new Set(["exit", "quit", ":q"]);

interface ReplOptions {
  prompt?: string;
  bashShell?: string;
  noBashFallback?: boolean;
}

function parseArgs(input: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  for (const ch of input) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === " " || ch === "\t") {
      if (cur) {
        out.push(cur);
        cur = "";
      }
    } else {
      cur += ch;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function isMountedPath(arg: string, mounts: string[]): boolean {
  if (!arg.startsWith("/")) return false;
  return mounts.some((m) => arg === m || arg.startsWith(m === "/" ? "/" : m + "/"));
}

function shouldInterceptAsLlmfuse(
  cmd: string,
  args: string[],
  mounts: string[],
): boolean {
  if (!VOCAB.has(cmd)) return false;
  const firstPathArg = args.find((a) => a.startsWith("/") && !a.startsWith("//"));
  if (!firstPathArg) {
    return cmd === "help" || cmd === "?";
  }
  return isMountedPath(firstPathArg, mounts);
}

async function runBash(line: string, shell: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const proc = spawn(shell, ["-c", line], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (b: Buffer) => (stdout += b.toString("utf8")));
    proc.stderr.on("data", (b: Buffer) => (stderr += b.toString("utf8")));
    proc.on("close", (code) => resolve({ stdout, stderr, exitCode: code ?? 0 }));
    proc.on("error", (err) =>
      resolve({ stdout: "", stderr: String(err), exitCode: 127 }),
    );
  });
}

function helpBanner(noBash: boolean): string {
  return [
    "llm-fuse restricted shell",
    "",
    "Built-in vocabulary (paths under a mount point are routed to the runtime):",
    "  ls <path>             list directory entries",
    "  cat <path>            print a file",
    "  stat <path>           show node metadata",
    "  tree <path> [--depth N]   recursive listing",
    "  invoke <path> [--input <json>]   run an action",
    "  help                  this banner",
    "  exit / quit / :q      leave the shell",
    "",
    noBash
      ? "Strict mode: anything outside the vocabulary is rejected."
      : "Anything else falls through to bash. Use `mode strict` to disable bash fallback.",
  ].join("\n");
}

export interface ReplResult {
  exited: "user" | "eof";
}

export async function runRepl(
  runtime: LlmFuseRuntime,
  opts: ReplOptions = {},
): Promise<ReplResult> {
  const isTty = process.stdout.isTTY;
  const promptStr = opts.prompt ?? "lfsh> ";
  const bashShell = opts.bashShell ?? "/bin/bash";
  let strict = !!opts.noBashFallback;
  const mounts = runtime.listMountPoints();

  if (isTty) {
    process.stdout.write(`llm-fuse shell — mounts: ${mounts.join(", ")}\n`);
    process.stdout.write(`type 'help' for the vocabulary, 'exit' to leave\n`);
  }

  const rl: Interface = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: isTty,
    prompt: promptStr,
  });
  if (isTty) rl.prompt();

  const handle = async (raw: string): Promise<void> => {
    const line = raw.trim();
    if (!line) return;
    if (EXIT.has(line)) {
      rl.close();
      return;
    }
    if (line === "mode strict") {
      strict = true;
      process.stdout.write("strict mode on (no bash fallback)\n");
      return;
    }
    if (line === "mode overlay") {
      strict = false;
      process.stdout.write("overlay mode on (bash fallback enabled)\n");
      return;
    }

    const argv = parseArgs(line);
    const head = argv[0];
    if (!head) return;
    const args = argv.slice(1);

    if (head === "help" || head === "?") {
      process.stdout.write(helpBanner(strict) + "\n");
      return;
    }

    if (shouldInterceptAsLlmfuse(head, args, mounts)) {
      const result = await runCommand(runtime, argv);
      process.stdout.write(result.stdout);
      if (!result.stdout.endsWith("\n")) process.stdout.write("\n");
      return;
    }

    if (strict) {
      const reason = VOCAB.has(head)
        ? `path is not under a mounted provider (${mounts.join(", ") || "none"})`
        : `'${head}' is not in the llm-fuse vocabulary`;
      process.stderr.write(`lfsh: rejected — ${reason} [strict mode]\n`);
      return;
    }

    const result = await runBash(line, bashShell);
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  };

  let exitedByUser = false;
  rl.on("close", () => {
    exitedByUser = true;
  });

  for await (const line of rl) {
    try {
      await handle(line);
    } catch (err) {
      process.stderr.write(
        `lfsh error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
    if (isTty) rl.prompt();
  }

  return { exited: exitedByUser ? "user" : "eof" };
}
