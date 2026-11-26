import { z } from "zod";
import { Agent, defineTool } from "../src/index";
import { createExampleModel, describeSettings } from "./shared";

const lookupOrder = defineTool({
  name: "lookup_order",
  description: "Look up an order by id and return its status and total.",
  input: z.object({ orderId: z.string().min(1) }),
  annotations: { readOnly: true, idempotent: true },
  execute: ({ orderId }) => ({
    orderId,
    status: orderId === "ORD-1001" ? "shipped" : "processing",
    totalUsd: orderId === "ORD-1001" ? 128.4 : 59.0,
    carrier: orderId === "ORD-1001" ? "AK Express" : null,
  }),
});

const answer = z.object({
  orderId: z.string(),
  status: z.enum(["processing", "shipped", "delivered", "cancelled"]),
  totalUsd: z.number(),
  summary: z.string().min(1).describe("One sentence the customer will read."),
});

async function main(): Promise<void> {
  const { model } = createExampleModel();
  console.log(`${describeSettings()}\n`);

  const agent = new Agent({
    model,
    instructions: "You are an order support assistant. Look up the order before answering.",
    tools: [lookupOrder],
    outputSchema: answer,
    maxTurns: 6,
  });

  let structured: unknown;
  let stopReason = "error";
  for await (const event of agent.stream({
    messages: [{ role: "user", content: "What happened to order ORD-1001?" }],
  })) {
    if (event.type === "tool.execution.started") {
      console.log(`  [tool] ${event.name}`);
    }
    if (event.type === "agent.completed") {
      stopReason = event.stopReason;
      structured = event.structuredOutput;
    }
    if (event.type === "agent.stopped") {
      stopReason = event.stopReason;
    }
    if (event.type === "agent.failed") {
      stopReason = event.stopReason;
    }
  }

  console.log(`\nstopReason=${stopReason}`);
  console.log(`structuredOutput=${JSON.stringify(structured, null, 2)}`);

  const parsed = answer.safeParse(structured);
  console.log(`validatedAgainstSchema=${parsed.success}`);
  if (!parsed.success) {
    console.error(JSON.stringify(parsed.error.issues, null, 2));
    process.exitCode = 1;
  }
}

await main();
