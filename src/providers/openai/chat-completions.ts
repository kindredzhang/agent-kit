import OpenAI from "openai";
import { parseJsonObject, stringifyJson } from "../../core/json";
import type {
  AgentMessage,
  AgentToolCall,
  LanguageModel,
  ModelRequest,
  ModelStreamEvent,
  ToolDefinition,
} from "../../core/types";
import { mapOpenAIFinishReason } from "./shared";

export interface OpenAIChatCompletionsModelOptions {
  client: OpenAI;
  model: string;
}

interface ToolCallAccumulator {
  id?: string;
  name: string;
  arguments: string;
  announced: boolean;
  emittedArguments: number;
}

function toChatMessage(message: AgentMessage) {
  switch (message.role) {
    case "system":
    case "developer":
    case "user":
      return { role: message.role, content: message.content };
    case "assistant":
      return {
        role: "assistant" as const,
        content: message.content || null,
        ...(message.toolCalls?.length
          ? {
              tool_calls: message.toolCalls.map((toolCall) => ({
                id: toolCall.id,
                type: "function" as const,
                function: {
                  name: toolCall.name,
                  arguments: JSON.stringify(toolCall.input),
                },
              })),
            }
          : {}),
      };
    case "tool":
      return {
        role: "tool" as const,
        tool_call_id: message.toolCallId,
        content: stringifyJson(message.content),
      };
  }
}

function toChatTool(tool: ToolDefinition) {
  return {
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
      ...(tool.strict !== undefined ? { strict: tool.strict } : {}),
    },
  };
}

export class OpenAIChatCompletionsModel implements LanguageModel {
  readonly provider = "openai-chat-completions" as const;

  constructor(private readonly options: OpenAIChatCompletionsModelOptions) {}

  async *stream(request: ModelRequest): AsyncGenerator<ModelStreamEvent> {
    const stream = await this.options.client.chat.completions.create(
      {
        model: this.options.model,
        messages: request.messages.map(toChatMessage),
        ...(request.tools?.length ? { tools: request.tools.map(toChatTool) } : {}),
        ...(request.maxOutputTokens !== undefined
          ? { max_completion_tokens: request.maxOutputTokens }
          : {}),
        stream: true,
        stream_options: { include_usage: true },
      },
      request.signal ? { signal: request.signal } : undefined,
    );

    const toolCalls = new Map<number, ToolCallAccumulator>();
    let finishReason = "other";
    let responseId: string | undefined;

    for await (const chunk of stream) {
      responseId ??= chunk.id;
      const choice = chunk.choices[0];

      if (choice) {
        if (choice.delta.content) {
          yield { type: "text.delta", delta: choice.delta.content };
        }

        if (choice.delta.refusal) {
          yield { type: "refusal.delta", delta: choice.delta.refusal };
        }

        for (const delta of choice.delta.tool_calls ?? []) {
          const current = toolCalls.get(delta.index) ?? {
            name: "",
            arguments: "",
            announced: false,
            emittedArguments: 0,
          };

          if (delta.id) current.id = delta.id;
          if (delta.function?.name) current.name += delta.function.name;

          const argumentDelta = delta.function?.arguments ?? "";
          if (argumentDelta) current.arguments += argumentDelta;

          if (!current.announced && current.id && current.name) {
            current.announced = true;
            yield {
              type: "tool.call.started",
              toolCallId: current.id,
              name: current.name,
            };
            if (current.arguments) {
              yield {
                type: "tool.call.arguments.delta",
                toolCallId: current.id,
                delta: current.arguments,
              };
              current.emittedArguments = current.arguments.length;
            }
          } else if (current.announced && argumentDelta) {
            yield {
              type: "tool.call.arguments.delta",
              toolCallId: current.id!,
              delta: argumentDelta,
            };
            current.emittedArguments += argumentDelta.length;
          }

          toolCalls.set(delta.index, current);
        }

        if (choice.finish_reason) finishReason = choice.finish_reason;
      }

      if (chunk.usage) {
        yield {
          type: "usage",
          usage: {
            inputTokens: chunk.usage.prompt_tokens,
            outputTokens: chunk.usage.completion_tokens,
            totalTokens: chunk.usage.total_tokens,
          },
        };
      }
    }

    for (const [index, current] of toolCalls) {
      const id = current.id ?? `call_${index}`;
      const name = current.name;

      if (!name) throw new Error(`OpenAI returned a tool call without a name at index ${index}.`);
      if (!current.announced) {
        yield { type: "tool.call.started", toolCallId: id, name };
      }

      const remainingArguments = current.arguments.slice(current.emittedArguments);
      if (remainingArguments) {
        yield {
          type: "tool.call.arguments.delta",
          toolCallId: id,
          delta: remainingArguments,
        };
      }

      const toolCall: AgentToolCall = {
        id,
        name,
        input: parseJsonObject(current.arguments),
      };
      yield { type: "tool.call.completed", toolCall };
    }

    yield {
      type: "finish",
      finishReason: mapOpenAIFinishReason(finishReason),
      ...(responseId ? { responseId } : {}),
    };
  }
}
