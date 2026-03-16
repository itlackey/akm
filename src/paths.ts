/**
 * Centralized path resolution for all akm directories.
 *
 * Provides platform-aware paths for config, cache, and stash directories,
 * following XDG Base Directory conventions on Unix and standard locations
 * on Windows.
 */

import path from "node:path";
import { ConfigError } from "./errors";

const IS_WINDOWS = process.platform === "win32";

// ── Config directory ─────────────────────────────────────────────────────────

export function getConfigDir(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string {
  const override = env.AKM_CONFIG_DIR?.trim();
  if (override) return override;

  if (platform === "win32") {
    const appData = env.APPDATA?.trim();
    if (appData) return path.join(appData, "akm");

    const userProfile = env.USERPROFILE?.trim();
    if (!userProfile) {
      throw new ConfigError("Unable to determine config directory. Set APPDATA or USERPROFILE.");
    }
    return path.join(userProfile, "AppData", "Roaming", "akm");
  }

  const xdgConfigHome = env.XDG_CONFIG_HOME?.trim();
  if (xdgConfigHome) return path.join(xdgConfigHome, "akm");

  const home = env.HOME?.trim();
  if (!home) {
    throw new ConfigError("Unable to determine config directory. Set XDG_CONFIG_HOME or HOME.");
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
      throw new ConfigError("Unable to determine cache directory. Set LOCALAPPDATA, USERPROFILE, or APPDATA.");
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

export function getDbPath(): string {
  return path.join(getCacheDir(), "index.db");
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
    throw new ConfigError("Unable to determine default stash directory. Set HOME.");
  }
  return path.join(home, "akm");
}
