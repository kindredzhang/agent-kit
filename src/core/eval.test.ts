import { expect, test } from "bun:test";
import { z } from "zod";
import { Agent, defineTool, evaluateAgentCases, observeAgentEvents } from "../index.js";
import type { AgentEvalCase, AgentEvalObservation, LanguageModel, ModelStreamEvent } from "../index.js";

function scriptedModel(toolName?: string): LanguageModel {
  let calls = 0;
  return {
    provider: "openai-chat-completions",
    async *stream(): AsyncGenerator<ModelStreamEvent> {
      calls += 1;
      if (calls === 1 && toolName) {
        yield { type: "tool.call.completed", toolCall: { id: "call", name: toolName, input: {} } };
        yield { type: "finish", finishReason: "tool_calls" };
      } else {
        yield { type: "text.delta", delta: "done" };
        yield { type: "finish", finishReason: "stop" };
      }
    },
  };
}

const lookup = defineTool({
  name: "lookup",
  description: "lookup",
  input: z.object({}),
  annotations: { readOnly: true },
  execute: () => "ok",
});

function run(toolName?: string) {
  return async (evalCase: AgentEvalCase<string>): Promise<AgentEvalObservation> =>
    observeAgentEvents(new Agent({ model: scriptedModel(toolName), tools: [lookup] }).stream({
      messages: [{ role: "user", content: evalCase.input }],
    }));
}

test("passes a case that matches its stop reason and tool trajectory", async () => {
  const cases: AgentEvalCase<string>[] = [{
    name: "uses lookup",
    input: "go",
    expect: { stopReason: "completed", toolTrajectory: [{ turn: 1, name: "lookup" }] },
  }];
  const report = await evaluateAgentCases(cases, run("lookup"));
  expect(report).toMatchObject({ passed: true, summary: { total: 1, passed: 1, failed: 0 } });
  expect(report.results).toEqual([{ name: "uses lookup", passed: true, failures: [] }]);
});

test("reports a stop reason mismatch without aborting other cases", async () => {
  const cases: AgentEvalCase<string>[] = [
    { name: "wrong stop", input: "a", expect: { stopReason: "refusal" } },
    { name: "right stop", input: "b", expect: { stopReason: "completed" } },
  ];
  const report = await evaluateAgentCases(cases, run());
  expect(report.passed).toBe(false);
  expect(report.summary).toEqual({ total: 2, passed: 1, failed: 1 });
  expect(report.results[0]).toMatchObject({
    name: "wrong stop",
    failures: [{ check: "stop_reason", expected: "refusal", actual: "completed" }],
  });
  expect(report.results[1]).toMatchObject({ passed: true });
});

test("reports a trajectory mismatch with the first differing step", async () => {
  const cases: AgentEvalCase<string>[] = [{
    name: "missing call",
    input: "go",
    expect: { toolTrajectory: [{ turn: 1, name: "lookup" }] },
  }];
  const report = await evaluateAgentCases(cases, run());
  expect(report.results[0]?.failures[0]).toEqual({
    check: "tool_trajectory",
    expected: [{ turn: 1, name: "lookup" }],
    actual: [],
    mismatch: { index: 0, expected: { turn: 1, name: "lookup" }, actual: undefined },
  });
});

test("compares structured output by value, ignoring key order", async () => {
  const answer = z.object({ sentiment: z.string(), confidence: z.number() });
  const model: LanguageModel = {
    provider: "openai-chat-completions",
    async *stream(): AsyncGenerator<ModelStreamEvent> {
      yield { type: "tool.call.completed", toolCall: { id: "a", name: "final_answer", input: { confidence: 1, sentiment: "positive" } } };
      yield { type: "finish", finishReason: "tool_calls" };
    },
  };
  const observe = async ({ input }: AgentEvalCase<string>) =>
    observeAgentEvents(new Agent({ model, outputSchema: answer }).stream({
      messages: [{ role: "user", content: input }],
    }));

  const passing = await evaluateAgentCases([{
    name: "value equal",
    input: "go",
    expect: { structuredOutput: { sentiment: "positive", confidence: 1 } },
  }], observe);
  expect(passing.passed).toBe(true);

  const failing = await evaluateAgentCases([{
    name: "nested mismatch",
    input: "go",
    expect: { structuredOutput: { sentiment: "negative", confidence: 1 } },
  }], observe);
  expect(failing.results[0]?.failures[0]).toEqual({
    check: "structured_output",
    expected: { sentiment: "negative", confidence: 1 },
    actual: { confidence: 1, sentiment: "positive" },
  });
});

test("reports a missing structured output instead of passing silently", async () => {
  const report = await evaluateAgentCases([{
    name: "expects output",
    input: "go",
    expect: { structuredOutput: { ok: true } },
  }], run());
  expect(report.results[0]?.failures[0]).toEqual({
    check: "structured_output",
    expected: { ok: true },
    actual: undefined,
  });
});

test("turns an observation error into a case failure and continues", async () => {
  const report = await evaluateAgentCases([
    { name: "throws", input: "a", expect: { stopReason: "completed" } },
    { name: "works", input: "b", expect: { stopReason: "completed" } },
  ], async (evalCase) => {
    if (evalCase.name === "throws") throw new Error("model unavailable");
    return run()(evalCase);
  });
  expect(report.summary).toEqual({ total: 2, passed: 1, failed: 1 });
  expect(report.results[0]?.failures[0]).toMatchObject({ check: "observation", error: { message: "model unavailable" } });
});

test("rejects duplicate case names", async () => {
  const cases: AgentEvalCase<string>[] = [
    { name: "same", input: "a", expect: {} },
    { name: "same", input: "b", expect: {} },
  ];
  expect(evaluateAgentCases(cases, run())).rejects.toThrow("same");
});

test("supports an empty suite while reporting the count", async () => {
  const report = await evaluateAgentCases([], run());
  expect(report).toEqual({ passed: true, summary: { total: 0, passed: 0, failed: 0 }, results: [] });
});

test("checks only the expectations a case declares", async () => {
  const report = await evaluateAgentCases([{ name: "no checks", input: "go", expect: {} }], run("lookup"));
  expect(report.passed).toBe(true);
});
