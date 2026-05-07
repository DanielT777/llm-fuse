import type { AuditEvent } from "./types.js";

export interface AuditSink {
  emit(event: AuditEvent): void;
}

export class StderrAuditSink implements AuditSink {
  emit(event: AuditEvent): void {
    process.stderr.write(JSON.stringify({ kind: "audit", ...event }) + "\n");
  }
}

export class MemoryAuditSink implements AuditSink {
  readonly events: AuditEvent[] = [];
  emit(event: AuditEvent): void {
    this.events.push(event);
  }
}

export class NullAuditSink implements AuditSink {
  emit(): void {}
}
