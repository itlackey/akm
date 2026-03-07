/**
 * Shared filesystem walker for agentikit stash directories.
 *
 * Provides a single implementation used by both the search fallback
 * (stash.ts) and the indexer (indexer.ts) to walk type-specific asset
 * directories and group files by parent directory.
 */

import fs from "node:fs"
import path from "node:path"
import { type AgentikitAssetType, SCRIPT_EXTENSIONS } from "./common"

export interface DirectoryGroup {
  dirPath: string
  files: string[]
}

/**
 * Walk a type root directory and return files grouped by their parent directory.
 *
 * Only files relevant to the given `assetType` are included (e.g. `.md` for
 * commands, script extensions for tools, `SKILL.md` for skills).
 */
export function walkStash(typeRoot: string, assetType: AgentikitAssetType): DirectoryGroup[] {
  if (!fs.existsSync(typeRoot)) return []

  const groups = new Map<string, string[]>()

  const stack = [typeRoot]
  while (stack.length > 0) {
    const current = stack.pop()
    if (!current) continue
    const entries = fs.readdirSync(current, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name === ".stash.json") continue
      const fullPath = path.join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(fullPath)
      } else if (entry.isFile() && isRelevantFile(entry.name, assetType)) {
        const parentDir = path.dirname(fullPath)
        const existing = groups.get(parentDir)
        if (existing) {
          existing.push(fullPath)
        } else {
          groups.set(parentDir, [fullPath])
        }
      }
    }
  }

  return Array.from(groups, ([dirPath, files]) => ({ dirPath, files }))
}

/**
 * Determine whether a file is relevant for the given asset type.
 */
function isRelevantFile(fileName: string, assetType: AgentikitAssetType): boolean {
  const ext = path.extname(fileName).toLowerCase()
  switch (assetType) {
    case "tool":
      return SCRIPT_EXTENSIONS.has(ext)
    case "skill":
      return fileName === "SKILL.md"
    case "command":
    case "agent":
    case "knowledge":
      return ext === ".md"
    default:
      return false
  }
}
