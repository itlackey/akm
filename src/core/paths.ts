/**
 * Centralized path resolution for all akm directories.
 *
 * Provides platform-aware paths for config, cache, and stash directories,
 * following XDG Base Directory conventions on Unix and standard locations
 * on Windows.
 */

import path from "node:path";
import { IS_WINDOWS } from "./common";
import { ConfigError } from "./errors";

/**
 * Returns true when the current process appears to be running under
 * `bun test` (either via the BUN_TEST sentinel Bun sets on the test
 * worker, or via the conventional NODE_ENV=test).
 *
 * Used by getDataDir/getStateDir to enforce that any test which sets
 * AKM_STASH_DIR ALSO redirects XDG_DATA_HOME and XDG_STATE_HOME (or the
 * AKM_*_DIR overrides) to temp directories. Without that pairing, tests
 * silently write SQLite databases, lockfiles, and task history into the
 * developer's real `~/.local/share/akm` / `~/.local/state/akm`.
 */
function isUnderBunTest(env: NodeJS.ProcessEnv): boolean {
  return env.BUN_TEST === "1" || env.NODE_ENV === "test";
}

/**
 * Build a TEST_ISOLATION_MISSING ConfigError describing which env var(s)
 * must be set so the data/state path resolves into a temp dir instead of
 * the user's real XDG home.
 */
function testIsolationError(directoryKind: "data" | "state"): ConfigError {
  const xdgVar = directoryKind === "data" ? "XDG_DATA_HOME" : "XDG_STATE_HOME";
  const akmVar = directoryKind === "data" ? "AKM_DATA_DIR" : "AKM_STATE_DIR";
  return new ConfigError(
    `Refusing to resolve ${directoryKind} directory under bun test: AKM_STASH_DIR is set but ${xdgVar}/${akmVar} is not. ` +
      "This guards against tests writing into the developer's real ~/.local/share/akm or ~/.local/state/akm. " +
      `Set ${xdgVar} (or ${akmVar}) to a mktemp-d directory in this test's env block.`,
    "TEST_ISOLATION_MISSING",
  );
}

// ── Config directory ─────────────────────────────────────────────────────────

export function getConfigDir(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string {
  const override = env.AKM_CONFIG_DIR?.trim();
  if (override) return override;

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

export function getConfigPath(): string {
  return path.join(getConfigDir(), "config.json");
}

// ── Cache directory ──────────────────────────────────────────────────────────

export function getCacheDir(): string {
  const override = process.env.AKM_CACHE_DIR?.trim();
  if (override) return override;

  if (IS_WINDOWS) {
    const localAppData = process.env.LOCALAPPDATA?.trim();
    if (localAppData) return path.join(localAppData, "akm");

    const userProfile = process.env.USERPROFILE?.trim();
    if (userProfile) return path.join(userProfile, "AppData", "Local", "akm");

    const appData = process.env.APPDATA?.trim();
    if (!appData) {
      throw new ConfigError(
        "Unable to determine cache directory. Set LOCALAPPDATA, USERPROFILE, or APPDATA.",
        "CONFIG_DIR_UNRESOLVABLE",
      );
    }
    // Heuristic fallback: APPDATA points to %APPDATA% (Roaming), so navigate
    // to the sibling "Local" directory. This is typically
    // C:\Users\<name>\AppData\Roaming → C:\Users\<name>\AppData\Local\akm.
    // Preferred: set LOCALAPPDATA to avoid this navigation.
    return path.join(appData, "..", "Local", "akm");
  }

  const xdgCacheHome = process.env.XDG_CACHE_HOME?.trim();
  if (xdgCacheHome) return path.join(xdgCacheHome, "akm");

  const home = process.env.HOME?.trim();
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
  // user's real $XDG_DATA_HOME / ~/.local/share/akm when AKM_STASH_DIR is
  // set without a matching data-dir override. Item 5 of the 0.8.x
  // critical-review plan: see memory:akm-improve-critical-review-2026-05-20.
  if (isUnderBunTest(env) && env.AKM_STASH_DIR?.trim() && !env.XDG_DATA_HOME?.trim()) {
    throw testIsolationError("data");
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

// ── State directory ──────────────────────────────────────────────────────────

/**
 * Returns the XDG state directory for akm (`~/.local/state/akm` on Linux/macOS,
 * `%LOCALAPPDATA%\akm\state` on Windows).
 *
 * Holds runtime state and log-like files that persist across reboots but are
 * less precious than $DATA: task history JSONL files, akm.lock.lck sentinel.
 *
 * Env overrides (in priority order):
 *   AKM_STATE_DIR   — point to any directory
 *   XDG_STATE_HOME  — (Linux/macOS) override the XDG base; akm subdir is appended
 */
export function getStateDir(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string {
  const override = env.AKM_STATE_DIR?.trim();
  if (override) return override;

  // Defense-in-depth: under `bun test`, refuse to fall through to the
  // user's real $XDG_STATE_HOME / ~/.local/state/akm when AKM_STASH_DIR
  // is set without a matching state-dir override. See getDataDir above.
  if (isUnderBunTest(env) && env.AKM_STASH_DIR?.trim() && !env.XDG_STATE_HOME?.trim()) {
    throw testIsolationError("state");
  }

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
  if (!home) return path.join("/tmp", "akm-state");

  return path.join(home, ".local", "state", "akm");
}

export function getDbPath(): string {
  return path.join(getDataDir(), "index.db");
}

export function getWorkflowDbPath(): string {
  return path.join(getDataDir(), "workflow.db");
}

/** Path to the state.db file in $DATA. */
export function getStateDbPathInDataDir(): string {
  return path.join(getDataDir(), "state.db");
}

/** Path for the task history directory in $STATE (v2 location). */
export function getTaskHistoryStateDir(): string {
  return path.join(getStateDir(), "tasks", "history");
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

export function getDefaultStashDir(): string {
  const override = process.env.AKM_STASH_DIR?.trim();
  if (override) return override;

  if (IS_WINDOWS) {
    const userProfile = process.env.USERPROFILE?.trim();
    if (userProfile) return path.join(userProfile, "Documents", "akm");
    return path.join("C:\\", "akm");
  }

  const home = process.env.HOME?.trim();
  if (!home) {
    throw new ConfigError("Unable to determine default stash directory. Set HOME.", "STASH_DIR_NOT_FOUND");
  }
  return path.join(home, "akm");
}
