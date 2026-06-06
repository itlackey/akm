// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Cross-runtime helpers for the akm CLI.
 *
 * akm historically targeted Bun exclusively, reaching for Bun-global APIs
 * (`Bun.spawnSync`, `Bun.write`, `Bun.resolveSync`, `Bun.semver`). The 0.9.0
 * cross-runtime stability release adds standard Node.js support. These helpers
 * centralise the runtime detection used to pick Node-compatible code paths and
 * to emit the correct user-facing install commands.
 */

/** True when executing under the Bun runtime. */
export function isBun(): boolean {
  return typeof (globalThis as { Bun?: unknown }).Bun !== "undefined" && typeof process.versions.bun === "string";
}

/**
 * The package manager command a user should run to add an optional dependency,
 * given the detected runtime. Bun users get `bun add <pkg>`, everyone else
 * (standard Node.js) gets `npm install <pkg>`.
 */
export function installCommand(pkg: string): string {
  return isBun() ? `bun add ${pkg}` : `npm install ${pkg}`;
}

/**
 * Compare two semver-ish version strings without depending on Bun.semver.
 *
 * Returns a negative number when `a < b`, a positive number when `a > b`, and
 * `0` when they are equal. Pre-release tags (e.g. `1.2.3-rc.1`) sort before the
 * corresponding release, matching semver precedence rules closely enough for
 * akm's "is a newer version available?" check. Non-numeric/malformed segments
 * are treated as `0`.
 */
export function compareSemver(a: string, b: string): number {
  const parsed = (v: string): { nums: number[]; pre: string[] } => {
    const cleaned = v.trim().replace(/^v/, "");
    const [core = "", pre = ""] = cleaned.split("-", 2);
    const nums = core.split(".").map((n) => {
      const parsedNum = Number.parseInt(n, 10);
      return Number.isNaN(parsedNum) ? 0 : parsedNum;
    });
    while (nums.length < 3) nums.push(0);
    const preParts = pre.length > 0 ? pre.split(".") : [];
    return { nums, pre: preParts };
  };

  const pa = parsed(a);
  const pb = parsed(b);

  for (let i = 0; i < Math.max(pa.nums.length, pb.nums.length); i++) {
    const diff = (pa.nums[i] ?? 0) - (pb.nums[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }

  // Equal core versions: a version WITH a pre-release tag is lower than one
  // without (1.0.0-rc.1 < 1.0.0).
  if (pa.pre.length === 0 && pb.pre.length === 0) return 0;
  if (pa.pre.length === 0) return 1;
  if (pb.pre.length === 0) return -1;

  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
    const ea = pa.pre[i];
    const eb = pb.pre[i];
    if (ea === undefined) return -1;
    if (eb === undefined) return 1;
    const na = Number.parseInt(ea, 10);
    const nb = Number.parseInt(eb, 10);
    const aIsNum = !Number.isNaN(na) && /^\d+$/.test(ea);
    const bIsNum = !Number.isNaN(nb) && /^\d+$/.test(eb);
    if (aIsNum && bIsNum) {
      if (na !== nb) return na < nb ? -1 : 1;
    } else if (aIsNum) {
      return -1; // numeric identifiers have lower precedence than alphanumeric
    } else if (bIsNum) {
      return 1;
    } else if (ea !== eb) {
      return ea < eb ? -1 : 1;
    }
  }
  return 0;
}
