import { assertRunId } from "../core/run-store.js";
import type { AgentRunState } from "../core/agent.js";
import type { AgentRunStore } from "../core/run-store.js";
import type { SQLiteDatabase } from "./sqlite.js";

export class SQLiteRunStore implements AgentRunStore {
  constructor(private readonly database: SQLiteDatabase) {
    this.database.run(`
      CREATE TABLE IF NOT EXISTS agentkit_agent_runs (
        run_id TEXT PRIMARY KEY,
        state_json TEXT NOT NULL
      )
    `);
  }

  async save(state: AgentRunState): Promise<void> {
    assertRunId(state?.runId);
    const stateJson = JSON.stringify(state);
    this.database.query<never>(`
      INSERT INTO agentkit_agent_runs (run_id, state_json)
      VALUES (?, ?)
      ON CONFLICT (run_id) DO UPDATE SET state_json = excluded.state_json
    `).run(state.runId, stateJson);
    return Promise.resolve();
  }

  async load(runId: string): Promise<AgentRunState | undefined> {
    assertRunId(runId);
    const row = this.database.query<{ state_json: string }>(`
      SELECT state_json
      FROM agentkit_agent_runs
      WHERE run_id = ?
    `).get(runId);
    return Promise.resolve(row ? JSON.parse(row.state_json) as AgentRunState : undefined);
  }

  async delete(runId: string): Promise<void> {
    assertRunId(runId);
    this.database.query<never>(`
      DELETE FROM agentkit_agent_runs
      WHERE run_id = ?
    `).run(runId);
    return Promise.resolve();
  }
}
