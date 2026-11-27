import { context, SpanKind, SpanStatusCode, trace as otelTrace } from "@opentelemetry/api";
import type { Attributes, Context, Span, Tracer } from "@opentelemetry/api";
import type { AgentModelTrace, AgentToolTrace, AgentTrace, AgentTraceError } from "./core/trace.js";
import type { FinishReason, ModelProvider, TokenUsage } from "./core/types.js";

export interface AgentTraceExportOptions {
  tracer?: Tracer;
  model?: string;
  agentName?: string;
}

const defaultTracerName = "agent-kit";

const providerNames: Record<ModelProvider, string> = {
  "openai-chat-completions": "openai",
  "openai-responses": "openai",
  "anthropic-messages": "anthropic",
};

const finishReasons: Record<FinishReason, string> = {
  stop: "stop",
  tool_calls: "tool_calls",
  length: "length",
  refusal: "refusal",
  other: "other",
};

export function exportAgentTrace(trace: AgentTrace, options: AgentTraceExportOptions = {}): void {
  const tracer = options.tracer ?? otelTrace.getTracer(defaultTracerName);
  const span = tracer.startSpan(agentSpanName(options), {
    kind: SpanKind.INTERNAL,
    startTime: trace.startedAt,
    attributes: {
      "gen_ai.operation.name": "invoke_agent",
      ...providerAttributes(trace),
      ...(options.agentName !== undefined ? { "gen_ai.agent.name": options.agentName } : {}),
      ...(options.model !== undefined ? { "gen_ai.request.model": options.model } : {}),
      ...conversationAttributes(trace),
      ...usageAttributes(trace.usage),
      "gen_ai.response.finish_reasons": runFinishReasons(trace),
    },
  });
  const parentContext = otelTrace.setSpan(context.active(), span);

  for (const turn of trace.turns) {
    if (turn.model) recordModelTurn(tracer, parentContext, trace, turn.model, options);
    for (const tool of turn.tools) recordToolCall(tracer, parentContext, trace, tool);
  }

  if (trace.error) recordError(span, trace.error);
  span.end(trace.endedAt);
}

function agentSpanName(options: AgentTraceExportOptions): string {
  return options.agentName !== undefined ? `invoke_agent ${options.agentName}` : "invoke_agent";
}

function recordModelTurn(
  tracer: Tracer,
  parentContext: Context,
  trace: AgentTrace,
  model: AgentModelTrace,
  options: AgentTraceExportOptions,
): void {
  const requestModel = model.requestModel ?? options.model;
  const span = tracer.startSpan(
    requestModel !== undefined ? `chat ${requestModel}` : "chat",
    {
      kind: SpanKind.CLIENT,
      startTime: model.startedAt,
      attributes: {
        "gen_ai.operation.name": "chat",
        ...providerAttributes(trace),
        ...(requestModel !== undefined ? { "gen_ai.request.model": requestModel } : {}),
        ...conversationAttributes(trace),
        ...usageAttributes(model.usage),
        "gen_ai.response.finish_reasons": modelFinishReasons(trace, model),
        ...(model.output !== undefined
          ? { "gen_ai.output.messages": outputMessages(model.output) }
          : {}),
      },
    },
    parentContext,
  );

  const failure = trace.status === "failed" && model.finishReason === undefined ? trace.error : undefined;
  if (failure) recordError(span, failure);
  span.end(model.endedAt);
}

function recordToolCall(tracer: Tracer, parentContext: Context, trace: AgentTrace, tool: AgentToolTrace): void {
  const span = tracer.startSpan(
    `execute_tool ${tool.name}`,
    {
      kind: SpanKind.INTERNAL,
      startTime: tool.startedAt,
      attributes: {
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.tool.name": tool.name,
        "gen_ai.tool.call.id": tool.toolCallId,
        "gen_ai.tool.type": "function",
        ...conversationAttributes(trace),
        ...(tool.input !== undefined ? { "gen_ai.tool.call.arguments": json(tool.input) } : {}),
        ...(tool.output !== undefined ? { "gen_ai.tool.call.result": json(tool.output) } : {}),
      },
    },
    parentContext,
  );

  if (tool.error) recordError(span, tool.error);
  span.end(tool.endedAt);
}

function recordError(span: Span, error: AgentTraceError): void {
  span.setAttribute("error.type", error.name);
  span.setStatus({ code: SpanStatusCode.ERROR });
}

function providerAttributes(trace: AgentTrace): Attributes {
  return trace.provider !== undefined ? { "gen_ai.provider.name": providerNames[trace.provider] } : {};
}

function conversationAttributes(trace: AgentTrace): Attributes {
  return trace.sessionId !== undefined ? { "gen_ai.conversation.id": trace.sessionId } : {};
}

function usageAttributes(usage: TokenUsage | undefined): Attributes {
  if (usage === undefined) return {};
  return {
    ...(usage.inputTokens !== undefined ? { "gen_ai.usage.input_tokens": usage.inputTokens } : {}),
    ...(usage.outputTokens !== undefined ? { "gen_ai.usage.output_tokens": usage.outputTokens } : {}),
  };
}

function runFinishReasons(trace: AgentTrace): string[] {
  if (trace.status === "failed") return ["error"];
  const reasons = trace.turns.flatMap((turn) =>
    turn.model?.finishReason !== undefined ? [finishReasons[turn.model.finishReason]] : [],
  );
  return reasons.length > 0 ? reasons : ["interrupted"];
}

function modelFinishReasons(trace: AgentTrace, model: AgentModelTrace): string[] {
  if (model.finishReason !== undefined) return [finishReasons[model.finishReason]];
  return [trace.status === "failed" ? "error" : "interrupted"];
}

function outputMessages(output: string): string {
  return json([{ role: "assistant", parts: [{ type: "text", content: output }] }]);
}

function json(value: unknown): string {
  return JSON.stringify(value);
}
