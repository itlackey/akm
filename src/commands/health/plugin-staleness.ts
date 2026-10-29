// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Report the installations Claude's native listing selects, not the versions
 * left in its cache. The listing owns scope and merged enabled settings; it
 * cannot prove what an already-running session has loaded. Ambiguous scoped
 * installations and unavailable compatibility contracts are reported as unknown.
 * Remote release checks remain optional under --no-probe.
 */

import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  OPENCODE_V1,
  OPENCODE_V2,
  type OpenCodeFlavor,
  readPackageVersion,
} from "../../integrations/harnesses/opencode/plugin-layout";
import { opencodeCacheDir } from "../../integrations/harnesses/opencode/roots";
import { highestVersion, isExactSemver, isPrerelease, isSemverRange, satisfiesRange } from "../../registry/semver";
import { openCodeConfigSpec } from "../sources/plugin-upgrade";
import type { HealthCheckResult } from "./types";

/**
 * Root directory holding Claude Code's plugin cache + marketplace clones.
 * Resolved per call (not memoized) so `AKM_CLAUDE_PLUGINS_DIR` can be set
 * after import — the override exists so tests point this at an empty
 * fixture directory instead of the real `~/.claude/plugins`, matching
 * `AKM_CLAUDE_PROJECTS_DIR` in `../../integrations/harnesses/claude/session-log.ts`.
 */
function claudePluginsDir(): string {
  return (
    process.env.AKM_CLAUDE_PLUGINS_DIR ??
    process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR ??
    path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude"), "plugins")
  );
}

/**
 * Root of OpenCode's package cache, same override pattern as
 * {@link claudePluginsDir} (`AKM_OPENCODE_CACHE_DIR` for tests).
 * The OpenCode plugins (`akm-opencode`, and `akm-opencode-v2` for OpenCode 2) bundle their own `akm-cli`
 * (layout: `integrations/harnesses/opencode/plugin-layout.ts`) and run it in-process,
 * sharing the host's databases with every other akm install — its version
 * lag matters the same way a stale Claude plugin's does.
 */
function defaultOpencodeCacheRoot(): string {
  return process.env.AKM_OPENCODE_CACHE_DIR ?? opencodeCacheDir();
}

/** One cached copy of an OpenCode plugin's bundled `akm-cli`. */
interface BundledAkm {
  /** The plugin spec OpenCode cached it under, for a layout that has one folder per spec. */
  spec?: string;
  /** The exact version the spec pins, when it does: a pinned plugin is reported, not compared (#1265). */
  pinned?: string;
  version: string;
}

/**
 * An OpenCode plugin package akm knows: which cache folders to read, and how the advisory words it.
 * Add a major here and it is checked; the advisory name, wording and evidence follow from the entry.
 */
interface OpencodePluginLocation {
  flavor: OpenCodeFlavor;
  /** The `name` of the advisory this plugin produces. */
  advisory: string;
  /** How the advisory words the plugin: `OpenCode's` / `OpenCode 2's`. */
  label: string;
  /** The update remedy the warning names. */
  remedy: string;
  /** The cache folders to read under the OpenCode cache root, with the spec each holds when the layout has one. */
  folders: (cacheRoot: string) => { spec?: string; pinned?: string; folder: string }[];
}

const OPENCODE_PLUGIN_LOCATIONS: readonly OpencodePluginLocation[] = [
  {
    // OpenCode 1: <cache>/packages/<spec>/node_modules/akm-cli, the one spec the global config names (#1265).
    flavor: OPENCODE_V1,
    advisory: "opencode-plugin-version",
    label: "OpenCode's",
    remedy: "update the OpenCode plugin",
    folders: (cacheRoot) => {
      // OpenCode caches each spec in its own folder, and a bare name is its `@latest`, as `akm upgrade` reads it. With
      // no config entry, or no folder for the spec, the bare `packages/akm-opencode` is read, as this check always has.
      const { pkg } = OPENCODE_V1;
      const bare = { folder: path.join(cacheRoot, OPENCODE_V1.cacheFolder(pkg)) };
      const named = openCodeConfigSpec(OPENCODE_V1)?.spec;
      if (named === undefined) return [bare];
      const spec = named === pkg ? `${pkg}@latest` : named;
      const folder = path.join(cacheRoot, OPENCODE_V1.cacheFolder(spec));
      if (!fs.existsSync(folder)) return [bare];
      const version = spec.slice(pkg.length + 1);
      return [{ spec, folder, ...(isExactSemver(version) ? { pinned: version } : {}) }];
    },
  },
  {
    // OpenCode 2: <cache>/npm/akm-opencode-v2@<spec>/<epoch-ms>/node_modules/akm-cli, newest build per spec.
    flavor: OPENCODE_V2,
    advisory: "opencode-v2-plugin-version",
    label: "OpenCode 2's akm-opencode-v2",
    remedy: "update the akm-opencode-v2 plugin",
    folders: (cacheRoot) => {
      const npmDir = path.join(cacheRoot, OPENCODE_V2.cacheFolder(""));
      let specs: string[];
      try {
        specs = fs.readdirSync(npmDir).filter((name) => name.startsWith(`${OPENCODE_V2.pkg}@`));
      } catch {
        return [];
      }
      return specs.sort().map((spec) => ({ spec, folder: path.join(npmDir, spec) }));
    },
  },
];

/**
 * The bundled `akm-cli` of each cached copy of `plugin`: its `package.json` is read, never executed,
 * mirroring {@link detectInstalledPlugins}'s manifest read. Copies with no bundled akm-cli are skipped.
 */
function findBundledAkm(plugin: OpencodePluginLocation, cacheRoot: string): BundledAkm[] {
  const found: BundledAkm[] = [];
  for (const { spec, pinned, folder } of plugin.folders(cacheRoot)) {
    const nodeModules = plugin.flavor.nodeModulesDir(folder);
    const version = nodeModules && readPackageVersion(path.join(nodeModules, "akm-cli", "package.json"));
    if (version !== undefined) found.push({ ...(spec ? { spec } : {}), ...(pinned ? { pinned } : {}), version });
  }
  return found;
}

function buildOpencodeBundledAdvisory(
  plugin: OpencodePluginLocation,
  bundled: BundledAkm,
  cliVersion: string,
): HealthCheckResult {
  const bundledVersion = bundled.version;
  const stale = bundledVersion !== cliVersion;
  const where = bundled.spec ? ` (${bundled.spec})` : "";
  if (bundled.pinned) {
    // The config chose this build: there is nothing to update it to, so no staleness verdict.
    return {
      name: plugin.advisory,
      kind: "deterministic",
      status: "pass",
      confidence: "high",
      message: `${plugin.label} plugin is pinned to v${bundled.pinned}${where}; its bundled akm-cli is v${bundledVersion}, and a pinned plugin is not compared with the running CLI v${cliVersion}.`,
      evidence: { bundledVersion, cliVersion, spec: bundled.spec, pinnedVersion: bundled.pinned },
    };
  }
  return {
    name: plugin.advisory,
    kind: "deterministic",
    status: stale ? "warn" : "pass",
    confidence: "high",
    message: stale
      ? `${plugin.label} bundled akm-cli${where} is v${bundledVersion}, but the running CLI is v${cliVersion} — it shares the same databases in-process; ${plugin.remedy}.`
      : `${plugin.label} bundled akm-cli${where} matches the running v${cliVersion}.`,
    evidence: bundled.spec ? { bundledVersion, cliVersion, spec: bundled.spec } : { bundledVersion, cliVersion },
  };
}

/** The native listing owns installation selection, scopes and merged enabled state. */
interface DetectedPlugin {
  harness: "claude";
  marketplace: string;
  pluginName: string;
  version: string;
  pluginDir: string;
  scope: string;
  enabled: boolean | undefined;
  projectPath?: string;
  applicable: boolean;
  selectionKnown: boolean;
}

function detectInstalledPlugins(pluginsRoot: string): DetectedPlugin[] | undefined {
  if (
    !fs.existsSync(path.join(pluginsRoot, "installed_plugins.json")) &&
    !fs.existsSync(path.join(pluginsRoot, "cache"))
  )
    return [];
  try {
    const listed = spawnSync("claude", ["plugin", "list", "--json"], {
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...process.env,
        ...(process.env.AKM_CLAUDE_PLUGINS_DIR
          ? { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR ?? path.dirname(pluginsRoot) }
          : {}),
        CLAUDE_CODE_PLUGIN_CACHE_DIR: pluginsRoot,
      },
    });
    if (listed.status !== 0) return undefined;
    const rows: unknown = JSON.parse(listed.stdout);
    if (!Array.isArray(rows)) return undefined;
    const detected = rows.flatMap((row) => {
      if (typeof row?.id !== "string" || !row.id.startsWith("akm@")) return [];
      const applicable =
        typeof row.projectPath !== "string" ||
        path.resolve(process.cwd()) === path.resolve(row.projectPath) ||
        path.resolve(process.cwd()).startsWith(`${path.resolve(row.projectPath)}${path.sep}`);
      return [
        {
          harness: "claude" as const,
          marketplace: row.id.slice(4),
          pluginName: "akm",
          version:
            typeof row.folderVersion === "string"
              ? row.folderVersion
              : typeof row.version === "string"
                ? row.version
                : "unknown",
          pluginDir:
            typeof row.readFromFolder === "string"
              ? row.readFromFolder
              : typeof row.installPath === "string"
                ? row.installPath
                : "",
          applicable,
          selectionKnown: false,
          scope: typeof row.scope === "string" ? row.scope : "unknown",
          enabled: typeof row.enabled === "boolean" ? row.enabled : undefined,
          ...(typeof row.projectPath === "string" ? { projectPath: row.projectPath } : {}),
        },
      ];
    });
    for (const plugin of detected) {
      const applicable = detected.filter((p) => p.marketplace === plugin.marketplace && p.applicable);
      plugin.selectionKnown =
        plugin.applicable &&
        isExactSemver(plugin.version) &&
        plugin.scope !== "unknown" &&
        plugin.pluginDir !== "" &&
        new Set(applicable.map((p) => `${p.version}:${p.pluginDir}`)).size === 1;
    }
    return detected;
  } catch {
    return undefined;
  }
}

/** Read the contract, never execute plugin source. A minimum admits later prereleases too. */
function readCompatibility(pluginDir: string, cliVersion: string): { versionRange?: string; admitted?: boolean } {
  let text: string;
  try {
    text = fs.readFileSync(path.join(pluginDir, "shared", "akm-version.ts"), "utf8");
  } catch {
    return {};
  }
  const minimum = text.match(/export\s+const\s+AKM_MIN_VERSION\s*=\s*["']([^"']+)["']/)?.[1];
  if (minimum !== undefined) {
    if (!isExactSemver(minimum) || !isExactSemver(cliVersion)) return {};
    return { versionRange: `>=${minimum}`, admitted: highestVersion([minimum, cliVersion]) === cliVersion };
  }
  const range = text.match(/export\s+const\s+AKM_VERSION_RANGE\s*=\s*["']([^"']+)["']/)?.[1];
  if (!range || !isSemverRange(range) || !isExactSemver(cliVersion)) return {};
  return { versionRange: range, admitted: satisfiesRange(cliVersion, range) };
}

/**
 * Injectable seam for the one network read this module performs: the release versions the marketplace channel the
 * clone follows offers now. Real impl below; tests supply a fake.
 */
export type ListRemoteTagsFn = (marketplaceDir: string) => string[] | undefined;

const LS_REMOTE_TIMEOUT_MS = 5_000;

/**
 * `git ls-remote --symref origin` against the marketplace clone's configured remote (lists refs only, fetches no
 * objects, writes no local refs), read for the channel the clone follows:
 *
 * - **The remote's default branch** (stable): every stable release tag; the newest is the highest of them.
 * - **Any other branch** (a channel such as `next`): the release tags on that branch's head. A channel branch is
 *   reset to each build it publishes, so its head IS the newest build of the channel, whatever semver order says
 *   about other tags (retired build schemes can sort above current builds).
 * - **No branch** (a marketplace added at a tag ref, which Claude Code clones detached): the release tag the clone
 *   is pinned to. A pinned marketplace never offers anything newer, so `claude plugin update` could not act on a
 *   newer tag elsewhere. A detached clone at an untagged commit reads like the default branch.
 *
 * Returns `undefined` (never throws) when the directory is not a git checkout, has no `origin` remote, or the
 * command fails/times out (e.g. offline): all "cannot determine availability", not "up to date". A channel head
 * with no release tag returns `[]`, which reads the same way.
 */
const realListRemoteTags: ListRemoteTagsFn = (marketplaceDir) => {
  let result: SpawnSyncReturns<string>;
  let branch: string;
  try {
    branch =
      spawnSync("git", ["-C", marketplaceDir, "branch", "--show-current"], {
        encoding: "utf8",
        timeout: LS_REMOTE_TIMEOUT_MS,
      }).stdout?.trim() ?? "";
    result = spawnSync("git", ["-C", marketplaceDir, "ls-remote", "--symref", "origin"], {
      encoding: "utf8",
      timeout: LS_REMOTE_TIMEOUT_MS,
    });
  } catch {
    return undefined;
  }
  if (result.status !== 0 || !result.stdout) return undefined;
  const refs = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split("\t"));
  const defaultBranch = refs
    .find(([value, name]) => name === "HEAD" && value?.startsWith("ref: refs/heads/"))?.[0]
    ?.replace(/^ref: refs\/heads\//, "");
  const tags = refs
    .filter(([, name]) => typeof name === "string" && name.startsWith("refs/tags/"))
    .map(([sha, name]) => ({
      sha: sha as string,
      version: (name as string)
        .replace(/^refs\/tags\//, "")
        .replace(/\^\{\}$/, "")
        .replace(/^v/, ""),
    }))
    .filter((tag) => isExactSemver(tag.version));
  const tagsAt = (sha: string | undefined) => [
    ...new Set(tags.filter((tag) => tag.sha === sha).map((tag) => tag.version)),
  ];
  const onChannelBranch = branch !== "" && defaultBranch !== undefined && branch !== defaultBranch;
  if (onChannelBranch) return tagsAt(refs.find(([, name]) => name === `refs/heads/${branch}`)?.[0]);
  if (branch === "") {
    const pinned = tagsAt(
      spawnSync("git", ["-C", marketplaceDir, "rev-parse", "HEAD"], {
        encoding: "utf8",
        timeout: LS_REMOTE_TIMEOUT_MS,
      }).stdout?.trim(),
    );
    if (pinned.length > 0) return pinned;
  }
  return [...new Set(tags.map((tag) => tag.version).filter((version) => !isPrerelease(version)))];
};

/** Options for {@link collectPluginStalenessAdvisories}. */
export interface PluginStalenessOptions {
  /** Root of the Claude plugin tree (contains `cache/` and `marketplaces/`). Defaults to `claudePluginsDir()`. */
  pluginsRoot?: string;
  /** The running akm-cli version to check plugin compatibility against. */
  cliVersion: string;
  /**
   * Whether check 2 may ask the remote for tags (`akm health --probe`, on by
   * default; `--no-probe` passes `false`). Defaults to `true` here so callers
   * that inject `listRemoteTags` need not repeat it; `health.ts` always passes it.
   */
  probe?: boolean;
  /** Injectable remote-tag lister; defaults to the real `git ls-remote`. */
  listRemoteTags?: ListRemoteTagsFn;
  /** Root of OpenCode's package cache. Defaults to `defaultOpencodeCacheRoot()`. */
  opencodeCacheRoot?: string;
}

/**
 * Build one `plugin-version` advisory per detected `akm` harness plugin,
 * plus one `opencode-plugin-version` advisory when the
 * OpenCode plugin's bundled `akm-cli` is found — it shares the host's
 * databases in-process, so its lag matters the same way a stale Claude
 * plugin's does. Returns `[]` when neither is installed — the benign,
 * common case.
 */
export function collectPluginStalenessAdvisories(options: PluginStalenessOptions): HealthCheckResult[] {
  const pluginsRoot = options.pluginsRoot ?? claudePluginsDir();
  const listRemoteTags = options.listRemoteTags ?? realListRemoteTags;
  const plugins = detectInstalledPlugins(pluginsRoot);

  const probe = options.probe ?? true;

  const results = (plugins ?? []).map((plugin) =>
    buildAdvisory(plugin, options.cliVersion, pluginsRoot, listRemoteTags, probe),
  );

  if (plugins === undefined && fs.existsSync(pluginsRoot)) {
    results.push({
      name: "plugin-version",
      kind: "deterministic",
      status: "unknown",
      confidence: "high",
      message:
        "Claude plugin installation and enabled state could not be resolved with `claude plugin list --json`; cached versions do not establish the selected installation.",
      evidence: { harness: "claude", installedVersion: null, enabled: null, admitted: null },
    });
  }

  const opencodeCacheRoot = options.opencodeCacheRoot ?? defaultOpencodeCacheRoot();
  for (const plugin of OPENCODE_PLUGIN_LOCATIONS) {
    for (const bundled of findBundledAkm(plugin, opencodeCacheRoot)) {
      results.push(buildOpencodeBundledAdvisory(plugin, bundled, options.cliVersion));
    }
  }

  return results;
}

function buildAdvisory(
  plugin: DetectedPlugin,
  cliVersion: string,
  pluginsRoot: string,
  listRemoteTags: ListRemoteTagsFn,
  probe: boolean,
): HealthCheckResult {
  const pluginRef = `${plugin.pluginName}@${plugin.marketplace}`;

  // Point 2: newest available vs. installed, via the marketplace clone's remote.
  const marketplaceDir = path.join(pluginsRoot, "marketplaces", plugin.marketplace);
  let availableVersion: string | undefined;
  try {
    const tags =
      probe && plugin.selectionKnown && plugin.enabled !== false && fs.existsSync(marketplaceDir)
        ? listRemoteTags(marketplaceDir)
        : undefined;
    availableVersion = tags && tags.length > 0 ? highestVersion(tags) : undefined;
  } catch {
    availableVersion = undefined;
  }
  const stale =
    availableVersion !== undefined &&
    plugin.version !== availableVersion &&
    highestVersion([plugin.version, availableVersion]) === availableVersion;

  // Point 3: does the plugin's own declared range admit the running CLI?
  const { versionRange, admitted } = readCompatibility(plugin.pluginDir, cliVersion);

  const messageParts = [
    `${pluginRef}: installed ${plugin.version} (${plugin.scope}${plugin.projectPath ? `: ${plugin.projectPath}` : ""})`,
  ];
  if (!plugin.applicable) messageParts.push("installed for another project; not selected in this directory");
  else if (!plugin.selectionKnown) messageParts.push("effective selection unknown across native installations");
  if (plugin.enabled === false) messageParts.push("disabled in Claude settings");
  else if (plugin.enabled === undefined) messageParts.push("enabled state unknown");
  if (admitted === undefined) messageParts.push("CLI compatibility unknown");
  if (!probe) messageParts.push("newest tag was not probed");
  if (availableVersion !== undefined) {
    messageParts.push(stale ? `available ${availableVersion} (STALE)` : `available ${availableVersion} (up to date)`);
  }
  if (stale) messageParts.push(`-> claude plugin update ${pluginRef}`);
  if (plugin.selectionKnown && plugin.enabled === true && admitted === false) {
    messageParts.push(
      `installed plugin requires akm-cli ${versionRange}; running ${cliVersion} -> NOT ADMITTED by the plugin compatibility contract`,
    );
  }

  return {
    name: "plugin-version",
    kind: "deterministic",
    // Not probed => staleness is unknown, not "up to date"; only the local
    // range check can still warn.
    status:
      plugin.enabled === false || !plugin.applicable
        ? "pass"
        : !plugin.selectionKnown || plugin.enabled === undefined
          ? "unknown"
          : stale || admitted === false
            ? "warn"
            : probe && availableVersion !== undefined && admitted !== undefined && plugin.enabled === true
              ? "pass"
              : "unknown",
    confidence: "high",
    message: messageParts.join(" — "),
    evidence: {
      harness: plugin.harness,
      marketplace: plugin.marketplace,
      plugin: plugin.pluginName,
      installedVersion: plugin.version,
      scope: plugin.scope,
      applicable: plugin.applicable,
      selectionKnown: plugin.selectionKnown,
      projectPath: plugin.projectPath ?? null,
      enabled: plugin.enabled ?? null,
      installPath: plugin.pluginDir,
      availableVersion: availableVersion ?? null,
      ...(probe ? {} : { probed: false }),
      stale,
      versionRange: versionRange ?? null,
      cliVersion,
      admitted: admitted ?? null,
    },
  };
}
