import fs from "node:fs"
import path from "node:path"
import { resolveStashDir } from "./common"
import { loadConfig } from "./config"
import type { AgentikitConfig } from "./config"

// ── Types ───────────────────────────────────────────────────────────────────

export interface StashSource {
  path: string
  /** For installed sources, the registry entry id */
  registryId?: string
}

// ── Resolution ──────────────────────────────────────────────────────────────

/**
 * Build the ordered list of stash sources (search paths):
 *   1. Primary stash dir (user's own, destination for clone)
 *   2. Additional search paths (user-configured)
 *   3. Installed kit paths (cache-managed, from registry)
 *
 * The first entry is always the primary stash. Additional entries come
 * from `searchPaths` config and `registry.installed` entries.
 */
export function resolveStashSources(overrideStashDir?: string): StashSource[] {
  const stashDir = overrideStashDir ?? resolveStashDir()
  const config = loadConfig()

  const sources: StashSource[] = [
    { path: stashDir },
  ]

  for (const dir of config.searchPaths) {
    if (isSuspiciousStashRoot(dir)) {
      console.warn(`Warning: stash root "${dir}" appears to be a system directory. This may be unintentional.`)
    }
    if (isValidDirectory(dir)) {
      sources.push({ path: dir })
    }
  }

  for (const entry of config.registry?.installed ?? []) {
    if (isSuspiciousStashRoot(entry.stashRoot)) {
      console.warn(`Warning: stash root "${entry.stashRoot}" appears to be a system directory. This may be unintentional.`)
    }
    if (isValidDirectory(entry.stashRoot)) {
      sources.push({
        path: entry.stashRoot,
        registryId: entry.id,
      })
    }
  }

  return sources
}

/**
 * Convenience: returns just the directory paths, preserving priority order.
 */
export function resolveAllStashDirs(overrideStashDir?: string): string[] {
  return resolveStashSources(overrideStashDir).map((s) => s.path)
}

/**
 * Find which source a file path belongs to.
 */
export function findSourceForPath(filePath: string, sources: StashSource[]): StashSource | undefined {
  const resolved = path.resolve(filePath)
  for (const source of sources) {
    if (resolved.startsWith(path.resolve(source.path) + path.sep)) return source
  }
  return undefined
}

/**
 * Return the primary stash source (first entry in the list).
 * This is the user's working stash and the default destination for clone.
 */
export function getPrimarySource(sources: StashSource[]): StashSource | undefined {
  return sources[0]
}

// ── Editability ─────────────────────────────────────────────────────────────

/**
 * Determine whether a file is safe to edit in place.
 *
 * The only files that are NOT editable are those inside a cache directory
 * managed by the package manager (`registry.installed[].cacheDir`). These
 * will be overwritten by `akm update` without warning.
 *
 * Everything else — working stash, search paths, local project dirs — is
 * the user's domain to manage.
 */
export function isEditable(filePath: string, config?: AgentikitConfig): boolean {
  const cfg = config ?? loadConfig()
  const resolved = path.resolve(filePath)
  const cacheManaged = cfg.registry?.installed ?? []
  const isWin = process.platform === "win32"

  for (const entry of cacheManaged) {
    const cacheRoot = path.resolve(entry.cacheDir)
    if (isWin) {
      // Windows paths are case-insensitive — normalize both sides
      if (resolved.toLowerCase().startsWith(cacheRoot.toLowerCase() + path.sep)) return false
    } else {
      if (resolved.startsWith(cacheRoot + path.sep)) return false
    }
  }

  return true
}

/**
 * Build an actionable hint for the agent when a file is not editable.
 * Callers must check `isEditable()` before calling — this function
 * unconditionally returns the hint string.
 */
export function buildEditHint(filePath: string, assetType: string, assetName: string, origin?: string): string {
  const ref = origin ? `${origin}//${assetType}:${assetName}` : `${assetType}:${assetName}`
  return `This asset is managed by akm and may be overwritten on update. To edit, run: akm clone ${ref}`
}

// ── Validation ──────────────────────────────────────────────────────────────

const SUSPICIOUS_ROOTS = new Set(["/", "/etc", "/bin", "/sbin", "/usr", "/var", "/tmp", "/dev", "/proc", "/sys"])

function isSuspiciousStashRoot(dir: string): boolean {
  const resolved = path.resolve(dir)
  const normalized = process.platform === "win32" ? resolved.toLowerCase() : resolved
  if (SUSPICIOUS_ROOTS.has(normalized)) return true
  if (process.platform === "win32") {
    // Check for Windows system directories
    const winDir = (process.env.SystemRoot || "C:\\Windows").toLowerCase()
    if (normalized === winDir || normalized.startsWith(winDir + path.sep)) return true
  }
  return false
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function isValidDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory()
  } catch {
    return false
  }
}
