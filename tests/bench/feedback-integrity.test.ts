/**
 * Unit tests for §6.8 feedback-signal integrity (#244).
 *
 * Coverage:
 *   • All four 2×2 quadrants (TP, FP, TN, FN).
 *   • Per-asset breakdown when an asset has mixed signals across runs.
 *   • `feedback_agreement < 0.80` triggers the warning marker (markdown +
 *     structured `warnings[]` JSON entry).
 *   • `feedback_coverage` correctly counts runs with feedback dispatched
 *     vs total Phase 1 runs.
 *   • NaN-safety: zero-feedback asset emits all rates as `null`, never
 *     `0` or `NaN`.
 *   • Attribution rule (§6.8): a feedback event is attributed to the run
 *     that produced it, not to a later run touching the same asset.
 *
 * The metric is a pure function over RunResult[] + feedbackLog[]; no spawn
 * fakes are needed. We build small synthetic streams directly.
 */

import { describe, expect, test } from "bun:test";

import type { RunResult } from "./driver";
import { computeFeedbackIntegrity, type FeedbackIntegrityInput, type FeedbackIntegrityMetrics } from "./metrics";
import { FEEDBACK_AGREEMENT_WARNING_THRESHOLD, renderEvolveReport, renderFeedbackIntegrityTable } from "./report";

function fakeRun(overrides: Partial<RunResult>): RunResult {
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

function fb(
  overrides: Partial<FeedbackIntegrityInput["feedbackLog"][number]>,
): FeedbackIntegrityInput["feedbackLog"][number] {
  return {
    taskId: "t",
    seed: 0,
    goldRef: "skill:s",
    signal: "positive",
    ok: true,
    ...overrides,
  };
}

describe("computeFeedbackIntegrity — 2x2 quadrants", () => {
  test("TP: feedback + on a passed run", () => {
    const phase1 = { akmRuns: [fakeRun({ taskId: "t1", seed: 0, outcome: "pass" })] };
    const feedbackLog = [fb({ taskId: "t1", seed: 0, goldRef: "skill:a", signal: "positive" })];
    const m = computeFeedbackIntegrity({ phase1, feedbackLog });
    expect(m.aggregate.truePositive).toBe(1);
    expect(m.aggregate.falsePositive).toBe(0);
    expect(m.aggregate.trueNegative).toBe(0);
    expect(m.aggregate.falseNegative).toBe(0);
    expect(m.aggregate.feedback_agreement).toBeCloseTo(1);
    expect(m.aggregate.feedback_coverage).toBeCloseTo(1);
    expect(m.perAsset).toHaveLength(1);
    expect(m.perAsset[0].ref).toBe("skill:a");
    expect(m.perAsset[0].truePositive).toBe(1);
    expect(m.perAsset[0].feedback_agreement).toBeCloseTo(1);
  });

  test("FP: feedback + on a failed run", () => {
    const phase1 = { akmRuns: [fakeRun({ taskId: "t1", seed: 0, outcome: "fail" })] };
    const feedbackLog = [fb({ taskId: "t1", seed: 0, goldRef: "skill:a", signal: "positive" })];
    const m = computeFeedbackIntegrity({ phase1, feedbackLog });
    expect(m.aggregate.truePositive).toBe(0);
    expect(m.aggregate.falsePositive).toBe(1);
    expect(m.aggregate.trueNegative).toBe(0);
    expect(m.aggregate.falseNegative).toBe(0);
    expect(m.aggregate.feedback_agreement).toBeCloseTo(0);
    expect(m.aggregate.false_positive_rate).toBeCloseTo(1);
    expect(m.perAsset[0].falsePositive).toBe(1);
  });

  test("TN: feedback - on a failed run", () => {
    const phase1 = { akmRuns: [fakeRun({ taskId: "t1", seed: 0, outcome: "fail" })] };
    const feedbackLog = [fb({ taskId: "t1", seed: 0, goldRef: "skill:a", signal: "negative" })];
    const m = computeFeedbackIntegrity({ phase1, feedbackLog });
    expect(m.aggregate.trueNegative).toBe(1);
    expect(m.aggregate.feedback_agreement).toBeCloseTo(1);
    expect(m.aggregate.false_positive_rate).toBeCloseTo(0);
    expect(m.perAsset[0].trueNegative).toBe(1);
  });

  test("FN: feedback - on a passed run", () => {
    const phase1 = { akmRuns: [fakeRun({ taskId: "t1", seed: 0, outcome: "pass" })] };
    const feedbackLog = [fb({ taskId: "t1", seed: 0, goldRef: "skill:a", signal: "negative" })];
    const m = computeFeedbackIntegrity({ phase1, feedbackLog });
    expect(m.aggregate.falseNegative).toBe(1);
    expect(m.aggregate.feedback_agreement).toBeCloseTo(0);
    expect(m.aggregate.false_negative_rate).toBeCloseTo(1);
    expect(m.perAsset[0].falseNegative).toBe(1);
  });
});

describe("computeFeedbackIntegrity — aggregate over mixed quadrants", () => {
  test("computes feedback_agreement and rates correctly across mixed runs", () => {
    // 4 runs covering all four quadrants — exactly one of each.
    const phase1 = {
      akmRuns: [
        fakeRun({ taskId: "tp", seed: 0, outcome: "pass" }),
        fakeRun({ taskId: "fp", seed: 0, outcome: "fail" }),
        fakeRun({ taskId: "tn", seed: 0, outcome: "fail" }),
        fakeRun({ taskId: "fn", seed: 0, outcome: "pass" }),
      ],
    };
    const feedbackLog = [
      fb({ taskId: "tp", seed: 0, goldRef: "skill:tp", signal: "positive" }),
      fb({ taskId: "fp", seed: 0, goldRef: "skill:fp", signal: "positive" }),
      fb({ taskId: "tn", seed: 0, goldRef: "skill:tn", signal: "negative" }),
      fb({ taskId: "fn", seed: 0, goldRef: "skill:fn", signal: "negative" }),
    ];
    const m = computeFeedbackIntegrity({ phase1, feedbackLog });
    expect(m.aggregate.truePositive).toBe(1);
    expect(m.aggregate.falsePositive).toBe(1);
    expect(m.aggregate.trueNegative).toBe(1);
    expect(m.aggregate.falseNegative).toBe(1);
    expect(m.aggregate.feedback_agreement).toBeCloseTo(0.5); // 2/4
    expect(m.aggregate.false_positive_rate).toBeCloseTo(0.5); // 1 / (1+1)
    expect(m.aggregate.false_negative_rate).toBeCloseTo(0.5); // 1 / (1+1)
    expect(m.aggregate.feedback_coverage).toBeCloseTo(1);
    expect(m.perAsset).toHaveLength(4);
    // Per-asset rows should be sorted by ref
    expect(m.perAsset.map((r) => r.ref)).toEqual(["skill:fn", "skill:fp", "skill:tn", "skill:tp"]);
  });
});

describe("computeFeedbackIntegrity — per-asset mixed signals", () => {
  test("aggregates correctly when one asset appears across multiple Phase 1 runs", () => {
    // skill:shared has 2 TP, 1 FP, 1 TN, 1 FN across 5 runs.
    const phase1 = {
      akmRuns: [
        fakeRun({ taskId: "t", seed: 0, outcome: "pass" }),
        fakeRun({ taskId: "t", seed: 1, outcome: "pass" }),
        fakeRun({ taskId: "t", seed: 2, outcome: "fail" }),
        fakeRun({ taskId: "t", seed: 3, outcome: "fail" }),
        fakeRun({ taskId: "t", seed: 4, outcome: "pass" }),
      ],
    };
    const feedbackLog = [
      fb({ taskId: "t", seed: 0, goldRef: "skill:shared", signal: "positive" }), // TP
      fb({ taskId: "t", seed: 1, goldRef: "skill:shared", signal: "positive" }), // TP
      fb({ taskId: "t", seed: 2, goldRef: "skill:shared", signal: "positive" }), // FP
      fb({ taskId: "t", seed: 3, goldRef: "skill:shared", signal: "negative" }), // TN
      fb({ taskId: "t", seed: 4, goldRef: "skill:shared", signal: "negative" }), // FN
    ];
    const m = computeFeedbackIntegrity({ phase1, feedbackLog });
    expect(m.perAsset).toHaveLength(1);
    const row = m.perAsset[0];
    expect(row.ref).toBe("skill:shared");
    expect(row.truePositive).toBe(2);
    expect(row.falsePositive).toBe(1);
    expect(row.trueNegative).toBe(1);
    expect(row.falseNegative).toBe(1);
    expect(row.feedback_agreement).toBeCloseTo(3 / 5);
    expect(row.false_positive_rate).toBeCloseTo(1 / 2); // FP / (FP+TN) = 1/2
    expect(row.false_negative_rate).toBeCloseTo(1 / 3); // FN / (FN+TP) = 1/3
  });
});

describe("computeFeedbackIntegrity — attribution rule", () => {
  test("attributes feedback to the run that produced it, not a later run touching the same asset", () => {
    // skill:contested appears across two Phase 1 runs:
    //   run #0: passed, feedback +  → TP
    //   run #1: failed, feedback +  → FP
    // The naive (wrong) implementation would conflate both events with
    // run #1's outcome and label both as FP. The correct implementation
    // joins each event to its own (taskId, seed) → gets one TP, one FP.
    const phase1 = {
      akmRuns: [fakeRun({ taskId: "t", seed: 0, outcome: "pass" }), fakeRun({ taskId: "t", seed: 1, outcome: "fail" })],
    };
    const feedbackLog = [
      fb({ taskId: "t", seed: 0, goldRef: "skill:contested", signal: "positive" }),
      fb({ taskId: "t", seed: 1, goldRef: "skill:contested", signal: "positive" }),
    ];
    const m = computeFeedbackIntegrity({ phase1, feedbackLog });
    expect(m.aggregate.truePositive).toBe(1);
    expect(m.aggregate.falsePositive).toBe(1);
    expect(m.aggregate.trueNegative).toBe(0);
    expect(m.aggregate.falseNegative).toBe(0);
    expect(m.perAsset[0].truePositive).toBe(1);
    expect(m.perAsset[0].falsePositive).toBe(1);
  });
});

describe("computeFeedbackIntegrity — feedback_coverage", () => {
  test("counts runs with feedback dispatched vs total Phase 1 runs", () => {
    // 4 phase-1 runs, only 2 had feedback dispatched.
    const phase1 = {
      akmRuns: [
        fakeRun({ taskId: "t", seed: 0, outcome: "pass" }),
        fakeRun({ taskId: "t", seed: 1, outcome: "fail" }),
        fakeRun({ taskId: "t", seed: 2, outcome: "harness_error" }),
        fakeRun({ taskId: "t", seed: 3, outcome: "budget_exceeded" }),
      ],
    };
    const feedbackLog = [
      fb({ taskId: "t", seed: 0, goldRef: "skill:a", signal: "positive" }),
      fb({ taskId: "t", seed: 1, goldRef: "skill:a", signal: "negative" }),
    ];
    const m = computeFeedbackIntegrity({ phase1, feedbackLog });
    expect(m.aggregate.feedback_coverage).toBeCloseTo(0.5); // 2 of 4
  });

  test("zero coverage when no feedback dispatched", () => {
    const phase1 = { akmRuns: [fakeRun({ taskId: "t", seed: 0, outcome: "pass" })] };
    const m = computeFeedbackIntegrity({ phase1, feedbackLog: [] });
    expect(m.aggregate.feedback_coverage).toBe(0);
    expect(m.aggregate.feedback_agreement).toBe(0);
    expect(m.perAsset).toEqual([]);
  });

  test("zero coverage and zero runs returns 0 (not NaN)", () => {
    const m = computeFeedbackIntegrity({ phase1: { akmRuns: [] }, feedbackLog: [] });
    expect(m.aggregate.feedback_coverage).toBe(0);
    expect(m.aggregate.feedback_agreement).toBe(0);
    expect(m.aggregate.false_positive_rate).toBe(0);
    expect(m.aggregate.false_negative_rate).toBe(0);
    expect(Number.isFinite(m.aggregate.feedback_coverage)).toBe(true);
    expect(Number.isFinite(m.aggregate.feedback_agreement)).toBe(true);
  });
});

describe("computeFeedbackIntegrity — NaN safety", () => {
  test("per-asset row with FP+TN === 0 emits null false_positive_rate (only positive feedback on passes)", () => {
    const phase1 = {
      akmRuns: [fakeRun({ taskId: "t", seed: 0, outcome: "pass" }), fakeRun({ taskId: "t", seed: 1, outcome: "pass" })],
    };
    const feedbackLog = [
      fb({ taskId: "t", seed: 0, goldRef: "skill:only-tp", signal: "positive" }),
      fb({ taskId: "t", seed: 1, goldRef: "skill:only-tp", signal: "positive" }),
    ];
    const m = computeFeedbackIntegrity({ phase1, feedbackLog });
    const row = m.perAsset[0];
    expect(row.feedback_agreement).toBeCloseTo(1);
    expect(row.false_positive_rate).toBeNull(); // FP+TN === 0
    expect(row.false_negative_rate).toBeCloseTo(0); // FN/(FN+TP) = 0/2 = 0
  });

  test("per-asset row with FN+TP === 0 emits null false_negative_rate (only negative feedback on fails)", () => {
    const phase1 = {
      akmRuns: [fakeRun({ taskId: "t", seed: 0, outcome: "fail" }), fakeRun({ taskId: "t", seed: 1, outcome: "fail" })],
    };
    const feedbackLog = [
      fb({ taskId: "t", seed: 0, goldRef: "skill:only-tn", signal: "negative" }),
      fb({ taskId: "t", seed: 1, goldRef: "skill:only-tn", signal: "negative" }),
    ];
    const m = computeFeedbackIntegrity({ phase1, feedbackLog });
    const row = m.perAsset[0];
    expect(row.feedback_agreement).toBeCloseTo(1);
    expect(row.false_negative_rate).toBeNull(); // FN+TP === 0
    expect(row.false_positive_rate).toBeCloseTo(0); // FP/(FP+TN) = 0/2 = 0
  });

  test("ok=false feedback events are excluded from the matrix but still count toward coverage", () => {
    const phase1 = {
      akmRuns: [fakeRun({ taskId: "t", seed: 0, outcome: "pass" }), fakeRun({ taskId: "t", seed: 1, outcome: "fail" })],
    };
    const feedbackLog = [
      fb({ taskId: "t", seed: 0, goldRef: "skill:a", signal: "positive", ok: true }),
      fb({ taskId: "t", seed: 1, goldRef: "skill:a", signal: "negative", ok: false }),
    ];
    const m = computeFeedbackIntegrity({ phase1, feedbackLog });
    // Only the ok=true entry contributes to the matrix (TP=1).
    expect(m.aggregate.truePositive).toBe(1);
    expect(m.aggregate.trueNegative).toBe(0);
    // But coverage counts both attempts.
    expect(m.aggregate.feedback_coverage).toBeCloseTo(1);
  });

  test("harness_error runs are excluded from the matrix even with a stamped feedback event", () => {
    const phase1 = { akmRuns: [fakeRun({ taskId: "t", seed: 0, outcome: "harness_error" })] };
    const feedbackLog = [fb({ taskId: "t", seed: 0, goldRef: "skill:a", signal: "positive" })];
    const m = computeFeedbackIntegrity({ phase1, feedbackLog });
    expect(m.aggregate.truePositive).toBe(0);
    expect(m.aggregate.falsePositive).toBe(0);
    expect(m.perAsset).toEqual([]);
  });

  test("feedback for a run not present in akmRuns is silently dropped", () => {
    const phase1 = { akmRuns: [fakeRun({ taskId: "real", seed: 0, outcome: "pass" })] };
    const feedbackLog = [fb({ taskId: "ghost", seed: 99, goldRef: "skill:a", signal: "positive" })];
    const m = computeFeedbackIntegrity({ phase1, feedbackLog });
    expect(m.aggregate.truePositive).toBe(0);
    expect(m.perAsset).toEqual([]);
    // Coverage still records the dispatch attempt — operator wanted feedback.
    expect(m.aggregate.feedback_coverage).toBeCloseTo(1);
  });
});

// ── Render-side coverage ───────────────────────────────────────────────────

function emptyUtilityReport(): import("./report").UtilityRunReport {
  // Build a minimal §13.3-shaped utility report. The renderer reads
  // many subfields; we stub them to safe zeros.
  return {
    timestamp: "2026-04-27T00:00:00Z",
    branch: "test",
    commit: "deadbee",
    model: "m",
    corpus: { domains: 0, tasks: 0, slice: "all", seedsPerArm: 1 },
    aggregateNoakm: { passRate: 0, tokensPerPass: 0, wallclockMs: 0 },
    aggregateAkm: { passRate: 0, tokensPerPass: 0, wallclockMs: 0 },
    aggregateDelta: {
      passRate: 0,
      tokensPerPass: 0,
      wallclockMs: 0,
    },
    trajectoryAkm: {
      correctAssetLoaded: null,
      feedbackRecorded: 0,
    },
    failureModes: { byLabel: {}, byTask: {} },
    tasks: [],
    warnings: [],
    akmRuns: [],
    taskMetadata: [],
    goldRankRecords: [],
  };
}

function evolveInputWith(metrics: FeedbackIntegrityMetrics | undefined) {
  return {
    timestamp: "2026-04-27T00:00:00Z",
    branch: "test",
    commit: "deadbee",
    model: "m",
    domain: "test",
    seedsPerArm: 1,
    proposals: { rows: [], totalProposals: 0, totalAccepted: 0, acceptanceRate: 0, lintPassRate: 0 },
    longitudinal: {
      improvementSlope: 0.1,
      overSyntheticLift: 0.05,
      degradationCount: 0,
      degradations: [],
      prePassRate: 0.5,
      postPassRate: 0.6,
      syntheticPassRate: 0.55,
    },
    arms: { pre: emptyUtilityReport(), post: emptyUtilityReport(), synthetic: emptyUtilityReport() },
    warnings: [],
    ...(metrics ? { feedbackIntegrity: metrics } : {}),
  };
}

describe("renderFeedbackIntegrityTable", () => {
  test("emits aggregate matrix + per-asset rows", () => {
    const phase1 = {
      akmRuns: [fakeRun({ taskId: "t", seed: 0, outcome: "pass" }), fakeRun({ taskId: "t", seed: 1, outcome: "fail" })],
    };
    const feedbackLog = [
      fb({ taskId: "t", seed: 0, goldRef: "skill:a", signal: "positive" }),
      fb({ taskId: "t", seed: 1, goldRef: "skill:a", signal: "negative" }),
    ];
    const m = computeFeedbackIntegrity({ phase1, feedbackLog });
    const md = renderFeedbackIntegrityTable(m);
    expect(md).toContain("Feedback-signal integrity");
    expect(md).toContain("feedback_agreement | 1.00");
    expect(md).toContain("feedback_coverage | 1.00");
    expect(md).toContain("`skill:a`");
  });

  test("renders n/a when a per-asset rate is null", () => {
    const phase1 = { akmRuns: [fakeRun({ taskId: "t", seed: 0, outcome: "pass" })] };
    const feedbackLog = [fb({ taskId: "t", seed: 0, goldRef: "skill:a", signal: "positive" })];
    const m = computeFeedbackIntegrity({ phase1, feedbackLog });
    const md = renderFeedbackIntegrityTable(m);
    // Only TP — false_positive_rate denom is 0 → null → "n/a".
    expect(md).toContain("n/a");
  });

  test("renders 'No feedback events recorded' when perAsset is empty", () => {
    const m: FeedbackIntegrityMetrics = {
      aggregate: {
        truePositive: 0,
        falsePositive: 0,
        trueNegative: 0,
        falseNegative: 0,
        feedback_agreement: 0,
        false_positive_rate: 0,
        false_negative_rate: 0,
        feedback_coverage: 0,
      },
      perAsset: [],
    };
    expect(renderFeedbackIntegrityTable(m)).toContain("No feedback events recorded");
  });
});

describe("renderEvolveReport — feedback_agreement headline + warning marker", () => {
  test("places real feedback_agreement after improvement_slope when metrics provided", () => {
    const metrics = computeFeedbackIntegrity({
      phase1: { akmRuns: [fakeRun({ taskId: "t", seed: 0, outcome: "pass" })] },
      feedbackLog: [fb({ taskId: "t", seed: 0, goldRef: "skill:a", signal: "positive" })],
    });
    const { markdown, json } = renderEvolveReport(evolveInputWith(metrics));
    // feedback_agreement is on a line directly after improvement_slope.
    const slopeIdx = markdown.indexOf("improvement_slope:");
    const agreementIdx = markdown.indexOf("feedback_agreement:");
    expect(slopeIdx).toBeGreaterThanOrEqual(0);
    expect(agreementIdx).toBeGreaterThan(slopeIdx);
    expect(markdown).toContain("feedback_agreement: 1.00");
    expect(markdown).not.toContain("pending (#244)");
    // JSON envelope carries `feedback_integrity` as a top-level key.
    const parsed = json as { feedback_integrity?: object; warnings: string[] };
    expect(parsed.feedback_integrity).toBeDefined();
    expect(parsed.warnings.some((w) => w.startsWith("feedback_agreement_below_threshold"))).toBe(false);
  });

  test("placeholder remains when metrics omitted (legacy path)", () => {
    const { markdown, json } = renderEvolveReport(evolveInputWith(undefined));
    expect(markdown).toContain("_feedback_agreement: pending (#244)_");
    const parsed = json as { feedback_integrity?: object };
    expect(parsed.feedback_integrity).toBeUndefined();
  });

  test("agreement < 0.80 prepends warning marker to markdown and structured warnings[]", () => {
    // 1 TP + 4 FP → agreement = 1/5 = 0.20.
    const phase1 = {
      akmRuns: [
        fakeRun({ taskId: "t", seed: 0, outcome: "pass" }),
        fakeRun({ taskId: "t", seed: 1, outcome: "fail" }),
        fakeRun({ taskId: "t", seed: 2, outcome: "fail" }),
        fakeRun({ taskId: "t", seed: 3, outcome: "fail" }),
        fakeRun({ taskId: "t", seed: 4, outcome: "fail" }),
      ],
    };
    const feedbackLog = [
      fb({ taskId: "t", seed: 0, goldRef: "skill:a", signal: "positive" }),
      fb({ taskId: "t", seed: 1, goldRef: "skill:a", signal: "positive" }),
      fb({ taskId: "t", seed: 2, goldRef: "skill:a", signal: "positive" }),
      fb({ taskId: "t", seed: 3, goldRef: "skill:a", signal: "positive" }),
      fb({ taskId: "t", seed: 4, goldRef: "skill:a", signal: "positive" }),
    ];
    const metrics = computeFeedbackIntegrity({ phase1, feedbackLog });
    expect(metrics.aggregate.feedback_agreement).toBeCloseTo(0.2);
    expect(metrics.aggregate.feedback_agreement).toBeLessThan(FEEDBACK_AGREEMENT_WARNING_THRESHOLD);

    const { markdown, json } = renderEvolveReport(evolveInputWith(metrics));
    // Marker appears above the headline, not after it.
    const warnIdx = markdown.indexOf("feedback_agreement = 0.20");
    const slopeIdx = markdown.indexOf("**improvement_slope:");
    expect(warnIdx).toBeGreaterThanOrEqual(0);
    expect(warnIdx).toBeLessThan(slopeIdx);
    expect(markdown).toContain("Track B headline numbers");
    // Structured warning surfaces in the JSON envelope.
    const parsed = json as { warnings: string[] };
    expect(parsed.warnings.some((w) => w.startsWith("feedback_agreement_below_threshold"))).toBe(true);
  });

  test("agreement at exactly 0.80 does NOT trigger the warning marker", () => {
    // 4 TP + 1 FP → agreement = 4/5 = 0.80 exactly.
    const phase1 = {
      akmRuns: [
        fakeRun({ taskId: "t", seed: 0, outcome: "pass" }),
        fakeRun({ taskId: "t", seed: 1, outcome: "pass" }),
        fakeRun({ taskId: "t", seed: 2, outcome: "pass" }),
        fakeRun({ taskId: "t", seed: 3, outcome: "pass" }),
        fakeRun({ taskId: "t", seed: 4, outcome: "fail" }),
      ],
    };
    const feedbackLog = [
      fb({ taskId: "t", seed: 0, goldRef: "skill:a", signal: "positive" }),
      fb({ taskId: "t", seed: 1, goldRef: "skill:a", signal: "positive" }),
      fb({ taskId: "t", seed: 2, goldRef: "skill:a", signal: "positive" }),
      fb({ taskId: "t", seed: 3, goldRef: "skill:a", signal: "positive" }),
      fb({ taskId: "t", seed: 4, goldRef: "skill:a", signal: "positive" }),
    ];
    const metrics = computeFeedbackIntegrity({ phase1, feedbackLog });
    expect(metrics.aggregate.feedback_agreement).toBeCloseTo(0.8);

    const { markdown, json } = renderEvolveReport(evolveInputWith(metrics));
    expect(markdown).not.toContain("Track B headline numbers");
    const parsed = json as { warnings: string[] };
    expect(parsed.warnings.some((w) => w.startsWith("feedback_agreement_below_threshold"))).toBe(false);
  });
});
