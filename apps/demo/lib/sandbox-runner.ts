import { Sandbox } from "@vercel/sandbox";
import {
  buildRuntime,
  runCommand,
} from "@llm-fuse/cli";
import { jsonPlaceholderProvider } from "@llm-fuse/provider-jsonplaceholder";

export interface RunResult {
  mode: "local" | "sandbox";
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

const isLocal = process.env.LLMFUSE_LOCAL_MODE === "1";
const gitUrl =
  process.env.SANDBOX_GIT_URL ?? "https://github.com/DanielT777/llm-fuse.git";
const gitRev = process.env.SANDBOX_GIT_REVISION ?? "main";

let sandboxPromise: Promise<Sandbox> | null = null;
let sandboxReady = false;

function tokens(): {
  token: string;
  teamId: string;
  projectId: string;
} | null {
  const token = process.env.VERCEL_TOKEN;
  const teamId = process.env.VERCEL_TEAM_ID;
  const projectId = process.env.VERCEL_PROJECT_ID;
  if (!token || !teamId || !projectId) return null;
  return { token, teamId, projectId };
}

async function getOrCreateSandbox(): Promise<Sandbox> {
  if (sandboxPromise) return sandboxPromise;
  const creds = tokens();
  if (!creds) {
    throw new Error(
      "VERCEL_TOKEN / VERCEL_TEAM_ID / VERCEL_PROJECT_ID are required for sandbox mode. Set LLMFUSE_LOCAL_MODE=1 to bypass.",
    );
  }
  sandboxPromise = (async () => {
    const sb = await Sandbox.create({
      token: creds.token,
      teamId: creds.teamId,
      projectId: creds.projectId,
      runtime: "node24",
      timeout: 5 * 60_000,
      source: { type: "git", url: gitUrl, revision: gitRev },
      networkPolicy: {
        allow: ["*.typicode.com", "registry.npmjs.org", "*.npmjs.org"],
      },
    } as Parameters<typeof Sandbox.create>[0]);
    await sb.runCommand({
      cmd: "corepack",
      args: ["enable"],
    });
    const install = await sb.runCommand({
      cmd: "pnpm",
      args: ["install", "--frozen-lockfile=false"],
    });
    if (install.exitCode !== 0) {
      throw new Error(`pnpm install failed in sandbox: exit ${install.exitCode}`);
    }
    const build = await sb.runCommand({
      cmd: "pnpm",
      args: ["-r", "--filter", "./packages/*", "run", "build"],
    });
    if (build.exitCode !== 0) {
      throw new Error(`pnpm build failed in sandbox: exit ${build.exitCode}`);
    }
    sandboxReady = true;
    return sb;
  })();
  try {
    return await sandboxPromise;
  } catch (err) {
    sandboxPromise = null;
    throw err;
  }
}

async function readLogs(
  command: { logs: () => AsyncIterable<{ stream: "stdout" | "stderr"; data: string }> },
): Promise<{ stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  for await (const log of command.logs()) {
    if (log.stream === "stdout") stdout += log.data;
    else stderr += log.data;
  }
  return { stdout, stderr };
}

async function runInSandbox(args: string[]): Promise<RunResult> {
  const start = Date.now();
  const sb = await getOrCreateSandbox();
  const cmd = await sb.runCommand({
    cmd: "node",
    args: ["packages/cli/dist/bin.js", ...args],
    detached: false,
  });
  const logs = await readLogs(cmd as unknown as { logs: () => AsyncIterable<{ stream: "stdout" | "stderr"; data: string }> });
  return {
    mode: "sandbox",
    exitCode: cmd.exitCode ?? 0,
    stdout: logs.stdout,
    stderr: logs.stderr,
    durationMs: Date.now() - start,
  };
}

async function runLocal(args: string[]): Promise<RunResult> {
  const start = Date.now();
  const runtime = buildRuntime({ providers: [jsonPlaceholderProvider] });
  const result = await runCommand(runtime, args);
  return {
    mode: "local",
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: "",
    durationMs: Date.now() - start,
  };
}

export async function runLlmfuseCommand(rawCommand: string): Promise<RunResult> {
  const argv = parseArgs(rawCommand);
  if (argv[0] === "llmfuse") argv.shift();
  if (isLocal || !tokens()) return runLocal(argv);
  return runInSandbox(argv);
}

export function isSandboxReady(): boolean {
  return sandboxReady;
}

export function isLocalMode(): boolean {
  return isLocal || !tokens();
}

function parseArgs(input: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  for (const ch of input.trim()) {
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        cur += ch;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === " ") {
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
