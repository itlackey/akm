// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The plugin half of `akm upgrade` (#1007): refresh the akm plugin of each
 * installed agent harness. Update only: a plugin that is not installed is never
 * installed, and a harness without one is skipped. Every external command
 * runs with a timeout and its failure is captured on that harness's entry,
 * so a broken harness never aborts the CLI upgrade.
 */

import * as childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { IS_WINDOWS, parseJsonc } from "../../core/common";
import { UsageError } from "../../core/errors";
import { moveToTrash } from "../../core/trash";
import {
  OPENCODE_V1,
  OPENCODE_V2,
  type OpenCodeFlavor,
  readPackageVersion,
} from "../../integrations/harnesses/opencode/plugin-layout";
import { opencodeCacheDir, opencodeConfigDir } from "../../integrations/harnesses/opencode/roots";
import { detectOpencodeMajor, OPENCODE_BIN, resolveOpencodeBin } from "../../integrations/harnesses/opencode/version";
import { isExactSemver } from "../../registry/semver";
import { semverOrder } from "../../runtime";
import type { PluginUpgradeEntry, UpgradeChannel, UpgradeCheckResponse, UpgradeResponse } from "../../sources/types";
import { collectPluginStalenessAdvisories } from "../health/plugin-staleness";
import {
  ChannelWriteError,
  claudeChannelEdits,
  codexChannelEdit,
  codexMarketplace,
  editChannelJson,
  writeChannelEdits,
} from "./plugin-channels";
import { installedChannel } from "./self-update";

const MARKETPLACE = "akm-plugins";
const PLUGIN_ID = `akm@${MARKETPLACE}`;
const READ_TIMEOUT_MS = 30_000;
const REFRESH_TIMEOUT_MS = 120_000;
const PREFETCH_TIMEOUT_MS = 180_000;

// ── Running external commands ───────────────────────────────────────────────

export type CommandFailure = { ok: false; missing: boolean; error: string };
type CommandResult = { ok: true; stdout: string } | CommandFailure;

function runCommand(command: string, args: string[], timeoutMs: number, opts?: { cwd?: string }): CommandResult {
  const result = childProcess.spawnSync(command, args, {
    encoding: "utf8",
    env: process.env,
    stdio: "pipe",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    cwd: opts?.cwd,
  });
  const label = `${command} ${args.join(" ")}`;
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === "ETIMEDOUT")
      return { ok: false, missing: false, error: `\`${label}\` timed out after ${timeoutMs / 1000}s` };
    return { ok: false, missing: code === "ENOENT", error: `\`${label}\` could not run: ${result.error.message}` };
  }
  if (result.status !== 0) {
    const detail = (result.stderr ?? "").trim() || (result.stdout ?? "").trim() || `exit code ${result.status}`;
    return { ok: false, missing: false, error: `\`${label}\` failed: ${detail}` };
  }
  return { ok: true, stdout: result.stdout ?? "" };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function skipped(harness: PluginUpgradeEntry["harness"], message: string): PluginUpgradeEntry {
  return { harness, outcome: "skipped", message };
}

function failed(harness: PluginUpgradeEntry["harness"], message: string): PluginUpgradeEntry {
  return { harness, outcome: "failed", message };
}

function channelWriteFailure(
  harness: PluginUpgradeEntry["harness"],
  error: unknown,
  before: NonNullable<PluginUpgradeEntry["channel"]>,
): PluginUpgradeEntry {
  return {
    ...failed(harness, String(error)),
    channel: error instanceof ChannelWriteError && error.writtenFiles.length ? "unknown" : before,
    ...(error instanceof ChannelWriteError ? { backups: error.backups } : {}),
  };
}

/** An entry for a refresh that ran: `updated` when the installed version moved, else `current`. */
function refreshed(harness: PluginUpgradeEntry["harness"], from: string | undefined, to: string | undefined) {
  const moved = from !== undefined && to !== undefined && from !== to;
  return { harness, outcome: moved ? "updated" : "current", from, to } as PluginUpgradeEntry;
}

/**
 * What `--check` says an update would do to a marketplace plugin, from the same read as the real switch
 * ({@link marketplacePlan}): the build the channel's branch of the registered marketplace offers. A switch to a channel
 * with nothing newer returns `keep`, the plugin the real switch leaves alone. A marketplace that cannot be read leaves
 * the entry `unknown`, with the reason.
 */
function planEntry(
  harness: "claude-code" | "codex",
  installed: (string | undefined)[],
  source: () => string,
  ref: string | undefined,
  channel: UpgradeChannel | undefined,
  allowDowngrade: boolean,
  planned?: MarketplacePlan,
): { entry: PluginUpgradeEntry; keep?: Kept } {
  const from = installed[0];
  const followed = channel ?? refChannel(ref);
  // A marketplace pinned to one tag never offers anything newer.
  if (followed === "pinned") return { entry: refreshed(harness, from, from) };
  const unknown = (reason: string) => ({
    entry: {
      harness,
      outcome: "unknown" as const,
      from,
      message: `the ${followed} build could not be read (${reason}); \`akm upgrade\` refreshes it`,
    },
  });
  let plan: MarketplacePlan;
  try {
    plan = planned ?? marketplacePlan(harness, source(), installed, followed, allowDowngrade);
  } catch (error) {
    return unknown(error instanceof Error ? error.message : String(error));
  }
  if (plan.target instanceof Error && !(channel && plan.keep)) return unknown(plan.target.message);
  if (plan.keep) return { entry: refreshed(harness, from, from), keep: plan.keep };
  const to = plan.target as string;
  return { entry: to === from ? refreshed(harness, from, from) : { harness, outcome: "pending", from, to } };
}

// ── Claude Code ─────────────────────────────────────────────────────────────

interface ClaudeInstallation {
  version?: string;
  scope?: string;
  projectPath?: string;
}
type Detected =
  | { entry: PluginUpgradeEntry }
  | { version: string | undefined; ref: string | undefined; installations: ClaudeInstallation[] };

function claudePlugins(): { installations: ClaudeInstallation[] } | { error: CommandFailure } {
  const listed = runCommand("claude", ["plugin", "list", "--json"], READ_TIMEOUT_MS);
  if (!listed.ok) return { error: listed };
  const plugins = parseJson(listed.stdout);
  const installations = Array.isArray(plugins)
    ? plugins
        .filter((p) => p?.id === PLUGIN_ID)
        .map((p) => ({
          version: typeof p.version === "string" ? p.version : undefined,
          scope: typeof p.scope === "string" ? p.scope : undefined,
          projectPath: typeof p.projectPath === "string" ? p.projectPath : undefined,
        }))
    : [];
  return { installations };
}

function detectClaudeCode(): Detected {
  const marketplaces = runCommand("claude", ["plugin", "marketplace", "list", "--json"], READ_TIMEOUT_MS);
  if (!marketplaces.ok) {
    const configDir = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
    const pluginsRoot =
      process.env.AKM_CLAUDE_PLUGINS_DIR ?? process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR ?? path.join(configDir, "plugins");
    const configured = fs.existsSync(path.join(pluginsRoot, "known_marketplaces.json"));
    return {
      entry:
        !marketplaces.missing || configured
          ? { ...failed("claude-code", marketplaces.error), channel: "unknown" }
          : skipped("claude-code", "claude is not on PATH"),
    };
  }
  const list = parseJson(marketplaces.stdout);
  const marketplace = Array.isArray(list) ? list.find((m) => m?.name === MARKETPLACE) : undefined;
  if (!marketplace) return { entry: skipped("claude-code", `the ${MARKETPLACE} marketplace is not configured`) };
  const plugin = claudePlugins();
  if ("error" in plugin) return { entry: { ...failed("claude-code", plugin.error.error), channel: "unknown" } };
  if (!plugin.installations.length) return { entry: skipped("claude-code", "the akm plugin is not installed") };
  return {
    version: plugin.installations[0]?.version,
    installations: plugin.installations,
    ref: typeof marketplace.ref === "string" ? marketplace.ref : undefined,
  };
}

/** A marketplace plugin a channel switch leaves untouched, and why when it is not "nothing newer". */
interface Kept {
  installed: string;
  reason?: string;
}

/** A component a channel switch leaves untouched because the channel has nothing newer than what is installed. */
function stays(
  harness: PluginUpgradeEntry["harness"],
  installed: string,
  channel: UpgradeChannel,
  before: NonNullable<PluginUpgradeEntry["channel"]>,
  reason?: string,
): PluginUpgradeEntry {
  return {
    harness,
    outcome: "current",
    from: installed,
    to: installed,
    channel: before,
    targetChannel: channel,
    message: `${harness} stays at ${installed}; ${reason ?? `${channel} has nothing newer`}`,
  };
}

function upgradeClaudeCode(
  dryRun: boolean,
  next: boolean,
  channel?: UpgradeChannel,
  plan?: MarketplacePlan,
  allowDowngrade = false,
): PluginUpgradeEntry {
  const detected = detectClaudeCode();
  if ("entry" in detected) return detected.entry;
  const before = refChannel(detected.ref);
  const planned = dryRun
    ? planEntry(
        "claude-code",
        detected.installations.map((p) => p.version),
        () => claudeMarketplace(claudePluginsRoot()).source,
        detected.ref,
        channel,
        allowDowngrade,
        plan,
      )
    : undefined;
  const keep = plan?.keep ?? planned?.keep;
  if (channel && keep !== undefined) return stays("claude-code", keep.installed, channel, before, keep.reason);
  let backups: string[] = [];
  if (channel && !dryRun) {
    try {
      const configDir = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
      const pluginsRoot =
        process.env.AKM_CLAUDE_PLUGINS_DIR ??
        process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR ??
        path.join(configDir, "plugins");
      backups = writeChannelEdits(
        claudeChannelEdits(
          configDir,
          pluginsRoot,
          channel,
          detected.installations.flatMap((p) => (p.projectPath ? [p.projectPath] : [])),
        ),
      );
    } catch (error) {
      return channelWriteFailure("claude-code", error, before);
    }
  }
  const entry = planned?.entry ?? refreshClaudeCode(detected.version, channel ? detected.installations : undefined);
  const noted = next && !channel ? withChannelNote(entry, detected.ref) : entry;
  return channelResult(noted, before, channel, dryRun, backups);
}

function refreshClaudeCode(from: string | undefined, installations?: ClaudeInstallation[]): PluginUpgradeEntry {
  const marketplace = runCommand("claude", ["plugin", "marketplace", "update", MARKETPLACE], REFRESH_TIMEOUT_MS);
  if (!marketplace.ok) return failed("claude-code", marketplace.error);
  for (const installation of installations ?? [{}]) {
    const update = runCommand(
      "claude",
      ["plugin", "update", PLUGIN_ID, ...(installation.scope ? ["--scope", installation.scope] : [])],
      REFRESH_TIMEOUT_MS,
      { cwd: installation.projectPath },
    );
    if (!update.ok) return failed("claude-code", update.error);
  }
  const after = claudePlugins();
  return refreshed("claude-code", from, "installations" in after ? after.installations[0]?.version : undefined);
}

// ── Codex ───────────────────────────────────────────────────────────────────

export function codexPluginVersion(): { version: string | undefined } | { error: CommandFailure } {
  const listed = runCommand("codex", ["plugin", "list", "--marketplace", MARKETPLACE, "--json"], READ_TIMEOUT_MS);
  if (!listed.ok) return { error: listed };
  const parsed = parseJson(listed.stdout) as { installed?: Array<{ pluginId?: string; version?: string }> } | undefined;
  const plugin = parsed?.installed?.find((p) => p?.pluginId === PLUGIN_ID);
  return { version: plugin ? String(plugin.version ?? "") : undefined };
}

export function codexConfigFile(): string {
  return path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "config.toml");
}

/** The akm-plugins entry of Codex's config; `{ error }` when the file exists and cannot be read or parsed. */
export function codexMarketplaceEntry(): { entry: Record<string, unknown> | undefined } | { error: string } {
  const file = codexConfigFile();
  try {
    return { entry: codexMarketplace(file) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { entry: undefined };
    return { error: `could not read ${file}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function upgradeCodex(
  dryRun: boolean,
  next: boolean,
  channel?: UpgradeChannel,
  plan?: MarketplacePlan,
  allowDowngrade = false,
): PluginUpgradeEntry {
  const before = codexPluginVersion();
  if ("error" in before)
    return !before.error.missing || fs.existsSync(codexConfigFile())
      ? { ...failed("codex", before.error.error), channel: "unknown" }
      : skipped("codex", "codex is not on PATH");
  if (before.version === undefined) {
    return skipped("codex", `the akm plugin is not installed from the ${MARKETPLACE} marketplace`);
  }
  const registered = codexMarketplaceEntry();
  if ("error" in registered) return { ...failed("codex", registered.error), channel: "unknown" };
  const ref = typeof registered.entry?.ref === "string" ? registered.entry.ref : undefined;
  const previous = refChannel(ref);
  const planned = dryRun
    ? planEntry(
        "codex",
        [before.version],
        () => codexMarketplaceRegistration().source,
        ref,
        channel,
        allowDowngrade,
        plan,
      )
    : undefined;
  const keep = plan?.keep ?? planned?.keep;
  if (channel && keep !== undefined) return stays("codex", keep.installed, channel, previous, keep.reason);
  const backups: string[] = [];
  if (channel && previous !== channel && !dryRun) {
    try {
      backups.push(...writeChannelEdits([codexChannelEdit(codexConfigFile(), channel)]));
    } catch (error) {
      return channelWriteFailure("codex", error, previous);
    }
  }
  const entry = planned?.entry ?? refreshCodex(before.version);
  return channelResult(next && !channel ? withChannelNote(entry, ref) : entry, previous, channel, dryRun, backups);
}

function refreshCodex(from: string | undefined): PluginUpgradeEntry {
  // Also refreshes the installed plugin's cache, so no re-add is needed.
  const upgrade = runCommand("codex", ["plugin", "marketplace", "upgrade", MARKETPLACE], REFRESH_TIMEOUT_MS);
  if (!upgrade.ok) return failed("codex", upgrade.error);
  const after = codexPluginVersion();
  return refreshed("codex", from, "version" in after ? after.version : undefined);
}

// ── OpenCode ────────────────────────────────────────────────────────────────

const nextSpec = (flavor: OpenCodeFlavor) => `${flavor.pkg}@next`;

export interface OpenCodeCache {
  dir: string;
  version: string | undefined;
}

export type OpenCodeLatest = { version: string } | { error: string };

/** The spec in a config's plugin entry (a spec string or a `[spec, options]` pair). */
function entrySpec(entry: unknown): string | undefined {
  const spec = Array.isArray(entry) ? entry[0] : entry;
  return typeof spec === "string" ? spec : undefined;
}

const namesPackage = (spec: string, pkg: string) => spec === pkg || spec.startsWith(`${pkg}@`);

export interface OpenCodeConfigSpec {
  spec: string;
  key: string;
  file: string;
  jsonPath: (string | number)[];
}

/**
 * The plugin spec the user's global OpenCode config names for this flavor's
 * package (bare, `@latest`, `@next`, an exact version, ...), with the config key
 * it sits under, or undefined when none does. A config file that exists and cannot
 * be read or parsed is `{ error }`, not an absent spec. OpenCode caches each spec in its
 * own folder, so this says which cache it loads. The config is only read, never
 * written; project configs are not looked at (akm does not know which project
 * OpenCode runs in).
 */
export function openCodeConfigSpec(flavor: OpenCodeFlavor): OpenCodeConfigSpec | { error: string } | undefined {
  const configDir = opencodeConfigDir();
  const explicit = flavor.globalConfigOnly ? undefined : process.env.OPENCODE_CONFIG?.trim();
  const files = [
    explicit,
    // OpenCode loads opencode.jsonc after opencode.json, so its plugin list wins.
    path.join(configDir, "opencode.jsonc"),
    path.join(configDir, "opencode.json"),
  ];
  for (const file of files) {
    if (!file) continue;
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") continue;
      return { error: `could not read ${file}: ${error instanceof Error ? error.message : String(error)}` };
    }
    let config: Record<string, unknown>;
    try {
      const parsed = parseJsonc(text);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not a JSON object");
      config = parsed as Record<string, unknown>;
    } catch (error) {
      return { error: `could not parse ${file}: ${error instanceof Error ? error.message : String(error)}` };
    }
    let setsList = false;
    for (const key of flavor.configKeys) {
      const entries = config[key];
      if (!Array.isArray(entries)) continue;
      setsList = true;
      for (const [index, entry] of entries.entries()) {
        const spec = entrySpec(entry);
        if (spec !== undefined && namesPackage(spec, flavor.pkg))
          return { spec, key, file, jsonPath: [key, index, ...(Array.isArray(entry) ? [0] : [])] };
      }
    }
    // OpenCode 1: a global file's plugin list replaces the earlier one, so a list that omits the package means it
    // is not loaded. OpenCode 2's handling of `plugin`/`plugins` across files is not measured, so it keeps looking.
    if (setsList && file !== explicit && flavor.major === 1) return undefined;
  }
  return undefined;
}

/** Whether OpenCode 2 has ever cached `akm-opencode-v2` on this host. */
function openCodeV2Cached(): boolean {
  try {
    return fs
      .readdirSync(path.join(opencodeCacheDir(), OPENCODE_V2.cacheFolder("")))
      .some((name) => name.startsWith(`${OPENCODE_V2.pkg}@`));
  } catch {
    return false;
  }
}

/**
 * The cached plugin OpenCode installed on first use, or undefined when there is
 * none. OpenCode names the folder after the spec it resolved, so a bare package
 * lands in `@latest` and `<pkg>@next` in `@next`.
 */
export function detectOpenCodeCache(tag: UpgradeChannel, flavor: OpenCodeFlavor): OpenCodeCache | undefined {
  const dir = path.join(opencodeCacheDir(), flavor.cacheFolder(`${flavor.pkg}@${tag}`));
  if (!fs.existsSync(dir)) return undefined;
  const nodeModules = flavor.nodeModulesDir(dir);
  return { dir, version: nodeModules && readPackageVersion(path.join(nodeModules, flavor.pkg, "package.json")) };
}

/** What npm's `<pkg>@<tag>` is. */
export function lookupOpenCodeLatest(tag: UpgradeChannel, flavor: OpenCodeFlavor): OpenCodeLatest {
  const spec = `${flavor.pkg}@${tag}`;
  const view = runCommand(IS_WINDOWS ? "npm.cmd" : "npm", ["view", spec, "version", "--json"], READ_TIMEOUT_MS);
  if (!view.ok) return { error: view.error };
  const parsed = parseJson(view.stdout) as { version?: unknown } | string | undefined;
  const version = typeof parsed === "string" ? parsed : parsed?.version;
  if (typeof version !== "string") return { error: `npm did not report a version for ${spec}` };
  return { version };
}

const CONTAINER_CGROUP = /docker|containerd|podman|libpod|lxc/;

/**
 * Whether the process could use this host's OpenCode cache. A process in another mount namespace (a container's
 * `opencode serve`) has its own cache; when that cannot be read, a container cgroup says the same. Anything
 * unreadable counts as a host process, so the answer errs towards deferring.
 */
export function usesHostCache(pid: string, procRoot = "/proc"): boolean {
  try {
    return fs.readlinkSync(`${procRoot}/${pid}/ns/mnt`) === fs.readlinkSync(`${procRoot}/self/ns/mnt`);
  } catch {
    // not readable (another user's process, or no such namespace file): look at the cgroup instead
  }
  try {
    return !CONTAINER_CGROUP.test(fs.readFileSync(`${procRoot}/${pid}/cgroup`, "utf8"));
  } catch {
    return true;
  }
}

/** Whether an OpenCode process is running (its prefetch would be replaced under it). `undefined` when that cannot be told. */
function openCodeRunning(): boolean | undefined {
  if (IS_WINDOWS) {
    const tasks = runCommand("tasklist", ["/FI", "IMAGENAME eq opencode.exe", "/NH"], READ_TIMEOUT_MS);
    return tasks.ok ? /opencode\.exe/i.test(tasks.stdout) : undefined;
  }
  const linux = process.platform === "linux";
  // `-f` because a Node-wrapped opencode shows up as `node …/opencode`; the
  // pattern needs `opencode` to be a whole path segment so `akm-opencode`
  // in some other command's arguments does not match.
  const pgrep = runCommand("pgrep", ["-f", "(^|/)opencode( |$)"], READ_TIMEOUT_MS);
  if (pgrep.ok) {
    return !linux || pgrep.stdout.split(/\s+/).some((pid) => /^\d+$/.test(pid) && usesHostCache(pid));
  }
  if (!pgrep.missing) return false; // pgrep exits 1 when nothing matched
  if (!linux) return undefined;
  try {
    return fs.readdirSync("/proc").some((pid) => {
      if (!/^\d+$/.test(pid) || Number(pid) === process.pid) return false;
      try {
        const argv = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
        return argv.slice(0, 2).some((arg) => path.basename(arg) === "opencode") && usesHostCache(pid);
      } catch {
        return false;
      }
    });
  } catch {
    return undefined;
  }
}

const notFollowingNext = (flavor: OpenCodeFlavor) =>
  `next channel: OpenCode resolves a bare "${flavor.pkg}" to @latest, so it is not updated to a prerelease; ` +
  `set "${flavor.configKeys[0]}": ["${nextSpec(flavor)}"] in your OpenCode config to follow prereleases`;

/** Why a run leaves alone an OpenCode whose config names a spec no run refreshes: an exact version or another tag (#1117). */
function otherSpecNote(flavor: OpenCodeFlavor, spec: string): string {
  return `OpenCode loads "${spec}" (your OpenCode config), so this upgrade leaves it alone; set "${flavor.configKeys[0]}": ["${flavor.pkg}"] to have \`akm upgrade\` keep it current`;
}

function upgradeOpenCode(dryRun: boolean, target: OpenCodeTarget): PluginUpgradeEntry {
  const { flavor, cache, latest, tag, skip } = target;
  const harness = flavor.harness;
  if (target.unreadable) return failed(harness, target.unreadable);
  // Refreshing a cache OpenCode does not load would trash one it never re-creates (#1115, #1117).
  if (skip) return skipped(harness, skip);
  if (!cache || !latest) return skipped(harness, `no cached ${flavor.pkg}@${tag} plugin`);
  if ("error" in latest) return failed(harness, latest.error);
  if (target.notFollowingNext) return skipped(harness, notFollowingNext(flavor));
  if (!target.switchChannel && cache.version === latest.version)
    return { harness, outcome: "current", from: cache.version, to: latest.version };
  const base = { harness, from: cache.version, to: latest.version };
  if (target.keepInstalled)
    return {
      harness,
      outcome: "current",
      from: cache.version,
      to: cache.version,
      message: `${flavor.pkg} stays at ${cache.version}; ${tag} has nothing newer`,
    };
  // OpenCode 1's refresh replaces the cache the running OpenCode is using, so it waits for the exit.
  // OpenCode 2's `plugin update` installs beside the old build, which a running service keeps using until it restarts.
  if (flavor.replacesCache) {
    const running = openCodeRunning();
    if (running !== false) {
      return {
        ...base,
        outcome: "deferred",
        message:
          running === true
            ? "OpenCode is running; the plugin cache is replaced by a later `akm upgrade` once it has exited"
            : "could not tell whether OpenCode is running; the plugin cache is replaced by a later `akm upgrade`",
      };
    }
  }
  if (dryRun) return { ...base, outcome: "pending" };
  // OpenCode must be runnable before anything changes: only the major that owns this plugin's cache can
  // refresh it. akm never installs or replaces the binary.
  // OpenCode 2 may sit beside an OpenCode 1 `opencode` as `opencode2`; OpenCode 1 is only ever `opencode`.
  const bin = flavor.major === 2 ? resolveOpencodeBin() : OPENCODE_BIN;
  const detected = detectOpencodeMajor(bin);
  if (!detected.runnable) return skipped(harness, `${bin} is not on PATH or \`${bin} --version\` failed`);
  const major = detected.reportedMajor;
  // OpenCode 1 keeps its long-standing behavior when the version cannot be read; OpenCode 2's
  // refresh needs a command only OpenCode 2 has, so it must be sure.
  if (major === undefined ? flavor.major === 2 : major !== flavor.major) {
    return skipped(
      harness,
      `\`${bin}\` on PATH is ${major === undefined ? "of an unknown version" : `OpenCode ${major}`}, ` +
        `not OpenCode ${flavor.major}, so it cannot refresh the ${flavor.pkg} cache; the cache is left alone`,
    );
  }
  let backups: string[] = [];
  if (target.switchChannel) {
    const configured = openCodeConfigSpec(flavor);
    if (configured && "error" in configured) return failed(harness, configured.error);
    if (!configured) return failed(harness, "the configured plugin entry disappeared before switching its channel");
    try {
      backups = writeChannelEdits([editChannelJson(configured.file, configured.jsonPath, target.spec)]);
    } catch (error) {
      return channelWriteFailure(harness, error, target.currentChannel ?? "unknown");
    }
  }
  if (flavor.replacesCache && fs.existsSync(cache.dir)) {
    try {
      moveToTrash(cache.dir);
    } catch (error) {
      return {
        ...failed(
          harness,
          `could not move ${cache.dir} to the trash: ${error instanceof Error ? error.message : String(error)}`,
        ),
        backups,
      };
    }
  }
  const trashed = flavor.replacesCache ? " (the old cache is in the trash)" : "";
  // From a temp dir, so no project's opencode.json is read.
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-opencode-prefetch-"));
  try {
    let refresh = runCommand(bin, flavor.refresh(target.spec), PREFETCH_TIMEOUT_MS, { cwd: workDir });
    // OpenCode 2 starts its background service for this command and answers "Plugin is not configured" until
    // that service has loaded the plugins, so the first command after the service was down fails. Ask again.
    for (
      let retry = 0;
      !refresh.ok && flavor.major === 2 && retry < 2 && /not configured/.test(refresh.error);
      retry++
    ) {
      refresh = runCommand(bin, flavor.refresh(target.spec), PREFETCH_TIMEOUT_MS, { cwd: workDir });
    }
    if (!refresh.ok) return { ...failed(harness, `${refresh.error}${trashed}`), backups };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
  const after = detectOpenCodeCache(tag, flavor);
  if (!after) return { ...failed(harness, `opencode did not re-create the plugin cache${trashed}`), backups };
  return { ...base, outcome: "updated", to: after.version ?? latest.version, ...(backups.length ? { backups } : {}) };
}

// ── Orchestration ───────────────────────────────────────────────────────────

/**
 * The note `--next` adds to a marketplace harness. The channel is the ref the marketplace follows (`next` is the
 * prerelease branch, the default branch is stable); only an explicit --channel switches it.
 */
export function refChannel(ref: string | undefined): UpgradeChannel | "pinned" {
  return !ref || ref === "main" || ref === "master" ? "latest" : ref === "next" ? "next" : "pinned";
}

function channelResult(
  entry: PluginUpgradeEntry,
  before: NonNullable<PluginUpgradeEntry["channel"]>,
  target: UpgradeChannel | undefined,
  dryRun: boolean,
  backups: string[] = [],
): PluginUpgradeEntry {
  const changed = target !== undefined && target !== before;
  return {
    ...entry,
    channel: changed && !dryRun ? target : before,
    ...(target ? { targetChannel: target } : {}),
    ...(changed
      ? {
          previousChannel: before,
          message: `${entry.message ? `${entry.message}; ` : ""}${dryRun ? "would configure" : "configured"} channel ${before} → ${target}`,
        }
      : {}),
    ...(backups.length ? { backups } : {}),
  };
}

function withChannelNote(entry: PluginUpgradeEntry, ref: string | undefined): PluginUpgradeEntry {
  if (entry.outcome === "skipped") return entry;
  const note =
    ref === "next"
      ? `next channel: the ${MARKETPLACE} marketplace follows ref next, the prerelease channel`
      : `next channel: the ${MARKETPLACE} marketplace follows ${ref ? `ref ${ref}` : "the default branch (stable)"}; use akm upgrade --channel next to switch all installed plugins`;
  return { ...entry, message: entry.message ? `${entry.message}; ${note}` : note };
}

/** What `--next` means for one OpenCode plugin: which npm tag it follows, and whether the user's config follows it too. */
export interface OpenCodeTarget {
  flavor: OpenCodeFlavor;
  cache: OpenCodeCache | undefined;
  latest: OpenCodeLatest | undefined;
  /** The npm tag `latest` was read from, and the cache folder's tag. */
  tag: UpgradeChannel;
  /** The spec OpenCode resolves, as its config writes it; what the re-fetch names. */
  spec: string;
  /** `--next` was asked for but the OpenCode config names the bare package, so it keeps resolving `@latest`. */
  notFollowingNext: boolean;
  /** Why this run leaves the plugin alone (the config names a spec it does not refresh, or does not name it), when it does. */
  skip?: string;
  /** The OpenCode config exists and could not be read, so no spec, cache or channel is known. */
  unreadable?: string;
  currentChannel?: NonNullable<PluginUpgradeEntry["channel"]>;
  switchChannel?: UpgradeChannel;
  /** A channel switch whose newest plugin build is older than the installed one: the installed build stays. */
  keepInstalled?: boolean;
}

export function upgradePlugins(opts: {
  dryRun: boolean;
  next: boolean;
  openCode: OpenCodeTarget[];
  channel?: UpgradeChannel;
  currentChannel?: UpgradeChannel;
  /** Marketplace harnesses a channel switch leaves alone, with the installed version each stays at. */
  plans?: { claude?: MarketplacePlan; codex?: MarketplacePlan };
  allowDowngrade?: boolean;
}): PluginUpgradeEntry[] {
  return [
    upgradeClaudeCode(opts.dryRun, opts.next, opts.channel, opts.plans?.claude, opts.allowDowngrade),
    upgradeCodex(opts.dryRun, opts.next, opts.channel, opts.plans?.codex, opts.allowDowngrade),
    ...opts.openCode.map((target) => {
      const entry = upgradeOpenCode(opts.dryRun, target);
      if (target.keepInstalled)
        return { ...entry, channel: target.currentChannel ?? "unknown", targetChannel: target.switchChannel };
      if (target.currentChannel === undefined) return entry;
      const changed =
        entry.channel === undefined &&
        target.switchChannel &&
        ((entry.backups?.length ?? 0) > 0 || entry.outcome === "updated" || entry.outcome === "current");
      return channelResult(
        entry,
        entry.channel ?? target.currentChannel ?? "unknown",
        opts.dryRun || changed ? target.switchChannel : undefined,
        opts.dryRun,
        entry.backups,
      );
    }),
  ].map((entry) => ({
    ...entry,
    ...(entry.channel && entry.channel !== "unknown" && opts.currentChannel
      ? { channelMismatch: entry.channel !== opts.currentChannel }
      : {}),
  }));
}

const SKEW_ADVISORY_HARNESS: Record<string, PluginUpgradeEntry["harness"]> = {
  "plugin-version": "claude-code",
  "codex-plugin-version": "codex",
  "opencode-plugin-version": "opencode",
  "opencode-v2-plugin-version": "opencode-v2",
};

/** Adds the `akm health` verdict to a plugin whose bundled akm-cli differs from the CLI, so the upgrade names the skew it leaves. */
function withEngineSkew(entries: PluginUpgradeEntry[], cliVersion: string): PluginUpgradeEntry[] {
  const skew = new Map<string, string>();
  // Codex is read only when its config registers the akm-plugins marketplace: one `codex plugin list` spawn.
  for (const advisory of collectPluginStalenessAdvisories({ cliVersion, probe: false })) {
    const harness = SKEW_ADVISORY_HARNESS[advisory.name];
    if (advisory.status === "warn" && harness && !skew.has(harness)) skew.set(harness, advisory.message);
  }
  return entries.map((entry) => {
    const note = skew.get(entry.harness);
    return note ? { ...entry, message: `${entry.message ? `${entry.message}; ` : ""}engine skew: ${note}` } : entry;
  });
}

export interface UpgradeRunDependencies {
  checkForUpdate: (
    currentVersion: string,
    channel: UpgradeChannel,
    exactChannel?: boolean,
  ) => Promise<UpgradeCheckResponse>;
  performUpgrade: (
    check: UpgradeCheckResponse,
    opts: { force: boolean; skipPostUpgrade: boolean; skipChecksum?: boolean; targetVersion?: string },
  ) => Promise<UpgradeResponse>;
}

export type UpgradeRunResult =
  | { mode: "check"; result: UpgradeCheckResponse & { plugins: PluginUpgradeEntry[] } }
  | { mode: "upgrade"; result: UpgradeResponse & { plugins: PluginUpgradeEntry[] }; failed: boolean };

/**
 * Which build of one OpenCode plugin refreshes, and which cache: the one the user's OpenCode config names, since
 * that is the only cache OpenCode re-creates. A bare name or `@latest` refreshes `@latest`, and `<pkg>@next`
 * refreshes `@next`, on a plain run too, as the marketplace plugins follow the channel their own registration names.
 * Under `--next` a bare one keeps resolving `@latest` and is reported as skipped. A config naming any other spec
 * (an exact version) is left alone.
 */
function resolveOpenCodeTarget(
  next: boolean,
  flavor: OpenCodeFlavor,
  configured: { spec: string; key: string } | undefined,
  channel?: UpgradeChannel,
): OpenCodeTarget {
  // OpenCode 1 with no config entry behaves like a bare one: it would resolve @latest. OpenCode 2's
  // re-fetch writes the config, so its plugin is only refreshed where the config already names it.
  const currentSpec = configured?.spec ?? flavor.pkg;
  const currentChannel =
    currentSpec === flavor.pkg || currentSpec === `${flavor.pkg}@latest`
      ? "latest"
      : currentSpec === nextSpec(flavor)
        ? "next"
        : "pinned";
  const spec = channel && configured ? (channel === "next" ? nextSpec(flavor) : flavor.pkg) : currentSpec;
  if (channel && configured) {
    const fromSpec = currentSpec === flavor.pkg ? `${flavor.pkg}@latest` : currentSpec;
    const oldDir = path.join(opencodeCacheDir(), flavor.cacheFolder(fromSpec));
    const oldModules = flavor.nodeModulesDir(oldDir);
    const version = oldModules ? readPackageVersion(path.join(oldModules, flavor.pkg, "package.json")) : undefined;
    return {
      flavor,
      spec,
      tag: channel,
      currentChannel,
      notFollowingNext: false,
      switchChannel: currentChannel !== channel ? channel : undefined,
      cache: { dir: path.join(opencodeCacheDir(), flavor.cacheFolder(`${flavor.pkg}@${channel}`)), version },
      latest: lookupOpenCodeLatest(channel, flavor),
    };
  }
  const leftAlone = (skip: string): OpenCodeTarget => ({
    flavor,
    cache: undefined,
    latest: undefined,
    tag: next ? "next" : "latest",
    spec,
    notFollowingNext: false,
    currentChannel: configured ? currentChannel : undefined,
    skip,
  });
  if (flavor.globalConfigOnly) {
    if (!configured) {
      return leftAlone(
        `OpenCode's global config does not name ${flavor.pkg}; this upgrade only refreshes a plugin it names`,
      );
    }
    if (configured.key !== flavor.configKeys[0]) {
      return leftAlone(
        `OpenCode loads "${spec}" from the "${configured.key}" key of your config; move it to "${flavor.configKeys[0]}" ` +
          "to have `akm upgrade` keep it current",
      );
    }
  }
  const followsLatest = spec === flavor.pkg || spec === `${flavor.pkg}@latest`;
  const followNext = spec === nextSpec(flavor);
  // Any other spec loads a cache no run refreshes.
  if (!followsLatest && !followNext) return leftAlone(otherSpecNote(flavor, spec));
  const tag: UpgradeChannel = followNext ? "next" : "latest";
  const cache = detectOpenCodeCache(tag, flavor);
  const latest = cache ? lookupOpenCodeLatest(tag, flavor) : undefined;
  return {
    flavor,
    cache,
    latest,
    tag,
    spec,
    currentChannel: configured || cache ? currentChannel : undefined,
    notFollowingNext: next && !followNext,
  };
}

/** A target for a flavor whose config could not be read: nothing about its spec, cache or channel is known. */
function unreadableTarget(flavor: OpenCodeFlavor, error: string, next: boolean): OpenCodeTarget {
  return {
    flavor,
    cache: undefined,
    latest: undefined,
    tag: next ? "next" : "latest",
    spec: flavor.pkg,
    notFollowingNext: false,
    unreadable: error,
  };
}

/**
 * The OpenCode plugins this host has: OpenCode 1's always, OpenCode 2's only when the global config
 * names `akm-opencode-v2` or OpenCode 2 has cached it, so a host with just OpenCode 1 sees the same
 * output as before.
 */
function resolveOpenCodeTargets(next: boolean, channel?: UpgradeChannel): OpenCodeTarget[] {
  const resolve = (flavor: OpenCodeFlavor, configured: OpenCodeConfigSpec | { error: string } | undefined) =>
    configured && "error" in configured
      ? unreadableTarget(flavor, configured.error, next)
      : resolveOpenCodeTarget(next, flavor, configured, channel);
  const targets = [resolve(OPENCODE_V1, openCodeConfigSpec(OPENCODE_V1))];
  const v2 = openCodeConfigSpec(OPENCODE_V2);
  if ((v2 && !("error" in v2)) || openCodeV2Cached()) targets.push(resolve(OPENCODE_V2, v2));
  return targets;
}

/**
 * The newest akm plugin build on `channel` of the marketplace at `source`: the version its catalog names. Only the
 * catalog and the plugin manifest are read, from a blobless clone with nothing checked out, so the channel's other
 * files are never downloaded. The real channel switch, `akm upgrade --check` and `akm health` all read it here.
 */
export function marketplaceTargetVersion(source: string, channel: UpgradeChannel, harness: "claude" | "codex"): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akm-channel-check-"));
  const checkout = path.join(root, "marketplace");
  try {
    const cloned = runCommand(
      "git",
      [
        "clone",
        "--depth",
        "1",
        "--single-branch",
        "--filter=blob:none",
        "--no-checkout",
        ...(channel === "next" ? ["--branch", "next"] : []),
        "--",
        source,
        checkout,
      ],
      REFRESH_TIMEOUT_MS,
    );
    if (!cloned.ok) throw new UsageError(`Could not check the target plugin version: ${cloned.error}`);
    const show = (file: string) => runCommand("git", ["-C", checkout, "show", `HEAD:${file}`], REFRESH_TIMEOUT_MS);
    const manifestDir = harness === "codex" ? ".codex-plugin" : ".claude-plugin";
    const catalogFile = harness === "codex" ? ".agents/plugins/marketplace.json" : ".claude-plugin/marketplace.json";
    const catalogText = show(catalogFile);
    if (!catalogText.ok) throw new UsageError(`Could not read the marketplace catalog: ${catalogText.error}`);
    const catalog = parseJson(catalogText.stdout) as
      | {
          plugins?: Array<{
            name?: string;
            source?: string | { source?: string; path?: string; url?: string; ref?: string };
            version?: string;
          }>;
        }
      | undefined;
    const plugin = catalog?.plugins?.find((p) => p.name === "akm");
    const entry = typeof plugin?.source === "object" ? plugin.source : undefined;
    // A `git-subdir` entry (Codex) names its build by tag; one in this same repo can also be read from the repository.
    const tagged = entry?.source === "git-subdir" ? entry.ref?.replace(/^v/, "") : undefined;
    const sameRepo = (url: string | undefined) =>
      url !== undefined && url.replace(/\.git$/, "").toLowerCase() === source.replace(/\.git$/, "").toLowerCase();
    const relative =
      typeof plugin?.source === "string"
        ? plugin.source
        : entry?.source === "local" || (entry?.source === "git-subdir" && sameRepo(entry.url))
          ? entry.path
          : undefined;
    const dir = relative ? path.posix.normalize(relative) : undefined;
    const contained = dir !== undefined && !path.posix.isAbsolute(dir) && dir !== ".." && !dir.startsWith("../");
    let manifestVersion: string | undefined;
    if (contained) {
      const manifest = show(path.posix.join(dir, manifestDir, "plugin.json"));
      const version = manifest.ok
        ? (parseJson(manifest.stdout) as { version?: unknown } | undefined)?.version
        : undefined;
      manifestVersion = typeof version === "string" ? version : undefined;
    }
    const version = plugin?.version ?? (tagged && isExactSemver(tagged) ? tagged : undefined) ?? manifestVersion;
    if (!version || !isExactSemver(version))
      throw new UsageError(
        "Could not determine the requested marketplace's akm plugin version; no channel was changed",
      );
    return version;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function claudePluginsRoot(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
  return (
    process.env.AKM_CLAUDE_PLUGINS_DIR ?? process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR ?? path.join(configDir, "plugins")
  );
}

/** The Git source and ref Claude has registered for a marketplace. */
export function claudeMarketplace(
  pluginsRoot: string,
  marketplace = MARKETPLACE,
): { source: string; ref: string | undefined } {
  const known = parseJson(fs.readFileSync(path.join(pluginsRoot, "known_marketplaces.json"), "utf8")) as Record<
    string,
    { source: { source: string; repo?: string; url?: string; ref?: string } }
  >;
  const registered = known[marketplace]?.source;
  const url =
    registered?.source === "github" && registered.repo ? `https://github.com/${registered.repo}.git` : registered?.url;
  if (!url) throw new UsageError("Could not determine the Claude marketplace Git source; no channel was changed");
  return { source: url, ref: typeof registered?.ref === "string" ? registered.ref : undefined };
}

/** The Git source and ref Codex has registered for the akm-plugins marketplace. */
export function codexMarketplaceRegistration(): { source: string; ref: string | undefined } {
  const registered = codexMarketplaceEntry();
  if ("error" in registered)
    throw new UsageError(`Could not read Codex's config: ${registered.error}; no channel was changed`);
  const source = registered.entry?.source;
  if (typeof source !== "string")
    throw new UsageError("Could not determine the Codex marketplace Git source; no channel was changed");
  const ref = registered.entry?.ref;
  return { source, ref: typeof ref === "string" ? ref : undefined };
}

/**
 * What moving one marketplace plugin to `channel` does, read without changing anything: the build the channel's branch
 * of the registered `source` offers (or why it could not be read), and, unless a downgrade is allowed, the installed
 * version that switch leaves alone because the channel has nothing newer. The real switch and `--check` both decide
 * from this.
 */
interface MarketplacePlan {
  target: string | Error;
  keep?: Kept;
}

function marketplacePlan(
  harness: "claude-code" | "codex",
  source: string,
  installed: (string | undefined)[],
  channel: UpgradeChannel,
  allowDowngrade: boolean,
): MarketplacePlan {
  let target: string | Error;
  try {
    target = marketplaceTargetVersion(source, channel, harness === "codex" ? "codex" : "claude");
  } catch (error) {
    target = error instanceof Error ? error : new Error(String(error));
  }
  let keep: Kept | undefined;
  for (const version of installed) {
    if (allowDowngrade || !version) continue;
    // An unreadable channel build leaves this plugin where it is; it never blocks the rest of the upgrade.
    if (target instanceof Error)
      keep = { installed: version, reason: `could not read the ${channel} build's version (${target.message})` };
    else if (semverOrder(target, version) <= 0 && (!keep || semverOrder(keep.installed, version) < 0))
      keep = { installed: version };
  }
  return { target, ...(keep ? { keep } : {}) };
}

/**
 * Checks the marketplace channel switch can be made and returns each harness's plan: the channel's build and, when
 * the installed build is as new as or newer than it, the plugin to leave alone. The check and the run both use it.
 */
function preflightMarketplaceChannels(
  channel: UpgradeChannel,
  allowDowngrade: boolean,
): { claude?: MarketplacePlan; codex?: MarketplacePlan } {
  const plans: { claude?: MarketplacePlan; codex?: MarketplacePlan } = {};
  const claude = detectClaudeCode();
  if ("entry" in claude && claude.entry.outcome === "failed")
    throw new UsageError(`Could not inventory Claude before switching channels: ${claude.entry.message}`);
  if (!("entry" in claude)) {
    const pluginsRoot = claudePluginsRoot();
    claudeChannelEdits(
      process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude"),
      pluginsRoot,
      channel,
      claude.installations.flatMap((p) => (p.projectPath ? [p.projectPath] : [])),
    );
    const plan = marketplacePlan(
      "claude-code",
      claudeMarketplace(pluginsRoot).source,
      claude.installations.map((p) => p.version),
      channel,
      allowDowngrade,
    );
    plans.claude = plan;
  }
  const codex = codexPluginVersion();
  if ("error" in codex && (!codex.error.missing || fs.existsSync(codexConfigFile())))
    throw new UsageError(`Could not inventory Codex before switching channels: ${codex.error.error}`);
  if (!("error" in codex) && codex.version !== undefined) {
    const registered = codexMarketplaceEntry();
    if ("error" in registered)
      throw new UsageError(`Could not inventory Codex before switching channels: ${registered.error}`);
    codexChannelEdit(codexConfigFile(), channel);
    const plan = marketplacePlan(
      "codex",
      codexMarketplaceRegistration().source,
      [codex.version],
      channel,
      allowDowngrade,
    );
    plans.codex = plan;
  }
  return plans;
}

/** `akm upgrade`: the CLI step, then the plugins. */
export async function runUpgrade(
  args: {
    check: boolean;
    force: boolean;
    skipPostUpgrade: boolean;
    skipChecksum?: boolean;
    next?: boolean;
    channel?: string;
    allowDowngrade?: boolean;
  },
  currentVersion: string,
  deps: UpgradeRunDependencies,
): Promise<UpgradeRunResult> {
  if (args.channel !== undefined && args.channel !== "latest" && args.channel !== "next")
    throw new UsageError("--channel must be latest or next");
  if (args.next && args.channel === "latest") throw new UsageError("--next conflicts with --channel latest");
  if (args.allowDowngrade && !args.channel) throw new UsageError("--allow-downgrade requires --channel latest or next");
  const switchChannel = args.channel as UpgradeChannel | undefined;
  const next = switchChannel ? switchChannel === "next" : args.next === true;
  const currentChannel = installedChannel(currentVersion);
  // With no channel asked for, the CLI stays on the one it is on.
  const channel: UpgradeChannel = switchChannel ?? (next ? "next" : currentChannel);
  const openCode = resolveOpenCodeTargets(next, switchChannel);
  const check = {
    ...(await deps.checkForUpdate(currentVersion, channel, switchChannel !== undefined)),
    channel,
    currentChannel,
    ...(switchChannel ? { targetChannel: switchChannel } : {}),
  };
  let stayMessage: string | undefined;
  // A channel whose newest akm is older than the installed one leaves akm where it is; an explicit switch still switches.
  if (!args.allowDowngrade && semverOrder(check.latestVersion, currentVersion) < 0) {
    stayMessage = `akm stays at ${currentVersion}; ${channel} has nothing newer`;
    check.latestVersion = currentVersion;
    check.updateAvailable = false;
  }
  if (switchChannel && !args.allowDowngrade) {
    for (const target of openCode) {
      if (
        target.cache?.version &&
        target.latest &&
        !("error" in target.latest) &&
        semverOrder(target.latest.version, target.cache.version) <= 0
      )
        target.keepInstalled = true;
    }
  }
  if (switchChannel && args.allowDowngrade && check.latestVersion !== currentVersion) check.updateAvailable = true;
  const plans = switchChannel ? preflightMarketplaceChannels(switchChannel, args.allowDowngrade === true) : {};
  if (args.check) {
    return {
      mode: "check",
      result: {
        ...check,
        plugins: withEngineSkew(
          upgradePlugins({
            dryRun: true,
            next,
            openCode,
            channel: switchChannel,
            plans,
            currentChannel,
            allowDowngrade: args.allowDowngrade,
          }),
          currentVersion,
        ),
      },
    };
  }
  const upgraded = await deps.performUpgrade(check, {
    force: args.force,
    skipPostUpgrade: args.skipPostUpgrade,
    ...(args.skipChecksum ? { skipChecksum: true } : {}),
    // A package manager install must name the version, or `@latest` goes past the prerelease the channel chose or
    // below the akm that stays.
    ...(switchChannel || stayMessage || (channel === "next" && check.latestVersion)
      ? { targetVersion: check.latestVersion }
      : {}),
  });
  if (
    switchChannel &&
    (upgraded.migration?.status === "blocked" ||
      upgraded.migration?.status === "failed" ||
      (check.latestVersion !== currentVersion && !upgraded.upgraded))
  ) {
    return {
      mode: "upgrade",
      result: { ...upgraded, channel, currentChannel, targetChannel: switchChannel, plugins: [] },
      failed: true,
    };
  }
  const plugins = withEngineSkew(
    upgradePlugins({
      dryRun: false,
      next,
      openCode,
      channel: switchChannel,
      plans,
      currentChannel: upgraded.upgraded ? installedChannel(upgraded.newVersion) : currentChannel,
    }),
    upgraded.upgraded ? upgraded.newVersion : currentVersion,
  );
  const result = {
    ...upgraded,
    channel,
    currentChannel,
    ...(switchChannel ? { targetChannel: switchChannel } : {}),
    ...(stayMessage ? { message: stayMessage } : {}),
    plugins,
  };
  // The install may have succeeded, but an upgrade whose migration is
  // blocked or could not run is not done, and neither is one whose plugin
  // step failed.
  const migrationFailed = upgraded.migration?.status === "blocked" || upgraded.migration?.status === "failed";
  // A plugin left on the other channel is a switch that did not happen. A "current" entry there is one the switch
  // left alone on purpose, and a deferred or skipped plugin already follows the channel asked for: its update waits
  // for the harness to exit, as in an upgrade with no --channel, and is reported in its entry.
  const switchIncomplete =
    switchChannel !== undefined &&
    plugins.some((p) => p.channel !== undefined && p.channel !== switchChannel && p.outcome !== "current");
  return {
    mode: "upgrade",
    result,
    failed: migrationFailed || switchIncomplete || plugins.some((p) => p.outcome === "failed"),
  };
}
