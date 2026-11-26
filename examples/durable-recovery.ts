import { Database } from "bun:sqlite";
import { z } from "zod";
import { Agent, SQLiteRunStore, defineTool } from "../src/index";
import { createExampleModel, describeSettings } from "./shared";

const charges: { amount: number; idempotencyKey: string }[] = [];

const chargeCard = defineTool({
  name: "charge_card",
  description: "Charge a customer's card for an order. This has an external side effect.",
  input: z.object({
    orderId: z.string().min(1),
    amountUsd: z.number().positive(),
  }),
  annotations: { readOnly: false },
  requiresApproval: false,
  execute: ({ orderId, amountUsd }, context) => {
    const idempotencyKey = `${context.runId}:${context.toolCallId}`;
    if (charges.some((entry) => entry.idempotencyKey === idempotencyKey)) {
      return { orderId, amountUsd, replayed: true, idempotencyKey };
    }
    charges.push({ amount: amountUsd, idempotencyKey });
    return { orderId, amountUsd, replayed: false, idempotencyKey };
  },
});

async function main(): Promise<void> {
  const { model } = createExampleModel();
  console.log(`${describeSettings()}\n`);

  const database = new Database(":memory:");
  try {
    const runStore = new SQLiteRunStore(database);
    const agent = new Agent({
      model,
      instructions: "You are a billing assistant. Always charge the card when asked, using the exact amount.",
      tools: [chargeCard],
      runStore,
      maxTurns: 4,
    });
    const messages = [{
      role: "user" as const,
      content: "Charge order ORD-9001 for 42.50 USD. Then confirm the order id and amount.",
    }];

    console.log("phase 1 — consume until the tool-batch checkpoint, then stop as if the process died");
    let runId: string | undefined;
    for await (const event of agent.stream({ messages })) {
      if (event.type === "agent.checkpointed") {
        console.log(`  [checkpoint] turn=${event.turn} resumeAt=${event.resumeAt}`);
      }
      if (event.type === "agent.checkpointed" && event.resumeAt === "tool_batch") {
        runId = event.runId;
        break;
      }
    }
    if (!runId) throw new Error("The example expected a tool-batch checkpoint.");
    const saved = await runStore.load(runId);
    console.log(`  pending tool calls: ${saved?.pendingToolCalls.map((call) => `${call.name}#${call.id}`).join(", ")}`);
    console.log(`  charges so far: ${charges.length}`);

    console.log("\nphase 2 — resume the same run id: the tool runs exactly once");
    for await (const event of agent.resume({ runId })) {
      if (event.type === "tool.execution.completed") {
        console.log(`  [tool] ${event.name} -> ${JSON.stringify(event.result)}`);
        break;
      }
    }
    console.log(`  charges so far: ${charges.length}`);
    console.log(`  checkpoint still present: ${await runStore.load(runId) !== undefined}`);

    console.log("\nphase 3 — crash again after the side effect, before the run finished");
    console.log("  resuming from the same checkpoint replays the batch with the same tool call id");
    for await (const event of agent.resume({ runId })) {
      if (event.type === "tool.execution.completed") {
        console.log(`  [replay] ${event.name} -> ${JSON.stringify(event.result)}`);
      }
      if (event.type === "agent.completed") {
        console.log(`  [done] ${event.message.content.trim().replaceAll("\n", " ")}`);
      }
    }

    console.log(`\ncharges recorded: ${JSON.stringify(charges, null, 0)}`);
    console.log(`duplicate charge prevented: ${charges.length === 1 ? "yes" : "no"}`);
    console.log(`checkpoint after completion: ${await runStore.load(runId) === undefined ? "none" : "present"}`);
  } finally {
    database.close();
  }
}

await main();
