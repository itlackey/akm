// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** The OpenCode half of `akm upgrade`'s plugin refresh: config and cache detection, the npm lookup, the re-fetch, and which plugin each run targets. */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { IS_WINDOWS, parseJsonc, toErrorMessage, tryParseJson } from "../../core/common";
import { moveToTrash } from "../../core/trash";
import {
  OPENCODE_V1,
  OPENCODE_V2,
  type OpenCodeFlavor,
  readPackageVersion,
} from "../../integrations/harnesses/opencode/plugin-layout";
import { opencodeCacheDir, opencodeConfigDir } from "../../integrations/harnesses/opencode/roots";
import { detectOpencodeMajor, OPENCODE_BIN, resolveOpencodeBin } from "../../integrations/harnesses/opencode/version";
import type { PluginUpgradeEntry, UpgradeChannel } from "../../sources/types";
import { editChannelJson, writeChannelEdits } from "./plugin-channels";
import {
  channelWriteFailure,
  failed,
  PREFETCH_TIMEOUT_MS,
  READ_TIMEOUT_MS,
  runCommand,
  skipped,
} from "./plugin-upgrade-commands";

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

interface OpenCodeConfigSpec {
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
      // asset-io: install
      text = fs.readFileSync(file, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") continue;
      return { error: `could not read ${file}: ${toErrorMessage(error)}` };
    }
    let config: Record<string, unknown>;
    try {
      const parsed = parseJsonc(text);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not a JSON object");
      config = parsed as Record<string, unknown>;
    } catch (error) {
      return { error: `could not parse ${file}: ${toErrorMessage(error)}` };
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
    // asset-io: install
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
  // asset-io: install
  if (!fs.existsSync(dir)) return undefined;
  const nodeModules = flavor.nodeModulesDir(dir);
  return { dir, version: nodeModules && readPackageVersion(path.join(nodeModules, flavor.pkg, "package.json")) };
}

/** What npm's `<pkg>@<tag>` is. */
export function lookupOpenCodeLatest(tag: UpgradeChannel, flavor: OpenCodeFlavor): OpenCodeLatest {
  const spec = `${flavor.pkg}@${tag}`;
  const view = runCommand(IS_WINDOWS ? "npm.cmd" : "npm", ["view", spec, "version", "--json"], READ_TIMEOUT_MS);
  if (!view.ok) return { error: view.error };
  const parsed = tryParseJson(view.stdout) as { version?: unknown } | string | undefined;
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
    // asset-io: host process table
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
    // asset-io: host process table
    return fs.readdirSync("/proc").some((pid) => {
      if (!/^\d+$/.test(pid) || Number(pid) === process.pid) return false;
      try {
        // asset-io: host process table
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

export function upgradeOpenCode(dryRun: boolean, target: OpenCodeTarget): PluginUpgradeEntry {
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
  // asset-io: install
  if (flavor.replacesCache && fs.existsSync(cache.dir)) {
    try {
      moveToTrash(cache.dir);
    } catch (error) {
      return {
        ...failed(harness, `could not move ${cache.dir} to the trash: ${toErrorMessage(error)}`),
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
    // asset-io: install
    fs.rmSync(workDir, { recursive: true, force: true });
  }
  const after = detectOpenCodeCache(tag, flavor);
  if (!after) return { ...failed(harness, `opencode did not re-create the plugin cache${trashed}`), backups };
  return { ...base, outcome: "updated", to: after.version ?? latest.version, ...(backups.length ? { backups } : {}) };
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
export function resolveOpenCodeTargets(next: boolean, channel?: UpgradeChannel): OpenCodeTarget[] {
  const resolve = (flavor: OpenCodeFlavor, configured: OpenCodeConfigSpec | { error: string } | undefined) =>
    configured && "error" in configured
      ? unreadableTarget(flavor, configured.error, next)
      : resolveOpenCodeTarget(next, flavor, configured, channel);
  const targets = [resolve(OPENCODE_V1, openCodeConfigSpec(OPENCODE_V1))];
  const v2 = openCodeConfigSpec(OPENCODE_V2);
  if ((v2 && !("error" in v2)) || openCodeV2Cached()) targets.push(resolve(OPENCODE_V2, v2));
  return targets;
}
