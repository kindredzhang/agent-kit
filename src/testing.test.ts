import { expect, test } from "bun:test";
import { z } from "zod";
import { Agent, defineTool } from "./index.js";
import type { AgentEvent } from "./index.js";
import { createFakeModel } from "./testing.js";

const input = { messages: [{ role: "user" as const, content: "go" }] };

async function collect(stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

test("replays scripted turns in order and splits text into deltas", async () => {
  const model = createFakeModel({ turns: [{ text: "hello world" }, { text: "second" }] });
  const agent = new Agent({ model });

  const first = await collect(agent.stream(input));
  const firstDeltas = first.flatMap((event) =>
    event.type === "message.delta" && event.delta.type === "text" ? [event.delta.text] : [],
  );
  expect(firstDeltas.length).toBeGreaterThan(1);
  expect(firstDeltas.join("")).toBe("hello world");
  expect(first.at(-1)).toMatchObject({ type: "agent.completed" });

  const second = await collect(agent.stream(input));
  expect(second.flatMap((event) =>
    event.type === "message.delta" && event.delta.type === "text" ? [event.delta.text] : [],
  ).join("")).toBe("second");

  expect(model.requests).toHaveLength(2);
});

test("fails loudly when the script runs out instead of repeating the last turn", async () => {
  const model = createFakeModel({ turns: [{ text: "only" }] });
  const agent = new Agent({ model });

  await collect(agent.stream(input));
  const events = await collect(agent.stream(input));

  const failure = events.at(-1);
  expect(failure).toMatchObject({ type: "agent.failed" });
  expect((failure as Extract<AgentEvent, { type: "agent.failed" }>).error.message).toContain("no scripted turn");
  expect(model.requests).toHaveLength(2);
});

test("derives the finish reason and tool call ids from a tool turn", async () => {
  const lookup = defineTool({
    name: "lookup",
    description: "Look something up.",
    input: z.object({ key: z.string() }),
    annotations: { readOnly: true },
    execute: ({ key }) => ({ key }),
  });
  const model = createFakeModel({
    turns: [
      { toolCalls: [{ name: "lookup", input: { key: "a" } }, { name: "lookup", input: { key: "b" } }] },
      { text: "done" },
    ],
  });
  const events = await collect(new Agent({ model, tools: [lookup] }).stream(input));

  const calls = events.flatMap((event) => (event.type === "tool.call.completed" ? [event.toolCall] : []));
  expect(calls).toHaveLength(2);
  expect(calls[0]!.id).not.toBe(calls[1]!.id);
  expect(events.find((event) => event.type === "turn.completed")).toMatchObject({ finishReason: "tool_calls" });
  expect(events.at(-1)).toMatchObject({ type: "agent.completed" });
});

test("exposes every request the agent sent", async () => {
  const model = createFakeModel({ turns: [{ text: "a" }, { text: "b" }] });
  const agent = new Agent({ model, instructions: "be brief" });

  await collect(agent.stream(input));
  await collect(agent.stream({ messages: [{ role: "user", content: "again" }] }));

  expect(model.requests).toHaveLength(2);
  expect(model.requests[0]!.messages).toEqual([
    { role: "system", content: "be brief" },
    { role: "user", content: "go" },
  ]);
  expect(model.requests[1]!.messages.at(-1)).toEqual({ role: "user", content: "again" });
});

test("reports scripted usage on the matching turn", async () => {
  const model = createFakeModel({
    turns: [{ text: "a", usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 } }],
  });
  const events = await collect(new Agent({ model }).stream(input));

  expect(events.find((event) => event.type === "usage")).toMatchObject({
    usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
  });
  expect(events.at(-1)).toMatchObject({ usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 } });
});

test("throws a scripted error so retry paths can be exercised", async () => {
  let attempts = 0;
  const model = createFakeModel({
    turns: [{ error: new Error("gateway down") }, { text: "recovered" }],
    onRequest: () => {
      attempts += 1;
    },
  });
  const events = await collect(new Agent({ model, modelRetry: { maxAttempts: 2, delayMs: 1 } }).stream(input));

  expect(attempts).toBe(2);
  expect(events.at(-1)).toMatchObject({ type: "agent.completed" });
  expect(events.some((event) => event.type === "model.request.retrying")).toBe(true);
});

test("holds a hanging turn open until the caller aborts", async () => {
  const model = createFakeModel({ turns: [{ hang: true }] });
  const controller = new AbortController();
  const agent = new Agent({ model });

  const stream = agent.stream({ ...input, signal: controller.signal });
  setTimeout(() => controller.abort(), 10);
  const events = await collect(stream);

  expect(events.at(-1)).toMatchObject({ type: "agent.stopped", stopReason: "cancelled" });
});

test("can answer requests dynamically instead of from a fixed script", async () => {
  const model = createFakeModel({
    onRequest: (request) => ({
      text: `saw ${request.messages.length} messages`,
    }),
  });
  const events = await collect(new Agent({ model }).stream(input));

  const message = events.at(-1);
  expect(message).toMatchObject({ type: "agent.completed" });
  expect((message as Extract<AgentEvent, { type: "agent.completed" }>).message.content).toBe("saw 1 messages");
});

test("rejects a script with no turns", () => {
  expect(() => createFakeModel({ turns: [] })).toThrow(RangeError);
});
