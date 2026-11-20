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

import { spawnSync } from "node:child_process";
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
import { highestVersion, isExactSemver } from "../../registry/semver";
import { semverOrder } from "../../runtime";
import { codexMarketplace } from "../sources/plugin-channels";
import {
  claudeMarketplace,
  codexConfigFile,
  codexMarketplaceRef,
  codexPluginVersion,
  marketplaceTargetVersion,
  openCodeConfigSpec,
  refChannel,
} from "../sources/plugin-upgrade";
import type { HealthCheckResult } from "./types";

/**
 * Root directory holding Claude Code's plugin cache + marketplace clones.
 * Resolved per call (not memoized) so Claude's own `CLAUDE_CODE_PLUGIN_CACHE_DIR`
 * can be set after import; tests point it at an empty fixture directory instead
 * of the real `~/.claude/plugins`.
 */
function claudePluginsDir(): string {
  return (
    process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR ??
    path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude"), "plugins")
  );
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
      // Cache residue is not an installation. Only a configured bare name may use the legacy bare cache.
      const { pkg } = OPENCODE_V1;
      const bare = { folder: path.join(cacheRoot, OPENCODE_V1.cacheFolder(pkg)) };
      const named = openCodeConfigSpec(OPENCODE_V1)?.spec;
      if (named === undefined) return [];
      const spec = named === pkg ? `${pkg}@latest` : named;
      const folder = path.join(cacheRoot, OPENCODE_V1.cacheFolder(spec));
      if (!fs.existsSync(folder)) return named === pkg ? [bare] : [];
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
      const { pkg } = OPENCODE_V2;
      const named = openCodeConfigSpec(OPENCODE_V2)?.spec;
      if (named === undefined) return [];
      const loaded = named === pkg ? `${pkg}@latest` : named;
      const npmDir = path.join(cacheRoot, OPENCODE_V2.cacheFolder(""));
      return [{ spec: loaded, folder: path.join(npmDir, loaded) }];
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
 * Injectable seam for the one network read this module performs: the newest akm plugin build on a channel of the
 * marketplace at a source. The real read is the one `akm upgrade` plans from; tests supply a fake.
 */
export type ReadChannelVersionFn = typeof marketplaceTargetVersion;

/** What the marketplace a plugin follows offers: the newest build, a pin that offers nothing newer, or why it could not be read. */
type Offered = { version: string } | { pinned: string } | { error: string };

function readOffered(
  harness: "claude" | "codex",
  registered: () => { source: string | undefined; ref: string | undefined },
  readChannelVersion: ReadChannelVersionFn,
): Offered {
  try {
    const { source, ref } = registered();
    if (source === undefined) return { error: "the registered marketplace has no Git source" };
    const channel = refChannel(ref);
    // A marketplace pinned to one tag never offers anything newer.
    if (channel === "pinned") return { pinned: ref as string };
    return { version: readChannelVersion(source, channel, harness) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** What Codex's own config and listing say about the akm plugin; `undefined` when the marketplace is not registered. */
export interface CodexPlugin {
  /** The marketplace entry's `ref`: a branch such as `next`, a tag, or none for the default (stable) branch. */
  ref: string | undefined;
  /** The marketplace entry's Git `source`; `undefined` when the entry names none. */
  source: string | undefined;
  listed: ReturnType<typeof codexPluginVersion>;
}

/** Codex is checked only when its config registers the akm-plugins marketplace, so a host without Codex runs nothing. */
function readCodexPlugin(): CodexPlugin | undefined {
  let source: unknown;
  try {
    const marketplace = codexMarketplace(codexConfigFile());
    if (marketplace === undefined) return undefined;
    source = marketplace.source;
  } catch {
    return undefined;
  }
  return {
    ref: codexMarketplaceRef(),
    source: typeof source === "string" ? source : undefined,
    listed: codexPluginVersion(),
  };
}

/** One `codex-plugin-version` advisory, or none when the marketplace is registered but the plugin is not installed. */
function buildCodexAdvisory(
  codex: CodexPlugin,
  cliVersion: string,
  probe: boolean,
  readChannelVersion: ReadChannelVersionFn,
): HealthCheckResult | undefined {
  const base = { name: "codex-plugin-version", kind: "deterministic", confidence: "high" } as const;
  if ("error" in codex.listed) {
    return {
      ...base,
      status: "unknown",
      reason: "blocked",
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
  const offered = probe ? readOffered("codex", () => ({ source: codex.source, ref }), readChannelVersion) : undefined;
  const availableVersion = offered && "version" in offered ? offered.version : undefined;
  const stale = availableVersion !== undefined && semverOrder(availableVersion, installed) > 0;
  // The akm-cli Codex's plugin cache holds for the installed plugin version: read, never executed.
  const bundledCli = readPackageVersion(
    path.join(
      path.dirname(codexConfigFile()),
      "plugins",
      "cache",
      "akm-plugins",
      "akm",
      installed,
      "node_modules",
      "akm-cli",
      "package.json",
    ),
  );
  const cliMatches = bundledCli === undefined ? undefined : bundledCli === cliVersion;
  const messageParts = [`akm@akm-plugins (Codex): installed ${installed} (${channel} channel)`];
  messageParts.push(...offeredNotes(offered, stale));
  if (stale) messageParts.push("-> codex plugin marketplace upgrade akm-plugins");
  if (bundledCli !== undefined && cliMatches === false) messageParts.push(bundledCliNote(bundledCli, cliVersion));
  return {
    ...base,
    ...(stale || cliMatches === false
      ? { status: "warn" }
      : offered && !("error" in offered)
        ? { status: "pass" }
        : unreadOffer(offered)),
    message: messageParts.join(" — "),
    evidence: {
      harness: "codex",
      installedVersion: installed,
      ref: ref ?? null,
      availableVersion: availableVersion ?? null,
      ...(probe ? {} : { probed: false }),
      ...(offered && "error" in offered ? { remoteUnavailable: true } : {}),
      stale,
      bundledCliVersion: bundledCli ?? null,
      cliVersion,
      cliMatches: cliMatches ?? null,
    },
  };
}

/** The `unknown` verdict of a check whose marketplace was not asked (`not-probed`) or could not be read (`blocked`). */
function unreadOffer(offered: Offered | undefined) {
  return { status: "unknown", reason: offered === undefined ? "not-probed" : "blocked" } as const;
}

/** What the read of the marketplace says in a message: that it was not made, why it failed, or what the channel offers. */
function offeredNotes(offered: Offered | undefined, stale: boolean): string[] {
  if (offered === undefined) return ["newest release was not probed"];
  if ("error" in offered) return [`the newest release could not be read from the marketplace (${offered.error})`];
  if ("pinned" in offered) return [`the marketplace is pinned to ${offered.pinned}, which offers nothing newer`];
  return [stale ? `available ${offered.version} (STALE)` : `available ${offered.version} (up to date)`];
}

/** Options for {@link collectPluginStalenessAdvisories}. */
export interface PluginStalenessOptions {
  /** Root of the Claude plugin tree (contains `cache/` and `marketplaces/`). Defaults to `claudePluginsDir()`. */
  pluginsRoot?: string;
  /** The running akm-cli version to check plugin compatibility against. */
  cliVersion: string;
  /**
   * Whether check 2 may read the marketplace for the newest release (`akm health --probe`, on by
   * default; `--no-probe` passes `false`). Defaults to `true` here so callers
   * that inject `readChannelVersion` need not repeat it; `health.ts` always passes it.
   */
  probe?: boolean;
  /** Injectable channel reader; defaults to the one `akm upgrade` plans from. */
  readChannelVersion?: ReadChannelVersionFn;
  /** Injectable Codex reader; defaults to Codex's config.toml and `codex plugin list`. */
  readCodex?: () => CodexPlugin | undefined;
  /** Root of OpenCode's package cache. Defaults to `opencodeCacheDir()` (`$XDG_CACHE_HOME/opencode`). */
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
  const readChannelVersion = options.readChannelVersion ?? marketplaceTargetVersion;
  const plugins = detectInstalledPlugins(pluginsRoot);

  const probe = options.probe ?? true;

  const results = (plugins ?? []).map((plugin) =>
    buildAdvisory(plugin, options.cliVersion, pluginsRoot, readChannelVersion, probe),
  );

  if (plugins === undefined && fs.existsSync(pluginsRoot)) {
    results.push({
      name: "plugin-version",
      kind: "deterministic",
      status: "unknown",
      reason: "blocked",
      confidence: "high",
      message:
        "Claude plugin installation and enabled state could not be resolved with `claude plugin list --json`; cached versions do not establish the selected installation.",
      evidence: { harness: "claude", installedVersion: null, enabled: null, cliMatches: null },
    });
  }

  const codex = (options.readCodex ?? readCodexPlugin)();
  if (codex) {
    const advisory = buildCodexAdvisory(codex, options.cliVersion, probe, readChannelVersion);
    if (advisory) results.push(advisory);
  }

  const opencodeCacheRoot = options.opencodeCacheRoot ?? opencodeCacheDir();
  for (const plugin of OPENCODE_PLUGIN_LOCATIONS) {
    for (const bundled of findBundledAkm(plugin, opencodeCacheRoot)) {
      results.push(buildOpencodeBundledAdvisory(plugin, bundled, options.cliVersion));
    }
  }

  return results;
}

/** Which side of a plugin's bundled akm-cli and the running CLI is behind, with the remedy when the plugin is ahead. */
function bundledCliNote(bundled: string, cliVersion: string, olderSuffix = ""): string {
  return highestVersion([bundled, cliVersion]) === bundled
    ? `bundles akm-cli ${bundled}, newer than the running CLI ${cliVersion}; both share the same databases -> akm upgrade`
    : `bundles akm-cli ${bundled}, older than the running CLI ${cliVersion}; both share the same databases${olderSuffix}`;
}

function buildAdvisory(
  plugin: DetectedPlugin,
  cliVersion: string,
  pluginsRoot: string,
  readChannelVersion: ReadChannelVersionFn,
  probe: boolean,
): HealthCheckResult {
  const pluginRef = `${plugin.pluginName}@${plugin.marketplace}`;

  // Point 2: newest available vs. installed, from the channel of the marketplace Claude registered.
  const asked = probe && plugin.selectionKnown && plugin.enabled !== false;
  const offered = asked
    ? readOffered("claude", () => claudeMarketplace(pluginsRoot, plugin.marketplace), readChannelVersion)
    : undefined;
  const availableVersion = offered && "version" in offered ? offered.version : undefined;
  const stale = availableVersion !== undefined && semverOrder(availableVersion, plugin.version) > 0;

  // Point 3: does the akm-cli the plugin runs match the running CLI? Both read and write the same databases.
  const pinnedCliVersion = readPinnedCli(plugin.pluginDir);
  const cliMatches = pinnedCliVersion === undefined ? undefined : pinnedCliVersion === cliVersion;

  const messageParts = [
    `${pluginRef}: installed ${plugin.version} (${plugin.scope}${plugin.projectPath ? `: ${plugin.projectPath}` : ""})`,
  ];
  if (!plugin.applicable) messageParts.push("installed for another project; not selected in this directory");
  else if (!plugin.selectionKnown) messageParts.push("effective selection unknown across native installations");
  if (plugin.enabled === false) messageParts.push("disabled in Claude settings");
  else if (plugin.enabled === undefined) messageParts.push("enabled state unknown");
  if (cliMatches === undefined) messageParts.push("bundled akm-cli unknown (no exact akm-cli pin in package.json)");
  if (!probe) messageParts.push("newest release was not probed");
  else if (offered) messageParts.push(...offeredNotes(offered, stale));
  if (stale) messageParts.push(`-> claude plugin update ${pluginRef}`);
  if (plugin.selectionKnown && plugin.enabled === true && cliMatches === false) {
    messageParts.push(
      bundledCliNote(
        pinnedCliVersion as string,
        cliVersion,
        !stale && availableVersion === plugin.version ? " and no newer plugin is published on its channel" : "",
      ),
    );
  }

  return {
    name: "plugin-version",
    kind: "deterministic",
    // Not probed => staleness is unknown, not "up to date"; only the local
    // pin comparison can still warn.
    ...(plugin.enabled === false || !plugin.applicable
      ? { status: "pass" }
      : !plugin.selectionKnown || plugin.enabled === undefined
        ? ({ status: "unknown", reason: "blocked" } as const)
        : stale || cliMatches === false
          ? { status: "warn" }
          : offered && !("error" in offered) && cliMatches !== undefined && plugin.enabled === true
            ? { status: "pass" }
            : cliMatches === undefined && offered !== undefined && !("error" in offered)
              ? ({ status: "unknown", reason: "blocked" } as const)
              : unreadOffer(offered)),
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
      ...(offered && "error" in offered ? { remoteUnavailable: true } : {}),
      stale,
      pinnedCliVersion: pinnedCliVersion ?? null,
      cliVersion,
      cliMatches: cliMatches ?? null,
    },
  };
}
