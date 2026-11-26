import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const entryPoints = ["index", "openai", "anthropic"];
const requiredFiles = entryPoints.flatMap((name) => [`${name}.js`, `${name}.d.ts`]);

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function run(cwd: string, command: string[]): Promise<CommandResult> {
  const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
}

async function runOrFail(cwd: string, command: string[], label: string): Promise<CommandResult> {
  const result = await run(cwd, command);
  if (result.exitCode !== 0) {
    throw new Error(
      `${label} failed with exit code ${result.exitCode}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
    );
  }
  return result;
}

async function assertDistIsBuilt(): Promise<void> {
  const missing: string[] = [];
  for (const file of requiredFiles) {
    if (!(await Bun.file(join(root, "dist", file)).exists())) missing.push(`dist/${file}`);
  }
  if (missing.length > 0) {
    throw new Error(`Missing build output: ${missing.join(", ")}. Run "bun run build" first.`);
  }
}

async function packTarball(workspace: string): Promise<string> {
  const destination = join(workspace, "tarball");
  await mkdir(destination, { recursive: true });
  await runOrFail(root, ["npm", "pack", "--pack-destination", destination], "npm pack");
  const entries = [...new Bun.Glob("*.tgz").scanSync(destination)];
  if (entries.length !== 1) {
    throw new Error(`Expected exactly one tarball in ${destination}, found ${entries.length}.`);
  }
  return join(destination, entries[0]!);
}

async function installIntoConsumer(consumer: string, tarball: string): Promise<void> {
  await writeFile(
    join(consumer, "package.json"),
    `${JSON.stringify({ name: "agent-kit-consumer", private: true, type: "module" }, null, 2)}\n`,
  );
  await runOrFail(
    consumer,
    ["npm", "install", tarball, "--no-audit", "--no-fund", "--loglevel", "error"],
    "npm install of the packed tarball",
  );
}

async function assertVendorSdksAreNotInstalled(consumer: string): Promise<void> {
  const unexpected = ["openai", "@anthropic-ai/sdk"].filter((name) =>
    existsSync(join(consumer, "node_modules", name)),
  );
  if (unexpected.length > 0) {
    throw new Error(
      `Optional peer dependencies were installed automatically: ${unexpected.join(", ")}. The consumer check is meaningless unless they are absent.`,
    );
  }
}

async function assertNodeLoadsEntryPoints(consumer: string): Promise<void> {
  const script = `
const entryPoints = ${JSON.stringify(entryPoints)};
for (const name of entryPoints) {
  const specifier = name === "index" ? "agent-kit" : \`agent-kit/\${name}\`;
  const loaded = await import(specifier);
  if (Object.keys(loaded).length === 0) throw new Error(\`\${specifier} exported nothing\`);
}
const { Agent, defineTool, AgentApprovalQueue, SQLiteRunStore } = await import("agent-kit");
for (const [name, value] of Object.entries({ Agent, defineTool, AgentApprovalQueue, SQLiteRunStore })) {
  if (typeof value !== "function") throw new Error(\`agent-kit did not export a constructor for \${name}\`);
}
const { OpenAIChatCompletionsModel } = await import("agent-kit/openai");
const { AnthropicMessagesModel } = await import("agent-kit/anthropic");
if (typeof OpenAIChatCompletionsModel !== "function") throw new Error("agent-kit/openai is missing OpenAIChatCompletionsModel");
if (typeof AnthropicMessagesModel !== "function") throw new Error("agent-kit/anthropic is missing AnthropicMessagesModel");
console.log(\`node \${process.version} loaded \${entryPoints.length} entry points\`);
`;
  await writeFile(join(consumer, "load.mjs"), script.trimStart());
  await runOrFail(consumer, ["node", "load.mjs"], "Loading the package under Node");
}

async function assertCoreTypesResolveWithoutVendorSdks(consumer: string): Promise<void> {
  await writeFile(
    join(consumer, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          module: "nodenext",
          moduleResolution: "nodenext",
          target: "es2023",
          lib: ["es2023", "dom"],
          strict: true,
          noEmit: true,
          skipLibCheck: false,
          types: [],
        },
        include: ["consumer.ts"],
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(consumer, "consumer.ts"),
    `import { z } from "zod";
import {
  Agent,
  AgentApprovalQueue,
  InMemoryApprovalStore,
  InMemoryRunStore,
  SQLiteRunStore,
  defineTool,
} from "agent-kit";
import type { AgentEvent, AgentRunState, LanguageModel, MessageDelta } from "agent-kit";

const echo = defineTool({
  name: "echo",
  description: "Echo the input back.",
  input: z.object({ text: z.string() }),
  annotations: { readOnly: true, idempotent: true },
  execute: ({ text }) => ({ echoed: text }),
});

const agent = new Agent({ model: {} as LanguageModel, tools: [echo], approvalMode: "pause" });
const queue = new AgentApprovalQueue({ store: new InMemoryApprovalStore() });

export const state: AgentRunState | undefined = undefined;
export const events: AgentEvent[] = [];
export const deltas: MessageDelta[] = [];
export { agent, queue, InMemoryRunStore, SQLiteRunStore };
`,
  );
  const tsc = join(root, "node_modules", ".bin", "tsc");
  await runOrFail(consumer, [tsc, "-p", "tsconfig.json"], "Type-checking the core entry point without vendor SDKs");
}

async function assertTarballShape(tarball: string): Promise<void> {
  const result = await runOrFail(root, ["tar", "-tzf", tarball], "Listing tarball contents");
  const entries = result.stdout.split("\n").filter(Boolean).map((line) => line.replace(/^package\//, ""));
  const forbidden = entries.filter(
    (entry) => entry.startsWith("src/") || entry.includes(".test.") || entry.startsWith("scripts/") || entry.startsWith("examples/"),
  );
  if (forbidden.length > 0) {
    throw new Error(`The tarball ships development files: ${forbidden.slice(0, 5).join(", ")}`);
  }
  const missing = ["package.json", "LICENSE", "README.md", "GLOSSARY.md", ...requiredFiles.map((file) => `dist/${file}`)].filter(
    (entry) => !entries.includes(entry),
  );
  if (missing.length > 0) {
    throw new Error(`The tarball is missing: ${missing.join(", ")}`);
  }
}

async function main(): Promise<void> {
  await assertDistIsBuilt();
  const workspace = await mkdtemp(join(tmpdir(), "agent-kit-package-"));
  const tarball = await packTarball(workspace);
  await assertTarballShape(tarball);

  const consumer = join(workspace, "consumer");
  await mkdir(consumer, { recursive: true });
  await installIntoConsumer(consumer, tarball);
  await assertVendorSdksAreNotInstalled(consumer);
  await assertNodeLoadsEntryPoints(consumer);
  await assertCoreTypesResolveWithoutVendorSdks(consumer);

  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  console.log(
    `verify-package ok: ${entryPoints.length} entry points, runtime dependencies [${Object.keys(manifest.dependencies).join(", ")}], workspace ${workspace}`,
  );
}

await main();
