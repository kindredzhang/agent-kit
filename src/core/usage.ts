import type { TokenUsage } from "./types.js";

export function combineUsage(current: TokenUsage | undefined, next: TokenUsage): TokenUsage {
  const usage: TokenUsage = {};
  for (const key of ["inputTokens", "outputTokens", "totalTokens"] as const) {
    if (current?.[key] !== undefined || next[key] !== undefined) {
      usage[key] = (current?.[key] ?? 0) + (next[key] ?? 0);
    }
  }
  return usage;
}
