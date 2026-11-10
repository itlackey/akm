// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Centralized path resolution for all akm directories.
 *
 * Provides platform-aware paths for config, cache, and stash directories,
 * following XDG Base Directory conventions on Unix and standard locations
 * on Windows.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { shortHash } from "./bundle-id";
import { ConfigError } from "./errors";
import { stripJsonComments } from "./jsonc";
import { IS_WINDOWS } from "./platform";
import { warnOnce } from "./warn";

/**
 * Returns true when the given path is in a directory family the OS may
 * reap (or that the user has clearly designated as a sandbox by virtue
 * of placing it under `/tmp` or a macOS per-user temp dir). Used by
 * `akm setup --dir <transient>` to keep its config and cache under that
 * directory (so a test harness's `akm setup --yes --dir .` cannot
 * silently clobber the user's `~/.config/akm/config.json`). See
 * the 2026-05-23 setup-clobbers-user-config incident
 * for the incident that motivated this.
 *
 * Both `/var/folders/*` and `/private/var/folders/*` are matched because
 * `os.tmpdir()` on macOS may return either form depending on whether the
 * caller has canonicalised the path (the realpath of `/var/folders` is
 * `/private/var/folders`, but `path.resolve()` does not follow symlinks).
 */
export function isTransientStashPath(p: string): boolean {
  return (
    p.startsWith("/tmp/") ||
    p === "/tmp" ||
    p.startsWith("/var/tmp/") ||
    p === "/var/tmp" ||
    p.startsWith("/private/tmp/") ||
    p.startsWith("/private/var/folders/") ||
    p.startsWith("/var/folders/")
  );
}

// ── Config file and directory ────────────────────────────────────────────────

/**
 * A configured bundle `path` as a directory: `~` or `~/...` expands to the home
 * folder; a relative path means the folder of the config file that holds it, never
 * the cwd. `undefined` when it cannot be placed: `~user/...`, or a relative path
 * with no config file to resolve against.
 */
export function resolveConfiguredBundlePath(configured: string, configFilePath?: string): string | undefined {
  if (configured === "~" || /^~[\\/]/.test(configured)) {
    return path.resolve(path.join(os.homedir(), configured.slice(1)));
  }
  if (configured.startsWith("~")) return undefined;
  if (path.isAbsolute(configured)) return path.resolve(configured);
  return configFilePath === undefined ? undefined : path.resolve(path.dirname(configFilePath), configured);
}

/**
 * The config file the installation was pointed at: `--config <file>` (the CLI assigns it to
 * `AKM_CONFIG_FILE` before anything else runs) or `AKM_CONFIG_FILE`, absolute. Credentials
 * and the config lock live beside it. `undefined` when none was chosen: the default file.
 */
function selectedConfigFile(env: NodeJS.ProcessEnv): string | undefined {
  const file = env.AKM_CONFIG_FILE?.trim();
  return file ? path.resolve(file) : undefined;
}

/** The variables that located an installation before `AKM_CONFIG_FILE` and the config file's `paths`. */
export const RETIRED_LOCATION_VARIABLES = {
  config: "AKM_CONFIG_DIR",
  data: "AKM_DATA_DIR",
  state: "AKM_STATE_DIR",
  cache: "AKM_CACHE_DIR",
} as const;

/** The variable that named the working bundle before `defaultBundle` and `--bundle` were the only ways. */
export const RETIRED_BUNDLE_VARIABLE = "AKM_BUNDLE_DIR";

/**
 * A retired variable that still places something is fatal: `AKM_CONFIG_DIR`, `AKM_DATA_DIR`, `AKM_STATE_DIR` or
 * `AKM_CACHE_DIR` set while `AKM_CONFIG_FILE` is not (ignoring it would open empty databases at the default locations),
 * or `AKM_BUNDLE_DIR` naming a directory other than the bundle akm resolves without it (ignoring it would work on a
 * different bundle than the host meant). `AKM_BUNDLE_DIR` naming that same bundle is ignored with no message: every
 * scheduler row akm 0.9.32 and 0.10 wrote inlines it, and hosts set it equal to `defaultBundle`. With
 * `AKM_CONFIG_FILE` set the installation is already named, so none of them is checked.
 *
 * Every location resolver below calls this first, so a library caller (`akm-cli/api`, `akm-cli/workspace`) gets the same
 * error as the CLI. `akm-migrate` (the executable `akm migrate` and `akm upgrade` run) is the one reader of these
 * variables: it carries them over first (`carryOverRetiredLocations`, `scripts/akm-migrate/`), so it never reaches this check.
 */
function assertNoRetiredLocationVariables(env: NodeJS.ProcessEnv): void {
  if (selectedConfigFile(env)) return;
  const named = Object.values(RETIRED_LOCATION_VARIABLES).find((name) => env[name]?.trim());
  if (named !== undefined) {
    throw new ConfigError(
      `${named} is no longer read. Run \`akm migrate apply\` (it moves the location into the config file's \`paths\`), then set AKM_CONFIG_FILE to the config file and unset ${named}.`,
      "RETIRED_LOCATION_VARIABLE",
    );
  }
  const bundleDir = env[RETIRED_BUNDLE_VARIABLE]?.trim();
  if (bundleDir && !isConfiguredWorkingBundle(bundleDir, env)) {
    throw new ConfigError(
      `${RETIRED_BUNDLE_VARIABLE} is no longer read, and it names ${path.resolve(bundleDir)}, which is not the bundle akm resolves without it. Run \`akm migrate apply\` (it registers that bundle as \`defaultBundle\` in the config file), then unset ${RETIRED_BUNDLE_VARIABLE}; pass \`--bundle <name>\` to work in another bundle.`,
      "RETIRED_LOCATION_VARIABLE",
    );
  }
}

/** The same directory, by resolved path or, when both exist, by real path. */
export function sameDirectory(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  if (a === b) return true;
  try {
    return fs.realpathSync.native(a) === fs.realpathSync.native(b);
  } catch {
    return false;
  }
}

/**
 * Whether `dir` is the working bundle the config file names: `defaultBundle`'s `path`, or its single component's root.
 * A raw read of the file, like `paths` below: the config module cannot load while a location is still being checked.
 * A missing or unreadable file, or no `defaultBundle`, names none.
 */
function isConfiguredWorkingBundle(dir: string, env: NodeJS.ProcessEnv): boolean {
  const file = selectedConfigFile(env) ?? path.join(unguardedConfigDir(env, process.platform), "config.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonComments(fs.readFileSync(file, "utf8")));
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null) return false;
  const { bundles, defaultBundle } = parsed as { bundles?: Record<string, unknown>; defaultBundle?: unknown };
  const bundle = typeof defaultBundle === "string" && bundles ? bundles[defaultBundle] : undefined;
  const raw =
    typeof bundle === "object" && bundle !== null ? (bundle as { path?: unknown; components?: unknown }) : undefined;
  if (typeof raw?.path !== "string" || !raw.path.trim()) return false;
  const bundlePath = resolveConfiguredBundlePath(raw.path.trim(), file);
  if (bundlePath === undefined) return false;
  if (sameDirectory(dir, bundlePath)) return true;
  const components = typeof raw.components === "object" && raw.components !== null ? Object.values(raw.components) : [];
  const root = (components[0] as { root?: unknown } | undefined)?.root;
  return typeof root === "string" && sameDirectory(dir, path.resolve(bundlePath, root));
}

export function getConfigDir(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string {
  assertNoRetiredLocationVariables(env);
  return unguardedConfigDir(env, platform);
}

function unguardedConfigDir(env: NodeJS.ProcessEnv, platform: string): string {
  const selected = selectedConfigFile(env);
  if (selected) return path.dirname(selected);

  if (platform === "win32") {
    const appData = env.APPDATA?.trim();
    if (appData) return path.join(appData, "akm");

    const userProfile = env.USERPROFILE?.trim();
    if (!userProfile) {
      throw new ConfigError(
        "Unable to determine config directory. Set APPDATA or USERPROFILE.",
        "CONFIG_DIR_UNRESOLVABLE",
      );
    }
    return path.join(userProfile, "AppData", "Roaming", "akm");
  }

  const xdgConfigHome = env.XDG_CONFIG_HOME?.trim();
  if (xdgConfigHome) return path.join(xdgConfigHome, "akm");

  const home = env.HOME?.trim();
  if (!home) {
    throw new ConfigError(
      "Unable to determine config directory. Set XDG_CONFIG_HOME or HOME.",
      "CONFIG_DIR_UNRESOLVABLE",
    );
  }
  return path.join(home, ".config", "akm");
}

export function getConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  assertNoRetiredLocationVariables(env);
  return selectedConfigFile(env) ?? path.join(getConfigDir(env), "config.json");
}

// ── Locations named by the config file's `paths` key ─────────────────────────

type ConfiguredLocation = "data" | "state" | "cache";

let cachedPaths:
  | { file: string; mtimeMs: number; size: number; resolved: Partial<Record<ConfiguredLocation, string>> }
  | undefined;

export function resetConfiguredPathsCache(): void {
  cachedPaths = undefined;
}

/**
 * `paths.data|state|cache` of the config file, read before the config module can load (a location must be
 * known to open anything): a raw parse, cached per file and mtime. A value is absolute, `~`, or relative to the
 * config file. One that cannot be placed is fatal, because it would move writes; an unset key is the default.
 * A missing, unreadable or unparseable file names nothing here: the config load reports it.
 */
function configuredLocation(kind: ConfiguredLocation, env: NodeJS.ProcessEnv): string | undefined {
  return locationNamedByFile(kind, env) ?? carriedLocations[kind];
}

/**
 * Locations a host named with a retired variable that the config file does not name yet. Only `akm-migrate` sets
 * them, for its own run: they stand in for the `paths` entry it writes (or, in `status` or with a file it cannot
 * write, would write), so every step reads the data, state and cache the host really uses.
 */
let carriedLocations: Partial<Record<ConfiguredLocation, string>> = {};

export function carryLocations(locations: Partial<Record<ConfiguredLocation, string>>): void {
  carriedLocations = { ...locations };
}

export function getCarriedLocations(): Readonly<Partial<Record<ConfiguredLocation, string>>> {
  return carriedLocations;
}

function locationNamedByFile(kind: ConfiguredLocation, env: NodeJS.ProcessEnv): string | undefined {
  let file: string;
  let stat: fs.Stats;
  try {
    file = getConfigPath(env);
    stat = fs.statSync(file);
  } catch {
    // No config file to read (or no home to find the default one under): the default location.
    return undefined;
  }
  if (
    !cachedPaths ||
    cachedPaths.file !== file ||
    cachedPaths.mtimeMs !== stat.mtimeMs ||
    cachedPaths.size !== stat.size
  ) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripJsonComments(fs.readFileSync(file, "utf8")));
    } catch {
      return undefined;
    }
    cachedPaths = { file, mtimeMs: stat.mtimeMs, size: stat.size, resolved: resolveConfiguredLocations(parsed, file) };
  }
  return cachedPaths.resolved[kind];
}

function resolveConfiguredLocations(parsed: unknown, file: string): Partial<Record<ConfiguredLocation, string>> {
  const raw = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>).paths : undefined;
  if (raw === undefined) return {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ConfigError(`"paths" in ${file} must be an object with data, state and cache.`, "INVALID_CONFIG_FILE");
  }
  const resolved: Partial<Record<ConfiguredLocation, string>> = {};
  for (const kind of ["data", "state", "cache"] as const) {
    const value = (raw as Record<string, unknown>)[kind];
    if (value === undefined) continue;
    const placed =
      typeof value === "string" && value.trim() ? resolveConfiguredBundlePath(value.trim(), file) : undefined;
    if (placed === undefined) {
      throw new ConfigError(
        `"paths.${kind}" in ${file} must be an absolute path, \`~/...\`, or a path relative to the config file.`,
        "INVALID_CONFIG_FILE",
      );
    }
    resolved[kind] = placed;
  }
  return resolved;
}

// ── Cache directory ──────────────────────────────────────────────────────────

export function getCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  assertNoRetiredLocationVariables(env);
  const configured = configuredLocation("cache", env);
  if (configured) return configured;

  if (IS_WINDOWS) {
    const localAppData = env.LOCALAPPDATA?.trim();
    if (localAppData) return path.join(localAppData, "akm");

    const userProfile = env.USERPROFILE?.trim();
    if (userProfile) return path.join(userProfile, "AppData", "Local", "akm");

    const appData = env.APPDATA?.trim();
    if (appData) {
      // Heuristic fallback: APPDATA points to %APPDATA% (Roaming), so
      // navigate to the sibling "Local" directory. This is typically
      // C:\Users\<name>\AppData\Roaming → C:\Users\<name>\AppData\Local\akm.
      // Preferred: set LOCALAPPDATA to avoid this navigation.
      return path.join(appData, "..", "Local", "akm");
    }
    throw new ConfigError(
      "Unable to determine cache directory. Set LOCALAPPDATA, USERPROFILE, or APPDATA.",
      "CONFIG_DIR_UNRESOLVABLE",
    );
  }

  const xdgCacheHome = env.XDG_CACHE_HOME?.trim();
  if (xdgCacheHome) return path.join(xdgCacheHome, "akm");

  const home = env.HOME?.trim();
  if (!home) return homelessFallbackDir("akm-cache");

  return path.join(home, ".cache", "akm");
}

/**
 * Last-resort directory when neither the XDG variable nor HOME is set.
 *
 * Scoped by uid. A fixed `/tmp/akm-<kind>` path is world-shared and entirely
 * predictable: on a multi-user host the first uid to run akm owns the
 * directory and every other user then reads and writes the same databases, and
 * any local user can pre-create the path (or a symlink at it) and wait. Adding
 * the uid gives each account its own path; the caller still creates it with
 * restrictive permissions.
 */
function homelessFallbackDir(kind: string): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  return path.join(os.tmpdir(), uid === undefined ? kind : `${kind}-${uid}`);
}

// ── Data directory ───────────────────────────────────────────────────────────

/**
 * Returns the XDG data directory for akm (`~/.local/share/akm` on Linux/macOS,
 * `%LOCALAPPDATA%\akm\data` on Windows).
 *
 * Holds durable, non-regenerable application data: SQLite databases
 * (`index.db`, `state.db`), `akm.lock`, and current data artifacts.
 * Losing this directory loses history and installed state.
 *
 * Where it lives (in priority order):
 *   `paths.data` in the config file
 *   XDG_DATA_HOME  — (Linux/macOS) override the XDG base; akm subdir is appended
 */
export function getDataDir(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string {
  assertNoRetiredLocationVariables(env);
  const configured = configuredLocation("data", env);
  if (configured) return configured;

  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA?.trim();
    if (localAppData) return path.join(localAppData, "akm", "data");

    const userProfile = env.USERPROFILE?.trim();
    if (userProfile) return path.join(userProfile, "AppData", "Local", "akm", "data");

    const appData = env.APPDATA?.trim();
    if (!appData) {
      throw new ConfigError(
        "Unable to determine data directory. Set LOCALAPPDATA, USERPROFILE, or APPDATA.",
        "CONFIG_DIR_UNRESOLVABLE",
      );
    }
    return path.join(appData, "..", "Local", "akm", "data");
  }

  const xdgDataHome = env.XDG_DATA_HOME?.trim();
  if (xdgDataHome) return path.join(xdgDataHome, "akm");

  const home = env.HOME?.trim();
  if (!home) return homelessFallbackDir("akm-data");

  return path.join(home, ".local", "share", "akm");
}

export function getDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(getDataDir(env), "index.db");
}

export function getIndexWriterLockPath(): string {
  return path.join(getDataDir(), "index.db.write.lock");
}

/**
 * Path to the opt-in, PID-liveness-only rebuild lock an explicit `akm index`
 * run acquires (#956). Distinct from {@link getIndexWriterLockPath}'s
 * `index.db.write.lock`, which is the asset-mutation lease and unrelated to
 * indexing since #872 — this lock never blocks and is never required, it
 * only lets a scheduled/opportunistic `akm index --skip-if-locked` step
 * aside instead of contending with a run already in progress.
 */
export function getIndexRebuildLockPath(): string {
  return path.join(getDataDir(), "index.rebuild.lock");
}

/** Path to the state.db file in $DATA. */
export function getStateDbPathInDataDir(): string {
  return path.join(getDataDir(), "state.db");
}

/** Path to the akm.lock file in $DATA. */
export function getLockfilePath(): string {
  return path.join(getDataDir(), "akm.lock");
}

/** Path to the akm.lock.lck write-sentinel in $DATA. */
export function getLockfileLockPath(): string {
  return path.join(getDataDir(), "akm.lock.lck");
}

export function getRegistryCacheDir(): string {
  return path.join(getCacheDir(), "registry");
}

export function getRegistryIndexCacheDir(): string {
  return path.join(getCacheDir(), "registry-index");
}

// ── State directory ──────────────────────────────────────────────────────────

/**
 * Returns the XDG state directory for akm (`~/.local/state/akm` on
 * Linux/macOS, `%LOCALAPPDATA%\akm\state` on Windows).
 *
 * Per-machine runtime state that is neither durable application data
 * (`$DATA`), a purely regenerable cache (`$CACHE`), nor state that must
 * travel with a bundle's own content (`$STASH/.akm`; see "What May Live in
 * $STASH/.akm" in docs/architecture/internals/storage-locations.md).
 *
 * Where it lives (in priority order):
 *   `paths.state` in the config file
 *   XDG_STATE_HOME — (Linux/macOS) override the XDG base; akm subdir is appended
 */
export function getStateDir(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string {
  assertNoRetiredLocationVariables(env);
  const configured = configuredLocation("state", env);
  if (configured) return configured;

  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA?.trim();
    if (localAppData) return path.join(localAppData, "akm", "state");

    const userProfile = env.USERPROFILE?.trim();
    if (userProfile) return path.join(userProfile, "AppData", "Local", "akm", "state");

    const appData = env.APPDATA?.trim();
    if (!appData) {
      throw new ConfigError(
        "Unable to determine state directory. Set LOCALAPPDATA, USERPROFILE, or APPDATA.",
        "CONFIG_DIR_UNRESOLVABLE",
      );
    }
    return path.join(appData, "..", "Local", "akm", "state");
  }

  const xdgStateHome = env.XDG_STATE_HOME?.trim();
  if (xdgStateHome) return path.join(xdgStateHome, "akm");

  const home = env.HOME?.trim();
  if (!home) return homelessFallbackDir("akm-state");

  return path.join(home, ".local", "state", "akm");
}

// ── Per-stash state under $STATE / $CACHE (itlackey/akm#890) ─────────────────

/**
 * Deterministic, filesystem-safe key for machine-local state that belongs to
 * one stash but must not live under `$STASH` itself. Namespaces `$STATE`/
 * `$CACHE` writers by the resolved absolute stash directory — the filesystem
 * counterpart of how `state.db`'s `proposals` table keys per-stash rows by
 * its `stash_dir` column — so two stashes on one machine never collide.
 *
 * Reuses {@link shortHash} (bundle-id.ts) rather than growing a second
 * sha256-truncated-hex helper. `shortHash` trims to 8 hex chars (32
 * bits) — fine at its original call site because a collision only ever
 * shortens a batch-unique slug suffix that a retry loop immediately
 * re-disambiguates. Here there is no such retry loop, but a machine
 * realistically has, at most, a handful to a few dozen distinct stash
 * directories ever registered — 32 bits of digest space makes an accidental
 * collision between two of them astronomically unlikely.
 */
export function getStashStateKey(stashDir: string): string {
  const resolved = path.resolve(stashDir).replace(/\\/g, "/");
  const normalized = IS_WINDOWS ? resolved.toLowerCase() : resolved;
  return shortHash(normalized);
}

function stashScopedDir(base: string, stashDir: string): string {
  return path.join(base, getStashStateKey(stashDir));
}

/**
 * `$CACHE/index/unresolved-sources/<stash>/` — synthetic placeholder path for
 * a configured source whose content root did not resolve this run. Never
 * written to disk; only used as a stable, reportable `SearchSource.path`.
 * Moved out of `$STASH/.akm/unresolved-sources/` (itlackey/akm#890).
 */
export function getUnresolvedSourcesDir(stashDir: string): string {
  return stashScopedDir(path.join(getCacheDir(), "index", "unresolved-sources"), stashDir);
}

/**
 * `$STATE/locks/<stash>/` — per-stash operational lock files for the improve
 * pipeline (e.g. `improve.lock`). Moved out of `$STASH/.akm/` (itlackey/akm#890).
 */
export function getStashLocksDir(stashDir: string): string {
  return stashScopedDir(path.join(getStateDir(), "locks"), stashDir);
}

/**
 * The environment of a process akm starts for the user: akm's own, as the program
 * has it when the user runs it from their shell, with `AKM_CONFIG_FILE` set over it
 * so a child that runs `akm` (an exec unit, an agent CLI) uses the same installation
 * even when the parent found it through `--config`, `XDG_*_HOME`, or a runtime that
 * remaps them. The file is absolute: it names the other locations (its `paths` key)
 * and the working bundle (`defaultBundle`). akm filters nothing.
 */
export function childProcessEnv(): Record<string, string> {
  const inherited: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined) inherited[name] = value;
  }
  return { ...inherited, AKM_CONFIG_FILE: getConfigPath() };
}

// ── Scheduled-task runtime directory (logs; run history lives in state.db) ───

export function getTaskLogDir(): string {
  return path.join(getCacheDir(), "tasks", "logs");
}

/** Per-run `akm improve` / `akm index` log files: flat `<ISO>.log` files under `$CACHE/logs/<kind>`. */
export function getRunLogDir(kind: "improve" | "index"): string {
  return path.join(getCacheDir(), "logs", kind);
}

// ── Default stash directory ──────────────────────────────────────────────────

/** Where a new bundle is created when nothing says otherwise: `~/akm`. Never read as the working bundle. */
export function getDefaultStashDir(env: NodeJS.ProcessEnv = process.env): string {
  if (IS_WINDOWS) {
    const userProfile = env.USERPROFILE?.trim();
    if (userProfile) return path.join(userProfile, "Documents", "akm");
    return path.join("C:\\", "akm");
  }

  const home = env.HOME?.trim();
  if (!home) {
    throw new ConfigError("Unable to determine default bundle directory. Set HOME.", "STASH_DIR_NOT_FOUND");
  }
  return path.join(home, "akm");
}

// ── Stash directory safety check (#473) ──────────────────────────────────────

/**
 * Refuse stashDir values that would clobber a sensitive system path or the
 * user's home directory itself. Called from `akm init`, `akm setup`, and the
 * setup-wizard validator before any disk write.
 *
 * Refuses:
 *   - The filesystem root (`/` or Windows drive root `C:\`)
 *   - Common system roots (`/etc`, `/var`, `/usr`, `/usr/local`, `/opt`,
 *     `/sys`, `/proc`, `/boot`, `/bin`, `/sbin`, `/lib`, `/lib64`, `/dev`,
 *     `/run`, `/home`, `/root`, `/mnt`, `/media`,
 *     `/Library`, `/System`, `/Applications`)
 *   - The user's home directory itself (exact match — subdirs are fine)
 *   - User-data dotfile parents: `~/.config`, `~/.local`, `~/.cache`,
 *     `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.kube`, `~/.docker`,
 *     and the macOS/Windows `~/Documents` and `~/Downloads` parents
 *
 * Subdirectories of any refused path are allowed (so `~/.local/share/akm-test`
 * is fine even though `~/.local` is refused). This catches fat-finger
 * `--dir /` or `--dir ~` without preventing legitimate nested use.
 */
export function assertSafeStashDir(stashDir: string, env: NodeJS.ProcessEnv = process.env): void {
  const resolved = path.resolve(stashDir);

  // Filesystem root — POSIX and Windows drive roots.
  if (resolved === "/" || /^[A-Za-z]:[\\/]?$/.test(resolved)) {
    throw new ConfigError(
      `Refusing stashDir at filesystem root (${resolved}). Pick a subdirectory like ~/akm.`,
      "UNSAFE_STASH_DIR",
    );
  }

  // System directories — exact match only.
  const SYSTEM_ROOTS = new Set([
    "/etc",
    "/var",
    "/usr",
    "/usr/local",
    "/opt",
    "/sys",
    "/proc",
    "/boot",
    "/bin",
    "/sbin",
    "/lib",
    "/lib64",
    "/dev",
    "/run",
    "/home",
    "/root",
    "/mnt",
    "/media",
    "/Library",
    "/System",
    "/Applications",
  ]);
  if (SYSTEM_ROOTS.has(resolved)) {
    throw new ConfigError(
      `Refusing stashDir at system path (${resolved}). Pick a path inside your home directory.`,
      "UNSAFE_STASH_DIR",
    );
  }

  if (resolved === "/var/tmp") {
    warnOnce(
      "stash-dir:var-tmp",
      `Stash directory is at ${resolved}, a shared scratch directory system cleanup jobs may periodically empty; using it as configured.`,
    );
  }

  // User home — exact match only. Subdirs (~/akm, ~/work/stash) are fine.
  // Check BOTH the env-controlled home and the OS-reported home, so the
  // refusal can't be bypassed by unsetting HOME, and so it still fires
  // under bun test (which isolates HOME to a tempdir while os.homedir()
  // still returns the real user's home).
  const candidateHomes = new Set<string>();
  const envHome = (env.HOME ?? env.USERPROFILE)?.trim();
  if (envHome) candidateHomes.add(path.resolve(envHome));
  try {
    const osHome = os.homedir();
    if (osHome) candidateHomes.add(path.resolve(osHome));
  } catch {
    // os.homedir() can throw on misconfigured systems; ignore.
  }

  const CREDENTIAL_USER_PARENTS = [".config", ".local", ".cache", ".ssh", ".gnupg", ".aws", ".kube", ".docker"];
  const PLAIN_USER_DATA_PARENTS = ["Documents", "Downloads", "AppData"];

  for (const home of candidateHomes) {
    if (resolved === home) {
      throw new ConfigError(
        `Refusing stashDir at your home directory (${resolved}). Pick a subdirectory like ~/akm.`,
        "UNSAFE_STASH_DIR",
      );
    }
    for (const sub of CREDENTIAL_USER_PARENTS) {
      if (resolved === path.join(home, sub)) {
        throw new ConfigError(
          `Refusing stashDir at sensitive user directory (${resolved}). Pick a subdirectory or a dedicated workspace.`,
          "UNSAFE_STASH_DIR",
        );
      }
    }
    for (const sub of PLAIN_USER_DATA_PARENTS) {
      if (resolved === path.join(home, sub)) {
        warnOnce(
          `stash-dir:plain-user-data:${sub}`,
          `Stash directory is at ${resolved}, your ${sub} folder; using it as configured, though it is usually a large, unrelated-content directory to index.`,
        );
      }
    }
  }
}
