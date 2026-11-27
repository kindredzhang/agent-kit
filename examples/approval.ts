import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { Agent, AgentApprovalQueue, SQLiteApprovalStore, SQLiteRunStore, defineTool } from "../src/index.js";
import { createExampleModel, describeSettings } from "./shared.js";

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

  const directory = await mkdtemp(join(tmpdir(), "rein-approval-"));
  const databasePath = join(directory, "state.sqlite");

  try {
    const worker = new Database(databasePath);
    const reviewer = new Database(databasePath);
    try {
      const agentFor = () => new Agent({
        model,
        instructions: "You are a support assistant. Send the email when asked, then confirm.",
        tools: [sendEmail],
        approvalMode: "pause",
        runStore: new SQLiteRunStore(worker),
        maxTurns: 4,
      });
      const queue = new AgentApprovalQueue({ store: new SQLiteApprovalStore(worker) });

      console.log("phase 1 — the run pauses and the queue records the pending call");
      let runId: string | undefined;
      for await (const event of queue.observe(agentFor().stream({
        messages: [{
          role: "user",
          content: "Email alice@example.com with the subject 'Order shipped' and a one-line body.",
        }],
      }))) {
        if (event.type === "agent.paused") {
          runId = event.runId;
          console.log(`  [paused] waiting on ${event.pendingToolCall.name}#${event.pendingToolCall.id}`);
        }
      }
      if (!runId) throw new Error("The example expected an approval pause.");
      console.log(`  emails sent: ${sent.length}`);

      console.log("\nphase 2 — another process lists the queue and approves");
      const reviewerQueue = new AgentApprovalQueue({ store: new SQLiteApprovalStore(reviewer) });
      const pending = await reviewerQueue.list();
      if (pending.length !== 1) throw new Error("The example expected one pending approval request.");
      const request = pending[0]!;
      console.log(`  [queue] ${request.tool.name} from ${alice(request.input)}`);
      await reviewerQueue.decide({
        runId: request.runId,
        approvalId: request.approvalId,
        decision: "approved",
      });
      console.log(`  [queue] decided: ${(await reviewerQueue.decisionFor(request.runId))?.decision}`);

      const resumedEvents = [];
      for await (const event of queue.resume(agentFor(), request.runId)) {
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
      console.log(`  queue after completion: ${(await queue.list({ pendingOnly: false })).length === 0 ? "empty" : "present"}`);

      console.log("\nphase 3 — a rejected call never executes");
      let rejectRunId: string | undefined;
      for await (const event of queue.observe(agentFor().stream({
        messages: [{
          role: "user",
          content: "Email bob@example.com with the subject 'Refund issued' and the body 'Your refund of 20 USD has been issued.'",
        }],
      }))) {
        if (event.type === "agent.paused") rejectRunId = event.runId;
      }
      if (!rejectRunId) throw new Error("The example expected a second pause.");

      const [rejectRequest] = await reviewerQueue.list();
      if (!rejectRequest) throw new Error("The example expected a second approval request.");
      await reviewerQueue.decide({
        runId: rejectRequest.runId,
        approvalId: rejectRequest.approvalId,
        decision: "rejected",
      });

      const before = sent.length;
      for await (const event of queue.resume(agentFor(), rejectRequest.runId)) {
        if (event.type === "tool.approval.resolved") {
          console.log(`  [approval] ${event.decision}${event.reason ? ` (${event.reason})` : ""}`);
        }
      }
      console.log(`  emails sent by the rejected run: ${sent.length - before}`);
      console.log(`  queue after rejection: ${(await queue.list({ pendingOnly: false })).length === 0 ? "empty" : "present"}`);
    } finally {
      worker.close();
      reviewer.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function alice(input: unknown): string {
  const value = input as { to?: string; subject?: string };
  return `${value.to ?? "?"} / "${value.subject ?? "?"}"`;
}

await main();
