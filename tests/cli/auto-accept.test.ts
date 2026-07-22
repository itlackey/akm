/**
 * Deprecation contract for `akm improve --auto-accept` (0.9.0).
 *
 * The confidence gate the flag configured was deleted in 0.9.0. The flag is
 * warn-and-ignore for one minor (removal in 0.10): installed crontabs embed
 * the old command line, so a hard parse error would make scheduled background
 * runs fail invisibly after upgrade.
 *
 * Contract pinned here:
 * - flag absent (undefined) → silent no-op (no warning)
 * - ANY present value — bare flag (`""` from citty), `safe`, `false`, an
 *   integer, out-of-range, or garbage — → exactly one deprecation warning,
 *   never a throw
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { parseAutoAcceptFlag } from "../../src/cli/parse-args";
import { _setWarnSinkForTests } from "../../src/core/warn";
import { overrideSeam } from "../_helpers/seams";

let warnings: string[] = [];

beforeEach(() => {
  warnings = [];
  overrideSeam(_setWarnSinkForTests, (level, args) => {
    if (level === "warn") warnings.push(args.map(String).join(" "));
  });
});

describe("parseAutoAcceptFlag (deprecated warn-and-ignore)", () => {
  test("flag absent (undefined) → no warning", () => {
    parseAutoAcceptFlag(undefined);
    expect(warnings).toEqual([]);
  });

  test.each([
    ["bare flag (empty string from citty)", ""],
    ["whitespace-only value", "   "],
    ["legacy 'safe' alias", "safe"],
    ["legacy 'false' disable", "false"],
    ["legacy integer threshold", "90"],
    ["out-of-range integer", "101"],
    ["negative integer", "-1"],
    ["non-integer garbage", "foo"],
    ["float", "50.5"],
  ] as const)("%s → one deprecation warning, no throw", (_label, raw) => {
    parseAutoAcceptFlag(raw);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("--auto-accept");
    expect(warnings[0]).toContain("deprecated");
    expect(warnings[0]).toContain("0.10");
  });

  test("legacy invalid values never throw (crontab-safety: scheduled runs must not fail)", () => {
    for (const raw of ["nope", "-5", "9000", "safe extra", "NaN"]) {
      expect(() => parseAutoAcceptFlag(raw)).not.toThrow();
    }
  });
});
