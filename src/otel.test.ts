import { expect, test } from "bun:test";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { Agent, AgentTraceCollector, defineTool, InMemorySessionStore } from "./index.js";
import type { AgentEvent, AgentTrace, LanguageModel, ModelStreamEvent } from "./index.js";
import { exportAgentTrace } from "./otel.js";
import { z } from "zod";

const input = { messages: [{ role: "user" as const, content: "start" }] };

function memoryTracer() {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  return { exporter, tracer: provider.getTracer("rein-kit-test") };
}

async function collect(stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

async function traceStream(
  stream: AsyncIterable<AgentEvent>,
  options: ConstructorParameters<typeof AgentTraceCollector>[0] = {},
): Promise<AgentTrace> {
  const collector = new AgentTraceCollector(options);
  for await (const event of stream) collector.record(event);
  const trace = collector.finish();
  if (!trace) throw new Error("expected a trace");
  return trace;
}

function traceOf(
  events: readonly AgentEvent[],
  options: ConstructorParameters<typeof AgentTraceCollector>[0] = {},
): AgentTrace {
  const collector = new AgentTraceCollector(options);
  for (const event of events) collector.record(event);
  const trace = collector.finish();
  if (!trace) throw new Error("expected a trace");
  return trace;
}

function byName(spans: readonly ReadableSpan[], name: string): ReadableSpan {
  const span = spans.find((candidate) => candidate.name === name);
  if (!span) throw new Error(`no span named "${name}"; got ${spans.map((s) => s.name).join(", ") || "(none)"}`);
  return span;
}

function toolThenAnswerModel(name: string): LanguageModel {
  return {
    provider: "openai-chat-completions",
    async *stream(request): AsyncGenerator<ModelStreamEvent> {
      if (request.messages.some((message) => message.role === "tool")) {
        yield { type: "text.delta", delta: "answer text" };
        yield { type: "finish", finishReason: "stop" };
        return;
      }
      yield { type: "tool.call.completed", toolCall: { id: "call-1", name, input: { key: "a" } } };
      yield { type: "finish", finishReason: "tool_calls" };
    },
  };
}

test("exports one invoke_agent span carrying the run attributes", async () => {
  const model: LanguageModel = {
    provider: "openai-chat-completions",
    async *stream(): AsyncGenerator<ModelStreamEvent> {
      yield { type: "text.delta", delta: "hello" };
      yield { type: "usage", usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } };
      yield { type: "finish", finishReason: "stop" };
    },
  };
  const { exporter, tracer } = memoryTracer();
  exportAgentTrace(traceOf(await collect(new Agent({ model }).stream(input))), { tracer, model: "test-model" });
  const spans = exporter.getFinishedSpans();

  expect(spans.map((span) => span.name).sort()).toEqual(["chat test-model", "invoke_agent"]);

  const span = byName(spans, "invoke_agent");
  expect(span.kind).toBe(SpanKind.INTERNAL);
  expect(span.status.code).toBe(SpanStatusCode.UNSET);
  expect(span.attributes).toMatchObject({
    "gen_ai.operation.name": "invoke_agent",
    "gen_ai.provider.name": "openai",
    "gen_ai.request.model": "test-model",
    "gen_ai.response.finish_reasons": ["stop"],
    "gen_ai.usage.input_tokens": 3,
    "gen_ai.usage.output_tokens": 2,
  });
});

test("maps model turns to chat spans and tool executions to execute_tool spans", async () => {
  const tool = defineTool({
    name: "lookup",
    description: "Look something up.",
    input: z.object({ key: z.string() }),
    annotations: { readOnly: true },
    execute: ({ key }) => ({ key, value: 1 }),
  });
  const { exporter, tracer } = memoryTracer();
  const agent = new Agent({ model: toolThenAnswerModel("lookup"), tools: [tool] });
  exportAgentTrace(traceOf(await collect(agent.stream(input))), { tracer, model: "test-model" });
  const spans = exporter.getFinishedSpans();

  const chatSpans = spans.filter((span) => span.name === "chat test-model");
  expect(chatSpans).toHaveLength(2);
  expect(chatSpans[0]!.kind).toBe(SpanKind.CLIENT);
  expect(chatSpans[0]!.status.code).toBe(SpanStatusCode.UNSET);
  expect(chatSpans[0]!.attributes).toMatchObject({
    "gen_ai.operation.name": "chat",
    "gen_ai.provider.name": "openai",
    "gen_ai.request.model": "test-model",
    "gen_ai.response.finish_reasons": ["tool_calls"],
  });
  expect(chatSpans[1]!.attributes["gen_ai.response.finish_reasons"]).toEqual(["stop"]);

  const toolSpan = byName(spans, "execute_tool lookup");
  expect(toolSpan.kind).toBe(SpanKind.INTERNAL);
  expect(toolSpan.status.code).toBe(SpanStatusCode.UNSET);
  expect(toolSpan.attributes).toMatchObject({
    "gen_ai.operation.name": "execute_tool",
    "gen_ai.tool.name": "lookup",
    "gen_ai.tool.call.id": "call-1",
    "gen_ai.tool.type": "function",
  });
});

test("nests chat and tool spans under the agent span and keeps their durations", async () => {
  const tool = defineTool({
    name: "lookup",
    description: "Look something up.",
    input: z.object({ key: z.string() }),
    annotations: { readOnly: true },
    execute: async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return "ok";
    },
  });
  const { exporter, tracer } = memoryTracer();
  const agent = new Agent({ model: toolThenAnswerModel("lookup"), tools: [tool] });
  exportAgentTrace(await traceStream(agent.stream(input)), { tracer, model: "test-model" });
  const spans = exporter.getFinishedSpans();

  const agentSpan = byName(spans, "invoke_agent");
  const toolSpan = byName(spans, "execute_tool lookup");
  const chatSpans = spans.filter((span) => span.name.startsWith("chat"));

  expect(chatSpans).toHaveLength(2);
  for (const child of [toolSpan, ...chatSpans]) {
    expect(child.parentSpanContext?.spanId).toBe(agentSpan.spanContext().spanId);
    expect(child.spanContext().traceId).toBe(agentSpan.spanContext().traceId);
  }
  expect(toolSpan.duration[1] / 1e6).toBeGreaterThanOrEqual(25);
});

test("marks a failed agent span with an error status and error.type", async () => {
  const model: LanguageModel = {
    provider: "openai-chat-completions",
    async *stream(): AsyncGenerator<ModelStreamEvent> {
      throw new Error("gateway exploded");
    },
  };
  const { exporter, tracer } = memoryTracer();
  exportAgentTrace(traceOf(await collect(new Agent({ model }).stream(input))), { tracer, model: "test-model" });
  const span = byName(exporter.getFinishedSpans(), "invoke_agent");

  expect(span.status.code).toBe(SpanStatusCode.ERROR);
  expect(span.status.message).toBeUndefined();
  expect(span.attributes["error.type"]).toBe("Error");
  expect(span.attributes["gen_ai.response.finish_reasons"]).toEqual(["error"]);
});

test("marks a failed tool span with an error status", async () => {
  const tool = defineTool({
    name: "boom",
    description: "Always fails.",
    input: z.object({ key: z.string() }),
    annotations: { readOnly: true },
    execute: () => {
      throw new RangeError("nope");
    },
  });
  const { exporter, tracer } = memoryTracer();
  const agent = new Agent({ model: toolThenAnswerModel("boom"), tools: [tool] });
  exportAgentTrace(traceOf(await collect(agent.stream(input))), { tracer, model: "test-model" });
  const spans = exporter.getFinishedSpans();
  const span = byName(spans, "execute_tool boom");

  expect(span.status.code).toBe(SpanStatusCode.ERROR);
  expect(span.attributes["error.type"]).toBe("RangeError");
  expect(byName(spans, "invoke_agent").status.code).toBe(SpanStatusCode.UNSET);
});

test("omits payload attributes unless the collector recorded them", async () => {
  const tool = defineTool({
    name: "lookup",
    description: "Look something up.",
    input: z.object({ key: z.string() }),
    annotations: { readOnly: true },
    execute: ({ key }) => ({ key, secret: "leak" }),
  });
  const { exporter, tracer } = memoryTracer();
  const agent = new Agent({ model: toolThenAnswerModel("lookup"), tools: [tool] });
  exportAgentTrace(traceOf(await collect(agent.stream(input))), { tracer, model: "test-model" });
  const spans = exporter.getFinishedSpans();

  expect(byName(spans, "execute_tool lookup").attributes["gen_ai.tool.call.arguments"]).toBeUndefined();
  expect(byName(spans, "execute_tool lookup").attributes["gen_ai.tool.call.result"]).toBeUndefined();
  expect(byName(spans, "chat test-model").attributes["gen_ai.output.messages"]).toBeUndefined();
});

test("records payload attributes as JSON strings when the collector was asked to", async () => {
  const tool = defineTool({
    name: "lookup",
    description: "Look something up.",
    input: z.object({ key: z.string() }),
    annotations: { readOnly: true },
    execute: ({ key }) => ({ key, value: 7 }),
  });
  const { exporter, tracer } = memoryTracer();
  const agent = new Agent({ model: toolThenAnswerModel("lookup"), tools: [tool] });
  const events = await collect(agent.stream(input));
  exportAgentTrace(traceOf(events, { recordInputs: true, recordOutputs: true }), { tracer, model: "test-model" });
  const spans = exporter.getFinishedSpans();
  const toolSpan = byName(spans, "execute_tool lookup");
  const answerSpan = spans.find(
    (span) => String(span.attributes["gen_ai.response.finish_reasons"]) === "stop",
  )!;

  expect(toolSpan.attributes["gen_ai.tool.call.arguments"]).toBe('{"key":"a"}');
  expect(toolSpan.attributes["gen_ai.tool.call.result"]).toBe('{"key":"a","value":7}');
  expect(JSON.parse(String(answerSpan.attributes["gen_ai.output.messages"]))).toEqual([
    { role: "assistant", parts: [{ type: "text", content: "answer text" }] },
  ]);
});

test("records conversation id and agent name when supplied", async () => {
  const model: LanguageModel = {
    provider: "openai-chat-completions",
    async *stream(): AsyncGenerator<ModelStreamEvent> {
      yield { type: "finish", finishReason: "stop" };
    },
  };
  const { exporter, tracer } = memoryTracer();
  const agent = new Agent({ model, sessionStore: new InMemorySessionStore() });
  const events = await collect(agent.stream({ ...input, sessionId: "session-7" }));
  exportAgentTrace(traceOf(events), { tracer, model: "test-model", agentName: "Researcher" });
  const spans = exporter.getFinishedSpans();

  const span = byName(spans, "invoke_agent Researcher");
  expect(span.attributes["gen_ai.agent.name"]).toBe("Researcher");
  expect(span.attributes["gen_ai.conversation.id"]).toBe("session-7");
  expect(byName(spans, "chat test-model").attributes["gen_ai.conversation.id"]).toBe("session-7");
});

test("falls back to the global tracer when none is supplied", async () => {
  const model: LanguageModel = {
    provider: "openai-chat-completions",
    async *stream(): AsyncGenerator<ModelStreamEvent> {
      yield { type: "finish", finishReason: "stop" };
    },
  };
  const trace = traceOf(await collect(new Agent({ model }).stream(input)));
  expect(() => exportAgentTrace(trace)).not.toThrow();
  expect(() => exportAgentTrace(trace, { model: "test-model" })).not.toThrow();
});
