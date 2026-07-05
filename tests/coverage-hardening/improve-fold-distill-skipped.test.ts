// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * C1 (13-bus-factor): per-ref `distill-skipped` action rows dominated
 * `improve_runs.result_json` (~13k rows/run, ~91% of result_json bytes) and
 * bloated state.db ~4GB/month. `foldDistillSkipped` replaces the unbounded
 * per-ref list with a bounded aggregate `{ total, byReason, samples }` so the
 * METRIC (total skipped + per-reason breakdown) survives while the row list
 * does not.
 *
 * These tests pin the pure fold: it (a) removes every distill-skipped action
 * from the persisted `actions` array, (b) preserves the total and per-reason
 * counts, and (c) caps the retained sample list.
 */

import { describe, expect, test } from "bun:test";
import {
  DISTILL_SKIPPED_SAMPLE_CAP_PER_REASON,
  foldDistillSkipped,
  type ImproveActionResult,
} from "../../src/core/improve-types";

function skip(ref: string, reason?: string): ImproveActionResult {
  return {
    ref,
    mode: "distill-skipped",
    result: reason === undefined ? { ok: true, reason: "" } : { ok: true, reason },
  };
}

describe("foldDistillSkipped — aggregate replaces the per-ref list", () => {
  test("strips every distill-skipped action from the persisted actions array", () => {
    const actions: ImproveActionResult[] = [
      { ref: "lesson:a", mode: "reflect", result: { ok: true } as never },
      skip("memory:b", "no new signal since last proposal"),
      { ref: "lesson:c", mode: "distill", result: { ok: true } as never },
      skip("memory:d", "pending proposal exists"),
    ];
    const { actions: kept, aggregate } = foldDistillSkipped(actions);
    // The unbounded per-ref distill-skipped rows are gone.
    expect(kept.some((a) => a.mode === "distill-skipped")).toBe(false);
    // Non-skip actions are preserved verbatim and in order.
    expect(kept.map((a) => a.mode)).toEqual(["reflect", "distill"]);
    expect(aggregate?.total).toBe(2);
  });

  test("preserves the total skipped count and the per-reason breakdown", () => {
    const actions: ImproveActionResult[] = [
      skip("memory:a", "no new signal since last proposal"),
      skip("memory:b", "no new signal since last proposal"),
      skip("memory:c", "pending proposal exists"),
      skip("memory:d", "type-filter"),
      skip("memory:e"), // missing/blank reason => "unknown"
    ];
    const { aggregate } = foldDistillSkipped(actions);
    expect(aggregate?.total).toBe(5);
    expect(aggregate?.byReason).toEqual({
      "no new signal since last proposal": 2,
      "pending proposal exists": 1,
      "type-filter": 1,
      unknown: 1,
    });
    // Invariant: the histogram sums to the total (the health-report contract).
    const sum = Object.values(aggregate?.byReason ?? {}).reduce((a, b) => a + b, 0);
    expect(sum).toBe(5);
  });

  test("caps the retained sample list per reason (bounded, not unbounded)", () => {
    const many: ImproveActionResult[] = [];
    for (let i = 0; i < 1000; i++) many.push(skip(`memory:${i}`, "no new signal since last proposal"));
    const { aggregate } = foldDistillSkipped(many);
    expect(aggregate?.total).toBe(1000);
    // Only a small capped sample is retained — NOT 1000 rows.
    expect(aggregate?.samples.length).toBe(DISTILL_SKIPPED_SAMPLE_CAP_PER_REASON);
    for (const s of aggregate?.samples ?? []) {
      expect(s.reason).toBe("no new signal since last proposal");
    }
  });

  test("caps samples independently per reason", () => {
    const actions: ImproveActionResult[] = [];
    for (let i = 0; i < 10; i++) actions.push(skip(`a:${i}`, "reason-a"));
    for (let i = 0; i < 10; i++) actions.push(skip(`b:${i}`, "reason-b"));
    const { aggregate } = foldDistillSkipped(actions);
    const byReasonInSamples: Record<string, number> = {};
    for (const s of aggregate?.samples ?? []) byReasonInSamples[s.reason] = (byReasonInSamples[s.reason] ?? 0) + 1;
    expect(byReasonInSamples["reason-a"]).toBe(DISTILL_SKIPPED_SAMPLE_CAP_PER_REASON);
    expect(byReasonInSamples["reason-b"]).toBe(DISTILL_SKIPPED_SAMPLE_CAP_PER_REASON);
  });

  test("returns no aggregate when there are no distill-skipped actions", () => {
    const actions: ImproveActionResult[] = [
      { ref: "lesson:a", mode: "reflect", result: { ok: true } as never },
      { ref: "lesson:b", mode: "distill", result: { ok: true } as never },
    ];
    const { actions: kept, aggregate } = foldDistillSkipped(actions);
    expect(aggregate).toBeUndefined();
    expect(kept).toHaveLength(2);
  });
});
