import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { InMemoryRunStore } from "../core/run-store.js";
import { SQLiteRunStore } from "../storage/sqlite-run-store.js";
import type { AgentRunState } from "../index.js";

function runState(runId: string, turn = 1): AgentRunState {
  const message = {
    id: "message-1",
    role: "assistant" as const,
    content: "",
    toolCalls: [{ id: "call_1", name: "read", input: {} }],
  };
  return {
    version: 1,
    runId,
    provider: "openai-chat-completions",
    approvalMode: "callback",
    usesCustomContextEstimator: false,
    toolDefinitions: [],
    toolApprovalPolicies: [],
    sessionHistory: [],
    messages: [{ role: "user", content: "start" }, message],
    messagesToAppend: [message],
    turn,
    pendingToolCalls: [{ id: "call_1", name: "read", input: {} }],
    finishReason: "tool_calls",
    approvalDecisions: [],
    resumeAt: "tool_batch",
  };
}

test("keeps an in-memory checkpoint isolated from caller mutations", async () => {
  const store = new InMemoryRunStore();
  const state = runState("run-1");
  await store.save(state);

  state.turn = 9;

  const loaded = await store.load("run-1");
  expect(loaded?.turn).toBe(1);

  loaded!.turn = 4;
  expect((await store.load("run-1"))?.turn).toBe(1);
});

test("overwrites and deletes a checkpoint by run id", async () => {
  const store = new InMemoryRunStore();
  await store.save(runState("run-1", 1));
  await store.save(runState("run-1", 2));

  expect((await store.load("run-1"))?.turn).toBe(2);

  await store.delete("run-1");
  expect(await store.load("run-1")).toBeUndefined();
  await store.delete("run-1");
});

test("rejects an empty run id", async () => {
  const store = new InMemoryRunStore();
  expect(store.save(runState(""))).rejects.toThrow("runId");
  expect(store.load("")).rejects.toThrow("runId");
  expect(store.delete("")).rejects.toThrow("runId");
});

test("persists a checkpoint across database connections", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rein-kit-run-"));
  const databasePath = join(directory, "runs.sqlite");

  try {
    const database = new Database(databasePath);
    try {
      await new SQLiteRunStore(database).save(runState("run-1"));
    } finally {
      database.close();
    }

    const reopened = new Database(databasePath);
    try {
      const store = new SQLiteRunStore(reopened);
      expect(await store.load("run-1")).toEqual(runState("run-1"));
      expect(await store.load("run-2")).toBeUndefined();

      await store.delete("run-1");
      expect(await store.load("run-1")).toBeUndefined();
    } finally {
      reopened.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("reports a corrupted checkpoint instead of returning partial state", async () => {
  const database = new Database(":memory:");
  try {
    const store = new SQLiteRunStore(database);
    database.run("INSERT INTO rein_agent_runs (run_id, state_json) VALUES (?, ?)", ["broken", "{not json"]);
    expect(store.load("broken")).rejects.toThrow();
  } finally {
    database.close();
  }
});
