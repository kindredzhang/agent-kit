import { expect, test } from "bun:test";
import { z } from "zod/v4";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { Agent, defineTool } from "../index.js";
import type { AgentEvent, LanguageModel, ModelStreamEvent } from "../index.js";
import { createMCPToolSource } from "./mcp.js";
import type { MCPToolClient, MCPToolDescriptor } from "./mcp.js";

async function connectServer(register: (server: McpServer) => void) {
  const server = new McpServer({ name: "test-server", version: "1.0.0" });
  register(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    async close() {
      await client.close();
      await server.close();
    },
  };
}

function toolCallingModel(tools: readonly { name: string }[]): LanguageModel {
  return {
    provider: "openai-chat-completions",
    async *stream({ messages }): AsyncGenerator<ModelStreamEvent> {
      if (messages.some(({ role }) => role === "tool")) {
        yield { type: "text.delta", delta: "Done." };
        yield { type: "finish", finishReason: "stop" };
        return;
      }
      yield { type: "tool.call.completed", toolCall: { id: "call_1", name: tools[0]!.name, input: { key: "a" } } };
      yield { type: "finish", finishReason: "tool_calls" };
    },
  };
}

async function run(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const collected: AgentEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

test("exposes a read-only MCP tool to an agent run with structured results", async () => {
  const connection = await connectServer((server) => {
    server.registerTool(
      "lookup",
      {
        description: "Look up a record.",
        inputSchema: z.object({ key: z.string() }),
        annotations: { readOnlyHint: true },
      },
      async ({ key }) => ({
        content: [{ type: "text", text: `found ${key}` }],
        structuredContent: { found: key },
      }),
    );
  });

  try {
    const source = await createMCPToolSource(connection.client, {
      namespace: "records",
      trustAnnotations: true,
    });
    expect(source.tools.map(({ name }) => name)).toEqual(["records__lookup"]);
    const agent = new Agent({ model: toolCallingModel(source.tools), tools: source.tools });
    const events = await run(agent.stream({ messages: [{ role: "user", content: "Look it up." }] }));

    expect(events).toContainEqual(
      expect.objectContaining({ type: "tool.execution.completed", name: "records__lookup", result: { found: "a" } }),
    );
    expect(events.some((event) => event.type === "tool.approval.requested")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "agent.completed" });
  } finally {
    await connection.close();
  }
});

test("requires approval for MCP tools unless the host trusts the server annotations", async () => {
  const connection = await connectServer((server) => {
    server.registerTool(
      "delete_record",
      {
        description: "Delete a record.",
        inputSchema: z.object({ key: z.string() }),
        annotations: { readOnlyHint: true },
      },
      async ({ key }) => ({ content: [{ type: "text", text: `deleted ${key}` }] }),
    );
  });

  try {
    const untrusted = await createMCPToolSource(connection.client);
    expect(untrusted.tools[0]?.annotations).toBeUndefined();
    expect(untrusted.tools[0]?.requiresApproval).toBe(true);

    const unapproved = await run(
      new Agent({ model: toolCallingModel(untrusted.tools), tools: untrusted.tools })
        .stream({ messages: [{ role: "user", content: "Delete it." }] }),
    );
    expect(unapproved).toContainEqual(
      expect.objectContaining({ type: "tool.approval.resolved", decision: "rejected", reason: "no_handler" }),
    );
    expect(unapproved.some((event) => event.type === "tool.execution.started")).toBe(false);

    const trusted = await createMCPToolSource(connection.client, { trustAnnotations: true });
    expect(trusted.tools[0]?.annotations).toEqual({ readOnly: true });
    expect(trusted.tools[0]?.requiresApproval).toBeUndefined();
    const approved = await run(
      new Agent({ model: toolCallingModel(trusted.tools), tools: trusted.tools })
        .stream({ messages: [{ role: "user", content: "Delete it." }] }),
    );
    expect(approved).toContainEqual(
      expect.objectContaining({ type: "tool.execution.completed", name: "delete_record" }),
    );
  } finally {
    await connection.close();
  }
});

test("returns MCP tool failures to the model as tool errors", async () => {
  const connection = await connectServer((server) => {
    server.registerTool(
      "fail",
      { description: "Always fails.", inputSchema: z.object({ key: z.string() }) },
      async ({ key }) => ({ content: [{ type: "text", text: `bad key: ${key}` }], isError: true }),
    );
  });

  try {
    const source = await createMCPToolSource(connection.client);
    const events = await run(
      new Agent({ model: toolCallingModel(source.tools), tools: source.tools, approveTool: async () => true })
        .stream({ messages: [{ role: "user", content: "Try it." }] }),
    );
    const failed = events.find((event) => event.type === "tool.execution.failed");
    expect(failed).toMatchObject({ type: "tool.execution.failed", name: "fail" });
    if (failed?.type !== "tool.execution.failed") throw new Error("Expected a tool execution failure.");
    expect(failed.error.message).toBe("bad key: a");
    expect(events.at(-1)).toMatchObject({ type: "agent.completed" });
  } finally {
    await connection.close();
  }
});

test("refreshes tool definitions so a paused run fails to resume after a schema change", async () => {
  let requiredField = "a";
  const connection = await connectServer((server) => {
    server.registerTool(
      "lookup",
      { description: "Look up a record.", inputSchema: z.object({ key: z.string() }) },
      async ({ key }) => ({ content: [{ type: "text", text: `found ${key}` }] }),
    );
  });
  const client: MCPToolClient = {
    async listTools(params, options) {
      if (options?.cacheMode !== "refresh") return connection.client.listTools(params);
      const listed = await connection.client.listTools(params, { cacheMode: "refresh" });
      return {
        ...listed,
        tools: listed.tools.map((tool) => ({
          ...tool,
          inputSchema: {
            type: "object",
            properties: { key: { type: "string" }, [requiredField]: { type: "string" } },
          },
        })),
      };
    },
    callTool: (params) => connection.client.callTool(params),
  };

  try {
    const source = await createMCPToolSource(client, { trustAnnotations: true });
    const pauseModel: LanguageModel = {
      provider: "openai-chat-completions",
      async *stream(): AsyncGenerator<ModelStreamEvent> {
        yield { type: "tool.call.completed", toolCall: { id: "call_1", name: "lookup", input: { key: "a" } } };
        yield { type: "finish", finishReason: "tool_calls" };
      },
    };
    const agent = new Agent({ model: pauseModel, tools: source.tools, approvalMode: "pause" });
    let paused: Extract<AgentEvent, { type: "agent.paused" }> | undefined;
    for await (const event of agent.stream({ messages: [{ role: "user", content: "Look it up." }] })) {
      if (event.type === "agent.paused") paused = event;
    }
    if (!paused) throw new Error("Expected an approval pause.");

    requiredField = "extra";
    await source.refresh();
    const resumed = await run(
      new Agent({ model: pauseModel, tools: source.tools, approvalMode: "pause" })
        .resume({ state: paused.runState, approval: { toolCallId: "call_1", decision: "approved" } }),
    );
    expect(resumed.at(-1)).toMatchObject({
      type: "agent.failed",
      error: { message: "Agent run state does not match the configured tools." },
    });
  } finally {
    await connection.close();
  }
});

function fakeClient(pages: readonly { tools: readonly MCPToolDescriptor[]; nextCursor?: string }[]): {
  client: MCPToolClient;
  calls: { name: string; arguments: JsonObjectArg }[];
} {
  const calls: { name: string; arguments: JsonObjectArg }[] = [];
  let pageIndex = 0;
  return {
    calls,
    client: {
      async listTools() {
        const page = pages[pageIndex++] ?? { tools: [] };
        return { tools: page.tools, ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}) };
      },
      async callTool(params) {
        calls.push(params);
        return {
          content: [
            { type: "text", text: "first" },
            { type: "image", text: undefined },
          ],
        };
      },
    },
  };
}

type JsonObjectArg = { [key: string]: unknown };

test("pages through the tool list and rejects a repeated cursor", async () => {
  const paged = fakeClient([
    { tools: [{ name: "first" }], nextCursor: "page-2" },
    { tools: [{ name: "second" }] },
  ]);
  const source = await createMCPToolSource(paged.client);
  expect(source.tools.map(({ name }) => name)).toEqual(["first", "second"]);

  const looping = fakeClient([
    { tools: [{ name: "first" }], nextCursor: "same" },
    { tools: [{ name: "second" }], nextCursor: "same" },
  ]);
  await expect(createMCPToolSource(looping.client)).rejects.toThrow(
    "MCP server returned the same tool list cursor twice.",
  );
});

test("rejects invalid or duplicate tool names and returns non-text content as JSON", async () => {
  await expect(createMCPToolSource(fakeClient([{ tools: [{ name: "bad name" }] }]).client)).rejects.toThrow(
    'MCP tool name "bad name" must match [A-Za-z0-9_-]{1,64}.',
  );
  await expect(createMCPToolSource(fakeClient([{ tools: [{ name: "same" }, { name: "same" }] }]).client)).rejects.toThrow(
    'MCP server exposes duplicate tool name "same".',
  );

  const source = await createMCPToolSource(fakeClient([{ tools: [{ name: "lookup" }] }]).client);
  const result = await source.tools[0]!.execute({ key: "a" }, { runId: "run", turn: 1, toolCallId: "call" });
  expect(result).toEqual([{ type: "text", text: "first" }, { type: "image" }]);
});

test("rejects a local tool that collides with a namespaced MCP tool", async () => {
  const source = await createMCPToolSource(fakeClient([{ tools: [{ name: "lookup" }] }]).client, {
    namespace: "records",
  });
  const local = defineTool({
    name: "records__lookup",
    description: "Local tool with the same name.",
    input: z.object({}),
    annotations: { readOnly: true },
    execute: () => ({ local: true }),
  });
  expect(() => new Agent({ model: toolCallingModel(source.tools), tools: [...source.tools, local] })).toThrow(
    "Tool names must be unique. Duplicate name: records__lookup.",
  );
});
