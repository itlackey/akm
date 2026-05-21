/**
 * Parser tests for `akm improve --auto-accept`.
 *
 * Semantics:
 * - flag absent → 90 (default-on)
 * - bare flag (`--auto-accept`) → 90
 * - `--auto-accept=false` (case-insensitive) → undefined (disables)
 * - `--auto-accept=safe` (case-insensitive) → 90 (back-compat alias)
 * - `--auto-accept=<N>` with integer N ∈ [0, 100] → N
 * - otherwise → throws UsageError("INVALID_FLAG_VALUE")
 *
 * citty maps a bare `--auto-accept` (no value) to the empty string `""` and
 * an absent flag to `undefined`, which is how we distinguish those two cases.
 */

import { describe, expect, test } from "bun:test";
import { parseAutoAcceptFlag } from "../../src/cli/parse-args";
import { UsageError } from "../../src/core/errors";

describe("parseAutoAcceptFlag", () => {
  test("flag absent (undefined) → 90 (default-on)", () => {
    expect(parseAutoAcceptFlag(undefined)).toBe(90);
  });

  test("bare flag (empty string from citty) → 90", () => {
    expect(parseAutoAcceptFlag("")).toBe(90);
  });

  test("whitespace-only value → 90 (treated as bare)", () => {
    expect(parseAutoAcceptFlag("   ")).toBe(90);
  });

  test("--auto-accept=false → undefined", () => {
    expect(parseAutoAcceptFlag("false")).toBeUndefined();
  });

  test("--auto-accept=FALSE → undefined (case-insensitive)", () => {
    expect(parseAutoAcceptFlag("FALSE")).toBeUndefined();
  });

  test("--auto-accept=False → undefined (mixed case)", () => {
    expect(parseAutoAcceptFlag("False")).toBeUndefined();
  });

  test("--auto-accept=safe → 90", () => {
    expect(parseAutoAcceptFlag("safe")).toBe(90);
  });

  test("--auto-accept=SAFE → 90 (case-insensitive)", () => {
    expect(parseAutoAcceptFlag("SAFE")).toBe(90);
  });

  test("--auto-accept=0 → 0 (lower bound)", () => {
    expect(parseAutoAcceptFlag("0")).toBe(0);
  });

  test("--auto-accept=50 → 50", () => {
    expect(parseAutoAcceptFlag("50")).toBe(50);
  });

  test("--auto-accept=90 → 90 (default)", () => {
    expect(parseAutoAcceptFlag("90")).toBe(90);
  });

  test("--auto-accept=100 → 100 (upper bound)", () => {
    expect(parseAutoAcceptFlag("100")).toBe(100);
  });

  test("--auto-accept=-1 → throws UsageError(INVALID_FLAG_VALUE)", () => {
    // Negative integers fail the `^\d+$` check before the range check.
    let err: unknown;
    try {
      parseAutoAcceptFlag("-1");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(UsageError);
    expect((err as UsageError).code).toBe("INVALID_FLAG_VALUE");
  });

  test("--auto-accept=101 → throws UsageError (out of range)", () => {
    let err: unknown;
    try {
      parseAutoAcceptFlag("101");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(UsageError);
    expect((err as UsageError).code).toBe("INVALID_FLAG_VALUE");
  });

  test("--auto-accept=foo → throws UsageError", () => {
    let err: unknown;
    try {
      parseAutoAcceptFlag("foo");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(UsageError);
    expect((err as UsageError).code).toBe("INVALID_FLAG_VALUE");
  });

  test("--auto-accept=50.5 → throws UsageError (integer only)", () => {
    let err: unknown;
    try {
      parseAutoAcceptFlag("50.5");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(UsageError);
    expect((err as UsageError).code).toBe("INVALID_FLAG_VALUE");
  });

  test("error message mentions the legal forms", () => {
    let err: unknown;
    try {
      parseAutoAcceptFlag("nope");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(UsageError);
    const msg = (err as UsageError).message;
    expect(msg).toContain("--auto-accept");
    expect(msg).toContain("0-100");
    expect(msg).toContain("safe");
    expect(msg).toContain("false");
  });
});
