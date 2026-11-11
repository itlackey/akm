import { describe, expect, test } from "bun:test";
import { parsePositiveIntFlag, parseTimeoutFlags } from "../src/cli/parse-args";
import { parseDuration } from "../src/core/time";

describe("--timeout grammar", () => {
  test("bare N is milliseconds; ms, s, m, h and d convert", () => {
    for (const [input, expected] of [
      ["30s", 30000],
      ["2m", 120000],
      ["1h", 3600000],
      ["1d", 86400000],
      ["250ms", 250],
      ["30000", 30000],
    ] as const) {
      expect(parseTimeoutFlags(input, undefined)).toBe(expected);
    }
  });
  test("keeps legacy absence and accepts equal explicit budgets", () => {
    expect(parseTimeoutFlags(undefined, undefined)).toBeUndefined();
    expect(parseTimeoutFlags(undefined, 123)).toBe(123);
    expect(parseTimeoutFlags("30s", parsePositiveIntFlag("30000", "--timeout-ms"))).toBe(30000);
    expect(() => parseTimeoutFlags("30s", 1000)).toThrow("conflicting budgets");
  });
  test("rejects malformed, zero, negative, fractional, month and overflowing values", () => {
    for (const input of ["", "0", "0s", "-1s", "1.5m", "3M", "30seconds", "Infinity", "999999999999999999999d"]) {
      expect(() => parseTimeoutFlags(input, undefined)).toThrow("Invalid --timeout value");
    }
  });
});

describe("shared duration grammar is unchanged", () => {
  test("--since / --expires / asset timeout: keep the single-letter units", () => {
    expect(parseDuration("3M")).toBe(90 * 86400000);
    expect(parseDuration("3m")).toBe(180000);
    expect(parseDuration("30s")).toBeNull();
    expect(parseDuration("30ms")).toBeNull();
  });
});
