import { runLlmfuseCommand } from "@/lib/sandbox-runner";
import { Sandbox } from "@vercel/sandbox";

export const maxDuration = 300;

interface ProbeOutput {
  mode: "local" | "sandbox" | "skipped";
  rawJson: string | null;
  parsed: unknown | null;
  error?: string;
}

export async function POST(): Promise<Response> {
  if (process.env.LLMFUSE_LOCAL_MODE === "1" || !process.env.VERCEL_TOKEN) {
    const fallback: ProbeOutput = {
      mode: "skipped",
      rawJson: null,
      parsed: null,
      error:
        "Sandbox credentials not set. The probe must run inside a Vercel Sandbox microVM to be meaningful.",
    };
    return Response.json(fallback);
  }

  try {
    const sb = await Sandbox.create({
      token: process.env.VERCEL_TOKEN!,
      teamId: process.env.VERCEL_TEAM_ID!,
      projectId: process.env.VERCEL_PROJECT_ID!,
      runtime: "node24",
      timeout: 5 * 60_000,
      source: {
        type: "git",
        url: process.env.SANDBOX_GIT_URL ?? "https://github.com/DanielT777/llm-fuse.git",
        revision: process.env.SANDBOX_GIT_REVISION ?? "main",
      },
      networkPolicy: { allow: ["registry.npmjs.org", "*.npmjs.org"] },
    } as Parameters<typeof Sandbox.create>[0]);

    await sb.runCommand({ cmd: "corepack", args: ["enable"] });
    await sb.runCommand({ cmd: "pnpm", args: ["install", "--frozen-lockfile=false"] });
    await sb.runCommand({
      cmd: "pnpm",
      args: ["--filter", "@llm-fuse/fuse", "run", "build"],
    });

    const probe = await sb.runCommand({
      cmd: "node",
      args: ["packages/fuse/dist/probe.js"],
    });
    let stdout = "";
    let stderr = "";
    for await (const log of (probe as unknown as { logs: () => AsyncIterable<{ stream: "stdout" | "stderr"; data: string }> }).logs()) {
      if (log.stream === "stdout") stdout += log.data;
      else stderr += log.data;
    }

    let parsed: unknown = null;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      // not JSON — leave as raw
    }

    return Response.json({
      mode: "sandbox",
      rawJson: stdout || stderr,
      parsed,
    } satisfies ProbeOutput);
  } catch (err) {
    return Response.json({
      mode: "sandbox",
      rawJson: null,
      parsed: null,
      error: err instanceof Error ? err.message : String(err),
    } satisfies ProbeOutput);
  }
}

// suppress unused-import lint when local-mode path is hot-reloaded
void runLlmfuseCommand;
