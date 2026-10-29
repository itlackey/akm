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
import { isExactSemver, isPrerelease } from "../../registry/semver";
import { semverOrder } from "../../runtime";
import type {
  PluginUpgradeEntry,
  UpgradeChannel,
  UpgradeCheckResponse,
  UpgradeLockstep,
  UpgradeResponse,
} from "../../sources/types";
import {
  ChannelWriteError,
  claudeChannelEdits,
  codexChannelEdit,
  codexMarketplace,
  editChannelJson,
  writeChannelEdits,
} from "./plugin-channels";

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

function detectClaudeCode(strict = false): Detected {
  const marketplaces = runCommand("claude", ["plugin", "marketplace", "list", "--json"], READ_TIMEOUT_MS);
  if (!marketplaces.ok) {
    const configDir = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
    const pluginsRoot =
      process.env.AKM_CLAUDE_PLUGINS_DIR ?? process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR ?? path.join(configDir, "plugins");
    const configured = fs.existsSync(path.join(pluginsRoot, "known_marketplaces.json"));
    return {
      entry:
        strict && (!marketplaces.missing || configured)
          ? { ...failed("claude-code", marketplaces.error), channel: "unknown" }
          : skipped("claude-code", marketplaces.missing ? "claude is not on PATH" : marketplaces.error),
    };
  }
  const list = parseJson(marketplaces.stdout);
  const marketplace = Array.isArray(list) ? list.find((m) => m?.name === MARKETPLACE) : undefined;
  if (!marketplace) return { entry: skipped("claude-code", `the ${MARKETPLACE} marketplace is not configured`) };
  const plugin = claudePlugins();
  if ("error" in plugin)
    return {
      entry: strict
        ? { ...failed("claude-code", plugin.error.error), channel: "unknown" }
        : skipped("claude-code", plugin.error.error),
    };
  if (!plugin.installations.length) return { entry: skipped("claude-code", "the akm plugin is not installed") };
  return {
    version: plugin.installations[0]?.version,
    installations: plugin.installations,
    ref: typeof marketplace.ref === "string" ? marketplace.ref : undefined,
  };
}

function upgradeClaudeCode(dryRun: boolean, next: boolean, channel?: UpgradeChannel): PluginUpgradeEntry {
  const detected = detectClaudeCode(channel !== undefined);
  if ("entry" in detected) return detected.entry;
  const before = refChannel(detected.ref);
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
  const entry = refreshClaudeCode(dryRun, detected.version, channel ? detected.installations : undefined);
  const noted = next && !channel ? withChannelNote(entry, detected.ref) : entry;
  return channelResult(noted, before, channel, dryRun, backups);
}

function refreshClaudeCode(
  dryRun: boolean,
  from: string | undefined,
  installations?: ClaudeInstallation[],
): PluginUpgradeEntry {
  if (dryRun) return unknownRefresh("claude-code", from);
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

function codexPluginVersion(): { version: string | undefined } | { error: CommandFailure } {
  const listed = runCommand("codex", ["plugin", "list", "--marketplace", MARKETPLACE, "--json"], READ_TIMEOUT_MS);
  if (!listed.ok) return { error: listed };
  const parsed = parseJson(listed.stdout) as { installed?: Array<{ pluginId?: string; version?: string }> } | undefined;
  const plugin = parsed?.installed?.find((p) => p?.pluginId === PLUGIN_ID);
  return { version: plugin ? String(plugin.version ?? "") : undefined };
}

function codexConfigFile(): string {
  return path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "config.toml");
}

function codexMarketplaceRef(): string | undefined {
  try {
    const ref = codexMarketplace(codexConfigFile())?.ref;
    return typeof ref === "string" ? ref : undefined;
  } catch {
    return undefined;
  }
}

function upgradeCodex(dryRun: boolean, next: boolean, channel?: UpgradeChannel): PluginUpgradeEntry {
  const before = codexPluginVersion();
  if ("error" in before)
    return channel && (!before.error.missing || fs.existsSync(codexConfigFile()))
      ? { ...failed("codex", before.error.error), channel: "unknown" }
      : skipped("codex", before.error.missing ? "codex is not on PATH" : before.error.error);
  if (before.version === undefined) {
    return skipped("codex", `the akm plugin is not installed from the ${MARKETPLACE} marketplace`);
  }
  const previous = refChannel(codexMarketplaceRef());
  const backups: string[] = [];
  if (channel && previous !== channel && !dryRun) {
    try {
      backups.push(...writeChannelEdits([codexChannelEdit(codexConfigFile(), channel)]));
    } catch (error) {
      return channelWriteFailure("codex", error, previous);
    }
  }
  const entry = refreshCodex(dryRun, before.version);
  return channelResult(
    next && !channel ? withChannelNote(entry, codexMarketplaceRef()) : entry,
    previous,
    channel,
    dryRun,
    backups,
  );
}

function refreshCodex(dryRun: boolean, from: string | undefined): PluginUpgradeEntry {
  if (dryRun) return unknownRefresh("codex", from);
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

export type OpenCodeLatest = { version: string; akmCli: string | undefined } | { error: string };

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
export function openCodeConfigSpec(
  flavor: OpenCodeFlavor,
): { spec: string; key: string; file: string; jsonPath: (string | number)[] } | undefined {
  const configDir = opencodeConfigDir();
  const files = [
    flavor.globalConfigOnly ? undefined : process.env.OPENCODE_CONFIG?.trim(),
    path.join(configDir, "opencode.json"),
    path.join(configDir, "opencode.jsonc"),
  ];
  for (const file of files) {
    if (!file) continue;
    try {
      const config = parseJsonc(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
      for (const key of flavor.configKeys) {
        const entries = config[key];
        if (!Array.isArray(entries)) continue;
        for (const [index, entry] of entries.entries()) {
          const spec = entrySpec(entry);
          if (spec !== undefined && namesPackage(spec, flavor.pkg))
            return { spec, key, file, jsonPath: [key, index, ...(Array.isArray(entry) ? [0] : [])] };
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
  if (!target.switchChannel && cache.version === latest.version)
    return { harness, outcome: "current", from: cache.version, to: latest.version };
  const base = { harness, from: cache.version, to: latest.version };
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
function refChannel(ref: string | undefined): UpgradeChannel | "pinned" {
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
      ? `--next: the ${MARKETPLACE} marketplace follows ref next, the prerelease channel`
      : `--next: the ${MARKETPLACE} marketplace follows ${ref ? `ref ${ref}` : "the default branch (stable)"}; use akm upgrade --channel next to switch all installed plugins`;
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
  currentChannel?: NonNullable<PluginUpgradeEntry["channel"]>;
  switchChannel?: UpgradeChannel;
}

export function upgradePlugins(opts: {
  dryRun: boolean;
  next: boolean;
  openCode: OpenCodeTarget[];
  channel?: UpgradeChannel;
  currentChannel?: UpgradeChannel;
}): PluginUpgradeEntry[] {
  return [
    upgradeClaudeCode(opts.dryRun, opts.next, opts.channel),
    upgradeCodex(opts.dryRun, opts.next, opts.channel),
    ...opts.openCode.map((target) => {
      const entry = upgradeOpenCode(opts.dryRun, target);
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
    ...(entry.channel && opts.currentChannel ? { channelMismatch: entry.channel !== opts.currentChannel } : {}),
  }));
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
  checkForUpdate: (
    currentVersion: string,
    channel: UpgradeChannel,
    exactChannel?: boolean,
  ) => Promise<UpgradeCheckResponse>;
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
  const followNext = next && spec === nextSpec(flavor);
  // Any other spec loads a cache this run does not refresh, and pins no akm-cli it should be held to.
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

/**
 * The OpenCode plugins this host has: OpenCode 1's always, OpenCode 2's only when the global config
 * names `akm-opencode-v2` or OpenCode 2 has cached it, so a host with just OpenCode 1 sees the same
 * output as before.
 */
function resolveOpenCodeTargets(next: boolean, channel?: UpgradeChannel): OpenCodeTarget[] {
  const targets = [resolveOpenCodeTarget(next, OPENCODE_V1, openCodeConfigSpec(OPENCODE_V1), channel)];
  const v2 = openCodeConfigSpec(OPENCODE_V2);
  if (v2 || openCodeV2Cached()) targets.push(resolveOpenCodeTarget(next, OPENCODE_V2, v2, channel));
  return targets;
}

/** Inspect the requested branch in a disposable clone before changing any installation. */
function marketplaceTargetVersion(source: string, channel: UpgradeChannel, harness: "claude" | "codex"): string {
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
        ...(channel === "next" ? ["--branch", "next"] : []),
        "--",
        source,
        checkout,
      ],
      REFRESH_TIMEOUT_MS,
    );
    if (!cloned.ok) throw new UsageError(`Could not check the target plugin version: ${cloned.error}`);
    const catalog = parseJson(
      fs.readFileSync(
        path.join(checkout, ...(harness === "codex" ? [".agents", "plugins"] : [".claude-plugin"]), "marketplace.json"),
        "utf8",
      ),
    ) as
      | { plugins?: Array<{ name?: string; source?: string | { source?: string; path?: string }; version?: string }> }
      | undefined;
    const plugin = catalog?.plugins?.find((p) => p.name === "akm");
    const relative =
      typeof plugin?.source === "string"
        ? plugin.source
        : plugin?.source?.source === "local"
          ? plugin.source.path
          : undefined;
    const local = relative ? path.resolve(checkout, relative) : undefined;
    const contained = local === checkout || local?.startsWith(`${checkout}${path.sep}`);
    const version =
      plugin?.version ??
      (local && contained
        ? readPackageVersion(path.join(local, harness === "codex" ? ".codex-plugin" : ".claude-plugin", "plugin.json"))
        : undefined);
    if (!version || !isExactSemver(version))
      throw new UsageError(
        "Could not determine the requested marketplace's akm plugin version; no channel was changed",
      );
    return version;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function preflightMarketplaceChannels(channel: UpgradeChannel, allowDowngrade: boolean): void {
  const versions = new Map<string, string>();
  const verify = (harness: "claude" | "codex", source: string, installed: string | undefined) => {
    if (allowDowngrade) return;
    const key = `${harness}:${source}`;
    let target = versions.get(key);
    if (!target) {
      target = marketplaceTargetVersion(source, channel, harness);
      versions.set(key, target);
    }
    if (installed && semverOrder(target, installed) < 0)
      throw new UsageError(
        `Switching to ${channel} would downgrade ${harness} from ${installed} to ${target}; repeat with --allow-downgrade`,
      );
  };
  const claude = detectClaudeCode(true);
  if ("entry" in claude && claude.entry.outcome === "failed")
    throw new UsageError(`Could not inventory Claude before switching channels: ${claude.entry.message}`);
  if (!("entry" in claude)) {
    const configDir = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
    const pluginsRoot =
      process.env.AKM_CLAUDE_PLUGINS_DIR ?? process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR ?? path.join(configDir, "plugins");
    claudeChannelEdits(
      configDir,
      pluginsRoot,
      channel,
      claude.installations.flatMap((p) => (p.projectPath ? [p.projectPath] : [])),
    );
    const known = parseJson(fs.readFileSync(path.join(pluginsRoot, "known_marketplaces.json"), "utf8")) as Record<
      string,
      { source: { source: string; repo?: string; url?: string } }
    >;
    const source = known[MARKETPLACE]?.source;
    const url = source?.source === "github" && source.repo ? `https://github.com/${source.repo}.git` : source?.url;
    if (!url) throw new UsageError("Could not determine the Claude marketplace Git source; no channel was changed");
    for (const installed of claude.installations) verify("claude", url, installed.version);
  }
  const codex = codexPluginVersion();
  if ("error" in codex && (!codex.error.missing || fs.existsSync(codexConfigFile())))
    throw new UsageError(`Could not inventory Codex before switching channels: ${codex.error.error}`);
  if (!("error" in codex) && codex.version !== undefined) {
    codexChannelEdit(codexConfigFile(), channel);
    const source = codexMarketplace(codexConfigFile())?.source;
    if (typeof source !== "string")
      throw new UsageError("Could not determine the Codex marketplace Git source; no channel was changed");
    verify("codex", source, codex.version);
  }
}

/** `akm upgrade`: the CLI step (held to the OpenCode plugin's akm), then the plugins. */
export async function runUpgrade(
  args: {
    check: boolean;
    force: boolean;
    skipPostUpgrade: boolean;
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
  const channel: UpgradeChannel = next ? "next" : "latest";
  const currentChannel: UpgradeChannel = isPrerelease(currentVersion) ? "next" : "latest";
  const openCode = resolveOpenCodeTargets(next, switchChannel);
  const held = lockstepSource(openCode);
  const check = {
    ...applyLockstep(
      await deps.checkForUpdate(currentVersion, channel, switchChannel !== undefined),
      held?.latest,
      held?.tag ?? "latest",
      held?.flavor.pkg ?? OPENCODE_V1.pkg,
    ),
    channel,
    currentChannel,
    ...(switchChannel ? { targetChannel: switchChannel } : {}),
  };
  if (
    switchChannel &&
    held?.latest &&
    !("error" in held.latest) &&
    held.latest.akmCli &&
    semverOrder(held.latest.akmCli, check.latestVersion) < 0
  ) {
    check.latestVersion = held.latest.akmCli;
    check.updateAvailable = semverOrder(currentVersion, check.latestVersion) < 0;
  }
  if (args.check) {
    return {
      mode: "check",
      result: {
        ...check,
        plugins: upgradePlugins({ dryRun: true, next, openCode, channel: switchChannel, currentChannel }),
      },
    };
  }
  if (switchChannel && !args.allowDowngrade) {
    if (semverOrder(check.latestVersion, currentVersion) < 0)
      throw new UsageError(
        `Switching to ${channel} would downgrade akm from ${currentVersion} to ${check.latestVersion}; repeat with --allow-downgrade`,
      );
    for (const target of openCode) {
      if (
        target.cache?.version &&
        target.latest &&
        !("error" in target.latest) &&
        semverOrder(target.latest.version, target.cache.version) < 0
      )
        throw new UsageError(
          `Switching to ${channel} would downgrade ${target.flavor.pkg} from ${target.cache.version} to ${target.latest.version}; repeat with --allow-downgrade`,
        );
    }
  }
  if (switchChannel) preflightMarketplaceChannels(switchChannel, args.allowDowngrade === true);
  if (switchChannel && args.allowDowngrade && check.latestVersion !== currentVersion) check.updateAvailable = true;
  const upgraded = await deps.performUpgrade(check, {
    force: args.force,
    skipPostUpgrade: args.skipPostUpgrade,
    // A package manager install must name the version, or `@latest` goes past the pin
    // (or past the prerelease that `--next` chose).
    ...(switchChannel || check.lockstep?.heldBack || (next && check.latestVersion)
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
  const plugins = upgradePlugins({
    dryRun: false,
    next,
    openCode,
    channel: switchChannel,
    currentChannel: upgraded.upgraded ? (isPrerelease(upgraded.newVersion) ? "next" : "latest") : currentChannel,
  });
  const result = {
    ...upgraded,
    channel,
    currentChannel,
    ...(switchChannel ? { targetChannel: switchChannel } : {}),
    ...(check.lockstep ? { lockstep: check.lockstep } : {}),
    plugins,
  };
  // The install may have succeeded, but an upgrade whose migration is
  // blocked or could not run is not done, and neither is one whose plugin
  // step failed.
  const migrationFailed = upgraded.migration?.status === "blocked" || upgraded.migration?.status === "failed";
  const switchIncomplete =
    switchChannel !== undefined &&
    plugins.some(
      (p) =>
        p.channel !== undefined && (p.channel !== switchChannel || p.outcome === "deferred" || p.outcome === "skipped"),
    );
  return {
    mode: "upgrade",
    result,
    failed: migrationFailed || switchIncomplete || plugins.some((p) => p.outcome === "failed"),
  };
}
