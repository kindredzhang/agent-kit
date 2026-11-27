import {
  assertApprovalId,
  assertPageQuery,
  assertPruneCutoff,
  assertToolCallId,
  decodeApprovalCursor,
  encodeApprovalCursor,
} from "../core/approval.js";
import type {
  AgentApprovalPage,
  AgentApprovalPageQuery,
  AgentApprovalRequest,
  AgentApprovalStore,
} from "../core/approval.js";
import { assertRunId } from "../core/run-store.js";
import type { SQLiteDatabase } from "./sqlite.js";

export class SQLiteApprovalStore implements AgentApprovalStore {
  constructor(private readonly database: SQLiteDatabase) {
    this.database.run(`
      CREATE TABLE IF NOT EXISTS rein_agent_approvals (
        run_id TEXT NOT NULL,
        approval_id TEXT NOT NULL,
        request_json TEXT NOT NULL,
        PRIMARY KEY (run_id, approval_id)
      )
    `);
    this.ensureCreatedAtIndex();
  }

  private ensureCreatedAtIndex(): void {
    const columns = this.database.query<{ name: string }>(
      "PRAGMA table_info(rein_agent_approvals)",
    ).all();
    if (!columns.some(({ name }) => name === "created_at")) {
      this.database.run("ALTER TABLE rein_agent_approvals ADD COLUMN created_at INTEGER");
      this.backfillCreatedAt();
    }
    this.database.run(`
      CREATE INDEX IF NOT EXISTS rein_agent_approvals_order
      ON rein_agent_approvals (created_at, run_id, approval_id)
    `);
  }

  private backfillCreatedAt(): void {
    const rows = this.database.query<{ run_id: string; approval_id: string; request_json: string }>(`
      SELECT run_id, approval_id, request_json
      FROM rein_agent_approvals
      WHERE created_at IS NULL
    `).all();
    const update = this.database.query<never>(`
      UPDATE rein_agent_approvals
      SET created_at = ?
      WHERE run_id = ? AND approval_id = ?
    `);
    for (const row of rows) {
      const request = JSON.parse(row.request_json) as Partial<AgentApprovalRequest>;
      const createdAt = typeof request.createdAt === "number" ? request.createdAt : 0;
      update.run(createdAt, row.run_id, row.approval_id);
    }
  }

  async save(request: AgentApprovalRequest): Promise<void> {
    assertRunId(request?.runId);
    assertApprovalId(request.approvalId);
    assertToolCallId(request.toolCallId);
    if (typeof request.createdAt !== "number" || !Number.isFinite(request.createdAt)) {
      throw new TypeError("An approval request requires a numeric createdAt.");
    }
    this.database.query<never>(`
      INSERT INTO rein_agent_approvals (run_id, approval_id, request_json, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (run_id, approval_id) DO UPDATE SET
        request_json = excluded.request_json,
        created_at = excluded.created_at
    `).run(request.runId, request.approvalId, JSON.stringify(request), request.createdAt);
    return Promise.resolve();
  }

  async load(runId: string): Promise<readonly AgentApprovalRequest[]> {
    assertRunId(runId);
    const rows = this.database.query<{ request_json: string }>(`
      SELECT request_json
      FROM rein_agent_approvals
      WHERE run_id = ?
      ORDER BY rowid
    `).all(runId);
    return Promise.resolve(rows.map((row) => JSON.parse(row.request_json) as AgentApprovalRequest));
  }

  async list(): Promise<readonly AgentApprovalRequest[]> {
    const rows = this.database.query<{ request_json: string }>(`
      SELECT request_json
      FROM rein_agent_approvals
      ORDER BY rowid
    `).all();
    return Promise.resolve(rows.map((row) => JSON.parse(row.request_json) as AgentApprovalRequest));
  }

  async listPage(query: AgentApprovalPageQuery): Promise<AgentApprovalPage> {
    assertPageQuery(query);
    const cursor = query.cursor === undefined ? undefined : decodeApprovalCursor(query.cursor);
    const pendingOnly = query.pendingOnly !== false;

    const conditions: string[] = [];
    const params: (string | number)[] = [];
    if (pendingOnly) {
      conditions.push("json_extract(request_json, '$.decision') IS NULL");
    }
    if (cursor !== undefined) {
      conditions.push(
        "(created_at > ? OR (created_at = ? AND (run_id > ? OR (run_id = ? AND approval_id > ?))))",
      );
      params.push(cursor.createdAt, cursor.createdAt, cursor.runId, cursor.runId, cursor.approvalId);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    params.push(query.limit + 1);

    const rows = this.database.query<{ request_json: string }>(`
      SELECT request_json
      FROM rein_agent_approvals
      ${where}
      ORDER BY created_at, run_id, approval_id
      LIMIT ?
    `).all(...params);

    const requests = rows.map((row) => JSON.parse(row.request_json) as AgentApprovalRequest);
    const hasMore = requests.length > query.limit;
    const page = hasMore ? requests.slice(0, query.limit) : requests;
    const last = page.at(-1);
    return Promise.resolve({
      requests: page,
      ...(hasMore && last !== undefined ? { nextCursor: encodeApprovalCursor(last) } : {}),
    });
  }

  async prune(input: { decidedBefore: number }): Promise<number> {
    assertPruneCutoff(input);
    let removed = 0;
    this.database.transaction((cutoff: number) => {
      this.database.query<never>(`
        DELETE FROM rein_agent_approvals
        WHERE created_at < ?
          AND json_extract(request_json, '$.decision') IS NOT NULL
      `).run(cutoff);
      const counted = this.database.query<{ removed: number }>("SELECT changes() AS removed").get();
      removed = counted?.removed ?? 0;
    })(input.decidedBefore);
    return Promise.resolve(removed);
  }

  async delete(runId: string): Promise<void> {
    assertRunId(runId);
    this.database.query<never>(`
      DELETE FROM rein_agent_approvals
      WHERE run_id = ?
    `).run(runId);
    return Promise.resolve();
  }
}
