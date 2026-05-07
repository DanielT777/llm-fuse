import { NullAuditSink, type AuditSink } from "./audit.js";
import { normalizePath, splitPath } from "./path.js";
import { PolicyEngine } from "./policy.js";
import {
  LlmFuseError,
  type LlmFuseCapability,
  type LlmFuseDirEntry,
  type LlmFuseInvokeResult,
  type LlmFuseNode,
  type LlmFuseProvider,
  type LlmFuseReadResult,
  type LlmFuseWriteInput,
  type LlmFuseWriteResult,
} from "./types.js";

export interface RuntimeOptions {
  providers: LlmFuseProvider[];
  policy?: PolicyEngine;
  audit?: AuditSink;
  readBytesLimit?: number;
  listEntriesLimit?: number;
}

interface ProviderMatch {
  provider: LlmFuseProvider;
  innerPath: string;
}

export class LlmFuseRuntime {
  private readonly providers: Map<string, LlmFuseProvider>;
  private readonly policy: PolicyEngine;
  private readonly audit: AuditSink;
  private readonly readBytesLimit: number;
  private readonly listEntriesLimit: number;

  constructor(opts: RuntimeOptions) {
    this.providers = new Map();
    for (const p of opts.providers) {
      this.providers.set(normalizePath(p.mountPoint), p);
    }
    this.policy = opts.policy ?? new PolicyEngine([], "allow");
    this.audit = opts.audit ?? new NullAuditSink();
    this.readBytesLimit = opts.readBytesLimit ?? 16_000;
    this.listEntriesLimit = opts.listEntriesLimit ?? 200;
  }

  listMountPoints(): string[] {
    return Array.from(this.providers.keys()).sort();
  }

  private resolve(path: string): ProviderMatch | null {
    const norm = normalizePath(path);
    if (norm === "/") return null;
    const segs = splitPath(norm);
    for (let i = segs.length; i >= 1; i--) {
      const candidate = "/" + segs.slice(0, i).join("/");
      const p = this.providers.get(candidate);
      if (p) {
        const inner = "/" + segs.slice(i).join("/");
        return { provider: p, innerPath: inner === "/" ? "/" : inner };
      }
    }
    return null;
  }

  private async guard<T>(
    capability: LlmFuseCapability,
    path: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const decision = this.policy.evaluate(capability, normalizePath(path));
    const start = Date.now();
    if (decision.effect === "deny") {
      this.audit.emit({
        timestamp: new Date().toISOString(),
        capability,
        path: normalizePath(path),
        decision: "deny",
        ruleMatched: decision.ruleMatched,
        ok: false,
        error: "EACCES",
      });
      throw new LlmFuseError(
        `permission denied: ${capability} ${path}`,
        "EACCES",
      );
    }
    try {
      const result = await fn();
      this.audit.emit({
        timestamp: new Date().toISOString(),
        capability,
        path: normalizePath(path),
        decision: "allow",
        ruleMatched: decision.ruleMatched,
        durationMs: Date.now() - start,
        ok: true,
      });
      return result;
    } catch (err) {
      this.audit.emit({
        timestamp: new Date().toISOString(),
        capability,
        path: normalizePath(path),
        decision: "allow",
        ruleMatched: decision.ruleMatched,
        durationMs: Date.now() - start,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  async stat(path: string): Promise<LlmFuseNode> {
    const norm = normalizePath(path);
    if (norm === "/") {
      return {
        path: "/",
        kind: "dir",
        capabilities: ["list"],
      };
    }
    const match = this.resolve(norm);
    if (!match) {
      const segs = splitPath(norm);
      if (segs.length === 1) {
        const candidate = "/" + segs[0];
        if (this.providers.has(candidate)) {
          return { path: candidate, kind: "dir", capabilities: ["list"] };
        }
      }
      throw new LlmFuseError(`no provider for ${norm}`, "ENOENT");
    }
    return this.guard("read", norm, async () => {
      const inner = await match.provider.stat(match.innerPath);
      return { ...inner, path: norm };
    });
  }

  async list(path: string): Promise<LlmFuseDirEntry[]> {
    const norm = normalizePath(path);
    if (norm === "/") {
      const entries: LlmFuseDirEntry[] = Array.from(
        this.providers.keys(),
      ).map((mount) => ({
        name: mount.replace(/^\//, ""),
        kind: "dir" as const,
        capabilities: ["list"] as LlmFuseCapability[],
      }));
      return this.policy.filterDirEntries("/", entries).slice(0, this.listEntriesLimit);
    }
    const match = this.resolve(norm);
    if (!match) throw new LlmFuseError(`no provider for ${norm}`, "ENOENT");

    return this.guard("list", norm, async () => {
      const raw = await match.provider.list(match.innerPath);
      return this.policy
        .filterDirEntries(norm, raw)
        .slice(0, this.listEntriesLimit);
    });
  }

  async read(path: string): Promise<LlmFuseReadResult> {
    const norm = normalizePath(path);
    const match = this.resolve(norm);
    if (!match) throw new LlmFuseError(`no provider for ${norm}`, "ENOENT");

    return this.guard("read", norm, async () => {
      const result = await match.provider.read(match.innerPath);
      if (Buffer.byteLength(result.body, "utf8") > this.readBytesLimit) {
        const total = Buffer.byteLength(result.body, "utf8");
        const truncated = Buffer.from(result.body, "utf8")
          .slice(0, this.readBytesLimit)
          .toString("utf8");
        return {
          ...result,
          body:
            truncated +
            `\n... [truncated: ${total} total bytes, showing ${this.readBytesLimit}]`,
          truncated: true,
          totalBytes: total,
        };
      }
      return result;
    });
  }

  async write(path: string, input: LlmFuseWriteInput): Promise<LlmFuseWriteResult> {
    const norm = normalizePath(path);
    const match = this.resolve(norm);
    if (!match) throw new LlmFuseError(`no provider for ${norm}`, "ENOENT");
    if (!match.provider.write) {
      throw new LlmFuseError(`write not supported on ${norm}`, "ENOTSUP");
    }
    return this.guard("write", norm, () => match.provider.write!(match.innerPath, input));
  }

  async invoke(path: string, input: unknown): Promise<LlmFuseInvokeResult> {
    const norm = normalizePath(path);
    const match = this.resolve(norm);
    if (!match) throw new LlmFuseError(`no provider for ${norm}`, "ENOENT");
    if (!match.provider.invoke) {
      throw new LlmFuseError(`invoke not supported on ${norm}`, "ENOTSUP");
    }
    return this.guard("invoke", norm, () => match.provider.invoke!(match.innerPath, input));
  }
}
