#!/usr/bin/env bun
import { spawn } from "node:child_process";

const examples = [
  { file: "tool-loop.ts", what: "tool loop, parallel tools, trace and trajectory evaluation" },
  { file: "structured-output.ts", what: "schema-validated final answer" },
  { file: "approval.ts", what: "approval pause, resume by run id, rejection" },
  { file: "durable-recovery.ts", what: "crash recovery, replay window, idempotency key" },
  { file: "timeouts.ts", what: "tool timeout and wall-clock budget" },
  { file: "otel-export.ts", what: "OpenTelemetry spans following the GenAI semantic conventions" },
];

const selected = process.argv.slice(2);
const toRun = selected.length > 0
  ? examples.filter((item) => selected.some((name) => item.file.startsWith(name)))
  : examples;

if (toRun.length === 0) {
  console.error(`No example matched: ${selected.join(", ")}`);
  console.error(`Available: ${examples.map((item) => item.file).join(", ")}`);
  process.exit(1);
}

if (!process.env.OPENAI_BASE_URL || !process.env.OPENAI_API_KEY || !process.env.AGENTKIT_MODEL) {
  console.error("Set OPENAI_BASE_URL, OPENAI_API_KEY and AGENTKIT_MODEL, then rerun.");
  process.exit(2);
}

let failed = 0;
for (const example of toRun) {
  console.log(`\n${"═".repeat(72)}\n${example.file} — ${example.what}\n${"═".repeat(72)}\n`);
  const code = await new Promise<number>((resolve) => {
    const child = spawn("bun", ["run", new URL(example.file, import.meta.url).pathname], {
      stdio: "inherit",
      env: process.env,
    });
    child.on("exit", (exitCode) => resolve(exitCode ?? 1));
  });
  if (code !== 0) {
    failed += 1;
    console.error(`\n${example.file} exited with ${code}`);
  }
}

console.log(`\n${toRun.length - failed}/${toRun.length} examples passed`);
if (failed > 0) process.exitCode = 1;
