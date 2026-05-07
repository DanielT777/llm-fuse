export type LlmFuseCapability = "list" | "read" | "write" | "invoke";

export type LlmFuseNodeKind = "dir" | "file" | "action";

export interface LlmFuseNode {
  path: string;
  kind: LlmFuseNodeKind;
  capabilities: LlmFuseCapability[];
  size?: number;
  contentType?: string;
}

export interface LlmFuseDirEntry {
  name: string;
  kind: LlmFuseNodeKind;
  capabilities: LlmFuseCapability[];
}

export interface LlmFuseReadResult {
  contentType: string;
  body: string;
  truncated?: boolean;
  totalBytes?: number;
}

export interface LlmFuseWriteInput {
  contentType: string;
  body: string;
}

export interface LlmFuseWriteResult {
  ok: boolean;
  path?: string;
}

export interface LlmFuseInvokeResult {
  ok: boolean;
  output: unknown;
  contentType?: string;
}

export interface LlmFuseProvider {
  readonly name: string;
  readonly mountPoint: string;
  stat(path: string): Promise<LlmFuseNode>;
  list(path: string): Promise<LlmFuseDirEntry[]>;
  read(path: string): Promise<LlmFuseReadResult>;
  write?(path: string, input: LlmFuseWriteInput): Promise<LlmFuseWriteResult>;
  invoke?(path: string, input: unknown): Promise<LlmFuseInvokeResult>;
}

export type PolicyEffect = "allow" | "deny";

export interface PolicyRule {
  effect: PolicyEffect;
  capabilities: LlmFuseCapability[];
  pathGlob: string;
}

export interface AuditEvent {
  timestamp: string;
  capability: LlmFuseCapability;
  path: string;
  decision: PolicyEffect;
  ruleMatched?: string;
  durationMs?: number;
  ok?: boolean;
  error?: string;
}

export class LlmFuseError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "ENOENT"
      | "EACCES"
      | "ENOTSUP"
      | "EINVAL"
      | "EIO",
  ) {
    super(message);
    this.name = "LlmFuseError";
  }
}
