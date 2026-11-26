import type { Agent, AgentEvent } from "./agent";
import { toJsonValue } from "./json";
import { assertRunId } from "./run-store";
import type { ToolAnnotations } from "./tools";
import type { JsonValue } from "./types";

export type AgentApprovalDecision = "approved" | "rejected";

export type AgentPausedEvent = Extract<AgentEvent, { type: "agent.paused" }>;
export type AgentApprovalRequestedEvent = Extract<AgentEvent, { type: "tool.approval.requested" }>;

export interface AgentApprovalRequest {
  runId: string;
  turn: number;
  toolCallId: string;
  approvalId: string;
  tool: { name: string; description: string; annotations?: ToolAnnotations };
  input: JsonValue;
  decision?: AgentApprovalDecision;
}

export interface AgentApprovalStore {
  save(request: AgentApprovalRequest): Promise<void>;
  load(runId: string): Promise<readonly AgentApprovalRequest[]>;
  list(): Promise<readonly AgentApprovalRequest[]>;
  delete(runId: string): Promise<void>;
}

export class InMemoryApprovalStore implements AgentApprovalStore {
  private readonly requests = new Map<string, AgentApprovalRequest>();

  async save(request: AgentApprovalRequest): Promise<void> {
    this.assertRequest(request);
    this.requests.set(key(request.runId, request.approvalId), structuredClone(request));
    return Promise.resolve();
  }

  async load(runId: string): Promise<readonly AgentApprovalRequest[]> {
    assertRunId(runId);
    return Promise.resolve(this.select((request) => request.runId === runId));
  }

  async list(): Promise<readonly AgentApprovalRequest[]> {
    return Promise.resolve(this.select(() => true));
  }

  async delete(runId: string): Promise<void> {
    assertRunId(runId);
    for (const [requestKey, request] of this.requests) {
      if (request.runId === runId) this.requests.delete(requestKey);
    }
    return Promise.resolve();
  }

  private select(predicate: (request: AgentApprovalRequest) => boolean): AgentApprovalRequest[] {
    return Array.from(this.requests.values())
      .filter(predicate)
      .map((request) => structuredClone(request));
  }

  private assertRequest(request: AgentApprovalRequest): void {
    assertRunId(request?.runId);
    assertApprovalId(request.approvalId);
    assertToolCallId(request.toolCallId);
  }
}

export class AgentApprovalQueue {
  private readonly store: AgentApprovalStore;
  private readonly requested = new Map<string, AgentApprovalRequestedEvent>();

  constructor(options: { store?: AgentApprovalStore } = {}) {
    this.store = options.store ?? new InMemoryApprovalStore();
  }

  async record(event: AgentPausedEvent): Promise<AgentApprovalRequest | undefined> {
    if (!event || event.type !== "agent.paused") {
      throw new TypeError("Recording an approval request requires an agent.paused event.");
    }
    assertRunId(event.runId);
    const pending = event.runState?.pendingApproval;
    if (!pending || pending.toolCallId !== event.pendingToolCall.id) {
      throw new TypeError("The paused run state does not carry a pending approval for its tool call.");
    }
    assertToolCallId(event.pendingToolCall.id);
    assertApprovalId(pending.approvalId);

    const existing = await this.store.load(event.runId);
    if (existing.some((request) => request.approvalId === pending.approvalId)) {
      return undefined;
    }

    const requested = this.requested.get(event.runId);
    this.requested.delete(event.runId);
    const definition = event.runState.toolDefinitions
      .find((entry) => entry.name === event.pendingToolCall.name);
    const request: AgentApprovalRequest = {
      runId: event.runId,
      turn: event.turn,
      toolCallId: event.pendingToolCall.id,
      approvalId: pending.approvalId,
      tool: requested && requested.toolCall.id === event.pendingToolCall.id
        ? { ...requested.tool }
        : { name: event.pendingToolCall.name, description: definition?.description ?? "" },
      input: requested && requested.toolCall.id === event.pendingToolCall.id
        ? toJsonValue(requested.input)
        : event.pendingToolCall.input,
    };

    await this.store.delete(event.runId);
    await this.store.save(request);
    return structuredClone(request);
  }

  async *observe(events: AsyncIterable<AgentEvent>): AsyncGenerator<AgentEvent> {
    for await (const event of events) {
      switch (event.type) {
        case "tool.approval.requested":
          this.requested.set(event.runId, event);
          break;
        case "agent.paused":
          await this.record(event);
          break;
        case "agent.completed":
        case "agent.failed":
          await this.clear(event.runId);
          break;
        case "agent.stopped":
          if (event.runState === undefined) await this.clear(event.runId);
          break;
      }
      yield event;
    }
  }

  async list(options: { pendingOnly?: boolean } = {}): Promise<AgentApprovalRequest[]> {
    const requests = await this.store.list();
    const selected = options.pendingOnly === false
      ? requests
      : requests.filter((request) => request.decision === undefined);
    return selected.map((request) => structuredClone(request));
  }

  async decisionFor(
    runId: string,
  ): Promise<{ toolCallId: string; approvalId: string; decision: AgentApprovalDecision } | undefined> {
    assertRunId(runId);
    const requests = await this.store.load(runId);
    const latest = requests.at(-1);
    return latest?.decision === undefined
      ? undefined
      : { toolCallId: latest.toolCallId, approvalId: latest.approvalId, decision: latest.decision };
  }

  async decide(input: {
    runId: string;
    approvalId: string;
    decision: AgentApprovalDecision;
  }): Promise<AgentApprovalRequest> {
    if (!input || typeof input !== "object") {
      throw new TypeError("An approval decision requires runId, approvalId, and decision.");
    }
    assertRunId(input.runId);
    assertApprovalId(input.approvalId);
    if (input.decision !== "approved" && input.decision !== "rejected") {
      throw new TypeError("An approval decision must be \"approved\" or \"rejected\".");
    }

    const requests = await this.store.load(input.runId);
    const request = requests.find((entry) => entry.approvalId === input.approvalId);
    if (!request) {
      throw new Error(`No approval request "${input.approvalId}" for run "${input.runId}".`);
    }
    if (request.decision !== undefined) {
      throw new Error(`The approval request "${input.approvalId}" is already decided.`);
    }

    const decided: AgentApprovalRequest = { ...request, decision: input.decision };
    await this.store.save(decided);
    return structuredClone(decided);
  }

  async clear(runId: string): Promise<void> {
    assertRunId(runId);
    this.requested.delete(runId);
    await this.store.delete(runId);
  }

  async *resume(
    agent: Agent,
    runId: string,
    options: { signal?: AbortSignal } = {},
  ): AsyncGenerator<AgentEvent> {
    const decision = await this.decisionFor(runId);
    yield* this.observe(agent.resume({
      runId,
      ...(decision ? { approval: { toolCallId: decision.toolCallId, decision: decision.decision } } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    }));
  }
}

export function assertToolCallId(toolCallId: string): void {
  if (typeof toolCallId !== "string" || toolCallId.length === 0) {
    throw new TypeError("toolCallId must be a non-empty string.");
  }
}

export function assertApprovalId(approvalId: string): void {
  if (typeof approvalId !== "string" || approvalId.length === 0) {
    throw new TypeError("approvalId must be a non-empty string.");
  }
}

function key(runId: string, approvalId: string): string {
  return `${runId}\u0000${approvalId}`;
}
