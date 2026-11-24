export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

export type ModelProvider =
  | "openai-chat-completions"
  | "openai-responses"
  | "anthropic-messages";

export type FinishReason = "stop" | "tool_calls" | "length" | "refusal" | "other";

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface AgentToolCall {
  id: string;
  name: string;
  input: JsonObject;
}

export interface JsonSchema {
  type: "object";
  [key: string]: unknown;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  strict?: boolean;
}

export type AgentMessage =
  | { id?: string; role: "system" | "developer" | "user"; content: string }
  | { id?: string; role: "assistant"; content: string; toolCalls?: AgentToolCall[] }
  | { id?: string; role: "tool"; toolCallId: string; content: JsonValue; isError?: boolean };

export interface ModelRequest {
  messages: readonly AgentMessage[];
  tools?: readonly ToolDefinition[];
  maxOutputTokens?: number;
  signal?: AbortSignal;
}

export type ModelStreamEvent =
  | { type: "text.delta"; delta: string }
  | { type: "reasoning.delta"; delta: string }
  | { type: "refusal.delta"; delta: string }
  | { type: "tool.call.started"; toolCallId: string; name: string }
  | { type: "tool.call.arguments.delta"; toolCallId: string; delta: string }
  | { type: "tool.call.completed"; toolCall: AgentToolCall }
  | { type: "usage"; usage: TokenUsage }
  | { type: "finish"; finishReason: FinishReason; responseId?: string };

export interface LanguageModel {
  readonly provider: ModelProvider;
  stream(request: ModelRequest): AsyncIterable<ModelStreamEvent>;
}
