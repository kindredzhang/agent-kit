import { expect, test } from "bun:test";
import { Agent, createSubagentTool, defineTool } from "../index";
import type { AgentEvent, LanguageModel, ModelStreamEvent } from "../index";
import { z } from "zod";

async function collect(stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

const input = { messages: [{ role: "user" as const, content: "start" }] };
const tool = defineTool({ name: "read", description: "read", input: z.object({}), annotations: { readOnly: true }, execute: () => "ok" });

function modelWithUsage(usage?: { totalTokens?: number; inputTokens?: number; outputTokens?: number }): LanguageModel {
  return {
    provider: "openai-chat-completions",
    async *stream(): AsyncGenerator<ModelStreamEvent> {
      if (usage) yield { type: "usage", usage };
      yield { type: "tool.call.completed", toolCall: { id: "call", name: "read", input: {} } };
      yield { type: "finish", finishReason: "tool_calls" };
    },
  };
}

test("stops subsequent model calls when reported tokens reach the shared limit", async () => {
  const agent = new Agent({ model: modelWithUsage({ totalTokens: 12 }), tools: [tool] });
  const events = await collect(agent.stream({ ...input, budget: { maxTotalTokens: 10 } }));
  expect(events.at(-1)).toMatchObject({ type: "agent.stopped", stopReason: "budget_exceeded", budget: { maxTotalTokens: 10, modelCalls: 1, usage: { totalTokens: 12 } } });
});

test("stops subsequent calls if total token usage is missing", async () => {
  for (const usage of [undefined, { inputTokens: 2 }, { totalTokens: -1 }]) {
    const agent = new Agent({ model: modelWithUsage(usage), tools: [tool] });
    const events = await collect(agent.stream({ ...input, budget: { maxTotalTokens: 10 } }));
    expect(events.at(-1)).toMatchObject({ type: "agent.stopped", stopReason: "usage_unavailable", budget: { modelCalls: 1 } });
  }
});

test("retains token budget across max-turn recovery", async () => {
  const model = modelWithUsage({ totalTokens: 4 });
  const stopped = await collect(new Agent({ model, tools: [tool], maxTurns: 1 }).stream({ ...input, budget: { maxTotalTokens: 4 } }));
  const event = stopped.at(-1);
  if (event?.type !== "agent.stopped" || !event.runState) throw new Error("expected run state");
  const resumed = await collect(new Agent({ model, tools: [tool], maxTurns: 2 }).resume({ state: event.runState }));
  expect(resumed.at(-1)).toMatchObject({ type: "agent.stopped", stopReason: "budget_exceeded", budget: { maxTotalTokens: 4, usage: { totalTokens: 4 } } });
});

test("approval recovery retains the token usage and limit", async () => {
  const write = defineTool({ name: "read", description: "write", input: z.object({}), execute: () => "ok" });
  const agent = new Agent({ model: modelWithUsage({ totalTokens: 5 }), tools: [write], approvalMode: "pause" });
  const events = await collect(agent.stream({ ...input, budget: { maxTotalTokens: 5 } }));
  const paused = events.find((event) => event.type === "agent.paused");
  if (!paused || paused.type !== "agent.paused") throw new Error("expected approval pause");
  const resumed = await collect(agent.resume({ state: paused.runState, approval: { toolCallId: "call", decision: "approved" } }));
  expect(resumed.at(-1)).toMatchObject({ type: "agent.stopped", stopReason: "budget_exceeded", budget: { usage: { totalTokens: 5 }, maxTotalTokens: 5 } });
});

test("a failed child with partial usage blocks future requests", async () => {
  const child: LanguageModel = {
    provider: "openai-chat-completions",
    async *stream(): AsyncGenerator<ModelStreamEvent> {
      yield { type: "usage", usage: { totalTokens: 3 } };
      throw new Error("connection lost");
    },
  };
  const delegate = createSubagentTool({ name: "delegate", description: "delegate", createAgent: () => new Agent({ model: child }) });
  const parent: LanguageModel = {
    provider: "openai-chat-completions",
    async *stream(): AsyncGenerator<ModelStreamEvent> {
      yield { type: "usage", usage: { totalTokens: 2 } };
      yield { type: "tool.call.completed", toolCall: { id: "a", name: "delegate", input: { task: "work" } } };
      yield { type: "finish", finishReason: "tool_calls" };
    },
  };
  const events = await collect(new Agent({ model: parent, tools: [delegate] }).stream({ ...input, budget: { maxTotalTokens: 100 } }));
  expect(events.at(-1)).toMatchObject({ type: "agent.stopped", stopReason: "usage_unavailable", budget: { modelCalls: 2, tokenUsageComplete: false, usage: { totalTokens: 5 } } });
});

test("cancellation preserves usage reported before the interruption", async () => {
  const controller = new AbortController();
  const model: LanguageModel = {
    provider: "openai-chat-completions",
    async *stream(): AsyncGenerator<ModelStreamEvent> {
      yield { type: "usage", usage: { totalTokens: 7 } };
      controller.abort();
      throw new DOMException("aborted", "AbortError");
    },
  };
  const events = await collect(new Agent({ model }).stream({ ...input, signal: controller.signal, budget: { maxTotalTokens: 10 } }));
  expect(events.at(-2)).toMatchObject({ type: "agent.budget.updated", budget: { usage: { totalTokens: 7 }, tokenUsageComplete: false } });
  expect(events.at(-1)).toMatchObject({ type: "agent.stopped", stopReason: "cancelled" });
});

test("rejects invalid token limits", async () => {
  const events = await collect(new Agent({ model: modelWithUsage() }).stream({ ...input, budget: { maxTotalTokens: 0 } }));
  const failure = events.at(-1);
  if (failure?.type !== "agent.failed") throw new Error("expected failure");
  expect(failure.error.message).toBe("maxTotalTokens must be a positive integer.");
});

test("allows already running child requests to finish while blocking later calls", async () => {
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  let entered = 0;
  const child: LanguageModel = {
    provider: "openai-chat-completions",
    async *stream(): AsyncGenerator<ModelStreamEvent> {
      entered++;
      if (entered === 2) release();
      await barrier;
      yield { type: "usage", usage: { totalTokens: 8 } };
      yield { type: "finish", finishReason: "stop" };
    },
  };
  const delegate = createSubagentTool({ name: "delegate", description: "delegate", createAgent: () => new Agent({ model: child }) });
  let parentCalls = 0;
  const parent: LanguageModel = {
    provider: "openai-chat-completions",
    async *stream(): AsyncGenerator<ModelStreamEvent> {
      parentCalls++;
      yield { type: "usage", usage: { totalTokens: 1 } };
      for (const id of ["a", "b"]) yield { type: "tool.call.completed", toolCall: { id, name: "delegate", input: { task: id } } };
      yield { type: "finish", finishReason: "tool_calls" };
    },
  };
  const events = await collect(new Agent({ model: parent, tools: [delegate] }).stream({ ...input, budget: { maxTotalTokens: 10 } }));
  expect(entered).toBe(2);
  expect(parentCalls).toBe(1);
  expect(events.at(-1)).toMatchObject({ type: "agent.stopped", stopReason: "budget_exceeded", budget: { modelCalls: 3, usage: { totalTokens: 17 } } });
});
