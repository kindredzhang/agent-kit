import { expect, test } from "bun:test";
import { Agent, defineTool } from "../index";
import type { AgentEvent, AgentRunState, LanguageModel, ModelStreamEvent } from "../index";
import { z } from "zod";

async function collect(stream: AsyncIterable<AgentEvent>) {
  const events: AgentEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

test("max-turn recovery keeps the budget and rejects invalid budget snapshots", async () => {
  const model: LanguageModel = {
    provider: "openai-chat-completions",
    async *stream({ messages }): AsyncGenerator<ModelStreamEvent> {
      if (messages.some((message) => message.role === "tool")) {
        yield { type: "usage", usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 } };
        yield { type: "finish", finishReason: "stop" };
      } else {
        yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
        yield { type: "tool.call.completed", toolCall: { id: "c", name: "read", input: {} } };
        yield { type: "finish", finishReason: "tool_calls" };
      }
    },
  };
  const tool = defineTool({ name: "read", description: "read", input: z.object({}), annotations: { readOnly: true }, execute: () => "ok" });
  const first = new Agent({ model, tools: [tool], maxTurns: 1 });
  const resumedAgent = new Agent({ model, tools: [tool], maxTurns: 2 });
  const firstEvents = await collect(first.stream({ messages: [{ role: "user", content: "start" }], budget: { maxModelCalls: 2 } }));
  const stop = firstEvents.at(-1);
  if (stop?.type !== "agent.stopped" || !stop.runState) throw new Error("expected state");
  const events = await collect(resumedAgent.resume({ state: stop.runState }));
  expect(events.at(-1)).toMatchObject({ type: "agent.completed" });
  expect(events.findLast((event) => event.type === "agent.budget.updated")).toMatchObject({ budget: { modelCalls: 2, usage: { totalTokens: 5 }, usageComplete: true } });
  const invalid = structuredClone(stop.runState) as AgentRunState;
  invalid.budget!.modelCalls = -1;
  const invalidEvents = await collect(resumedAgent.resume({ state: invalid }));
  expect(invalidEvents.at(-1)).toMatchObject({ type: "agent.failed" });
});
