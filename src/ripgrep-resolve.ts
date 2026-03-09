import fs from "node:fs"
import path from "node:path"
import { IS_WINDOWS } from "./common"
import { getBinDir } from "./paths"

export const RG_BINARY = IS_WINDOWS ? "rg.exe" : "rg"

function canExecute(filePath: string): boolean {
  if (!fs.existsSync(filePath)) return false
  if (IS_WINDOWS) return true
  try {
    fs.accessSync(filePath, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

function resolveFromPath(): string | null {
  const rawPath = process.env.PATH
  if (!rawPath) return null

  const pathEntries = rawPath.split(path.delimiter).filter(Boolean)

  if (IS_WINDOWS) {
    const pathext = (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM")
      .split(";")
      .filter(Boolean)
      .map((ext) => ext.toLowerCase())

    for (const entry of pathEntries) {
      const directCandidate = path.join(entry, "rg")
      if (canExecute(directCandidate)) return directCandidate

      for (const ext of pathext) {
        const candidate = path.join(entry, `rg${ext}`)
        if (canExecute(candidate)) return candidate
      }
    }
    return null
  }

  for (const entry of pathEntries) {
    const candidate = path.join(entry, "rg")
    if (canExecute(candidate)) return candidate
  }

  return null
}

/**
 * Resolve the path to a usable ripgrep binary.
 * Checks in order:
 *   1. Provided binDir (or default cache bin dir) for rg
 *   2. System PATH (rg)
 * Returns null if ripgrep is not available.
 */
export function resolveRg(binDir?: string): string | null {
  if (binDir) {
    const directRg = path.join(binDir, RG_BINARY)
    if (canExecute(directRg)) return directRg
  }

  // Check default cache bin dir
  try {
    const defaultBinDir = getBinDir()
    const cachedRg = path.join(defaultBinDir, RG_BINARY)
    if (canExecute(cachedRg)) return cachedRg
  } catch {
    // getBinDir may fail if HOME is not set — fall through
  }

  return resolveFromPath()
}

/**
 * Check if ripgrep is available (in cache/bin or system PATH).
 */
export function isRgAvailable(binDir?: string): boolean {
  return resolveRg(binDir) !== null
}
