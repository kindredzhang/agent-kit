import * as z from "zod";
import type { AgentToolCall, JsonObject, JsonSchema, ToolDefinition } from "./types";

export interface ToolExecutionContext {
  runId: string;
  turn: number;
  toolCallId: string;
  signal?: AbortSignal;
}

export interface ToolAnnotations {
  readOnly?: boolean;
  destructive?: boolean;
  idempotent?: boolean;
}

export interface ToolApprovalRequest {
  approvalId: string;
  runId: string;
  turn: number;
  toolCall: AgentToolCall;
  input: unknown;
  tool: {
    name: string;
    description: string;
    annotations?: ToolAnnotations;
  };
  signal?: AbortSignal;
}

export type ToolApprovalHandler = (request: ToolApprovalRequest) => boolean | Promise<boolean>;

export interface ToolRetryContext {
  attempt: number;
  maxAttempts: number;
  error: Error;
}

export interface ToolRetryPolicy {
  maxAttempts: number;
  delayMs?: number;
  shouldRetry?: (context: ToolRetryContext) => boolean | Promise<boolean>;
}

export interface AgentTool<TInput = unknown> extends ToolDefinition {
  annotations?: ToolAnnotations;
  requiresApproval?: boolean;
  retry?: ToolRetryPolicy;
  parseInput(input: JsonObject): TInput;
  execute(input: TInput, context: ToolExecutionContext): unknown | Promise<unknown>;
}

export type AnyAgentTool = AgentTool<any>;

function assertRetryPolicy(policy: ToolRetryPolicy): void {
  if (!Number.isSafeInteger(policy.maxAttempts) || policy.maxAttempts < 1 || policy.maxAttempts > 10) {
    throw new RangeError("retry.maxAttempts must be an integer between 1 and 10.");
  }
  if (policy.delayMs !== undefined && (!Number.isSafeInteger(policy.delayMs) || policy.delayMs < 0)) {
    throw new RangeError("retry.delayMs must be a non-negative safe integer.");
  }
  if (policy.shouldRetry !== undefined && typeof policy.shouldRetry !== "function") {
    throw new TypeError("retry.shouldRetry must be a function.");
  }
}

export function defineTool<TSchema extends z.ZodObject>(definition: {
  name: string;
  description: string;
  input: TSchema;
  strict?: boolean;
  annotations?: ToolAnnotations;
  requiresApproval?: boolean;
  retry?: ToolRetryPolicy;
  execute: (
    input: z.output<TSchema>,
    context: ToolExecutionContext,
  ) => unknown | Promise<unknown>;
}): AgentTool<z.output<TSchema>> {
  if (definition.retry) assertRetryPolicy(definition.retry);
  return {
    name: definition.name,
    description: definition.description,
    inputSchema: z.toJSONSchema(definition.input, { io: "input" }) as JsonSchema,
    ...(definition.strict !== undefined ? { strict: definition.strict } : {}),
    ...(definition.annotations ? { annotations: definition.annotations } : {}),
    ...(definition.requiresApproval !== undefined
      ? { requiresApproval: definition.requiresApproval }
      : {}),
    ...(definition.retry ? { retry: { ...definition.retry } } : {}),
    parseInput: (input) => definition.input.parse(input),
    execute: definition.execute,
  };
}
