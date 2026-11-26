import type { AgentEvent, AgentStopReason } from "./agent";
import type { AgentBudgetSnapshot } from "./budget";
import type { FinishReason, JsonObject, JsonValue, ModelProvider, TokenUsage } from "./types";
import { combineUsage } from "./usage";

interface TraceTiming {
  startedAt: number;
  endedAt: number;
}

export interface AgentTrace extends TraceTiming {
  id: string;
  runId: string;
  operation: "invoke_agent";
  provider?: ModelProvider;
  resumed: boolean;
  status: "completed" | "paused" | "stopped" | "failed" | "interrupted";
  stopReason?: AgentStopReason;
  usage?: TokenUsage;
  budget?: AgentBudgetSnapshot;
  turns: AgentTurnTrace[];
}

export interface AgentTurnTrace extends TraceTiming {
  operation: "step";
  turn: number;
  model?: AgentModelTrace;
  modelRetries?: number;
  tools: AgentToolTrace[];
  approvals: AgentApprovalTrace[];
  compaction?: { estimatedTokensBefore: number; estimatedTokensAfter: number; removedTurnCount: number };
}

export interface AgentModelTrace extends TraceTiming {
  operation: "chat";
  requestModel?: string;
  finishReason?: FinishReason;
  usage?: TokenUsage;
  output?: string;
}

export interface AgentToolTrace extends TraceTiming {
  operation: "execute_tool";
  toolCallId: string;
  name: string;
  status: "completed" | "failed" | "interrupted";
  attempts?: number;
  input?: JsonObject;
  output?: JsonValue;
}

export interface AgentApprovalTrace {
  approvalId: string;
  toolCallId: string;
  requestedAt?: number;
  resolvedAt?: number;
  decision?: "approved" | "rejected";
  reason?: Extract<AgentEvent, { type: "tool.approval.resolved" }>["reason"];
}

export interface AgentTraceOptions {
  recordInputs?: boolean;
  recordOutputs?: boolean;
  requestModel?: string;
  now?: () => number;
}

export class AgentTraceCollector {
  private trace?: AgentTrace;
  private closed = false;
  private readonly now: () => number;
  private readonly recordInputs: boolean;
  private readonly recordOutputs: boolean;
  private readonly requestModel?: string;
  private readonly inputs = new Map<string, JsonObject>();
  private readonly activeTools = new Map<string, AgentToolTrace>();

  constructor(options: AgentTraceOptions = {}) {
    this.now = options.now ?? (() => performance.timeOrigin + performance.now());
    this.recordInputs = options.recordInputs === true;
    this.recordOutputs = options.recordOutputs === true;
    this.requestModel = options.requestModel;
  }

  record(event: AgentEvent): void {
    if (this.closed || (this.trace && this.trace.runId !== event.runId)) {
      throw new Error("An AgentTraceCollector accepts one Agent event stream.");
    }

    if (event.type === "agent.started" || event.type === "agent.resumed") {
      if (this.trace) throw new Error("An AgentTraceCollector accepts one Agent event stream.");
      this.trace = this.startTrace(event.runId, this.now());
      this.trace.provider = event.provider;
      this.trace.resumed = event.type === "agent.resumed";
      return;
    }

    if (event.type === "message.delta" || event.type === "tool.call.started" ||
      event.type === "tool.call.arguments.delta" ||
      (event.type === "tool.call.completed" && !this.recordInputs) ||
      (event.type === "message.completed" && !this.recordOutputs)) return;

    const now = this.now();
    const trace = this.trace ??= this.startTrace(event.runId, now);
    switch (event.type) {
      case "agent.budget.updated":
        trace.budget = structuredClone(event.budget);
        return;
      case "agent.completed":
      case "agent.stopped":
      case "agent.failed":
        trace.status = event.type === "agent.completed" ? "completed" : event.type === "agent.stopped" ? "stopped" : "failed";
        trace.stopReason = event.stopReason;
        if (event.usage) trace.usage = combineUsage(undefined, event.usage);
        this.close(now);
        return;
      case "agent.paused":
        trace.status = "paused";
        if (event.runState.usage) trace.usage = combineUsage(undefined, event.runState.usage);
        this.close(now);
        return;
    }

    const turn = this.getTurn(trace, event.turn, now);
    switch (event.type) {
      case "agent.context.compacted":
        turn.compaction = {
          estimatedTokensBefore: event.estimatedTokensBefore,
          estimatedTokensAfter: event.estimatedTokensAfter,
          removedTurnCount: event.removedTurnCount,
        };
        break;
      case "message.started":
        turn.model = {
          operation: "chat",
          startedAt: now,
          endedAt: now,
          ...(this.requestModel !== undefined ? { requestModel: this.requestModel } : {}),
        };
        break;
      case "usage":
        if (turn.model) turn.model.usage = combineUsage(turn.model.usage, event.usage);
        trace.usage = combineUsage(trace.usage, event.usage);
        break;
      case "message.completed":
        if (turn.model) turn.model.output = event.message.content;
        break;
      case "turn.completed":
        if (turn.model) {
          turn.model.finishReason = event.finishReason;
          turn.model.endedAt = now;
        }
        break;
      case "model.request.retrying":
        turn.modelRetries = (turn.modelRetries ?? 0) + 1;
        break;
      case "tool.call.completed":
        this.inputs.set(event.toolCall.id, structuredClone(event.toolCall.input));
        break;
      case "tool.approval.requested":
        if (this.recordInputs) this.inputs.set(event.toolCall.id, structuredClone(event.toolCall.input));
        turn.approvals.push({ approvalId: event.approvalId, toolCallId: event.toolCall.id, requestedAt: now });
        break;
      case "tool.approval.resolved": {
        const approval = turn.approvals.find(({ approvalId }) => approvalId === event.approvalId);
        const resolution = {
          approvalId: event.approvalId,
          toolCallId: event.toolCallId,
          resolvedAt: now,
          decision: event.decision,
          ...(event.reason ? { reason: event.reason } : {}),
        };
        if (approval) Object.assign(approval, resolution);
        else turn.approvals.push(resolution);
        break;
      }
      case "tool.execution.started": {
        const input = this.inputs.get(event.toolCallId);
        const tool: AgentToolTrace = {
          operation: "execute_tool",
          toolCallId: event.toolCallId,
          name: event.name,
          startedAt: now,
          endedAt: now,
          status: "interrupted",
          ...(input !== undefined ? { input } : {}),
        };
        turn.tools.push(tool);
        this.activeTools.set(event.toolCallId, tool);
        break;
      }
      case "tool.execution.completed":
      case "tool.execution.failed": {
        const tool = this.activeTools.get(event.toolCallId);
        if (!tool) break;
        tool.endedAt = now;
        tool.status = event.type === "tool.execution.completed" ? "completed" : "failed";
        if (event.attempts !== undefined) tool.attempts = event.attempts;
        if (event.type === "tool.execution.completed" && this.recordOutputs) {
          tool.output = structuredClone(event.result);
        }
        this.activeTools.delete(event.toolCallId);
        break;
      }
    }
  }

  finish(): AgentTrace | undefined {
    if (!this.closed) this.close(this.now());
    return this.trace && structuredClone(this.trace);
  }

  private startTrace(runId: string, now: number): AgentTrace {
    return {
      id: crypto.randomUUID(),
      runId,
      operation: "invoke_agent",
      startedAt: now,
      endedAt: now,
      resumed: false,
      status: "interrupted",
      turns: [],
    };
  }

  private getTurn(trace: AgentTrace, turnNumber: number, now: number): AgentTurnTrace {
    const current = trace.turns.at(-1);
    if (current?.turn === turnNumber) return current;
    this.closeTurn(now);
    const turn: AgentTurnTrace = {
      operation: "step",
      turn: turnNumber,
      startedAt: now,
      endedAt: now,
      tools: [],
      approvals: [],
    };
    trace.turns.push(turn);
    return turn;
  }

  private closeTurn(now: number): void {
    const turn = this.trace?.turns.at(-1);
    if (turn) {
      turn.endedAt = now;
      if (turn.model && turn.model.finishReason === undefined) turn.model.endedAt = now;
    }
    for (const tool of this.activeTools.values()) tool.endedAt = now;
    this.activeTools.clear();
    this.inputs.clear();
  }

  private close(now: number): void {
    this.closeTurn(now);
    if (this.trace) this.trace.endedAt = now;
    this.closed = true;
  }
}
