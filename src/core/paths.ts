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

import os from "node:os";
import path from "node:path";
import { IS_WINDOWS } from "./common";
import { ConfigError } from "./errors";

/**
 * Returns true when the current process appears to be running under
 * `bun test` (either via the BUN_TEST sentinel Bun sets on the test
 * worker, or via the conventional NODE_ENV=test).
 *
 * Used by getDataDir to enforce that every test which resolves a data
 * directory ALSO sets XDG_DATA_HOME (or the AKM_DATA_DIR override) to a
 * temp directory. Without that pairing, tests silently write SQLite
 * databases, lockfiles, and task history into the developer's real
 * `~/.local/share/akm`.
 */
function isUnderBunTest(env: NodeJS.ProcessEnv): boolean {
  return env.BUN_TEST === "1" || env.NODE_ENV === "test";
}

/**
 * Returns true when the given path is in a directory family the OS may
 * reap (or that the user has clearly designated as a sandbox by virtue
 * of placing it under `/tmp` or a macOS per-user temp dir). Used to
 * decide whether `AKM_STASH_DIR=$tmpdir` should also isolate config +
 * cache writes (so a test harness's `akm setup --yes --dir .` cannot
 * silently clobber the user's `~/.config/akm/config.json`). See
 * `docs/technical/incidents/2026-05-23-setup-clobbers-user-config.md`
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

/**
 * Build a TEST_ISOLATION_MISSING ConfigError describing which env var(s)
 * must be set so the data path resolves into a temp dir instead of the
 * user's real XDG home.
 */
function testIsolationError(): ConfigError {
  return new ConfigError(
    "Refusing to resolve data directory under bun test: neither XDG_DATA_HOME nor AKM_DATA_DIR is set. " +
      "This guards against tests writing into the developer's real ~/.local/share/akm. " +
      "Set XDG_DATA_HOME (or AKM_DATA_DIR) to a mktemp-d directory in this test's env block.",
    "TEST_ISOLATION_MISSING",
  );
}

// ── Config directory ─────────────────────────────────────────────────────────

export function getConfigDir(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string {
  const override = env.AKM_CONFIG_DIR?.trim();
  if (override) return override;

  // Explicit XDG override wins next — tests and operators that pre-arrange
  // an isolated config dir via XDG_CONFIG_HOME (or %APPDATA% on Windows)
  // must be honored as set, so the AKM_STASH_DIR transient-isolation rule
  // below does not silently move config away from where they pointed it.
  if (platform === "win32") {
    const appData = env.APPDATA?.trim();
    if (appData) return path.join(appData, "akm");
  } else {
    const xdgConfigHome = env.XDG_CONFIG_HOME?.trim();
    if (xdgConfigHome) return path.join(xdgConfigHome, "akm");
  }

  // Isolation safety: when AKM_STASH_DIR points at a transient/sandbox path
  // (/tmp, /var/tmp, /private/var/folders) AND no explicit config dir
  // override is set, route config writes into `${AKM_STASH_DIR}/.akm`
  // instead of the user's host ~/.config/akm. This prevents the documented
  // isolation pattern
  //   AKM_DATA_DIR=/tmp/x AKM_STASH_DIR=/tmp/x akm setup --yes --dir .
  // from silently clobbering the host config. See
  // docs/technical/incidents/2026-05-23-setup-clobbers-user-config.md for the incident.
  // Daily users with a persistent AKM_STASH_DIR=~/my-stash are unaffected.
  const stashOverride = env.AKM_STASH_DIR?.trim();
  if (stashOverride && isTransientStashPath(stashOverride)) {
    return path.join(stashOverride, ".akm");
  }

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
  return path.join(getConfigDir(env), "config.json");
}

// ── Cache directory ──────────────────────────────────────────────────────────

export function getCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.AKM_CACHE_DIR?.trim();
  if (override) return override;

  // Explicit XDG/platform overrides win before the transient-stash isolation
  // rule below — tests and operators that pre-arrange XDG_CACHE_HOME (or
  // %LOCALAPPDATA% / %USERPROFILE% / %APPDATA% on Windows) must be honored
  // as set, so the AKM_STASH_DIR transient rule does not silently move cache
  // writes away from where they pointed them.
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
  } else {
    const xdgCacheHome = env.XDG_CACHE_HOME?.trim();
    if (xdgCacheHome) return path.join(xdgCacheHome, "akm");
  }

  // Isolation safety (mirrors getConfigDir): when AKM_STASH_DIR points at a
  // transient path AND no explicit cache override is set, route cache writes
  // into `${AKM_STASH_DIR}/.akm/cache` so that config backups, registry-index
  // cache, and other regenerable artifacts do not pollute the user's host
  // ~/.cache/akm directory.
  const stashOverride = env.AKM_STASH_DIR?.trim();
  if (stashOverride && isTransientStashPath(stashOverride)) {
    return path.join(stashOverride, ".akm", "cache");
  }

  if (IS_WINDOWS) {
    // None of LOCALAPPDATA / USERPROFILE / APPDATA were set above.
    throw new ConfigError(
      "Unable to determine cache directory. Set LOCALAPPDATA, USERPROFILE, or APPDATA.",
      "CONFIG_DIR_UNRESOLVABLE",
    );
  }

  const home = env.HOME?.trim();
  if (!home) return path.join("/tmp", "akm-cache");

  return path.join(home, ".cache", "akm");
}

// ── Data directory ───────────────────────────────────────────────────────────

/**
 * Returns the XDG data directory for akm (`~/.local/share/akm` on Linux/macOS,
 * `%LOCALAPPDATA%\akm\data` on Windows).
 *
 * Holds durable, non-regenerable application data: SQLite databases
 * (index.db, workflow.db, state.db), akm.lock, and config-backups.
 * Losing this directory loses history and installed state.
 *
 * Env overrides (in priority order):
 *   AKM_DATA_DIR   — point to any directory
 *   XDG_DATA_HOME  — (Linux/macOS) override the XDG base; akm subdir is appended
 */
export function getDataDir(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string {
  const override = env.AKM_DATA_DIR?.trim();
  if (override) return override;

  // Defense-in-depth: under `bun test`, refuse to fall through to the
  // user's real $XDG_DATA_HOME / ~/.local/share/akm under any condition.
  // Any test that needs a data dir must point it at a mktemp-d directory
  // via XDG_DATA_HOME (or AKM_DATA_DIR). The previous carve-out that only
  // fired when AKM_STASH_DIR was set was a loophole: tests calling
  // openDatabase() or getDbPath() without overriding any env var silently
  // wrote into ~/.local/share/akm/index.db (observed: 4,183-row
  // registry-cache pollution). Item 5 of the 0.8.x critical-review plan.
  if (isUnderBunTest(env) && !env.XDG_DATA_HOME?.trim()) {
    throw testIsolationError();
  }

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
  if (!home) return path.join("/tmp", "akm-data");

  return path.join(home, ".local", "share", "akm");
}

export function getDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(getDataDir(env), "index.db");
}

export function getIndexWriterLockPath(): string {
  return path.join(getDataDir(), "index.db.write.lock");
}

export function getWorkflowDbPath(): string {
  return path.join(getDataDir(), "workflow.db");
}

/** Path to the state.db file in $DATA. */
export function getStateDbPathInDataDir(): string {
  return path.join(getDataDir(), "state.db");
}

/** Path for the task history directory in $DATA. */
export function getTaskHistoryStateDir(): string {
  return path.join(getDataDir(), "tasks", "history");
}

/** Path to the akm.lock file in $DATA. */
export function getLockfilePath(): string {
  return path.join(getDataDir(), "akm.lock");
}

/** Path to the akm.lock.lck write-sentinel in $DATA. */
export function getLockfileLockPath(): string {
  return path.join(getDataDir(), "akm.lock.lck");
}

export function getSemanticStatusPath(): string {
  return path.join(getCacheDir(), "semantic-status.json");
}

export function getRegistryCacheDir(): string {
  return path.join(getCacheDir(), "registry");
}

export function getRegistryIndexCacheDir(): string {
  return path.join(getCacheDir(), "registry-index");
}

export function getBinDir(): string {
  return path.join(getCacheDir(), "bin");
}

// ── Scheduled-task runtime directories (logs + history) ──────────────────────

export function getTaskLogDir(): string {
  return path.join(getCacheDir(), "tasks", "logs");
}

export function getTaskHistoryDir(): string {
  return path.join(getCacheDir(), "tasks", "history");
}

// ── Default stash directory ──────────────────────────────────────────────────

export function getDefaultStashDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.AKM_STASH_DIR?.trim();
  if (override) return override;

  if (IS_WINDOWS) {
    const userProfile = env.USERPROFILE?.trim();
    if (userProfile) return path.join(userProfile, "Documents", "akm");
    return path.join("C:\\", "akm");
  }

  const home = env.HOME?.trim();
  if (!home) {
    throw new ConfigError("Unable to determine default stash directory. Set HOME.", "STASH_DIR_NOT_FOUND");
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
    "/var/tmp",
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

  const HIDDEN_USER_PARENTS = [
    ".config",
    ".local",
    ".cache",
    ".ssh",
    ".gnupg",
    ".aws",
    ".kube",
    ".docker",
    "Documents",
    "Downloads",
    "AppData",
  ];

  for (const home of candidateHomes) {
    if (resolved === home) {
      throw new ConfigError(
        `Refusing stashDir at your home directory (${resolved}). Pick a subdirectory like ~/akm.`,
        "UNSAFE_STASH_DIR",
      );
    }
    for (const sub of HIDDEN_USER_PARENTS) {
      if (resolved === path.join(home, sub)) {
        throw new ConfigError(
          `Refusing stashDir at sensitive user directory (${resolved}). Pick a subdirectory or a dedicated workspace.`,
          "UNSAFE_STASH_DIR",
        );
      }
    }
  }
}
