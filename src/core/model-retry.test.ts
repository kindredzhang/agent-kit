import { expect, test } from "bun:test";
import { Agent } from "../index.js";
import type { AgentEvent, LanguageModel, ModelStreamEvent } from "../index.js";

async function collect(stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

const input = { messages: [{ role: "user" as const, content: "go" }] };

function failingThenSucceeding(failures: number): LanguageModel {
  let calls = 0;
  return {
    provider: "openai-chat-completions",
    async *stream(): AsyncGenerator<ModelStreamEvent> {
      calls += 1;
      if (calls <= failures) throw new Error(`failure ${calls}`);
      yield { type: "text.delta", delta: "hello" };
      yield { type: "finish", finishReason: "stop" };
    },
  };
}

test("retries a model request that fails before emitting anything", async () => {
  const events = await collect(new Agent({
    model: failingThenSucceeding(2),
    modelRetry: { maxAttempts: 3 },
  }).stream(input));
  expect(events.filter((event) => event.type === "model.request.retrying")).toHaveLength(2);
  expect(events.find((event) => event.type === "model.request.retrying")).toMatchObject({
    turn: 1,
    attempt: 1,
    maxAttempts: 3,
    error: { message: "failure 1" },
  });
  expect(events.at(-1)).toMatchObject({ type: "agent.completed", message: { content: "hello" } });
  const completed = events.find((event) => event.type === "message.completed");
  expect(completed).toMatchObject({ message: { content: "hello" } });
});

test("does not retry once the stream has emitted content", async () => {
  let calls = 0;
  const model: LanguageModel = {
    provider: "openai-chat-completions",
    async *stream(): AsyncGenerator<ModelStreamEvent> {
      calls += 1;
      yield { type: "text.delta", delta: "partial" };
      throw new Error("connection lost");
    },
  };
  const events = await collect(new Agent({ model, modelRetry: { maxAttempts: 3 } }).stream(input));
  expect(calls).toBe(1);
  expect(events.some((event) => event.type === "model.request.retrying")).toBe(false);
  expect(events.at(-1)).toMatchObject({ type: "agent.failed", error: { message: "connection lost" } });
});

test("each attempt claims its own model call budget slot", async () => {
  const events = await collect(new Agent({
    model: failingThenSucceeding(1),
    modelRetry: { maxAttempts: 3 },
  }).stream({ ...input, budget: { maxModelCalls: 1 } }));
  expect(events.at(-1)).toMatchObject({ type: "agent.stopped", stopReason: "budget_exceeded", budget: { modelCalls: 1 } });
});

test("stops retrying when shouldRetry declines the error", async () => {
  const events = await collect(new Agent({
    model: failingThenSucceeding(3),
    modelRetry: { maxAttempts: 5, shouldRetry: ({ error }) => !error.message.includes("failure 1") },
  }).stream(input));
  expect(events.some((event) => event.type === "model.request.retrying")).toBe(false);
  expect(events.at(-1)).toMatchObject({ type: "agent.failed", error: { message: "failure 1" } });
});

test("gives up after exhausting the attempts", async () => {
  const events = await collect(new Agent({
    model: failingThenSucceeding(5),
    modelRetry: { maxAttempts: 2 },
  }).stream(input));
  expect(events.filter((event) => event.type === "model.request.retrying")).toHaveLength(1);
  expect(events.at(-1)).toMatchObject({ type: "agent.failed", error: { message: "failure 2" } });
});

test("never retries an aborted request", async () => {
  const controller = new AbortController();
  let calls = 0;
  const model: LanguageModel = {
    provider: "openai-chat-completions",
    async *stream(): AsyncGenerator<ModelStreamEvent> {
      calls += 1;
      controller.abort();
      throw new DOMException("aborted", "AbortError");
    },
  };
  const events = await collect(new Agent({ model, modelRetry: { maxAttempts: 3 } }).stream({ ...input, signal: controller.signal }));
  expect(calls).toBe(1);
  expect(events.at(-1)).toMatchObject({ type: "agent.stopped", stopReason: "cancelled" });
});

test("cancellation during the retry delay stops the run without another attempt", async () => {
  const controller = new AbortController();
  let calls = 0;
  const model: LanguageModel = {
    provider: "openai-chat-completions",
    async *stream(): AsyncGenerator<ModelStreamEvent> {
      calls += 1;
      setTimeout(() => controller.abort(), 5);
      throw new Error("temporary");
    },
  };
  const startedAt = performance.now();
  const events = await collect(new Agent({
    model,
    modelRetry: { maxAttempts: 3, delayMs: 5000 },
  }).stream({ ...input, signal: controller.signal }));
  expect(performance.now() - startedAt).toBeLessThan(1000);
  expect(calls).toBe(1);
  expect(events.at(-1)).toMatchObject({ type: "agent.stopped", stopReason: "cancelled" });
});

test("a failed attempt without reported tokens blocks retry under a token budget", async () => {
  const events = await collect(new Agent({
    model: failingThenSucceeding(1),
    modelRetry: { maxAttempts: 3 },
  }).stream({ ...input, budget: { maxTotalTokens: 1000 } }));
  expect(events.at(-1)).toMatchObject({ type: "agent.stopped", stopReason: "usage_unavailable" });
});

test("rejects invalid model retry policies", () => {
  const model = failingThenSucceeding(0);
  expect(() => new Agent({ model, modelRetry: { maxAttempts: 0 } })).toThrow("modelRetry.maxAttempts");
  expect(() => new Agent({ model, modelRetry: { maxAttempts: 2, delayMs: -1 } })).toThrow("modelRetry.delayMs");
});

test("records model retries in the trace", async () => {
  const { AgentTraceCollector } = await import("../index");
  const collector = new AgentTraceCollector();
  for await (const event of new Agent({
    model: failingThenSucceeding(1),
    modelRetry: { maxAttempts: 2 },
  }).stream(input)) {
    collector.record(event);
  }
  const trace = collector.finish()!;
  expect(trace.turns[0]).toMatchObject({ modelRetries: 1 });
  expect(trace.turns[0]?.model).toMatchObject({ finishReason: "stop" });
});
