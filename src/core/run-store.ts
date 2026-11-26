import type { AgentRunState } from "./agent";

export interface AgentRunStore {
  save(state: AgentRunState): Promise<void>;
  load(runId: string): Promise<AgentRunState | undefined>;
  delete(runId: string): Promise<void>;
}

export function assertRunId(runId: string): void {
  if (typeof runId !== "string" || runId.length === 0) {
    throw new TypeError("runId must be a non-empty string.");
  }
}

export class InMemoryRunStore implements AgentRunStore {
  private readonly states = new Map<string, AgentRunState>();

  async save(state: AgentRunState): Promise<void> {
    assertRunId(state?.runId);
    this.states.set(state.runId, structuredClone(state));
    return Promise.resolve();
  }

  async load(runId: string): Promise<AgentRunState | undefined> {
    assertRunId(runId);
    const state = this.states.get(runId);
    return Promise.resolve(state ? structuredClone(state) : undefined);
  }

  async delete(runId: string): Promise<void> {
    assertRunId(runId);
    this.states.delete(runId);
    return Promise.resolve();
  }
}
