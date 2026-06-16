// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Unit tests for #614 — symmetric valence weighting in the improve eligibility
 * sort. Pure scoring; no storage. Covers:
 *   - symmetry: equal-magnitude strong-positive vs strong-negative rank
 *     comparably (neither is ignored),
 *   - lane routing (high-negative → fix, high-positive → reinforce),
 *   - deterministic score.
 */

import { describe, expect, test } from "bun:test";
import { computeValenceScore, STRONG_VALENCE_THRESHOLD } from "../../../src/commands/improve/feedback-valence";

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
