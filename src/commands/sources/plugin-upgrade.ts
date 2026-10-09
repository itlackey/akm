// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The plugin half of `akm upgrade` (#1007): refresh the akm plugin of each
 * installed agent harness, and keep the CLI in version lockstep with the
 * OpenCode plugin. Update only: a plugin that is not installed is never
 * installed, and a harness without one is skipped. Every external command
 * runs with a timeout and its failure is captured on that harness's entry,
 * so a broken harness never aborts the CLI upgrade.
 */

import * as childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { IS_WINDOWS, parseJsonc } from "../../core/common";
import { moveToTrash } from "../../core/trash";
import { OPENCODE_SDK_SERVER_BIN } from "../../integrations/agent/profiles";
import {
  OPENCODE_V1,
  OPENCODE_V2,
  type OpenCodeFlavor,
  readPackageVersion,
} from "../../integrations/harnesses/opencode/plugin-layout";
import { detectOpencodeMajor, resolveOpencodeBin } from "../../integrations/harnesses/opencode/version";
import { semverOrder } from "../../runtime";
import type {
  PluginUpgradeEntry,
  UpgradeChannel,
  UpgradeCheckResponse,
  UpgradeLockstep,
  UpgradeResponse,
} from "../../sources/types";

const MARKETPLACE = "akm-plugins";
const PLUGIN_ID = `akm@${MARKETPLACE}`;
const READ_TIMEOUT_MS = 30_000;
const REFRESH_TIMEOUT_MS = 120_000;
const PREFETCH_TIMEOUT_MS = 180_000;

// ── Running external commands ───────────────────────────────────────────────

type CommandFailure = { ok: false; missing: boolean; error: string };
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

/** An entry for a refresh that ran: `updated` when the installed version moved, else `current`. */
function refreshed(harness: PluginUpgradeEntry["harness"], from: string | undefined, to: string | undefined) {
  const moved = from !== undefined && to !== undefined && from !== to;
  return { harness, outcome: moved ? "updated" : "current", from, to } as PluginUpgradeEntry;
}

/** Unknown, in `--check`: knowing whether a newer build exists needs a marketplace fetch, which `--check` does not do. */
function unknownRefresh(harness: PluginUpgradeEntry["harness"], from: string | undefined): PluginUpgradeEntry {
  return {
    harness,
    outcome: "unknown",
    from,
    message:
      "checking needs a fetch of the akm-plugins marketplace, which --check does not do; `akm upgrade` refreshes it",
  };
}

// ── Claude Code ─────────────────────────────────────────────────────────────

type Detected = { entry: PluginUpgradeEntry } | { version: string | undefined };

function claudePluginVersion(): { version: string | undefined } | { error: CommandFailure } {
  const listed = runCommand("claude", ["plugin", "list", "--json"], READ_TIMEOUT_MS);
  if (!listed.ok) return { error: listed };
  const plugins = parseJson(listed.stdout);
  const plugin = Array.isArray(plugins) ? plugins.find((p) => p?.id === PLUGIN_ID) : undefined;
  return { version: plugin ? String(plugin.version ?? "") : undefined };
}

function detectClaudeCode(): Detected {
  const marketplaces = runCommand("claude", ["plugin", "marketplace", "list", "--json"], READ_TIMEOUT_MS);
  if (!marketplaces.ok) {
    return { entry: skipped("claude-code", marketplaces.missing ? "claude is not on PATH" : marketplaces.error) };
  }
  const list = parseJson(marketplaces.stdout);
  if (!Array.isArray(list) || !list.some((m) => m?.name === MARKETPLACE)) {
    return { entry: skipped("claude-code", `the ${MARKETPLACE} marketplace is not configured`) };
  }
  const plugin = claudePluginVersion();
  if ("error" in plugin) return { entry: skipped("claude-code", plugin.error.error) };
  if (plugin.version === undefined) return { entry: skipped("claude-code", "the akm plugin is not installed") };
  return { version: plugin.version };
}

function upgradeClaudeCode(dryRun: boolean): PluginUpgradeEntry {
  const detected = detectClaudeCode();
  if ("entry" in detected) return detected.entry;
  if (dryRun) return unknownRefresh("claude-code", detected.version);
  const marketplace = runCommand("claude", ["plugin", "marketplace", "update", MARKETPLACE], REFRESH_TIMEOUT_MS);
  if (!marketplace.ok) return failed("claude-code", marketplace.error);
  const update = runCommand("claude", ["plugin", "update", PLUGIN_ID], REFRESH_TIMEOUT_MS);
  if (!update.ok) return failed("claude-code", update.error);
  const after = claudePluginVersion();
  return refreshed("claude-code", detected.version, "version" in after ? after.version : undefined);
}

// ── Codex ───────────────────────────────────────────────────────────────────

function codexPluginVersion(): { version: string | undefined } | { error: CommandFailure } {
  const listed = runCommand("codex", ["plugin", "list", "--marketplace", MARKETPLACE, "--json"], READ_TIMEOUT_MS);
  if (!listed.ok) return { error: listed };
  const parsed = parseJson(listed.stdout) as { installed?: Array<{ pluginId?: string; version?: string }> } | undefined;
  const plugin = parsed?.installed?.find((p) => p?.pluginId === PLUGIN_ID);
  return { version: plugin ? String(plugin.version ?? "") : undefined };
}

function upgradeCodex(dryRun: boolean): PluginUpgradeEntry {
  const before = codexPluginVersion();
  if ("error" in before) return skipped("codex", before.error.missing ? "codex is not on PATH" : before.error.error);
  if (before.version === undefined) {
    return skipped("codex", `the akm plugin is not installed from the ${MARKETPLACE} marketplace`);
  }
  if (dryRun) return unknownRefresh("codex", before.version);
  // Also refreshes the installed plugin's cache, so no re-add is needed.
  const upgrade = runCommand("codex", ["plugin", "marketplace", "upgrade", MARKETPLACE], REFRESH_TIMEOUT_MS);
  if (!upgrade.ok) return failed("codex", upgrade.error);
  const after = codexPluginVersion();
  return refreshed("codex", before.version, "version" in after ? after.version : undefined);
}

// ── OpenCode ────────────────────────────────────────────────────────────────

const nextSpec = (flavor: OpenCodeFlavor) => `${flavor.pkg}@next`;

export interface OpenCodeCache {
  dir: string;
  version: string | undefined;
}

export type OpenCodeLatest = { version: string; akmCli: string | undefined } | { error: string };

function homeDir(): string {
  return process.env.HOME?.trim() || process.env.USERPROFILE?.trim() || os.homedir();
}

function openCodeCacheHome(): string {
  const cacheHome = process.env.XDG_CACHE_HOME?.trim() || path.join(homeDir(), ".cache");
  return path.join(cacheHome, "opencode");
}

/** The spec in a config's plugin entry (a spec string or a `[spec, options]` pair). */
function entrySpec(entry: unknown): string | undefined {
  const spec = Array.isArray(entry) ? entry[0] : entry;
  return typeof spec === "string" ? spec : undefined;
}

const namesPackage = (spec: string, pkg: string) => spec === pkg || spec.startsWith(`${pkg}@`);

/**
 * The plugin spec the user's global OpenCode config names for this flavor's
 * package (bare, `@latest`, `@next`, an exact version, ...), with the config key
 * it sits under, or undefined when none does. OpenCode caches each spec in its
 * own folder, so this says which cache it loads. The config is only read, never
 * written; project configs are not looked at (akm does not know which project
 * OpenCode runs in).
 */
export function openCodeConfigSpec(flavor: OpenCodeFlavor): { spec: string; key: string } | undefined {
  const configHome = process.env.XDG_CONFIG_HOME?.trim() || path.join(homeDir(), ".config");
  const files = [
    flavor.globalConfigOnly ? undefined : process.env.OPENCODE_CONFIG?.trim(),
    path.join(configHome, "opencode", "opencode.json"),
    path.join(configHome, "opencode", "opencode.jsonc"),
  ];
  for (const file of files) {
    if (!file) continue;
    try {
      const config = parseJsonc(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
      for (const key of flavor.configKeys) {
        const entries = config[key];
        if (!Array.isArray(entries)) continue;
        for (const entry of entries) {
          const spec = entrySpec(entry);
          if (spec !== undefined && namesPackage(spec, flavor.pkg)) return { spec, key };
        }
      }
    } catch {
      // Missing or unparseable: this file names no spec.
    }
  }
  return undefined;
}

/** Whether OpenCode 2 has ever cached `akm-opencode-v2` on this host. */
function openCodeV2Cached(): boolean {
  try {
    return fs
      .readdirSync(path.join(openCodeCacheHome(), OPENCODE_V2.cacheFolder("")))
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
  const dir = path.join(openCodeCacheHome(), flavor.cacheFolder(`${flavor.pkg}@${tag}`));
  if (!fs.existsSync(dir)) return undefined;
  const nodeModules = flavor.nodeModulesDir(dir);
  return { dir, version: nodeModules && readPackageVersion(path.join(nodeModules, flavor.pkg, "package.json")) };
}

/** What npm's `<pkg>@<tag>` is, and which akm-cli it pins. */
export function lookupOpenCodeLatest(tag: UpgradeChannel, flavor: OpenCodeFlavor): OpenCodeLatest {
  const spec = `${flavor.pkg}@${tag}`;
  const view = runCommand(
    IS_WINDOWS ? "npm.cmd" : "npm",
    ["view", spec, "version", "dependencies.akm-cli", "--json"],
    READ_TIMEOUT_MS,
  );
  if (!view.ok) return { error: view.error };
  const parsed = parseJson(view.stdout) as { version?: unknown; "dependencies.akm-cli"?: unknown } | undefined;
  if (typeof parsed?.version !== "string") return { error: `npm did not report a version for ${spec}` };
  const akmCli = parsed["dependencies.akm-cli"];
  return { version: parsed.version, akmCli: typeof akmCli === "string" ? akmCli : undefined };
}

/**
 * `<pkg>@next`, which must exist and pin an akm-cli no older than the one
 * `@latest` pins: a prerelease channel that trails the stable one is not a target.
 *
 * The two builds are compared by their akm-cli pins, never by their own
 * versions. akm-plugins' stable versions are `<akm_version><yyyymmddhhmm>`
 * concatenated into the PATCH (`0.9.27202610072331`), while prereleases are
 * `<akm_version>.<ts>` (`0.9.28-alpha.8.202610081938`), so by semver every
 * prerelease sorts below the stable build and the comparison means nothing
 * (#1089). For the same reason plugin versions are only ever tested for
 * equality (is the cache already this build?), never ordered.
 */
export function lookupOpenCodeNext(flavor: OpenCodeFlavor): OpenCodeLatest {
  const next = lookupOpenCodeLatest("next", flavor);
  if ("error" in next) return next;
  const latest = lookupOpenCodeLatest("latest", flavor);
  if ("error" in latest) return { error: `could not compare with ${flavor.pkg}@latest: ${latest.error}` };
  // No pin on @next: returned as is, and the lockstep holds the CLI and says why.
  if (!next.akmCli) return next;
  if (!latest.akmCli) {
    return { error: `could not compare with ${flavor.pkg}@latest: it declares no akm-cli dependency` };
  }
  if (semverOrder(next.akmCli, latest.akmCli) < 0) {
    return {
      error:
        `${nextSpec(flavor)} (${next.version}) pins akm-cli ${next.akmCli}, older than the ` +
        `${latest.akmCli} that ${flavor.pkg}@latest (${latest.version}) pins`,
    };
  }
  return next;
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
  `--next: OpenCode resolves a bare "${flavor.pkg}" to @latest, so it is not updated to a prerelease; ` +
  `set "${flavor.configKeys[0]}": ["${nextSpec(flavor)}"] in your OpenCode config to follow prereleases`;

/** Why a run leaves alone an OpenCode whose config names a spec this run does not refresh (#1115, #1117). */
function otherSpecNote(flavor: OpenCodeFlavor, spec: string): string {
  const loads = `OpenCode loads "${spec}" (your OpenCode config), so this upgrade leaves it alone`;
  const key = flavor.configKeys[0];
  return spec === nextSpec(flavor)
    ? `${loads}; run \`akm upgrade --next\` to update it, or set "${key}": ["${flavor.pkg}"] to follow stable releases`
    : `${loads}; set "${key}": ["${flavor.pkg}"] to have \`akm upgrade\` keep it current`;
}

function upgradeOpenCode(dryRun: boolean, target: OpenCodeTarget): PluginUpgradeEntry {
  const { flavor, cache, latest, tag, skip } = target;
  const harness = flavor.harness;
  // Refreshing a cache OpenCode does not load would trash one it never re-creates (#1115, #1117).
  if (skip) return skipped(harness, skip);
  if (!cache || !latest) return skipped(harness, `no cached ${flavor.pkg}@${tag} plugin`);
  if ("error" in latest) return failed(harness, latest.error);
  if (target.notFollowingNext) return skipped(harness, notFollowingNext(flavor));
  if (cache.version === latest.version) return { harness, outcome: "current", from: cache.version, to: latest.version };
  const base = { harness, from: cache.version, to: latest.version };
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
  if (dryRun) return { ...base, outcome: "pending" };
  // OpenCode must be runnable before the cache goes: it does the prefetch, and only the major
  // that owns this plugin's cache can re-create it. akm never installs or replaces the binary.
  // OpenCode 2 may sit beside an OpenCode 1 `opencode` as `opencode2`; OpenCode 1 is only ever `opencode`.
  const bin = flavor.major === 2 ? resolveOpencodeBin() : OPENCODE_SDK_SERVER_BIN;
  const detected = detectOpencodeMajor(bin);
  if (!detected.runnable) return skipped(harness, `${bin} is not on PATH or \`${bin} --version\` failed`);
  const major = detected.reportedMajor;
  // OpenCode 1 keeps its long-standing behavior when the version cannot be read; OpenCode 2's
  // refresh needs a command only OpenCode 2 has, so it must be sure.
  if (major === undefined ? flavor.major === 2 : major !== flavor.major) {
    return skipped(
      harness,
      `\`${bin}\` on PATH is ${major === undefined ? "of an unknown version" : `OpenCode ${major}`}, ` +
        `not OpenCode ${flavor.major}, so it cannot re-create the ${flavor.pkg} cache; the cache is left alone`,
    );
  }
  try {
    moveToTrash(cache.dir);
  } catch (error) {
    return failed(
      harness,
      `could not move ${cache.dir} to the trash: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  // From a temp dir, so no project's opencode.json is read.
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-opencode-prefetch-"));
  try {
    const prefetch = runCommand(bin, flavor.prefetch(target.spec), PREFETCH_TIMEOUT_MS, { cwd: workDir });
    if (!prefetch.ok) return failed(harness, `${prefetch.error} (the old cache is in the trash)`);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
  const after = detectOpenCodeCache(tag, flavor);
  if (!after) return failed(harness, "opencode did not re-create the plugin cache (the old cache is in the trash)");
  return { ...base, outcome: "updated", to: after.version ?? latest.version };
}

// ── Orchestration ───────────────────────────────────────────────────────────

const NO_PRERELEASE_CHANNEL =
  "--next: no prerelease channel; the akm-plugins marketplace is followed as usual and works with any 0.9.x akm";

/** The note `--next` adds to a harness whose plugin has no prerelease channel. */
function withNextNote(entry: PluginUpgradeEntry): PluginUpgradeEntry {
  if (entry.outcome === "skipped") return entry;
  return { ...entry, message: entry.message ? `${entry.message}; ${NO_PRERELEASE_CHANNEL}` : NO_PRERELEASE_CHANNEL };
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
}

export function upgradePlugins(opts: {
  dryRun: boolean;
  next: boolean;
  openCode: OpenCodeTarget[];
}): PluginUpgradeEntry[] {
  const claude = upgradeClaudeCode(opts.dryRun);
  const codex = upgradeCodex(opts.dryRun);
  return [
    opts.next ? withNextNote(claude) : claude,
    opts.next ? withNextNote(codex) : codex,
    ...opts.openCode.map((target) => upgradeOpenCode(opts.dryRun, target)),
  ];
}

/**
 * When an OpenCode plugin is present the CLI target is the akm-cli that
 * `<pkg>@latest` pins, not the newest release: the plugin runs that
 * exact akm in-process, against databases a newer CLI may already have
 * migrated. The CLI never moves backwards to meet the pin.
 *
 * It fails closed: when the plugin is present but its pin cannot be read (the
 * npm lookup failed, or the package declares no akm-cli), the CLI is held where
 * it is (`updateAvailable: false`, `latestVersion` = the current version) and
 * `lockstep.reason` says why. Moving the CLI ahead of a pin nobody could read is
 * what lockstep exists to prevent; the OpenCode entry reports the failure.
 */
export function applyLockstep<T extends UpgradeCheckResponse>(
  check: T,
  latest: OpenCodeLatest | undefined,
  tag: UpgradeChannel,
  pkg: OpenCodeFlavor["pkg"],
): T & { lockstep?: UpgradeLockstep } {
  if (!latest) return check;
  // Held back only when there is a release this upgrade would otherwise install.
  const wouldInstall = semverOrder(check.currentVersion, check.latestVersion) < 0;
  const pinned = "error" in latest ? undefined : latest.akmCli;
  if (!pinned) {
    const reason =
      "error" in latest
        ? `could not read the akm-cli pin of ${pkg}@${tag}: ${latest.error}`
        : `${pkg}@${tag} declares no akm-cli dependency`;
    return {
      ...check,
      latestVersion: check.currentVersion,
      updateAvailable: false,
      lockstep: {
        plugin: pkg,
        pinnedVersion: null,
        newestVersion: check.latestVersion,
        heldBack: wouldInstall,
        reason,
      },
    };
  }
  const heldBack = semverOrder(pinned, check.latestVersion) < 0 && wouldInstall;
  const lockstep: UpgradeLockstep = {
    plugin: pkg,
    pinnedVersion: pinned,
    newestVersion: check.latestVersion,
    heldBack,
  };
  if (!heldBack) return { ...check, lockstep };
  return {
    ...check,
    latestVersion: pinned,
    updateAvailable: semverOrder(check.currentVersion, pinned) < 0,
    lockstep,
  };
}

/**
 * The plugin the CLI is held to when several are present: one whose pin could not be read (the
 * CLI stays put), else the one pinning the oldest akm-cli, since every plugin runs the CLI that is installed.
 */
function lockstepSource(targets: OpenCodeTarget[]): OpenCodeTarget | undefined {
  const readable = (t: OpenCodeTarget): t is OpenCodeTarget & { latest: { akmCli: string } } =>
    t.latest !== undefined && !("error" in t.latest) && typeof t.latest.akmCli === "string";
  const pinned = targets.filter((t) => t.latest);
  return (
    pinned.find((t) => !readable(t)) ??
    pinned.filter(readable).sort((a, b) => semverOrder(a.latest.akmCli, b.latest.akmCli))[0]
  );
}

export interface UpgradeRunDependencies {
  checkForUpdate: (currentVersion: string, channel: UpgradeChannel) => Promise<UpgradeCheckResponse>;
  performUpgrade: (
    check: UpgradeCheckResponse,
    opts: { force: boolean; skipPostUpgrade: boolean; targetVersion?: string },
  ) => Promise<UpgradeResponse>;
}

export type UpgradeRunResult =
  | { mode: "check"; result: UpgradeCheckResponse & { plugins: PluginUpgradeEntry[] } }
  | { mode: "upgrade"; result: UpgradeResponse & { plugins: PluginUpgradeEntry[] }; failed: boolean };

/**
 * Which build of one OpenCode plugin the CLI is held to, and which cache refreshes.
 * Under `--next` that is `<pkg>@next`, but only when the user's OpenCode
 * config names that tag: a bare one keeps resolving `@latest`, so the lockstep
 * stays against the `@latest` pin and the entry is reported as skipped. A config
 * naming any other spec (an exact version, or `@next` on a plain run) is left
 * alone, with no lockstep.
 */
function resolveOpenCodeTarget(
  next: boolean,
  flavor: OpenCodeFlavor,
  configured: { spec: string; key: string } | undefined,
): OpenCodeTarget {
  // OpenCode 1 with no config entry behaves like a bare one: it would resolve @latest. OpenCode 2's
  // re-fetch writes the config, so its plugin is only refreshed where the config already names it.
  const spec = configured?.spec ?? flavor.pkg;
  const leftAlone = (skip: string): OpenCodeTarget => ({
    flavor,
    cache: undefined,
    latest: undefined,
    tag: next ? "next" : "latest",
    spec,
    notFollowingNext: false,
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
  const followNext = next && spec === nextSpec(flavor);
  // Any other spec loads a cache this run does not refresh, and pins no akm-cli it should be held to.
  if (!followsLatest && !followNext) return leftAlone(otherSpecNote(flavor, spec));
  const tag: UpgradeChannel = followNext ? "next" : "latest";
  const cache = detectOpenCodeCache(tag, flavor);
  const latest = cache ? (followNext ? lookupOpenCodeNext(flavor) : lookupOpenCodeLatest("latest", flavor)) : undefined;
  return { flavor, cache, latest, tag, spec, notFollowingNext: next && !followNext };
}

/**
 * The OpenCode plugins this host has: OpenCode 1's always, OpenCode 2's only when the global config
 * names `akm-opencode-v2` or OpenCode 2 has cached it, so a host with just OpenCode 1 sees the same
 * output as before.
 */
function resolveOpenCodeTargets(next: boolean): OpenCodeTarget[] {
  const targets = [resolveOpenCodeTarget(next, OPENCODE_V1, openCodeConfigSpec(OPENCODE_V1))];
  const v2 = openCodeConfigSpec(OPENCODE_V2);
  if (v2 || openCodeV2Cached()) targets.push(resolveOpenCodeTarget(next, OPENCODE_V2, v2));
  return targets;
}

/** `akm upgrade`: the CLI step (held to the OpenCode plugin's akm), then the plugins. */
export async function runUpgrade(
  args: { check: boolean; force: boolean; skipPostUpgrade: boolean; next?: boolean },
  currentVersion: string,
  deps: UpgradeRunDependencies,
): Promise<UpgradeRunResult> {
  const next = args.next === true;
  const channel: UpgradeChannel = next ? "next" : "latest";
  const openCode = resolveOpenCodeTargets(next);
  const held = lockstepSource(openCode);
  const check = {
    ...applyLockstep(
      await deps.checkForUpdate(currentVersion, channel),
      held?.latest,
      held?.tag ?? "latest",
      held?.flavor.pkg ?? OPENCODE_V1.pkg,
    ),
    channel,
  };
  if (args.check) {
    return { mode: "check", result: { ...check, plugins: upgradePlugins({ dryRun: true, next, openCode }) } };
  }
  const upgraded = await deps.performUpgrade(check, {
    force: args.force,
    skipPostUpgrade: args.skipPostUpgrade,
    // A package manager install must name the version, or `@latest` goes past the pin
    // (or past the prerelease that `--next` chose).
    ...(check.lockstep?.heldBack || (next && check.latestVersion) ? { targetVersion: check.latestVersion } : {}),
  });
  const plugins = upgradePlugins({ dryRun: false, next, openCode });
  const result = { ...upgraded, channel, ...(check.lockstep ? { lockstep: check.lockstep } : {}), plugins };
  // The install may have succeeded, but an upgrade whose migration is
  // blocked or could not run is not done, and neither is one whose plugin
  // step failed.
  const migrationFailed = upgraded.migration?.status === "blocked" || upgraded.migration?.status === "failed";
  return { mode: "upgrade", result, failed: migrationFailed || plugins.some((p) => p.outcome === "failed") };
}
