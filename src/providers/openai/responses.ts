import type OpenAI from "openai";
import { parseJsonObject, stringifyJson } from "../../core/json.js";
import type {
  AgentMessage,
  AgentToolCall,
  FinishReason,
  LanguageModel,
  ModelRequest,
  ModelStreamEvent,
  ToolDefinition,
} from "../../core/types.js";

export interface OpenAIResponsesModelOptions {
  client: OpenAI;
  model: string;
}

interface FunctionCallState {
  id: string;
  name: string;
  arguments: string;
  announced: boolean;
  emittedArguments: number;
}

function toResponsesInput(messages: readonly AgentMessage[]): OpenAI.Responses.ResponseInput {
  return messages.flatMap((message): OpenAI.Responses.ResponseInputItem[] => {
    switch (message.role) {
      case "system":
      case "developer":
      case "user":
        return [{ role: message.role, content: message.content }];
      case "assistant":
        return [
          ...(message.content ? [{ role: "assistant" as const, content: message.content }] : []),
          ...(message.toolCalls ?? []).map((toolCall) => ({
            type: "function_call" as const,
            call_id: toolCall.id,
            name: toolCall.name,
            arguments: JSON.stringify(toolCall.input),
          })),
        ];
      case "tool":
        return [
          {
            type: "function_call_output" as const,
            call_id: message.toolCallId,
            output: stringifyJson(message.content),
          },
        ];
    }
  });
}

function toResponsesTool(tool: ToolDefinition) {
  return {
    type: "function" as const,
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
    strict: tool.strict ?? false,
  };
}

export class OpenAIResponsesModel implements LanguageModel {
  readonly provider = "openai-responses" as const;

  constructor(private readonly options: OpenAIResponsesModelOptions) {}

  async *stream(request: ModelRequest): AsyncGenerator<ModelStreamEvent> {
    const stream = await this.options.client.responses.create(
      {
        model: this.options.model,
        input: toResponsesInput(request.messages),
        ...(request.tools?.length ? { tools: request.tools.map(toResponsesTool) } : {}),
        ...(request.maxOutputTokens !== undefined
          ? { max_output_tokens: request.maxOutputTokens }
          : {}),
        stream: true,
      },
      request.signal ? { signal: request.signal } : undefined,
    );

    const callsByItemId = new Map<string, FunctionCallState>();
    let finishReason: FinishReason = "other";
    let responseIncomplete = false;
    let responseId: string | undefined;

    for await (const event of stream) {
      switch (event.type) {
        case "response.created":
          responseId = event.response.id;
          break;
        case "response.output_text.delta":
          yield { type: "text.delta", delta: event.delta };
          break;
        case "response.reasoning_summary_text.delta":
          yield { type: "reasoning.delta", delta: event.delta };
          break;
        case "response.refusal.delta":
          yield { type: "refusal.delta", delta: event.delta };
          break;
        case "response.output_item.added":
          if (event.item.type === "function_call") {
            const itemId = event.item.id ?? event.item.call_id ?? `item_${event.output_index}`;
            const callId = event.item.call_id ?? event.item.id ?? `call_${event.output_index}`;
            const argumentsText = event.item.arguments ?? "";
            const state: FunctionCallState = {
              id: callId,
              name: event.item.name,
              arguments: argumentsText,
              announced: true,
              emittedArguments: argumentsText.length,
            };
            callsByItemId.set(itemId, state);
            yield {
              type: "tool.call.started",
              toolCallId: state.id,
              name: state.name,
            };
            if (argumentsText) {
              yield {
                type: "tool.call.arguments.delta",
                toolCallId: state.id,
                delta: argumentsText,
              };
            }
          }
          break;
        case "response.function_call_arguments.delta": {
          const state = callsByItemId.get(event.item_id);
          if (state) {
            state.arguments += event.delta;
            state.emittedArguments += event.delta.length;
            yield {
              type: "tool.call.arguments.delta",
              toolCallId: state.id,
              delta: event.delta,
            };
          }
          break;
        }
        case "response.output_item.done":
          if (event.item.type === "function_call") {
            const itemId = event.item.id ?? event.item.call_id ?? `item_${event.output_index}`;
            const callId = event.item.call_id ?? event.item.id ?? `call_${event.output_index}`;
            const state = callsByItemId.get(itemId) ?? {
              id: callId,
              name: event.item.name,
              arguments: "",
              announced: false,
              emittedArguments: 0,
            };
            const finalArguments = event.item.arguments ?? state.arguments;
            if (!finalArguments.startsWith(state.arguments)) state.emittedArguments = 0;
            state.arguments = finalArguments;
            callsByItemId.set(itemId, state);

            if (!state.announced) {
              state.announced = true;
              yield {
                type: "tool.call.started",
                toolCallId: state.id,
                name: state.name,
              };
            }

            const remainingArguments = state.arguments.slice(state.emittedArguments);
            if (remainingArguments) {
              yield {
                type: "tool.call.arguments.delta",
                toolCallId: state.id,
                delta: remainingArguments,
              };
              state.emittedArguments = state.arguments.length;
            }

            const toolCall: AgentToolCall = {
              id: state.id,
              name: state.name,
              input: parseJsonObject(state.arguments),
            };
            yield { type: "tool.call.completed", toolCall };
          }
          break;
        case "response.completed":
          responseId = event.response.id;
          finishReason = "stop";
          if (event.response.usage) {
            yield {
              type: "usage",
              usage: {
                inputTokens: event.response.usage.input_tokens,
                outputTokens: event.response.usage.output_tokens,
                totalTokens: event.response.usage.total_tokens,
              },
            };
          }
          break;
        case "response.incomplete":
          responseId = event.response.id;
          responseIncomplete = true;
          finishReason = "length";
          if (event.response.usage) {
            yield {
              type: "usage",
              usage: {
                inputTokens: event.response.usage.input_tokens,
                outputTokens: event.response.usage.output_tokens,
                totalTokens: event.response.usage.total_tokens,
              },
            };
          }
          break;
        case "response.failed":
          throw new Error(event.response.error?.message ?? "OpenAI Responses request failed.");
        case "error":
          throw new Error(event.message);
      }
    }

    if (!responseIncomplete && [...callsByItemId.values()].some((call) => call.name)) {
      finishReason = "tool_calls";
    }

    yield {
      type: "finish",
      finishReason,
      ...(responseId ? { responseId } : {}),
    };
  }
}
