import { assertSessionId } from "../core/session.js";
import type { SessionStore } from "../core/session.js";
import type { AgentMessage } from "../core/types.js";
import type { SQLiteDatabase } from "./sqlite.js";

export class SQLiteSessionStore implements SessionStore {
  constructor(private readonly database: SQLiteDatabase) {
    this.database.run(`
      CREATE TABLE IF NOT EXISTS agentkit_session_messages (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        message_json TEXT NOT NULL
      )
    `);
    this.database.run(`
      CREATE INDEX IF NOT EXISTS agentkit_session_messages_session_sequence
      ON agentkit_session_messages (session_id, sequence)
    `);
  }

  async load(sessionId: string): Promise<readonly AgentMessage[]> {
    assertSessionId(sessionId);
    const rows = this.database.query<{ message_json: string }>(`
      SELECT message_json
      FROM agentkit_session_messages
      WHERE session_id = ?
      ORDER BY sequence ASC
    `).all(sessionId);
    return rows.map((row) => JSON.parse(row.message_json) as AgentMessage);
  }

  async append(sessionId: string, messages: readonly AgentMessage[]): Promise<void> {
    assertSessionId(sessionId);
    if (messages.length === 0) return;

    const insert = this.database.query<never>(`
      INSERT INTO agentkit_session_messages (session_id, message_json)
      VALUES (?, ?)
    `);
    const insertMessages = this.database.transaction((id: string, entries: readonly AgentMessage[]) => {
      for (const message of entries) {
        insert.run(id, JSON.stringify(message));
      }
    });
    insertMessages(sessionId, messages);
  }

  async clear(sessionId: string): Promise<void> {
    assertSessionId(sessionId);
    this.database.query<never>(`
      DELETE FROM agentkit_session_messages
      WHERE session_id = ?
    `).run(sessionId);
  }
}
