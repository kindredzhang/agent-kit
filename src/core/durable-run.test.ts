import { expect, test } from "bun:test";
import { z } from "zod";
import { Agent, InMemoryRunStore, InMemorySessionStore, defineTool } from "../index.js";
import type {
  AgentEvent,
  AgentResumeInput,
  AgentRunState,
  AgentRunStore,
  LanguageModel,
  ModelStreamEvent,
} from "../index.js";

async function collect(stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function toolCallingModel(): LanguageModel {
  return {
    provider: "openai-chat-completions",
    async *stream({ messages }): AsyncGenerator<ModelStreamEvent> {
      if (messages.some((message) => message.role === "tool")) {
        yield { type: "text.delta", delta: "done" };
        yield { type: "finish", finishReason: "stop" };
        return;
      }
      yield { type: "tool.call.completed", toolCall: { id: "call_1", name: "read", input: {} } };
      yield { type: "finish", finishReason: "tool_calls" };
    },
  };
}

const read = defineTool({
  name: "read",
  description: "read",
  input: z.object({}),
  annotations: { readOnly: true },
  execute: () => "ok",
});

async function consumeUntil(stream: AsyncIterable<AgentEvent>, predicate: (event: AgentEvent) => boolean) {
  const events: AgentEvent[] = [];
  for await (const event of stream) {
    events.push(event);
    if (predicate(event)) break;
  }
  return events;
}

test("writes a model-turn checkpoint before each request and a tool-batch checkpoint before execution", async () => {
  const store = new InMemoryRunStore();
  const agent = new Agent({ model: toolCallingModel(), tools: [read], runStore: store });
  const events = await collect(agent.stream({ messages: [{ role: "user", content: "go" }] }));

  expect(events.filter((event) => event.type === "agent.checkpointed")).toEqual([
    { type: "agent.checkpointed", runId: events[0]!.runId, turn: 1, resumeAt: "model_turn" },
    { type: "agent.checkpointed", runId: events[0]!.runId, turn: 1, resumeAt: "tool_batch" },
    { type: "agent.checkpointed", runId: events[0]!.runId, turn: 2, resumeAt: "model_turn" },
  ]);
  expect(events.at(-1)).toMatchObject({ type: "agent.completed" });
});

test("removes the checkpoint when a run completes", async () => {
  const store = new InMemoryRunStore();
  const agent = new Agent({ model: toolCallingModel(), tools: [read], runStore: store });
  const events = await collect(agent.stream({ messages: [{ role: "user", content: "go" }] }));
  expect(await store.load(events[0]!.runId)).toBeUndefined();
});

test("keeps a checkpoint when the run pauses and resumes it by id", async () => {
  const store = new InMemoryRunStore();
  const model: LanguageModel = {
    provider: "openai-chat-completions",
    async *stream({ messages }): AsyncGenerator<ModelStreamEvent> {
      if (messages.some((message) => message.role === "tool")) {
        yield { type: "text.delta", delta: "done" };
        yield { type: "finish", finishReason: "stop" };
        return;
      }
      yield { type: "tool.call.completed", toolCall: { id: "call_1", name: "write", input: { value: 1 } } };
      yield { type: "finish", finishReason: "tool_calls" };
    },
  };
  const executions: number[] = [];
  const write = defineTool({
    name: "write",
    description: "write",
    input: z.object({ value: z.number() }),
    execute: ({ value }) => {
      executions.push(value);
      return "written";
    },
  });
  const agent = new Agent({ model, tools: [write], approvalMode: "pause", runStore: store });
  const events = await collect(agent.stream({ messages: [{ role: "user", content: "go" }] }));
  const paused = events.at(-1);
  if (paused?.type !== "agent.paused") throw new Error("expected a pause");

  const saved = await store.load(paused.runId);
  expect(saved?.resumeAt).toBe("tool_batch");
  expect(saved?.pendingApproval).toEqual({ toolCallId: "call_1", approvalId: expect.any(String) });

  const resumed = await collect(agent.resume({
    runId: paused.runId,
    approval: { toolCallId: "call_1", decision: "approved" },
  }));
  expect(resumed[0]).toMatchObject({ type: "agent.resumed", runId: paused.runId });
  expect(resumed.at(-1)).toMatchObject({ type: "agent.completed" });
  expect(executions).toEqual([1]);
  expect(await store.load(paused.runId)).toBeUndefined();
});

test("resumes from a model-turn checkpoint without replaying finished tools", async () => {
  const store = new InMemoryRunStore();
  let executions = 0;
  const counted = defineTool({
    name: "read",
    description: "read",
    input: z.object({}),
    annotations: { readOnly: true },
    execute: () => {
      executions += 1;
      return "ok";
    },
  });
  const agent = new Agent({ model: toolCallingModel(), tools: [counted], runStore: store });
  const stream = agent.stream({ messages: [{ role: "user", content: "go" }] });
  const events = await consumeUntil(
    stream,
    (event) => event.type === "agent.checkpointed" && event.resumeAt === "model_turn" && event.turn === 2,
  );
  const runId = events[0]!.runId;
  expect(executions).toBe(1);

  const saved = await store.load(runId);
  expect(saved?.resumeAt).toBe("model_turn");
  expect(saved?.turn).toBe(2);
  expect(saved?.pendingToolCalls).toEqual([]);

  const resumed = await collect(new Agent({ model: toolCallingModel(), tools: [counted], runStore: store })
    .resume({ runId }));
  expect(resumed.at(-1)).toMatchObject({ type: "agent.completed", runId });
  expect(executions).toBe(1);
});

test("replays a tool batch from its checkpoint and keeps tool call ids stable", async () => {
  const store = new InMemoryRunStore();
  const seenKeys: string[] = [];
  const record = defineTool({
    name: "record",
    description: "record",
    input: z.object({ slot: z.string() }),
    requiresApproval: false,
    execute: ({ slot }, context) => {
      seenKeys.push(`${slot}:${context.toolCallId}`);
      return "recorded";
    },
  });
  const model: LanguageModel = {
    provider: "openai-chat-completions",
    async *stream({ messages }): AsyncGenerator<ModelStreamEvent> {
      if (messages.some((message) => message.role === "tool")) {
        yield { type: "text.delta", delta: "done" };
        yield { type: "finish", finishReason: "stop" };
        return;
      }
      yield { type: "tool.call.completed", toolCall: { id: "call_a", name: "record", input: { slot: "a" } } };
      yield { type: "tool.call.completed", toolCall: { id: "call_b", name: "record", input: { slot: "b" } } };
      yield { type: "finish", finishReason: "tool_calls" };
    },
  };
  const agent = new Agent({ model, tools: [record], runStore: store });
  const events = await consumeUntil(
    agent.stream({ messages: [{ role: "user", content: "go" }] }),
    (event) => event.type === "tool.execution.completed",
  );
  const runId = events[0]!.runId;
  expect(seenKeys).toEqual(["a:call_a"]);

  const saved = await store.load(runId);
  expect(saved?.resumeAt).toBe("tool_batch");
  expect(saved?.pendingToolCalls.map((toolCall) => toolCall.id)).toEqual(["call_a", "call_b"]);

  const resumed = await collect(new Agent({ model, tools: [record], runStore: store }).resume({ runId }));
  expect(resumed.at(-1)).toMatchObject({ type: "agent.completed" });
  expect(seenKeys).toEqual(["a:call_a", "a:call_a", "b:call_b"]);
});

test("keeps the checkpoint when a max-turn stop carries a run state", async () => {
  const store = new InMemoryRunStore();
  const agent = new Agent({ model: toolCallingModel(), tools: [read], maxTurns: 1, runStore: store });
  const events = await collect(agent.stream({ messages: [{ role: "user", content: "go" }] }));
  const stopped = events.at(-1);
  if (stopped?.type !== "agent.stopped" || !stopped.runState) throw new Error("expected a resumable stop");

  const saved = await store.load(stopped.runId);
  expect(saved?.resumeAt).toBe("tool_batch");
  expect(saved?.turn).toBe(1);

  const resumed = await collect(new Agent({ model: toolCallingModel(), tools: [read], maxTurns: 2, runStore: store })
    .resume({ runId: stopped.runId }));
  expect(resumed.at(-1)).toMatchObject({ type: "agent.completed", runId: stopped.runId });
});

test("removes the checkpoint on a terminal stop that cannot be resumed", async () => {
  const store = new InMemoryRunStore();
  const agent = new Agent({ model: toolCallingModel(), tools: [read], runStore: store });
  const controller = new AbortController();
  const events = await collect(agent.stream({
    messages: [{ role: "user", content: "go" }],
    signal: controller.signal,
  }));
  expect(events.at(-1)).toMatchObject({ type: "agent.completed" });
  expect(await store.load(events[0]!.runId)).toBeUndefined();

  const cancelledStore = new InMemoryRunStore();
  const cancelledController = new AbortController();
  cancelledController.abort();
  const cancelled = await collect(new Agent({ model: toolCallingModel(), tools: [read], runStore: cancelledStore })
    .stream({ messages: [{ role: "user", content: "go" }], signal: cancelledController.signal }));
  expect(cancelled.at(-1)).toMatchObject({ type: "agent.stopped", stopReason: "cancelled" });
  expect(await cancelledStore.load(cancelled[0]!.runId)).toBeUndefined();
});

test("fails the run when a checkpoint cannot be saved", async () => {
  const store: AgentRunStore = {
    save: () => Promise.reject(new Error("disk full")),
    load: () => Promise.resolve(undefined),
    delete: () => Promise.resolve(),
  };
  const events = await collect(new Agent({ model: toolCallingModel(), tools: [read], runStore: store })
    .stream({ messages: [{ role: "user", content: "go" }] }));
  expect(events.at(-1)).toMatchObject({ type: "agent.failed", error: { message: "disk full" } });
});

test("surfaces a checkpoint cleanup failure instead of a terminal event", async () => {
  const store: AgentRunStore = {
    save: () => Promise.resolve(),
    load: () => Promise.resolve(undefined),
    delete: () => Promise.reject(new Error("store unavailable")),
  };
  const events: AgentEvent[] = [];
  await expect((async () => {
    for await (const event of new Agent({ model: toolCallingModel(), tools: [read], runStore: store })
      .stream({ messages: [{ role: "user", content: "go" }] })) {
      events.push(event);
    }
  })()).rejects.toThrow("store unavailable");
  expect(events.some((event) => event.type === "agent.completed")).toBe(false);
});

test("does not emit checkpoints when no run store is configured", async () => {
  const events = await collect(new Agent({ model: toolCallingModel(), tools: [read] })
    .stream({ messages: [{ role: "user", content: "go" }] }));
  expect(events.some((event) => event.type === "agent.checkpointed")).toBe(false);
});

test("rejects invalid resume inputs and unknown checkpoints", async () => {
  const store = new InMemoryRunStore();
  const agent = new Agent({ model: toolCallingModel(), tools: [read], runStore: store });

  const both = await collect(agent.resume({
    state: {} as AgentRunState,
    runId: "run-1",
  } as AgentResumeInput));
  expect(both.at(-1)).toMatchObject({ type: "agent.failed" });

  const neither = await collect(agent.resume({} as AgentResumeInput));
  expect(neither.at(-1)).toMatchObject({ type: "agent.failed" });

  const unknown = await collect(agent.resume({ runId: "missing" }));
  expect(unknown.at(-1)).toMatchObject({
    type: "agent.failed",
    error: { message: "No checkpoint is stored for run \"missing\"." },
  });

  const withoutStore = await collect(new Agent({ model: toolCallingModel(), tools: [read] })
    .resume({ runId: "missing" }));
  expect(withoutStore.at(-1)).toMatchObject({ type: "agent.failed", error: { message: expect.stringContaining("runStore") } });
});

test("rejects a checkpoint that belongs to a different run", async () => {
  const store: AgentRunStore = {
    save: () => Promise.resolve(),
    load: () => Promise.resolve({ ...({} as AgentRunState), runId: "other" }),
    delete: () => Promise.resolve(),
  };
  const events = await collect(new Agent({ model: toolCallingModel(), tools: [read], runStore: store })
    .resume({ runId: "requested" }));
  expect(events.at(-1)).toMatchObject({ type: "agent.failed", error: { message: expect.stringContaining("does not belong") } });
});

test("treats a model-turn checkpoint's unrecorded usage as unknown under a token budget", async () => {
  const store = new InMemoryRunStore();
  const model: LanguageModel = {
    provider: "openai-chat-completions",
    async *stream({ messages }): AsyncGenerator<ModelStreamEvent> {
      yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
      if (messages.some((message) => message.role === "tool")) {
        yield { type: "text.delta", delta: "done" };
        yield { type: "finish", finishReason: "stop" };
        return;
      }
      yield { type: "tool.call.completed", toolCall: { id: "call_1", name: "read", input: {} } };
      yield { type: "finish", finishReason: "tool_calls" };
    },
  };
  const agent = new Agent({ model, tools: [read], runStore: store });
  const events = await consumeUntil(
    agent.stream({ messages: [{ role: "user", content: "go" }], budget: { maxTotalTokens: 1000 } }),
    (event) => event.type === "agent.checkpointed" && event.resumeAt === "model_turn" && event.turn === 2,
  );
  const runId = events[0]!.runId;

  const saved = await store.load(runId);
  expect(saved?.budget?.tokenUsageComplete).toBe(true);

  const resumed = await collect(new Agent({ model, tools: [read], runStore: store }).resume({ runId }));
  expect(resumed.at(-1)).toMatchObject({
    type: "agent.stopped",
    stopReason: "usage_unavailable",
    budget: { tokenUsageComplete: false },
  });
});

test("refuses to resume when the session history changed", async () => {
  const store = new InMemoryRunStore();
  const sessionStore = new InMemorySessionStore();
  const agent = new Agent({ model: toolCallingModel(), tools: [read], runStore: store, sessionStore });
  const events = await consumeUntil(
    agent.stream({ messages: [{ role: "user", content: "go" }], sessionId: "conversation-1" }),
    (event) => event.type === "agent.checkpointed" && event.resumeAt === "model_turn" && event.turn === 2,
  );
  const runId = events[0]!.runId;

  await sessionStore.append("conversation-1", [{ role: "user", content: "intruder" }]);

  const resumed = await collect(new Agent({ model: toolCallingModel(), tools: [read], runStore: store, sessionStore })
    .resume({ runId }));
  expect(resumed.at(-1)).toMatchObject({ type: "agent.failed", error: { message: expect.stringContaining("Session history changed") } });
});
