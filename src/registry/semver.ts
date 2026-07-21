// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Registry semver engine (§4.6 dedup, WI-9.3).
 *
 * The pure semver parse/compare/range machinery previously inlined in
 * `./resolve.ts` (verbatim move — behavior-preserving). Range support is
 * deliberately minimal: exact versions, `^`, `~`, `>=`, and `*`/`latest`,
 * which is all the registry resolution paths use.
 *
 * NOTE: `src/runtime.ts` has its own `semverOrder` with a DIFFERENT
 * contract (engine-version ordering, not range satisfaction) — the two are
 * intentionally not unified.
 */

interface SemverParts {
  major: number;
  minor: number;
  patch: number;
  prerelease?: string;
}

function parseSemver(version: string): SemverParts | undefined {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/);
  if (!match) return undefined;
  return {
    major: parseInt(match[1]!, 10),
    minor: parseInt(match[2]!, 10),
    patch: parseInt(match[3]!, 10),
    prerelease: match[4],
  };
}

export function isExactSemver(version: string): boolean {
  return /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.+-]+)?$/.test(version);
}

export function isSemverRange(input: string): boolean {
  return /^[~^>=<*]/.test(input) || /^\d+\.(\d+|\*)/.test(input);
}

function compareSemver(a: SemverParts, b: SemverParts): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  // Versions with prerelease are lower than release
  if (a.prerelease && !b.prerelease) return -1;
  if (!a.prerelease && b.prerelease) return 1;
  return 0;
}

function semverGte(a: SemverParts, b: SemverParts): boolean {
  return compareSemver(a, b) >= 0;
}

function satisfiesRange(version: SemverParts, range: string): boolean {
  // Skip pre-release versions unless range specifically mentions one
  if (version.prerelease && !range.includes("-")) return false;

  // ^1.2.3 — compatible with version: same major, >= minor.patch
  const caretMatch = range.match(/^\^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/);
  if (caretMatch) {
    const rMajor = parseInt(caretMatch[1]!, 10);
    const rMinor = parseInt(caretMatch[2]!, 10);
    const rPatch = parseInt(caretMatch[3]!, 10);
    if (version.major !== rMajor) return false;
    // ^0.x has special behavior: ^0.2.3 means >=0.2.3 <0.3.0
    if (rMajor === 0) {
      if (version.minor !== rMinor) return false;
      return version.patch >= rPatch;
    }
    return semverGte(version, { major: rMajor, minor: rMinor, patch: rPatch });
  }

  // ~1.2.3 — same major.minor, patch >= specified
  const tildeMatch = range.match(/^~(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/);
  if (tildeMatch) {
    const rMajor = parseInt(tildeMatch[1]!, 10);
    const rMinor = parseInt(tildeMatch[2]!, 10);
    const rPatch = parseInt(tildeMatch[3]!, 10);
    return version.major === rMajor && version.minor === rMinor && version.patch >= rPatch;
  }

  // >=1.2.3
  const gteMatch = range.match(/^>=(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/);
  if (gteMatch) {
    const rMajor = parseInt(gteMatch[1]!, 10);
    const rMinor = parseInt(gteMatch[2]!, 10);
    const rPatch = parseInt(gteMatch[3]!, 10);
    return semverGte(version, { major: rMajor, minor: rMinor, patch: rPatch });
  }

  // * or latest
  if (range === "*" || range === "latest") return true;

  return false;
}

export function maxSatisfying(versions: string[], range: string): string | undefined {
  const candidates: Array<{ version: string; parsed: SemverParts }> = [];
  for (const v of versions) {
    const parsed = parseSemver(v);
    if (!parsed) continue;
    if (satisfiesRange(parsed, range)) {
      candidates.push({ version: v, parsed });
    }
  }
  if (candidates.length === 0) return undefined;
  candidates.sort((a, b) => compareSemver(b.parsed, a.parsed));
  return candidates[0]!.version;
}
