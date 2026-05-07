#!/usr/bin/env node
import { jsonPlaceholderProvider } from "@llm-fuse/provider-jsonplaceholder";
import { buildRuntime, runCommand } from "./index.js";
import { runRepl } from "./repl.js";
import { mountFuse } from "./mount.js";

const auditFlag = process.env.LLMFUSE_AUDIT === "1";

const runtime = buildRuntime({
  providers: [jsonPlaceholderProvider],
  audit: auditFlag,
});

const argv = process.argv.slice(2);
const head = argv[0];

async function main(): Promise<number> {
  if (head === "repl" || head === "shell") {
    const strict = argv.includes("--strict");
    await runRepl(runtime, { noBashFallback: strict });
    return 0;
  }

  if (head === "mount") {
    const target = argv[1];
    if (!target) {
      process.stderr.write("usage: llmfuse mount <target> [--allow-arch-mismatch]\n");
      return 2;
    }
    const allowArchMismatch = argv.includes("--allow-arch-mismatch");
    process.stdout.write(`mounting llm-fuse at ${target}...\n`);
    let handle;
    try {
      handle = await mountFuse(runtime, { target, allowArchMismatch });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`\nmount refused — ${message}\n\n`);
      process.stderr.write(
        `Note: this is the same blocker the POC was designed to surface.\n` +
          `Use the restricted shell instead — it works in every environment:\n` +
          `  llmfuse repl\n`,
      );
      return 1;
    }
    process.stdout.write(`mounted. press Ctrl-C to unmount.\n`);
    process.stdout.write(`try: ls ${target}/api/users\n`);
    process.stdout.write(`     cat ${target}/api/users/1/metadata.json\n`);

    const cleanup = async (): Promise<void> => {
      process.stdout.write(`\nunmounting ${handle.target}...\n`);
      try {
        await handle.unmount();
      } catch (err) {
        process.stderr.write(
          `unmount failed (you may need: umount ${handle.target} or sudo diskutil unmount force ${handle.target}): ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exit(1);
      }
      process.exit(0);
    };
    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);
    return await new Promise<number>(() => {});
  }

  const result = await runCommand(runtime, argv);
  process.stdout.write(result.stdout + (result.stdout.endsWith("\n") ? "" : "\n"));
  return result.exitCode;
}

main().then((code) => process.exit(code)).catch((err) => {
  process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
