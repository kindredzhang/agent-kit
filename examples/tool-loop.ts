import { z } from "zod";
import { Agent, AgentTraceCollector, defineTool, evaluateToolTrajectory } from "../src/index";
import { createExampleModel, describeSettings } from "./shared";

const getWeather = defineTool({
  name: "get_weather",
  description: "Get the current weather for a city.",
  input: z.object({ city: z.string().min(1).describe("City name, e.g. Tokyo") }),
  annotations: { readOnly: true, idempotent: true },
  execute: ({ city }) => ({ city, temperatureC: 21, condition: "clear" }),
});

const searchFlights = defineTool({
  name: "search_flights",
  description: "Search available flights between two cities.",
  input: z.object({
    from: z.string().min(1),
    to: z.string().min(1),
    date: z.string().describe("ISO date, e.g. 2026-12-01"),
  }),
  annotations: { readOnly: true, idempotent: true },
  execute: ({ from, to, date }) => ({
    route: `${from} -> ${to}`,
    date,
    options: [
      { flight: "AK101", depart: "09:10", arrive: "13:40", priceUsd: 412 },
      { flight: "AK205", depart: "18:25", arrive: "22:55", priceUsd: 368 },
    ],
  }),
});

async function main(): Promise<void> {
  const { model } = createExampleModel();
  console.log(`provider=openai-chat-completions ${describeSettings()}\n`);

  const trace = new AgentTraceCollector({ recordInputs: true, recordOutputs: true });
  const agent = new Agent({
    model,
    instructions: "You are a concise travel assistant. Call tools when they provide the answer.",
    tools: [getWeather, searchFlights],
    maxTurns: 6,
  });

  process.stdout.write("assistant> ");
  let text = "";
  let stopReason = "error";
  for await (const event of agent.stream({
    messages: [{
      role: "user",
      content: "What is the weather in Tokyo, and what flights go from Tokyo to Osaka on 2026-12-01?",
    }],
  })) {
    trace.record(event);
    switch (event.type) {
      case "message.delta":
        if (event.delta.type === "text") {
          text += event.delta.text;
          process.stdout.write(event.delta.text);
        }
        break;
      case "tool.execution.started":
        process.stdout.write(`\n  -> ${event.name}(...)`);
        break;
      case "tool.execution.completed":
        process.stdout.write(`\n  <- ${event.name}: ${JSON.stringify(event.result).slice(0, 100)}`);
        break;
      case "tool.execution.failed":
        process.stdout.write(`\n  !! ${event.name}: ${event.error.message}`);
        break;
      case "agent.completed":
        stopReason = event.stopReason;
        break;
      case "agent.stopped":
        stopReason = event.stopReason;
        break;
      case "agent.failed":
        stopReason = event.stopReason;
        break;
    }
  }

  const record = trace.finish();
  const executed = record?.turns.flatMap((turn) =>
    turn.tools.filter((tool) => tool.status === "completed").map((tool) => ({ turn: turn.turn, name: tool.name }))
  ) ?? [];

  console.log(`\n\nstopReason=${stopReason}`);
  console.log(`toolTrajectory=${JSON.stringify(executed)}`);
  if (record?.usage) console.log(`usage=${JSON.stringify(record.usage)}`);

  const evaluation = record
    ? evaluateToolTrajectory([record], executed)
    : undefined;
  console.log(`trajectoryEvaluated=${evaluation?.passed ?? false}`);

  if (stopReason !== "completed") process.exitCode = 1;
  if (text.trim().length === 0) {
    console.error("The model produced no text.");
    process.exitCode = 1;
  }
}

await main();
