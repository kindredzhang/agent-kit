import { z } from "zod";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { Agent, AgentTraceCollector, defineTool } from "../src/index.js";
import { exportAgentTrace } from "../src/otel.js";
import { createExampleModel, describeSettings } from "./shared.js";

const getWeather = defineTool({
  name: "get_weather",
  description: "Get the current weather for a city.",
  input: z.object({ city: z.string().min(1) }),
  annotations: { readOnly: true, idempotent: true },
  execute: ({ city }) => ({ city, temperatureC: 21, condition: "clear" }),
});

function printSpanTree(spans: readonly ReadableSpan[]): void {
  const byParent = new Map<string | undefined, ReadableSpan[]>();
  for (const span of spans) {
    const parent = span.parentSpanContext?.spanId;
    byParent.set(parent, [...(byParent.get(parent) ?? []), span]);
  }

  const walk = (parent: string | undefined, depth: number): void => {
    for (const span of byParent.get(parent) ?? []) {
      const kind = span.kind === 2 ? "CLIENT" : "INTERNAL";
      const status = span.status.code === 2 ? " ERROR" : "";
      const durationMs = span.duration[1] / 1e6;
      console.log(`${"  ".repeat(depth)}${span.name} [${kind}]${status} ${durationMs.toFixed(1)}ms`);
      for (const [key, value] of Object.entries(span.attributes)) {
        if (key.startsWith("gen_ai.")) {
          console.log(`${"  ".repeat(depth + 1)}${key}=${JSON.stringify(value)}`);
        }
      }
      walk(span.spanContext().spanId, depth + 1);
    }
  };

  walk(undefined, 0);
}

async function main(): Promise<void> {
  const { model, modelId } = createExampleModel();
  console.log(`${describeSettings()}\n`);

  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });

  const collector = new AgentTraceCollector({ recordInputs: true, recordOutputs: true });
  const agent = new Agent({
    model,
    instructions: "You are a concise weather assistant. Call get_weather when asked about weather.",
    tools: [getWeather],
    maxTurns: 4,
  });

  let stopReason = "error";
  for await (const event of agent.stream({
    messages: [{ role: "user", content: "What is the weather in Tokyo?" }],
  })) {
    collector.record(event);
    if (event.type === "tool.execution.completed") console.log(`tool ${event.name}: ${JSON.stringify(event.result)}`);
    if (event.type === "agent.completed") stopReason = event.stopReason;
    if (event.type === "agent.stopped" || event.type === "agent.failed") stopReason = event.stopReason;
  }

  const trace = collector.finish();
  if (!trace) {
    console.error("No trace was collected.");
    process.exitCode = 1;
    return;
  }

  exportAgentTrace(trace, { tracer: provider.getTracer("rein-kit-example"), model: modelId, agentName: "WeatherAssistant" });
  await provider.forceFlush();

  console.log(`\nspan tree (status=${stopReason}):`);
  printSpanTree(exporter.getFinishedSpans());

  if (stopReason !== "completed") process.exitCode = 1;
}

await main();
