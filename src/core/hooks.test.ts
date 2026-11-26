import { expect, test } from "bun:test";
import { z } from "zod";
import { Agent, defineTool } from "../index";
import type { AgentEvent, LanguageModel, ModelStreamEvent } from "../index";

async function collect(stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

const input = { messages: [{ role: "user" as const, content: "original" }] };

test("beforeModel observes the prepared request without changing it or spending budget when rejected", async () => {
  let calls = 0;
  const model: LanguageModel = {
    provider: "openai-chat-completions",
    async *stream(request): AsyncGenerator<ModelStreamEvent> {
      calls++;
      expect(request.messages[0]?.content).toBe("original");
      yield { type: "finish", finishReason: "stop" };
    },
  };
  const seen: string[] = [];
  const agent = new Agent({ model, hooks: { beforeModel: ({ messages }) => {
    seen.push(String(messages[0]?.content));
    messages[0]!.content = "changed";
  } } });
  expect((await collect(agent.stream(input))).at(-1)?.type).toBe("agent.completed");
  expect(seen).toEqual(["original"]);
  const blocked = await collect(new Agent({ model, hooks: { beforeModel: () => { throw new Error("blocked"); } } }).stream(input));
  expect(blocked.at(-1)).toMatchObject({ type: "agent.failed", error: { message: "blocked" } });
  expect(blocked.findLast((event) => event.type === "agent.budget.updated")).toMatchObject({ budget: { modelCalls: 0 } });
  expect(calls).toBe(1);
});

test("beforeTool runs after approval on resume and can block execution", async () => {
  let executed = 0;
  let checks = 0;
  const model: LanguageModel = {
    provider: "openai-chat-completions",
    async *stream({ messages }): AsyncGenerator<ModelStreamEvent> {
      if (!messages.some((message) => message.role === "tool")) {
        yield { type: "tool.call.completed", toolCall: { id: "call", name: "write", input: { value: "original" } } };
        yield { type: "finish", finishReason: "tool_calls" };
      } else {
        expect(messages.at(-1)).toMatchObject({ role: "tool", isError: true, content: { error: "blocked" } });
        yield { type: "finish", finishReason: "stop" };
      }
    },
  };
  const tool = defineTool({ name: "write", description: "write", input: z.object({ value: z.string() }), execute: () => { executed++; } });
  const agent = new Agent({ model, tools: [tool], approvalMode: "pause", hooks: { beforeTool: ({ toolCall }) => {
    checks++;
    expect(toolCall.input.value).toBe("original");
    throw new Error("blocked");
  } } });
  const paused = (await collect(agent.stream(input))).find((event) => event.type === "agent.paused");
  if (!paused || paused.type !== "agent.paused") throw new Error("expected pause");
  expect(checks).toBe(0);
  const resumed = await collect(agent.resume({ state: paused.runState, approval: { toolCallId: "call", decision: "approved" } }));
  expect(resumed.some((event) => event.type === "tool.execution.failed")).toBe(true);
  expect(resumed.at(-1)?.type).toBe("agent.completed");
  expect(checks).toBe(1);
  expect(executed).toBe(0);
});

test("cancellation during beforeTool prevents the tool from running", async () => {
  const controller = new AbortController();
  let executed = false;
  const model: LanguageModel = {
    provider: "openai-chat-completions",
    async *stream(): AsyncGenerator<ModelStreamEvent> {
      yield { type: "tool.call.completed", toolCall: { id: "call", name: "read", input: {} } };
      yield { type: "finish", finishReason: "tool_calls" };
    },
  };
  const tool = defineTool({ name: "read", description: "read", input: z.object({}), annotations: { readOnly: true }, execute: () => { executed = true; } });
  const agent = new Agent({ model, tools: [tool], hooks: { beforeTool: () => { controller.abort(); } } });
  const events = await collect(agent.stream({ ...input, signal: controller.signal }));
  expect(executed).toBe(false);
  expect(events.at(-1)).toMatchObject({ type: "agent.stopped", stopReason: "cancelled" });
});
