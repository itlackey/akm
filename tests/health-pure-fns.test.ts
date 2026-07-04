// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import { summarizePhaseDurations } from "../src/commands/health/improve-metrics";
import { matchImproveTaskId } from "../src/commands/health/task-runs";
import type { WindowResult } from "../src/commands/health/types";
import { computeDeltas, readNumericPath } from "../src/commands/health/windows";

describe("readNumericPath", () => {
  test("walks a dotted path to a finite number", () => {
    expect(readNumericPath({ a: { b: 5 } }, "a.b")).toBe(5);
  });

  test("returns 0 for a missing leaf", () => {
    expect(readNumericPath({ a: { b: 5 } }, "a.c")).toBe(0);
  });

  test("returns 0 when an intermediate segment is not an object", () => {
    expect(readNumericPath({ a: 1 }, "a.b")).toBe(0);
  });

  test("returns 0 for null root and for non-finite values", () => {
    expect(readNumericPath(null, "a")).toBe(0);
    expect(readNumericPath({ a: Number.NaN }, "a")).toBe(0);
  });
});

describe("summarizePhaseDurations", () => {
  test("empty samples yield all-zero stats", () => {
    expect(summarizePhaseDurations([])).toEqual({ count: 0, totalMs: 0, medianMs: 0, p95Ms: 0 });
  });

  test("nearest-rank median and p95 over sorted samples", () => {
    // sorted [10,20,30]: median = idx floor(0.5*3)=1 → 20; p95 = idx min(2, floor(0.95*3)=2) → 30.
    expect(summarizePhaseDurations([30, 10, 20])).toEqual({ count: 3, totalMs: 60, medianMs: 20, p95Ms: 30 });
  });
});

describe("computeDeltas", () => {
  const mk = (failed: number): WindowResult =>
    ({ improve: { actions: { reflect: { failed } } } }) as unknown as WindowResult;

  test("computes percent change for a changed interesting path", () => {
    const out = computeDeltas(mk(2), mk(4));
    expect(out["improve.actions.reflect.failed"]).toEqual({ from: 2, to: 4, pctChange: 100 });
  });

  test("reports +inf when the baseline is zero", () => {
    const out = computeDeltas(mk(0), mk(4));
    expect(out["improve.actions.reflect.failed"]).toEqual({ from: 0, to: 4, pctChange: "+inf" });
  });

  test("skips paths that are zero in both windows", () => {
    expect(computeDeltas(mk(0), mk(0))).toEqual({});
  });
});

describe("matchImproveTaskId", () => {
  const at = (iso: string) => Date.parse(iso);

  test("attributes a run to the nearest scheduled improve task within ±5 min", () => {
    const taskId = matchImproveTaskId("2026-01-01T00:00:00Z", null, [
      { taskId: "akm-improve-frequent", startMs: at("2026-01-01T00:00:30Z"), endMs: Number.NaN },
      { taskId: "akm-improve-proactive-weekly", startMs: at("2026-01-01T00:04:00Z"), endMs: Number.NaN },
    ]);
    expect(taskId).toBe("akm-improve-frequent");
  });

  test("returns 'manual' when no task starts within the window", () => {
    const taskId = matchImproveTaskId("2026-01-01T00:00:00Z", null, [
      { taskId: "akm-improve-frequent", startMs: at("2026-01-01T00:10:00Z"), endMs: Number.NaN },
    ]);
    expect(taskId).toBe("manual");
  });

  test("returns 'manual' for an unparseable start timestamp", () => {
    expect(matchImproveTaskId("not-a-date", null, [])).toBe("manual");
  });
});
