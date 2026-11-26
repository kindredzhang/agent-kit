import type { AgentEvent, AgentStopReason } from "./agent.js";
import type { ToolTrajectoryStep } from "./evaluation.js";
import type { JsonValue, TokenUsage } from "./types.js";

export interface AgentEvalObservation {
  stopReason: AgentStopReason;
  structuredOutput?: JsonValue;
  toolTrajectory: ToolTrajectoryStep[];
  text: string;
  usage?: TokenUsage;
  error?: Error;
}

export interface AgentEvalExpectation {
  stopReason?: AgentStopReason;
  structuredOutput?: JsonValue;
  toolTrajectory?: readonly ToolTrajectoryStep[];
  textIncludes?: string;
}

export interface AgentEvalCase<TInput = unknown> {
  name: string;
  input: TInput;
  expect: AgentEvalExpectation;
}

export type AgentEvalFailure =
  | { check: "stop_reason"; expected: AgentStopReason; actual: AgentStopReason }
  | { check: "text"; expected: string; actual: string }
  | {
      check: "structured_output";
      expected: JsonValue;
      actual: JsonValue | undefined;
    }
  | {
      check: "tool_trajectory";
      expected: readonly ToolTrajectoryStep[];
      actual: ToolTrajectoryStep[];
      mismatch: { index: number; expected?: ToolTrajectoryStep; actual?: ToolTrajectoryStep };
    }
  | { check: "observation"; error: Error };

export interface AgentEvalResult {
  name: string;
  passed: boolean;
  failures: AgentEvalFailure[];
}

export interface AgentEvalReport {
  passed: boolean;
  summary: { total: number; passed: number; failed: number };
  results: AgentEvalResult[];
}

export type AgentEvalObserver<TInput> = (
  evalCase: AgentEvalCase<TInput>,
  signal: AbortSignal,
) => Promise<AgentEvalObservation>;

function sameJsonValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => sameJsonValue(value, right[index]));
  }
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (leftKeys.length !== rightKeys.length || !leftKeys.every((key, index) => key === rightKeys[index])) {
    return false;
  }
  return leftKeys.every((key) =>
    sameJsonValue((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]),
  );
}

export function observeAgentEvents(events: AsyncIterable<AgentEvent>): Promise<AgentEvalObservation> {
  return (async () => {
    const toolTrajectory: ToolTrajectoryStep[] = [];
    let text = "";
    let stopReason: AgentStopReason | undefined;
    let structuredOutput: JsonValue | undefined;
    let usage: TokenUsage | undefined;
    let error: Error | undefined;

    for await (const event of events) {
      switch (event.type) {
        case "message.delta":
          if (event.delta.type === "text") text += event.delta.text;
          break;
        case "tool.execution.started":
          toolTrajectory.push({ turn: event.turn, name: event.name });
          break;
        case "agent.completed":
          stopReason = event.stopReason;
          if (event.structuredOutput !== undefined) structuredOutput = event.structuredOutput;
          if (event.usage) usage = event.usage;
          break;
        case "agent.stopped":
          stopReason = event.stopReason;
          if (event.usage) usage = event.usage;
          break;
        case "agent.failed":
          stopReason = event.stopReason;
          error = event.error;
          if (event.usage) usage = event.usage;
          break;
      }
    }

    return {
      stopReason: stopReason ?? "error",
      toolTrajectory,
      text,
      ...(structuredOutput !== undefined ? { structuredOutput } : {}),
      ...(usage ? { usage } : {}),
      ...(error ? { error } : {}),
    };
  })();
}

function compareCase(evalCase: AgentEvalCase, observation: AgentEvalObservation): AgentEvalFailure[] {
  const failures: AgentEvalFailure[] = [];
  const expected = evalCase.expect;

  if (expected.stopReason !== undefined && expected.stopReason !== observation.stopReason) {
    failures.push({ check: "stop_reason", expected: expected.stopReason, actual: observation.stopReason });
  }
  if (expected.textIncludes !== undefined && !observation.text.includes(expected.textIncludes)) {
    failures.push({ check: "text", expected: expected.textIncludes, actual: observation.text });
  }
  if (expected.structuredOutput !== undefined &&
    !sameJsonValue(expected.structuredOutput, observation.structuredOutput)) {
    failures.push({
      check: "structured_output",
      expected: expected.structuredOutput,
      actual: observation.structuredOutput,
    });
  }
  if (expected.toolTrajectory !== undefined) {
    const actual = observation.toolTrajectory;
    const length = Math.max(actual.length, expected.toolTrajectory.length);
    for (let index = 0; index < length; index += 1) {
      const expectedStep = expected.toolTrajectory[index];
      const actualStep = actual[index];
      if (expectedStep?.turn !== actualStep?.turn || expectedStep?.name !== actualStep?.name) {
        failures.push({
          check: "tool_trajectory",
          expected: expected.toolTrajectory,
          actual,
          mismatch: { index, expected: expectedStep, actual: actualStep },
        });
        break;
      }
    }
  }

  return failures;
}

export async function evaluateAgentCases<TInput>(
  cases: readonly AgentEvalCase<TInput>[],
  observe: AgentEvalObserver<TInput>,
): Promise<AgentEvalReport> {
  const names = new Set<string>();
  for (const evalCase of cases) {
    if (names.has(evalCase.name)) throw new Error(`Duplicate Agent eval case name: ${evalCase.name}.`);
    names.add(evalCase.name);
  }

  const results: AgentEvalResult[] = [];
  for (const evalCase of cases) {
    const controller = new AbortController();
    try {
      const observation = await observe(evalCase, controller.signal);
      const failures = compareCase(evalCase, observation);
      results.push({ name: evalCase.name, passed: failures.length === 0, failures });
    } catch (error) {
      results.push({
        name: evalCase.name,
        passed: false,
        failures: [{ check: "observation", error: error instanceof Error ? error : new Error(String(error)) }],
      });
    }
  }

  const passed = results.filter(({ passed: resultPassed }) => resultPassed).length;
  return {
    passed: passed === results.length,
    summary: { total: results.length, passed, failed: results.length - passed },
    results,
  };
}
