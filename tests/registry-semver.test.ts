// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * R-068 #3: the hand-rolled `satisfiesRange` in `src/registry/semver.ts`
 * silently rejected a long list of valid npm range forms even though the
 * looser `isSemverRange` classifier correctly recognized them as ranges —
 * `1.2.x`, `>1.0.0`, `<2.0.0`, `>=1.0.0 <2.0.0`, `^1.2`, OR-ranges (`a || b`),
 * hyphen ranges, and plain exact versions used as a range. The module now
 * delegates to the real `semver` package (already a runtime dependency).
 * These tests pin every form the register called out, plus the
 * previously-supported forms, so a future re-inlining regresses loudly.
 */

import { describe, expect, test } from "bun:test";
import { isExactSemver, isSemverRange, maxSatisfying } from "../src/registry/semver";

describe("isExactSemver", () => {
  test("true for exact versions", () => {
    expect(isExactSemver("1.2.3")).toBe(true);
    expect(isExactSemver("0.0.1")).toBe(true);
    expect(isExactSemver("1.2.3-beta.1")).toBe(true);
  });

  test("false for ranges, wildcards, and partial versions", () => {
    expect(isExactSemver("^1.2.3")).toBe(false);
    expect(isExactSemver("~1.2.3")).toBe(false);
    expect(isExactSemver("*")).toBe(false);
    expect(isExactSemver("latest")).toBe(false);
    expect(isExactSemver("1.2")).toBe(false);
    expect(isExactSemver("not-a-version")).toBe(false);
  });
});

describe("isSemverRange — every form R-068 #3 called out", () => {
  test.each([
    ["1.2.x", true],
    [">1.0.0", true],
    ["<2.0.0", true],
    [">=1.0.0 <2.0.0", true],
    ["^1.2", true],
    ["^1.2.3", true],
    ["~1.2.3", true],
    ["1.x || 2.x", true], // OR-range
    ["1.2.3 - 2.3.4", true], // hyphen range
    ["1.2.3", true], // exact version used as a range
    ["*", true],
  ])("isSemverRange(%s) -> %s", (input, expected) => {
    expect(isSemverRange(input)).toBe(expected);
  });

  test("false for npm dist-tag conventions and garbage", () => {
    expect(isSemverRange("latest")).toBe(false);
    expect(isSemverRange("not-a-range-at-all")).toBe(false);
  });
});

describe("maxSatisfying — resolves a satisfiable version for every previously-rejected form", () => {
  const versions = ["1.0.0", "1.2.0", "1.2.5", "1.2.9", "1.3.0", "2.0.0", "2.3.4", "3.0.0"];

  test.each([
    ["1.2.x", "1.2.9"],
    [">1.0.0", "3.0.0"],
    ["<2.0.0", "1.3.0"],
    [">=1.0.0 <2.0.0", "1.3.0"],
    ["^1.2", "1.3.0"],
    ["^1.2.3", "1.3.0"], // caret allows minor bumps within the same major
    ["~1.2.3", "1.2.9"], // tilde is patch-only

    ["1.x || 2.x", "2.3.4"],
    ["1.2.3 - 2.3.4", "2.3.4"],
    ["1.2.5", "1.2.5"], // exact version used as a range
    ["*", "3.0.0"],
  ])("maxSatisfying(versions, %s) -> %s", (range, expected) => {
    expect(maxSatisfying(versions, range)).toBe(expected);
  });

  test("returns undefined when nothing satisfies the range", () => {
    expect(maxSatisfying(versions, "^5.0.0")).toBeUndefined();
    expect(maxSatisfying(versions, ">10.0.0")).toBeUndefined();
  });

  test("prerelease versions are excluded by default (matching npm's own semver semantics)", () => {
    const withPrerelease = [...versions, "1.4.0-beta.1"];
    // A plain range does not admit a prerelease of a version it doesn't
    // explicitly reference — the released 1.3.0 still wins over 1.4.0-beta.1.
    expect(maxSatisfying(withPrerelease, "^1.2.0")).toBe("1.3.0");
    // A range that explicitly targets the same [major, minor, patch] with a
    // prerelease tag DOES admit it (narrowed version list so no released
    // version in the same range outranks the prerelease).
    expect(maxSatisfying(["1.3.0", "1.4.0-beta.1"], ">=1.4.0-alpha")).toBe("1.4.0-beta.1");
  });

  test("hyphen range with only a partial upper bound", () => {
    expect(maxSatisfying(versions, "1.0.0 - 1.2.5")).toBe("1.2.5");
  });
});
