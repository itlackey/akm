// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Desktop runs its bundled akm engine; the user's terminal and plugins run the host `akm`. Both read one data directory.
 * An older reader refuses a newer index layout (`INDEX_SCHEMA_INCOMPATIBLE`) and names its upgrade, so the two engines
 * converge by updating, and skew always has a stated remedy. Nothing here changes behavior; it names the remedy.
 */
export type Skew = "unknown" | "same" | "host-older" | "host-newer";

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/** Semver order: negative when `a` is older than `b`, or null when either is not a version. */
export function compareVersions(a: string | undefined, b: string | undefined): number | null {
  const left = a ? VERSION.exec(a.trim()) : null;
  const right = b ? VERSION.exec(b.trim()) : null;
  if (!left || !right) return null;
  for (const index of [1, 2, 3]) {
    const difference = Number(left[index]) - Number(right[index]);
    if (difference) return difference;
  }
  const [x, y] = [left[4], right[4]];
  if (x === y) return 0;
  if (!x) return 1; // 1.0.0 is newer than 1.0.0-beta
  if (!y) return -1;
  const [xs, ys] = [x.split("."), y.split(".")];
  for (let index = 0; index < Math.max(xs.length, ys.length); index++) {
    const [p, q] = [xs[index], ys[index]];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const [pn, qn] = [/^\d+$/.test(p), /^\d+$/.test(q)];
    if (pn && qn) return Number(p) - Number(q);
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

/** Same release line (major and minor): a difference between its builds is informational. Real incompatibility is reported by akm itself. */
export function sameReleaseLine(engine: string | undefined, host: string | undefined): boolean {
  const line = (version: string | undefined) =>
    version ? VERSION.exec(version.trim())?.slice(1, 3).join(".") : undefined;
  const [a, b] = [line(engine), line(host)];
  return a !== undefined && a === b;
}

export function classifyEngineSkew(engine: string | undefined, host: string | undefined): Skew {
  const order = compareVersions(host, engine);
  if (order === null) return "unknown";
  return order === 0 ? "same" : order < 0 ? "host-older" : "host-newer";
}

/** True when a host upgrade would reach a release newer than Desktop's engine, which Desktop could then not read. */
export function hostUpgradeOutrunsDesktop(engine: string | undefined, latest: string | undefined): boolean {
  const order = compareVersions(latest, engine);
  return order !== null && order > 0;
}

/** What Desktop's own `INDEX_SCHEMA_INCOMPATIBLE` means to its user: akm's text says "upgrade akm", and Desktop is akm. */
export const NEWER_INDEX_MESSAGE =
  "This library was upgraded by a newer AKM than the one built into this app. Update AKM Desktop to the latest release.";
