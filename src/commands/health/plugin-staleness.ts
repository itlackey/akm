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
import { tryParseJson } from "../../core/common";
import {
  OPENCODE_V1,
  OPENCODE_V2,
  type OpenCodeFlavor,
  readPackageVersion,
} from "../../integrations/harnesses/opencode/plugin-layout";
import { opencodeCacheDir } from "../../integrations/harnesses/opencode/roots";
import { highestVersion, isExactSemver, isPrerelease } from "../../registry/semver";
import { codexMarketplace } from "../sources/plugin-channels";
import {
  codexConfigFile,
  codexMarketplaceRef,
  codexPluginVersion,
  openCodeConfigSpec,
} from "../sources/plugin-upgrade";
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
      // OpenCode 2 loads the one spec its global config names and leaves the folders of other specs behind, so only
      // that spec's folder is read (a bare name is its `@latest`). With no entry every cached spec is read, as before.
      const { pkg } = OPENCODE_V2;
      const named = openCodeConfigSpec(OPENCODE_V2)?.spec;
      const loaded = named === undefined ? undefined : named === pkg ? `${pkg}@latest` : named;
      return specs
        .filter((spec) => loaded === undefined || spec === loaded)
        .sort()
        .map((spec) => ({ spec, folder: path.join(npmDir, spec) }));
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
  // Which side is behind decides the remedy: a plugin ahead of the CLI is fixed by `akm upgrade`, not by updating the
  // plugin, and a plugin behind it can only move once its channel publishes a newer build.
  const bundledNewer = stale && highestVersion([bundledVersion, cliVersion]) === bundledVersion;
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
    message: !stale
      ? `${plugin.label} bundled akm-cli${where} matches the running v${cliVersion}.`
      : bundledNewer
        ? `${plugin.label} bundled akm-cli${where} is v${bundledVersion}, newer than the running CLI v${cliVersion} — it shares the same databases in-process; run \`akm upgrade\` to move the CLI up to it.`
        : `${plugin.label} bundled akm-cli${where} is v${bundledVersion}, older than the running CLI v${cliVersion} — it shares the same databases in-process; ${plugin.remedy} when its channel publishes a build for v${cliVersion} (\`akm upgrade\` checks and updates it).`,
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

/**
 * The exact `akm-cli` the plugin's `package.json` pins: the copy Claude Code installs beside it and its hooks run (it
 * never uses an `akm` on PATH), which shares the host's databases with the running CLI. Read, never executed;
 * `undefined` when the manifest is missing or pins no exact version.
 */
function readPinnedCli(pluginDir: string): string | undefined {
  let text: string;
  try {
    text = fs.readFileSync(path.join(pluginDir, "package.json"), "utf8");
  } catch {
    return undefined;
  }
  const manifest = tryParseJson(text) as { dependencies?: Record<string, unknown> } | undefined;
  const pin = manifest?.dependencies?.["akm-cli"];
  return typeof pin === "string" && isExactSemver(pin) ? pin : undefined;
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
const splitRefs = (lsRemote: string): string[][] =>
  lsRemote
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split("\t"));

/**
 * The release versions one channel offers, from `git ls-remote --symref` output: the tags at `branch`'s head when it
 * is not the remote's default branch, the tags at `pinnedSha` when given and tagged, else every stable tag.
 */
function channelVersions(lsRemote: string, branch: string, pinnedSha: string | undefined): string[] {
  const refs = splitRefs(lsRemote);
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
  if (branch === "" && pinnedSha !== undefined) {
    const pinned = tagsAt(pinnedSha);
    if (pinned.length > 0) return pinned;
  }
  return [...new Set(tags.map((tag) => tag.version).filter((version) => !isPrerelease(version)))];
}

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
  const pinnedSha =
    branch === ""
      ? spawnSync("git", ["-C", marketplaceDir, "rev-parse", "HEAD"], {
          encoding: "utf8",
          timeout: LS_REMOTE_TIMEOUT_MS,
        }).stdout?.trim()
      : undefined;
  return channelVersions(result.stdout, branch, pinnedSha);
};

/**
 * The same read against a remote named by URL and the ref a marketplace entry follows (Codex keeps no clone akm
 * reads): a branch, a tag (that release alone), or none for the remote's default branch. `undefined` when the
 * remote cannot be read.
 */
export type ListRemoteTagsAtFn = (remote: string, ref: string | undefined) => string[] | undefined;

const realListRemoteTagsAt: ListRemoteTagsAtFn = (remote, ref) => {
  let result: SpawnSyncReturns<string>;
  try {
    result = spawnSync("git", ["ls-remote", "--symref", remote], { encoding: "utf8", timeout: LS_REMOTE_TIMEOUT_MS });
  } catch {
    return undefined;
  }
  if (result.status !== 0 || !result.stdout) return undefined;
  if (ref !== undefined && splitRefs(result.stdout).some(([, name]) => name === `refs/tags/${ref}`)) {
    const version = ref.replace(/^v/, "");
    return isExactSemver(version) ? [version] : [];
  }
  return channelVersions(result.stdout, ref ?? "", undefined);
};

/** The marketplace every akm Codex install registers (`codex plugin marketplace add itlackey/akm-plugins`). */
const CODEX_MARKETPLACE_REMOTE = "https://github.com/itlackey/akm-plugins";

/** What Codex's own config and listing say about the akm plugin; `undefined` when the marketplace is not registered. */
export interface CodexPlugin {
  /** The marketplace entry's `ref`: a branch such as `next`, a tag, or none for the default (stable) branch. */
  ref: string | undefined;
  listed: ReturnType<typeof codexPluginVersion>;
}

/** Codex is checked only when its config registers the akm-plugins marketplace, so a host without Codex runs nothing. */
function readCodexPlugin(): CodexPlugin | undefined {
  try {
    if (codexMarketplace(codexConfigFile()) === undefined) return undefined;
  } catch {
    return undefined;
  }
  return { ref: codexMarketplaceRef(), listed: codexPluginVersion() };
}

/** One `codex-plugin-version` advisory, or none when the marketplace is registered but the plugin is not installed. */
function buildCodexAdvisory(
  codex: CodexPlugin,
  probe: boolean,
  listRemoteTagsAt: ListRemoteTagsAtFn,
): HealthCheckResult | undefined {
  const base = { name: "codex-plugin-version", kind: "deterministic", confidence: "high" } as const;
  if ("error" in codex.listed) {
    return {
      ...base,
      status: "unknown",
      message: codex.listed.error.missing
        ? "Codex's config registers the akm-plugins marketplace, but `codex` is not on PATH, so its akm plugin was not checked."
        : `Codex's akm plugin could not be listed: ${codex.listed.error.error}`,
      evidence: { harness: "codex", installedVersion: null },
    };
  }
  const installed = codex.listed.version;
  if (!installed) return undefined;
  const { ref } = codex;
  const channel =
    ref === undefined || ref === "main" || ref === "master" ? "stable" : ref === "next" ? "next" : `pinned to ${ref}`;
  let availableVersion: string | undefined;
  let remoteUnavailable = false;
  if (probe) {
    const tags = listRemoteTagsAt(CODEX_MARKETPLACE_REMOTE, ref);
    if (tags === undefined) remoteUnavailable = true;
    else availableVersion = highestVersion(tags);
  }
  const stale =
    availableVersion !== undefined &&
    installed !== availableVersion &&
    highestVersion([installed, availableVersion]) === availableVersion;
  const messageParts = [`akm@akm-plugins (Codex): installed ${installed} (${channel} channel)`];
  if (!probe) messageParts.push("newest tag was not probed");
  else if (remoteUnavailable) messageParts.push(REMOTE_UNAVAILABLE_NOTE);
  if (availableVersion !== undefined) {
    messageParts.push(stale ? `available ${availableVersion} (STALE)` : `available ${availableVersion} (up to date)`);
  }
  if (stale) messageParts.push("-> codex plugin marketplace upgrade akm-plugins");
  return {
    ...base,
    status: stale ? "warn" : probe && availableVersion !== undefined ? "pass" : "unknown",
    message: messageParts.join(" — "),
    evidence: {
      harness: "codex",
      installedVersion: installed,
      ref: ref ?? null,
      availableVersion: availableVersion ?? null,
      ...(probe ? {} : { probed: false }),
      ...(remoteUnavailable ? { remoteUnavailable: true } : {}),
      stale,
    },
  };
}

/** Said when a probe asked the marketplace remote and got no answer, so "unknown" is not mistaken for "no newer release". */
const REMOTE_UNAVAILABLE_NOTE = "the newest release could not be read from the marketplace remote (offline?)";

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
  /** Injectable remote-tag lister by URL and ref, for Codex; defaults to the real `git ls-remote`. */
  listRemoteTagsAt?: ListRemoteTagsAtFn;
  /** Injectable Codex reader; defaults to Codex's config.toml and `codex plugin list`. */
  readCodex?: () => CodexPlugin | undefined;
  /** Root of OpenCode's package cache. Defaults to `defaultOpencodeCacheRoot()`. */
  opencodeCacheRoot?: string;
}

/**
 * Build one `plugin-version` advisory per detected `akm` Claude Code plugin, a `codex-plugin-version` advisory when
 * Codex has the plugin installed from the akm-plugins marketplace, plus one `opencode-plugin-version` /
 * `opencode-v2-plugin-version` advisory when an OpenCode plugin's bundled `akm-cli` is found — every plugin runs its
 * own akm against the host's databases, so its lag matters the same way. Returns `[]` when none is installed — the
 * benign, common case.
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
      evidence: { harness: "claude", installedVersion: null, enabled: null, cliMatches: null },
    });
  }

  const codex = (options.readCodex ?? readCodexPlugin)();
  if (codex) {
    const advisory = buildCodexAdvisory(codex, probe, options.listRemoteTagsAt ?? realListRemoteTagsAt);
    if (advisory) results.push(advisory);
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
  const asked = probe && plugin.selectionKnown && plugin.enabled !== false && fs.existsSync(marketplaceDir);
  let availableVersion: string | undefined;
  let remoteUnavailable = false;
  try {
    const tags = asked ? listRemoteTags(marketplaceDir) : undefined;
    remoteUnavailable = asked && tags === undefined;
    availableVersion = tags && tags.length > 0 ? highestVersion(tags) : undefined;
  } catch {
    availableVersion = undefined;
    remoteUnavailable = asked;
  }
  const stale =
    availableVersion !== undefined &&
    plugin.version !== availableVersion &&
    highestVersion([plugin.version, availableVersion]) === availableVersion;

  // Point 3: does the akm-cli the plugin runs match the running CLI? Both read and write the same databases.
  const pinnedCliVersion = readPinnedCli(plugin.pluginDir);
  const cliMatches = pinnedCliVersion === undefined ? undefined : pinnedCliVersion === cliVersion;
  const pinNewer =
    pinnedCliVersion !== undefined &&
    cliMatches === false &&
    highestVersion([pinnedCliVersion, cliVersion]) === pinnedCliVersion;

  const messageParts = [
    `${pluginRef}: installed ${plugin.version} (${plugin.scope}${plugin.projectPath ? `: ${plugin.projectPath}` : ""})`,
  ];
  if (!plugin.applicable) messageParts.push("installed for another project; not selected in this directory");
  else if (!plugin.selectionKnown) messageParts.push("effective selection unknown across native installations");
  if (plugin.enabled === false) messageParts.push("disabled in Claude settings");
  else if (plugin.enabled === undefined) messageParts.push("enabled state unknown");
  if (cliMatches === undefined) messageParts.push("bundled akm-cli unknown (no exact akm-cli pin in package.json)");
  if (!probe) messageParts.push("newest tag was not probed");
  else if (remoteUnavailable) messageParts.push(REMOTE_UNAVAILABLE_NOTE);
  if (availableVersion !== undefined) {
    messageParts.push(stale ? `available ${availableVersion} (STALE)` : `available ${availableVersion} (up to date)`);
  }
  if (stale) messageParts.push(`-> claude plugin update ${pluginRef}`);
  if (plugin.selectionKnown && plugin.enabled === true && cliMatches === false) {
    messageParts.push(
      pinNewer
        ? `bundles akm-cli ${pinnedCliVersion}, newer than the running CLI ${cliVersion}; both share the same databases -> akm upgrade`
        : `bundles akm-cli ${pinnedCliVersion}, older than the running CLI ${cliVersion}; both share the same databases${
            !stale && availableVersion === plugin.version ? " and no newer plugin is published on its channel" : ""
          }`,
    );
  }

  return {
    name: "plugin-version",
    kind: "deterministic",
    // Not probed => staleness is unknown, not "up to date"; only the local
    // pin comparison can still warn.
    status:
      plugin.enabled === false || !plugin.applicable
        ? "pass"
        : !plugin.selectionKnown || plugin.enabled === undefined
          ? "unknown"
          : stale || cliMatches === false
            ? "warn"
            : probe && availableVersion !== undefined && cliMatches !== undefined && plugin.enabled === true
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
      ...(remoteUnavailable ? { remoteUnavailable: true } : {}),
      stale,
      pinnedCliVersion: pinnedCliVersion ?? null,
      cliVersion,
      cliMatches: cliMatches ?? null,
    },
  };
}
