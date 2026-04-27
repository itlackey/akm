/**
 * Unit tests for outcome / per-task / corpus / trajectory aggregation.
 */

import { describe, expect, test } from "bun:test";

import type { RunResult } from "./driver";
import {
  aggregateCorpus,
  aggregatePerTask,
  aggregateTrajectory,
  computeCorpusDelta,
  computeOutcomeAggregate,
  computePerTaskDelta,
  type PerTaskMetrics,
} from "./metrics";

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
    assetsLoaded: [],
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

describe("aggregatePerTask", () => {
  test("0 of K passes — tokensPerPass is null, passRate is 0", () => {
    const runs = [
      fakeResult({ seed: 0, outcome: "fail", wallclockMs: 1000 }),
      fakeResult({ seed: 1, outcome: "fail", wallclockMs: 2000 }),
      fakeResult({ seed: 2, outcome: "harness_error", wallclockMs: 3000 }),
    ];
    const m = aggregatePerTask(runs);
    expect(m.passRate).toBe(0);
    expect(m.passAt1).toBe(0);
    expect(m.tokensPerPass).toBeNull();
    expect(m.wallclockMs).toBe(2000);
    expect(m.harnessErrorCount).toBe(1);
    expect(m.budgetExceededCount).toBe(0);
    expect(m.count).toBe(3);
  });

  test("K of K passes — passRate is 1, stdev is 0", () => {
    const runs = Array.from({ length: 5 }, (_, i) =>
      fakeResult({ seed: i, outcome: "pass", tokens: { input: 1000, output: 0 }, wallclockMs: 1000 }),
    );
    const m = aggregatePerTask(runs);
    expect(m.passRate).toBe(1);
    expect(m.passAt1).toBe(1);
    expect(m.tokensPerPass).toBe(1000);
    expect(m.passRateStdev).toBe(0);
  });

  test("partial passes — passRate, stdev, and budget_exceeded count are computed", () => {
    const runs = [
      fakeResult({ seed: 0, outcome: "pass", tokens: { input: 800, output: 200 }, wallclockMs: 1000 }),
      fakeResult({ seed: 1, outcome: "pass", tokens: { input: 1200, output: 300 }, wallclockMs: 1500 }),
      fakeResult({ seed: 2, outcome: "fail", wallclockMs: 2000 }),
      fakeResult({ seed: 3, outcome: "budget_exceeded", wallclockMs: 3000 }),
    ];
    const m = aggregatePerTask(runs);
    expect(m.passRate).toBeCloseTo(0.5);
    expect(m.passAt1).toBe(1);
    expect(m.tokensPerPass).toBeCloseTo((1000 + 1500) / 2);
    expect(m.budgetExceededCount).toBe(1);
    // Sample stdev of [1, 1, 0, 0] over 4 samples = sqrt(4/3 * 0.25) — non-zero.
    expect(m.passRateStdev).toBeGreaterThan(0);
  });

  test("passAt1 honours seed=0 specifically when present", () => {
    const runs = [
      fakeResult({ seed: 1, outcome: "pass" }),
      fakeResult({ seed: 0, outcome: "fail" }),
      fakeResult({ seed: 2, outcome: "pass" }),
    ];
    const m = aggregatePerTask(runs);
    expect(m.passAt1).toBe(0);
  });

  test("empty input returns a zeroed envelope", () => {
    const m = aggregatePerTask([]);
    expect(m.count).toBe(0);
    expect(m.passRate).toBe(0);
    expect(m.tokensPerPass).toBeNull();
  });
});

describe("aggregateCorpus", () => {
  test("weights every task equally regardless of seed count", () => {
    const perTask: Record<string, PerTaskMetrics> = {
      a: {
        passRate: 1,
        passAt1: 1,
        tokensPerPass: 1000,
        wallclockMs: 1000,
        passRateStdev: 0,
        budgetExceededCount: 0,
        harnessErrorCount: 0,
        count: 5,
      },
      b: {
        passRate: 0,
        passAt1: 0,
        tokensPerPass: null,
        wallclockMs: 2000,
        passRateStdev: 0,
        budgetExceededCount: 0,
        harnessErrorCount: 0,
        count: 1,
      },
    };
    const corpus = aggregateCorpus(perTask);
    expect(corpus.passRate).toBeCloseTo(0.5);
    expect(corpus.wallclockMs).toBeCloseTo(1500);
    expect(corpus.tokensPerPass).toBeCloseTo(1000); // null is dropped
  });

  test("tokensPerPass is null when every task has null tokensPerPass", () => {
    const perTask: Record<string, PerTaskMetrics> = {
      a: {
        passRate: 0,
        passAt1: 0,
        tokensPerPass: null,
        wallclockMs: 1000,
        passRateStdev: 0,
        budgetExceededCount: 0,
        harnessErrorCount: 0,
        count: 1,
      },
    };
    const corpus = aggregateCorpus(perTask);
    expect(corpus.tokensPerPass).toBeNull();
  });

  test("empty input returns zeros + null tokens", () => {
    const corpus = aggregateCorpus({});
    expect(corpus.passRate).toBe(0);
    expect(corpus.tokensPerPass).toBeNull();
  });
});

describe("delta helpers", () => {
  test("computeCorpusDelta — akm − noakm", () => {
    const noakm = { passRate: 0.3, tokensPerPass: 18000, wallclockMs: 4000 };
    const akm = { passRate: 0.7, tokensPerPass: 14000, wallclockMs: 3000 };
    const d = computeCorpusDelta(noakm, akm);
    expect(d.passRate).toBeCloseTo(0.4);
    expect(d.tokensPerPass).toBeCloseTo(-4000);
    expect(d.wallclockMs).toBeCloseTo(-1000);
  });

  test("computeCorpusDelta — null tokensPerPass propagates", () => {
    const noakm = { passRate: 0, tokensPerPass: null, wallclockMs: 1 };
    const akm = { passRate: 1, tokensPerPass: 5, wallclockMs: 2 };
    expect(computeCorpusDelta(noakm, akm).tokensPerPass).toBeNull();
  });

  test("computePerTaskDelta — same null-safety rule", () => {
    const noakm: PerTaskMetrics = {
      passRate: 0,
      passAt1: 0,
      tokensPerPass: null,
      wallclockMs: 0,
      passRateStdev: 0,
      budgetExceededCount: 0,
      harnessErrorCount: 0,
      count: 1,
    };
    const akm: PerTaskMetrics = {
      passRate: 1,
      passAt1: 1,
      tokensPerPass: 1000,
      wallclockMs: 100,
      passRateStdev: 0,
      budgetExceededCount: 0,
      harnessErrorCount: 0,
      count: 1,
    };
    expect(computePerTaskDelta(noakm, akm).tokensPerPass).toBeNull();
  });
});

describe("aggregateTrajectory", () => {
  test("returns null/0 on empty input", () => {
    const t = aggregateTrajectory([]);
    expect(t.correctAssetLoaded).toBeNull();
    expect(t.feedbackRecorded).toBe(0);
  });

  test("correctAssetLoaded is null when no run had a known goldRef", () => {
    const runs = [
      fakeResult({ trajectory: { correctAssetLoaded: null, feedbackRecorded: false } }),
      fakeResult({ trajectory: { correctAssetLoaded: null, feedbackRecorded: true } }),
    ];
    const t = aggregateTrajectory(runs);
    expect(t.correctAssetLoaded).toBeNull();
    expect(t.feedbackRecorded).toBeCloseTo(0.5);
  });

  test("correctAssetLoaded is fraction over runs with goldRef", () => {
    const runs = [
      fakeResult({ trajectory: { correctAssetLoaded: true, feedbackRecorded: false } }),
      fakeResult({ trajectory: { correctAssetLoaded: false, feedbackRecorded: false } }),
      fakeResult({ trajectory: { correctAssetLoaded: null, feedbackRecorded: false } }),
    ];
    const t = aggregateTrajectory(runs);
    expect(t.correctAssetLoaded).toBeCloseTo(0.5);
    expect(t.feedbackRecorded).toBe(0);
  });
});
