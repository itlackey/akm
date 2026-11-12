import { describe, expect, test } from "bun:test";
import { parseTimeoutFlag } from "../src/cli/parse-args";
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
      expect(parseTimeoutFlag(input)).toBe(expected);
    }
  });
  test("an absent flag is undefined", () => {
    expect(parseTimeoutFlag(undefined)).toBeUndefined();
  });
  test("rejects malformed, zero, negative, fractional, month and overflowing values", () => {
    for (const input of ["", "0", "0s", "-1s", "1.5m", "3M", "30seconds", "Infinity", "999999999999999999999d"]) {
      expect(() => parseTimeoutFlag(input)).toThrow(
        /Invalid --timeout value.*bare N is milliseconds, or N with ms, s, m, h or d/,
      );
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
