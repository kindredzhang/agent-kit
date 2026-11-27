import { expect, test } from "bun:test";
import { z } from "zod";
import { Agent, InMemoryRunStore, InMemorySessionStore, defineTool } from "../index.js";
import { createFakeModel } from "../testing.js";

const messages = [{ role: "user" as const, content: "Read the log." }];

test("bounds the tool message in UTF-8 while reporting the full result to the host", async () => {
  const log = "甲🌙🌙".repeat(20);
  const model = createFakeModel({
    turns: [{ toolCalls: [{ name: "read_log", input: {} }] }, { text: "done" }],
  });
  const sessionStore = new InMemorySessionStore();
  const agent = new Agent({
    model,
    tools: [defineTool({
      name: "read_log",
      description: "Read the log.",
      input: z.object({}),
      annotations: { readOnly: true },
      execute: () => log,
    })],
    sessionStore,
    maxToolResultBytes: 33,
    maxContextTokens: 100,
    estimateContextTokens: ({ messages }) => messages.reduce(
      (size, message) => size + JSON.stringify(message.content).length, 0,
    ),
  });

  const events = await Array.fromAsync(agent.stream({ messages, sessionId: "log" }));

  expect(events.find(({ type }) => type === "tool.execution.completed")).toMatchObject({ result: log });
  expect(events.at(-1)).toMatchObject({ type: "agent.completed" });
  const toolMessage = model.requests[1]?.messages.at(-1);
  expect(toolMessage).toMatchObject({ role: "tool", content: "甲🌙\n[Tool result truncated]" });
  expect(new TextEncoder().encode(String(toolMessage?.content)).length).toBeLessThanOrEqual(33);
  expect((await sessionStore.load("log")).find(({ role }) => role === "tool")).toEqual(toolMessage);
});

test("bounds oversized results in existing session history without rewriting that history", async () => {
  const original = { text: "x".repeat(100) };
  const small = { ok: true };
  const sessionStore = new InMemorySessionStore();
  await sessionStore.append("log", [
    { role: "user", content: "Read the log." },
    { role: "assistant", content: "", toolCalls: [
      { id: "big", name: "read_log", input: {} },
      { id: "small", name: "check_status", input: {} },
    ] },
    { role: "tool", toolCallId: "big", content: original, isError: true },
    { role: "tool", toolCallId: "small", content: small },
    { role: "assistant", content: "Done." },
  ]);
  const model = createFakeModel({ turns: [{ text: "Done." }] });
  const agent = new Agent({ model, sessionStore, maxToolResultBytes: 32 });

  await Array.fromAsync(agent.stream({ messages, sessionId: "log" }));

  expect(model.requests[0]?.messages.filter(({ role }) => role === "tool")).toEqual([
    { role: "tool", toolCallId: "big", content: '{"text":\n[Tool result truncated]', isError: true },
    { role: "tool", toolCallId: "small", content: small },
  ]);
  expect((await sessionStore.load("log"))[2]?.content).toEqual(original);
});

test("bounds a saved tool result when resuming a model-turn checkpoint", async () => {
  const runStore = new InMemoryRunStore();
  const log = "x".repeat(100);
  let executions = 0;
  const tools = [defineTool({
    name: "read_log",
    description: "Read the log.",
    input: z.object({}),
    annotations: { readOnly: true },
    execute: () => {
      executions += 1;
      return log;
    },
  })];
  const initialModel = createFakeModel({ turns: [{ toolCalls: [{ name: "read_log", input: {} }] }] });
  const initialAgent = new Agent({ model: initialModel, tools, runStore });
  let runId: string | undefined;
  for await (const event of initialAgent.stream({ messages })) {
    if (event.type === "agent.checkpointed" && event.resumeAt === "model_turn" && event.turn === 2) {
      runId = event.runId;
      break;
    }
  }
  if (runId === undefined) throw new Error("expected a model-turn checkpoint");
  expect((await runStore.load(runId))?.messages.at(-1)?.content).toEqual(log);

  const model = createFakeModel({ turns: [{ text: "Done." }] });
  const agent = new Agent({ model, tools, runStore, maxToolResultBytes: 28 });
  const events = await Array.fromAsync(agent.resume({ runId }));

  expect(events.at(-1)).toMatchObject({ type: "agent.completed" });
  expect(model.requests[0]?.messages.at(-1)).toMatchObject({
    role: "tool",
    content: "xxxx\n[Tool result truncated]",
  });
  expect(executions).toBe(1);
});

test("returns the full structured output even with a small tool result limit", async () => {
  const output = { text: "x".repeat(100) };
  const model = createFakeModel({ turns: [{ toolCalls: [{ name: "final_answer", input: output }] }] });
  const agent = new Agent({ model, outputSchema: z.object({ text: z.string() }), maxToolResultBytes: 1 });

  const events = await Array.fromAsync(agent.stream({ messages }));

  expect(events.at(-1)).toMatchObject({ type: "agent.completed", structuredOutput: output });
});
