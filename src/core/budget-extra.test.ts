import { expect, test } from "bun:test";
import { Agent, createSubagentTool } from "../index";
import type { AgentEvent, AgentTool, LanguageModel, ModelStreamEvent } from "../index";

async function collect(events: AsyncIterable<AgentEvent>) {
  const result: AgentEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

test("shares a budget through nested subagents without a parent signal", async () => {
  let calls = 0;
  let tool: AgentTool;
  const model: LanguageModel = {
    provider: "openai-chat-completions",
    async *stream({ messages }): AsyncGenerator<ModelStreamEvent> {
      calls++;
      if (messages.some((m) => m.role === "tool")) {
        yield { type: "finish", finishReason: "stop" };
      } else {
        yield { type: "tool.call.completed", toolCall: { id: `call-${calls}`, name: "delegate", input: { task: "continue" } } };
        yield { type: "finish", finishReason: "tool_calls" };
      }
    },
  };
  tool = createSubagentTool({ name: "delegate", description: "delegate", maxDepth: 3, createAgent: () => new Agent({ model, tools: [tool] }) });
  const agent = new Agent({ model, tools: [tool] });
  const events = await collect(agent.stream({ messages: [{ role: "user", content: "start" }], budget: { maxModelCalls: 3 } }));
  expect(calls).toBe(3);
  expect(events.at(-1)).toMatchObject({ type: "agent.stopped", stopReason: "budget_exceeded", budget: { modelCalls: 3 } });
});

test("records missing usage and failed requests without refunding a call", async () => {
  const model: LanguageModel = {
    provider: "openai-chat-completions",
    async *stream(): AsyncGenerator<ModelStreamEvent> { throw new Error("failed"); },
  };
  const events = await collect(new Agent({ model }).stream({ messages: [{ role: "user", content: "start" }], budget: { maxModelCalls: 1 } }));
  expect(events.at(-2)).toMatchObject({ type: "agent.budget.updated", budget: { modelCalls: 1, requestsWithUsage: 0 } });
  expect(events.at(-1)).toMatchObject({ type: "agent.failed" });
});
