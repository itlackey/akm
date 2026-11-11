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

/**
 * What a version difference between the host CLI and Desktop's engine asks of the person. A difference inside one release
 * line is informational; across lines, akm's own refusal (`INDEX_SCHEMA_INCOMPATIBLE`) is the real signal, so the advice
 * names the remedy for when it appears.
 */
export function skewAdvice(
  engine: string | undefined,
  host: string | undefined,
): { kind: "none" | "info" | "act"; text: string } {
  const skew = classifyEngineSkew(engine, host);
  if (skew !== "host-older" && skew !== "host-newer") return { kind: "none", text: "" };
  const where = `Host akm ${host} is ${skew === "host-older" ? "older" : "newer"} than this app's engine (${engine}).`;
  if (sameReleaseLine(engine, host))
    return {
      kind: "info",
      text: `${where} They are builds of the same release line, so nothing needs doing unless AKM Desktop reports an incompatible library.`,
    };
  return {
    kind: "act",
    text:
      skew === "host-older"
        ? `${where} If the library index changed, the CLI will ask you to upgrade: use Update CLI & plugins.`
        : `${where} If AKM Desktop says the library was upgraded by a newer AKM, update AKM Desktop.`,
  };
}

/**
 * Why the CLI is not updated: its next release is newer than the engine in this app, which could not read a library the
 * CLI migrated. Says when Desktop's own channel will not offer that release, and that plugins update with the CLI because
 * akm has no plugins-only update.
 */
export function holdReason(
  engine: string | undefined,
  latest: string | undefined,
  desktopChannel: "stable" | "prerelease",
): string | undefined {
  if (!hostUpgradeOutrunsDesktop(engine, latest)) return undefined;
  const notOffered = desktopChannel === "stable" && /-/.test(latest ?? "");
  return `Version ${latest} is newer than the AKM built into this app${
    notOffered ? ", and AKM Desktop follows stable releases only, so it will not be offered to Desktop" : ""
  }. The CLI and its plugins are updated together (akm has no plugins-only update) and are held until AKM Desktop can read what they migrate.`;
}

/**
 * Whether a prerelease CLI can be switched to stable: akm refuses it as a downgrade when stable is older than the
 * installed version. `unknown` when no stable release is known to compare against.
 */
export function stableSwitch(
  installed: string | undefined,
  stable: string | undefined,
): "offer" | "downgrade" | "unknown" {
  const order = compareVersions(stable && !/-/.test(stable) ? stable : undefined, installed);
  return order === null ? "unknown" : order >= 0 ? "offer" : "downgrade";
}
