import type { AgentImageSource, FinishReason } from "../../core/types.js";

export function toDataUrl(mediaType: string, data: string): string {
  return `data:${mediaType};base64,${data}`;
}

export function toImageUrl(source: AgentImageSource): string {
  return source.type === "url" ? source.url : toDataUrl(source.mediaType, source.data);
}

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
