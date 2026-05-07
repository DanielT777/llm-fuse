import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, stat as fsStat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { LlmFuseRuntime } from "@llm-fuse/core";

export interface MountOptions {
  target: string;
  displayFolder?: boolean;
  mkdirIfMissing?: boolean;
  allowArchMismatch?: boolean;
}

export interface MountHandle {
  unmount: () => Promise<void>;
  target: string;
}

interface PreflightFailure {
  kind: "no_prebuild" | "kext_missing" | "package_missing";
  message: string;
}

function fuseNativePackageDir(): string | null {
  try {
    const req = createRequire(import.meta.url);
    return dirname(req.resolve("fuse-native/package.json"));
  } catch {
    return null;
  }
}

function preflight(allowArchMismatch: boolean): PreflightFailure | null {
  const pkgDir = fuseNativePackageDir();
  if (!pkgDir) {
    return {
      kind: "package_missing",
      message:
        "fuse-native is not installed. It is an optional dependency that may have been skipped on this platform.",
    };
  }

  if (!allowArchMismatch) {
    const expected = `${process.platform}-${process.arch}`;
    const prebuiltDir = join(pkgDir, "prebuilds", expected);
    if (!existsSync(prebuiltDir)) {
      const available = existsSync(join(pkgDir, "prebuilds"))
        ? execSync(`ls ${join(pkgDir, "prebuilds")}`, { encoding: "utf8" }).trim().split(/\s+/).join(", ")
        : "none";
      return {
        kind: "no_prebuild",
        message: [
          `fuse-native ships no native prebuild for ${expected}.`,
          `available prebuilds: ${available}`,
          process.platform === "darwin" && process.arch === "arm64"
            ? "Apple Silicon Macs need fuse-native to be rebuilt from source against macFUSE headers — and the macFUSE kext also has to be approved via Recovery / Reduced Security. Loading the x64 prebuild on arm64 will segfault Node, so the mount has been refused before invoking it."
            : "Loading a mismatched native addon will likely segfault Node. Pass --allow-arch-mismatch to attempt anyway.",
        ].join("\n"),
      };
    }
  }

  if (process.platform === "darwin") {
    try {
      const loaded = execSync("kmutil showloaded 2>/dev/null", { encoding: "utf8" });
      if (!/fuse/i.test(loaded)) {
        return {
          kind: "kext_missing",
          message:
            "macFUSE kext is not loaded (`kmutil showloaded` shows no fuse entry). Approving macFUSE on Apple Silicon requires booting into Recovery → Reduced Security → allowing third-party kernel extensions → reboot. Aborting mount.",
        };
      }
    } catch {
      // kmutil missing or sandboxed — let fuse-native try and fail.
    }
  }

  return null;
}

export async function mountFuse(
  runtime: LlmFuseRuntime,
  opts: MountOptions,
): Promise<MountHandle> {
  const { target } = opts;

  const preflightFailure = preflight(!!opts.allowArchMismatch);
  if (preflightFailure) {
    const err = new Error(preflightFailure.message);
    (err as Error & { code: string }).code = preflightFailure.kind;
    throw err;
  }

  if (opts.mkdirIfMissing !== false) {
    try {
      await fsStat(target);
    } catch {
      await mkdir(target, { recursive: true });
    }
  }

  let buildFuseHandlers: typeof import("@llm-fuse/fuse").buildFuseHandlers;
  try {
    ({ buildFuseHandlers } = await import("@llm-fuse/fuse"));
  } catch (err) {
    throw new Error(
      `failed to load @llm-fuse/fuse adapter: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let FuseCtor: new (
    target: string,
    ops: Record<string, unknown>,
    opts?: Record<string, unknown>,
  ) => {
    mount: (cb: (err: Error | null) => void) => void;
    unmount: (cb: (err: Error | null) => void) => void;
  };
  try {
    const mod = (await import("fuse-native")) as unknown as { default: typeof FuseCtor };
    FuseCtor = mod.default;
  } catch (err) {
    throw new Error(
      `fuse-native is not available: ${err instanceof Error ? err.message : String(err)}\n` +
        `On macOS install macFUSE first: brew install --cask macfuse (and approve the kernel extension in System Settings -> Privacy & Security).`,
    );
  }

  const handlers = buildFuseHandlers(runtime);
  const fuse = new FuseCtor(target, handlers as unknown as Record<string, unknown>, {
    displayFolder: opts.displayFolder ?? true,
  });

  await new Promise<void>((resolve, reject) => {
    fuse.mount((err) => (err ? reject(err) : resolve()));
  });

  return {
    target,
    unmount: () =>
      new Promise<void>((resolve, reject) => {
        fuse.unmount((err) => (err ? reject(err) : resolve()));
      }),
  };
}
