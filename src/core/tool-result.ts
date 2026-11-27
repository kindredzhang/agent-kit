import { stringifyJson } from "./json.js";
import type { AgentMessage } from "./types.js";

const encoder = new TextEncoder();
const truncationSuffix = "\n[Tool result truncated]";

export function limitToolMessage(message: AgentMessage, maxBytes?: number): AgentMessage {
  if (maxBytes === undefined || message.role !== "tool") return message;
  const text = stringifyJson(message.content);
  if (text.length * 3 <= maxBytes) return message;

  const buffer = new Uint8Array(maxBytes);
  if (text.length <= maxBytes && encoder.encodeInto(text, buffer).read === text.length) return message;

  const suffix = maxBytes >= truncationSuffix.length ? truncationSuffix : "...".slice(0, maxBytes);
  const { read } = encoder.encodeInto(text, buffer.subarray(0, maxBytes - suffix.length));
  return { ...message, content: text.slice(0, read) + suffix };
}
