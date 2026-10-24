// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Registry semver engine (§4.6 dedup, WI-9.3).
 *
 * R-068 #3: this used to be a hand-rolled parse/compare/range implementation
 * (a verbatim move from `./resolve.ts`) that only understood exact versions,
 * `^x.y.z`, `~x.y.z`, `>=x.y.z`, and `*`/`latest`. Every OTHER valid npm range
 * form was silently REJECTED by `satisfiesRange` even though the looser
 * `isSemverRange` classifier correctly recognized it as a range: `1.2.x`,
 * `>1.0.0`, `<2.0.0`, compound ranges (`>=1.0.0 <2.0.0`), partial carets
 * (`^1.2`), OR-ranges (`a || b`), hyphen ranges (`1.2.3 - 2.3.4`), and plain
 * exact versions used as a range. A silently-empty `maxSatisfying` result for
 * a genuinely satisfiable range meant `akm bundle add pkg@<range>` could fail to
 * resolve a real, installable version.
 *
 * `semver` (the npm package) is already a runtime dependency
 * (`package.json`) — it was simply never imported from `src/`. This module
 * now delegates to it directly instead of re-deriving a subset of its
 * behavior, so every range form `semver` itself understands is supported.
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

/** True when `version` satisfies `range` (both real semver forms). False for an invalid version or range. */
export function satisfiesRange(version: string, range: string): boolean {
  return semver.satisfies(version, range);
}
