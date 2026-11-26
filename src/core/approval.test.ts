import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Agent, AgentApprovalQueue, InMemoryRunStore, SQLiteApprovalStore, SQLiteRunStore, defineTool } from "../index.js";
import type { AgentEvent, LanguageModel, ModelStreamEvent } from "../index.js";
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
