import * as z from "zod";
import { assertRetryPolicy } from "./retry.js";
import type { RetryPolicy } from "./retry.js";
import type { AgentToolCall, JsonObject, JsonSchema, ToolDefinition } from "./types.js";

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

export type ToolRetryPolicy = RetryPolicy;

export interface AgentTool<TInput = unknown> extends ToolDefinition {
  annotations?: ToolAnnotations;
  requiresApproval?: boolean;
  retry?: ToolRetryPolicy;
  timeoutMs?: number;
  parseInput(input: JsonObject): TInput;
  execute(input: TInput, context: ToolExecutionContext): unknown | Promise<unknown>;
}

export type AnyAgentTool = AgentTool<any>;

export function defineTool<TSchema extends z.ZodObject>(definition: {
  name: string;
  description: string;
  input: TSchema;
  strict?: boolean;
  annotations?: ToolAnnotations;
  requiresApproval?: boolean;
  retry?: ToolRetryPolicy;
  timeoutMs?: number;
  execute: (
    input: z.output<TSchema>,
    context: ToolExecutionContext,
  ) => unknown | Promise<unknown>;
}): AgentTool<z.output<TSchema>> {
  if (definition.retry) assertRetryPolicy(definition.retry, "retry");
  if (definition.timeoutMs !== undefined &&
    (!Number.isSafeInteger(definition.timeoutMs) || definition.timeoutMs < 1)) {
    throw new RangeError("timeoutMs must be a positive integer.");
  }
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
    ...(definition.timeoutMs !== undefined ? { timeoutMs: definition.timeoutMs } : {}),
    parseInput: (input) => definition.input.parse(input),
    execute: definition.execute,
  };
}
