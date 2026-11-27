import type { AgentToolCall, LanguageModel, ModelProvider, ModelRequest, ModelStreamEvent, TokenUsage } from "./core/types.js";

export interface FakeToolCall {
  name: string;
  input: Record<string, unknown>;
  id?: string;
}

export interface FakeTurn {
  text?: string;
  reasoning?: string;
  refusal?: string;
  toolCalls?: readonly FakeToolCall[];
  usage?: TokenUsage;
  finishReason?: "stop" | "tool_calls" | "length" | "refusal" | "other";
  responseId?: string;
  error?: Error;
  hang?: boolean;
}

export interface FakeModelOptions {
  turns?: readonly FakeTurn[];
  onRequest?: (request: ModelRequest, turnIndex: number) => FakeTurn | void;
  provider?: ModelProvider;
  chunkSize?: number;
}

export interface FakeModel extends LanguageModel {
  readonly requests: readonly ModelRequest[];
}

const defaultProvider: ModelProvider = "openai-chat-completions";

export function createFakeModel(options: FakeModelOptions): FakeModel {
  const turns = options.turns;
  if (turns !== undefined && turns.length === 0) {
    throw new RangeError("createFakeModel requires at least one scripted turn.");
  }
  if (turns === undefined && options.onRequest === undefined) {
    throw new TypeError("createFakeModel requires either turns or onRequest.");
  }

  const chunkSize = options.chunkSize ?? 4;
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1) {
    throw new RangeError("chunkSize must be a positive integer.");
  }

  const requests: ModelRequest[] = [];
  let turnIndex = 0;

  return {
    provider: options.provider ?? defaultProvider,
    requests,
    async *stream(request: ModelRequest): AsyncGenerator<ModelStreamEvent> {
      const index = turnIndex;
      turnIndex += 1;
      requests.push({ ...request, messages: [...request.messages] });

      const dynamic = options.onRequest?.(request, index);
      const turn = dynamic ?? turns?.[index];
      if (turn === undefined) {
        throw new Error(`The fake model has no scripted turn for request ${index + 1}.`);
      }

      if (turn.error) throw turn.error;

      if (turn.hang) {
        await new Promise((_resolve, reject) => {
          const signal = request.signal;
          if (!signal) return;
          if (signal.aborted) {
            reject(new DOMException("The run was cancelled.", "AbortError"));
            return;
          }
          signal.addEventListener("abort", () => reject(new DOMException("The run was cancelled.", "AbortError")), { once: true });
        });
        return;
      }

      for (const delta of chunks(turn.reasoning, chunkSize)) {
        yield { type: "reasoning.delta", delta };
      }
      for (const delta of chunks(turn.refusal, chunkSize)) {
        yield { type: "refusal.delta", delta };
      }
      for (const delta of chunks(turn.text, chunkSize)) {
        yield { type: "text.delta", delta };
      }

      const toolCalls: AgentToolCall[] = (turn.toolCalls ?? []).map((toolCall, position) => ({
        id: toolCall.id ?? `fake-call-${index + 1}-${position + 1}`,
        name: toolCall.name,
        input: toolCall.input as AgentToolCall["input"],
      }));
      for (const toolCall of toolCalls) {
        yield { type: "tool.call.completed", toolCall };
      }

      if (turn.usage) yield { type: "usage", usage: turn.usage };

      const finishReason = turn.finishReason ?? (toolCalls.length > 0 ? "tool_calls" : "stop");
      yield {
        type: "finish",
        finishReason,
        ...(turn.responseId !== undefined ? { responseId: turn.responseId } : {}),
      };
    },
  };
}

function chunks(text: string | undefined, size: number): string[] {
  if (text === undefined || text.length === 0) return [];
  const parts: string[] = [];
  for (let offset = 0; offset < text.length; offset += size) {
    parts.push(text.slice(offset, offset + size));
  }
  return parts;
}
