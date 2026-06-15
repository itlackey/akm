// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Unit tests for #614 — symmetric valence weighting in the improve eligibility
 * sort. Pure scoring; no storage. Covers:
 *   - symmetry: equal-magnitude strong-positive vs strong-negative rank
 *     comparably (neither is ignored),
 *   - utility remains the primary ordering factor,
 *   - lane routing (high-negative → fix, high-positive → reinforce),
 *   - deterministic sort,
 *   - legacy negative-only parity.
 */

import { describe, expect, test } from "bun:test";
import {
  combinedEligibilityScore,
  computeValenceScore,
  FEEDBACK_WEIGHT,
  negativeOnlyRatio,
  STRONG_VALENCE_THRESHOLD,
  UTILITY_WEIGHT,
} from "../../../src/commands/improve/feedback-valence";

describe("computeValenceScore — symmetric magnitude", () => {
  test("no feedback => zero attention, no lane", () => {
    const s = computeValenceScore({ positive: 0, negative: 0 });
    expect(s).toEqual({ valence: 0, magnitude: 0, attention: 0, lane: null });
  });

  test("equal-magnitude strong positive and strong negative produce equal attention", () => {
    const pos = computeValenceScore({ positive: 10, negative: 0 });
    const neg = computeValenceScore({ positive: 0, negative: 10 });
    // |valence| is symmetric: both fully one-sided → magnitude 1 → equal attention.
    expect(pos.attention).toBe(neg.attention);
    expect(pos.attention).toBe(1);
    // ...but the SIGN differs, so they route to opposite lanes.
    expect(pos.lane).toBe("reinforce");
    expect(neg.lane).toBe("fix");
  });

  test("net valence and magnitude computed from counts", () => {
    const s = computeValenceScore({ positive: 3, negative: 1 });
    expect(s.valence).toBeCloseTo(0.5, 10);
    expect(s.magnitude).toBeCloseTo(0.5, 10);
    expect(s.attention).toBeCloseTo(0.5, 10);
  });

  test("weak / mixed feedback below threshold gets no lane", () => {
    // valence = (2-3)/5 = -0.2, |0.2| < 0.5 threshold
    const s = computeValenceScore({ positive: 2, negative: 3 });
    expect(s.magnitude).toBeLessThan(STRONG_VALENCE_THRESHOLD);
    expect(s.lane).toBeNull();
  });

  test("lane routing exactly at the strong threshold", () => {
    // valence = (3-1)/4 = 0.5 == threshold → reinforce
    const s = computeValenceScore({ positive: 3, negative: 1 });
    expect(s.magnitude).toBeCloseTo(STRONG_VALENCE_THRESHOLD, 10);
    expect(s.lane).toBe("reinforce");
  });

  test("negative counts are clamped (no negative attention)", () => {
    const s = computeValenceScore({ positive: -5, negative: -5 });
    expect(s.attention).toBe(0);
    expect(s.lane).toBeNull();
  });
});

describe("combinedEligibilityScore — utility dominant", () => {
  test("weights utility above feedback", () => {
    expect(UTILITY_WEIGHT).toBeGreaterThan(FEEDBACK_WEIGHT);
  });

  test("a higher-utility asset outranks a lower-utility one with maxed feedback", () => {
    // Asset A: high utility, no feedback. Asset B: low utility, full attention.
    const aScore = combinedEligibilityScore(0.9, 0);
    const bScore = combinedEligibilityScore(0.3, 1);
    // utility is the primary factor: A (0.63) still beats B (0.51).
    expect(aScore).toBeGreaterThan(bScore);
  });

  test("among equal-utility assets, stronger |valence| ranks higher", () => {
    const strong = combinedEligibilityScore(0.5, computeValenceScore({ positive: 10, negative: 0 }).attention);
    const weak = combinedEligibilityScore(0.5, computeValenceScore({ positive: 2, negative: 3 }).attention);
    expect(strong).toBeGreaterThan(weak);
  });

  test("strong-positive and strong-negative with equal utility rank comparably", () => {
    const posScore = combinedEligibilityScore(0.5, computeValenceScore({ positive: 8, negative: 0 }).attention);
    const negScore = combinedEligibilityScore(0.5, computeValenceScore({ positive: 0, negative: 8 }).attention);
    // Neither is ignored — symmetric magnitude gives them the SAME composite.
    expect(posScore).toBe(negScore);
  });
});

describe("negativeOnlyRatio — legacy parity", () => {
  test("strong positive yields zero (the old blind spot)", () => {
    expect(negativeOnlyRatio({ positive: 10, negative: 0 })).toBe(0);
  });

  test("matches negative proportion", () => {
    expect(negativeOnlyRatio({ positive: 1, negative: 3 })).toBeCloseTo(0.75, 10);
  });

  test("no feedback yields zero", () => {
    expect(negativeOnlyRatio({ positive: 0, negative: 0 })).toBe(0);
  });
});

describe("deterministic sort with symmetric valence", () => {
  type Item = { ref: string; utility: number; counts: { positive: number; negative: number } };

  function sortItems(items: Item[]): string[] {
    return [...items]
      .sort((a, b) => {
        const sa = combinedEligibilityScore(a.utility, computeValenceScore(a.counts).attention);
        const sb = combinedEligibilityScore(b.utility, computeValenceScore(b.counts).attention);
        if (sb !== sa) return sb - sa;
        return a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0;
      })
      .map((i) => i.ref);
  }

  const items: Item[] = [
    { ref: "skill:b", utility: 0.5, counts: { positive: 0, negative: 0 } },
    { ref: "skill:a", utility: 0.5, counts: { positive: 0, negative: 0 } },
    { ref: "skill:hot-pos", utility: 0.5, counts: { positive: 9, negative: 0 } },
    { ref: "skill:hot-neg", utility: 0.5, counts: { positive: 0, negative: 9 } },
  ];

  test("identical scores break ties by ref string, stable across input order", () => {
    const forward = sortItems(items);
    const reversed = sortItems([...items].reverse());
    expect(forward).toEqual(reversed);
  });

  test("equal-magnitude pos/neg are adjacent and tie-broken deterministically", () => {
    const order = sortItems(items);
    // hot-neg and hot-pos both have attention 1 → identical composite; ref
    // string tie-break puts hot-neg before hot-pos. The two no-feedback assets
    // follow, ordered a before b.
    expect(order).toEqual(["skill:hot-neg", "skill:hot-pos", "skill:a", "skill:b"]);
  });
});
