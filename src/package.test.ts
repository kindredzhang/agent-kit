import { beforeAll, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const dist = join(root, "dist");

async function readJson(relativePath: string): Promise<any> {
  return JSON.parse(await readFile(join(root, relativePath), "utf8"));
}

beforeAll(async () => {
  const build = Bun.spawn(["bunx", "tsc", "-p", "tsconfig.build.json"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (await build.exited !== 0) {
    throw new Error(`Building the package failed: ${await new Response(build.stderr).text()}`);
  }
}, 120_000);

test("declares a publishable package with typed subpath exports", async () => {
  const manifest = await readJson("package.json");

  expect(manifest.private).toBeUndefined();
  expect(manifest.exports["."]).toEqual({
    types: "./dist/index.d.ts",
    import: "./dist/index.js",
  });
  expect(Object.keys(manifest.exports)).toEqual([".", "./openai", "./anthropic", "./otel", "./testing"]);
  expect(Object.keys(manifest.dependencies)).toEqual(["zod"]);
  expect(manifest.peerDependenciesMeta.openai.optional).toBe(true);
  expect(manifest.peerDependenciesMeta["@anthropic-ai/sdk"].optional).toBe(true);
  expect(manifest.peerDependenciesMeta["@opentelemetry/api"].optional).toBe(true);
  expect(manifest.files).toContain("dist");
});

test("keeps vendor SDKs out of the core type surface", async () => {
  const declarations = [
    "index.d.ts",
    "core/agent.d.ts",
    "core/types.d.ts",
    "core/tools.d.ts",
    "core/approval.d.ts",
    "storage/sqlite.d.ts",
    "storage/sqlite-run-store.d.ts",
    "storage/sqlite-session.d.ts",
    "storage/sqlite-approval-store.d.ts",
  ];

  for (const declaration of declarations) {
    const source = await readFile(join(dist, declaration), "utf8");
    expect(source).not.toContain('from "openai"');
    expect(source).not.toContain('from "@anthropic-ai/sdk"');
    expect(source).not.toContain('from "@opentelemetry/api"');
    expect(source).not.toContain('from "bun:sqlite"');
  }
});

test("emits declarations that resolve without bundler-only resolution", async () => {
  const unresolved: string[] = [];

  for (const declaration of ["index.d.ts", "openai.d.ts", "anthropic.d.ts", "otel.d.ts", "testing.d.ts"]) {
    const source = await readFile(join(dist, declaration), "utf8");
    for (const match of source.matchAll(/from "(\.[^"]*)"/g)) {
      if (!match[1]!.endsWith(".js")) unresolved.push(`${declaration}: ${match[1]}`);
    }
  }

  expect(unresolved).toEqual([]);
});
