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
import { IS_WINDOWS } from "../../core/common";
import { moveToTrash } from "../../core/trash";
import { semverOrder } from "../../runtime";
import type { PluginUpgradeEntry, UpgradeCheckResponse, UpgradeLockstep, UpgradeResponse } from "../../sources/types";

const MARKETPLACE = "akm-plugins";
const PLUGIN_ID = `akm@${MARKETPLACE}`;
const OPENCODE_PACKAGE = "akm-opencode";
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

/** Pending, in `--check`: the marketplace is only refreshed by a real upgrade, so whether a newer build exists is not known yet. */
function pendingRefresh(harness: PluginUpgradeEntry["harness"], from: string | undefined): PluginUpgradeEntry {
  return {
    harness,
    outcome: "pending",
    from,
    message: "the akm-plugins marketplace is refreshed by `akm upgrade`; --check does not fetch it",
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
  if (dryRun) return pendingRefresh("claude-code", detected.version);
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
  if (dryRun) return pendingRefresh("codex", before.version);
  // Also refreshes the installed plugin's cache, so no re-add is needed.
  const upgrade = runCommand("codex", ["plugin", "marketplace", "upgrade", MARKETPLACE], REFRESH_TIMEOUT_MS);
  if (!upgrade.ok) return failed("codex", upgrade.error);
  const after = codexPluginVersion();
  return refreshed("codex", before.version, "version" in after ? after.version : undefined);
}

// ── OpenCode ────────────────────────────────────────────────────────────────

export interface OpenCodeCache {
  dir: string;
  version: string | undefined;
}

export type OpenCodeLatest = { version: string; akmCli: string | undefined } | { error: string };

/** The cached `akm-opencode` OpenCode installed on first use, or undefined when there is none. */
export function detectOpenCodeCache(): OpenCodeCache | undefined {
  const cacheHome =
    process.env.XDG_CACHE_HOME?.trim() ||
    path.join(process.env.HOME?.trim() || process.env.USERPROFILE?.trim() || os.homedir(), ".cache");
  const dir = path.join(cacheHome, "opencode", "packages", `${OPENCODE_PACKAGE}@latest`);
  if (!fs.existsSync(dir)) return undefined;
  const readVersion = (file: string): string | undefined => {
    try {
      const pkg = JSON.parse(fs.readFileSync(file, "utf8")) as { version?: unknown };
      return typeof pkg.version === "string" ? pkg.version : undefined;
    } catch {
      return undefined;
    }
  };
  return { dir, version: readVersion(path.join(dir, "node_modules", OPENCODE_PACKAGE, "package.json")) };
}

/** What npm's `akm-opencode@latest` is, and which akm-cli it pins. */
export function lookupOpenCodeLatest(): OpenCodeLatest {
  const view = runCommand(
    IS_WINDOWS ? "npm.cmd" : "npm",
    ["view", `${OPENCODE_PACKAGE}@latest`, "version", "dependencies.akm-cli", "--json"],
    READ_TIMEOUT_MS,
  );
  if (!view.ok) return { error: view.error };
  const parsed = parseJson(view.stdout) as { version?: unknown; "dependencies.akm-cli"?: unknown } | undefined;
  if (typeof parsed?.version !== "string") return { error: "npm did not report a version for akm-opencode@latest" };
  const akmCli = parsed["dependencies.akm-cli"];
  return { version: parsed.version, akmCli: typeof akmCli === "string" ? akmCli : undefined };
}

/** Whether an OpenCode process is running (its prefetch would be replaced under it). `undefined` when that cannot be told. */
function openCodeRunning(): boolean | undefined {
  if (IS_WINDOWS) {
    const tasks = runCommand("tasklist", ["/FI", "IMAGENAME eq opencode.exe", "/NH"], READ_TIMEOUT_MS);
    return tasks.ok ? /opencode\.exe/i.test(tasks.stdout) : undefined;
  }
  // `-f` because a Node-wrapped opencode shows up as `node …/opencode`; the
  // pattern needs `opencode` to be a whole path segment so `akm-opencode`
  // in some other command's arguments does not match.
  const pgrep = runCommand("pgrep", ["-f", "(^|/)opencode( |$)"], READ_TIMEOUT_MS);
  if (pgrep.ok) return true;
  if (!pgrep.missing) return false; // pgrep exits 1 when nothing matched
  if (process.platform !== "linux") return undefined;
  try {
    return fs.readdirSync("/proc").some((pid) => {
      if (!/^\d+$/.test(pid) || Number(pid) === process.pid) return false;
      try {
        const argv = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
        return argv.slice(0, 2).some((arg) => path.basename(arg) === "opencode");
      } catch {
        return false;
      }
    });
  } catch {
    return undefined;
  }
}

function upgradeOpenCode(
  dryRun: boolean,
  cache: OpenCodeCache | undefined,
  latest: OpenCodeLatest | undefined,
): PluginUpgradeEntry {
  if (!cache || !latest) return skipped("opencode", "no cached akm-opencode plugin");
  if ("error" in latest) return failed("opencode", latest.error);
  if (cache.version === latest.version)
    return { harness: "opencode", outcome: "current", from: cache.version, to: latest.version };
  const base = { harness: "opencode" as const, from: cache.version, to: latest.version };
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
  // OpenCode must be runnable before the cache goes: it does the prefetch.
  const probe = runCommand("opencode", ["--version"], READ_TIMEOUT_MS);
  if (!probe.ok) return skipped("opencode", probe.missing ? "opencode is not on PATH" : probe.error);
  try {
    moveToTrash(cache.dir);
  } catch (error) {
    return failed(
      "opencode",
      `could not move ${cache.dir} to the trash: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  // Any OpenCode command that resolves the config installs the plugin again;
  // from a temp dir, so no project's opencode.json is read.
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-opencode-prefetch-"));
  try {
    const prefetch = runCommand("opencode", ["debug", "config"], PREFETCH_TIMEOUT_MS, { cwd: workDir });
    if (!prefetch.ok) return failed("opencode", `${prefetch.error} (the old cache is in the trash)`);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
  const after = detectOpenCodeCache();
  if (!after) return failed("opencode", "opencode did not re-create the plugin cache (the old cache is in the trash)");
  return { ...base, outcome: "updated", to: after.version ?? latest.version };
}

// ── Orchestration ───────────────────────────────────────────────────────────

export function upgradePlugins(opts: {
  dryRun: boolean;
  openCode: { cache: OpenCodeCache | undefined; latest: OpenCodeLatest | undefined };
}): PluginUpgradeEntry[] {
  return [
    upgradeClaudeCode(opts.dryRun),
    upgradeCodex(opts.dryRun),
    upgradeOpenCode(opts.dryRun, opts.openCode.cache, opts.openCode.latest),
  ];
}

/**
 * When the OpenCode plugin is present the CLI target is the akm-cli that
 * `akm-opencode@latest` pins, not the newest release: the plugin runs that
 * exact akm in-process, against databases a newer CLI may already have
 * migrated. The CLI never moves backwards, and a plugin lookup that failed
 * leaves the target alone (the failure is on the OpenCode entry).
 */
export function applyLockstep<T extends UpgradeCheckResponse>(
  check: T,
  latest: OpenCodeLatest | undefined,
): T & { lockstep?: UpgradeLockstep } {
  if (!latest || "error" in latest || !latest.akmCli) return check;
  const pinned = latest.akmCli;
  // Held back only when the pin is below a release this upgrade would install.
  const heldBack =
    semverOrder(pinned, check.latestVersion) < 0 && semverOrder(check.currentVersion, check.latestVersion) < 0;
  const lockstep: UpgradeLockstep = {
    plugin: OPENCODE_PACKAGE,
    pinnedVersion: pinned,
    newestVersion: check.latestVersion,
    heldBack,
  };
  if (!heldBack) return { ...check, lockstep };
  // The CLI never moves backwards to meet the pin.
  return {
    ...check,
    latestVersion: pinned,
    updateAvailable: semverOrder(check.currentVersion, pinned) < 0,
    lockstep,
  };
}

export interface UpgradeRunDependencies {
  checkForUpdate: (currentVersion: string) => Promise<UpgradeCheckResponse>;
  performUpgrade: (
    check: UpgradeCheckResponse,
    opts: { force: boolean; skipPostUpgrade: boolean },
  ) => Promise<UpgradeResponse>;
}

export type UpgradeRunResult =
  | { mode: "check"; result: UpgradeCheckResponse & { plugins: PluginUpgradeEntry[] } }
  | { mode: "upgrade"; result: UpgradeResponse & { plugins: PluginUpgradeEntry[] }; failed: boolean };

/** `akm upgrade`: the CLI step (held to the OpenCode plugin's akm), then the plugins. */
export async function runUpgrade(
  args: { check: boolean; force: boolean; skipPostUpgrade: boolean },
  currentVersion: string,
  deps: UpgradeRunDependencies,
): Promise<UpgradeRunResult> {
  const cache = detectOpenCodeCache();
  const latest = cache ? lookupOpenCodeLatest() : undefined;
  const check = applyLockstep(await deps.checkForUpdate(currentVersion), latest);
  const openCode = { cache, latest };
  if (args.check) {
    return { mode: "check", result: { ...check, plugins: upgradePlugins({ dryRun: true, openCode }) } };
  }
  const upgraded = await deps.performUpgrade(check, { force: args.force, skipPostUpgrade: args.skipPostUpgrade });
  const plugins = upgradePlugins({ dryRun: false, openCode });
  const result = { ...upgraded, ...(check.lockstep ? { lockstep: check.lockstep } : {}), plugins };
  // The install may have succeeded, but an upgrade whose migration is
  // blocked or could not run is not done, and neither is one whose plugin
  // step failed.
  const migrationFailed = upgraded.migration?.status === "blocked" || upgraded.migration?.status === "failed";
  return { mode: "upgrade", result, failed: migrationFailed || plugins.some((p) => p.outcome === "failed") };
}
