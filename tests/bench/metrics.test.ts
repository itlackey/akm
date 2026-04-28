/**
 * Unit tests for outcome / per-task / corpus / trajectory aggregation.
 */

import { describe, expect, test } from "bun:test";

import type { EventEnvelope } from "../../src/core/events";
import type { TaskMetadata } from "./corpus";
import type { RunResult } from "./driver";
import {
  aggregateAkmOverhead,
  aggregateByMemoryAbility,
  aggregateByTaskFamily,
  aggregateCorpus,
  aggregatePerTask,
  aggregateTrajectory,
  computeAkmOverhead,
  computeAssetRegressionCandidates,
  computeCorpusCoverage,
  computeCorpusDelta,
  computeDomainAggregates,
  computeNegativeTransfer,
  computeOutcomeAggregate,
  computePerTaskDelta,
  domainOfTaskId,
  type PerTaskMetrics,
  type PerTaskTagEntry,
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

// ── Memory-operation aggregations (#262) ───────────────────────────────────

describe("aggregateByMemoryAbility / aggregateByTaskFamily (#262)", () => {
  function entry(
    id: string,
    noakmPass: number,
    akmPass: number,
    extras: Partial<PerTaskTagEntry> = {},
  ): PerTaskTagEntry {
    return {
      id,
      noakm: ptm({ passRate: noakmPass }),
      akm: ptm({ passRate: akmPass }),
      ...extras,
    };
  }

  test("returns empty when no entries carry the keying tag", () => {
    const entries = [entry("d/a", 0.4, 0.6), entry("d/b", 0.5, 0.7)];
    expect(aggregateByMemoryAbility(entries)).toEqual([]);
    expect(aggregateByTaskFamily(entries)).toEqual([]);
  });

  test("aggregateByMemoryAbility groups tasks, computes deltas + negative transfer", () => {
    const entries = [
      entry("d/lookup-1", 0.4, 0.8, { memoryAbility: "procedural_lookup" }),
      entry("d/lookup-2", 0.6, 0.4, { memoryAbility: "procedural_lookup" }),
      entry("d/compose-1", 0.0, 1.0, { memoryAbility: "multi_asset_composition" }),
      entry("d/no-tag", 0.5, 0.7),
    ];
    const rows = aggregateByMemoryAbility(entries);
    expect(rows.map((r) => r.category)).toEqual(["multi_asset_composition", "procedural_lookup"]);
    const lookup = rows.find((r) => r.category === "procedural_lookup");
    expect(lookup?.taskCount).toBe(2);
    expect(lookup?.passRateNoakm).toBeCloseTo(0.5);
    expect(lookup?.passRateAkm).toBeCloseTo(0.6);
    expect(lookup?.passRateDelta).toBeCloseTo(0.1);
    // d/lookup-2 regressed (akm < noakm).
    expect(lookup?.negativeTransferCount).toBe(1);
    expect(lookup?.workflowCompliance).toBeNull();
  });

  test("aggregateByMemoryAbility folds workflow_compliance when at least one task supplies it", () => {
    const entries = [
      entry("d/a", 0.5, 0.7, { memoryAbility: "procedural_lookup", workflowCompliance: 0.8 }),
      entry("d/b", 0.5, 0.7, { memoryAbility: "procedural_lookup" }),
      entry("d/c", 0.5, 0.7, { memoryAbility: "procedural_lookup", workflowCompliance: 0.6 }),
    ];
    const [row] = aggregateByMemoryAbility(entries);
    expect(row?.workflowCompliance).toBeCloseTo(0.7);
  });

  test("aggregateByTaskFamily groups by family", () => {
    const entries = [
      entry("d/a", 0.4, 0.6, { taskFamily: "d/group-1" }),
      entry("d/b", 0.4, 0.4, { taskFamily: "d/group-1" }),
      entry("d/c", 0.0, 1.0, { taskFamily: "d/group-2" }),
    ];
    const rows = aggregateByTaskFamily(entries);
    expect(rows.map((r) => r.category)).toEqual(["d/group-1", "d/group-2"]);
    const g1 = rows.find((r) => r.category === "d/group-1");
    expect(g1?.taskCount).toBe(2);
    expect(g1?.passRateDelta).toBeCloseTo(0.1);
  });

  test("computeCorpusCoverage counts every closed-set ability + an untagged bucket", () => {
    const cov = computeCorpusCoverage([
      { memoryAbility: "procedural_lookup", taskFamily: "d/family-a" },
      { memoryAbility: "procedural_lookup", taskFamily: "d/family-a" },
      { memoryAbility: "abstention", taskFamily: "d/family-b" },
      { taskFamily: "d/family-c" },
      {},
    ]);
    expect(cov.totalTasks).toBe(5);
    expect(cov.memoryAbilityCounts.procedural_lookup).toBe(2);
    expect(cov.memoryAbilityCounts.abstention).toBe(1);
    expect(cov.memoryAbilityCounts.conflict_resolution).toBe(0);
    expect(cov.memoryAbilityCounts.untagged).toBe(2);
    expect(cov.taskFamilyCounts["d/family-a"]).toBe(2);
    expect(cov.taskFamilyCounts.untagged).toBe(1);
  });
});

// ── AKM overhead (#263) ────────────────────────────────────────────────────

function akmEvent(eventType: string, ts: string, ref?: string, metadata?: Record<string, unknown>): EventEnvelope {
  return {
    schemaVersion: 1,
    id: 0,
    ts,
    eventType,
    ...(ref ? { ref } : {}),
    ...(metadata ? { metadata } : {}),
  };
}

function metaMap(
  entries: ReadonlyArray<Pick<TaskMetadata, "id" | "goldRef" | "expectedTransferFrom">>,
): Map<string, Pick<TaskMetadata, "goldRef" | "expectedTransferFrom">> {
  const m = new Map<string, Pick<TaskMetadata, "goldRef" | "expectedTransferFrom">>();
  for (const e of entries) m.set(e.id, { goldRef: e.goldRef, expectedTransferFrom: e.expectedTransferFrom });
  return m;
}

describe("computeAkmOverhead — no AKM calls", () => {
  test("zero counts and null timings when run had no AKM events", () => {
    const run = fakeResult({ taskId: "demo/none", events: [] });
    const rows = computeAkmOverhead([run]);
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.searchCount).toBe(0);
    expect(r.showCount).toBe(0);
    expect(r.feedbackCount).toBe(0);
    expect(r.totalToolCalls).toBe(0);
    expect(r.assetsLoadedCount).toBe(0);
    expect(r.timeToFirstSearchMs).toBeNull();
    expect(r.timeToFirstCorrectAssetMs).toBeNull();
    expect(r.contextBytesLoaded).toBeNull();
    expect(r.assetBytesLoaded).toBeNull();
    // Without metadata, irrelevance is unjudgeable -> null.
    expect(r.irrelevantAssetsLoadedCount).toBeNull();
  });

  test("aggregate over empty array is the zero envelope", () => {
    const agg = aggregateAkmOverhead([]);
    expect(agg.totalRuns).toBe(0);
    expect(agg.passingRuns).toBe(0);
    expect(agg.toolCallsPerSuccess).toBeNull();
    expect(agg.costPerSuccess).toBeNull();
    expect(agg.meanTimeToFirstSearchMs).toBeNull();
  });
});

describe("computeAkmOverhead — successful AKM use", () => {
  test("counts search/show/feedback, computes timings and relevance", () => {
    const run = fakeResult({
      taskId: "demo/ok",
      outcome: "pass",
      tokenMeasurement: "parsed",
      tokens: { input: 100, output: 50 },
      events: [
        akmEvent("search", "2026-04-27T10:00:00.000Z", undefined, { query: "deploy" }),
        akmEvent("show", "2026-04-27T10:00:00.500Z", "skill:deploy"),
        akmEvent("feedback", "2026-04-27T10:00:01.000Z", "skill:deploy"),
      ],
    });
    const tasks = metaMap([{ id: "demo/ok", goldRef: "skill:deploy", expectedTransferFrom: [] }]);
    const rows = computeAkmOverhead([run], { taskMetadata: tasks });
    const r = rows[0];
    expect(r.searchCount).toBe(1);
    expect(r.showCount).toBe(1);
    expect(r.feedbackCount).toBe(1);
    expect(r.totalToolCalls).toBe(3);
    expect(r.assetsLoadedCount).toBe(1);
    expect(r.irrelevantAssetsLoadedCount).toBe(0);
    expect(r.timeToFirstSearchMs).toBe(0); // first search IS the run-start anchor
    expect(r.timeToFirstCorrectAssetMs).toBe(500);
    const agg = aggregateAkmOverhead(rows, [run]);
    expect(agg.passingRuns).toBe(1);
    expect(agg.toolCallsPerSuccess).toBe(3);
    expect(agg.costPerSuccess).toBe(150);
  });

  test("expected_transfer_from refs are not counted as irrelevant", () => {
    const run = fakeResult({
      taskId: "demo/transfer",
      events: [
        akmEvent("show", "2026-04-27T10:00:00.000Z", "skill:foo"),
        akmEvent("show", "2026-04-27T10:00:01.000Z", "skill:helper"),
      ],
    });
    const tasks = metaMap([{ id: "demo/transfer", goldRef: "skill:foo", expectedTransferFrom: ["skill:helper"] }]);
    const rows = computeAkmOverhead([run], { taskMetadata: tasks });
    expect(rows[0].assetsLoadedCount).toBe(2);
    expect(rows[0].irrelevantAssetsLoadedCount).toBe(0);
  });
});

describe("computeAkmOverhead — excessive AKM calls", () => {
  test("high counts and low calls-per-success are surfaced", () => {
    const goldRef = "skill:gold";
    const noisyRun = fakeResult({
      taskId: "demo/noisy",
      outcome: "fail",
      events: [
        akmEvent("search", "2026-04-27T10:00:00.000Z"),
        akmEvent("search", "2026-04-27T10:00:00.100Z"),
        akmEvent("search", "2026-04-27T10:00:00.200Z"),
        akmEvent("show", "2026-04-27T10:00:00.300Z", "skill:other"),
        akmEvent("show", "2026-04-27T10:00:00.400Z", "skill:other2"),
        akmEvent("show", "2026-04-27T10:00:00.500Z", "skill:other3"),
        akmEvent("show", "2026-04-27T10:00:00.600Z", goldRef),
      ],
    });
    const passingRun = fakeResult({
      taskId: "demo/easy",
      outcome: "pass",
      tokenMeasurement: "parsed",
      tokens: { input: 10, output: 10 },
      events: [akmEvent("search", "2026-04-27T10:00:00.000Z"), akmEvent("show", "2026-04-27T10:00:00.100Z", goldRef)],
    });
    const tasks = metaMap([
      { id: "demo/noisy", goldRef, expectedTransferFrom: [] },
      { id: "demo/easy", goldRef, expectedTransferFrom: [] },
    ]);
    const rows = computeAkmOverhead([noisyRun, passingRun], { taskMetadata: tasks });
    expect(rows[0].totalToolCalls).toBe(7);
    expect(rows[0].irrelevantAssetsLoadedCount).toBe(3);
    expect(rows[0].timeToFirstCorrectAssetMs).toBe(600);
    expect(rows[1].totalToolCalls).toBe(2);
    const agg = aggregateAkmOverhead(rows, [noisyRun, passingRun]);
    expect(agg.totalToolCalls).toBe(9);
    expect(agg.passingRuns).toBe(1);
    // 9 tool calls for one passing run = high overhead per success.
    expect(agg.toolCallsPerSuccess).toBe(9);
  });
});

describe("computeAkmOverhead — missing timing/byte data", () => {
  test("event without ts -> null first-search timing (NOT zero)", () => {
    const run = fakeResult({
      taskId: "demo/notime",
      events: [
        // No ts on event — workflow-trace assigns a synthetic order hint but
        // ts stays undefined, so we cannot anchor a real time-offset.
        { schemaVersion: 1, id: 0, eventType: "search" } as EventEnvelope,
      ],
    });
    const rows = computeAkmOverhead([run]);
    expect(rows[0].searchCount).toBe(1);
    expect(rows[0].timeToFirstSearchMs).toBeNull();
    expect(rows[0].timeToFirstCorrectAssetMs).toBeNull();
  });

  test("byte sizes are always null for now (NOT zero)", () => {
    const run = fakeResult({
      events: [akmEvent("show", "2026-04-27T10:00:00.000Z", "skill:foo")],
    });
    const rows = computeAkmOverhead([run]);
    expect(rows[0].contextBytesLoaded).toBeNull();
    expect(rows[0].assetBytesLoaded).toBeNull();
    const agg = aggregateAkmOverhead(rows, [run]);
    expect(agg.meanContextBytesLoaded).toBeNull();
    expect(agg.meanAssetBytesLoaded).toBeNull();
  });

  test("cost_per_success is null when any passing run lacks parsed token measurement", () => {
    const passParsed = fakeResult({
      taskId: "t1",
      outcome: "pass",
      tokenMeasurement: "parsed",
      tokens: { input: 10, output: 5 },
      events: [akmEvent("search", "2026-04-27T10:00:00.000Z")],
    });
    const passMissing = fakeResult({
      taskId: "t2",
      outcome: "pass",
      tokenMeasurement: "missing",
      tokens: { input: 0, output: 0 },
      events: [akmEvent("search", "2026-04-27T10:00:00.000Z")],
    });
    const rows = computeAkmOverhead([passParsed, passMissing]);
    const agg = aggregateAkmOverhead(rows, [passParsed, passMissing]);
    expect(agg.passingRuns).toBe(2);
    expect(agg.costPerSuccess).toBeNull();
  });

  test("missing task metadata -> irrelevantAssetsLoadedCount is null (not 0)", () => {
    const run = fakeResult({
      taskId: "demo/unknown",
      events: [akmEvent("show", "2026-04-27T10:00:00.000Z", "skill:foo")],
    });
    // No metadata supplied for this task.
    const rows = computeAkmOverhead([run]);
    expect(rows[0].assetsLoadedCount).toBe(1);
    expect(rows[0].irrelevantAssetsLoadedCount).toBeNull();
  });

  test("aggregate skips null timings rather than zero-filling", () => {
    const noTime = fakeResult({
      taskId: "t1",
      outcome: "fail",
      events: [{ schemaVersion: 1, id: 0, eventType: "search" } as EventEnvelope],
    });
    const withTime = fakeResult({
      taskId: "t2",
      outcome: "fail",
      events: [akmEvent("search", "2026-04-27T10:00:01.000Z")],
    });
    const rows = computeAkmOverhead([noTime, withTime]);
    // First run: search event has no ts -> no run-start anchor, timing null.
    // Second run: search event IS the only event with ts, so it's both the
    // anchor and the first search -> offset 0.
    expect(rows[0].timeToFirstSearchMs).toBeNull();
    expect(rows[1].timeToFirstSearchMs).toBe(0);
    const agg = aggregateAkmOverhead(rows, [noTime, withTime]);
    // Mean honours only the parseable observation; the null is skipped, NOT
    // treated as zero in the numerator.
    expect(agg.meanTimeToFirstSearchMs).toBe(0);
    // tool_calls_per_success is null because no run passed.
    expect(agg.toolCallsPerSuccess).toBeNull();
  });
});
