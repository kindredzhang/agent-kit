import { expect, test } from "bun:test";
import { Agent, defineTool } from "../index.js";
import type { AgentEvent, LanguageModel, ModelStreamEvent } from "../index.js";
import { z } from "zod";

async function collect(stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

const input = { messages: [{ role: "user" as const, content: "start" }] };

function hangingModel(): LanguageModel {
  return {
    provider: "openai-chat-completions",
    async *stream(request): AsyncGenerator<ModelStreamEvent> {
      await new Promise((_resolve, reject) => {
        request.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
      yield { type: "finish", finishReason: "stop" };
    },
  };
}

test("stops a run that exceeds its wall-clock budget", async () => {
  const agent = new Agent({ model: hangingModel() });
  const events = await collect(agent.stream({ ...input, budget: { maxDurationMs: 20 } }));
  expect(events.at(-1)).toMatchObject({
    type: "agent.stopped",
    stopReason: "budget_exceeded",
    budget: { maxDurationMs: 20 },
  });
});

test("rejects a non-positive wall-clock budget", async () => {
  const agent = new Agent({ model: hangingModel() });
  for (const maxDurationMs of [0, -1, 1.5]) {
    const events = await collect(agent.stream({ ...input, budget: { maxDurationMs } }));
    expect(events.at(-1)).toMatchObject({ type: "agent.failed", error: { name: "RangeError" } });
  }
});

test("does not spend wall-clock budget while the run waits for approval", async () => {
  const model: LanguageModel = {
    provider: "openai-chat-completions",
    async *stream(request): AsyncGenerator<ModelStreamEvent> {
      if (request.messages.some((message) => message.role === "tool")) {
        yield { type: "finish", finishReason: "stop" };
        return;
      }
      yield { type: "tool.call.completed", toolCall: { id: "a", name: "write", input: {} } };
      yield { type: "finish", finishReason: "tool_calls" };
    },
  };
  const tool = defineTool({ name: "write", description: "write", input: z.object({}), execute: () => "ok" });
  const agent = new Agent({ model, tools: [tool], approvalMode: "pause" });
  const paused = await collect(agent.stream({ ...input, budget: { maxDurationMs: 50 } }));
  const pause = paused.find((event) => event.type === "agent.paused");
  if (!pause || pause.type !== "agent.paused") throw new Error("expected a pause");

  await new Promise((resolve) => setTimeout(resolve, 120));
  const resumed = await collect(agent.resume({
    state: pause.runState,
    approval: { toolCallId: "a", decision: "approved" },
  }));
  expect(resumed.at(-1)).toMatchObject({ type: "agent.completed" });
});

test("carries elapsed wall-clock time across a resume", async () => {
  const model: LanguageModel = {
    provider: "openai-chat-completions",
    async *stream(request): AsyncGenerator<ModelStreamEvent> {
      if (request.messages.some((message) => message.role === "tool")) {
        yield { type: "finish", finishReason: "stop" };
        return;
      }
      yield { type: "tool.call.completed", toolCall: { id: "a", name: "write", input: {} } };
      yield { type: "finish", finishReason: "tool_calls" };
    },
  };
  const tool = defineTool({ name: "write", description: "write", input: z.object({}), execute: () => "ok" });
  const agent = new Agent({ model, tools: [tool], approvalMode: "pause" });
  const paused = await collect(agent.stream({ ...input, budget: { maxDurationMs: 30 } }));
  const pause = paused.find((event) => event.type === "agent.paused");
  if (!pause || pause.type !== "agent.paused") throw new Error("expected a pause");
  expect(pause.runState.budget?.maxDurationMs).toBe(30);

  const resumed = await collect(agent.resume({
    state: pause.runState,
    approval: { toolCallId: "a", decision: "approved" },
  }));
  expect(resumed.at(-1)).toMatchObject({ type: "agent.completed" });
});

test("times out a tool that never settles and reports it as a tool failure", async () => {
  const neverSettles = defineTool({
    name: "hang",
    description: "hang",
    input: z.object({}),
    annotations: { readOnly: true },
    timeoutMs: 20,
    execute: () => new Promise(() => {}),
  });
  const model: LanguageModel = {
    provider: "openai-chat-completions",
    async *stream(request): AsyncGenerator<ModelStreamEvent> {
      if (request.messages.some((message) => message.role === "tool")) {
        yield { type: "finish", finishReason: "stop" };
        return;
      }
      yield { type: "tool.call.completed", toolCall: { id: "a", name: "hang", input: {} } };
      yield { type: "finish", finishReason: "tool_calls" };
    },
  };
  const agent = new Agent({ model, tools: [neverSettles] });
  const events = await collect(agent.stream(input));
  const failure = events.find((event) => event.type === "tool.execution.failed");
  expect(failure).toMatchObject({ name: "hang", error: { name: "TimeoutError" } });
  expect(events.at(-1)).toMatchObject({ type: "agent.completed" });
});

test("rejects an invalid tool timeout", () => {
  expect(() => defineTool({
    name: "bad",
    description: "bad",
    input: z.object({}),
    timeoutMs: 0,
    execute: () => "ok",
  })).toThrow(RangeError);
});

test("reports the wall-clock budget, not cancellation, when a tool ignores the abort", async () => {  const ignoresAbort = defineTool({
    name: "stubborn",
    description: "stubborn",
    input: z.object({}),
    annotations: { readOnly: true },
    execute: async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
      return "done";
    },
  });
  const model: LanguageModel = {
    provider: "openai-chat-completions",
    async *stream(request): AsyncGenerator<ModelStreamEvent> {
      if (request.messages.some((message) => message.role === "tool")) {
        yield { type: "finish", finishReason: "stop" };
        return;
      }
      yield { type: "tool.call.completed", toolCall: { id: "a", name: "stubborn", input: {} } };
      yield { type: "finish", finishReason: "tool_calls" };
    },
  };
  const agent = new Agent({ model, tools: [ignoresAbort] });
  const events = await collect(agent.stream({ ...input, budget: { maxDurationMs: 20 } }));
  expect(events.at(-1)).toMatchObject({ type: "agent.stopped", stopReason: "budget_exceeded" });
});

test("stops a run whose tool never settles even when the tool declares no timeout", async () => {
  const neverSettles = defineTool({
    name: "hang",
    description: "hang",
    input: z.object({}),
    annotations: { readOnly: true },
    execute: () => new Promise(() => {}),
  });
  const model: LanguageModel = {
    provider: "openai-chat-completions",
    async *stream(request): AsyncGenerator<ModelStreamEvent> {
      if (request.messages.some((message) => message.role === "tool")) {
        yield { type: "finish", finishReason: "stop" };
        return;
      }
      yield { type: "tool.call.completed", toolCall: { id: "a", name: "hang", input: {} } };
      yield { type: "finish", finishReason: "tool_calls" };
    },
  };
  const agent = new Agent({ model, tools: [neverSettles] });
  const events = await collect(agent.stream({ ...input, budget: { maxDurationMs: 20 } }));
  expect(events.at(-1)).toMatchObject({ type: "agent.stopped", stopReason: "budget_exceeded" });
});
