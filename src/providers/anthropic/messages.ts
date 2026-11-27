import { createHash } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import { parseJsonObject, stringifyJson, toJsonValue } from "../../core/json.js";
import type {
  AgentContentPart,
  AgentMessage,
  AgentToolCall,
  FinishReason,
  LanguageModel,
  ModelRequest,
  ModelStreamEvent,
  ToolDefinition,
} from "../../core/types.js";

export interface AnthropicMessagesModelOptions {
  client: Anthropic;
  model: string;
  maxOutputTokens?: number;
  thinking?: Anthropic.MessageStreamParams["thinking"];
}

interface ToolBlockState {
  id: string;
  name: string;
  arguments: string;
  emittedArguments: number;
}

function toAnthropicContent(part: AgentContentPart): Anthropic.ContentBlockParam {
  switch (part.type) {
    case "text":
      return part;
    case "image": {
      const source = part.source;
      return {
        type: "image",
        source: source.type === "url" ? source : { type: "base64", media_type: source.mediaType, data: source.data },
      };
    }
    case "file":
      return {
        type: "document",
        title: part.filename,
        source: { type: "base64", media_type: part.mediaType, data: part.data },
      };
  }
}

function toAnthropicHistory(
  messages: readonly AgentMessage[],
  model: string,
  system: string,
  tools: readonly Anthropic.Tool[] | undefined,
) {
  const converted: Anthropic.MessageParam[] = [];
  const fingerprint = createHash("sha256").update(JSON.stringify([system, tools]));
  let lostToolThinking = false;
  const append = (message: Anthropic.MessageParam) => {
    converted.push(message);
    fingerprint.update(JSON.stringify(message));
  };

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;

    switch (message.role) {
      case "system":
      case "developer":
        break;
      case "user":
        lostToolThinking = false;
        append({
          role: "user",
          content: typeof message.content === "string" ? message.content : message.content.map(toAnthropicContent),
        });
        break;
      case "assistant": {
        const continuation = message.continuation;
        if (continuation?.provider === "anthropic-messages") {
          const data = continuation.data;
          if (continuation.model === model && data && typeof data === "object" && !Array.isArray(data) &&
            Array.isArray(data.content) && data.prefix === fingerprint.copy().digest("hex")) {
            append({ role: "assistant", content: data.content as unknown as Anthropic.ContentBlockParam[] });
            break;
          }
          lostToolThinking ||= Boolean(message.toolCalls?.length);
        }

        const content: Anthropic.ContentBlockParam[] = [];
        if (message.content) content.push({ type: "text", text: message.content });
        for (const toolCall of message.toolCalls ?? []) {
          content.push({
            type: "tool_use",
            id: toolCall.id,
            name: toolCall.name,
            input: toolCall.input,
          });
        }
        if (content.length > 0) append({ role: "assistant", content });
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
        append({ role: "user", content });
        break;
      }
    }
  }

  return { messages: converted, prefix: fingerprint.digest("hex"), lostToolThinking };
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
    const { client, model } = this.options;
    const tools = request.tools?.length ? request.tools.map(toAnthropicTool) : undefined;
    const { messages, prefix, lostToolThinking } = toAnthropicHistory(request.messages, model, system, tools);
    let thinking = this.options.thinking;
    if (lostToolThinking && thinking?.type === "enabled") thinking = { type: "disabled" };
    const stream = client.messages.stream(
      {
        model,
        max_tokens:
          request.maxOutputTokens ?? this.options.maxOutputTokens ?? 4096,
        messages,
        ...(system ? { system } : {}),
        ...(tools ? { tools } : {}),
        ...(thinking ? { thinking } : {}),
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
    const finishReason = mapAnthropicFinishReason(message.stop_reason);
    const hasThinking = message.content.some((block) => block.type === "thinking" || block.type === "redacted_thinking");
    yield {
      type: "finish",
      finishReason,
      ...(responseId ? { responseId } : {}),
      ...(hasThinking && finishReason !== "length" ? {
        continuation: { provider: this.provider, model, data: { prefix, content: toJsonValue(message.content) } },
      } : {}),
    };
  }
}
