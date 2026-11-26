import { assertApprovalId, assertToolCallId } from "../core/approval.js";
import type { AgentApprovalRequest, AgentApprovalStore } from "../core/approval.js";
import { assertRunId } from "../core/run-store.js";
import type { SQLiteDatabase } from "./sqlite.js";

export class SQLiteApprovalStore implements AgentApprovalStore {
  constructor(private readonly database: SQLiteDatabase) {
    this.database.run(`
      CREATE TABLE IF NOT EXISTS agentkit_agent_approvals (
        run_id TEXT NOT NULL,
        approval_id TEXT NOT NULL,
        request_json TEXT NOT NULL,
        PRIMARY KEY (run_id, approval_id)
      )
    `);
  }

  async save(request: AgentApprovalRequest): Promise<void> {
    assertRunId(request?.runId);
    assertApprovalId(request.approvalId);
    assertToolCallId(request.toolCallId);
    this.database.query<never>(`
      INSERT INTO agentkit_agent_approvals (run_id, approval_id, request_json)
      VALUES (?, ?, ?)
      ON CONFLICT (run_id, approval_id) DO UPDATE SET request_json = excluded.request_json
    `).run(request.runId, request.approvalId, JSON.stringify(request));
    return Promise.resolve();
  }

  async load(runId: string): Promise<readonly AgentApprovalRequest[]> {
    assertRunId(runId);
    const rows = this.database.query<{ request_json: string }>(`
      SELECT request_json
      FROM agentkit_agent_approvals
      WHERE run_id = ?
      ORDER BY rowid
    `).all(runId);
    return Promise.resolve(rows.map((row) => JSON.parse(row.request_json) as AgentApprovalRequest));
  }

  async list(): Promise<readonly AgentApprovalRequest[]> {
    const rows = this.database.query<{ request_json: string }>(`
      SELECT request_json
      FROM agentkit_agent_approvals
      ORDER BY rowid
    `).all();
    return Promise.resolve(rows.map((row) => JSON.parse(row.request_json) as AgentApprovalRequest));
  }

  async delete(runId: string): Promise<void> {
    assertRunId(runId);
    this.database.query<never>(`
      DELETE FROM agentkit_agent_approvals
      WHERE run_id = ?
    `).run(runId);
    return Promise.resolve();
  }
}
