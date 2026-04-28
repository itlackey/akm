/**
 * Unit tests for outcome / per-task / corpus / trajectory aggregation.
 */

import { describe, expect, test } from "bun:test";

import type { RunResult } from "./driver";
import {
  aggregateCorpus,
  aggregatePerTask,
  aggregateTrajectory,
  computeAssetRegressionCandidates,
  computeCorpusDelta,
  computeDomainAggregates,
  computeNegativeTransfer,
  computeOutcomeAggregate,
  computePerTaskDelta,
  domainOfTaskId,
  type PerTaskMetrics,
} from "./metrics";

function ptm(overrides: Partial<PerTaskMetrics> = {}): PerTaskMetrics {
  return {
    passRate: 0,
    passAt1: 0,
    tokensPerPass: null,
    wallclockMs: 0,
    passRateStdev: 0,
    budgetExceededCount: 0,
    harnessErrorCount: 0,
    count: 1,
    runsWithMeasuredTokens: 0,
    ...overrides,
  };
}

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
      runsWithMeasuredTokens: 0,
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

  test("missing token measurement is NOT silently treated as zero (issue #252)", () => {
    // Two passes: one parsed at 1000, one missing measurement. The mean must
    // be 1000 (the measured pass), not (1000+0)/2 = 500.
    const results = [
      fakeResult({
        outcome: "pass",
        tokens: { input: 700, output: 300 },
        tokenMeasurement: "parsed",
      }),
      fakeResult({
        outcome: "pass",
        tokens: { input: 0, output: 0 },
        tokenMeasurement: "missing",
      }),
    ];
    const agg = computeOutcomeAggregate(results);
    expect(agg.passRate).toBeCloseTo(1);
    expect(agg.tokensPerPass).toBeCloseTo(1000);
    expect(agg.runsWithMeasuredTokens).toBe(1);
  });

  test("unsupported token measurement is also skipped from token aggregation", () => {
    const results = [
      fakeResult({
        outcome: "pass",
        tokens: { input: 0, output: 0 },
        tokenMeasurement: "unsupported",
      }),
    ];
    const agg = computeOutcomeAggregate(results);
    // No measured passes → tokensPerPass collapses to 0, but runsWithMeasuredTokens=0
    // signals that the 0 is "unknown", not "free".
    expect(agg.tokensPerPass).toBe(0);
    expect(agg.runsWithMeasuredTokens).toBe(0);
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
    expect(m.runsWithMeasuredTokens).toBe(0);
  });

  test("aggregatePerTask: passes with missing measurement do NOT pull tokensPerPass to zero", () => {
    const runs = [
      fakeResult({
        seed: 0,
        outcome: "pass",
        tokens: { input: 800, output: 200 },
        tokenMeasurement: "parsed",
        wallclockMs: 1000,
      }),
      fakeResult({
        seed: 1,
        outcome: "pass",
        tokens: { input: 0, output: 0 },
        tokenMeasurement: "missing",
        wallclockMs: 1000,
      }),
    ];
    const m = aggregatePerTask(runs);
    expect(m.passRate).toBe(1);
    // Mean is over the single measured pass, not (1000 + 0) / 2.
    expect(m.tokensPerPass).toBeCloseTo(1000);
    expect(m.runsWithMeasuredTokens).toBe(1);
    expect(m.count).toBe(2);
  });

  test("aggregatePerTask: tokensPerPass is null when every pass has missing measurement", () => {
    const runs = [
      fakeResult({
        seed: 0,
        outcome: "pass",
        tokens: { input: 0, output: 0 },
        tokenMeasurement: "missing",
      }),
      fakeResult({
        seed: 1,
        outcome: "pass",
        tokens: { input: 0, output: 0 },
        tokenMeasurement: "unsupported",
      }),
    ];
    const m = aggregatePerTask(runs);
    expect(m.passRate).toBe(1);
    expect(m.tokensPerPass).toBeNull();
    expect(m.runsWithMeasuredTokens).toBe(0);
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
        runsWithMeasuredTokens: 5,
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
        runsWithMeasuredTokens: 0,
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
        runsWithMeasuredTokens: 0,
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
      runsWithMeasuredTokens: 0,
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
      runsWithMeasuredTokens: 1,
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

describe("domainOfTaskId", () => {
  test("returns the segment before the first slash", () => {
    expect(domainOfTaskId("docker-homelab/redis-healthcheck")).toBe("docker-homelab");
  });

  test("falls back to 'unknown' when there is no slash", () => {
    expect(domainOfTaskId("noslash")).toBe("unknown");
  });

  test("falls back to 'unknown' when the slash is at index 0", () => {
    expect(domainOfTaskId("/leading")).toBe("unknown");
  });
});

describe("computeNegativeTransfer", () => {
  test("returns zero count and severity when no regressions are present", () => {
    const tasks = [
      { id: "d/a", noakm: ptm({ passRate: 0.4 }), akm: ptm({ passRate: 0.8 }) },
      { id: "d/b", noakm: ptm({ passRate: 0.5 }), akm: ptm({ passRate: 0.5 }) },
    ];
    const out = computeNegativeTransfer(tasks);
    expect(out.count).toBe(0);
    expect(out.severity).toBe(0);
    expect(out.topRegressedTasks).toEqual([]);
  });

  test("captures a single regression with correct delta and severity", () => {
    const tasks = [
      { id: "d/a", noakm: ptm({ passRate: 0.4 }), akm: ptm({ passRate: 0.8 }) },
      { id: "d/regressed", noakm: ptm({ passRate: 0.6 }), akm: ptm({ passRate: 0.2 }) },
    ];
    const out = computeNegativeTransfer(tasks);
    expect(out.count).toBe(1);
    expect(out.severity).toBeCloseTo(0.4);
    expect(out.topRegressedTasks).toHaveLength(1);
    const row = out.topRegressedTasks[0];
    if (!row) throw new Error("expected row");
    expect(row.taskId).toBe("d/regressed");
    expect(row.domain).toBe("d");
    expect(row.delta).toBeCloseTo(-0.4);
    expect(row.severity).toBeCloseTo(0.4);
  });

  test("multiple regressions are sorted by severity desc with deterministic tiebreak", () => {
    const tasks = [
      // Mild regression -0.1.
      { id: "alpha/x", noakm: ptm({ passRate: 0.6 }), akm: ptm({ passRate: 0.5 }) },
      // Tied severity -0.3 (first tiebreaks by taskId asc).
      { id: "beta/y", noakm: ptm({ passRate: 0.8 }), akm: ptm({ passRate: 0.5 }) },
      { id: "alpha/z", noakm: ptm({ passRate: 0.8 }), akm: ptm({ passRate: 0.5 }) },
      // Improvement (no regression).
      { id: "alpha/w", noakm: ptm({ passRate: 0.1 }), akm: ptm({ passRate: 0.9 }) },
    ];
    const out = computeNegativeTransfer(tasks);
    expect(out.count).toBe(3);
    expect(out.severity).toBeCloseTo(0.7);
    expect(out.topRegressedTasks.map((r) => r.taskId)).toEqual(["alpha/z", "beta/y", "alpha/x"]);
  });

  test("a task with equal pass rate is not counted as regressed", () => {
    const tasks = [{ id: "d/eq", noakm: ptm({ passRate: 0.5 }), akm: ptm({ passRate: 0.5 }) }];
    expect(computeNegativeTransfer(tasks).count).toBe(0);
  });
});

describe("computeDomainAggregates", () => {
  test("groups tasks by domain prefix", () => {
    const tasks = [
      {
        id: "alpha/a",
        noakm: ptm({ passRate: 0.4, tokensPerPass: 10000, wallclockMs: 1000 }),
        akm: ptm({ passRate: 0.8, tokensPerPass: 8000, wallclockMs: 900 }),
      },
      {
        id: "alpha/b",
        noakm: ptm({ passRate: 0.6, tokensPerPass: 12000, wallclockMs: 2000 }),
        akm: ptm({ passRate: 0.4, tokensPerPass: 9000, wallclockMs: 1500 }),
      },
      {
        id: "beta/c",
        noakm: ptm({ passRate: 0.2, tokensPerPass: null, wallclockMs: 500 }),
        akm: ptm({ passRate: 0.5, tokensPerPass: 5000, wallclockMs: 600 }),
      },
    ];
    const rows = computeDomainAggregates(tasks);
    expect(rows.map((r) => r.domain)).toEqual(["alpha", "beta"]);

    const alpha = rows.find((r) => r.domain === "alpha");
    if (!alpha) throw new Error("alpha missing");
    expect(alpha.taskCount).toBe(2);
    expect(alpha.regressionCount).toBe(1);
    expect(alpha.passRateNoakm).toBeCloseTo(0.5);
    expect(alpha.passRateAkm).toBeCloseTo(0.6);
    expect(alpha.passRateDelta).toBeCloseTo(0.1);
    expect(alpha.tokensPerPassDelta).toBeCloseTo(8500 - 11000);
    expect(alpha.wallclockMsDelta).toBeCloseTo(1200 - 1500);

    const beta = rows.find((r) => r.domain === "beta");
    if (!beta) throw new Error("beta missing");
    expect(beta.regressionCount).toBe(0);
    // Single-side null tokensPerPass yields null delta.
    expect(beta.tokensPerPassDelta).toBeNull();
  });

  test("emits an empty array on no tasks", () => {
    expect(computeDomainAggregates([])).toEqual([]);
  });
});

describe("computeAssetRegressionCandidates", () => {
  function fakeRun(taskId: string, assets: string[]): RunResult {
    return {
      schemaVersion: 1,
      taskId,
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
      assetsLoaded: assets,
    };
  }

  test("returns empty when no regressed tasks were provided", () => {
    expect(computeAssetRegressionCandidates([], [fakeRun("d/a", ["skill:x"])])).toEqual([]);
  });

  test("counts distinct regressed tasks per asset and totals raw load volume", () => {
    const akmRuns = [
      // task d/r1 across two seeds, same asset.
      fakeRun("d/r1", ["skill:foo", "skill:bar"]),
      fakeRun("d/r1", ["skill:foo"]),
      // task d/r2 loads skill:foo (again) plus skill:baz.
      fakeRun("d/r2", ["skill:foo", "skill:baz"]),
      // Non-regressed task is ignored entirely.
      fakeRun("d/clean", ["skill:foo", "skill:bar", "skill:baz"]),
    ];
    const rows = computeAssetRegressionCandidates(["d/r1", "d/r2"], akmRuns);
    expect(rows.map((r) => r.assetRef)).toEqual(["skill:foo", "skill:bar", "skill:baz"]);
    const foo = rows[0];
    if (!foo) throw new Error("foo missing");
    expect(foo.regressedTaskCount).toBe(2);
    expect(foo.regressedTaskIds).toEqual(["d/r1", "d/r2"]);
    expect(foo.totalLoadCount).toBe(3);
    const bar = rows[1];
    if (!bar) throw new Error("bar missing");
    expect(bar.regressedTaskCount).toBe(1);
    expect(bar.totalLoadCount).toBe(1);
  });
});
