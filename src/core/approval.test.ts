import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Agent, AgentApprovalQueue, InMemoryApprovalStore, InMemoryRunStore, SQLiteApprovalStore, SQLiteRunStore, defineTool } from "../index.js";
import type { AgentApprovalRequest, AgentEvent, LanguageModel, ModelStreamEvent } from "../index.js";
import { z } from "zod";

function writeModel(): LanguageModel {
  return {
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
}

function scriptedModel(script: readonly ("tool_call" | "text")[]): LanguageModel {
  let round = 0;
  return {
    provider: "openai-chat-completions",
    async *stream(): AsyncGenerator<ModelStreamEvent> {
      const step = script[Math.min(round, script.length - 1)]!;
      round += 1;
      if (step === "tool_call") {
        yield { type: "tool.call.completed", toolCall: { id: "call_1", name: "write", input: { value: 1 } } };
        yield { type: "finish", finishReason: "tool_calls" };
        return;
      }
      yield { type: "text.delta", delta: "done" };
      yield { type: "finish", finishReason: "stop" };
    },
  };
}

function writeTool(executions: number[]) {
  return defineTool({
    name: "write",
    description: "Write a record.",
    input: z.object({ value: z.number() }),
    execute: ({ value }) => {
      executions.push(value);
      return "written";
    },
  });
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const collected: AgentEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

function record(runId: string, approvalId: string): AgentApprovalRequest {
  return {
    runId,
    turn: 1,
    toolCallId: "call_1",
    approvalId,
    tool: { name: "write", description: "Write a record." },
    input: { value: 1 },
    createdAt: 1_700_000_000_000,
  };
}

test("observes a paused run and records its approval request", async () => {
  const queue = new AgentApprovalQueue();
  const agent = new Agent({ model: writeModel(), tools: [writeTool([])], approvalMode: "pause" });

  const events = await collect(queue.observe(agent.stream({
    messages: [{ role: "user", content: "go" }],
  })));
  expect(events.at(-1)).toMatchObject({ type: "agent.paused" });

  const pending = await queue.list();
  expect(pending).toHaveLength(1);
  expect(pending[0]).toMatchObject({
    runId: events[0]!.runId,
    turn: 1,
    toolCallId: "call_1",
    tool: { name: "write", description: "Write a record." },
    input: { value: 1 },
  });
  expect(pending[0]?.approvalId).toBeString();
  expect(pending[0]?.decision).toBeUndefined();
});

test("resumes a paused run after a decision and clears the request", async () => {
  const runStore = new InMemoryRunStore();
  const queue = new AgentApprovalQueue();
  const executions: number[] = [];
  const agent = new Agent({
    model: writeModel(),
    tools: [writeTool(executions)],
    approvalMode: "pause",
    runStore,
  });

  await collect(queue.observe(agent.stream({ messages: [{ role: "user", content: "go" }] })));
  const [request] = await queue.list();
  if (!request) throw new Error("expected a pending approval request");

  expect(await queue.decisionFor(request.runId)).toBeUndefined();

  await queue.decide({ runId: request.runId, approvalId: request.approvalId, decision: "approved" });
  expect(await queue.decisionFor(request.runId)).toEqual({
    toolCallId: "call_1",
    approvalId: request.approvalId,
    decision: "approved",
  });

  const resumed = await collect(queue.resume(agent, request.runId));

  expect(resumed.at(-1)).toMatchObject({ type: "agent.completed" });
  expect(executions).toEqual([1]);
  expect(await queue.list()).toEqual([]);
});

test("keeps a rejected call from executing and still clears the request", async () => {
  const runStore = new InMemoryRunStore();
  const queue = new AgentApprovalQueue();
  const executions: number[] = [];
  const agent = new Agent({
    model: writeModel(),
    tools: [writeTool(executions)],
    approvalMode: "pause",
    runStore,
  });

  await collect(queue.observe(agent.stream({ messages: [{ role: "user", content: "go" }] })));
  const [request] = await queue.list();
  if (!request) throw new Error("expected a pending approval request");

  await queue.decide({ runId: request.runId, approvalId: request.approvalId, decision: "rejected" });
  const resumed = await collect(queue.observe(agent.resume({
    runId: request.runId,
    approval: { toolCallId: request.toolCallId, decision: "rejected" },
  })));

  expect(resumed).toContainEqual(expect.objectContaining({
    type: "tool.approval.resolved",
    decision: "rejected",
  }));
  expect(executions).toEqual([]);
  expect(resumed.at(-1)).toMatchObject({ type: "agent.completed" });
  expect(await queue.list()).toEqual([]);
});

test("stamps each request with when it was recorded", async () => {
  let clock = 1_700_000_000_000;
  const queue = new AgentApprovalQueue({ now: () => clock });
  const agent = new Agent({ model: writeModel(), tools: [writeTool([])], approvalMode: "pause" });

  await collect(queue.observe(agent.stream({ messages: [{ role: "user", content: "go" }] })));

  const [request] = await queue.list();
  expect(request?.createdAt).toBe(1_700_000_000_000);

  clock += 5_000;
  const [decided] = await queue.list();
  expect(decided?.createdAt).toBe(1_700_000_000_000);
});

test("keeps createdAt stable when a request is decided", async () => {
  const queue = new AgentApprovalQueue({ now: () => 1_700_000_000_000 });
  const agent = new Agent({ model: writeModel(), tools: [writeTool([])], approvalMode: "pause" });
  await collect(queue.observe(agent.stream({ messages: [{ role: "user", content: "go" }] })));

  const [request] = await queue.list();
  if (!request) throw new Error("expected a pending approval request");
  const decided = await queue.decide({
    runId: request.runId,
    approvalId: request.approvalId,
    decision: "approved",
  });

  expect(decided.createdAt).toBe(1_700_000_000_000);
});

test("pages through pending requests with a stable cursor", async () => {
  const store = new InMemoryApprovalStore();
  const queue = new AgentApprovalQueue({ store });
  for (const [index, runId] of ["run-1", "run-2", "run-3", "run-4", "run-5"].entries()) {
    await store.save(record(`run-${index + 1}`, `approval-${index + 1}`));
  }

  const first = await queue.listPage({ limit: 2 });
  expect(first.requests.map(({ runId }) => runId)).toEqual(["run-1", "run-2"]);
  expect(first.nextCursor).toBeDefined();

  const second = await queue.listPage({ limit: 2, cursor: first.nextCursor });
  expect(second.requests.map(({ runId }) => runId)).toEqual(["run-3", "run-4"]);
  expect(second.nextCursor).toBeDefined();

  const third = await queue.listPage({ limit: 2, cursor: second.nextCursor });
  expect(third.requests.map(({ runId }) => runId)).toEqual(["run-5"]);
  expect(third.nextCursor).toBeUndefined();
});

test("pages through requests recorded in the same millisecond", async () => {
  const store = new InMemoryApprovalStore();
  const queue = new AgentApprovalQueue({ store });
  for (const index of [1, 2, 3]) await store.save(record(`run-${index}`, `approval-${index}`));

  const seen: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await queue.listPage({ limit: 1, ...(cursor ? { cursor } : {}) });
    seen.push(...page.requests.map(({ runId }) => runId));
    cursor = page.nextCursor;
  } while (cursor);

  expect(seen).toEqual(["run-1", "run-2", "run-3"]);
});

test("applies pendingOnly before paging", async () => {
  const store = new InMemoryApprovalStore();
  const queue = new AgentApprovalQueue({ store });
  for (const index of [1, 2, 3]) await store.save(record(`run-${index}`, `approval-${index}`));
  await store.save({ ...record("run-2", "approval-2"), decision: "approved" });

  const pending = await queue.listPage({ limit: 2 });
  expect(pending.requests.map(({ runId }) => runId)).toEqual(["run-1", "run-3"]);

  const all = await queue.listPage({ limit: 2, pendingOnly: false });
  expect(all.requests.map(({ runId }) => runId)).toEqual(["run-1", "run-2"]);
});

test("rejects a cursor that is not one this queue produced", async () => {
  const queue = new AgentApprovalQueue();
  expect(queue.listPage({ limit: 1, cursor: "not-a-cursor" })).rejects.toThrow(TypeError);
});

test("rejects a page limit that is not a positive integer", async () => {
  const queue = new AgentApprovalQueue();
  expect(queue.listPage({ limit: 0 })).rejects.toThrow(RangeError);
  expect(queue.listPage({ limit: 1.5 })).rejects.toThrow(RangeError);
});

test("prunes decided requests older than a cutoff and keeps pending ones", async () => {
  const store = new InMemoryApprovalStore();
  const queue = new AgentApprovalQueue({ store });

  await store.save({ ...record("run-old-decided", "approval-1"), createdAt: 1_000, decision: "approved" });
  await store.save({ ...record("run-old-pending", "approval-2"), createdAt: 1_000 });
  await store.save({ ...record("run-new-decided", "approval-3"), createdAt: 9_000, decision: "rejected" });

  const removed = await queue.prune({ decidedBefore: 5_000 });
  expect(removed).toBe(1);
  expect((await queue.list({ pendingOnly: false })).map(({ runId }) => runId))
    .toEqual(["run-old-pending", "run-new-decided"]);
});

test("prunes nothing when every decided request is newer than the cutoff", async () => {
  const store = new InMemoryApprovalStore();
  const queue = new AgentApprovalQueue({ store });
  await store.save({ ...record("run-1", "approval-1"), createdAt: 9_000, decision: "approved" });

  expect(await queue.prune({ decidedBefore: 5_000 })).toBe(0);
  expect(await queue.list({ pendingOnly: false })).toHaveLength(1);
});

test("rejects a prune cutoff that is not a finite number", async () => {
  const queue = new AgentApprovalQueue();
  expect(queue.prune({ decidedBefore: Number.NaN })).rejects.toThrow(TypeError);
  expect(queue.prune({ decidedBefore: "soon" as unknown as number })).rejects.toThrow(TypeError);
});

test("lists decided requests only when asked", async () => {
  const queue = new AgentApprovalQueue();
  const agent = new Agent({ model: writeModel(), tools: [writeTool([])], approvalMode: "pause" });
  await collect(queue.observe(agent.stream({ messages: [{ role: "user", content: "go" }] })));
  const [request] = await queue.list();
  if (!request) throw new Error("expected a pending approval request");

  await queue.decide({ runId: request.runId, approvalId: request.approvalId, decision: "approved" });

  expect(await queue.list()).toEqual([]);
  expect(await queue.list({ pendingOnly: false })).toMatchObject([
    { toolCallId: "call_1", decision: "approved" },
  ]);
});

test("rejects unknown and repeated decisions", async () => {
  const queue = new AgentApprovalQueue();
  const agent = new Agent({ model: writeModel(), tools: [writeTool([])], approvalMode: "pause" });
  await collect(queue.observe(agent.stream({ messages: [{ role: "user", content: "go" }] })));
  const [request] = await queue.list();
  if (!request) throw new Error("expected a pending approval request");

  expect(queue.decide({ runId: "missing", approvalId: "approval-1", decision: "approved" }))
    .rejects.toThrow("No approval request");

  await queue.decide({ runId: request.runId, approvalId: request.approvalId, decision: "approved" });
  expect(queue.decide({ runId: request.runId, approvalId: request.approvalId, decision: "rejected" }))
    .rejects.toThrow("already decided");

  expect(queue.decide({
    runId: request.runId,
    approvalId: request.approvalId,
    decision: "maybe" as "approved",
  })).rejects.toThrow("decision");
});

test("keeps requests from different runs apart", async () => {
  const queue = new AgentApprovalQueue();
  const agent = new Agent({ model: writeModel(), tools: [writeTool([])], approvalMode: "pause" });

  await collect(queue.observe(agent.stream({ messages: [{ role: "user", content: "first" }] })));
  await collect(queue.observe(agent.stream({ messages: [{ role: "user", content: "second" }] })));

  const requests = await queue.list();
  expect(requests).toHaveLength(2);
  expect(new Set(requests.map((request) => request.runId)).size).toBe(2);

  await queue.decide({
    runId: requests[1]!.runId,
    approvalId: requests[1]!.approvalId,
    decision: "approved",
  });

  expect(await queue.decisionFor(requests[0]!.runId)).toBeUndefined();
  expect(await queue.decisionFor(requests[1]!.runId)).toEqual({
    toolCallId: "call_1",
    approvalId: requests[1]!.approvalId,
    decision: "approved",
  });
});

test("records a pause reported without a preceding approval request", async () => {
  const queue = new AgentApprovalQueue();
  const agent = new Agent({ model: writeModel(), tools: [writeTool([])], approvalMode: "pause" });
  const events = await collect(agent.stream({ messages: [{ role: "user", content: "go" }] }));
  const paused = events.at(-1);
  if (paused?.type !== "agent.paused") throw new Error("expected a pause");

  const recorded = await queue.record(paused);
  expect(recorded).toMatchObject({
    runId: paused.runId,
    toolCallId: "call_1",
    approvalId: paused.runState.pendingApproval?.approvalId,
    tool: { name: "write" },
    input: { value: 1 },
  });
  expect(await queue.record(paused)).toBeUndefined();
});

test("records a repeated tool call id in the same run as a new request", async () => {
  const runStore = new InMemoryRunStore();
  const queue = new AgentApprovalQueue();
  const agent = new Agent({
    model: scriptedModel(["tool_call", "tool_call"]),
    tools: [writeTool([])],
    approvalMode: "pause",
    runStore,
  });

  await collect(queue.observe(agent.stream({ messages: [{ role: "user", content: "first" }] })));
  const [first] = await queue.list();
  if (!first) throw new Error("expected a pending approval request");
  await queue.decide({ runId: first.runId, approvalId: first.approvalId, decision: "approved" });

  const resumed = await collect(queue.resume(agent, first.runId));
  expect(resumed.at(-1)).toMatchObject({ type: "agent.paused" });

  const second = await queue.list();
  expect(second).toHaveLength(1);
  expect(second[0]?.toolCallId).toBe("call_1");
  expect(second[0]?.approvalId).not.toBe(first.approvalId);
  expect(second[0]?.decision).toBeUndefined();
});

test("lets another process decide and resume the run", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-kit-approval-"));
  const databasePath = join(directory, "state.sqlite");
  const executions: number[] = [];

  try {
    const writer = new Database(databasePath);
    const reader = new Database(databasePath);
    try {
      const runStore = new SQLiteRunStore(writer);
      const agent = new Agent({
        model: writeModel(),
        tools: [writeTool(executions)],
        approvalMode: "pause",
        runStore,
      });
      const queue = new AgentApprovalQueue({ store: new SQLiteApprovalStore(writer) });

      await collect(queue.observe(agent.stream({ messages: [{ role: "user", content: "go" }] })));

      const approvingProcess = new AgentApprovalQueue({ store: new SQLiteApprovalStore(reader) });
      const [request] = await approvingProcess.list();
      if (!request) throw new Error("expected a pending approval request");
      await approvingProcess.decide({
        runId: request.runId,
        approvalId: request.approvalId,
        decision: "approved",
      });

      expect(await queue.decisionFor(request.runId)).toEqual({
        toolCallId: "call_1",
        approvalId: request.approvalId,
        decision: "approved",
      });

      const events = await collect(queue.resume(agent, request.runId));
      expect(events.at(-1)).toMatchObject({ type: "agent.completed" });
      expect(executions).toEqual([1]);
      expect(await approvingProcess.list()).toEqual([]);
    } finally {
      writer.close();
      reader.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
