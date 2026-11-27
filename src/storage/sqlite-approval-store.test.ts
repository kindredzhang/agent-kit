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
    createdAt: 1_700_000_000_000,
  };
}

test("persists a decision across database connections", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rein-kit-approval-"));
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

test("pages in creation order and stops at the last page", async () => {
  const store = new SQLiteApprovalStore(new Database(":memory:"));
  for (const [index, runId] of ["run-1", "run-2", "run-3", "run-4", "run-5"].entries()) {
    await store.save({ ...approvalRequest(runId, "call_1"), createdAt: 1_000 + index });
  }

  const first = await store.listPage({ limit: 2 });
  expect(first.requests.map(({ runId }) => runId)).toEqual(["run-1", "run-2"]);

  const second = await store.listPage({ limit: 2, cursor: first.nextCursor });
  expect(second.requests.map(({ runId }) => runId)).toEqual(["run-3", "run-4"]);

  const third = await store.listPage({ limit: 2, cursor: second.nextCursor });
  expect(third.requests.map(({ runId }) => runId)).toEqual(["run-5"]);
  expect(third.nextCursor).toBeUndefined();
});

test("breaks ties on identical creation times", async () => {
  const store = new SQLiteApprovalStore(new Database(":memory:"));
  for (const runId of ["run-b", "run-a", "run-c"]) {
    await store.save({ ...approvalRequest(runId, "call_1"), createdAt: 1_000 });
  }

  const first = await store.listPage({ limit: 2 });
  expect(first.requests.map(({ runId }) => runId)).toEqual(["run-a", "run-b"]);

  const second = await store.listPage({ limit: 2, cursor: first.nextCursor });
  expect(second.requests.map(({ runId }) => runId)).toEqual(["run-c"]);
});

test("pages only pending requests by default and includes decided ones when asked", async () => {
  const store = new SQLiteApprovalStore(new Database(":memory:"));
  for (const [index, runId] of ["run-1", "run-2", "run-3"].entries()) {
    await store.save({ ...approvalRequest(runId, "call_1"), createdAt: 1_000 + index });
  }
  await store.save({ ...approvalRequest("run-2", "call_1"), createdAt: 1_001, decision: "approved" });

  expect((await store.listPage({ limit: 10 })).requests.map(({ runId }) => runId)).toEqual(["run-1", "run-3"]);
  expect((await store.listPage({ limit: 10, pendingOnly: false })).requests.map(({ runId }) => runId))
    .toEqual(["run-1", "run-2", "run-3"]);
});

test("prunes only decided requests older than the cutoff", async () => {
  const store = new SQLiteApprovalStore(new Database(":memory:"));
  await store.save({ ...approvalRequest("run-old-decided", "call_1"), createdAt: 1_000, decision: "approved" });
  await store.save({ ...approvalRequest("run-old-pending", "call_2"), createdAt: 1_000 });
  await store.save({ ...approvalRequest("run-new-decided", "call_3"), createdAt: 9_000, decision: "rejected" });

  expect(await store.prune({ decidedBefore: 5_000 })).toBe(1);
  expect((await store.list()).map(({ runId }) => runId)).toEqual(["run-old-pending", "run-new-decided"]);
  expect(await store.prune({ decidedBefore: 5_000 })).toBe(0);
});

test("backfills createdAt when the table predates the column", async () => {
  const database = new Database(":memory:");
  database.run(`
    CREATE TABLE rein_agent_approvals (
      run_id TEXT NOT NULL,
      approval_id TEXT NOT NULL,
      request_json TEXT NOT NULL,
      PRIMARY KEY (run_id, approval_id)
    )
  `);
  database.query(`
    INSERT INTO rein_agent_approvals (run_id, approval_id, request_json)
    VALUES (?, ?, ?)
  `).run("run-1", "approval-1", JSON.stringify({ ...approvalRequest("run-1", "call_1"), createdAt: 1_500 }));

  const store = new SQLiteApprovalStore(database);
  const page = await store.listPage({ limit: 10 });
  expect(page.requests).toEqual([{ ...approvalRequest("run-1", "call_1"), createdAt: 1_500 }]);
});
