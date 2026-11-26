import type { AgentMessage, ModelRequest, ToolDefinition } from "./types.js";

export type ContextEstimateInput = Pick<ModelRequest, "messages" | "tools">;

export type ContextTokenEstimator = (request: ContextEstimateInput) => number;

export interface ContextPreparation {
  estimatedTokensBefore?: number;
  estimatedTokensAfter?: number;
  removedTurnCount: number;
  contextLimit?: { estimatedTokens: number; maxContextTokens: number };
}

function defaultEstimateContextTokens(request: ContextEstimateInput): number {
  const serialized = JSON.stringify({ messages: request.messages, tools: request.tools }) ?? "";
  let asciiCharacters = 0;
  let otherCharacters = 0;

  for (const character of serialized) {
    if (character.codePointAt(0)! <= 0x7f) {
      asciiCharacters += 1;
    } else {
      otherCharacters += 1;
    }
  }

  return Math.ceil(asciiCharacters / 4) + otherCharacters;
}

function createConversationTurns(messages: readonly AgentMessage[]): AgentMessage[][] {
  const userIndexes: number[] = [];

  for (const [index, message] of messages.entries()) {
    if (message.role === "user") userIndexes.push(index);
  }

  const turns: AgentMessage[][] = [];
  for (let turnIndex = 0; turnIndex < userIndexes.length - 1; turnIndex += 1) {
    const start = userIndexes[turnIndex]!;
    const end = userIndexes[turnIndex + 1]!;
    const turn = messages.slice(start, end).filter((message) =>
      message.role !== "system" && message.role !== "developer"
    );
    if (turn.length > 0) turns.push(turn);
  }

  return turns;
}

export class ContextManager {
  private readonly removableGroups: AgentMessage[][];
  private readonly estimateTokens: ContextTokenEstimator;

  constructor(
    private readonly maxContextTokens: number | undefined,
    estimateContextTokens: ContextTokenEstimator | undefined,
    messages: readonly AgentMessage[],
  ) {
    this.removableGroups = maxContextTokens === undefined ? [] : createConversationTurns(messages);
    this.estimateTokens = estimateContextTokens ?? defaultEstimateContextTokens;
  }

  addToolInteraction(messages: readonly AgentMessage[]): void {
    if (this.maxContextTokens === undefined) return;
    this.removableGroups.push([...messages]);
  }

  prepare(
    messages: AgentMessage[],
    tools: readonly ToolDefinition[] | undefined,
  ): ContextPreparation {
    if (this.maxContextTokens === undefined) return { removedTurnCount: 0 };

    const request = {
      messages,
      ...(tools ? { tools } : {}),
    };
    const estimatedTokensBefore = this.estimate(request);
    let estimatedTokensAfter = estimatedTokensBefore;
    let removedTurnCount = 0;

    while (estimatedTokensAfter > this.maxContextTokens && this.removableGroups.length > 0) {
      const group = this.removableGroups.shift()!;
      const groupMessages = new Set(group);
      const retainedMessages = messages.filter((message) => !groupMessages.has(message));
      if (retainedMessages.length === messages.length) continue;

      messages.splice(0, messages.length, ...retainedMessages);
      removedTurnCount += 1;
      estimatedTokensAfter = this.estimate(request);
    }

    return {
      estimatedTokensBefore,
      estimatedTokensAfter,
      removedTurnCount,
      ...(estimatedTokensAfter > this.maxContextTokens
        ? { contextLimit: { estimatedTokens: estimatedTokensAfter, maxContextTokens: this.maxContextTokens } }
        : {}),
    };
  }

  private estimate(request: ContextEstimateInput): number {
    const estimate = this.estimateTokens(request);
    if (!Number.isSafeInteger(estimate) || estimate < 0) {
      throw new RangeError("estimateContextTokens must return a non-negative safe integer.");
    }
    return estimate;
  }
}
