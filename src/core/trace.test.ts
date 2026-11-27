import { expect, test } from "bun:test";
import { z } from "zod";
import { Agent, AgentTraceCollector, defineTool, evaluateToolTrajectory } from "../index.js";
import type { AgentEvent, AgentTraceOptions, LanguageModel, ModelStreamEvent } from "../index.js";

async function collect(events: AsyncIterable<AgentEvent>, options?: AgentTraceOptions) {
  const collector = new AgentTraceCollector(options);
  for await (const event of events) collector.record(event);
  const trace = collector.finish();
  if (!trace) throw new Error("Expected an Agent trace.");
  return trace;
}

const lookup = defineTool({
  name: "lookup",
  description: "Look up a record.",
  input: z.object({ key: z.string() }),
  annotations: { readOnly: true },
  execute: ({ key }) => ({ found: key }),
});

const model: LanguageModel = {
  provider: "openai-chat-completions",
  async *stream({ messages }) {
    if (!messages.some(({ role }) => role === "tool")) {
      yield { type: "tool.call.completed", toolCall: { id: "call_1", name: "lookup", input: { key: "private-argument" } } };
      yield { type: "usage", usage: { inputTokens: 3 } };
      yield { type: "usage", usage: { outputTokens: 2 } };
      yield { type: "finish", finishReason: "tool_calls" };
      return;
    }
    yield { type: "text.delta", delta: "private-answer" };
    yield { type: "usage", usage: { inputTokens: 5, outputTokens: 1 } };
    yield { type: "finish", finishReason: "stop" };
  },
};

const input = { messages: [{ role: "user" as const, content: "private-prompt" }] };

test("builds timed run, turn, model and tool spans without content by default", async () => {
  const agent = new Agent({ model, tools: [lookup] });
  let time = 100;
  const trace = await collect(agent.stream(input), { now: () => time++, requestModel: "test-model" });

  expect(trace).toMatchObject({
    operation: "invoke_agent",
    provider: "openai-chat-completions",
    startedAt: 100,
    status: "completed",
    stopReason: "completed",
    usage: { inputTokens: 8, outputTokens: 3 },
    turns: [
      {
        operation: "step",
        turn: 1,
        model: {
          operation: "chat",
          requestModel: "test-model",
          finishReason: "tool_calls",
          usage: { inputTokens: 3, outputTokens: 2 },
        },
        tools: [{ operation: "execute_tool", toolCallId: "call_1", name: "lookup", status: "completed" }],
      },
      { turn: 2, model: { finishReason: "stop" }, tools: [] },
    ],
  });
  const [first, second] = trace.turns;
  expect(first!.model!.endedAt).toBeLessThan(first!.tools[0]!.startedAt);
  expect(first!.tools[0]!.endedAt).toBeLessThan(second!.startedAt);
  expect(trace.endedAt).toBeGreaterThan(second!.model!.endedAt);
  expect(JSON.stringify(trace)).not.toContain("private-");
});

test("records tool inputs and model and tool outputs only when their option is enabled", async () => {
  const agent = new Agent({ model, tools: [lookup] });
  const inputs = await collect(agent.stream(input), { recordInputs: true });
  expect(inputs.turns[0]?.tools[0]?.input).toEqual({ key: "private-argument" });
  expect(inputs.turns[0]?.tools[0]?.output).toBeUndefined();
  expect(inputs.turns[1]?.model?.output).toBeUndefined();

  const outputs = await collect(agent.stream(input), { recordOutputs: true });
  expect(outputs.turns[0]?.tools[0]?.input).toBeUndefined();
  expect(outputs.turns[0]?.tools[0]?.output).toEqual({ found: "private-argument" });
  expect(outputs.turns[1]?.model?.output).toBe("private-answer");
  expect(JSON.stringify(outputs)).not.toContain("private-prompt");
});

test("correlates approval pause and resume without adding a second model span to the resumed turn", async () => {
  const restrictedLookup = { ...lookup, requiresApproval: true };
  const agent = new Agent({ model, tools: [restrictedLookup], approvalMode: "pause" });
  const collector = new AgentTraceCollector();
  let pause: Extract<AgentEvent, { type: "agent.paused" }> | undefined;
  for await (const event of agent.stream(input)) {
    collector.record(event);
    if (event.type === "agent.paused") pause = event;
  }
  if (!pause) throw new Error("Expected an approval pause.");
  const initial = collector.finish()!;
  expect(initial).toMatchObject({ status: "paused", usage: { inputTokens: 3, outputTokens: 2 } });
  expect(initial.turns[0]?.tools).toEqual([]);
  const request = initial.turns[0]!.approvals[0]!;
  expect(request.requestedAt).toBeDefined();
  expect(request.decision).toBeUndefined();
  expect(JSON.stringify(initial)).not.toContain("private-");

  const resumed = await collect(agent.resume({
    state: pause.runState,
    approval: { toolCallId: "call_1", decision: "approved" },
  }));
  expect(resumed.runId).toBe(initial.runId);
  expect(resumed.id).not.toBe(initial.id);
  expect(resumed).toMatchObject({ resumed: true, status: "completed", usage: { inputTokens: 8, outputTokens: 3 } });
  expect(resumed.turns[0]?.model).toBeUndefined();
  expect(resumed.turns[0]?.approvals[0]).toMatchObject({ approvalId: request.approvalId, decision: "approved" });
  const expected = [{ turn: 1, name: "lookup" }];
  expect(evaluateToolTrajectory([initial, resumed], expected)).toEqual({ passed: true, actual: expected });
});

test("records context compaction before a budget stop without adding a model span", async () => {
  const agent = new Agent({
    model,
    instructions: "Keep this instruction.",
    maxContextTokens: 1,
    estimateContextTokens: ({ messages }) => messages.length,
  });
  const trace = await collect(agent.stream({
    messages: [
      { role: "user", content: "Old question." },
      { role: "assistant", content: "Old answer." },
      ...input.messages,
    ],
  }));
  expect(trace).toMatchObject({
    status: "stopped",
    stopReason: "context_limit",
    turns: [{
      turn: 1,
      compaction: { estimatedTokensBefore: 4, estimatedTokensAfter: 2, removedTurnCount: 1 },
      tools: [],
    }],
  });
  expect(trace.turns[0]?.model).toBeUndefined();
});

test("closes unfinished model spans on failure without exporting error details", async () => {
  const agent = new Agent({
    model: {
      provider: "openai-chat-completions",
      async *stream() {
        yield { type: "usage", usage: { inputTokens: 2 } };
        throw new Error("private-error");
      },
    },
  });
  let time = 0;
  const trace = await collect(agent.stream(input), { now: () => time++, recordOutputs: true });
  expect(trace).toMatchObject({ status: "failed", stopReason: "error", usage: { inputTokens: 2 } });
  expect(trace.turns[0]?.model?.finishReason).toBeUndefined();
  expect(trace.turns[0]?.model?.endedAt).toBe(trace.endedAt);
  expect(JSON.stringify(trace)).not.toContain("private-error");
});

test("evaluates tool start order even when parallel execution finishes out of order", async () => {
  const executions = Promise.withResolvers<void>();
  const slow = defineTool({
    name: "slow",
    description: "Read the first record.",
    input: z.object({}),
    annotations: { readOnly: true },
    execute: async () => {
      await executions.promise;
      return true;
    },
  });
  const agent = new Agent({
    tools: [slow, lookup],
    model: {
      provider: "openai-chat-completions",
      async *stream({ messages }): AsyncGenerator<ModelStreamEvent> {
        if (messages.some(({ role }) => role === "tool")) {
          yield { type: "finish", finishReason: "stop" };
          return;
        }
        yield { type: "tool.call.completed", toolCall: { id: "unknown", name: "unavailable", input: {} } };
        yield { type: "tool.call.completed", toolCall: { id: "slow", name: "slow", input: {} } };
        yield { type: "tool.call.completed", toolCall: { id: "fast", name: "lookup", input: { key: "record" } } };
        yield { type: "finish", finishReason: "tool_calls" };
      },
    },
  });
  const completionOrder: string[] = [];
  const collector = new AgentTraceCollector();
  for await (const event of agent.stream(input)) {
    collector.record(event);
    if (event.type === "tool.execution.completed") {
      completionOrder.push(event.name);
      executions.resolve();
    }
  }
  expect(completionOrder).toEqual(["lookup", "slow"]);
  const trace = collector.finish()!;
  const first = { turn: 1, name: "slow" };
  const second = { turn: 1, name: "lookup" };
  expect(evaluateToolTrajectory([trace], [first, second])).toEqual({ passed: true, actual: [first, second] });
  expect(evaluateToolTrajectory([trace], [second, first])).toMatchObject({
    passed: false, mismatch: { index: 0, expected: second, actual: first },
  });
  expect(evaluateToolTrajectory([trace], [first])).toMatchObject({
    passed: false, mismatch: { index: 1, actual: second },
  });
  expect(evaluateToolTrajectory([trace], [first, second, first])).toMatchObject({
    passed: false, mismatch: { index: 2, expected: first },
  });
});

test("marks a tool span interrupted when cancellation follows its start event", async () => {
  const controller = new AbortController();
  const agent = new Agent({ model, tools: [lookup] });
  const collector = new AgentTraceCollector();
  for await (const event of agent.stream({ ...input, signal: controller.signal })) {
    collector.record(event);
    if (event.type === "tool.execution.started") controller.abort();
  }

  const trace = collector.finish()!;
  expect(trace).toMatchObject({ status: "stopped", stopReason: "cancelled" });
  expect(trace.turns[0]?.tools[0]).toMatchObject({ status: "interrupted", endedAt: trace.endedAt });
});

test("finalizes an interrupted event consumer without inventing a run outcome", async () => {
  const collector = new AgentTraceCollector();
  const agent = new Agent({ model, tools: [lookup] });
  for await (const event of agent.stream(input)) {
    collector.record(event);
    if (event.type === "message.started") break;
  }
  const trace = collector.finish();
  expect(trace?.status).toBe("interrupted");
  expect(trace?.stopReason).toBeUndefined();
  expect(trace?.turns[0]?.model?.endedAt).toBe(trace?.endedAt);
});

test("records the error type on a failed run and its failed tool", async () => {
  const collector = new AgentTraceCollector();
  const agent = new Agent({
    model: {
      provider: "openai-chat-completions",
      async *stream({ messages }) {
        if (!messages.some(({ role }) => role === "tool")) {
          yield { type: "tool.call.completed", toolCall: { id: "call_1", name: "lookup", input: { key: "a" } } };
          yield { type: "finish", finishReason: "tool_calls" };
          return;
        }
        throw new RangeError("secret-detail");
      },
    },
    tools: [{ ...lookup, execute: () => { throw new TypeError("also-secret"); } }],
  });
  for await (const event of agent.stream(input)) collector.record(event);
  const trace = collector.finish()!;

  expect(trace.error).toEqual({ name: "RangeError" });
  expect(trace.turns[0]?.tools[0]?.error).toEqual({ name: "TypeError" });
  expect(JSON.stringify(trace)).not.toContain("secret");
});

test("records the session id on the run trace", async () => {
  const { InMemorySessionStore } = await import("../index.js");
  const agent = new Agent({ model, tools: [lookup], sessionStore: new InMemorySessionStore() });
  const trace = await collect(agent.stream({ ...input, sessionId: "session-42" }));

  expect(trace.sessionId).toBe("session-42");
});
