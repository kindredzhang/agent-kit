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

export interface AgentTool<TInput = unknown> extends ToolDefinition {
  annotations?: ToolAnnotations;
  requiresApproval?: boolean;
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
  execute: (
    input: z.output<TSchema>,
    context: ToolExecutionContext,
  ) => unknown | Promise<unknown>;
}): AgentTool<z.output<TSchema>> {
  return {
    name: definition.name,
    description: definition.description,
    inputSchema: z.toJSONSchema(definition.input, { io: "input" }) as JsonSchema,
    ...(definition.strict !== undefined ? { strict: definition.strict } : {}),
    ...(definition.annotations ? { annotations: definition.annotations } : {}),
    ...(definition.requiresApproval !== undefined
      ? { requiresApproval: definition.requiresApproval }
      : {}),
    parseInput: (input) => definition.input.parse(input),
    execute: definition.execute,
  };
}
