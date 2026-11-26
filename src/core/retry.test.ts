import { expect, test } from "bun:test";
import { z } from "zod";
import { Agent, AgentTraceCollector, defineTool } from "../index.js";
import type { AgentEvent, LanguageModel, ModelStreamEvent } from "../index.js";

async function collect(stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

const input = { messages: [{ role: "user" as const, content: "go" }] };

function toolThenDone(toolName: string, verify?: (messages: readonly { role: string; content?: unknown }[]) => void): LanguageModel {
  let calls = 0;
  return {
    provider: "openai-chat-completions",
    async *stream({ messages }): AsyncGenerator<ModelStreamEvent> {
      calls += 1;
      if (calls === 1) {
        yield { type: "tool.call.completed", toolCall: { id: "call", name: toolName, input: {} } };
        yield { type: "finish", finishReason: "tool_calls" };
      } else {
        verify?.(messages);
        yield { type: "finish", finishReason: "stop" };
      }
    },
  };
}

test("retries a tool that declares a retry policy and reports the attempt count", async () => {
  let executions = 0;
  const tool = defineTool({
    name: "fetch",
    description: "fetch",
    input: z.object({}),
    annotations: { readOnly: true, idempotent: true },
    retry: { maxAttempts: 3 },
    execute: () => {
      executions += 1;
      if (executions < 3) throw new Error("temporary failure");
      return "ok";
    },
  });
  const events = await collect(new Agent({ model: toolThenDone("fetch"), tools: [tool] }).stream(input));
  expect(executions).toBe(3);
  expect(events.some((event) => event.type === "tool.execution.failed")).toBe(false);
  expect(events.find((event) => event.type === "tool.execution.completed")).toMatchObject({ result: "ok", attempts: 3 });
  expect(events.at(-1)?.type).toBe("agent.completed");
});

test("does not retry a tool without a retry policy", async () => {
  let executions = 0;
  const tool = defineTool({
    name: "fetch",
    description: "fetch",
    input: z.object({}),
    annotations: { readOnly: true },
    execute: () => {
      executions += 1;
      throw new Error("failure");
    },
  });
  const events = await collect(new Agent({ model: toolThenDone("fetch"), tools: [tool] }).stream(input));
  expect(executions).toBe(1);
  expect(events.find((event) => event.type === "tool.execution.failed")).toMatchObject({
    error: { message: "failure" },
  });
  expect(events.find((event) => event.type === "tool.execution.failed")).not.toHaveProperty("attempts");
});

test("stops retrying when the policy filter rejects the error", async () => {
  let executions = 0;
  const tool = defineTool({
    name: "fetch",
    description: "fetch",
    input: z.object({}),
    annotations: { readOnly: true, idempotent: true },
    retry: { maxAttempts: 5, shouldRetry: ({ error }) => error.message !== "fatal" },
    execute: () => {
      executions += 1;
      throw new Error("fatal");
    },
  });
  const events = await collect(new Agent({ model: toolThenDone("fetch"), tools: [tool] }).stream(input));
  expect(executions).toBe(1);
  expect(events.find((event) => event.type === "tool.execution.failed")).toMatchObject({ error: { message: "fatal" } });
});

test("reports the last error and attempts after exhausting the policy", async () => {
  let executions = 0;
  const tool = defineTool({
    name: "fetch",
    description: "fetch",
    input: z.object({}),
    annotations: { readOnly: true, idempotent: true },
    retry: { maxAttempts: 2 },
    execute: () => {
      executions += 1;
      throw new Error(`failure ${executions}`);
    },
  });
  const events = await collect(new Agent({ model: toolThenDone("fetch"), tools: [tool] }).stream(input));
  expect(executions).toBe(2);
  expect(events.find((event) => event.type === "tool.execution.failed")).toMatchObject({
    error: { message: "failure 2" },
    attempts: 2,
  });
  expect(events.at(-1)?.type).toBe("agent.completed");
});

test("requests approval once and retries only after it is granted", async () => {
  let executions = 0;
  let approvals = 0;
  const tool = defineTool({
    name: "write",
    description: "write",
    input: z.object({}),
    retry: { maxAttempts: 2 },
    execute: () => {
      executions += 1;
      if (executions === 1) throw new Error("temporary");
      return "saved";
    },
  });
  const events = await collect(new Agent({
    model: toolThenDone("write"),
    tools: [tool],
    approveTool: () => {
      approvals += 1;
      return true;
    },
  }).stream(input));
  expect(approvals).toBe(1);
  expect(executions).toBe(2);
  expect(events.find((event) => event.type === "tool.execution.completed")).toMatchObject({ result: "saved", attempts: 2 });
});

test("cancellation during the retry delay stops the run without another attempt", async () => {
  const controller = new AbortController();
  let executions = 0;
  const tool = defineTool({
    name: "fetch",
    description: "fetch",
    input: z.object({}),
    annotations: { readOnly: true, idempotent: true },
    retry: { maxAttempts: 5, delayMs: 5000 },
    execute: () => {
      executions += 1;
      setTimeout(() => controller.abort(), 5);
      throw new Error("temporary");
    },
  });
  const startedAt = performance.now();
  const events = await collect(new Agent({ model: toolThenDone("fetch"), tools: [tool] }).stream({ ...input, signal: controller.signal }));
  expect(performance.now() - startedAt).toBeLessThan(1000);
  expect(executions).toBe(1);
  expect(events.at(-1)).toMatchObject({ type: "agent.stopped", stopReason: "cancelled" });
});

test("treats an AbortError as cancellation rather than a retryable failure", async () => {
  let executions = 0;
  const tool = defineTool({
    name: "fetch",
    description: "fetch",
    input: z.object({}),
    annotations: { readOnly: true, idempotent: true },
    retry: { maxAttempts: 3 },
    execute: () => {
      executions += 1;
      throw new DOMException("aborted", "AbortError");
    },
  });
  await collect(new Agent({ model: toolThenDone("fetch"), tools: [tool] }).stream(input));
  expect(executions).toBe(1);
});

test("records attempts in the trace", async () => {
  let executions = 0;
  const tool = defineTool({
    name: "fetch",
    description: "fetch",
    input: z.object({}),
    annotations: { readOnly: true, idempotent: true },
    retry: { maxAttempts: 2 },
    execute: () => {
      executions += 1;
      if (executions === 1) throw new Error("temporary");
      return "ok";
    },
  });
  const collector = new AgentTraceCollector();
  for await (const event of new Agent({ model: toolThenDone("fetch"), tools: [tool] }).stream(input)) {
    collector.record(event);
  }
  const trace = collector.finish()!;
  expect(trace.turns[0]?.tools[0]).toMatchObject({ name: "fetch", status: "completed", attempts: 2 });
});

test("rejects invalid retry policies", () => {
  const base = { name: "fetch", description: "fetch", input: z.object({}), execute: () => "ok" };
  expect(() => defineTool({ ...base, retry: { maxAttempts: 0 } })).toThrow("maxAttempts");
  expect(() => defineTool({ ...base, retry: { maxAttempts: 2, delayMs: -1 } })).toThrow("delayMs");
});
