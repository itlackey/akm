// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Unit tests for #614 — symmetric valence weighting in the improve eligibility
 * sort. Pure scoring; no storage. Covers:
 *   - symmetry: equal-magnitude strong-positive vs strong-negative rank
 *     comparably (neither is ignored),
 *   - deterministic score.
 *
 * ValenceScore.lane / STRONG_VALENCE_THRESHOLD / FeedbackLane (the fix/reinforce
 * attention-lane routing) were deleted in Chunk 7 (WI-7.2, R22) — no consumer
 * read `.lane` outside this module.
 */

import { describe, expect, test } from "bun:test";
import { computeValenceScore } from "../../../src/commands/improve/feedback-valence";

describe("computeValenceScore — symmetric magnitude", () => {
  test("no feedback => zero attention", () => {
    const s = computeValenceScore({ positive: 0, negative: 0 });
    expect(s).toEqual({ valence: 0, magnitude: 0, attention: 0 });
  });

  test("equal-magnitude strong positive and strong negative produce equal attention", () => {
    const pos = computeValenceScore({ positive: 10, negative: 0 });
    const neg = computeValenceScore({ positive: 0, negative: 10 });
    // |valence| is symmetric: both fully one-sided → magnitude 1 → equal attention.
    expect(pos.attention).toBe(neg.attention);
    expect(pos.attention).toBe(1);
  });

  test("net valence and magnitude computed from counts", () => {
    const s = computeValenceScore({ positive: 3, negative: 1 });
    expect(s.valence).toBeCloseTo(0.5, 10);
    expect(s.magnitude).toBeCloseTo(0.5, 10);
    expect(s.attention).toBeCloseTo(0.5, 10);
  });

  test("negative counts are clamped (no negative attention)", () => {
    const s = computeValenceScore({ positive: -5, negative: -5 });
    expect(s.attention).toBe(0);
  });
});
