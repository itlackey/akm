// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import { dayRange, isoWeekStart, nearestRank, wilson, zeroFill } from "../src/commands/metrics/stats";

describe("dashboard stats", () => {
  test("dayRange is inclusive and empty when reversed", () => {
    expect(dayRange("2026-10-30", "2026-11-02")).toEqual(["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"]);
    expect(dayRange("2026-11-02", "2026-10-30")).toEqual([]);
  });

  test("isoWeekStart is the Monday of the UTC week", () => {
    expect(isoWeekStart("2026-11-01")).toBe("2026-10-26"); // a Sunday
    expect(isoWeekStart("2026-10-26")).toBe("2026-10-26"); // a Monday
    expect(isoWeekStart("2026-11-04")).toBe("2026-11-02");
  });

  test("zeroFill fills gaps inside coverage, not before the first row, and marks partial days", () => {
    const rows = [
      { day: "2026-10-30", n: 3 },
      { day: "2026-11-01", n: 1 },
    ];
    const filled = zeroFill(rows, (day) => ({ day, n: 0 }), {
      since: "2026-10-28T09:30:00.000Z",
      until: "2026-11-01T12:00:00.000Z",
    });
    // 10-28 and 10-29 are before the first recorded day: unknown, so absent.
    expect(filled).toEqual([
      { day: "2026-10-30", n: 3 },
      { day: "2026-10-31", n: 0 },
      { day: "2026-11-01", n: 1, partial: true },
    ]);
  });

  test("zeroFill marks a window that opens mid-day as partial on its first day", () => {
    const filled = zeroFill([{ day: "2026-10-31", n: 2 }], (day) => ({ day, n: 0 }), {
      since: "2026-10-31T09:30:00.000Z",
      until: "2026-11-01T00:00:00.000Z",
    });
    expect(filled[0]).toEqual({ day: "2026-10-31", n: 2, partial: true });
  });

  test("zeroFill of nothing is nothing", () => {
    expect(
      zeroFill([], (day) => ({ day }), { since: "2026-10-31T00:00:00.000Z", until: "2026-11-01T00:00:00.000Z" }),
    ).toEqual([]);
  });

  test("wilson gives a wide interval for a small sample and none for zero", () => {
    expect(wilson(0, 0)).toBeNull();
    const small = wilson(1, 2);
    const large = wilson(50, 100);
    expect(small && large && small.high - small.low > large.high - large.low).toBe(true);
    expect(large?.low).toBeGreaterThan(0.39);
    expect(large?.high).toBeLessThan(0.61);
  });

  test("nearestRank picks the ranked element", () => {
    expect(nearestRank([], 0.5)).toBeNull();
    expect(nearestRank([1, 2, 3, 4], 0.5)).toBe(2);
    expect(nearestRank([1, 2, 3, 4], 0.95)).toBe(4);
    expect(nearestRank([5], 0)).toBe(5);
  });
});
