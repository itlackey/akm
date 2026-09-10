// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `plugin-version` advisory for `akm health` (itlackey/akm#832).
 *
 * #828 was filed as a CLI bug — session extraction failing on 232/234 runs —
 * and took a full investigation to resolve. The actual cause: the harness
 * plugin (`akm@akm-plugins`, installed in Claude Code's plugin cache) was
 * three days stale relative to the fix, and its own `AKM_VERSION_RANGE` gate
 * had nothing to do with it — the plugin was simply running old code. Every
 * fact needed to reach that conclusion in one step was already on disk:
 *
 *   - installed plugin version: `~/.claude/plugins/cache/<marketplace>/akm/<version>/.claude-plugin/plugin.json`
 *   - the plugin's own akm-cli compatibility contract: `<pluginDir>/shared/akm-version.ts`'s `AKM_VERSION_RANGE`
 *   - the running CLI's version: `../../version.ts`'s `pkgVersion`
 *
 * Nothing correlated them, so a stale plugin was indistinguishable from a
 * broken CLI. This module closes that gap with three checks, one per
 * detected plugin:
 *
 *   1. report the installed version;
 *   2. compare it against the newest tag published to the plugin's git
 *      remote, and warn (naming the update command) when behind;
 *   3. the sharp one — check whether the *installed plugin's* declared
 *      `AKM_VERSION_RANGE` admits the *running* CLI version. When it does
 *      not, the plugin has silently disabled itself (both surfaces log
 *      `version_out_of_range` / `akm_version_mismatch` and degrade quietly)
 *      and there was previously no way to know that from the CLI side.
 *
 * Read-only: this never fetches, writes, or mutates the plugin cache or
 * marketplace clone. Check 2 is one of two deliberate exceptions to "`akm
 * health` makes no network call" (see `./health-advisories.md`; the other is
 * the `cli-version` advisory in `./version-drift.ts`, #950): a plugin's
 * local marketplace clone is not proof of what is newest upstream — the
 * incident above involved a clone that hadn't seen the fix's tag at all — so
 * the only way to ever detect drift is to ask the remote what tags exist.
 * That query is a `git ls-remote --tags` (lists refs; fetches nothing,
 * writes nothing) with a short timeout, and any failure (offline, no
 * remote, timeout) degrades to "installed version reported, no staleness
 * claim" rather than a false positive or a hang. Unlike `cli-version`, this
 * check is NOT gated behind `--probe`/`--no-probe` — it predates that flag
 * and stays unconditional; see `./version-drift.ts` for why the newer check
 * chose the opposite default.
 *
 * Every collector here is best-effort and silent on missing/unreadable
 * input: no Claude plugin installed, no marketplace clone, an unreadable
 * manifest, or a malformed version range must never crash `akm health` and
 * must never produce a false "stale" or "inactive" warning.
 */

import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isExactSemver, isSemverRange, maxSatisfying, satisfiesRange } from "../../registry/semver";
import type { HealthCheckResult } from "./types";

/**
 * Root directory holding Claude Code's plugin cache + marketplace clones.
 * Resolved per call (not memoized) so `AKM_CLAUDE_PLUGINS_DIR` can be set
 * after import — the override exists so tests point this at an empty
 * fixture directory instead of the real `~/.claude/plugins`, matching
 * `AKM_CLAUDE_PROJECTS_DIR` in `../../integrations/harnesses/claude/session-log.ts`.
 */
function claudePluginsDir(): string {
  return process.env.AKM_CLAUDE_PLUGINS_DIR ?? path.join(os.homedir(), ".claude", "plugins");
}

/** One `akm` plugin found in the Claude Code plugin cache. */
interface DetectedPlugin {
  harness: "claude";
  marketplace: string;
  pluginName: string;
  version: string;
  pluginDir: string;
}

/**
 * Scan `<pluginsRoot>/cache/<marketplace>/akm/<version>/` for every
 * `akm` plugin cache entry, picking the highest cached version per
 * marketplace when more than one is present. Returns `[]` (never throws)
 * when the cache directory is absent, empty, or unreadable — that is the
 * ordinary "no Claude plugin installed" case, not an error.
 */
function detectInstalledPlugins(pluginsRoot: string): DetectedPlugin[] {
  const cacheDir = path.join(pluginsRoot, "cache");
  let marketplaces: string[];
  try {
    marketplaces = fs.readdirSync(cacheDir);
  } catch {
    return [];
  }

  const detected: DetectedPlugin[] = [];
  for (const marketplace of marketplaces) {
    const pluginDir = path.join(cacheDir, marketplace, "akm");
    let versions: string[];
    try {
      versions = fs.readdirSync(pluginDir).filter(isExactSemver);
    } catch {
      continue;
    }
    if (versions.length === 0) continue;
    const latest = maxSatisfying(versions, "*") ?? versions.sort().at(-1);
    if (!latest) continue;
    const versionDir = path.join(pluginDir, latest);
    const manifestPath = path.join(versionDir, ".claude-plugin", "plugin.json");
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
      if (typeof manifest.version !== "string") continue;
      detected.push({
        harness: "claude",
        marketplace,
        pluginName: "akm",
        version: manifest.version,
        pluginDir: versionDir,
      });
    } catch {
      // Unreadable/malformed manifest — skip this entry rather than crash.
    }
  }
  return detected;
}

/**
 * Extract `AKM_VERSION_RANGE` from the installed plugin's vendored
 * `shared/akm-version.ts`. Returns `undefined` when the file is missing,
 * unreadable, or does not contain the expected declaration — callers must
 * treat that as "compatibility unknown", never as a mismatch.
 */
function readVersionRange(pluginDir: string): string | undefined {
  const versionFilePath = path.join(pluginDir, "shared", "akm-version.ts");
  let text: string;
  try {
    text = fs.readFileSync(versionFilePath, "utf8");
  } catch {
    return undefined;
  }
  const match = text.match(/export\s+const\s+AKM_VERSION_RANGE\s*=\s*["']([^"']+)["']/);
  return match?.[1];
}

/** Injectable seam for the one network read this module performs. Real impl below; tests supply a fake. */
export type ListRemoteTagsFn = (marketplaceDir: string) => string[] | undefined;

const LS_REMOTE_TIMEOUT_MS = 5_000;

/**
 * `git ls-remote --tags origin` against the marketplace clone's configured
 * remote — lists refs only, fetches no objects, writes no local refs.
 * Returns `undefined` (never throws) when the directory is not a git
 * checkout, has no `origin` remote, or the command fails/times out (e.g.
 * offline) — all "cannot determine availability", not "up to date".
 */
const realListRemoteTags: ListRemoteTagsFn = (marketplaceDir) => {
  let result: SpawnSyncReturns<string>;
  try {
    result = spawnSync("git", ["-C", marketplaceDir, "ls-remote", "--tags", "origin"], {
      encoding: "utf8",
      timeout: LS_REMOTE_TIMEOUT_MS,
    });
  } catch {
    return undefined;
  }
  if (result.status !== 0 || !result.stdout) return undefined;
  const tags = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split("\t")[1])
    .filter((ref): ref is string => typeof ref === "string" && ref.startsWith("refs/tags/"))
    .map((ref) => ref.replace(/^refs\/tags\//, "").replace(/\^\{\}$/, ""))
    .map((tag) => tag.replace(/^v/, ""))
    .filter(isExactSemver);
  return [...new Set(tags)];
};

/** Options for {@link collectPluginStalenessAdvisories}. */
export interface PluginStalenessOptions {
  /** Root of the Claude plugin tree (contains `cache/` and `marketplaces/`). Defaults to `claudePluginsDir()`. */
  pluginsRoot?: string;
  /** The running akm-cli version to check plugin compatibility against. */
  cliVersion: string;
  /** Injectable remote-tag lister; defaults to the real `git ls-remote`. */
  listRemoteTags?: ListRemoteTagsFn;
}

/**
 * Build one `plugin-version` advisory per detected `akm` harness plugin.
 * Returns `[]` when no plugin is installed — the benign, common case.
 */
export function collectPluginStalenessAdvisories(options: PluginStalenessOptions): HealthCheckResult[] {
  const pluginsRoot = options.pluginsRoot ?? claudePluginsDir();
  const listRemoteTags = options.listRemoteTags ?? realListRemoteTags;
  const plugins = detectInstalledPlugins(pluginsRoot);

  return plugins.map((plugin) => buildAdvisory(plugin, options.cliVersion, pluginsRoot, listRemoteTags));
}

function buildAdvisory(
  plugin: DetectedPlugin,
  cliVersion: string,
  pluginsRoot: string,
  listRemoteTags: ListRemoteTagsFn,
): HealthCheckResult {
  const pluginRef = `${plugin.pluginName}@${plugin.marketplace}`;

  // Point 2: newest available vs. installed, via the marketplace clone's remote.
  const marketplaceDir = path.join(pluginsRoot, "marketplaces", plugin.marketplace);
  let availableVersion: string | undefined;
  try {
    const tags = fs.existsSync(marketplaceDir) ? listRemoteTags(marketplaceDir) : undefined;
    availableVersion = tags && tags.length > 0 ? maxSatisfying(tags, "*") : undefined;
  } catch {
    availableVersion = undefined;
  }
  const stale =
    availableVersion !== undefined &&
    plugin.version !== availableVersion &&
    maxSatisfying([plugin.version, availableVersion], "*") === availableVersion;

  // Point 3: does the plugin's own declared range admit the running CLI?
  const versionRange = readVersionRange(plugin.pluginDir);
  const rangeKnown = versionRange !== undefined && isSemverRange(versionRange);
  const admitted = rangeKnown ? satisfiesRange(cliVersion, versionRange as string) : undefined;

  const messageParts = [`${pluginRef}: installed ${plugin.version}`];
  if (availableVersion !== undefined) {
    messageParts.push(stale ? `available ${availableVersion} (STALE)` : `available ${availableVersion} (up to date)`);
  }
  if (stale) messageParts.push(`-> claude plugin update ${pluginRef}`);
  if (rangeKnown && admitted === false) {
    messageParts.push(
      `installed plugin requires akm-cli ${versionRange}; running ${cliVersion} -> NOT ADMITTED (plugin is inactive)`,
    );
  }

  return {
    name: "plugin-version",
    kind: "deterministic",
    status: stale || admitted === false ? "warn" : "pass",
    confidence: "high",
    message: messageParts.join(" — "),
    evidence: {
      harness: plugin.harness,
      marketplace: plugin.marketplace,
      plugin: plugin.pluginName,
      installedVersion: plugin.version,
      availableVersion: availableVersion ?? null,
      stale,
      versionRange: versionRange ?? null,
      cliVersion,
      admitted: admitted ?? null,
    },
  };
}
