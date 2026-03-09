import fs from "node:fs"
import path from "node:path"
import { resolveStashDir } from "./common"
import { loadConfig } from "./config"

// ── Types ───────────────────────────────────────────────────────────────────

export type StashSourceKind = "working" | "mounted" | "installed"

export interface StashSource {
  kind: StashSourceKind
  path: string
  /** For installed sources, the registry entry id */
  registryId?: string
  /** Whether this source is writable (only working stash) */
  writable: boolean
}

// ── Resolution ──────────────────────────────────────────────────────────────

/**
 * Build the ordered list of stash sources:
 *   1. Working stash (writable)
 *   2. Mounted stash dirs (read-only, user-configured)
 *   3. Installed stash dirs (read-only, derived from registry.installed)
 */
export function resolveStashSources(overrideStashDir?: string): StashSource[] {
  const stashDir = overrideStashDir ?? resolveStashDir()
  const config = loadConfig()

  const sources: StashSource[] = [
    { kind: "working", path: stashDir, writable: true },
  ]

  for (const dir of config.mountedStashDirs) {
    // Skip suspicious system directories silently — they are almost certainly misconfigured
    if (isSuspiciousStashRoot(dir)) continue
    if (isValidDirectory(dir)) {
      sources.push({ kind: "mounted", path: dir, writable: false })
    }
  }

  for (const entry of config.registry?.installed ?? []) {
    if (isSuspiciousStashRoot(entry.stashRoot)) continue
    if (isValidDirectory(entry.stashRoot)) {
      sources.push({
        kind: "installed",
        path: entry.stashRoot,
        registryId: entry.id,
        writable: false,
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
