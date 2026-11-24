import Anthropic from "@anthropic-ai/sdk";
import { parseJsonObject, stringifyJson } from "../../core/json";
import type {
  AgentMessage,
  AgentToolCall,
  FinishReason,
  LanguageModel,
  ModelRequest,
  ModelStreamEvent,
  ToolDefinition,
} from "../../core/types";

export interface AnthropicMessagesModelOptions {
  client: Anthropic;
  model: string;
  maxOutputTokens?: number;
}

interface ToolBlockState {
  id: string;
  name: string;
  arguments: string;
  emittedArguments: number;
}

function toAnthropicMessages(messages: readonly AgentMessage[]): Anthropic.MessageParam[] {
  const converted: Anthropic.MessageParam[] = [];

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;

    switch (message.role) {
      case "system":
      case "developer":
        break;
      case "user":
        converted.push({ role: "user", content: message.content });
        break;
      case "assistant": {
        const content = [];
        if (message.content) content.push({ type: "text" as const, text: message.content });
        for (const toolCall of message.toolCalls ?? []) {
          content.push({
            type: "tool_use" as const,
            id: toolCall.id,
            name: toolCall.name,
            input: toolCall.input,
          });
        }
        converted.push({ role: "assistant", content });
        break;
      }
      case "tool": {
        const content: {
          type: "tool_result";
          tool_use_id: string;
          content: string;
          is_error?: boolean;
        }[] = [];

        while (index < messages.length) {
          const toolMessage = messages[index]!;
          if (toolMessage.role !== "tool") break;
          content.push({
            type: "tool_result",
            tool_use_id: toolMessage.toolCallId,
            content: stringifyJson(toolMessage.content),
            ...(toolMessage.isError ? { is_error: true } : {}),
          });
          index += 1;
        }
        index -= 1;
        converted.push({ role: "user", content });
        break;
      }
    }
  }

  return converted;
}

function toAnthropicTool(tool: ToolDefinition) {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
    ...(tool.strict !== undefined ? { strict: tool.strict } : {}),
  };
}

function mapAnthropicFinishReason(reason: string | null): FinishReason {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "tool_use":
      return "tool_calls";
    case "max_tokens":
      return "length";
    case "refusal":
      return "refusal";
    default:
      return "other";
  }
}

export class AnthropicMessagesModel implements LanguageModel {
  readonly provider = "anthropic-messages" as const;

  constructor(private readonly options: AnthropicMessagesModelOptions) {}

  async *stream(request: ModelRequest): AsyncGenerator<ModelStreamEvent> {
    const system = request.messages.flatMap((message) =>
      message.role === "system" || message.role === "developer" ? [message.content] : [],
    ).join("\n\n");
    const stream = this.options.client.messages.stream(
      {
        model: this.options.model,
        max_tokens:
          request.maxOutputTokens ?? this.options.maxOutputTokens ?? 4096,
        messages: toAnthropicMessages(request.messages),
        ...(system ? { system } : {}),
        ...(request.tools?.length ? { tools: request.tools.map(toAnthropicTool) } : {}),
      },
      request.signal ? { signal: request.signal } : undefined,
    );

    const toolBlocks = new Map<number, ToolBlockState>();
    let responseId: string | undefined;

    for await (const event of stream) {
      switch (event.type) {
        case "message_start":
          responseId = event.message.id;
          break;
        case "content_block_start":
          if (event.content_block.type === "tool_use") {
            const state: ToolBlockState = {
              id: event.content_block.id,
              name: event.content_block.name,
              arguments: "",
              emittedArguments: 0,
            };
            toolBlocks.set(event.index, state);
            yield {
              type: "tool.call.started",
              toolCallId: state.id,
              name: state.name,
            };
          }
          break;
        case "content_block_delta":
          if (event.delta.type === "text_delta") {
            yield { type: "text.delta", delta: event.delta.text };
          } else if (event.delta.type === "thinking_delta") {
            yield { type: "reasoning.delta", delta: event.delta.thinking };
          } else if (event.delta.type === "input_json_delta") {
            const state = toolBlocks.get(event.index);
            if (state) {
              state.arguments += event.delta.partial_json;
              yield {
                type: "tool.call.arguments.delta",
                toolCallId: state.id,
                delta: event.delta.partial_json,
              };
            }
          }
          break;
      }
    }

    const message = await stream.finalMessage();
    responseId = message.id;

    for (const [index, block] of message.content.entries()) {
      if (block.type !== "tool_use") continue;

      const state = toolBlocks.get(index);
      const inputSource = state?.arguments || JSON.stringify(block.input) || "{}";
      const toolCall: AgentToolCall = {
        id: block.id,
        name: block.name,
        input: parseJsonObject(inputSource),
      };
      yield { type: "tool.call.completed", toolCall };
    }

    yield {
      type: "usage",
      usage: {
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
        totalTokens: message.usage.input_tokens + message.usage.output_tokens,
      },
    };
    yield {
      type: "finish",
      finishReason: mapAnthropicFinishReason(message.stop_reason),
      ...(responseId ? { responseId } : {}),
    };
  }
}
