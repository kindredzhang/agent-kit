import type { Agent, AgentEvent } from "./agent.js";
import { toJsonValue } from "./json.js";
import { assertRunId } from "./run-store.js";
import type { ToolAnnotations } from "./tools.js";
import type { JsonValue } from "./types.js";

export type AgentApprovalDecision = "approved" | "rejected";

export type AgentPausedEvent = Extract<AgentEvent, { type: "agent.paused" }>;
export type AgentApprovalRequestedEvent = Extract<AgentEvent, { type: "tool.approval.requested" }>;

interface ApprovalCursor {
  createdAt: number;
  runId: string;
  approvalId: string;
}

export function compareApprovalOrder(left: AgentApprovalRequest, right: AgentApprovalRequest): number {
  if (left.createdAt !== right.createdAt) return left.createdAt - right.createdAt;
  if (left.runId !== right.runId) return left.runId < right.runId ? -1 : 1;
  if (left.approvalId !== right.approvalId) return left.approvalId < right.approvalId ? -1 : 1;
  return 0;
}

export function encodeApprovalCursor(request: AgentApprovalRequest): string {
  const cursor: ApprovalCursor = {
    createdAt: request.createdAt,
    runId: request.runId,
    approvalId: request.approvalId,
  };
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeApprovalCursor(cursor: string): ApprovalCursor {
  if (typeof cursor !== "string" || cursor.length === 0) {
    throw new TypeError("An approval page cursor must be a non-empty string.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new TypeError("The approval page cursor is not one this store produced.");
  }
  if (
    !parsed || typeof parsed !== "object" ||
    typeof (parsed as ApprovalCursor).createdAt !== "number" ||
    typeof (parsed as ApprovalCursor).runId !== "string" ||
    typeof (parsed as ApprovalCursor).approvalId !== "string"
  ) {
    throw new TypeError("The approval page cursor is not one this store produced.");
  }
  return parsed as ApprovalCursor;
}

export function isAfterApprovalCursor(request: AgentApprovalRequest, cursor: ApprovalCursor): boolean {
  if (request.createdAt !== cursor.createdAt) return request.createdAt > cursor.createdAt;
  if (request.runId !== cursor.runId) return request.runId > cursor.runId;
  return request.approvalId > cursor.approvalId;
}

export function assertPageQuery(query: AgentApprovalPageQuery): void {
  if (!Number.isSafeInteger(query?.limit) || query.limit < 1) {
    throw new RangeError("An approval page limit must be a positive integer.");
  }
}

export interface AgentApprovalRequest {
  runId: string;
  turn: number;
  toolCallId: string;
  approvalId: string;
  tool: { name: string; description: string; annotations?: ToolAnnotations };
  input: JsonValue;
  createdAt: number;
  decision?: AgentApprovalDecision;
}

export interface AgentApprovalPage {
  requests: AgentApprovalRequest[];
  nextCursor?: string;
}

export interface AgentApprovalPageQuery {
  limit: number;
  cursor?: string;
  pendingOnly?: boolean;
}

export interface AgentApprovalStore {
  save(request: AgentApprovalRequest): Promise<void>;
  load(runId: string): Promise<readonly AgentApprovalRequest[]>;
  list(): Promise<readonly AgentApprovalRequest[]>;
  listPage(query: AgentApprovalPageQuery): Promise<AgentApprovalPage>;
  prune(input: { decidedBefore: number }): Promise<number>;
  delete(runId: string): Promise<void>;
}

export function assertPruneCutoff(input: { decidedBefore: number }): void {
  if (typeof input?.decidedBefore !== "number" || !Number.isFinite(input.decidedBefore)) {
    throw new TypeError("A prune cutoff requires a finite decidedBefore timestamp.");
  }
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

  async listPage(query: AgentApprovalPageQuery): Promise<AgentApprovalPage> {
    assertPageQuery(query);
    const cursor = query.cursor === undefined ? undefined : decodeApprovalCursor(query.cursor);
    const pendingOnly = query.pendingOnly !== false;

    const ordered = this.select((request) => !pendingOnly || request.decision === undefined)
      .sort(compareApprovalOrder)
      .filter((request) => cursor === undefined || isAfterApprovalCursor(request, cursor));

    const requests = ordered.slice(0, query.limit);
    const last = requests.at(-1);
    return Promise.resolve({
      requests,
      ...(ordered.length > query.limit && last !== undefined
        ? { nextCursor: encodeApprovalCursor(last) }
        : {}),
    });
  }

  async prune(input: { decidedBefore: number }): Promise<number> {
    assertPruneCutoff(input);
    let removed = 0;
    for (const [requestKey, request] of this.requests) {
      if (request.decision !== undefined && request.createdAt < input.decidedBefore) {
        this.requests.delete(requestKey);
        removed += 1;
      }
    }
    return Promise.resolve(removed);
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

export interface AgentApprovalQueueOptions {
  store?: AgentApprovalStore;
  now?: () => number;
}

export class AgentApprovalQueue {
  private readonly store: AgentApprovalStore;
  private readonly now: () => number;
  private readonly requested = new Map<string, AgentApprovalRequestedEvent>();

  constructor(options: AgentApprovalQueueOptions = {}) {
    this.store = options.store ?? new InMemoryApprovalStore();
    this.now = options.now ?? (() => performance.timeOrigin + performance.now());
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
      createdAt: this.now(),
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

  async listPage(query: AgentApprovalPageQuery): Promise<AgentApprovalPage> {
    assertPageQuery(query);
    const page = await this.store.listPage(query);
    return {
      requests: page.requests.map((request) => structuredClone(request)),
      ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
    };
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

  async prune(input: { decidedBefore: number }): Promise<number> {
    assertPruneCutoff(input);
    return this.store.prune(input);
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
