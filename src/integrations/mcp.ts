import type { AnyAgentTool, ToolAnnotations } from "../core/tools.js";
import type { JsonObject, JsonSchema, JsonValue } from "../core/types.js";
import { toJsonValue } from "../core/json.js";

export interface MCPToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
  };
}

export interface MCPToolCallResult {
  content?: readonly { type: string; text?: string }[];
  structuredContent?: unknown;
  isError?: boolean;
}

export interface MCPToolListResult {
  tools: readonly MCPToolDescriptor[];
  nextCursor?: string;
}

export interface MCPToolClient {
  listTools(params?: { cursor?: string }, options?: { cacheMode?: "use" | "refresh" | "bypass" }): Promise<MCPToolListResult>;
  callTool(params: { name: string; arguments: JsonObject }): Promise<MCPToolCallResult>;
}

export interface MCPToolSourceOptions {
  namespace?: string;
  trustAnnotations?: boolean;
  toolName?: (serverToolName: string) => string;
}

export interface MCPToolSource {
  readonly tools: readonly AnyAgentTool[];
  refresh(): Promise<void>;
}

const TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const TOOL_NAME_PATTERN_SOURCE = "[A-Za-z0-9_-]{1,64}";
const MAX_TOOL_PAGES = 100;

function normalizeSchema(schema: unknown): JsonSchema {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
    return { type: "object" };
  }
  return structuredClone(schema) as JsonSchema;
}

function trustedAnnotations(descriptor: MCPToolDescriptor): ToolAnnotations | undefined {
  const hints = descriptor.annotations;
  if (!hints) return undefined;
  const annotations: ToolAnnotations = {
    ...(typeof hints.readOnlyHint === "boolean" ? { readOnly: hints.readOnlyHint } : {}),
    ...(typeof hints.destructiveHint === "boolean" ? { destructive: hints.destructiveHint } : {}),
    ...(typeof hints.idempotentHint === "boolean" ? { idempotent: hints.idempotentHint } : {}),
  };
  return Object.keys(annotations).length > 0 ? annotations : undefined;
}

function toToolResult(result: MCPToolCallResult): JsonValue {
  if (result.structuredContent !== undefined) return toJsonValue(result.structuredContent);

  const content = result.content ?? [];
  if (content.length === 0) return null;
  if (content.every((block) => block.type === "text")) {
    return content.map((block) => block.text ?? "").join("\n");
  }
  return toJsonValue(content);
}

function errorMessage(result: MCPToolCallResult): string {
  const texts = (result.content ?? [])
    .filter((block) => block.type === "text" && block.text !== undefined)
    .map((block) => block.text);
  return texts.length > 0 ? texts.join("\n") : "MCP tool call failed.";
}

async function listAllTools(client: MCPToolClient, refresh: boolean): Promise<MCPToolDescriptor[]> {
  const tools: MCPToolDescriptor[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
    const result = await client.listTools(
      cursor !== undefined ? { cursor } : undefined,
      refresh && page === 0 ? { cacheMode: "refresh" } : undefined,
    );
    tools.push(...result.tools);
    if (result.nextCursor === undefined) return tools;
    if (seenCursors.has(result.nextCursor)) {
      throw new Error("MCP server returned the same tool list cursor twice.");
    }
    seenCursors.add(result.nextCursor);
    cursor = result.nextCursor;
  }

  throw new Error(`MCP server returned more than ${MAX_TOOL_PAGES} pages of tools.`);
}

function createMCPTool(
  client: MCPToolClient,
  descriptor: MCPToolDescriptor,
  name: string,
  annotations: ToolAnnotations | undefined,
): AnyAgentTool {
  return {
    name,
    description: descriptor.description || descriptor.name,
    inputSchema: normalizeSchema(descriptor.inputSchema),
    ...(annotations ? { annotations } : {}),
    ...(annotations === undefined ? { requiresApproval: true } : {}),
    parseInput: (input: JsonObject) => input,
    execute: async (input: JsonObject) => {
      const result = await client.callTool({ name: descriptor.name, arguments: input });
      if (result.isError === true) throw new Error(errorMessage(result));
      return toToolResult(result);
    },
  };
}

export async function createMCPToolSource(
  client: MCPToolClient,
  options: MCPToolSourceOptions = {},
): Promise<MCPToolSource> {
  const resolveName = (serverToolName: string): string => {
    const name = options.toolName?.(serverToolName) ??
      (options.namespace !== undefined ? `${options.namespace}__${serverToolName}` : serverToolName);
    if (!TOOL_NAME_PATTERN.test(name)) {
      throw new Error(`MCP tool name "${name}" must match ${TOOL_NAME_PATTERN_SOURCE}.`);
    }
    return name;
  };

  let tools: readonly AnyAgentTool[] = [];

  const refresh = async (): Promise<void> => {
    const descriptors = await listAllTools(client, true);
    const names = new Set<string>();
    const nextTools = descriptors.map((descriptor) => {
      const name = resolveName(descriptor.name);
      if (names.has(name)) throw new Error(`MCP server exposes duplicate tool name "${name}".`);
      names.add(name);
      return createMCPTool(
        client,
        descriptor,
        name,
        options.trustAnnotations === true ? trustedAnnotations(descriptor) : undefined,
      );
    });
    tools = nextTools;
  };

  await refresh();

  return {
    get tools() {
      return tools;
    },
    refresh,
  };
}
