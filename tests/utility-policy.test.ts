// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import {
  computeNextUtility,
  FEEDBACK_LR,
  HIGH_UTILITY_THRESHOLD,
  MAX_NEG_DELTA_PER_CALL,
  UTILITY_REVIEW_THRESHOLD,
} from "../src/indexer/feedback/utility-policy";

// The MemRL bounded-step utility policy is pure math extracted out of
// indexer/db/db.ts — testable with zero DB, which is the point of the split.

describe("computeNextUtility", () => {
  test("leaves utility untouched when there is no feedback", () => {
    const r = computeNextUtility(0.7, 0, 0);
    expect(r.previousUtility).toBe(0.7);
    expect(r.nextUtility).toBe(0.7);
    expect(r.crossedReviewThreshold).toBe(false);
  });

  test("a single positive signal steps utility up by lr·(1 − current)", () => {
    const r = computeNextUtility(0.5, 1, 0);
    expect(r.nextUtility).toBeCloseTo(0.5 + FEEDBACK_LR * (1 - 0.5), 10);
    expect(r.crossedReviewThreshold).toBe(false);
  });

  test("a single negative signal steps utility down by lr·current", () => {
    const r = computeNextUtility(0.5, 0, 1);
    expect(r.nextUtility).toBeCloseTo(0.5 - FEEDBACK_LR * 0.5, 10);
  });

  test("flags crossing below the review threshold", () => {
    const r = computeNextUtility(HIGH_UTILITY_THRESHOLD, 0, 1);
    expect(r.nextUtility).toBeLessThan(UTILITY_REVIEW_THRESHOLD);
    expect(r.crossedReviewThreshold).toBe(true);
  });

  test("does not flag when the asset stays above the review threshold", () => {
    const r = computeNextUtility(0.9, 0, 1);
    expect(r.nextUtility).toBeGreaterThanOrEqual(UTILITY_REVIEW_THRESHOLD);
    expect(r.crossedReviewThreshold).toBe(false);
  });

  test("balanced positive/negative feedback is a no-op step from the midpoint", () => {
    const r = computeNextUtility(0.5, 1, 1);
    expect(r.nextUtility).toBeCloseTo(0.5, 10);
  });

  test("clamps the result into [0, 1] and never over-steps the negative cap", () => {
    for (const prev of [0, 0.25, 0.5, 0.75, 1]) {
      for (const [pos, neg] of [
        [0, 0],
        [5, 0],
        [0, 5],
        [3, 7],
      ] as const) {
        const r = computeNextUtility(prev, pos, neg);
        expect(r.nextUtility).toBeGreaterThanOrEqual(0);
        expect(r.nextUtility).toBeLessThanOrEqual(1);
        // A single call can only move utility down by at most the per-call cap.
        expect(prev - r.nextUtility).toBeLessThanOrEqual(MAX_NEG_DELTA_PER_CALL + 1e-9);
      }
    }
  });
});
