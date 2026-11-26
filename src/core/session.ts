import type { AgentMessage } from "./types.js";

export interface SessionStore {
  load(sessionId: string): Promise<readonly AgentMessage[]>;
  append(sessionId: string, messages: readonly AgentMessage[]): Promise<void>;
  clear(sessionId: string): Promise<void>;
}

export function assertSessionId(sessionId: string): void {
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new TypeError("sessionId must be a non-empty string.");
  }
}

export class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, AgentMessage[]>();

  async load(sessionId: string): Promise<readonly AgentMessage[]> {
    assertSessionId(sessionId);
    return structuredClone(this.sessions.get(sessionId) ?? []);
  }

  async append(sessionId: string, messages: readonly AgentMessage[]): Promise<void> {
    assertSessionId(sessionId);
    if (messages.length === 0) return;

    const currentMessages = this.sessions.get(sessionId) ?? [];
    this.sessions.set(sessionId, [...currentMessages, ...structuredClone(messages)]);
  }

  async clear(sessionId: string): Promise<void> {
    assertSessionId(sessionId);
    this.sessions.delete(sessionId);
  }
}
