import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { SQLiteApprovalStore } from "./sqlite-approval-store.js";
import { SQLiteRunStore } from "./sqlite-run-store.js";
import { SQLiteSessionStore } from "./sqlite-session.js";
import type { SQLiteDatabase } from "./sqlite.js";

class RecordingDatabase implements SQLiteDatabase {
  readonly statements: string[] = [];

  constructor(private readonly inner: Database) {}

  run(sql: string): unknown {
    this.statements.push(sql.trim().split("\n")[0]!.trim());
    return this.inner.run(sql);
  }

  query<Row = unknown>(sql: string) {
    return this.inner.query<Row, any[]>(sql);
  }

  transaction<Args extends unknown[]>(fn: (...args: Args) => void): (...args: Args) => void {
    return this.inner.transaction(fn);
  }
}

test("accepts any database that satisfies the SQLiteDatabase interface", async () => {
  const database = new RecordingDatabase(new Database(":memory:"));

  const sessions = new SQLiteSessionStore(database);
  await sessions.append("session-1", [{ role: "user", content: "hello" }]);
  expect(await sessions.load("session-1")).toEqual([{ role: "user", content: "hello" }]);

  const runs = new SQLiteRunStore(database);
  expect(await runs.load("missing")).toBeUndefined();

  const approvals = new SQLiteApprovalStore(database);
  expect(await approvals.list()).toEqual([]);

  expect(database.statements.some((sql) => sql.startsWith("CREATE TABLE IF NOT EXISTS agentkit_session_messages")))
    .toBe(true);
  expect(database.statements.some((sql) => sql.startsWith("CREATE TABLE IF NOT EXISTS agentkit_agent_runs")))
    .toBe(true);
  expect(database.statements.some((sql) => sql.startsWith("CREATE TABLE IF NOT EXISTS agentkit_agent_approvals")))
    .toBe(true);
});
