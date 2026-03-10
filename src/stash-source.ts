import fs from "node:fs"
import path from "node:path"
import { resolveStashDir } from "./common"
import { loadConfig } from "./config"
import type { AgentikitConfig } from "./config"

// ── Types ───────────────────────────────────────────────────────────────────

export type StashSourceKind = "working" | "mounted" | "installed"

export interface StashSource {
  kind: StashSourceKind
  path: string
  /** For installed sources, the registry entry id */
  registryId?: string
}

// ── Resolution ──────────────────────────────────────────────────────────────

/**
 * Build the ordered list of stash sources:
 *   1. Working stash (user's own)
 *   2. Mounted stash dirs (user-configured, editable by default)
 *   3. Installed stash dirs (cache-managed, not safe to edit in place)
 */
export function resolveStashSources(overrideStashDir?: string): StashSource[] {
  const stashDir = overrideStashDir ?? resolveStashDir()
  const config = loadConfig()

  const sources: StashSource[] = [
    { kind: "working", path: stashDir },
  ]

  for (const dir of config.mountedStashDirs) {
    if (isSuspiciousStashRoot(dir)) {
      console.warn(`Warning: stash root "${dir}" appears to be a system directory. This may be unintentional.`)
    }
    if (isValidDirectory(dir)) {
      sources.push({ kind: "mounted", path: dir })
    }
  }

  for (const entry of config.registry?.installed ?? []) {
    if (isSuspiciousStashRoot(entry.stashRoot)) {
      console.warn(`Warning: stash root "${entry.stashRoot}" appears to be a system directory. This may be unintentional.`)
    }
    if (isValidDirectory(entry.stashRoot)) {
      sources.push({
        kind: "installed",
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

// ── Editability ─────────────────────────────────────────────────────────────

/**
 * Determine whether a file is safe to edit in place.
 *
 * The only files that are NOT editable are those inside a cache directory
 * managed by the package manager (`registry.installed[].cacheDir`). These
 * will be overwritten by `akm update` without warning.
 *
 * Everything else — working stash, mounted dirs, local project dirs — is
 * the user's domain to manage.
 */
export function isEditable(filePath: string, config?: AgentikitConfig): boolean {
  const cfg = config ?? loadConfig()
  const resolved = path.resolve(filePath)
  const cacheManaged = cfg.registry?.installed ?? []

  for (const entry of cacheManaged) {
    const cacheRoot = path.resolve(entry.cacheDir)
    if (resolved.startsWith(cacheRoot + path.sep)) return false
  }

  return true
}

/**
 * Build an actionable hint for the agent when a file is not editable.
 * Returns undefined when the file is editable (no hint needed).
 */
export function buildEditHint(filePath: string, assetType: string, assetName: string, config?: AgentikitConfig): string | undefined {
  const cfg = config ?? loadConfig()
  if (isEditable(filePath, cfg)) return undefined
  return `This asset is managed by akm and may be overwritten on update. To edit, run: akm clone ${assetType}:${assetName}`
}

// ── Validation ──────────────────────────────────────────────────────────────

const SUSPICIOUS_ROOTS = new Set(['/', '/etc', '/bin', '/sbin', '/usr', '/var', '/tmp', '/dev', '/proc', '/sys'])

function isSuspiciousStashRoot(dir: string): boolean {
  const resolved = path.resolve(dir)
  const normalized = process.platform === 'win32' ? resolved.toLowerCase() : resolved
  if (SUSPICIOUS_ROOTS.has(normalized)) return true
  if (process.platform === 'win32') {
    // Check for Windows system directories
    const winDir = (process.env.SystemRoot || 'C:\\Windows').toLowerCase()
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
