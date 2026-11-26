import { expect, test } from "bun:test";
import { z } from "zod";
import { Agent } from "../core/agent.js";
import type { AgentEvent } from "../core/agent.js";
import { defineTool } from "../core/tools.js";
import type { AnyAgentTool } from "../core/tools.js";
import type { JsonObject, LanguageModel, ModelRequest, ModelStreamEvent, TokenUsage } from "../core/types.js";
import { createSubagentTool } from "./subagent.js";

function model(handler: (request: ModelRequest) => ModelStreamEvent[]): LanguageModel {
  return {
    provider: "openai-chat-completions",
    async *stream(request: ModelRequest): AsyncGenerator<ModelStreamEvent> {
      yield* handler(request);
    },
  };
}

function toolCall(id: string, name: string, input: JsonObject): ModelStreamEvent[] {
  return [
    { type: "tool.call.completed", toolCall: { id, name, input } },
    { type: "finish", finishReason: "tool_calls" },
  ];
}

function text(content: string, usage?: TokenUsage): ModelStreamEvent[] {
  const events: ModelStreamEvent[] = [{ type: "text.delta", delta: content }];
  if (usage) events.push({ type: "usage", usage });
  events.push({ type: "finish", finishReason: "stop" });
  return events;
}

function hasToolResult(request: ModelRequest): boolean {
  return request.messages.some(({ role }) => role === "tool");
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const collected: AgentEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

function lastExecution(events: readonly AgentEvent[]) {
  const event = events.findLast(
    (entry) => entry.type === "tool.execution.completed" || entry.type === "tool.execution.failed",
  );
  if (!event) throw new Error("Expected a tool execution event.");
  return event;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("Timed out waiting for condition.");
    await Bun.sleep(5);
  }
}

const taskInput = z.object({});

test("returns the subagent summary to the parent model", async () => {
  const subagent = createSubagentTool({
    name: "delegate",
    description: "Run a subagent on a task.",
    createAgent: () =>
      new Agent({
        model: model((request) => {
          expect(request.messages.at(-1)).toMatchObject({
            role: "user",
            content: "Summarize the release notes.",
          });
          return text("Release adds pause/resume.", { inputTokens: 4, outputTokens: 3, totalTokens: 7 });
        }),
      }),
  });
  const parent = new Agent({
    model: model((request) =>
      hasToolResult(request)
        ? text("The subagent said: Release adds pause/resume.")
        : toolCall("call_1", "delegate", { task: "Summarize the release notes." }),
    ),
    tools: [subagent],
  });

  const events = await collect(parent.stream({ messages: [{ role: "user", content: "What changed?" }] }));

  expect(lastExecution(events)).toMatchObject({
    type: "tool.execution.completed",
    name: "delegate",
    result: "Release adds pause/resume.",
  });
  expect(events.at(-1)).toMatchObject({
    type: "agent.completed",
    message: { content: "The subagent said: Release adds pause/resume." },
  });
});

test("runs without approval alongside other read-only tools", async () => {
  let delegations = 0;
  const subagent = createSubagentTool({
    name: "delegate",
    description: "Run a subagent on a task.",
    createAgent: () => {
      delegations += 1;
      return new Agent({ model: model(() => text("ok")) });
    },
  });
  const lookup = defineTool({
    name: "lookup",
    description: "Look something up.",
    input: taskInput,
    annotations: { readOnly: true },
    execute: async () => "record",
  });
  const parent = new Agent({
    model: model((request) =>
      hasToolResult(request)
        ? text("Both done.")
        : [
            { type: "tool.call.completed", toolCall: { id: "call_1", name: "lookup", input: {} } },
            { type: "tool.call.completed", toolCall: { id: "call_2", name: "delegate", input: { task: "Check." } } },
            { type: "finish", finishReason: "tool_calls" },
          ],
    ),
    tools: [lookup, subagent],
  });

  const events = await collect(parent.stream({ messages: [{ role: "user", content: "Go." }] }));

  expect(events.some((event) => event.type === "tool.approval.requested")).toBe(false);
  expect(delegations).toBe(1);
  expect(events.at(-1)).toMatchObject({ type: "agent.completed" });
});

test("reports a stopped subagent run as a tool error while the parent still completes", async () => {
  const subagent = createSubagentTool({
    name: "delegate",
    description: "Run a subagent on a task.",
    createAgent: () =>
      new Agent({
        model: model(() => [
          { type: "text.delta", delta: "partial" },
          { type: "finish", finishReason: "length" },
        ]),
      }),
  });
  const parent = new Agent({
    model: model((request) =>
      hasToolResult(request) ? text("Retried without the subagent.") : toolCall("call_1", "delegate", { task: "Do it." }),
    ),
    tools: [subagent],
  });

  const events = await collect(parent.stream({ messages: [{ role: "user", content: "Go." }] }));
  const failure = lastExecution(events);

  if (failure.type !== "tool.execution.failed") throw new Error("Expected a failed execution.");
  expect(failure.error.message).toBe("Subagent run ended with length: partial");
  expect(events.at(-1)).toMatchObject({
    type: "agent.completed",
    message: { content: "Retried without the subagent." },
  });
});

test("surfaces the underlying error of a failed subagent run", async () => {
  const subagent = createSubagentTool({
    name: "delegate",
    description: "Run a subagent on a task.",
    createAgent: () =>
      new Agent({
        model: {
          provider: "openai-chat-completions",
          async *stream(): AsyncGenerator<ModelStreamEvent> {
            throw new Error("provider exploded");
          },
        },
      }),
  });
  const parent = new Agent({
    model: model((request) => (hasToolResult(request) ? text("Handled.") : toolCall("call_1", "delegate", { task: "Do it." }))),
    tools: [subagent],
  });

  const events = await collect(parent.stream({ messages: [{ role: "user", content: "Go." }] }));
  const failure = lastExecution(events);

  if (failure.type !== "tool.execution.failed") throw new Error("Expected a failed execution.");
  expect(failure.error.message).toBe("Subagent run ended with error: provider exploded");
  expect(events.at(-1)).toMatchObject({ type: "agent.completed" });
});

test("refuses to create an agent beyond the depth limit", async () => {
  const depths: number[] = [];
  const rejectedResults: unknown[] = [];
  const delegate: AnyAgentTool = createSubagentTool({
    name: "delegate",
    description: "Run a subagent on a task.",
    maxDepth: 2,
    createAgent: (depth) => {
      depths.push(depth);
      return new Agent({
        model: model((request) => {
          for (const message of request.messages) {
            if (message.role === "tool" && message.isError) rejectedResults.push(message.content);
          }
          return request.messages.some(({ role }) => role === "tool")
            ? text("depth reached")
            : toolCall(`call_${depth}`, "delegate", { task: "deeper" });
        }),
        tools: [delegate],
      });
    },
  });
  const parent = new Agent({
    model: model((request) => (hasToolResult(request) ? text("Done.") : toolCall("call_0", "delegate", { task: "start" }))),
    tools: [delegate],
  });

  const events = await collect(parent.stream({ messages: [{ role: "user", content: "Go." }] }));

  expect(depths).toEqual([1, 2]);
  expect(rejectedResults).toEqual([
    { name: "Error", error: "Subagent depth limit reached (maxDepth: 2)." },
  ]);
  expect(lastExecution(events)).toMatchObject({ type: "tool.execution.completed", result: "depth reached" });
  expect(events.at(-1)).toMatchObject({ type: "agent.completed", message: { content: "Done." } });
});

test("waits for a free slot when concurrency is exhausted", async () => {
  let active = 0;
  let peak = 0;
  const releases: (() => void)[] = [];
  const awaitRelease = defineTool({
    name: "await_release",
    description: "Wait until released.",
    input: taskInput,
    annotations: { readOnly: true },
    execute: async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      return "released";
    },
  });
  const subagent = createSubagentTool({
    name: "delegate",
    description: "Run a subagent on a task.",
    maxConcurrency: 1,
    createAgent: () =>
      new Agent({
        model: model((request) =>
          hasToolResult(request) ? text("released summary") : toolCall("inner", "await_release", {}),
        ),
        tools: [awaitRelease],
      }),
  });
  const parent = new Agent({
    model: model((request) =>
      request.messages.filter(({ role }) => role === "tool").length === 2
        ? text("Both finished.")
        : [
            { type: "tool.call.completed", toolCall: { id: "call_1", name: "delegate", input: { task: "A" } } },
            { type: "tool.call.completed", toolCall: { id: "call_2", name: "delegate", input: { task: "B" } } },
            { type: "finish", finishReason: "tool_calls" },
          ],
    ),
    tools: [subagent],
  });

  const run = collect(parent.stream({ messages: [{ role: "user", content: "Go." }] }));
  await waitFor(() => releases.length === 1);

  expect(peak).toBe(1);
  releases.shift()?.();
  await waitFor(() => releases.length === 1);
  expect(peak).toBe(1);
  releases.shift()?.();

  const events = await run;
  expect(events.at(-1)).toMatchObject({ type: "agent.completed", message: { content: "Both finished." } });
});

test("stops the subagent when the parent signal aborts", async () => {
  const controller = new AbortController();
  let subagentRequests = 0;
  const subagent = createSubagentTool({
    name: "delegate",
    description: "Run a subagent on a task.",
    createAgent: () =>
      new Agent({
        model: {
          provider: "openai-chat-completions",
          async *stream(request: ModelRequest): AsyncGenerator<ModelStreamEvent> {
            subagentRequests += 1;
            controller.abort();
            expect(request.signal?.aborted).toBe(true);
            throw new DOMException("The operation was aborted.", "AbortError");
          },
        },
      }),
  });
  const parent = new Agent({
    model: model((request) => (hasToolResult(request) ? text("never") : toolCall("call_1", "delegate", { task: "Hang." }))),
    tools: [subagent],
  });

  const events = await collect(
    parent.stream({ messages: [{ role: "user", content: "Go." }], signal: controller.signal }),
  );

  expect(subagentRequests).toBe(1);
  expect(events).toContainEqual(
    expect.objectContaining({ type: "tool.execution.failed", name: "delegate", error: expect.objectContaining({ name: "AbortError" }) }),
  );
  expect(events.at(-1)).toMatchObject({ type: "agent.stopped", stopReason: "cancelled" });
  expect(events.some((event) => event.type === "agent.completed")).toBe(false);
});

test("reports subagent usage to the host", async () => {
  const reported: TokenUsage[] = [];
  const subagent = createSubagentTool({
    name: "delegate",
    description: "Run a subagent on a task.",
    createAgent: () => new Agent({ model: model(() => text("done", { inputTokens: 5, outputTokens: 2, totalTokens: 7 })) }),
    onUsage: (usage) => reported.push(usage),
  });
  const parent = new Agent({
    model: model((request) => (hasToolResult(request) ? text("Fine.") : toolCall("call_1", "delegate", { task: "Work." }))),
    tools: [subagent],
  });

  await collect(parent.stream({ messages: [{ role: "user", content: "Go." }] }));

  expect(reported).toEqual([{ inputTokens: 5, outputTokens: 2, totalTokens: 7 }]);
});

test("rejects invalid limits at construction", () => {
  const createAgent = () => new Agent({ model: model(() => text("x")) });

  expect(() => createSubagentTool({ name: "a", description: "d", createAgent, maxDepth: 0 })).toThrow(
    "maxDepth must be a positive integer.",
  );
  expect(() => createSubagentTool({ name: "b", description: "d", createAgent, maxConcurrency: 1.5 })).toThrow(
    "maxConcurrency must be a positive integer.",
  );
});
