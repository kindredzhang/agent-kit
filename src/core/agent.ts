import { ContextManager } from "./context";
import type { ContextTokenEstimator } from "./context";
import { assertSessionId } from "./session";
import type { SessionStore } from "./session";
import { toJsonValue } from "./json";
import type { AnyAgentTool, ToolAnnotations, ToolApprovalHandler } from "./tools";
import type {
  AgentMessage,
  AgentToolCall,
  FinishReason,
  JsonValue,
  LanguageModel,
  ModelProvider,
  TokenUsage,
} from "./types";

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
  | "error";

export type AgentEvent =
  | { type: "agent.started"; runId: string; provider: ModelProvider }
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
  | { type: "tool.execution.completed"; runId: string; turn: number; toolCallId: string; name: string; result: JsonValue }
  | { type: "tool.execution.failed"; runId: string; turn: number; toolCallId: string; name: string; error: Error }
  | { type: "usage"; runId: string; turn: number; usage: TokenUsage }
  | { type: "message.completed"; runId: string; turn: number; message: Extract<AgentMessage, { role: "assistant" }> }
  | { type: "turn.completed"; runId: string; turn: number; finishReason: FinishReason }
  | {
      type: "agent.completed";
      runId: string;
      stopReason: "completed" | "refusal";
      message: Extract<AgentMessage, { role: "assistant" }>;
      finishReason: FinishReason;
      usage?: TokenUsage;
      responseId?: string;
    }
  | {
      type: "agent.stopped";
      runId: string;
      stopReason: "max_turns" | "cancelled" | "length" | "context_limit";
      message?: Extract<AgentMessage, { role: "assistant" }>;
      finishReason?: FinishReason;
      usage?: TokenUsage;
      responseId?: string;
      context?: { estimatedTokens: number; maxContextTokens: number };
    }
  | { type: "agent.failed"; runId: string; stopReason: "error"; error: Error; usage?: TokenUsage };

export interface AgentOptions {
  model: LanguageModel;
  instructions?: string;
  tools?: readonly AnyAgentTool[];
  approveTool?: ToolApprovalHandler;
  maxOutputTokens?: number;
  maxTurns?: number;
  maxContextTokens?: number;
  estimateContextTokens?: ContextTokenEstimator;
  sessionStore?: SessionStore;
}

export interface AgentRunInput {
  messages: readonly AgentMessage[];
  sessionId?: string;
  signal?: AbortSignal;
}

interface ToolExecutionOutcome {
  toolCall: AgentToolCall;
  result: JsonValue;
  error?: Error;
}

interface ToolExecutionPlan {
  index: number;
  toolCall: AgentToolCall;
  tool: AnyAgentTool;
  input: unknown;
}

function combineUsage(current: TokenUsage | undefined, next: TokenUsage): TokenUsage {
  const inputTokens = current?.inputTokens === undefined && next.inputTokens === undefined
    ? undefined
    : (current?.inputTokens ?? 0) + (next.inputTokens ?? 0);
  const outputTokens = current?.outputTokens === undefined && next.outputTokens === undefined
    ? undefined
    : (current?.outputTokens ?? 0) + (next.outputTokens ?? 0);
  const totalTokens = current?.totalTokens === undefined && next.totalTokens === undefined
    ? undefined
    : (current?.totalTokens ?? 0) + (next.totalTokens ?? 0);

  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
  };
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

function requiresApproval(tool: AnyAgentTool): boolean {
  if (tool.requiresApproval !== undefined) return tool.requiresApproval;
  return tool.annotations?.readOnly !== true || tool.annotations.destructive === true;
}

function canRunConcurrently(tool: AnyAgentTool): boolean {
  return tool.annotations?.readOnly === true && tool.annotations.destructive !== true;
}

export class Agent {
  private readonly toolsByName = new Map<string, AnyAgentTool>();
  private readonly maxTurns: number;

  constructor(private readonly options: AgentOptions) {
    this.maxTurns = options.maxTurns ?? 10;
    if (!Number.isSafeInteger(this.maxTurns) || this.maxTurns < 1) {
      throw new RangeError("maxTurns must be a positive integer.");
    }
    if (options.maxContextTokens !== undefined &&
      (!Number.isSafeInteger(options.maxContextTokens) || options.maxContextTokens < 1)) {
      throw new RangeError("maxContextTokens must be a positive safe integer.");
    }

    for (const tool of options.tools ?? []) {
      if (this.toolsByName.has(tool.name)) {
        throw new Error(`Tool names must be unique. Duplicate name: ${tool.name}.`);
      }
      this.toolsByName.set(tool.name, tool);
    }
  }

  async *stream(input: AgentRunInput): AsyncGenerator<AgentEvent> {
    const runId = crypto.randomUUID();
    const inputMessages = [...input.messages];
    const sessionMessagesToAppend = [...inputMessages];
    const messages: AgentMessage[] = [];
    const sessionStore = this.options.sessionStore;
    const tools = this.options.tools?.map(({ name, description, inputSchema, strict }) => ({
      name,
      description,
      inputSchema,
      ...(strict !== undefined ? { strict } : {}),
    }));

    yield {
      type: "agent.started",
      runId,
      provider: this.options.model.provider,
    };

    let totalUsage: TokenUsage | undefined;

    try {
      if (input.sessionId !== undefined) {
        assertSessionId(input.sessionId);
        if (!sessionStore) throw new Error("A sessionStore must be configured when sessionId is provided.");
        messages.push(...await sessionStore.load(input.sessionId));
      }
      messages.push(...inputMessages);
      if (this.options.instructions !== undefined) {
        messages.unshift({ role: "system", content: this.options.instructions });
      }

      const contextManager = new ContextManager(
        this.options.maxContextTokens,
        this.options.estimateContextTokens,
        messages,
      );

      for (let turn = 1; turn <= this.maxTurns; turn += 1) {
        if (input.signal?.aborted) {
          yield {
            type: "agent.stopped",
            runId,
            stopReason: "cancelled",
            ...(totalUsage ? { usage: totalUsage } : {}),
          };
          return;
        }

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

        const messageId = crypto.randomUUID();
        let content = "";
        let finishReason: FinishReason = "other";
        let responseId: string | undefined;
        const toolCalls: AgentToolCall[] = [];

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
              totalUsage = combineUsage(totalUsage, event.usage);
              yield { ...event, runId, turn };
              break;
            case "finish":
              finishReason = event.finishReason;
              responseId = event.responseId;
              break;
          }
        }

        const message: Extract<AgentMessage, { role: "assistant" }> = {
          id: messageId,
          role: "assistant",
          content,
          ...(toolCalls.length > 0 ? { toolCalls } : {}),
        };

        messages.push(message);
        sessionMessagesToAppend.push(message);
        yield { type: "message.completed", runId, turn, message };
        yield { type: "turn.completed", runId, turn, finishReason };

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

        if (finishReason === "refusal" || toolCalls.length === 0) {
          if (input.sessionId !== undefined && sessionStore) {
            await sessionStore.append(input.sessionId, sessionMessagesToAppend);
          }
          yield {
            type: "agent.completed",
            runId,
            stopReason: finishReason === "refusal" ? "refusal" : "completed",
            message,
            finishReason,
            ...(totalUsage ? { usage: totalUsage } : {}),
            ...(responseId ? { responseId } : {}),
          };
          return;
        }

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
            const outcome = await this.executeTool(plan, runId, turn, input.signal);
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
            this.executeTool(batchPlan, runId, turn, input.signal).then((outcome) => ({
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
        contextManager.addToolInteraction(toolInteractionMessages);
      }
    } catch (error) {
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

  private executionEvent(runId: string, turn: number, outcome: ToolExecutionOutcome): AgentEvent {
    if (outcome.error) {
      return {
        type: "tool.execution.failed",
        runId,
        turn,
        toolCallId: outcome.toolCall.id,
        name: outcome.toolCall.name,
        error: outcome.error,
      };
    }

    return {
      type: "tool.execution.completed",
      runId,
      turn,
      toolCallId: outcome.toolCall.id,
      name: outcome.toolCall.name,
      result: outcome.result,
    };
  }

  private async executeTool(
    plan: ToolExecutionPlan,
    runId: string,
    turn: number,
    signal?: AbortSignal,
  ): Promise<ToolExecutionOutcome> {
    try {
      const result = await plan.tool.execute(plan.input, {
        runId,
        turn,
        toolCallId: plan.toolCall.id,
        ...(signal ? { signal } : {}),
      });

      return { toolCall: plan.toolCall, result: toJsonValue(result) };
    } catch (error) {
      return failedOutcome(plan.toolCall, error);
    }
  }
}
