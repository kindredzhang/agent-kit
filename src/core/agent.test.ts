import { expect, test } from "bun:test";
import { Agent } from "./agent";
import type { AgentEvent } from "./agent";
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
