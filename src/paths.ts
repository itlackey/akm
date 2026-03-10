/**
 * Centralized path resolution for all agentikit directories.
 *
 * Provides platform-aware paths for config, cache, and stash directories,
 * following XDG Base Directory conventions on Unix and standard locations
 * on Windows.
 */

import path from "node:path"
import { ConfigError } from "./errors"

const IS_WINDOWS = process.platform === "win32"

// ── Config directory ─────────────────────────────────────────────────────────

export function getConfigDir(
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
): string {
  if (platform === "win32") {
    const appData = env.APPDATA?.trim()
    if (appData) return path.join(appData, "agentikit")

    const userProfile = env.USERPROFILE?.trim()
    if (!userProfile) {
      throw new ConfigError("Unable to determine config directory. Set APPDATA or USERPROFILE.")
    }
    return path.join(userProfile, "AppData", "Roaming", "agentikit")
  }

  const xdgConfigHome = env.XDG_CONFIG_HOME?.trim()
  if (xdgConfigHome) return path.join(xdgConfigHome, "agentikit")

  const home = env.HOME?.trim()
  if (!home) {
    throw new ConfigError("Unable to determine config directory. Set XDG_CONFIG_HOME or HOME.")
  }
  return path.join(home, ".config", "agentikit")
}

export function getConfigPath(): string {
  return path.join(getConfigDir(), "config.json")
}

// ── Cache directory ──────────────────────────────────────────────────────────

export function getCacheDir(): string {
  if (IS_WINDOWS) {
    const localAppData = process.env.LOCALAPPDATA?.trim()
    if (localAppData) return path.join(localAppData, "agentikit")

    const userProfile = process.env.USERPROFILE?.trim()
    if (userProfile) return path.join(userProfile, "AppData", "Local", "agentikit")

    const appData = process.env.APPDATA?.trim()
    if (!appData) {
      throw new ConfigError("Unable to determine cache directory. Set LOCALAPPDATA, USERPROFILE, or APPDATA.")
    }
    return path.join(appData, "..", "Local", "agentikit")
  }

  const xdgCacheHome = process.env.XDG_CACHE_HOME?.trim()
  if (xdgCacheHome) return path.join(xdgCacheHome, "agentikit")

  const home = process.env.HOME?.trim()
  if (!home) return path.join("/tmp", "agentikit-cache")

  return path.join(home, ".cache", "agentikit")
}

export function getDbPath(): string {
  return path.join(getCacheDir(), "index.db")
}

export function getRegistryCacheDir(): string {
  return path.join(getCacheDir(), "registry")
}

export function getRegistryIndexCacheDir(): string {
  return path.join(getCacheDir(), "registry-index")
}

export function getBinDir(): string {
  return path.join(getCacheDir(), "bin")
}

// ── Default stash directory ──────────────────────────────────────────────────

export function getDefaultStashDir(): string {
  if (IS_WINDOWS) {
    const userProfile = process.env.USERPROFILE?.trim()
    if (userProfile) return path.join(userProfile, "Documents", "agentikit")
    return path.join("C:\\", "agentikit")
  }

  const home = process.env.HOME?.trim()
  if (!home) {
    throw new ConfigError("Unable to determine default stash directory. Set HOME.")
  }
  return path.join(home, "agentikit")
}
