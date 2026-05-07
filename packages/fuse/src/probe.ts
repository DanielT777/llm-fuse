#!/usr/bin/env node
/**
 * llm-fuse environment probe.
 *
 * Reports whether the current environment can run a real FUSE mount. Designed
 * to be executed *inside* a target sandbox (Vercel Sandbox microVM, Docker
 * container, CI runner, local laptop) so we can document the practical
 * portability of the FUSE strategy vs the restricted-shell fallback.
 *
 * The probe is non-destructive: it inspects the environment and only attempts a
 * real mount if --mount is passed and a target directory is provided.
 *
 * Output is JSON on stdout so it can be captured and rendered by the demo app.
 */
import { execSync } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import os from "node:os";

interface ProbeReport {
  schema: "llm-fuse-probe@1";
  timestamp: string;
  platform: NodeJS.Platform;
  arch: string;
  release: string;
  kernelVersion: string | null;
  nodeVersion: string;
  isRoot: boolean;
  fuseDevicePresent: boolean;
  fuseDeviceReadable: boolean;
  fuseModuleLoaded: boolean | null;
  fuseNativePackageInstalled: boolean;
  fuseNativeRequireError: string | null;
  mountAttempt: MountAttempt | null;
  verdict: "fuse_likely" | "fuse_unlikely" | "fuse_blocked" | "unknown";
  notes: string[];
}

interface MountAttempt {
  attempted: boolean;
  target: string;
  success: boolean;
  error: string | null;
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function checkFuseModule(): boolean | null {
  if (process.platform !== "linux") return null;
  try {
    const out = execSync("lsmod 2>/dev/null", { encoding: "utf8" });
    return /\bfuse\b/.test(out);
  } catch {
    return null;
  }
}

async function tryRequireFuseNative(): Promise<{
  ok: boolean;
  error: string | null;
}> {
  try {
    await import("fuse-native");
    return { ok: true, error: null };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function attemptMount(
  target: string,
): Promise<MountAttempt> {
  const result: MountAttempt = {
    attempted: true,
    target,
    success: false,
    error: null,
  };
  try {
    const fuseMod = (await import("fuse-native")) as unknown as {
      default: new (
        target: string,
        ops: Record<string, unknown>,
        opts?: Record<string, unknown>,
      ) => { mount: (cb: (err: Error | null) => void) => void; unmount: (cb: (err: Error | null) => void) => void };
    };
    const Fuse = fuseMod.default;
    const ops = {
      readdir(_path: string, cb: (errno: number, names: string[]) => void) {
        cb(0, ["hello.txt"]);
      },
      getattr(path: string, cb: (errno: number, stat?: unknown) => void) {
        const isRoot = path === "/";
        cb(0, {
          mtime: new Date(),
          atime: new Date(),
          ctime: new Date(),
          size: isRoot ? 4096 : 11,
          mode: isRoot ? 16877 : 33060,
          uid: 0,
          gid: 0,
        });
      },
      open(_path: string, _flags: number, cb: (errno: number, fd: number) => void) {
        cb(0, 42);
      },
      read(_path: string, _fd: number, buf: Buffer, len: number, pos: number, cb: (n: number) => void) {
        const data = Buffer.from("hello fuse\n");
        const slice = data.subarray(pos, pos + len);
        slice.copy(buf);
        cb(slice.length);
      },
    };
    const fuse = new Fuse(target, ops, { displayFolder: true });
    await new Promise<void>((resolve, reject) => {
      fuse.mount((err) => (err ? reject(err) : resolve()));
    });
    await new Promise<void>((resolve, reject) => {
      fuse.unmount((err) => (err ? reject(err) : resolve()));
    });
    result.success = true;
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  }
  return result;
}

async function main(): Promise<void> {
  const wantMount = process.argv.includes("--mount");
  const targetIdx = process.argv.indexOf("--target");
  const target = targetIdx >= 0 ? process.argv[targetIdx + 1] ?? "/tmp/llmfuse-probe" : "/tmp/llmfuse-probe";

  const fuseDevicePresent = safe(
    () => statSync("/dev/fuse").isCharacterDevice(),
    false,
  );
  const fuseDeviceReadable = safe(() => {
    accessSync("/dev/fuse", constants.R_OK | constants.W_OK);
    return true;
  }, false);
  const fuseModuleLoaded = checkFuseModule();
  const fuseNative = await tryRequireFuseNative();

  const notes: string[] = [];
  let verdict: ProbeReport["verdict"] = "unknown";
  if (process.platform === "linux") {
    if (fuseDevicePresent && fuseDeviceReadable && fuseNative.ok) {
      verdict = "fuse_likely";
      notes.push("/dev/fuse present and readable; fuse-native loaded");
    } else if (!fuseDevicePresent) {
      verdict = "fuse_blocked";
      notes.push("/dev/fuse missing — kernel does not expose FUSE");
    } else if (!fuseDeviceReadable) {
      verdict = "fuse_blocked";
      notes.push("/dev/fuse not readable by this process — needs CAP_SYS_ADMIN or fusermount");
    } else if (!fuseNative.ok) {
      verdict = "fuse_unlikely";
      notes.push(`fuse-native could not be loaded: ${fuseNative.error}`);
    }
  } else if (process.platform === "darwin") {
    notes.push("macOS requires macFUSE userspace + kext approval; this probe targets Linux microVMs");
    verdict = fuseNative.ok ? "fuse_unlikely" : "fuse_blocked";
  } else {
    verdict = "fuse_blocked";
    notes.push(`platform ${process.platform} unsupported for FUSE`);
  }

  let mountAttempt: MountAttempt | null = null;
  if (wantMount && fuseNative.ok) {
    mountAttempt = await attemptMount(target);
    if (mountAttempt.success) {
      verdict = "fuse_likely";
      notes.push("real mount + unmount succeeded");
    } else {
      if (verdict !== "fuse_blocked") verdict = "fuse_unlikely";
      notes.push(`mount attempt failed: ${mountAttempt.error}`);
    }
  }

  const report: ProbeReport = {
    schema: "llm-fuse-probe@1",
    timestamp: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    release: os.release(),
    kernelVersion: safe(() => execSync("uname -a", { encoding: "utf8" }).trim(), null),
    nodeVersion: process.version,
    isRoot: process.getuid?.() === 0,
    fuseDevicePresent,
    fuseDeviceReadable,
    fuseModuleLoaded,
    fuseNativePackageInstalled: fuseNative.ok,
    fuseNativeRequireError: fuseNative.error,
    mountAttempt,
    verdict,
    notes,
  };
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}

main().catch((err) => {
  process.stderr.write(`probe failure: ${err}\n`);
  process.exit(1);
});
