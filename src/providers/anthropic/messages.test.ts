import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { Agent, InMemorySessionStore, SQLiteRunStore, SQLiteSessionStore, defineTool } from "../../index.js";
import { AnthropicMessagesModel } from "./messages.js";

type Turn = {
  content: Anthropic.ContentBlock[];
  stopReason: Anthropic.Message["stop_reason"];
  events?: readonly unknown[];
};

function scriptedClient(turns: readonly Turn[]) {
  const requests: Anthropic.MessageStreamParams[] = [];
  const client = {
    messages: {
      stream: (request: Anthropic.MessageStreamParams) => {
        const turn = turns[requests.length];
        requests.push(request);
        if (!turn) throw new Error("Unexpected model request.");
        const events = (async function* () {
          for (const event of turn.events ?? []) yield event;
        })();
        return Object.assign(events, {
          finalMessage: async () => ({
            id: `msg_${requests.length}`,
            content: turn.content,
            stop_reason: turn.stopReason,
            usage: { input_tokens: 3, output_tokens: 2 },
          }),
        });
      },
    },
  } as unknown as Anthropic;
  return { client, requests };
}

const thinking = { type: "adaptive" } as const;
const question = { role: "user", content: "Look it up." } as const;
const tool = defineTool({
  name: "lookup",
  description: "Look up a record.",
  input: z.object({ key: z.string() }),
  execute: ({ key }) => ({ key, found: true }),
});

function answer(text: string): Turn {
  return {
    content: [{ type: "text", text, citations: null }],
    stopReason: "end_turn",
    events: [{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }],
  };
}

test("replays signed Anthropic blocks in order after approval and across saved session turns", async () => {
  const blocks: Anthropic.ContentBlock[] = [
    { type: "thinking", thinking: "Check the record.", signature: "signature_1" },
    { type: "text", text: "Looking it up.", citations: null },
    { type: "redacted_thinking", data: "redacted_1" },
    { type: "tool_use", id: "toolu_1", name: "lookup", input: { key: "one" }, caller: { type: "direct" } },
  ];
  const found = answer("Found it.");
  const { client, requests } = scriptedClient([
    {
      content: blocks,
      stopReason: "tool_use",
      events: [
        { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Check the record." } },
        { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Looking it up." } },
      ],
    },
    {
      ...found,
      content: [{ type: "thinking", thinking: "", signature: "signature_2" }, ...found.content],
    },
    answer("Still found."),
  ]);
  using database = new Database(":memory:");
  const makeAgent = () => new Agent({
    model: new AnthropicMessagesModel({ client, model: "test-model", thinking }),
    tools: [tool],
    approvalMode: "pause",
    runStore: new SQLiteRunStore(database),
    sessionStore: new SQLiteSessionStore(database),
  });

  const events = await Array.fromAsync(makeAgent().stream({ messages: [question], sessionId: "lookup" }));
  const paused = events.at(-1);
  if (paused?.type !== "agent.paused") throw new Error("expected a pause");
  expect(requests[0]?.thinking).toEqual(thinking);
  expect(events).toContainEqual(expect.objectContaining({
    type: "message.delta",
    delta: { type: "reasoning", text: "Check the record." },
  }));

  const resumed = await Array.fromAsync(makeAgent().resume({
    runId: paused.runId,
    approval: { toolCallId: "toolu_1", decision: "approved" },
  }));
  expect(resumed.at(-1)).toMatchObject({ type: "agent.completed", message: { content: "Found it." } });
  expect(requests[1]?.messages).toEqual([
    question,
    { role: "assistant", content: blocks },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: '{"key":"one","found":true}' }] },
  ]);

  const followUp = { role: "user", content: "Show it again." } as const;
  await Array.fromAsync(makeAgent().stream({ messages: [followUp], sessionId: "lookup" }));
  expect(requests[2]?.messages).toEqual([
    ...requests[1]!.messages,
    { role: "assistant", content: [
      { type: "thinking", thinking: "", signature: "signature_2" },
      { type: "text", text: "Found it.", citations: null },
    ] },
    followUp,
  ]);
});

test("uses portable Anthropic history when context compaction invalidates a signature", async () => {
  const reply = answer("Done.");
  const { client, requests } = scriptedClient([
    reply,
    {
      ...reply,
      content: [{ type: "thinking", thinking: "", signature: "signature_1" }, ...reply.content],
    },
    reply,
  ]);
  const agent = new Agent({
    model: new AnthropicMessagesModel({ client, model: "test-model", thinking }),
    sessionStore: new InMemorySessionStore(),
    maxContextTokens: 3,
    estimateContextTokens: ({ messages }) => messages.length,
  });
  const second = { role: "user", content: "Another question." } as const;
  const third = { role: "user", content: "Last question." } as const;
  await Array.fromAsync(agent.stream({ sessionId: "lookup", messages: [question] }));
  await Array.fromAsync(agent.stream({ sessionId: "lookup", messages: [second] }));
  const events = await Array.fromAsync(agent.stream({ sessionId: "lookup", messages: [third] }));

  expect(events).toContainEqual(expect.objectContaining({ type: "agent.context.compacted", removedTurnCount: 1 }));
  expect(requests[2]?.messages).toEqual([
    second,
    { role: "assistant", content: [{ type: "text", text: "Done." }] },
    third,
  ]);
});

test("continues a compacted Anthropic tool turn when its manual thinking prefix is gone", async () => {
  const reply = answer("Done.");
  const { client, requests } = scriptedClient([
    reply,
    { stopReason: "tool_use", content: [
      { type: "thinking", thinking: "Check.", signature: "signature_1" },
      { type: "tool_use", id: "toolu_1", name: "lookup", input: { key: "one" }, caller: { type: "direct" } },
    ] },
    reply,
  ]);
  const manual = { type: "enabled", budget_tokens: 1_024 } as const;
  const agent = new Agent({
    model: new AnthropicMessagesModel({ client, model: "test-model", thinking: manual }),
    tools: [tool],
    approveTool: () => true,
    sessionStore: new InMemorySessionStore(),
    maxContextTokens: 3,
    estimateContextTokens: ({ messages }) => messages.length,
  });
  await Array.fromAsync(agent.stream({ sessionId: "lookup", messages: [question] }));
  const followUp = { role: "user", content: "Look up another record." } as const;
  const events = await Array.fromAsync(agent.stream({ sessionId: "lookup", messages: [followUp] }));

  expect(events.at(-1)).toMatchObject({ type: "agent.completed" });
  expect(requests[1]?.thinking).toEqual(manual);
  expect(requests[2]).toMatchObject({
    thinking: { type: "disabled" },
    messages: [
      followUp,
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "lookup", input: { key: "one" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: '{"key":"one","found":true}' }] },
    ],
  });
});

test("sends ordered text, URL and base64 images, and a PDF to Anthropic Messages", async () => {
  const { client, requests } = scriptedClient([answer("Done.")]);
  const model = new AnthropicMessagesModel({ client, model: "test-model" });
  await Array.fromAsync(model.stream({ messages: [{ role: "user", content: [
    { type: "text", text: "Compare these." },
    { type: "image", source: { type: "url", url: "https://example.com/image.png" } },
    { type: "image", source: { type: "base64", mediaType: "image/png", data: "aW1hZ2U=" } },
    { type: "file", mediaType: "application/pdf", filename: "report.pdf", data: "cGRm" },
    { type: "text", text: "Use a table." },
  ] }] }));

  expect(requests[0]?.messages).toEqual([{ role: "user", content: [
    { type: "text", text: "Compare these." },
    { type: "image", source: { type: "url", url: "https://example.com/image.png" } },
    { type: "image", source: { type: "base64", media_type: "image/png", data: "aW1hZ2U=" } },
    { type: "document", title: "report.pdf", source: { type: "base64", media_type: "application/pdf", data: "cGRm" } },
    { type: "text", text: "Use a table." },
  ] }]);
});
