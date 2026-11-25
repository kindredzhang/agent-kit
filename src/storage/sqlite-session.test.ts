import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "bun:test";
import { SQLiteSessionStore } from "./sqlite-session";
import type { AgentMessage } from "../core/types";

test("persists isolated session histories across database connections", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-kit-session-"));
  const databasePath = join(directory, "sessions.sqlite");
  const messages: AgentMessage[] = [
    { role: "user", content: "Look this up." },
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "call_1", name: "lookup", input: { key: "value" } }],
    },
    { role: "tool", toolCallId: "call_1", content: { found: true } },
    { role: "assistant", content: "Found it." },
  ];

  try {
    const database = new Database(databasePath);
    try {
      const store = new SQLiteSessionStore(database);
      await store.append("conversation-a", messages);
      await store.append("conversation-b", [{ role: "user", content: "Separate." }]);
    } finally {
      database.close();
    }

    const reopenedDatabase = new Database(databasePath);
    try {
      const reopenedStore = new SQLiteSessionStore(reopenedDatabase);
      expect(await reopenedStore.load("conversation-a")).toEqual(messages);
      expect(await reopenedStore.load("conversation-b")).toEqual([{ role: "user", content: "Separate." }]);

      await reopenedStore.clear("conversation-a");
      expect(await reopenedStore.load("conversation-a")).toEqual([]);
      expect(await reopenedStore.load("conversation-b")).toEqual([{ role: "user", content: "Separate." }]);
    } finally {
      reopenedDatabase.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rolls back a session append when a message cannot be serialized", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-kit-session-"));
  const cyclicMessage = { role: "user", content: "Cannot serialize." } as AgentMessage & { self: unknown };
  cyclicMessage.self = cyclicMessage;

  try {
    const database = new Database(join(directory, "sessions.sqlite"));
    try {
      const store = new SQLiteSessionStore(database);
      await expect(store.append("conversation-a", [
        { role: "user", content: "This insert must be rolled back." },
        cyclicMessage,
      ])).rejects.toThrow();
      expect(await store.load("conversation-a")).toEqual([]);
    } finally {
      database.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
