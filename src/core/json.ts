import type { JsonObject, JsonValue } from "./types";

export function parseJsonObject(source: string): JsonObject {
  const value: unknown = JSON.parse(source || "{}");

  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Tool input must be a JSON object.");
  }

  return value as JsonObject;
}

export function stringifyJson(value: JsonValue): string {
  return typeof value === "string" ? value : JSON.stringify(value) ?? "null";
}

export function toJsonValue(value: unknown): JsonValue {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value) ?? "null") as JsonValue;
}
