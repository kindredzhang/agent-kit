import { z } from "zod";
import { Agent, defineTool } from "../src/index.js";
import { createExampleModel, describeSettings } from "./shared.js";

const slowLookup = defineTool({
  name: "slow_lookup",
  description: "Look up a record in a slow upstream service. Sometimes the upstream never answers.",
  input: z.object({ key: z.string().min(1) }),
  annotations: { readOnly: true, idempotent: true },
  timeoutMs: 300,
  execute: ({ key }) => new Promise((resolve) => setTimeout(() => resolve({ key, value: 42 }), 1000)),
});

async function main(): Promise<void> {
  const { model } = createExampleModel();
  console.log(`${describeSettings()}\n`);

  const agent = new Agent({
    model,
    instructions: "You look up records. Use slow_lookup once, then report what happened.",
    tools: [slowLookup],
    maxTurns: 4,
  });

  for await (const event of agent.stream({
    messages: [{ role: "user", content: "Look up key alpha." }],
    budget: { maxDurationMs: 30_000 },
  })) {
    switch (event.type) {
      case "tool.execution.failed":
        console.log(`tool ${event.name} failed: ${event.error.name}: ${event.error.message}`);
        break;
      case "tool.execution.completed":
        console.log(`tool ${event.name} completed: ${JSON.stringify(event.result)}`);
        break;
      case "agent.budget.updated":
        console.log(`elapsed ${event.budget.elapsedMs}ms of ${event.budget.maxDurationMs}ms`);
        break;
      case "agent.completed":
        console.log(`\ncompleted: ${event.message.content}`);
        break;
      case "agent.stopped":
        console.log(`\nstopped: ${event.stopReason}`);
        break;
      case "agent.failed":
        console.log(`\nfailed: ${event.error.message}`);
        break;
    }
  }
}

await main();
