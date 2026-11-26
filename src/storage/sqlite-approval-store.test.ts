import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SQLiteApprovalStore } from "../storage/sqlite-approval-store.js";
import type { AgentApprovalRequest } from "../index.js";

function approvalRequest(runId: string, toolCallId: string): AgentApprovalRequest {
  return {
    runId,
    turn: 1,
    toolCallId,
    approvalId: `approval-${toolCallId}`,
    tool: { name: "write", description: "Write a record." },
    input: { value: 1 },
  };
}

test("persists a decision across database connections", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-kit-approval-"));
  const databasePath = join(directory, "approvals.sqlite");

  try {
    const database = new Database(databasePath);
    try {
      await new SQLiteApprovalStore(database).save(approvalRequest("run-1", "call_1"));
    } finally {
      database.close();
    }

    const reopened = new Database(databasePath);
    try {
      const store = new SQLiteApprovalStore(reopened);
      expect(await store.load("run-1")).toEqual([approvalRequest("run-1", "call_1")]);

      await store.save({ ...approvalRequest("run-1", "call_1"), decision: "approved" });
      expect(await store.load("run-1")).toMatchObject([{ decision: "approved" }]);
      expect(await store.list()).toMatchObject([{ toolCallId: "call_1", decision: "approved" }]);
    } finally {
      reopened.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("keeps requests ordered and scoped by run", async () => {
  const store = new SQLiteApprovalStore(new Database(":memory:"));

  await store.save(approvalRequest("run-1", "call_1"));
  await store.save(approvalRequest("run-2", "call_2"));
  await store.save(approvalRequest("run-1", "call_3"));

  expect((await store.load("run-1")).map((request) => request.toolCallId)).toEqual(["call_1", "call_3"]);
  expect((await store.list()).map((request) => request.runId)).toEqual(["run-1", "run-2", "run-1"]);

  await store.delete("run-1");
  expect(await store.load("run-1")).toEqual([]);
  expect((await store.list()).map((request) => request.runId)).toEqual(["run-2"]);
});

test("rejects an empty run id and tool call id", async () => {
  const store = new SQLiteApprovalStore(new Database(":memory:"));
  expect(store.save(approvalRequest("", "call_1"))).rejects.toThrow("runId");
  expect(store.save(approvalRequest("run-1", ""))).rejects.toThrow("toolCallId");
  expect(store.load("")).rejects.toThrow("runId");
  expect(store.delete("")).rejects.toThrow("runId");
});
