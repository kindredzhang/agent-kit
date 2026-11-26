import { expect, test } from "bun:test";
import { Agent } from "./agent";
import type { AgentEvent, AgentRunState } from "./agent";
import { InMemorySessionStore } from "./session";
import type { SessionStore } from "./session";
import { defineTool } from "./tools";
import { z } from "zod";
import type { LanguageModel, ModelRequest, ModelStreamEvent } from "./types";

function createModel(events: readonly ModelStreamEvent[]): LanguageModel {
  return {
    provider: "openai-chat-completions",
    async *stream(_request: ModelRequest) {
      yield* events;
    },
  };
}

function createModelSequence(responses: readonly (readonly ModelStreamEvent[])[]): LanguageModel {
  let responseIndex = 0;
  return {
    provider: "openai-chat-completions",
    async *stream(_request: ModelRequest) {
      yield* responses[responseIndex++] ?? [];
    },
  };
}

test("marks a final assistant response as completed and includes usage", async () => {
  const agent = new Agent({
    model: createModel([
      { type: "text.delta", delta: "Hello." },
      { type: "usage", usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } },
      { type: "finish", finishReason: "stop" },
    ]),
  });
  const events: AgentEvent[] = [];

  for await (const event of agent.stream({ messages: [{ role: "user", content: "Hi." }] })) {
    events.push(event);
  }

  expect(events.at(-1)).toMatchObject({
    type: "agent.completed",
    stopReason: "completed",
    usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
  });
});

test("stops at the turn limit without executing the final tool call", async () => {
  const agent = new Agent({
    model: createModel([
      {
        type: "tool.call.completed",
        toolCall: { id: "call_1", name: "mutate", input: {} },
      },
      { type: "usage", usage: { inputTokens: 4, outputTokens: 3, totalTokens: 7 } },
      { type: "finish", finishReason: "tool_calls" },
    ]),
    maxTurns: 1,
  });
  const events: AgentEvent[] = [];

  for await (const event of agent.stream({ messages: [{ role: "user", content: "Run the action." }] })) {
    events.push(event);
  }

  expect(events.at(-1)).toMatchObject({
    type: "agent.stopped",
    stopReason: "max_turns",
    usage: { inputTokens: 4, outputTokens: 3, totalTokens: 7 },
  });
  expect(events.some((event) => event.type === "tool.execution.started")).toBe(false);
});

test("stops instead of completing when the model output is truncated", async () => {
  const agent = new Agent({
    model: createModel([
      { type: "text.delta", delta: "Partial answer" },
      { type: "usage", usage: { inputTokens: 6, outputTokens: 8, totalTokens: 14 } },
      { type: "finish", finishReason: "length" },
    ]),
  });
  const events: AgentEvent[] = [];

  for await (const event of agent.stream({ messages: [{ role: "user", content: "Explain this." }] })) {
    events.push(event);
  }

  expect(events.at(-1)).toMatchObject({
    type: "agent.stopped",
    stopReason: "length",
    finishReason: "length",
    message: { content: "Partial answer" },
    usage: { inputTokens: 6, outputTokens: 8, totalTokens: 14 },
  });
});

test("reports model cancellation as a stop and retains usage already received", async () => {
  const controller = new AbortController();
  const model: LanguageModel = {
    provider: "openai-chat-completions",
    async *stream(_request: ModelRequest) {
      yield { type: "usage", usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 } };
      controller.abort();
      throw new DOMException("The operation was aborted.", "AbortError");
    },
  };
  const agent = new Agent({ model });
  const events: AgentEvent[] = [];

  for await (const event of agent.stream({
    messages: [{ role: "user", content: "Cancel this run." }],
    signal: controller.signal,
  })) {
    events.push(event);
  }

  expect(events.at(-1)).toMatchObject({
    type: "agent.stopped",
    stopReason: "cancelled",
    usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
  });
});

test("does not start an approved tool after its run is cancelled", async () => {
  const controller = new AbortController();
  let executions = 0;
  const tool = defineTool({
    name: "update_record",
    description: "Update a record.",
    input: z.object({}),
    execute: () => {
      executions += 1;
      return { updated: true };
    },
  });
  const agent = new Agent({
    model: createModel([
      {
        type: "tool.call.completed",
        toolCall: { id: "call_1", name: "update_record", input: {} },
      },
      { type: "finish", finishReason: "tool_calls" },
    ]),
    tools: [tool],
    approveTool: async () => {
      controller.abort();
      return true;
    },
  });
  const events: AgentEvent[] = [];

  for await (const event of agent.stream({
    messages: [{ role: "user", content: "Update the record." }],
    signal: controller.signal,
  })) {
    events.push(event);
  }

  expect(events.at(-1)).toMatchObject({ type: "agent.stopped", stopReason: "cancelled" });
  expect(executions).toBe(0);
});

test("does not invoke the approval handler after cancellation", async () => {
  const controller = new AbortController();
  let approvals = 0;
  let executions = 0;
  const tool = defineTool({
    name: "update_record",
    description: "Update a record.",
    input: z.object({}),
    execute: () => {
      executions += 1;
      return { updated: true };
    },
  });
  const agent = new Agent({
    model: createModel([
      {
        type: "tool.call.completed",
        toolCall: { id: "call_1", name: "update_record", input: {} },
      },
      { type: "finish", finishReason: "tool_calls" },
    ]),
    tools: [tool],
    approveTool: async () => {
      approvals += 1;
      return true;
    },
  });
  const events: AgentEvent[] = [];

  for await (const event of agent.stream({
    messages: [{ role: "user", content: "Update the record." }],
    signal: controller.signal,
  })) {
    events.push(event);
    if (event.type === "tool.approval.requested") controller.abort();
  }

  expect(approvals).toBe(0);
  expect(executions).toBe(0);
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "tool.approval.resolved",
      decision: "rejected",
      reason: "cancelled",
    }),
  );
  expect(events.at(-1)).toMatchObject({ type: "agent.stopped", stopReason: "cancelled" });
});

test("reports cancellation while waiting for tool approval", async () => {
  const controller = new AbortController();
  const tool = defineTool({
    name: "update_record",
    description: "Update a record.",
    input: z.object({}),
    execute: () => ({ updated: true }),
  });
  const agent = new Agent({
    model: createModel([
      {
        type: "tool.call.completed",
        toolCall: { id: "call_1", name: "update_record", input: {} },
      },
      { type: "finish", finishReason: "tool_calls" },
    ]),
    tools: [tool],
    approveTool: async () => {
      controller.abort();
      throw new DOMException("The operation was aborted.", "AbortError");
    },
  });
  const events: AgentEvent[] = [];

  for await (const event of agent.stream({
    messages: [{ role: "user", content: "Update the record." }],
    signal: controller.signal,
  })) {
    events.push(event);
  }

  expect(events).toContainEqual(
    expect.objectContaining({
      type: "tool.approval.resolved",
      decision: "rejected",
      reason: "cancelled",
    }),
  );
  expect(events.some((event) => event.type === "tool.approval.resolved" && event.reason === "handler_failed")).toBe(false);
  expect(events.at(-1)).toMatchObject({ type: "agent.stopped", stopReason: "cancelled" });
});

test("aggregates usage across model turns before completing", async () => {
  const lookup = defineTool({
    name: "lookup",
    description: "Look up a record.",
    input: z.object({}),
    annotations: { readOnly: true },
    execute: () => ({ found: true }),
  });
  const agent = new Agent({
    model: createModelSequence([
      [
        {
          type: "tool.call.completed",
          toolCall: { id: "call_1", name: "lookup", input: {} },
        },
        { type: "usage", usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } },
        { type: "finish", finishReason: "tool_calls" },
      ],
      [
        { type: "text.delta", delta: "Found it." },
        { type: "usage", usage: { inputTokens: 7, outputTokens: 11, totalTokens: 18 } },
        { type: "finish", finishReason: "stop" },
      ],
    ]),
    tools: [lookup],
  });
  const events: AgentEvent[] = [];

  for await (const event of agent.stream({ messages: [{ role: "user", content: "Look it up." }] })) {
    events.push(event);
  }

  expect(events.at(-1)).toMatchObject({
    type: "agent.completed",
    usage: { inputTokens: 10, outputTokens: 13, totalTokens: 23 },
  });
});

test("keeps a model refusal as a completed run with a refusal reason", async () => {
  const agent = new Agent({
    model: createModel([
      { type: "refusal.delta", delta: "I cannot help with that request." },
      { type: "usage", usage: { inputTokens: 5, outputTokens: 6, totalTokens: 11 } },
      { type: "finish", finishReason: "refusal" },
    ]),
  });
  const events: AgentEvent[] = [];

  for await (const event of agent.stream({ messages: [{ role: "user", content: "Do this." }] })) {
    events.push(event);
  }

  expect(events.at(-1)).toMatchObject({
    type: "agent.completed",
    stopReason: "refusal",
    finishReason: "refusal",
    usage: { inputTokens: 5, outputTokens: 6, totalTokens: 11 },
  });
});

test("does not execute tool calls when the model refuses", async () => {
  let executions = 0;
  const lookup = defineTool({
    name: "lookup",
    description: "Look up a record.",
    input: z.object({}),
    annotations: { readOnly: true },
    execute: () => {
      executions += 1;
      return { found: true };
    },
  });
  const agent = new Agent({
    model: createModel([
      {
        type: "tool.call.completed",
        toolCall: { id: "call_1", name: "lookup", input: {} },
      },
      { type: "finish", finishReason: "refusal" },
    ]),
    tools: [lookup],
  });
  const events: AgentEvent[] = [];

  for await (const event of agent.stream({ messages: [{ role: "user", content: "Look it up." }] })) {
    events.push(event);
  }

  expect(events.at(-1)).toMatchObject({ type: "agent.completed", stopReason: "refusal" });
  expect(executions).toBe(0);
});

test("reports model errors as failures with usage received before the error", async () => {
  const model: LanguageModel = {
    provider: "openai-chat-completions",
    async *stream(_request: ModelRequest) {
      yield { type: "usage", usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 } };
      throw new Error("Provider unavailable.");
    },
  };
  const agent = new Agent({ model });
  const events: AgentEvent[] = [];

  for await (const event of agent.stream({ messages: [{ role: "user", content: "Try this." }] })) {
    events.push(event);
  }

  const terminal = events.at(-1);
  expect(terminal?.type).toBe("agent.failed");
  if (terminal?.type === "agent.failed") {
    expect(terminal.stopReason).toBe("error");
    expect(terminal.error.message).toBe("Provider unavailable.");
    expect(terminal.usage).toEqual({ inputTokens: 8, outputTokens: 2, totalTokens: 10 });
  }
});

test("keeps tool execution errors recoverable by the model", async () => {
  let receivedToolError = false;
  const tool = defineTool({
    name: "lookup",
    description: "Look up a record.",
    input: z.object({}),
    annotations: { readOnly: true },
    execute: () => {
      throw new Error("Database unavailable.");
    },
  });
  const model: LanguageModel = {
    provider: "openai-chat-completions",
    async *stream(request: ModelRequest) {
      if (request.messages.some((message) => message.role === "tool" && message.isError)) {
        receivedToolError = true;
        yield { type: "text.delta", delta: "I could not look up the record." };
        yield { type: "finish", finishReason: "stop" };
        return;
      }

      yield {
        type: "tool.call.completed",
        toolCall: { id: "call_1", name: "lookup", input: {} },
      };
      yield { type: "finish", finishReason: "tool_calls" };
    },
  };
  const agent = new Agent({ model, tools: [tool] });
  const events: AgentEvent[] = [];

  for await (const event of agent.stream({ messages: [{ role: "user", content: "Look it up." }] })) {
    events.push(event);
  }

  expect(events.some((event) => event.type === "tool.execution.failed")).toBe(true);
  expect(receivedToolError).toBe(true);
  expect(events.at(-1)).toMatchObject({ type: "agent.completed", stopReason: "completed" });
});

test("continues a conversation from messages persisted in a session", async () => {
  const requests: ModelRequest[] = [];
  let responseIndex = 0;
  const model: LanguageModel = {
    provider: "openai-chat-completions",
    async *stream(request: ModelRequest) {
      requests.push({ ...request, messages: [...request.messages] });
      yield { type: "text.delta", delta: responseIndex++ === 0 ? "Hello." : "Welcome back." };
      yield { type: "finish", finishReason: "stop" };
    },
  };
  const sessionStore = new InMemorySessionStore();
  const firstAgent = new Agent({ model, instructions: "Keep this instruction.", sessionStore });
  const secondAgent = new Agent({ model, instructions: "Keep this instruction.", sessionStore });

  const firstEvents: AgentEvent[] = [];
  const secondEvents: AgentEvent[] = [];
  for await (const event of firstAgent.stream({
    sessionId: "conversation-1",
    messages: [{ role: "user", content: "Hello." }],
  })) {
    firstEvents.push(event);
  }
  for await (const event of secondAgent.stream({
    sessionId: "conversation-1",
    messages: [{ role: "user", content: "What did I say?" }],
  })) {
    secondEvents.push(event);
  }

  expect(firstEvents.at(-1)).toMatchObject({ type: "agent.completed" });
  expect(secondEvents.at(-1)).toMatchObject({ type: "agent.completed" });
  expect(requests[1]?.messages).toEqual([
    { role: "system", content: "Keep this instruction." },
    { role: "user", content: "Hello." },
    expect.objectContaining({ role: "assistant", content: "Hello." }),
    { role: "user", content: "What did I say?" },
  ]);
  expect(await sessionStore.load("conversation-1")).toEqual([
    { role: "user", content: "Hello." },
    expect.objectContaining({ role: "assistant", content: "Hello." }),
    { role: "user", content: "What did I say?" },
    expect.objectContaining({ role: "assistant", content: "Welcome back." }),
  ]);
});

test("persists the complete tool interaction for a completed session run", async () => {
  const sessionStore = new InMemorySessionStore();
  let responseIndex = 0;
  const model: LanguageModel = {
    provider: "openai-chat-completions",
    async *stream(_request: ModelRequest) {
      if (responseIndex++ === 0) {
        yield { type: "tool.call.completed", toolCall: { id: "call_1", name: "lookup", input: { id: "a" } } };
        yield { type: "tool.call.completed", toolCall: { id: "call_2", name: "lookup", input: { id: "b" } } };
        yield { type: "finish", finishReason: "tool_calls" };
        return;
      }

      yield { type: "text.delta", delta: "Both records were found." };
      yield { type: "finish", finishReason: "stop" };
    },
  };
  const lookup = defineTool({
    name: "lookup",
    description: "Look up a record.",
    input: z.object({ id: z.string() }),
    annotations: { readOnly: true },
    execute: ({ id }) => ({ found: id }),
  });
  const agent = new Agent({ model, tools: [lookup], sessionStore });
  const events: AgentEvent[] = [];

  for await (const event of agent.stream({
    sessionId: "conversation-1",
    messages: [{ role: "user", content: "Look up both records." }],
  })) {
    events.push(event);
  }

  expect(events.at(-1)).toMatchObject({ type: "agent.completed", stopReason: "completed" });
  expect(await sessionStore.load("conversation-1")).toMatchObject([
    { role: "user", content: "Look up both records." },
    {
      role: "assistant",
      toolCalls: [
        { id: "call_1", name: "lookup", input: { id: "a" } },
        { id: "call_2", name: "lookup", input: { id: "b" } },
      ],
    },
    { role: "tool", toolCallId: "call_1", content: { found: "a" } },
    { role: "tool", toolCallId: "call_2", content: { found: "b" } },
    { role: "assistant", content: "Both records were found." },
  ]);
});

test("does not persist stopped or failed session runs", async () => {
  const sessionStore = new InMemorySessionStore();
  const stoppedModel = createModel([
    { type: "tool.call.completed", toolCall: { id: "call_1", name: "lookup", input: {} } },
    { type: "finish", finishReason: "tool_calls" },
  ]);
  const failedModel: LanguageModel = {
    provider: "openai-chat-completions",
    async *stream(_request: ModelRequest) {
      throw new Error("Provider unavailable.");
    },
  };
  const cancelledController = new AbortController();
  const cancelledModel: LanguageModel = {
    provider: "openai-chat-completions",
    async *stream(_request: ModelRequest) {
      cancelledController.abort();
      yield { type: "finish", finishReason: "stop" };
    },
  };
  const runs = [
    {
      sessionId: "stopped",
      agent: new Agent({ model: stoppedModel, sessionStore, maxTurns: 1 }),
      input: { messages: [{ role: "user" as const, content: "Stop before tool execution." }] },
      stopReason: "max_turns",
    },
    {
      sessionId: "failed",
      agent: new Agent({ model: failedModel, sessionStore }),
      input: { messages: [{ role: "user" as const, content: "Fail before completion." }] },
      stopReason: "error",
    },
    {
      sessionId: "cancelled",
      agent: new Agent({ model: cancelledModel, sessionStore }),
      input: { messages: [{ role: "user" as const, content: "Cancel before completion." }], signal: cancelledController.signal },
      stopReason: "cancelled",
    },
  ] as const;

  for (const run of runs) {
    const events: AgentEvent[] = [];
    for await (const event of run.agent.stream({ ...run.input, sessionId: run.sessionId })) {
      events.push(event);
    }

    expect(events.at(-1)).toMatchObject({ stopReason: run.stopReason });
    expect(await sessionStore.load(run.sessionId)).toEqual([]);
  }
});

test("requires a session store when a session id is provided", async () => {
  let modelRequests = 0;
  const model: LanguageModel = {
    provider: "openai-chat-completions",
    async *stream(_request: ModelRequest) {
      modelRequests += 1;
      yield { type: "finish", finishReason: "stop" };
    },
  };
  const agent = new Agent({ model });
  const events: AgentEvent[] = [];

  for await (const event of agent.stream({
    sessionId: "conversation-1",
    messages: [{ role: "user", content: "Continue." }],
  })) {
    events.push(event);
  }

  expect(events.at(-1)).toMatchObject({ type: "agent.failed", error: { message: "A sessionStore must be configured when sessionId is provided." } });
  expect(modelRequests).toBe(0);
});

test("reports session store read and write errors as run failures", async () => {
  for (const failedOperation of ["load", "append"] as const) {
    const expectedMessage = `Session ${failedOperation} failed.`;
    const sessionStore: SessionStore = {
      async load() {
        if (failedOperation === "load") throw new Error(expectedMessage);
        return [];
      },
      async append() {
        if (failedOperation === "append") throw new Error(expectedMessage);
      },
      async clear() {},
    };
    const agent = new Agent({
      model: createModel([{ type: "finish", finishReason: "stop" }]),
      sessionStore,
    });
    const events: AgentEvent[] = [];

    for await (const event of agent.stream({
      sessionId: "conversation-1",
      messages: [{ role: "user", content: "Continue." }],
    })) {
      events.push(event);
    }

    expect(events.at(-1)).toMatchObject({
      type: "agent.failed",
      stopReason: "error",
      error: { message: expectedMessage },
    });
  }
});

test("pauses for approval and resumes the same serialized run state", async () => {
  let responseIndex = 0;
  let executions = 0;
  const model: LanguageModel = {
    provider: "openai-chat-completions",
    async *stream(_request: ModelRequest) {
      if (responseIndex++ === 0) {
        yield { type: "tool.call.completed", toolCall: { id: "call_1", name: "update_record", input: { id: "record-1" } } };
        yield { type: "usage", usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 } };
        yield { type: "finish", finishReason: "tool_calls" };
        return;
      }

      yield { type: "text.delta", delta: "The record is updated." };
      yield { type: "usage", usage: { inputTokens: 5, outputTokens: 4, totalTokens: 9 } };
      yield { type: "finish", finishReason: "stop" };
    },
  };
  const updateRecord = defineTool({
    name: "update_record",
    description: "Update a record.",
    input: z.object({ id: z.string() }),
    execute: ({ id }) => {
      executions += 1;
      return { updated: id };
    },
  });
  const sessionStore = new InMemorySessionStore();
  const agent = new Agent({
    model,
    instructions: "Update records only with approval.",
    tools: [updateRecord],
    sessionStore,
    approvalMode: "pause",
  });
  const pausedEvents: AgentEvent[] = [];

  for await (const event of agent.stream({
    sessionId: "conversation-1",
    messages: [{ role: "user", content: "Update record-1." }],
  })) {
    pausedEvents.push(event);
  }

  const paused = pausedEvents.at(-1);
  expect(paused?.type).toBe("agent.paused");
  expect(await sessionStore.load("conversation-1")).toEqual([]);
  if (paused?.type !== "agent.paused") throw new Error("Expected an approval pause.");
  const runId = paused.runId;
  const state = JSON.parse(JSON.stringify(paused.runState)) as AgentRunState;
  expect(state.pendingApproval?.toolCallId).toBe("call_1");

  const resumedEvents: AgentEvent[] = [];
  for await (const event of agent.resume({
    state,
    approval: { toolCallId: "call_1", decision: "approved" },
  })) {
    resumedEvents.push(event);
  }

  expect(resumedEvents[0]).toMatchObject({ type: "agent.resumed", runId });
  expect(resumedEvents).toContainEqual(
    expect.objectContaining({ type: "tool.approval.resolved", toolCallId: "call_1", decision: "approved" }),
  );
  expect(resumedEvents.at(-1)).toMatchObject({
    type: "agent.completed",
    runId,
    usage: { inputTokens: 9, outputTokens: 6, totalTokens: 15 },
  });
  expect(executions).toBe(1);
  expect(responseIndex).toBe(2);
  expect(await sessionStore.load("conversation-1")).toMatchObject([
    { role: "user", content: "Update record-1." },
    { role: "assistant", toolCalls: [{ id: "call_1", name: "update_record" }] },
    { role: "tool", toolCallId: "call_1", content: { updated: "record-1" } },
    { role: "assistant", content: "The record is updated." },
  ]);
});

test("rejects a paused run when its Session history has changed", async () => {
  const sessionStore = new InMemorySessionStore();
  await sessionStore.append("conversation-1", [{ role: "user", content: "Prior question." }]);
  let executions = 0;
  const model = createModel([
    { type: "tool.call.completed", toolCall: { id: "call_1", name: "update_record", input: {} } },
    { type: "finish", finishReason: "tool_calls" },
  ]);
  const updateRecord = defineTool({
    name: "update_record",
    description: "Update a record.",
    input: z.object({}),
    execute: () => {
      executions += 1;
      return { updated: true };
    },
  });
  const agent = new Agent({ model, tools: [updateRecord], sessionStore, approvalMode: "pause" });
  let pausedState: AgentRunState | undefined;

  for await (const event of agent.stream({
    sessionId: "conversation-1",
    messages: [{ role: "user", content: "Update the record." }],
  })) {
    if (event.type === "agent.paused") pausedState = event.runState;
  }
  expect(pausedState).toBeDefined();
  await sessionStore.append("conversation-1", [{ role: "user", content: "A separate run changed history." }]);

  const resumedEvents: AgentEvent[] = [];
  for await (const event of agent.resume({
    state: pausedState!,
    approval: { toolCallId: "call_1", decision: "approved" },
  })) {
    resumedEvents.push(event);
  }

  expect(resumedEvents.at(-1)).toMatchObject({
    type: "agent.failed",
    error: { message: "Session history changed while the Agent run was paused." },
  });
  expect(executions).toBe(0);
});

test("resumes a max-turn stop after increasing the turn budget", async () => {
  const model = createModelSequence([
    [
      { type: "tool.call.completed", toolCall: { id: "call_1", name: "update_record", input: {} } },
      { type: "finish", finishReason: "tool_calls" },
    ],
    [
      { type: "text.delta", delta: "The record is updated." },
      { type: "finish", finishReason: "stop" },
    ],
  ]);
  let executions = 0;
  const updateRecord = defineTool({
    name: "update_record",
    description: "Update a record.",
    input: z.object({}),
    execute: () => {
      executions += 1;
      return { updated: true };
    },
  });
  const initialAgent = new Agent({ model, tools: [updateRecord], maxTurns: 1, approvalMode: "pause" });
  const stoppedEvents: AgentEvent[] = [];
  for await (const event of initialAgent.stream({ messages: [{ role: "user", content: "Update the record." }] })) {
    stoppedEvents.push(event);
  }
  const stopped = stoppedEvents.at(-1);
  expect(stopped).toMatchObject({ type: "agent.stopped", stopReason: "max_turns" });
  if (stopped?.type !== "agent.stopped" || !stopped.runState) throw new Error("Expected a resumable turn limit stop.");

  const resumedAgent = new Agent({ model, tools: [updateRecord], maxTurns: 2, approvalMode: "pause" });
  const pausedEvents: AgentEvent[] = [];
  for await (const event of resumedAgent.resume({ state: stopped.runState })) {
    pausedEvents.push(event);
  }
  const paused = pausedEvents.at(-1);
  expect(paused?.type).toBe("agent.paused");
  if (paused?.type !== "agent.paused") throw new Error("Expected approval before execution.");

  const finalEvents: AgentEvent[] = [];
  for await (const event of resumedAgent.resume({
    state: paused.runState,
    approval: { toolCallId: "call_1", decision: "approved" },
  })) {
    finalEvents.push(event);
  }

  expect(finalEvents.at(-1)).toMatchObject({ type: "agent.completed", runId: stopped.runId });
  expect(executions).toBe(1);
});

test("collects approval decisions across pauses before executing a tool batch", async () => {
  const model = createModelSequence([
    [
      { type: "tool.call.completed", toolCall: { id: "call_1", name: "update_record", input: { id: "record-1" } } },
      { type: "tool.call.completed", toolCall: { id: "call_2", name: "update_record", input: { id: "record-2" } } },
      { type: "finish", finishReason: "tool_calls" },
    ],
    [
      { type: "text.delta", delta: "The first record is updated." },
      { type: "finish", finishReason: "stop" },
    ],
  ]);
  const executedIds: string[] = [];
  const updateRecord = defineTool({
    name: "update_record",
    description: "Update a record.",
    input: z.object({ id: z.string() }),
    execute: ({ id }) => {
      executedIds.push(id);
      return { updated: id };
    },
  });
  const agent = new Agent({ model, tools: [updateRecord], approvalMode: "pause" });
  const firstEvents: AgentEvent[] = [];
  for await (const event of agent.stream({ messages: [{ role: "user", content: "Update two records." }] })) {
    firstEvents.push(event);
  }
  const firstPause = firstEvents.at(-1);
  expect(firstPause?.type).toBe("agent.paused");
  if (firstPause?.type !== "agent.paused") throw new Error("Expected the first approval pause.");

  const secondEvents: AgentEvent[] = [];
  for await (const event of agent.resume({
    state: firstPause.runState,
    approval: { toolCallId: "call_1", decision: "approved" },
  })) {
    secondEvents.push(event);
  }
  const secondPause = secondEvents.at(-1);
  expect(secondPause?.type).toBe("agent.paused");
  expect(secondEvents).toContainEqual(
    expect.objectContaining({ type: "tool.approval.resolved", toolCallId: "call_1", decision: "approved" }),
  );
  if (secondPause?.type !== "agent.paused") throw new Error("Expected the second approval pause.");
  expect(secondPause.runState.approvalDecisions).toMatchObject([
    { toolCallId: "call_1", decision: "approved", resolved: true },
  ]);

  const finalEvents: AgentEvent[] = [];
  for await (const event of agent.resume({
    state: secondPause.runState,
    approval: { toolCallId: "call_2", decision: "rejected" },
  })) {
    finalEvents.push(event);
  }

  expect(finalEvents.some((event) => event.type === "tool.approval.resolved" && event.toolCallId === "call_1")).toBe(false);
  expect(finalEvents).toContainEqual(
    expect.objectContaining({ type: "tool.approval.resolved", toolCallId: "call_2", decision: "rejected" }),
  );
  expect(finalEvents.at(-1)).toMatchObject({ type: "agent.completed" });
  expect(executedIds).toEqual(["record-1"]);
});

test("does not persist run-local context compaction over session history", async () => {
  const sessionStore = new InMemorySessionStore();
  const storedHistory = [
    { role: "user" as const, content: "Old question." },
    { role: "assistant" as const, content: "Old answer." },
    { role: "user" as const, content: "Recent question." },
    { role: "assistant" as const, content: "Recent answer." },
  ];
  await sessionStore.append("conversation-1", storedHistory);

  let request: ModelRequest | undefined;
  const model: LanguageModel = {
    provider: "openai-chat-completions",
    async *stream(modelRequest: ModelRequest) {
      request = { ...modelRequest, messages: [...modelRequest.messages] };
      yield { type: "finish", finishReason: "stop" };
    },
  };
  const agent = new Agent({
    model,
    sessionStore,
    maxContextTokens: 3,
    estimateContextTokens: ({ messages }) => messages.length,
  });
  const events: AgentEvent[] = [];

  for await (const event of agent.stream({
    sessionId: "conversation-1",
    messages: [{ role: "user", content: "Current question." }],
  })) {
    events.push(event);
  }

  expect(request?.messages).toEqual([
    { role: "user", content: "Recent question." },
    { role: "assistant", content: "Recent answer." },
    { role: "user", content: "Current question." },
  ]);
  expect(events.some((event) => event.type === "agent.context.compacted")).toBe(true);
  const persistedMessages = await sessionStore.load("conversation-1");
  expect(persistedMessages.slice(0, 4)).toEqual(storedHistory);
  expect(persistedMessages.slice(4)).toMatchObject([
    { role: "user", content: "Current question." },
    { role: "assistant", content: "" },
  ]);
});

test("compacts the oldest input turns while preserving instructions and the latest request", async () => {
  let estimatorSawToolDefinition = false;
  let estimatorReceivedOutputLimit = false;
  const lookup = defineTool({
    name: "lookup",
    description: "Look up a record.",
    input: z.object({}),
    annotations: { readOnly: true },
    execute: () => ({ found: true }),
  });
  const inputMessages = [
    { role: "user" as const, content: "Old question." },
    { role: "assistant" as const, content: "Old answer." },
    { role: "user" as const, content: "Middle question." },
    { role: "assistant" as const, content: "Middle answer." },
    { role: "user" as const, content: "Recent old question." },
    { role: "assistant" as const, content: "Recent old answer." },
    { role: "user" as const, content: "Current question." },
  ];
  let request: ModelRequest | undefined;
  const model: LanguageModel = {
    provider: "openai-chat-completions",
    async *stream(modelRequest: ModelRequest) {
      request = { ...modelRequest, messages: [...modelRequest.messages] };
      yield { type: "finish", finishReason: "stop" };
    },
  };
  const agent = new Agent({
    model,
    instructions: "Keep this instruction.",
    tools: [lookup],
    maxOutputTokens: 24,
    maxContextTokens: 4,
    estimateContextTokens: (request) => {
      estimatorSawToolDefinition = request.tools?.some((tool) => tool.name === "lookup") ?? false;
      estimatorReceivedOutputLimit = "maxOutputTokens" in request;
      return request.messages.length;
    },
  });
  const events: AgentEvent[] = [];

  for await (const event of agent.stream({ messages: inputMessages })) {
    events.push(event);
  }

  expect(request?.messages).toEqual([
    { role: "system", content: "Keep this instruction." },
    { role: "user", content: "Recent old question." },
    { role: "assistant", content: "Recent old answer." },
    { role: "user", content: "Current question." },
  ]);
  expect(request?.tools?.map((tool) => tool.name)).toEqual(["lookup"]);
  expect(request?.maxOutputTokens).toBe(24);
  expect(estimatorSawToolDefinition).toBe(true);
  expect(estimatorReceivedOutputLimit).toBe(false);
  expect(events.findIndex((event) => event.type === "agent.context.compacted")).toBeLessThan(
    events.findIndex((event) => event.type === "turn.started"),
  );
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "agent.context.compacted",
      turn: 1,
      estimatedTokensBefore: 8,
      estimatedTokensAfter: 4,
      removedTurnCount: 2,
    }),
  );
  expect(inputMessages).toEqual([
    { role: "user", content: "Old question." },
    { role: "assistant", content: "Old answer." },
    { role: "user", content: "Middle question." },
    { role: "assistant", content: "Middle answer." },
    { role: "user", content: "Recent old question." },
    { role: "assistant", content: "Recent old answer." },
    { role: "user", content: "Current question." },
  ]);
});

test("compacts an older tool interaction as one unit between model turns", async () => {
  const requests: ModelRequest[] = [];
  let responseIndex = 0;
  const model: LanguageModel = {
    provider: "openai-chat-completions",
    async *stream(request: ModelRequest) {
      requests.push({ ...request, messages: [...request.messages] });
      if (responseIndex++ === 0) {
        yield {
          type: "tool.call.completed",
          toolCall: { id: "call_1", name: "lookup", input: {} },
        };
        yield {
          type: "tool.call.completed",
          toolCall: { id: "call_2", name: "lookup", input: {} },
        };
        yield { type: "finish", finishReason: "tool_calls" };
        return;
      }

      yield { type: "text.delta", delta: "Done." };
      yield { type: "finish", finishReason: "stop" };
    },
  };
  const lookup = defineTool({
    name: "lookup",
    description: "Look up a record.",
    input: z.object({}),
    annotations: { readOnly: true },
    execute: () => ({ found: true }),
  });
  const agent = new Agent({
    model,
    tools: [lookup],
    maxContextTokens: 2,
    estimateContextTokens: ({ messages }) => messages.length,
  });
  const events: AgentEvent[] = [];

  for await (const event of agent.stream({ messages: [{ role: "user", content: "Look it up." }] })) {
    events.push(event);
  }

  expect(requests).toHaveLength(2);
  expect(requests[1]?.messages).toEqual([{ role: "user", content: "Look it up." }]);
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "agent.context.compacted",
      turn: 2,
      estimatedTokensBefore: 4,
      estimatedTokensAfter: 1,
      removedTurnCount: 1,
    }),
  );
});

test("stops before the model when protected context exceeds its budget", async () => {
  let requests = 0;
  const inputMessages = [
    { role: "user" as const, content: "Old question." },
    { role: "assistant" as const, content: "Old answer." },
    { role: "user" as const, content: "Current question." },
  ];
  const model: LanguageModel = {
    provider: "openai-chat-completions",
    async *stream(_request: ModelRequest) {
      requests += 1;
      yield { type: "finish", finishReason: "stop" };
    },
  };
  const agent = new Agent({
    model,
    instructions: "Keep this instruction.",
    maxContextTokens: 1,
    estimateContextTokens: ({ messages }) => messages.length,
  });
  const events: AgentEvent[] = [];

  for await (const event of agent.stream({ messages: inputMessages })) {
    events.push(event);
  }

  expect(requests).toBe(0);
  expect(events.at(-1)).toMatchObject({
    type: "agent.stopped",
    stopReason: "context_limit",
    context: { estimatedTokens: 2, maxContextTokens: 1 },
  });
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "agent.context.compacted",
      estimatedTokensBefore: 4,
      estimatedTokensAfter: 2,
      removedTurnCount: 1,
    }),
  );
  expect(events.some((event) => event.type === "turn.started")).toBe(false);
  expect(inputMessages).toEqual([
    { role: "user", content: "Old question." },
    { role: "assistant", content: "Old answer." },
    { role: "user", content: "Current question." },
  ]);
});

test("leaves messages unchanged when no context budget is configured", async () => {
  let estimatorCalls = 0;
  let request: ModelRequest | undefined;
  const inputMessages = [
    { role: "user" as const, content: "Old question." },
    { role: "assistant" as const, content: "Old answer." },
    { role: "user" as const, content: "Current question." },
  ];
  const model: LanguageModel = {
    provider: "openai-chat-completions",
    async *stream(modelRequest: ModelRequest) {
      request = { ...modelRequest, messages: [...modelRequest.messages] };
      yield { type: "finish", finishReason: "stop" };
    },
  };
  const agent = new Agent({
    model,
    estimateContextTokens: () => {
      estimatorCalls += 1;
      return 0;
    },
  });
  const events: AgentEvent[] = [];

  for await (const event of agent.stream({ messages: inputMessages })) {
    events.push(event);
  }

  expect(request?.messages).toEqual(inputMessages);
  expect(estimatorCalls).toBe(0);
  expect(events.some((event) => event.type === "agent.context.compacted")).toBe(false);
});

test("uses the default estimator when a context budget is configured", async () => {
  let requests = 0;
  const model: LanguageModel = {
    provider: "openai-chat-completions",
    async *stream(_request: ModelRequest) {
      requests += 1;
      yield { type: "finish", finishReason: "stop" };
    },
  };
  const agent = new Agent({ model, maxContextTokens: 1 });
  const events: AgentEvent[] = [];

  for await (const event of agent.stream({ messages: [{ role: "user", content: "Current question." }] })) {
    events.push(event);
  }

  expect(requests).toBe(0);
  const terminal = events.at(-1);
  expect(terminal).toMatchObject({
    type: "agent.stopped",
    stopReason: "context_limit",
    context: { maxContextTokens: 1 },
  });
  if (terminal?.type === "agent.stopped") {
    expect(terminal.context?.estimatedTokens).toBeGreaterThan(1);
  }
});

test("requires a positive integer context budget", () => {
  expect(() => new Agent({ model: createModel([]), maxContextTokens: 0 })).toThrow(RangeError);
  expect(() => new Agent({ model: createModel([]), maxContextTokens: 1.5 })).toThrow(RangeError);
});
