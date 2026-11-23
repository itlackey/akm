// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Registry semver engine.
 *
 * This module delegates to `semver` (the npm package, a runtime dependency)
 * rather than re-deriving a subset of its behavior, so every range form
 * `semver` itself understands is supported: `1.2.x`, `>1.0.0`, `<2.0.0`,
 * compound ranges (`>=1.0.0 <2.0.0`), partial carets (`^1.2`), OR-ranges
 * (`a || b`), hyphen ranges (`1.2.3 - 2.3.4`), and plain exact versions used
 * as a range, so `akm bundle add pkg@<range>` resolves a real, installable
 * version.
 *
 * NOTE: `src/runtime.ts` has its own `semverOrder` with a DIFFERENT
 * contract (engine-version ordering, not range satisfaction) — the two are
 * intentionally not unified.
 */

import semver from "semver";

/** True when `version` is an exact, fully-specified semver (not a range, wildcard, or partial version). */
export function isExactSemver(version: string): boolean {
  return semver.valid(version) !== null;
}

/**
 * True when `input` is a semver RANGE expression `maxSatisfying` can
 * evaluate. Deliberately false for npm dist-tag conventions like `"latest"`
 * — those are resolved via `dist-tags` lookup, not range satisfaction.
 */
export function isSemverRange(input: string): boolean {
  return semver.validRange(input) !== null;
}

/** Highest version in `versions` that satisfies `range`, or `undefined` if none match. */
export function maxSatisfying(versions: string[], range: string): string | undefined {
  return semver.maxSatisfying(versions, range) ?? undefined;
}

/**
 * Highest of `versions` in semver order, prereleases included (`0.10.1-beta` sorts above `0.9.30`). Invalid entries
 * are ignored; `undefined` when none is valid. Use this to order known versions, not `maxSatisfying(versions, "*")`,
 * which skips every prerelease.
 */
export function highestVersion(versions: string[]): string | undefined {
  return semver.rsort(versions.filter((version) => semver.valid(version) !== null))[0];
}

/** True when `version` is a valid semver prerelease (`1.2.3-beta`). */
export function isPrerelease(version: string): boolean {
  return semver.valid(version) !== null && semver.prerelease(version) !== null;
}

/** True when `version` satisfies `range` (both real semver forms). False for an invalid version or range. */
export function satisfiesRange(version: string, range: string): boolean {
  return semver.satisfies(version, range);
}
