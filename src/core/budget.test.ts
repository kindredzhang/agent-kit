import { expect, test } from "bun:test";
import { Agent, AgentTraceCollector, createSubagentTool, defineTool } from "../index.js";
import type { AgentEvent, LanguageModel, ModelRequest, ModelStreamEvent } from "../index.js";
import { z } from "zod";

async function collect(stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

const input = { messages: [{ role: "user" as const, content: "start" }] };

test("counts parent and parallel child model calls against one shared limit", async () => {
  let children = 0;
  const childModel: LanguageModel = {
    provider: "openai-chat-completions",
    async *stream(): AsyncGenerator<ModelStreamEvent> {
      children++;
      yield { type: "usage", usage: { totalTokens: 3 } };
      yield { type: "finish", finishReason: "stop" };
    },
  };
  const tool = createSubagentTool({ name: "delegate", description: "delegate", createAgent: () => new Agent({ model: childModel }) });
  const parentModel: LanguageModel = {
    provider: "openai-chat-completions",
    async *stream(request: ModelRequest): AsyncGenerator<ModelStreamEvent> {
      if (request.messages.some((message) => message.role === "tool")) throw new Error("unexpected request");
      yield { type: "usage", usage: { totalTokens: 5 } };
      for (const id of ["a", "b"]) yield { type: "tool.call.completed", toolCall: { id, name: "delegate", input: { task: id } } };
      yield { type: "finish", finishReason: "tool_calls" };
    },
  };
  const agent = new Agent({ model: parentModel, tools: [tool] });
  const events = await collect(agent.stream({ ...input, budget: { maxModelCalls: 2 } }));
  expect(children).toBe(1);
  expect(events.at(-1)).toMatchObject({ type: "agent.stopped", stopReason: "budget_exceeded", budget: { modelCalls: 2, usage: { totalTokens: 8 } } });
  const trace = new AgentTraceCollector();
  for (const event of events) trace.record(event);
  expect(trace.finish()).toMatchObject({ stopReason: "budget_exceeded", budget: { modelCalls: 2 } });
});

test("restores the shared budget across approval pauses and accepts old snapshots", async () => {
  let requests = 0;
  const model: LanguageModel = {
    provider: "openai-chat-completions",
    async *stream(request): AsyncGenerator<ModelStreamEvent> {
      requests++;
      if (request.messages.some((message) => message.role === "tool")) {
        yield { type: "finish", finishReason: "stop" };
      } else {
        yield { type: "tool.call.completed", toolCall: { id: "a", name: "write", input: {} } };
        yield { type: "finish", finishReason: "tool_calls" };
      }
    },
  };
  const tool = defineTool({ name: "write", description: "write", input: z.object({}), execute: () => "ok" });
  const agent = new Agent({ model, tools: [tool], approvalMode: "pause" });
  const events = await collect(agent.stream({ ...input, budget: { maxModelCalls: 1 } }));
  const pause = events.find((event) => event.type === "agent.paused");
  if (!pause || pause.type !== "agent.paused") throw new Error("expected pause");
  expect(pause.runState.budget).toMatchObject({ maxModelCalls: 1, modelCalls: 1 });
  const resumed = await collect(agent.resume({ state: pause.runState, approval: { toolCallId: "a", decision: "approved" } }));
  expect(resumed.at(-1)).toMatchObject({ type: "agent.stopped", stopReason: "budget_exceeded" });
  expect(requests).toBe(1);
  const oldState = structuredClone(pause.runState);
  delete oldState.budget;
  const legacy = await collect(agent.resume({ state: oldState, approval: { toolCallId: "a", decision: "approved" } }));
  expect(legacy.at(-1)).toMatchObject({ type: "agent.completed" });
});

test("independent runs using the same agent have independent limits", async () => {
  const model: LanguageModel = { provider: "openai-chat-completions", async *stream() { yield { type: "finish" as const, finishReason: "stop" as const }; } };
  const agent = new Agent({ model });
  const runs = await Promise.all([collect(agent.stream({ ...input, budget: { maxModelCalls: 1 } })), collect(agent.stream({ ...input, budget: { maxModelCalls: 1 } }))]);
  expect(runs.map((events) => events.at(-1)?.type)).toEqual(["agent.completed", "agent.completed"]);
});
