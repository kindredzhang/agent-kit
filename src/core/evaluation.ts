import type { AgentTrace } from "./trace";

export interface ToolTrajectoryStep {
  turn: number;
  name: string;
}

export type ToolTrajectoryEvaluation =
  | { passed: true; actual: ToolTrajectoryStep[] }
  | {
      passed: false;
      actual: ToolTrajectoryStep[];
      mismatch: { index: number; expected?: ToolTrajectoryStep; actual?: ToolTrajectoryStep };
    };

export function evaluateToolTrajectory(
  traces: readonly AgentTrace[],
  expected: readonly ToolTrajectoryStep[],
): ToolTrajectoryEvaluation {
  const runId = traces[0]?.runId;
  if (traces.some((trace) => trace.runId !== runId)) {
    throw new Error("Tool trajectory evaluation requires traces from one Agent run.");
  }

  const actual = traces.flatMap(({ turns }) => turns.flatMap(({ turn, tools }) =>
    tools.map(({ name }) => ({ turn, name })),
  ));
  const length = Math.max(actual.length, expected.length);
  for (let index = 0; index < length; index += 1) {
    const expectedStep = expected[index];
    const actualStep = actual[index];
    if (expectedStep?.turn !== actualStep?.turn || expectedStep?.name !== actualStep?.name) {
      return { passed: false, actual, mismatch: { index, expected: expectedStep, actual: actualStep } };
    }
  }
  return { passed: true, actual };
}
