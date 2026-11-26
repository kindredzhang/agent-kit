import type { FinishReason } from "../../core/types.js";

export function mapOpenAIFinishReason(reason: string | null | undefined): FinishReason {
  switch (reason) {
    case "stop":
      return "stop";
    case "tool_calls":
    case "function_call":
      return "tool_calls";
    case "length":
      return "length";
    case "content_filter":
      return "refusal";
    default:
      return "other";
  }
}
