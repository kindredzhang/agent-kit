import { expect, test } from "bun:test";
import { InMemorySessionStore } from "./session";
import type { AgentMessage } from "./types";

test("keeps isolated session histories and returns independent message copies", async () => {
  const store = new InMemorySessionStore();
  const messages: AgentMessage[] = [
    { role: "user", content: "First question." },
    {
      role: "assistant",
      content: "Done.",
      toolCalls: [{ id: "call_1", name: "lookup", input: { key: "value" } }],
    },
  ];

  await store.append("conversation-a", messages);
  const firstMessage = messages[0];
  if (firstMessage?.role === "user") firstMessage.content = "Changed by caller.";

  const loaded = await store.load("conversation-a");
  expect(loaded).toEqual([
    { role: "user", content: "First question." },
    {
      role: "assistant",
      content: "Done.",
      toolCalls: [{ id: "call_1", name: "lookup", input: { key: "value" } }],
    },
  ]);
  expect(await store.load("conversation-b")).toEqual([]);

  const loadedMessage = loaded[0];
  if (loadedMessage?.role === "user") loadedMessage.content = "Changed by reader.";
  expect((await store.load("conversation-a"))[0]).toEqual({ role: "user", content: "First question." });

  await store.append("conversation-a", [{ role: "user", content: "Second question." }]);
  expect(await store.load("conversation-a")).toHaveLength(3);

  await store.clear("conversation-a");
  expect(await store.load("conversation-a")).toEqual([]);
  expect(await store.load("conversation-b")).toEqual([]);
});
