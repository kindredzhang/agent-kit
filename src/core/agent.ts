import * as z from "zod";
import { ContextManager } from "./context";
import { AgentBudget, getBudgetContext, setBudgetContext } from "./budget";
import type { AgentBudgetOptions, AgentBudgetSnapshot } from "./budget";
import type { ContextTokenEstimator } from "./context";
import { assertSessionId } from "./session";
import type { SessionStore } from "./session";
import { toJsonValue } from "./json";
import { combineUsage } from "./usage";
import type { AnyAgentTool, ToolAnnotations, ToolApprovalHandler } from "./tools";
import type {
  AgentMessage,
  AgentToolCall,
  FinishReason,
  JsonObject,
  JsonSchema,
  JsonValue,
  LanguageModel,
  ModelProvider,
  TokenUsage,
  ToolDefinition,
} from "./types";

export interface AgentRunState {
  version: 1;
  budget?: AgentBudgetSnapshot;
  runId: string;
  provider: ModelProvider;
  instructions?: string;
  approvalMode: "callback" | "pause";
  maxContextTokens?: number;
  maxOutputTokens?: number;
  usesCustomContextEstimator: boolean;
  toolDefinitions: readonly ToolDefinition[];
  toolApprovalPolicies: readonly { toolName: string; requiresApproval: boolean }[];
  sessionId?: string;
  sessionHistory: readonly AgentMessage[];
  messages: readonly AgentMessage[];
  messagesToAppend: readonly AgentMessage[];
  turn: number;
  pendingToolCalls: readonly AgentToolCall[];
  finishReason: FinishReason;
  responseId?: string;
  usage?: TokenUsage;
  approvalDecisions: readonly {
    toolCallId: string;
    approvalId: string;
    decision: "approved" | "rejected";
    resolved: boolean;
  }[];
  pendingApproval?: { toolCallId: string; approvalId: string };
}

export interface AgentResumeInput {
  state: AgentRunState;
  approval?: { toolCallId: string; decision: "approved" | "rejected" };
  signal?: AbortSignal;
}

export type MessageDelta =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "refusal"; text: string };

export type AgentStopReason =
  | "completed"
  | "refusal"
  | "max_turns"
  | "cancelled"
  | "length"
  | "context_limit"
  | "budget_exceeded"
  | "usage_unavailable"
  | "error";

export type AgentEvent =
  | { type: "agent.started"; runId: string; provider: ModelProvider }
  | { type: "agent.resumed"; runId: string; provider: ModelProvider }
  | { type: "agent.budget.updated"; runId: string; budget: AgentBudgetSnapshot }
  | { type: "agent.paused"; runId: string; turn: number; pendingToolCall: AgentToolCall; runState: AgentRunState }
  | { type: "turn.started"; runId: string; turn: number }
  | {
      type: "agent.context.compacted";
      runId: string;
      turn: number;
      estimatedTokensBefore: number;
      estimatedTokensAfter: number;
      removedTurnCount: number;
    }
  | { type: "message.started"; runId: string; turn: number; messageId: string; role: "assistant" }
  | { type: "message.delta"; runId: string; turn: number; messageId: string; delta: MessageDelta }
  | { type: "tool.call.started"; runId: string; turn: number; toolCallId: string; name: string }
  | { type: "tool.call.arguments.delta"; runId: string; turn: number; toolCallId: string; delta: string }
  | { type: "tool.call.completed"; runId: string; turn: number; toolCall: AgentToolCall }
  | {
      type: "tool.approval.requested";
      runId: string;
      turn: number;
      approvalId: string;
      toolCall: AgentToolCall;
      input: unknown;
      tool: { name: string; description: string; annotations?: ToolAnnotations };
    }
  | {
      type: "tool.approval.resolved";
      runId: string;
      turn: number;
      approvalId: string;
      toolCallId: string;
      decision: "approved" | "rejected";
      reason?: "no_handler" | "rejected" | "handler_failed" | "cancelled";
    }
  | { type: "tool.execution.started"; runId: string; turn: number; toolCallId: string; name: string }
  | { type: "tool.execution.completed"; runId: string; turn: number; toolCallId: string; name: string; result: JsonValue; attempts?: number }
  | { type: "tool.execution.failed"; runId: string; turn: number; toolCallId: string; name: string; error: Error; attempts?: number }
  | { type: "usage"; runId: string; turn: number; usage: TokenUsage }
  | { type: "message.completed"; runId: string; turn: number; message: Extract<AgentMessage, { role: "assistant" }> }
  | { type: "turn.completed"; runId: string; turn: number; finishReason: FinishReason }
  | {
      type: "agent.completed";
      runId: string;
      stopReason: "completed" | "refusal";
      message: Extract<AgentMessage, { role: "assistant" }>;
      finishReason: FinishReason;
      structuredOutput?: JsonValue;
      usage?: TokenUsage;
      responseId?: string;
    }
  | {
      type: "agent.stopped";
      runId: string;
      stopReason: "max_turns" | "cancelled" | "length" | "context_limit" | "budget_exceeded" | "usage_unavailable";
      budget?: AgentBudgetSnapshot;
      message?: Extract<AgentMessage, { role: "assistant" }>;
      finishReason?: FinishReason;
      usage?: TokenUsage;
      responseId?: string;
      context?: { estimatedTokens: number; maxContextTokens: number };
      runState?: AgentRunState;
    }
  | { type: "agent.failed"; runId: string; stopReason: "error"; error: Error; usage?: TokenUsage };

export interface AgentHooks {
  beforeModel?: (context: {
    runId: string;
    turn: number;
    messages: readonly AgentMessage[];
    tools: readonly ToolDefinition[];
    maxOutputTokens?: number;
    signal?: AbortSignal;
  }) => void | Promise<void>;
  beforeTool?: (context: {
    runId: string;
    turn: number;
    toolCall: AgentToolCall;
    signal?: AbortSignal;
  }) => void | Promise<void>;
}

export interface AgentOptions {
  model: LanguageModel;
  hooks?: AgentHooks;
  instructions?: string;
  tools?: readonly AnyAgentTool[];
  outputSchema?: z.ZodObject;
  outputToolName?: string;
  approveTool?: ToolApprovalHandler;
  approvalMode?: "callback" | "pause";
  maxOutputTokens?: number;
  maxTurns?: number;
  maxContextTokens?: number;
  estimateContextTokens?: ContextTokenEstimator;
  sessionStore?: SessionStore;
}

export interface AgentRunInput {
  budget?: AgentBudgetOptions;
  messages: readonly AgentMessage[];
  sessionId?: string;
  signal?: AbortSignal;
}

interface ToolExecutionOutcome {
  toolCall: AgentToolCall;
  result: JsonValue;
  error?: Error;
  attempts?: number;
}

interface ToolExecutionPlan {
  index: number;
  toolCall: AgentToolCall;
  tool: AnyAgentTool;
  input: unknown;
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || (error instanceof Error && error.name === "AbortError");
}

function failedOutcome(toolCall: AgentToolCall, error: unknown): ToolExecutionOutcome {
  const normalizedError = toError(error);
  return {
    toolCall,
    result: { name: normalizedError.name, error: normalizedError.message },
    error: normalizedError,
  };
}

function abortableDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new DOMException("The run was cancelled.", "AbortError"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("The run was cancelled.", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function requiresApproval(tool: AnyAgentTool): boolean {
  if (tool.requiresApproval !== undefined) return tool.requiresApproval;
  return tool.annotations?.readOnly !== true || tool.annotations.destructive === true;
}

function canRunConcurrently(tool: AnyAgentTool): boolean {
  return tool.annotations?.readOnly === true && tool.annotations.destructive !== true;
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

export class Agent {
  private readonly toolsByName = new Map<string, AnyAgentTool>();
  private readonly maxTurns: number;
  private readonly outputToolName?: string;
  private readonly outputDefinition?: ToolDefinition;
  private readonly outputParser?: (input: JsonObject) => unknown;

  constructor(private readonly options: AgentOptions) {
    this.maxTurns = options.maxTurns ?? 10;
    if (!Number.isSafeInteger(this.maxTurns) || this.maxTurns < 1) {
      throw new RangeError("maxTurns must be a positive integer.");
    }
    if (options.maxContextTokens !== undefined &&
      (!Number.isSafeInteger(options.maxContextTokens) || options.maxContextTokens < 1)) {
      throw new RangeError("maxContextTokens must be a positive safe integer.");
    }
    if (options.outputSchema) {
      this.outputToolName = options.outputToolName ?? "final_answer";
      if (this.outputToolName.length === 0) throw new TypeError("outputToolName must be a non-empty string.");
      this.outputDefinition = {
        name: this.outputToolName,
        description: "Submit the final answer. Use this tool only when the task is complete and all other tool calls have finished.",
        inputSchema: z.toJSONSchema(options.outputSchema, { io: "input" }) as JsonSchema,
      };
      this.outputParser = (input) => options.outputSchema!.parse(input);
    } else if (options.outputToolName !== undefined) {
      throw new TypeError("outputToolName requires outputSchema.");
    }

    for (const tool of options.tools ?? []) {
      if (this.toolsByName.has(tool.name)) {
        throw new Error(`Tool names must be unique. Duplicate name: ${tool.name}.`);
      }
      this.toolsByName.set(tool.name, tool);
    }
    if (this.outputToolName !== undefined && this.toolsByName.has(this.outputToolName)) {
      throw new Error(`Tool name "${this.outputToolName}" is reserved for structured output.`);
    }
    if (this.outputToolName !== undefined) {
      this.toolsByName.set(this.outputToolName, {
        ...this.outputDefinition!,
        annotations: { readOnly: true },
        requiresApproval: false,
        parseInput: (toolInput) => this.outputParser!(toolInput),
        execute: (parsedInput) => parsedInput,
      });
    }
  }

  async *stream(input: AgentRunInput): AsyncGenerator<AgentEvent> {
    yield* this.executeRun(input);
  }

  async *resume(input: AgentResumeInput): AsyncGenerator<AgentEvent> {
    if (!input || typeof input !== "object" || !input.state || typeof input.state !== "object") {
      yield {
        type: "agent.failed",
        runId: crypto.randomUUID(),
        stopReason: "error",
        error: new TypeError("A valid Agent run state is required to resume a run."),
      };
      return;
    }

    yield* this.executeRun(
      {
        messages: [],
        ...(input.state.sessionId !== undefined ? { sessionId: input.state.sessionId } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      },
      input.state,
      input.approval,
    );
  }

  private async *executeRun(
    input: AgentRunInput,
    restoredState?: AgentRunState,
    approval?: AgentResumeInput["approval"],
  ): AsyncGenerator<AgentEvent> {
    const runId = restoredState?.runId ?? crypto.randomUUID();
    const inputMessages = restoredState ? [] : [...input.messages];
    const sessionMessagesToAppend: AgentMessage[] = restoredState ? [] : [...inputMessages];
    const messages: AgentMessage[] = [];
    let sessionHistory: AgentMessage[] = [];
    const sessionId = restoredState?.sessionId ?? input.sessionId;
    const sessionStore = this.options.sessionStore;
    const tools = this.toolDefinitions();
    const approvalDecisions: AgentRunState["approvalDecisions"][number][] = [];

    yield restoredState
      ? { type: "agent.resumed", runId, provider: this.options.model.provider }
      : { type: "agent.started", runId, provider: this.options.model.provider };

    let totalUsage: TokenUsage | undefined = restoredState?.usage;
    let currentBudget: AgentBudget | undefined;

    try {
      const inheritedBudget = getBudgetContext(input);
      const budget = inheritedBudget ?? (restoredState
        ? restoredState.budget
          ? new AgentBudget({ maxModelCalls: restoredState.budget.maxModelCalls, maxTotalTokens: restoredState.budget.maxTotalTokens }, restoredState.budget)
          : new AgentBudget({}, { modelCalls: 0, requestsWithUsage: 0, usage: {}, usageComplete: false })
        : new AgentBudget(input.budget));
      currentBudget = budget;
      if (restoredState) {
        this.validateRunState(restoredState);
        messages.push(...restoredState.messages);
        sessionMessagesToAppend.push(...restoredState.messagesToAppend);
        sessionHistory.push(...restoredState.sessionHistory);

        if (sessionId !== undefined) {
          assertSessionId(sessionId);
          if (!sessionStore) throw new Error("A sessionStore must be configured when resuming this run.");
          const currentHistory = await sessionStore.load(sessionId);
          if (!sameJsonValue(currentHistory, restoredState.sessionHistory)) {
            throw new Error("Session history changed while the Agent run was paused.");
          }
        }

        if (restoredState.turn > this.maxTurns) {
          const savedMessage = messages.at(-1);
          if (savedMessage?.role !== "assistant") {
            throw new Error("The saved Agent run state has no pending assistant tool call message.");
          }
          yield {
            type: "agent.stopped",
            runId,
            stopReason: "max_turns",
            message: savedMessage,
            finishReason: restoredState.finishReason,
            ...(totalUsage ? { usage: totalUsage } : {}),
            ...(restoredState.responseId ? { responseId: restoredState.responseId } : {}),
            runState: structuredClone(restoredState),
          };
          return;
        }

        approvalDecisions.push(...restoredState.approvalDecisions.map((entry) => ({ ...entry })));
        if (restoredState.pendingApproval) {
          if (!approval || approval.toolCallId !== restoredState.pendingApproval.toolCallId ||
            (approval.decision !== "approved" && approval.decision !== "rejected")) {
            throw new Error("A matching approval decision is required to resume this run.");
          }
          if (approvalDecisions.some((entry) => entry.toolCallId === approval.toolCallId)) {
            throw new Error("The pending tool call already has an approval decision.");
          }
          approvalDecisions.push({
            ...restoredState.pendingApproval,
            decision: approval.decision,
            resolved: false,
          });
        } else if (approval) {
          throw new Error("This run is not waiting for an approval decision.");
        }
      } else {
        if (sessionId !== undefined) {
          assertSessionId(sessionId);
          if (!sessionStore) throw new Error("A sessionStore must be configured when sessionId is provided.");
          sessionHistory = [...await sessionStore.load(sessionId)];
          messages.push(...sessionHistory);
        }
        messages.push(...inputMessages);
        if (this.options.instructions !== undefined) {
          messages.unshift({ role: "system", content: this.options.instructions });
        }
      }

      const contextManager = new ContextManager(
        this.options.maxContextTokens,
        this.options.estimateContextTokens,
        messages,
      );

      for (let turn = restoredState?.turn ?? 1; turn <= this.maxTurns; turn += 1) {
        yield { type: "agent.budget.updated", runId, budget: budget.snapshot() };
        if (input.signal?.aborted) {
          yield {
            type: "agent.stopped",
            runId,
            stopReason: "cancelled",
            ...(totalUsage ? { usage: totalUsage } : {}),
          };
          return;
        }

        const resumingTurn = restoredState !== undefined && turn === restoredState.turn;
        const turnApprovalDecisions = resumingTurn ? approvalDecisions : [];
        if (!resumingTurn) {
          const context = contextManager.prepare(messages, tools);
          if (context.removedTurnCount > 0) {
            yield {
              type: "agent.context.compacted",
              runId,
              turn,
              estimatedTokensBefore: context.estimatedTokensBefore!,
              estimatedTokensAfter: context.estimatedTokensAfter!,
              removedTurnCount: context.removedTurnCount,
            };
          }
          if (input.signal?.aborted) {
            yield {
              type: "agent.stopped",
              runId,
              stopReason: "cancelled",
              ...(totalUsage ? { usage: totalUsage } : {}),
            };
            return;
          }

          if (context.contextLimit) {
            yield {
              type: "agent.stopped",
              runId,
              stopReason: "context_limit",
              context: context.contextLimit,
              ...(totalUsage ? { usage: totalUsage } : {}),
            };
            return;
          }
        }

        let message: Extract<AgentMessage, { role: "assistant" }>;
        let finishReason: FinishReason;
        let responseId: string | undefined;
        let toolCalls: AgentToolCall[];

        if (resumingTurn) {
          const savedMessage = messages.at(-1);
          if (savedMessage?.role !== "assistant") {
            throw new Error("The saved Agent run state has no pending assistant tool call message.");
          }
          message = savedMessage;
          finishReason = restoredState.finishReason;
          responseId = restoredState.responseId;
          toolCalls = [...restoredState.pendingToolCalls];
        } else {
          const messageId = crypto.randomUUID();
          let content = "";
          finishReason = "other";
          toolCalls = [];

          if (this.options.hooks?.beforeModel) {
            await this.options.hooks.beforeModel({
              runId,
              turn,
              messages: structuredClone(messages),
              tools: structuredClone(tools ?? []),
              ...(this.options.maxOutputTokens !== undefined ? { maxOutputTokens: this.options.maxOutputTokens } : {}),
              ...(input.signal ? { signal: input.signal } : {}),
            });
            if (input.signal?.aborted) throw new DOMException("The run was cancelled.", "AbortError");
          }

          const budgetStop = budget.claim();
          if (budgetStop) {
            yield { type: "agent.stopped", runId, stopReason: budgetStop, budget: budget.snapshot(),
              ...(totalUsage ? { usage: totalUsage } : {}) };
            return;
          }
          let requestUsage: TokenUsage | undefined;
          let requestCompleted = false;
          try {
            yield { type: "turn.started", runId, turn };
            yield { type: "message.started", runId, turn, messageId, role: "assistant" };
            for await (const event of this.options.model.stream({
              messages,
              tools,
              maxOutputTokens: this.options.maxOutputTokens,
              signal: input.signal,
            })) {
              switch (event.type) {
                case "text.delta":
                  content += event.delta;
                  yield {
                    type: "message.delta",
                    runId,
                    turn,
                    messageId,
                    delta: { type: "text", text: event.delta },
                  };
                  break;
                case "reasoning.delta":
                  yield {
                    type: "message.delta",
                    runId,
                    turn,
                    messageId,
                    delta: { type: "reasoning", text: event.delta },
                  };
                  break;
                case "refusal.delta":
                  content += event.delta;
                  yield {
                    type: "message.delta",
                    runId,
                    turn,
                    messageId,
                    delta: { type: "refusal", text: event.delta },
                  };
                  break;
                case "tool.call.started":
                  yield { ...event, runId, turn };
                  break;
                case "tool.call.arguments.delta":
                  yield { ...event, runId, turn };
                  break;
                case "tool.call.completed":
                  toolCalls.push(event.toolCall);
                  yield { ...event, runId, turn };
                  break;
                case "usage":
                  requestUsage = combineUsage(requestUsage, event.usage);
                  budget.record(event.usage);
                  totalUsage = combineUsage(totalUsage, event.usage);
                  yield { ...event, runId, turn };
                  break;
                case "finish":
                  finishReason = event.finishReason;
                  responseId = event.responseId;
                  break;
              }
            }
            requestCompleted = true;
          } finally {
            budget.finishRequest(requestUsage, requestCompleted);
          }
          yield { type: "agent.budget.updated", runId, budget: budget.snapshot() };
          message = {
            id: messageId,
            role: "assistant",
            content,
            ...(toolCalls.length > 0 ? { toolCalls } : {}),
          };
          messages.push(message);
          sessionMessagesToAppend.push(message);
          yield { type: "message.completed", runId, turn, message };
          yield { type: "turn.completed", runId, turn, finishReason };
        }

        if (input.signal?.aborted) {
          yield {
            type: "agent.stopped",
            runId,
            stopReason: "cancelled",
            message,
            finishReason,
            ...(totalUsage ? { usage: totalUsage } : {}),
            ...(responseId ? { responseId } : {}),
          };
          return;
        }

        if (finishReason === "length") {
          yield {
            type: "agent.stopped",
            runId,
            stopReason: "length",
            message,
            finishReason,
            ...(totalUsage ? { usage: totalUsage } : {}),
            ...(responseId ? { responseId } : {}),
          };
          return;
        }

        if (finishReason === "refusal") {
          if (sessionId !== undefined && sessionStore) {
            await sessionStore.append(sessionId, sessionMessagesToAppend);
          }
          yield {
            type: "agent.completed",
            runId,
            stopReason: "refusal",
            message,
            finishReason,
            ...(totalUsage ? { usage: totalUsage } : {}),
            ...(responseId ? { responseId } : {}),
          };
          return;
        }

        if (toolCalls.length === 0) {
          if (this.outputToolName !== undefined) {
            if (turn === this.maxTurns) {
              yield {
                type: "agent.stopped",
                runId,
                stopReason: "max_turns",
                message,
                finishReason,
                ...(totalUsage ? { usage: totalUsage } : {}),
                ...(responseId ? { responseId } : {}),
              };
              return;
            }
            messages.push({
              role: "developer",
              content: `Submit the final answer by calling the "${this.outputToolName}" tool with input that matches its schema. Do not answer in plain text.`,
            });
            continue;
          }

          if (sessionId !== undefined && sessionStore) {
            await sessionStore.append(sessionId, sessionMessagesToAppend);
          }
          yield {
            type: "agent.completed",
            runId,
            stopReason: "completed",
            message,
            finishReason,
            ...(totalUsage ? { usage: totalUsage } : {}),
            ...(responseId ? { responseId } : {}),
          };
          return;
        }

        if (turn === this.maxTurns) {
          const runState = this.createRunState({
            budget: budget.checkpoint(),
            runId,
            sessionId,
            sessionHistory,
            messages,
            messagesToAppend: sessionMessagesToAppend,
            turn,
            pendingToolCalls: toolCalls,
            finishReason,
            responseId,
            usage: totalUsage,
            approvalDecisions: turnApprovalDecisions,
          });
          yield {
            type: "agent.stopped",
            runId,
            stopReason: "max_turns",
            message,
            finishReason,
            ...(totalUsage ? { usage: totalUsage } : {}),
            ...(responseId ? { responseId } : {}),
            runState,
          };
          return;
        }

        const outcomes = new Array<ToolExecutionOutcome>(toolCalls.length);
        const plans: ToolExecutionPlan[] = [];

        for (const [index, toolCall] of toolCalls.entries()) {
          const tool = this.toolsByName.get(toolCall.name);
          if (!tool) {
            const outcome = failedOutcome(toolCall, new Error(`Tool "${toolCall.name}" is not available.`));
            outcomes[index] = outcome;
            yield this.executionEvent(runId, turn, outcome);
            continue;
          }

          if (toolCall.name === this.outputToolName && toolCalls.length > 1) {
            const outcome = failedOutcome(
              toolCall,
              new Error(`The "${this.outputToolName}" tool must be the only tool call in a turn.`),
            );
            outcomes[index] = outcome;
            yield this.executionEvent(runId, turn, outcome);
            continue;
          }

          let parsedInput: unknown;
          try {
            parsedInput = tool.parseInput(toolCall.input);
          } catch (error) {
            const outcome = failedOutcome(toolCall, error);
            outcomes[index] = outcome;
            yield this.executionEvent(runId, turn, outcome);
            continue;
          }

          if (requiresApproval(tool)) {
            const savedDecision = turnApprovalDecisions.find((entry) => entry.toolCallId === toolCall.id);
            if (savedDecision) {
              if (!savedDecision.resolved) {
                yield {
                  type: "tool.approval.resolved",
                  runId,
                  turn,
                  approvalId: savedDecision.approvalId,
                  toolCallId: toolCall.id,
                  decision: savedDecision.decision,
                  ...(savedDecision.decision === "rejected" ? { reason: "rejected" as const } : {}),
                };
                savedDecision.resolved = true;
              }
              if (savedDecision.decision === "rejected") {
                outcomes[index] = failedOutcome(
                  toolCall,
                  new Error("Tool call was rejected by the approval handler."),
                );
                continue;
              }
            } else {
              const approvalId = crypto.randomUUID();
              const approvalTool = {
                name: tool.name,
                description: tool.description,
                ...(tool.annotations ? { annotations: tool.annotations } : {}),
              };
              const request = {
                approvalId,
                runId,
                turn,
                toolCall,
                input: parsedInput,
                tool: approvalTool,
                ...(input.signal ? { signal: input.signal } : {}),
              };

              yield {
                type: "tool.approval.requested",
                runId,
                turn,
                approvalId,
                toolCall,
                input: parsedInput,
                tool: approvalTool,
              };

              if (input.signal?.aborted) {
                yield {
                  type: "tool.approval.resolved",
                  runId,
                  turn,
                  approvalId,
                  toolCallId: toolCall.id,
                  decision: "rejected",
                  reason: "cancelled",
                };
                yield {
                  type: "agent.stopped",
                  runId,
                  stopReason: "cancelled",
                  message,
                  finishReason,
                  ...(totalUsage ? { usage: totalUsage } : {}),
                  ...(responseId ? { responseId } : {}),
                };
                return;
              }

              if (this.options.approvalMode === "pause") {
                const pendingApproval = { toolCallId: toolCall.id, approvalId };
                const runState = this.createRunState({
                  budget: budget.checkpoint(),
                  runId,
                  sessionId,
                  sessionHistory,
                  messages,
                  messagesToAppend: sessionMessagesToAppend,
                  turn,
                  pendingToolCalls: toolCalls,
                  finishReason,
                  responseId,
                  usage: totalUsage,
                  approvalDecisions: turnApprovalDecisions,
                  pendingApproval,
                });
                yield { type: "agent.paused", runId, turn, pendingToolCall: toolCall, runState };
                return;
              }

              if (!this.options.approveTool) {
                yield {
                  type: "tool.approval.resolved",
                  runId,
                  turn,
                  approvalId,
                  toolCallId: toolCall.id,
                  decision: "rejected",
                  reason: "no_handler",
                };
                outcomes[index] = failedOutcome(
                  toolCall,
                  new Error("Tool call requires approval, but no approval handler is configured."),
                );
                continue;
              }

              let approved: boolean;
              try {
                approved = await this.options.approveTool(request);
              } catch (error) {
                yield {
                  type: "tool.approval.resolved",
                  runId,
                  turn,
                  approvalId,
                  toolCallId: toolCall.id,
                  decision: "rejected",
                  reason: isAbortError(error, input.signal) ? "cancelled" : "handler_failed",
                };
                throw error;
              }

              yield {
                type: "tool.approval.resolved",
                runId,
                turn,
                approvalId,
                toolCallId: toolCall.id,
                decision: approved ? "approved" : "rejected",
                ...(!approved ? { reason: "rejected" as const } : {}),
              };

              if (!approved) {
                outcomes[index] = failedOutcome(
                  toolCall,
                  new Error("Tool call was rejected by the approval handler."),
                );
                continue;
              }
            }
          }

          plans.push({ index, toolCall, tool, input: parsedInput });
        }

        let planIndex = 0;
        while (planIndex < plans.length) {
          if (input.signal?.aborted) {
            yield {
              type: "agent.stopped",
              runId,
              stopReason: "cancelled",
              message,
              finishReason,
              ...(totalUsage ? { usage: totalUsage } : {}),
              ...(responseId ? { responseId } : {}),
            };
            return;
          }

          const plan = plans[planIndex]!;

          if (!canRunConcurrently(plan.tool)) {
            yield {
              type: "tool.execution.started",
              runId,
              turn,
              toolCallId: plan.toolCall.id,
              name: plan.toolCall.name,
            };
            if (input.signal?.aborted) {
              yield {
                type: "agent.stopped",
                runId,
                stopReason: "cancelled",
                message,
                finishReason,
                ...(totalUsage ? { usage: totalUsage } : {}),
                ...(responseId ? { responseId } : {}),
              };
              return;
            }
            const outcome = await this.executeTool(plan, runId, turn, budget, input.signal);
            outcomes[plan.index] = outcome;
            yield this.executionEvent(runId, turn, outcome);
            planIndex += 1;
            continue;
          }

          let batchEnd = planIndex;
          while (batchEnd < plans.length && canRunConcurrently(plans[batchEnd]!.tool)) {
            batchEnd += 1;
          }
          const batch = plans.slice(planIndex, batchEnd);
          for (const batchPlan of batch) {
            yield {
              type: "tool.execution.started",
              runId,
              turn,
              toolCallId: batchPlan.toolCall.id,
              name: batchPlan.toolCall.name,
            };
          }

          if (input.signal?.aborted) {
            yield {
              type: "agent.stopped",
              runId,
              stopReason: "cancelled",
              message,
              finishReason,
              ...(totalUsage ? { usage: totalUsage } : {}),
              ...(responseId ? { responseId } : {}),
            };
            return;
          }

          const executions = batch.map((batchPlan, batchIndex) =>
            this.executeTool(batchPlan, runId, turn, budget, input.signal).then((outcome) => ({
              batchIndex,
              plan: batchPlan,
              outcome,
            })),
          );
          const pending = new Set(executions.map((_, index) => index));
          while (pending.size > 0) {
            const { batchIndex, plan: completedPlan, outcome } = await Promise.race(
              [...pending].map((executionIndex) => executions[executionIndex]!),
            );
            pending.delete(batchIndex);
            outcomes[completedPlan.index] = outcome;
            yield this.executionEvent(runId, turn, outcome);
          }

          planIndex = batchEnd;
        }

        yield { type: "agent.budget.updated", runId, budget: budget.snapshot() };
        const toolInteractionMessages: AgentMessage[] = [message];
        for (let index = 0; index < toolCalls.length; index += 1) {
          const outcome = outcomes[index]!;
          const toolMessage: AgentMessage = {
            role: "tool",
            toolCallId: outcome.toolCall.id,
            content: outcome.result,
            ...(outcome.error ? { isError: true } : {}),
          };
          messages.push(toolMessage);
          sessionMessagesToAppend.push(toolMessage);
          toolInteractionMessages.push(toolMessage);
        }

        const outputOutcome = this.outputToolName !== undefined && toolCalls.length === 1 &&
          toolCalls[0]!.name === this.outputToolName ? outcomes[0]! : undefined;
        if (outputOutcome && !outputOutcome.error) {
          if (sessionId !== undefined && sessionStore) {
            await sessionStore.append(sessionId, sessionMessagesToAppend);
          }
          yield {
            type: "agent.completed",
            runId,
            stopReason: "completed",
            message,
            finishReason,
            structuredOutput: outputOutcome.result,
            ...(totalUsage ? { usage: totalUsage } : {}),
            ...(responseId ? { responseId } : {}),
          };
          return;
        }

        contextManager.addToolInteraction(toolInteractionMessages);
      }
    } catch (error) {
      if (currentBudget) yield { type: "agent.budget.updated", runId, budget: currentBudget.snapshot() };
      if (isAbortError(error, input.signal)) {
        yield {
          type: "agent.stopped",
          runId,
          stopReason: "cancelled",
          ...(totalUsage ? { usage: totalUsage } : {}),
        };
        return;
      }

      yield {
        type: "agent.failed",
        runId,
        stopReason: "error",
        error: toError(error),
        ...(totalUsage ? { usage: totalUsage } : {}),
      };
    }
  }

  private toolDefinitions(): ToolDefinition[] | undefined {
    const definitions: ToolDefinition[] = [
      ...(this.outputDefinition ? [this.outputDefinition] : []),
      ...(this.options.tools ?? []).map(({ name, description, inputSchema, strict }) => ({
        name,
        description,
        inputSchema,
        ...(strict !== undefined ? { strict } : {}),
      })),
    ];
    return definitions.length > 0 ? definitions : undefined;
  }

  private toolApprovalPolicies(): AgentRunState["toolApprovalPolicies"] {
    return [...this.toolsByName].map(([toolName, tool]) => ({
      toolName,
      requiresApproval: requiresApproval(tool),
    }));
  }

  private createRunState(input: {
    budget: AgentBudgetSnapshot;
    runId: string;
    sessionId?: string;
    sessionHistory: readonly AgentMessage[];
    messages: readonly AgentMessage[];
    messagesToAppend: readonly AgentMessage[];
    turn: number;
    pendingToolCalls: readonly AgentToolCall[];
    finishReason: FinishReason;
    responseId?: string;
    usage?: TokenUsage;
    approvalDecisions: readonly AgentRunState["approvalDecisions"][number][];
    pendingApproval?: AgentRunState["pendingApproval"];
  }): AgentRunState {
    return structuredClone({
      version: 1 as const,
      budget: input.budget,
      runId: input.runId,
      provider: this.options.model.provider,
      ...(this.options.instructions !== undefined ? { instructions: this.options.instructions } : {}),
      approvalMode: this.options.approvalMode ?? "callback",
      ...(this.options.maxContextTokens !== undefined ? { maxContextTokens: this.options.maxContextTokens } : {}),
      ...(this.options.maxOutputTokens !== undefined ? { maxOutputTokens: this.options.maxOutputTokens } : {}),
      usesCustomContextEstimator: this.options.estimateContextTokens !== undefined,
      toolDefinitions: this.toolDefinitions() ?? [],
      toolApprovalPolicies: this.toolApprovalPolicies(),
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
      sessionHistory: [...input.sessionHistory],
      messages: [...input.messages],
      messagesToAppend: [...input.messagesToAppend],
      turn: input.turn,
      pendingToolCalls: [...input.pendingToolCalls],
      finishReason: input.finishReason,
      ...(input.responseId !== undefined ? { responseId: input.responseId } : {}),
      ...(input.usage ? { usage: input.usage } : {}),
      approvalDecisions: input.approvalDecisions.map((entry) => ({ ...entry })),
      ...(input.pendingApproval ? { pendingApproval: input.pendingApproval } : {}),
    });
  }

  private validateRunState(state: AgentRunState): void {
    if (!state || typeof state !== "object" || state.version !== 1) {
      throw new TypeError("Unsupported or invalid Agent run state.");
    }
    if (typeof state.runId !== "string" || state.runId.length === 0 || state.provider !== this.options.model.provider) {
      throw new Error("Agent run state does not match this model provider.");
    }
    if (state.instructions !== this.options.instructions ||
      state.approvalMode !== (this.options.approvalMode ?? "callback") ||
      state.maxContextTokens !== this.options.maxContextTokens ||
      state.maxOutputTokens !== this.options.maxOutputTokens ||
      state.usesCustomContextEstimator !== (this.options.estimateContextTokens !== undefined)) {
      throw new Error("Agent run state does not match this Agent configuration.");
    }
    if (!sameJsonValue(state.toolDefinitions, this.toolDefinitions() ?? []) ||
      !sameJsonValue(state.toolApprovalPolicies, this.toolApprovalPolicies())) {
      throw new Error("Agent run state does not match the configured tools.");
    }
    if (!Number.isSafeInteger(state.turn) || state.turn < 1 || typeof state.finishReason !== "string" ||
      state.finishReason === "length" || state.finishReason === "refusal" ||
      !Array.isArray(state.sessionHistory) || !Array.isArray(state.messages) ||
      !Array.isArray(state.messagesToAppend) || !Array.isArray(state.pendingToolCalls) ||
      state.pendingToolCalls.length === 0 || !Array.isArray(state.approvalDecisions)) {
      throw new TypeError("Agent run state is missing required continuation data.");
    }
    if (state.sessionId !== undefined) assertSessionId(state.sessionId);
    if (state.sessionId === undefined && state.sessionHistory.length > 0) {
      throw new TypeError("Agent run state has session history without a session id.");
    }

    const lastMessage = state.messages.at(-1);
    if (lastMessage?.role !== "assistant" || !sameJsonValue(lastMessage.toolCalls, state.pendingToolCalls) ||
      !sameJsonValue(state.messagesToAppend.at(-1), lastMessage)) {
      throw new TypeError("Agent run state does not contain its pending assistant tool call message.");
    }

    const pendingToolCallIds = new Set(state.pendingToolCalls.map((toolCall) => toolCall.id));
    const decisionIds = new Set<string>();
    for (const entry of state.approvalDecisions) {
      if (typeof entry.toolCallId !== "string" || !pendingToolCallIds.has(entry.toolCallId) ||
        typeof entry.approvalId !== "string" || entry.approvalId.length === 0 ||
        (entry.decision !== "approved" && entry.decision !== "rejected") || typeof entry.resolved !== "boolean" ||
        decisionIds.has(entry.toolCallId)) {
        throw new TypeError("Agent run state contains an invalid approval decision.");
      }
      decisionIds.add(entry.toolCallId);
    }

    if (state.pendingApproval) {
      const toolCall = state.pendingToolCalls.find((entry) => entry.id === state.pendingApproval!.toolCallId);
      const tool = toolCall ? this.toolsByName.get(toolCall.name) : undefined;
      if (!tool || !requiresApproval(tool) || typeof state.pendingApproval.approvalId !== "string" ||
        state.pendingApproval.approvalId.length === 0 || decisionIds.has(state.pendingApproval.toolCallId)) {
        throw new TypeError("Agent run state contains an invalid pending approval.");
      }
    }
  }

  private executionEvent(runId: string, turn: number, outcome: ToolExecutionOutcome): AgentEvent {
    if (outcome.error) {
      return {
        type: "tool.execution.failed",
        runId,
        turn,
        toolCallId: outcome.toolCall.id,
        name: outcome.toolCall.name,
        error: outcome.error,
        ...(outcome.attempts !== undefined ? { attempts: outcome.attempts } : {}),
      };
    }

    return {
      type: "tool.execution.completed",
      runId,
      turn,
      toolCallId: outcome.toolCall.id,
      name: outcome.toolCall.name,
      result: outcome.result,
      ...(outcome.attempts !== undefined ? { attempts: outcome.attempts } : {}),
    };
  }

  private async executeTool(
    plan: ToolExecutionPlan,
    runId: string,
    turn: number,
    budget: AgentBudget,
    signal?: AbortSignal,
  ): Promise<ToolExecutionOutcome> {
    const context = {
      runId,
      turn,
      toolCallId: plan.toolCall.id,
      ...(signal ? { signal } : {}),
    };
    setBudgetContext(context, budget);
    try {
      if (this.options.hooks?.beforeTool) {
        await this.options.hooks.beforeTool({
          runId,
          turn,
          toolCall: structuredClone(plan.toolCall),
          ...(signal ? { signal } : {}),
        });
        if (signal?.aborted) throw new DOMException("The run was cancelled.", "AbortError");
      }

      const policy = plan.tool.retry;
      const maxAttempts = policy?.maxAttempts ?? 1;
      let attempt = 0;
      for (;;) {
        attempt += 1;
        try {
          const result = await plan.tool.execute(plan.input, context);
          return {
            toolCall: plan.toolCall,
            result: toJsonValue(result),
            ...(attempt > 1 ? { attempts: attempt } : {}),
          };
        } catch (error) {
          if (isAbortError(error, signal)) throw error;
          const retryable = attempt < maxAttempts && (policy!.shouldRetry
            ? await policy!.shouldRetry({ attempt, maxAttempts, error: toError(error) })
            : true);
          if (!retryable) {
            return { ...failedOutcome(plan.toolCall, error), ...(attempt > 1 ? { attempts: attempt } : {}) };
          }
          if (signal?.aborted) throw new DOMException("The run was cancelled.", "AbortError");
          if (policy?.delayMs) await abortableDelay(policy.delayMs, signal);
        }
      }
    } catch (error) {
      return failedOutcome(plan.toolCall, error);
    }
  }
}
