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

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { toErrorMessage, tryParseJson } from "../../core/common";
import { UsageError } from "../../core/errors";
import { isExactSemver } from "../../registry/semver";
import { semverOrder } from "../../runtime";
import type { PluginUpgradeEntry, UpgradeChannel, UpgradeCheckResponse, UpgradeResponse } from "../../sources/types";
import { collectPluginStalenessAdvisories } from "../health/plugin-staleness";
import { claudeChannelEdits, codexChannelEdit, codexMarketplace, writeChannelEdits } from "./plugin-channels";
import {
  type CommandFailure,
  channelWriteFailure,
  failed,
  marketplaceReader,
  READ_TIMEOUT_MS,
  REFRESH_TIMEOUT_MS,
  refreshed,
  runCommand,
  skipped,
} from "./plugin-upgrade-commands";
import { type OpenCodeTarget, resolveOpenCodeTargets, upgradeOpenCode } from "./plugin-upgrade-opencode";
import { installedChannel } from "./self-update";

const MARKETPLACE = "akm-plugins";
const PLUGIN_NAME = "akm";
const PLUGIN_ID = `${PLUGIN_NAME}@${MARKETPLACE}`;

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
    return unknown(toErrorMessage(error));
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
  const plugins = tryParseJson(listed.stdout);
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
    // asset-io: install
    const configured = fs.existsSync(path.join(claudePluginsRoot(), "known_marketplaces.json"));
    return {
      entry:
        !marketplaces.missing || configured
          ? { ...failed("claude-code", marketplaces.error), channel: "unknown" }
          : skipped("claude-code", "claude is not on PATH"),
    };
  }
  const list = tryParseJson(marketplaces.stdout);
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
      backups = writeChannelEdits(
        claudeChannelEdits(
          claudeConfigDir(),
          claudePluginsRoot(),
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
  const parsed = tryParseJson(listed.stdout) as
    | { installed?: Array<{ pluginId?: string; version?: string }> }
    | undefined;
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
    return { error: `could not read ${file}: ${toErrorMessage(error)}` };
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
    // asset-io: install
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
 * The newest akm plugin build on `channel` of the marketplace at `source`: the version its catalog names. Only the
 * catalog and the plugin manifest are read, from a blobless clone with nothing checked out, so the channel's other
 * files are never downloaded. The real channel switch, `akm upgrade --check` and `akm health` all read it here.
 */
export function marketplaceTargetVersion(source: string, channel: UpgradeChannel, harness: "claude" | "codex"): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akm-channel-check-"));
  const checkout = path.join(root, "marketplace");
  try {
    const show = marketplaceReader(source, channel, checkout);
    const manifestDir = harness === "codex" ? ".codex-plugin" : ".claude-plugin";
    const catalogFile = harness === "codex" ? ".agents/plugins/marketplace.json" : ".claude-plugin/marketplace.json";
    const catalogText = show(catalogFile);
    if (!catalogText.ok) throw new UsageError(`Could not read the marketplace catalog: ${catalogText.error}`);
    const catalog = tryParseJson(catalogText.stdout) as
      | {
          plugins?: Array<{
            name?: string;
            source?: string | { source?: string; path?: string; url?: string; ref?: string };
            version?: string;
          }>;
        }
      | undefined;
    const plugin = catalog?.plugins?.find((p) => p.name === PLUGIN_NAME);
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
        ? (tryParseJson(manifest.stdout) as { version?: unknown } | undefined)?.version
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
    // asset-io: install
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
}

function claudePluginsRoot(): string {
  return (
    process.env.AKM_CLAUDE_PLUGINS_DIR ??
    process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR ??
    path.join(claudeConfigDir(), "plugins")
  );
}

/** The Git source and ref Claude has registered for a marketplace. */
export function claudeMarketplace(
  pluginsRoot: string,
  marketplace = MARKETPLACE,
): { source: string; ref: string | undefined } {
  // asset-io: install
  const known = tryParseJson(fs.readFileSync(path.join(pluginsRoot, "known_marketplaces.json"), "utf8")) as Record<
    string,
    { source: { source: string; repo?: string; url?: string; path?: string; ref?: string } }
  >;
  const registered = known[marketplace]?.source;
  const url =
    registered?.source === "github" && registered.repo
      ? `https://github.com/${registered.repo}.git`
      : registered?.source === "directory"
        ? registered.path
        : registered?.url;
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

interface MarketplacePlan {
  target: string | Error;
  keep?: Kept;
}

/**
 * What moving one marketplace plugin to `channel` does, read without changing anything: the build the channel's branch
 * of the registered `source` offers (or why it could not be read), and, unless a downgrade is allowed, the installed
 * version that switch leaves alone because the channel has nothing newer. The real switch and `--check` both decide
 * from this.
 */
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
      claudeConfigDir(),
      pluginsRoot,
      channel,
      claude.installations.flatMap((p) => (p.projectPath ? [p.projectPath] : [])),
    );
    plans.claude = marketplacePlan(
      "claude-code",
      claudeMarketplace(pluginsRoot).source,
      claude.installations.map((p) => p.version),
      channel,
      allowDowngrade,
    );
  }
  const codex = codexPluginVersion();
  // asset-io: install
  if ("error" in codex && (!codex.error.missing || fs.existsSync(codexConfigFile())))
    throw new UsageError(`Could not inventory Codex before switching channels: ${codex.error.error}`);
  if (!("error" in codex) && codex.version !== undefined) {
    const registered = codexMarketplaceEntry();
    if ("error" in registered)
      throw new UsageError(`Could not inventory Codex before switching channels: ${registered.error}`);
    codexChannelEdit(codexConfigFile(), channel);
    plans.codex = marketplacePlan(
      "codex",
      codexMarketplaceRegistration().source,
      [codex.version],
      channel,
      allowDowngrade,
    );
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
