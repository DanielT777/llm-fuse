import {
  LlmFuseRuntime,
  PolicyEngine,
  StderrAuditSink,
  type LlmFuseProvider,
  type PolicyRule,
} from "@llm-fuse/core";

export interface BuildRuntimeOptions {
  providers: LlmFuseProvider[];
  policyRules?: PolicyRule[];
  audit?: boolean;
}

export function buildRuntime(opts: BuildRuntimeOptions): LlmFuseRuntime {
  return new LlmFuseRuntime({
    providers: opts.providers,
    policy: new PolicyEngine(opts.policyRules ?? [], "allow"),
    audit: opts.audit ? new StderrAuditSink() : undefined,
  });
}

export interface CliResult {
  exitCode: number;
  stdout: string;
}

function fmtList(entries: { name: string; kind: string }[]): string {
  return entries
    .map((e) => (e.kind === "dir" ? `${e.name}/` : e.kind === "action" ? `${e.name}!` : e.name))
    .join("\n");
}

async function tree(
  runtime: LlmFuseRuntime,
  path: string,
  depth: number,
  out: string[],
  prefix = "",
): Promise<void> {
  const entries = await runtime.list(path);
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!e) continue;
    const last = i === entries.length - 1;
    const connector = last ? "└── " : "├── ";
    const marker = e.kind === "dir" ? "/" : e.kind === "action" ? "!" : "";
    out.push(`${prefix}${connector}${e.name}${marker}`);
    if (e.kind === "dir" && depth > 1) {
      const child = path === "/" ? `/${e.name}` : `${path}/${e.name}`;
      await tree(runtime, child, depth - 1, out, prefix + (last ? "    " : "│   "));
    }
  }
}

export async function runCommand(
  runtime: LlmFuseRuntime,
  argv: string[],
): Promise<CliResult> {
  const [cmd, ...rest] = argv;
  try {
    switch (cmd) {
      case undefined:
      case "help":
      case "--help":
      case "-h":
        return {
          exitCode: 0,
          stdout: helpText(),
        };
      case "ls": {
        const path = rest[0] ?? "/";
        const entries = await runtime.list(path);
        return { exitCode: 0, stdout: fmtList(entries) };
      }
      case "stat": {
        const path = rest[0];
        if (!path) return { exitCode: 2, stdout: "usage: llmfuse stat <path>" };
        const node = await runtime.stat(path);
        return { exitCode: 0, stdout: JSON.stringify(node, null, 2) };
      }
      case "cat": {
        const path = rest[0];
        if (!path) return { exitCode: 2, stdout: "usage: llmfuse cat <path>" };
        const result = await runtime.read(path);
        return {
          exitCode: 0,
          stdout: result.body,
        };
      }
      case "tree": {
        const path = rest[0] ?? "/";
        const depthIdx = rest.indexOf("--depth");
        const depth = depthIdx >= 0 ? parseInt(rest[depthIdx + 1] ?? "2", 10) : 2;
        const out: string[] = [path === "/" ? "/" : path];
        await tree(runtime, path, depth, out);
        return { exitCode: 0, stdout: out.join("\n") };
      }
      case "invoke": {
        const path = rest[0];
        if (!path)
          return { exitCode: 2, stdout: "usage: llmfuse invoke <path> [--input <json>]" };
        const inputIdx = rest.indexOf("--input");
        let input: unknown = undefined;
        if (inputIdx >= 0) {
          const raw = rest[inputIdx + 1] ?? "{}";
          try {
            input = JSON.parse(raw);
          } catch {
            return { exitCode: 2, stdout: `invalid --input JSON: ${raw}` };
          }
        }
        const result = await runtime.invoke(path, input);
        return { exitCode: 0, stdout: JSON.stringify(result, null, 2) };
      }
      default:
        return { exitCode: 2, stdout: `unknown command: ${cmd}\n${helpText()}` };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { exitCode: 1, stdout: `error: ${msg}` };
  }
}

export function helpText(): string {
  return [
    "llmfuse — restricted shell over a virtual filesystem of mounted APIs",
    "",
    "One-shot commands:",
    "  llmfuse ls [path]",
    "  llmfuse cat <path>",
    "  llmfuse stat <path>",
    "  llmfuse tree [path] [--depth N]",
    "  llmfuse invoke <path> [--input <json>]",
    "",
    "Interactive shell:",
    "  llmfuse repl              overlay shell — vocabulary intercepts mount paths,",
    "                            anything else falls through to bash",
    "  llmfuse repl --strict     reject anything outside the vocabulary",
    "",
    "Mount as a real filesystem (requires fuse-native + macFUSE / libfuse):",
    "  llmfuse mount <target>",
    "",
    "Conventions:",
    "  trailing /  -> directory",
    "  trailing !  -> invokable action",
  ].join("\n");
}
