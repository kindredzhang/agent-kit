import { expect, test } from "bun:test";
import { z } from "zod";
import { Agent, createSubagentTool, defineTool } from "../index.js";
import type { AgentEvent, LanguageModel, ModelStreamEvent } from "../index.js";

async function collect(stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

const input = { messages: [{ role: "user" as const, content: "classify" }] };
const answer = z.object({
  sentiment: z.enum(["positive", "negative"]),
  confidence: z.number().min(0).max(1),
});

function answerModel(inputs: unknown[]): LanguageModel {
  let call = 0;
  return {
    provider: "openai-chat-completions",
    async *stream(): AsyncGenerator<ModelStreamEvent> {
      const value = inputs[Math.min(call, inputs.length - 1)];
      call += 1;
      yield { type: "tool.call.completed", toolCall: { id: `answer-${call}`, name: "final_answer", input: value as never } };
      yield { type: "finish", finishReason: "tool_calls" };
    },
  };
}

test("completes with a schema-validated structured output", async () => {
  const events = await collect(new Agent({ model: answerModel([{ sentiment: "positive", confidence: 0.9 }]), outputSchema: answer }).stream(input));
  expect(events.find((event) => event.type === "tool.execution.completed")).toMatchObject({
    name: "final_answer",
    result: { sentiment: "positive", confidence: 0.9 },
  });
  expect(events.at(-1)).toMatchObject({
    type: "agent.completed",
    stopReason: "completed",
    structuredOutput: { sentiment: "positive", confidence: 0.9 },
  });
});

test("returns validation failures to the model and accepts a later correction", async () => {
  let calls = 0;
  const valid = { sentiment: "positive", confidence: 0.9 };
  const model: LanguageModel = {
    provider: "openai-chat-completions",
    async *stream({ messages }): AsyncGenerator<ModelStreamEvent> {
      calls += 1;
      if (calls === 1) {
        yield { type: "tool.call.completed", toolCall: { id: "bad", name: "final_answer", input: { sentiment: "neutral", confidence: 2 } } };
      } else {
        const failure = messages.findLast((message) => message.role === "tool");
        expect(failure).toMatchObject({ role: "tool", isError: true });
        expect(JSON.stringify(failure?.content)).toContain("sentiment");
        expect(JSON.stringify(failure?.content)).toContain("confidence");
        yield { type: "tool.call.completed", toolCall: { id: "good", name: "final_answer", input: valid } };
      }
      yield { type: "finish", finishReason: "tool_calls" };
    },
  };
  const events = await collect(new Agent({ model, outputSchema: answer }).stream(input));
  expect(calls).toBe(2);
  expect(events.filter((event) => event.type === "tool.execution.failed")).toHaveLength(1);
  expect(events.at(-1)).toMatchObject({ type: "agent.completed", structuredOutput: valid });
});

test("nudges the model when it answers without calling the output tool", async () => {
  let calls = 0;
  const model: LanguageModel = {
    provider: "openai-chat-completions",
    async *stream({ messages }): AsyncGenerator<ModelStreamEvent> {
      calls += 1;
      if (calls === 1) {
        expect(messages.some((message) => message.role === "developer")).toBe(false);
        yield { type: "text.delta", delta: "positive" };
        yield { type: "finish", finishReason: "stop" };
      } else {
        expect(messages.findLast((message) => message.role === "developer")?.content).toContain("final_answer");
        yield { type: "tool.call.completed", toolCall: { id: "good", name: "final_answer", input: { sentiment: "positive", confidence: 1 } } };
        yield { type: "finish", finishReason: "tool_calls" };
      }
    },
  };
  const events = await collect(new Agent({ model, outputSchema: answer }).stream(input));
  expect(calls).toBe(2);
  expect(events.at(-1)).toMatchObject({
    type: "agent.completed",
    structuredOutput: { sentiment: "positive", confidence: 1 },
  });
});

test("rejects a final answer tool call mixed with other tool calls", async () => {
  let calls = 0;
  const read = defineTool({ name: "read", description: "read", input: z.object({}), annotations: { readOnly: true }, execute: () => "ok" });
  const model: LanguageModel = {
    provider: "openai-chat-completions",
    async *stream(): AsyncGenerator<ModelStreamEvent> {
      calls += 1;
      if (calls === 1) {
        yield { type: "tool.call.completed", toolCall: { id: "a", name: "read", input: {} } };
        yield { type: "tool.call.completed", toolCall: { id: "b", name: "final_answer", input: { sentiment: "positive", confidence: 1 } } };
      } else {
        yield { type: "tool.call.completed", toolCall: { id: "c", name: "final_answer", input: { sentiment: "positive", confidence: 1 } } };
      }
      yield { type: "finish", finishReason: "tool_calls" };
    },
  };
  const events = await collect(new Agent({ model, tools: [read], outputSchema: answer }).stream(input));
  expect(calls).toBe(2);
  expect(events.find((event) => event.type === "tool.execution.failed")).toMatchObject({
    name: "final_answer",
    error: { message: expect.stringContaining("only tool call") },
  });
  expect(events.at(-1)).toMatchObject({ type: "agent.completed", structuredOutput: { sentiment: "positive", confidence: 1 } });
});

test("stops with max_turns when the model never calls the output tool", async () => {
  const model: LanguageModel = {
    provider: "openai-chat-completions",
    async *stream(): AsyncGenerator<ModelStreamEvent> {
      yield { type: "text.delta", delta: "plain text" };
      yield { type: "finish", finishReason: "stop" };
    },
  };
  const events = await collect(new Agent({ model, outputSchema: answer, maxTurns: 2 }).stream(input));
  expect(events.at(-1)).toMatchObject({ type: "agent.stopped", stopReason: "max_turns" });
});

test("rejects tool name collisions and mismatched resumes", async () => {
  const tool = defineTool({ name: "final_answer", description: "custom", input: z.object({}), execute: () => "ok" });
  expect(() => new Agent({ model: answerModel([{}]), tools: [tool], outputSchema: answer })).toThrow(
    "final_answer",
  );

  const first = new Agent({ model: answerModel([{ sentiment: "positive", confidence: 1 }]), outputSchema: answer, maxTurns: 1 });
  const stopped = (await collect(first.stream(input))).at(-1);
  if (stopped?.type !== "agent.stopped" || !stopped.runState) throw new Error("expected run state");
  const mismatched = await collect(new Agent({ model: answerModel([{}]) }).resume({ state: stopped.runState }));
  expect(mismatched.at(-1)).toMatchObject({ type: "agent.failed" });
});

test("preserves structured output config across max-turn recovery", async () => {
  const model: LanguageModel = {
    provider: "openai-chat-completions",
    async *stream(): AsyncGenerator<ModelStreamEvent> {
      yield { type: "tool.call.completed", toolCall: { id: "a", name: "final_answer", input: { sentiment: "positive", confidence: 1 } } };
      yield { type: "finish", finishReason: "tool_calls" };
    },
  };
  const stopped = (await collect(new Agent({ model, outputSchema: answer, maxTurns: 1 }).stream(input))).at(-1);
  if (stopped?.type !== "agent.stopped" || !stopped.runState) throw new Error("expected run state");
  const resumed = await collect(new Agent({ model, outputSchema: answer, maxTurns: 2 }).resume({ state: stopped.runState }));
  expect(resumed.at(-1)).toMatchObject({ type: "agent.completed", structuredOutput: { sentiment: "positive", confidence: 1 } });
});

test("a subagent returns its parent-visible structured output as a JSON string", async () => {
  const child = new Agent({
    model: {
      provider: "openai-chat-completions",
      async *stream(): AsyncGenerator<ModelStreamEvent> {
        yield { type: "tool.call.completed", toolCall: { id: "x", name: "final_answer", input: { sentiment: "negative", confidence: 0.5 } } };
        yield { type: "finish", finishReason: "tool_calls" };
      },
    },
    outputSchema: answer,
  });
  let parentCalls = 0;
  const parent = new Agent({
    model: {
      provider: "openai-chat-completions",
      async *stream({ messages }): AsyncGenerator<ModelStreamEvent> {
        parentCalls += 1;
        if (parentCalls === 1) {
          yield { type: "tool.call.completed", toolCall: { id: "d", name: "delegate", input: { task: "classify" } } };
        } else {
          expect(messages.findLast((message) => message.role === "tool")).toMatchObject({
            content: JSON.stringify({ sentiment: "negative", confidence: 0.5 }),
          });
        }
        yield { type: "finish", finishReason: parentCalls === 1 ? "tool_calls" : "stop" };
      },
    },
    tools: [createSubagentTool({ name: "delegate", description: "delegate", createAgent: () => child })],
  });
  const events = await collect(parent.stream(input));
  expect(events.at(-1)).toMatchObject({ type: "agent.completed" });
});

test("does not let an output call outrun a pending approval in the same turn", async () => {
  const write = defineTool({ name: "write", description: "write", input: z.object({}), execute: () => "done" });
  let calls = 0;
  const model: LanguageModel = {
    provider: "openai-chat-completions",
    async *stream(): AsyncGenerator<ModelStreamEvent> {
      calls += 1;
      if (calls === 1) {
        yield { type: "tool.call.completed", toolCall: { id: "w", name: "write", input: {} } };
        yield { type: "tool.call.completed", toolCall: { id: "f", name: "final_answer", input: { sentiment: "positive", confidence: 1 } } };
      } else {
        yield { type: "tool.call.completed", toolCall: { id: "g", name: "final_answer", input: { sentiment: "positive", confidence: 1 } } };
      }
      yield { type: "finish", finishReason: "tool_calls" };
    },
  };
  const events = await collect(new Agent({
    model,
    tools: [write],
    outputSchema: answer,
    approvalMode: "pause",
  }).stream(input));
  expect(events.some((event) => event.type === "agent.paused")).toBe(true);
});
