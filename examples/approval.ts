import { Database } from "bun:sqlite";
import { z } from "zod";
import { Agent, SQLiteRunStore, defineTool } from "../src/index";
import { createExampleModel, describeSettings } from "./shared";

const sent: string[] = [];

const sendEmail = defineTool({
  name: "send_email",
  description: "Send an email to a customer. This has an external side effect.",
  input: z.object({
    to: z.string().email(),
    subject: z.string().min(1),
    body: z.string().min(1),
  }),
  annotations: { readOnly: false },
  execute: ({ to, subject }) => {
    sent.push(`${to}: ${subject}`);
    return { delivered: true, to, subject };
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
      instructions: "You are a support assistant. Send the email when asked, then confirm.",
      tools: [sendEmail],
      approvalMode: "pause",
      runStore,
      maxTurns: 4,
    });

    console.log("phase 1 — the run pauses for approval and the checkpoint keeps the pending call");
    let runId: string | undefined;
    let toolCallId: string | undefined;
    for await (const event of agent.stream({
      messages: [{
        role: "user",
        content: "Email alice@example.com with the subject 'Order shipped' and a one-line body.",
      }],
    })) {
      if (event.type === "tool.approval.requested") {
        console.log(`  [approval] ${event.tool.name} from ${alice(event.input)}`);
      }
      if (event.type === "agent.paused") {
        runId = event.runId;
        toolCallId = event.pendingToolCall.id;
        console.log(`  [paused] waiting on ${event.pendingToolCall.name}#${event.pendingToolCall.id}`);
      }
    }
    if (!runId || !toolCallId) throw new Error("The example expected an approval pause.");
    console.log(`  emails sent: ${sent.length}`);
    const saved = await runStore.load(runId);
    console.log(`  checkpoint holds pending approval: ${saved?.pendingApproval?.toolCallId === toolCallId}`);

    console.log("\nphase 2 — a different process loads the checkpoint and approves");
    const resumedEvents = [];
    for await (const event of agent.resume({
      runId,
      approval: { toolCallId, decision: "approved" },
    })) {
      resumedEvents.push(event);
      if (event.type === "tool.execution.started") {
        console.log(`  [execute] ${event.name}`);
      }
      if (event.type === "agent.completed") {
        console.log(`  [done] ${event.message.content.trim().replaceAll("\n", " ")}`);
      }
    }
    console.log(`  emails sent: ${sent.length}`);
    console.log(`  approval requested again: ${resumedEvents.some((event) => event.type === "tool.approval.requested")}`);
    console.log(`  checkpoint after completion: ${await runStore.load(runId) === undefined ? "none" : "present"}`);

    console.log("\nphase 3 — a rejected call never executes");
    const rejectRun = new Agent({
      model,
      instructions: "You are a support assistant. Send the email when asked, then confirm.",
      tools: [sendEmail],
      approvalMode: "pause",
      runStore,
      maxTurns: 4,
    });
    let rejectId: string | undefined;
    let rejectCallId: string | undefined;
    for await (const event of rejectRun.stream({
      messages: [{
        role: "user",
        content: "Email bob@example.com with the subject 'Refund issued' and the body 'Your refund of 20 USD has been issued.'",
      }],
    })) {
      if (event.type === "agent.paused") {
        rejectId = event.runId;
        rejectCallId = event.pendingToolCall.id;
      }
    }
    if (!rejectId || !rejectCallId) throw new Error("The example expected a second pause.");
    const before = sent.length;
    for await (const event of rejectRun.resume({
      runId: rejectId,
      approval: { toolCallId: rejectCallId, decision: "rejected" },
    })) {
      if (event.type === "tool.approval.resolved") {
        console.log(`  [approval] ${event.decision}${event.reason ? ` (${event.reason})` : ""}`);
      }
    }
    console.log(`  emails sent by the rejected run: ${sent.length - before}`);
  } finally {
    database.close();
  }
}

function alice(input: unknown): string {
  const value = input as { to?: string; subject?: string };
  return `${value.to ?? "?"} / "${value.subject ?? "?"}"`;
}

await main();
