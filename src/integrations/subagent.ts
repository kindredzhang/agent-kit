import { z } from "zod";
import { defineTool } from "../core/tools";
import type { AnyAgentTool, ToolExecutionContext } from "../core/tools";
import type { Agent } from "../core/agent";
import type { TokenUsage } from "../core/types";

export interface SubagentToolOptions {
  name: string;
  description: string;
  createAgent: (depth: number) => Agent;
  maxDepth?: number;
  maxConcurrency?: number;
  onUsage?: (usage: TokenUsage) => void;
}

const DEFAULT_MAX_DEPTH = 3;
const DEFAULT_MAX_CONCURRENCY = 2;
const taskInput = z.object({ task: z.string().min(1) });
const subagentDepths = new WeakMap<AbortSignal, number>();

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer.`);
  }
}

function abortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

class Semaphore {
  private active = 0;
  private readonly waiters: (() => void)[] = [];

  constructor(private readonly limit: number) {}

  async acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw abortError();
    if (this.active < this.limit) {
      this.active += 1;
      return;
    }

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const onAbort = () => {
        if (settled) return;
        settled = true;
        const index = this.waiters.indexOf(grant);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(abortError());
      };
      const grant = () => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      this.waiters.push(grant);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) {
      next();
      return;
    }
    this.active -= 1;
  }
}

interface SubagentOutcome {
  content?: string;
  stopReason: string;
  error?: Error;
  usage?: TokenUsage;
}

async function runSubagent(input: {
  agent: Agent;
  task: string;
  signal: AbortSignal;
}): Promise<SubagentOutcome> {
  let content: string | undefined;
  let stopReason = "no terminal event";
  let error: Error | undefined;
  let usage: TokenUsage | undefined;

  for await (const event of input.agent.stream({
    messages: [{ role: "user", content: input.task }],
    signal: input.signal,
  })) {
    switch (event.type) {
      case "agent.completed":
        content = event.message.content;
        stopReason = event.stopReason;
        usage = event.usage;
        break;
      case "agent.stopped":
        content = event.message?.content;
        stopReason = event.stopReason;
        usage = event.usage;
        break;
      case "agent.failed":
        stopReason = event.stopReason;
        error = event.error;
        usage = event.usage;
        break;
    }
  }

  return {
    ...(content !== undefined ? { content } : {}),
    stopReason,
    ...(error ? { error } : {}),
    ...(usage ? { usage } : {}),
  };
}

function describeOutcome(outcome: SubagentOutcome): string {
  if (outcome.error) return `${outcome.stopReason}: ${outcome.error.message}`;
  if (outcome.content) return `${outcome.stopReason}: ${outcome.content}`;
  return outcome.stopReason;
}

export function createSubagentTool(options: SubagentToolOptions): AnyAgentTool {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxConcurrency = options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
  assertPositiveInteger(maxDepth, "maxDepth");
  assertPositiveInteger(maxConcurrency, "maxConcurrency");

  const semaphoresByDepth = new Map<number, Semaphore>();
  const semaphoreFor = (depth: number): Semaphore => {
    const existing = semaphoresByDepth.get(depth);
    if (existing) return existing;
    const created = new Semaphore(maxConcurrency);
    semaphoresByDepth.set(depth, created);
    return created;
  };

  return defineTool({
    name: options.name,
    description: options.description,
    input: taskInput,
    annotations: { readOnly: true },
    execute: async ({ task }, context) => {
      const depth = (context.signal ? subagentDepths.get(context.signal) : undefined) ?? 0;
      if (depth >= maxDepth) {
        throw new Error(`Subagent depth limit reached (maxDepth: ${maxDepth}).`);
      }

      const semaphore = semaphoreFor(depth);
      await semaphore.acquire(context.signal);
      try {
        const child = new AbortController();
        const forwardAbort = () => child.abort(context.signal?.reason);
        context.signal?.addEventListener("abort", forwardAbort, { once: true });
        if (context.signal?.aborted) child.abort(context.signal.reason);
        subagentDepths.set(child.signal, depth + 1);

        try {
          const outcome = await runSubagent({ agent: options.createAgent(depth + 1), task, signal: child.signal });
          if (outcome.usage) options.onUsage?.(outcome.usage);
          if (child.signal.aborted) throw abortError();
          if (outcome.stopReason !== "completed") {
            throw new Error(`Subagent run ended with ${describeOutcome(outcome)}`);
          }
          return outcome.content ?? "";
        } finally {
          context.signal?.removeEventListener("abort", forwardAbort);
          subagentDepths.delete(child.signal);
        }
      } finally {
        semaphore.release();
      }
    },
  });
}
