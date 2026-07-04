// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import { parseDuration } from "../../src/core/time";

// Characterization tests pinning the shared duration-shorthand parser that the
// four former copies (consolidate, health, --window-compare, --expires) now
// route through. The key contract is that `m` is caller-defined via the unit
// map — MINUTES for some callers, MONTHS for others — and the helper never
// picks a winner.

const MINUTE = 60_000;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;
const MONTH_30D = 30 * DAY;

describe("parseDuration", () => {
  test("multiplies amount by the unit map's multiplier", () => {
    const units = { m: MINUTE, h: HOUR, d: DAY };
    expect(parseDuration("30m", units)).toBe(30 * MINUTE);
    expect(parseDuration("12h", units)).toBe(12 * HOUR);
    expect(parseDuration("7d", units)).toBe(7 * DAY);
  });

  test("`m` semantics are entirely caller-controlled (minute vs month)", () => {
    expect(parseDuration("6m", { m: MINUTE })).toBe(6 * MINUTE);
    expect(parseDuration("6m", { m: MONTH_30D })).toBe(6 * MONTH_30D);
  });

  test("returns null when the input does not match <digits><letter>", () => {
    const units = { m: MINUTE, h: HOUR, d: DAY };
    expect(parseDuration("forever", units)).toBeNull();
    expect(parseDuration("30", units)).toBeNull();
    expect(parseDuration("d30", units)).toBeNull();
    expect(parseDuration("2026-04-01", units)).toBeNull();
    expect(parseDuration("", units)).toBeNull();
  });

  test("returns null when the matched unit is absent from the map", () => {
    // Case-sensitive against map keys: an upper-case `M` misses a lower-case map.
    expect(parseDuration("5M", { m: MINUTE })).toBeNull();
    expect(parseDuration("5y", { m: MINUTE, h: HOUR, d: DAY })).toBeNull();
  });

  test("trims surrounding whitespace before matching", () => {
    expect(parseDuration("  7d  ", { d: DAY })).toBe(7 * DAY);
  });

  test("amount 0 yields 0 (callers enforce their own positivity policy)", () => {
    expect(parseDuration("0h", { h: HOUR })).toBe(0);
  });
});
