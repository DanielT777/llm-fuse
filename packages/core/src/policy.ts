import { matchGlob } from "./path.js";
import type {
  LlmFuseCapability,
  PolicyEffect,
  PolicyRule,
} from "./types.js";

export interface PolicyDecision {
  effect: PolicyEffect;
  ruleMatched?: string;
}

export class PolicyEngine {
  constructor(
    private readonly rules: PolicyRule[],
    private readonly defaultEffect: PolicyEffect = "allow",
  ) {}

  evaluate(capability: LlmFuseCapability, path: string): PolicyDecision {
    for (let i = this.rules.length - 1; i >= 0; i--) {
      const rule = this.rules[i];
      if (!rule) continue;
      if (
        rule.capabilities.includes(capability) &&
        matchGlob(rule.pathGlob, path)
      ) {
        return {
          effect: rule.effect,
          ruleMatched: `${rule.effect} ${rule.capabilities.join(",")} ${rule.pathGlob}`,
        };
      }
    }
    return { effect: this.defaultEffect };
  }

  filterDirEntries<T extends { name: string; capabilities: LlmFuseCapability[] }>(
    parentPath: string,
    entries: T[],
  ): T[] {
    return entries.filter((entry) => {
      const childPath =
        parentPath === "/" ? `/${entry.name}` : `${parentPath}/${entry.name}`;
      const decision = this.evaluate("list", childPath);
      return decision.effect === "allow";
    });
  }
}
