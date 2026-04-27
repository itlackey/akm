/**
 * Unit tests for `computeOutcomeAggregate`.
 */

import { describe, expect, test } from "bun:test";

import type { RunResult } from "./driver";
import { computeOutcomeAggregate } from "./metrics";

function fakeResult(overrides: Partial<RunResult>): RunResult {
  return {
    schemaVersion: 1,
    taskId: "t",
    arm: "akm",
    seed: 0,
    model: "m",
    outcome: "pass",
    tokens: { input: 0, output: 0 },
    wallclockMs: 0,
    trajectory: { correctAssetLoaded: null, feedbackRecorded: null },
    events: [],
    verifierStdout: "",
    verifierExitCode: 0,
    ...overrides,
  };
}

describe("computeOutcomeAggregate", () => {
  test("returns zeros on empty input", () => {
    expect(computeOutcomeAggregate([])).toEqual({
      passRate: 0,
      tokensPerPass: 0,
      wallclockMs: 0,
      budgetExceeded: 0,
    });
  });

  test("computes passRate, tokensPerPass, wallclockMs across mixed outcomes", () => {
    const results = [
      fakeResult({ outcome: "pass", tokens: { input: 1000, output: 500 }, wallclockMs: 1000 }),
      fakeResult({ outcome: "pass", tokens: { input: 2000, output: 1000 }, wallclockMs: 2000 }),
      fakeResult({ outcome: "fail", tokens: { input: 500, output: 200 }, wallclockMs: 1500 }),
      fakeResult({ outcome: "budget_exceeded", tokens: { input: 100, output: 50 }, wallclockMs: 500 }),
    ];
    const agg = computeOutcomeAggregate(results);
    expect(agg.passRate).toBeCloseTo(0.5);
    expect(agg.tokensPerPass).toBeCloseTo((1500 + 3000) / 2);
    expect(agg.wallclockMs).toBeCloseTo((1000 + 2000 + 1500 + 500) / 4);
    expect(agg.budgetExceeded).toBe(1);
  });

  test("tokensPerPass is 0 (not NaN) when no runs passed", () => {
    const results = [fakeResult({ outcome: "fail", wallclockMs: 100 })];
    const agg = computeOutcomeAggregate(results);
    expect(agg.passRate).toBe(0);
    expect(agg.tokensPerPass).toBe(0);
  });
});
