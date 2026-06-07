/**
 * Phase 2A / Rec 5 — configurable forgetting curve.
 *
 * Verifies that the utility-recency decay
 *   `recencyFactor = exp(-daysSinceLastUse / stabilizedHalfLife)`
 * remains identical to the pre-2A `exp(-days / 30)` curve when no
 * `utilityDecayConfig` and no `positiveFeedbackCounts` are supplied
 * (default-safe), and that supplying them stretches the half-life as
 * documented (with the 4× cap).
 */

import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { UtilityScoreRow } from "../src/indexer/db";
import type { StashEntry } from "../src/indexer/passes/metadata";
import { shouldQueryPositiveFeedbackCounts } from "../src/indexer/search/db-search";
import type { RankedEntryInput } from "../src/indexer/search/ranking";
import { applyUtilityContributors, type UtilityRankingContext } from "../src/indexer/search/ranking-contributors";

function makeRanked(id: number, name = "memory"): RankedEntryInput {
  const entry: StashEntry = { name, type: "memory" };
  return {
    id,
    entry,
    filePath: `/stash/memories/${name}.md`,
    score: 1,
    rankingMode: "fts",
  };
}

function makeUtilContext(opts: {
  itemId: number;
  utility: number;
  lastUsedDaysAgo: number;
  utilityDecayConfig?: { halfLifeDays: number; feedbackStabilityBoost: number };
  positiveFeedbackCounts?: Map<number, number>;
}): UtilityRankingContext {
  const lastUsedAt = new Date(Date.now() - opts.lastUsedDaysAgo * 86_400_000).toISOString();
  const utilScore: UtilityScoreRow = {
    entryId: opts.itemId,
    utility: opts.utility,
    showCount: 10,
    searchCount: 10,
    selectRate: 1,
    lastUsedAt,
    updatedAt: new Date().toISOString(),
  };
  return {
    db: null as unknown as Database,
    query: "x",
    queryLower: "x",
    queryTokens: ["x"],
    graphContext: null,
    utilityScores: new Map([[opts.itemId, utilScore]]),
    utilityDecayConfig: opts.utilityDecayConfig,
    positiveFeedbackCounts: opts.positiveFeedbackCounts,
  };
}

function expectedDefaultScore(utility: number, daysSinceLastUse: number, baseScore = 1): number {
  // Mirror the pre-2A formula exactly: `recency = exp(-days / 30)`, with
  // utility weight 0.5 and max boost 1.5 — the same constants the real
  // contributor uses. Lets us assert default-safety in isolation.
  const recencyFactor = Math.exp(-daysSinceLastUse / 30);
  const rawBoost = 1 + utility * recencyFactor * 0.5;
  return baseScore * Math.min(rawBoost, 1.5);
}

describe("utility recency decay (Phase 2A / Rec 5)", () => {
  test("default behaviour matches pre-2A exp(-days/30) curve", () => {
    const item = makeRanked(1);
    const ctx = makeUtilContext({ itemId: 1, utility: 0.6, lastUsedDaysAgo: 15 });
    applyUtilityContributors(item, ctx);
    expect(item.score).toBeCloseTo(expectedDefaultScore(0.6, 15), 6);
    expect(item.utilityBoosted).toBe(true);
  });

  test("configured halfLifeDays: 60 produces slower decay (higher boost) than default 30", () => {
    const itemSlow = makeRanked(1);
    const ctxSlow = makeUtilContext({
      itemId: 1,
      utility: 0.6,
      lastUsedDaysAgo: 30,
      utilityDecayConfig: { halfLifeDays: 60, feedbackStabilityBoost: 1.5 },
    });
    applyUtilityContributors(itemSlow, ctxSlow);

    const itemDefault = makeRanked(1);
    const ctxDefault = makeUtilContext({ itemId: 1, utility: 0.6, lastUsedDaysAgo: 30 });
    applyUtilityContributors(itemDefault, ctxDefault);

    expect(itemSlow.score).toBeGreaterThan(itemDefault.score);
    // Sanity: recencyFactor at days=30, halfLife=60 = exp(-0.5) ≈ 0.6065
    const expectedRecency = Math.exp(-30 / 60);
    const expectedBoost = Math.min(1 + 0.6 * expectedRecency * 0.5, 1.5);
    expect(itemSlow.score).toBeCloseTo(1 * expectedBoost, 6);
  });

  test("stability boost: positiveCount=3 with boost=1.5 yields halfLife × 1.5^3 = halfLife × 3.375", () => {
    const item = makeRanked(42);
    const ctx = makeUtilContext({
      itemId: 42,
      utility: 0.8,
      lastUsedDaysAgo: 30,
      utilityDecayConfig: { halfLifeDays: 30, feedbackStabilityBoost: 1.5 },
      positiveFeedbackCounts: new Map([[42, 3]]),
    });
    applyUtilityContributors(item, ctx);

    const effectiveHalfLife = 30 * 1.5 ** 3; // 101.25 — below 4× cap (120)
    const expectedRecency = Math.exp(-30 / effectiveHalfLife);
    const expectedBoost = Math.min(1 + 0.8 * expectedRecency * 0.5, 1.5);
    expect(item.score).toBeCloseTo(1 * expectedBoost, 6);
  });

  test("4× cap: positive count of 100 caps effective half-life at halfLifeDays × 4", () => {
    const itemHuge = makeRanked(7);
    const ctxHuge = makeUtilContext({
      itemId: 7,
      utility: 0.6,
      lastUsedDaysAgo: 30,
      utilityDecayConfig: { halfLifeDays: 30, feedbackStabilityBoost: 1.5 },
      positiveFeedbackCounts: new Map([[7, 100]]),
    });
    applyUtilityContributors(itemHuge, ctxHuge);

    const itemCapped = makeRanked(7);
    const ctxCapped = makeUtilContext({
      itemId: 7,
      utility: 0.6,
      lastUsedDaysAgo: 30,
      // 1.5^N grows past 4× very quickly; the cap should kick in at halfLife * 4.
      // Force the comparison by setting positive count to the exact saturation point.
      utilityDecayConfig: { halfLifeDays: 30, feedbackStabilityBoost: 1.5 },
      positiveFeedbackCounts: new Map([[7, 4]]),
    });
    applyUtilityContributors(itemCapped, ctxCapped);

    // At positive=100 the formula attempts halfLife × 1.5^100 → must clamp to halfLife × 4.
    // At positive=4 we have 1.5^4 = 5.0625 — also above the cap, so both should
    // produce IDENTICAL scores (both clamped to halfLife × 4 = 120).
    expect(itemHuge.score).toBeCloseTo(itemCapped.score, 9);

    const cappedHalfLife = 30 * 4;
    const expectedRecency = Math.exp(-30 / cappedHalfLife);
    const expectedBoost = Math.min(1 + 0.6 * expectedRecency * 0.5, 1.5);
    expect(itemHuge.score).toBeCloseTo(1 * expectedBoost, 6);
  });

  test("positiveFeedbackCounts.get(id) === 0 (no boost) matches the default decay", () => {
    const itemBoostedZero = makeRanked(11);
    const ctxBoostedZero = makeUtilContext({
      itemId: 11,
      utility: 0.6,
      lastUsedDaysAgo: 15,
      utilityDecayConfig: { halfLifeDays: 30, feedbackStabilityBoost: 1.5 },
      positiveFeedbackCounts: new Map([[11, 0]]),
    });
    applyUtilityContributors(itemBoostedZero, ctxBoostedZero);

    const itemDefault = makeRanked(11);
    const ctxDefault = makeUtilContext({ itemId: 11, utility: 0.6, lastUsedDaysAgo: 15 });
    applyUtilityContributors(itemDefault, ctxDefault);

    // Both should follow exp(-15/30) because 1.5^0 = 1 collapses the formula.
    expect(itemBoostedZero.score).toBeCloseTo(itemDefault.score, 9);
  });

  describe("shouldQueryPositiveFeedbackCounts gate (Rec 5 hot-path)", () => {
    // The bug this guards against: prior to the fix the per-search DB lookup
    // was gated on `feedbackStabilityBoost > 1.0`, but that value defaulted to
    // 1.5 when `utilityDecay` was absent — so the query fired on EVERY search
    // even though the ranking contributor ignored its result. The gate must
    // require an explicit opt-in (`utilityDecay` defined) AND a non-no-op boost.

    test("returns false when utilityDecay config is undefined (no opt-in)", () => {
      expect(shouldQueryPositiveFeedbackCounts(undefined)).toBe(false);
    });

    test("returns true when utilityDecay is defined with default boost (1.5)", () => {
      expect(shouldQueryPositiveFeedbackCounts({ halfLifeDays: 30 })).toBe(true);
    });

    test("returns true when utilityDecay is defined with explicit boost > 1.0", () => {
      expect(shouldQueryPositiveFeedbackCounts({ halfLifeDays: 30, feedbackStabilityBoost: 2.0 })).toBe(true);
    });

    test("returns false when utilityDecay is defined but boost == 1.0 (no-op)", () => {
      expect(shouldQueryPositiveFeedbackCounts({ feedbackStabilityBoost: 1.0 })).toBe(false);
    });

    test("returns false when utilityDecay is the empty object and boost defaults to 1.5", () => {
      // Subtle: an empty `utilityDecay: {}` is still an explicit opt-in, so
      // the default boost of 1.5 makes this true — preserves intent that the
      // user wanted the feature even with no overrides.
      expect(shouldQueryPositiveFeedbackCounts({})).toBe(true);
    });
  });

  test("feedbackStabilityBoost = 1.0 disables the boost entirely (regardless of count)", () => {
    const itemBoostOne = makeRanked(99);
    const ctxBoostOne = makeUtilContext({
      itemId: 99,
      utility: 0.6,
      lastUsedDaysAgo: 15,
      utilityDecayConfig: { halfLifeDays: 30, feedbackStabilityBoost: 1.0 },
      positiveFeedbackCounts: new Map([[99, 50]]),
    });
    applyUtilityContributors(itemBoostOne, ctxBoostOne);

    const itemDefault = makeRanked(99);
    const ctxDefault = makeUtilContext({ itemId: 99, utility: 0.6, lastUsedDaysAgo: 15 });
    applyUtilityContributors(itemDefault, ctxDefault);

    expect(itemBoostOne.score).toBeCloseTo(itemDefault.score, 9);
  });
});
