import type { TokenUsage } from "./types.js";
import { combineUsage } from "./usage.js";

export interface AgentBudgetOptions {
  maxModelCalls?: number;
  maxTotalTokens?: number;
}

export interface AgentBudgetSnapshot {
  maxModelCalls?: number;
  maxTotalTokens?: number;
  modelCalls: number;
  usage: TokenUsage;
  requestsWithUsage: number;
  usageComplete: boolean;
  tokenUsageComplete?: boolean;
}

export class AgentBudget {
  private modelCalls: number;
  private usage: TokenUsage;
  private requestsWithUsage: number;
  private activeRequests = 0;
  private usageComplete: boolean;
  private tokenUsageComplete: boolean;
  readonly maxModelCalls?: number;
  readonly maxTotalTokens?: number;

  constructor(options: AgentBudgetOptions = {}, snapshot?: AgentBudgetSnapshot) {
    const limit = options.maxModelCalls;
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) {
      throw new RangeError("maxModelCalls must be a positive integer.");
    }
    const tokenLimit = options.maxTotalTokens;
    if (tokenLimit !== undefined && (!Number.isSafeInteger(tokenLimit) || tokenLimit < 1)) {
      throw new RangeError("maxTotalTokens must be a positive integer.");
    }
    if (snapshot && (!Number.isSafeInteger(snapshot.modelCalls) || snapshot.modelCalls < 0 ||
      !Number.isSafeInteger(snapshot.requestsWithUsage) || snapshot.requestsWithUsage < 0 ||
      snapshot.requestsWithUsage > snapshot.modelCalls || typeof snapshot.usageComplete !== "boolean" ||
      (snapshot.usageComplete && snapshot.requestsWithUsage !== snapshot.modelCalls) ||
      (snapshot.tokenUsageComplete !== undefined && typeof snapshot.tokenUsageComplete !== "boolean") ||
      (snapshot.tokenUsageComplete === true && snapshot.requestsWithUsage !== snapshot.modelCalls) ||
      (tokenLimit !== undefined && snapshot.modelCalls > 0 && snapshot.tokenUsageComplete === undefined) ||
      (limit !== undefined && snapshot.modelCalls > limit) ||
      !snapshot.usage || typeof snapshot.usage !== "object" || Array.isArray(snapshot.usage) ||
      (snapshot.tokenUsageComplete === true && snapshot.modelCalls > 0 && snapshot.usage.totalTokens === undefined) ||
      Object.entries(snapshot.usage).some(([key, value]) =>
        !["inputTokens", "outputTokens", "totalTokens"].includes(key) ||
        !Number.isSafeInteger(value) || (value as number) < 0))) {
      throw new TypeError("Invalid Agent budget snapshot.");
    }
    this.maxModelCalls = limit;
    this.maxTotalTokens = tokenLimit;
    this.modelCalls = snapshot?.modelCalls ?? 0;
    this.requestsWithUsage = snapshot?.requestsWithUsage ?? 0;
    this.usage = { ...snapshot?.usage };
    this.usageComplete = snapshot?.usageComplete ?? true;
    this.tokenUsageComplete = snapshot?.tokenUsageComplete ?? (snapshot ? snapshot.usageComplete : true);
  }

  claim(): "budget_exceeded" | "usage_unavailable" | undefined {
    if (this.maxModelCalls !== undefined && this.modelCalls >= this.maxModelCalls) return "budget_exceeded";
    if (this.maxTotalTokens !== undefined) {
      if (!this.tokenUsageComplete) return "usage_unavailable";
      if ((this.usage.totalTokens ?? 0) >= this.maxTotalTokens) return "budget_exceeded";
    }
    this.modelCalls += 1;
    this.activeRequests += 1;
    return undefined;
  }

  record(usage: TokenUsage): void {
    const valid: TokenUsage = {};
    for (const key of ["inputTokens", "outputTokens", "totalTokens"] as const) {
      const value = usage[key];
      if (value === undefined) continue;
      if (!Number.isSafeInteger(value) || value < 0) {
        this.usageComplete = false;
        if (key === "totalTokens") this.tokenUsageComplete = false;
      } else {
        valid[key] = value;
      }
    }
    this.usage = combineUsage(this.usage, valid);
  }

  finishRequest(usage: TokenUsage | undefined, completed: boolean): void {
    this.activeRequests -= 1;
    if (usage) this.requestsWithUsage += 1;
    if (!completed || usage?.totalTokens === undefined || !Number.isSafeInteger(usage.totalTokens) || usage.totalTokens < 0) {
      this.tokenUsageComplete = false;
    }
    if (!completed || usage?.inputTokens === undefined || usage.outputTokens === undefined || usage.totalTokens === undefined) {
      this.usageComplete = false;
    }
  }

  checkpoint(): AgentBudgetSnapshot {
    if (this.activeRequests > 0) throw new Error("Cannot snapshot an Agent budget while model requests are active.");
    return this.snapshot();
  }

  snapshot(): AgentBudgetSnapshot {
    return {
      ...(this.maxModelCalls !== undefined ? { maxModelCalls: this.maxModelCalls } : {}),
      ...(this.maxTotalTokens !== undefined ? { maxTotalTokens: this.maxTotalTokens } : {}),
      modelCalls: this.modelCalls,
      usage: { ...this.usage },
      requestsWithUsage: this.requestsWithUsage,
      usageComplete: this.usageComplete && this.activeRequests === 0,
      tokenUsageComplete: this.tokenUsageComplete && this.activeRequests === 0,
    };
  }
}

const contexts = new WeakMap<object, AgentBudget>();

export function setBudgetContext(target: object, budget: AgentBudget): void {
  contexts.set(target, budget);
}

export function getBudgetContext(target: object): AgentBudget | undefined {
  return contexts.get(target);
}
