// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { akmHealth } from "../src/commands/health";
import {
  CALIBRATION_BUCKET_COUNT,
  type CalibrationSample,
  computeThresholdAutoTune,
  gateDecisionsToSamples,
  summarizeCalibration,
} from "../src/commands/improve/calibration";
import { maybeAutoTuneThreshold } from "../src/commands/improve/improve";
import { createProposal, recordGateDecision } from "../src/commands/proposal/repository";
import type { AkmConfig } from "../src/core/config/config";
import { getStateDbPathInDataDir } from "../src/core/paths";
import { type Cleanup, type IsolatedAkmStorage, withIsolatedAkmStorage } from "./_helpers/sandbox";

let storage: IsolatedAkmStorage;
let cleanup: Cleanup = () => {};

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  cleanup = storage.cleanup;
});

afterEach(() => {
  cleanup();
  cleanup = () => {};
});

// ── Pure calibration summary ────────────────────────────────────────────────

describe("summarizeCalibration", () => {
  test("empty input → all-zero, parity-preserving summary", () => {
    const s = summarizeCalibration([]);
    expect(s.samples).toBe(0);
    expect(s.accepted).toBe(0);
    expect(s.rejected).toBe(0);
    expect(s.overallAcceptRate).toBe(0);
    expect(s.meanConfidence).toBe(0);
    expect(s.calibrationGap).toBe(0);
    expect(s.buckets).toHaveLength(CALIBRATION_BUCKET_COUNT);
    expect(s.buckets.every((b) => b.count === 0 && b.acceptRate === 0)).toBe(true);
  });

  test("over-confident accepts produce a positive calibration gap", () => {
    // 10 decisions all predicted ~0.95 confidence; only 5 realized as accepted.
    const samples: CalibrationSample[] = [];
    for (let i = 0; i < 10; i += 1) {
      samples.push({ confidence: 0.95, outcome: i < 5 ? "auto-accepted" : "auto-rejected" });
    }
    const s = summarizeCalibration(samples);
    expect(s.samples).toBe(10);
    expect(s.accepted).toBe(5);
    expect(s.rejected).toBe(5);
    expect(s.overallAcceptRate).toBe(0.5);
    expect(s.meanConfidence).toBe(0.95);
    // Over-confident: predicted 0.95 but only 0.5 realized → gap +0.45.
    expect(s.calibrationGap).toBe(0.45);
    // The 0.9–1.0 bucket (index 9) holds all 10.
    const top = s.buckets[CALIBRATION_BUCKET_COUNT - 1];
    expect(top?.count).toBe(10);
    expect(top?.accepted).toBe(5);
    expect(top?.acceptRate).toBe(0.5);
  });

  test("well-calibrated decisions yield a near-zero gap", () => {
    const samples: CalibrationSample[] = [
      { confidence: 0.9, outcome: "auto-accepted" },
      { confidence: 0.9, outcome: "auto-accepted" },
      { confidence: 0.9, outcome: "auto-accepted" },
      { confidence: 0.9, outcome: "auto-accepted" },
      { confidence: 0.9, outcome: "auto-accepted" },
      { confidence: 0.9, outcome: "auto-accepted" },
      { confidence: 0.9, outcome: "auto-accepted" },
      { confidence: 0.9, outcome: "auto-accepted" },
      { confidence: 0.9, outcome: "auto-accepted" },
      { confidence: 0.9, outcome: "auto-rejected" },
    ];
    const s = summarizeCalibration(samples);
    expect(s.overallAcceptRate).toBe(0.9);
    expect(s.meanConfidence).toBe(0.9);
    expect(s.calibrationGap).toBe(0);
  });

  test("output is deterministic across runs", () => {
    const samples: CalibrationSample[] = [
      { confidence: 0.3, outcome: "auto-rejected" },
      { confidence: 0.8, outcome: "auto-accepted" },
      { confidence: 0.55, outcome: "auto-accepted" },
    ];
    expect(summarizeCalibration(samples)).toEqual(summarizeCalibration(samples));
  });
});

// ── gateDecisionsToSamples projection ────────────────────────────────────────

describe("gateDecisionsToSamples", () => {
  test("keeps only acted-on decisions with a valid confidence", () => {
    const samples = gateDecisionsToSamples([
      { outcome: "auto-accepted", reason: "above-threshold", confidence: 0.9, decidedAt: "2026-06-10T00:00:00Z" },
      { outcome: "auto-rejected", reason: "validation:x", confidence: 0.95, decidedAt: "2026-06-10T00:00:00Z" },
      // deferred → excluded (no realized accept/reject)
      { outcome: "deferred", reason: "below-threshold", confidence: 0.5, decidedAt: "2026-06-10T00:00:00Z" },
      // missing confidence → excluded
      { outcome: "auto-accepted", reason: "above-threshold", decidedAt: "2026-06-10T00:00:00Z" },
      // out-of-range confidence → excluded
      { outcome: "auto-accepted", reason: "x", confidence: 1.5, decidedAt: "2026-06-10T00:00:00Z" },
      undefined,
    ]);
    expect(samples).toHaveLength(2);
    expect(samples[0]?.outcome).toBe("auto-accepted");
    expect(samples[1]?.outcome).toBe("auto-rejected");
  });

  test("excludes exploration-budget promotions (no reliability signal; exempt from auto-tune)", () => {
    const samples = gateDecisionsToSamples([
      { outcome: "auto-accepted", reason: "above-threshold", confidence: 0.92, decidedAt: "2026-06-10T00:00:00Z" },
      // exploration-budget: accepted regardless of confidence → must NOT pollute calibration
      { outcome: "auto-accepted", reason: "exploration-budget", confidence: 0.4, decidedAt: "2026-06-10T00:00:00Z" },
      { outcome: "auto-accepted", reason: "exploration-budget", confidence: 0.1, decidedAt: "2026-06-10T00:00:00Z" },
    ]);
    expect(samples).toHaveLength(1);
    expect(samples[0]?.confidence).toBe(0.92);
  });

  test("applies the [since, until) window on decidedAt", () => {
    const decisions = [
      { outcome: "auto-accepted" as const, reason: "x", confidence: 0.9, decidedAt: "2026-06-01T00:00:00Z" },
      { outcome: "auto-accepted" as const, reason: "x", confidence: 0.9, decidedAt: "2026-06-10T00:00:00Z" },
      { outcome: "auto-accepted" as const, reason: "x", confidence: 0.9, decidedAt: "2026-06-20T00:00:00Z" },
    ];
    const windowed = gateDecisionsToSamples(decisions, {
      since: "2026-06-05T00:00:00Z",
      until: "2026-06-15T00:00:00Z",
    });
    expect(windowed).toHaveLength(1);
  });
});

// ── Bounded, opt-in threshold auto-tune (pure) ───────────────────────────────

describe("computeThresholdAutoTune", () => {
  const baseConfig = {
    autoTune: true,
    minThreshold: 70,
    maxThreshold: 95,
    maxStep: 5,
    minSamples: 10,
    targetAcceptRate: 0.9,
  };

  test("disabled → no-op", () => {
    const r = computeThresholdAutoTune(85, summarizeCalibration([]), { ...baseConfig, autoTune: false });
    expect(r.adjusted).toBe(false);
    expect(r.reason).toBe("disabled");
    expect(r.newThreshold).toBe(85);
  });

  test("insufficient samples → no-op", () => {
    const samples: CalibrationSample[] = [{ confidence: 0.9, outcome: "auto-rejected" }];
    const r = computeThresholdAutoTune(85, summarizeCalibration(samples), baseConfig);
    expect(r.adjusted).toBe(false);
    expect(r.reason).toBe("insufficient-samples");
  });

  test("over-confident gate (realized below target) raises the threshold, bounded by maxStep", () => {
    // 20 samples, 50% realized accept → well below 0.9 target.
    const samples: CalibrationSample[] = [];
    for (let i = 0; i < 20; i += 1) {
      samples.push({ confidence: 0.95, outcome: i < 10 ? "auto-accepted" : "auto-rejected" });
    }
    const r = computeThresholdAutoTune(85, summarizeCalibration(samples), baseConfig);
    expect(r.adjusted).toBe(true);
    expect(r.reason).toBe("below-target-raise");
    // bounded by maxStep=5 → 85 → 90 (not the full gap).
    expect(r.newThreshold).toBe(90);
    expect(r.delta).toBe(5);
  });

  test("over-conservative gate (realized above target) lowers the threshold", () => {
    const samples: CalibrationSample[] = [];
    for (let i = 0; i < 20; i += 1) samples.push({ confidence: 0.95, outcome: "auto-accepted" });
    const r = computeThresholdAutoTune(85, summarizeCalibration(samples), baseConfig);
    expect(r.adjusted).toBe(true);
    expect(r.reason).toBe("above-target-lower");
    expect(r.newThreshold).toBe(80);
  });

  test("never exceeds the configured band", () => {
    const samples: CalibrationSample[] = [];
    for (let i = 0; i < 20; i += 1) samples.push({ confidence: 0.95, outcome: "auto-accepted" });
    // current at the lower bound, wants to go lower → clamped.
    const r = computeThresholdAutoTune(70, summarizeCalibration(samples), baseConfig);
    expect(r.newThreshold).toBe(70);
    expect(r.adjusted).toBe(false);
    expect(r.reason).toBe("clamped-at-bound");
  });
});

// ── End-to-end: health surfaces calibration from seeded gate decisions ───────

describe("akm health calibration surface", () => {
  function seedDecision(
    ref: string,
    confidence: number,
    outcome: "auto-accepted" | "auto-rejected" | "deferred",
  ): void {
    const created = createProposal(storage.stashDir, {
      ref,
      source: "reflect",
      sourceRun: "run-1",
      payload: { content: `# ${ref}\n\nbody for ${ref}\n` },
      confidence,
    });
    if ("skipped" in created) throw new Error(`proposal skipped: ${created.reason}`);
    recordGateDecision(storage.stashDir, created.id, {
      outcome,
      reason: outcome === "auto-accepted" ? "above-threshold" : "below-threshold",
      confidence,
      thresholds: { autoAccept: 0.9 },
      gate: "improve:reflect",
    });
  }

  test("default (no gate decisions) → empty calibration summary, parity", () => {
    const result = akmHealth({ since: "7d" });
    expect(result.improve.calibration.samples).toBe(0);
    expect(result.improve.calibration.calibrationGap).toBe(0);
  });

  test("over-confident accepts produce a measurable calibration signal", () => {
    // 6 acted-on decisions: 3 accepted, 3 rejected — all at high confidence.
    seedDecision("lesson:cal-a", 0.95, "auto-accepted");
    seedDecision("lesson:cal-b", 0.95, "auto-accepted");
    seedDecision("lesson:cal-c", 0.95, "auto-accepted");
    seedDecision("lesson:cal-d", 0.95, "auto-rejected");
    seedDecision("lesson:cal-e", 0.95, "auto-rejected");
    seedDecision("lesson:cal-f", 0.95, "auto-rejected");
    // A deferred decision must NOT count toward calibration.
    seedDecision("lesson:cal-g", 0.4, "deferred");

    const result = akmHealth({ since: "7d" });
    const cal = result.improve.calibration;
    expect(cal.samples).toBe(6);
    expect(cal.accepted).toBe(3);
    expect(cal.rejected).toBe(3);
    expect(cal.overallAcceptRate).toBe(0.5);
    expect(cal.meanConfidence).toBe(0.95);
    expect(cal.calibrationGap).toBe(0.45); // over-confident
  });
});

// ── End-to-end: opt-in auto-tune is default-off and bounded ──────────────────

describe("maybeAutoTuneThreshold", () => {
  function seedManyOverconfident(n: number): void {
    for (let i = 0; i < n; i += 1) {
      const created = createProposal(storage.stashDir, {
        ref: `lesson:tune-${i}`,
        source: "reflect",
        sourceRun: "run-1",
        payload: { content: `# tune-${i}\n\nbody ${i}\n` },
        confidence: 0.95,
      });
      if ("skipped" in created) throw new Error("seed skipped");
      recordGateDecision(storage.stashDir, created.id, {
        outcome: i % 2 === 0 ? "auto-accepted" : "auto-rejected",
        reason: "above-threshold",
        confidence: 0.95,
        thresholds: { autoAccept: 0.9 },
        gate: "improve:reflect",
      });
    }
  }

  test("default off (no calibration config) → returns undefined, no tuning", () => {
    seedManyOverconfident(20);
    const config = {} as AkmConfig;
    expect(maybeAutoTuneThreshold(85, config, getStateDbPathInDataDir())).toBeUndefined();
  });

  test("autoTune: false → returns undefined", () => {
    seedManyOverconfident(20);
    const config = { improve: { calibration: { autoTune: false, minThreshold: 70, maxThreshold: 95 } } } as AkmConfig;
    expect(maybeAutoTuneThreshold(85, config, getStateDbPathInDataDir())).toBeUndefined();
  });

  test("enabled + over-confident gate → bounded upward nudge, logged via event", () => {
    seedManyOverconfident(20); // 50% realized accept, target 0.9 → raise
    const config = {
      improve: {
        calibration: { autoTune: true, minThreshold: 70, maxThreshold: 95, maxStep: 5, minSamples: 10 },
      },
    } as AkmConfig;
    const tuned = maybeAutoTuneThreshold(85, config, getStateDbPathInDataDir());
    expect(tuned).toBe(90); // 85 + maxStep(5), within [70,95]
  });

  test("enabled but insufficient samples → returns undefined", () => {
    seedManyOverconfident(4);
    const config = {
      improve: { calibration: { autoTune: true, minThreshold: 70, maxThreshold: 95, minSamples: 10 } },
    } as AkmConfig;
    expect(maybeAutoTuneThreshold(85, config, getStateDbPathInDataDir())).toBeUndefined();
  });
});
