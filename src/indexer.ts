import fs from "node:fs"
import path from "node:path"
import type { AgentikitAssetType } from "./stash"
import {
  type StashFile,
  type StashEntry,
  loadStashFile,
  writeStashFile,
  generateMetadata,
} from "./metadata"
import { TfIdfAdapter, type ScoredEntry } from "./similarity"

// ── Types ───────────────────────────────────────────────────────────────────

export interface IndexedEntry {
  entry: StashEntry
  path: string
  dirPath: string
}

export interface SearchIndex {
  version: number
  builtAt: string
  stashDir: string
  entries: IndexedEntry[]
  /** Serialized TF-IDF state (term frequencies, idf values) */
  tfidf?: unknown
}

export interface IndexResponse {
  stashDir: string
  totalEntries: number
  generatedMetadata: number
  indexPath: string
}

// ── Constants ───────────────────────────────────────────────────────────────

const INDEX_VERSION = 1
const SCRIPT_EXTENSIONS = new Set([".sh", ".ts", ".js", ".ps1", ".cmd", ".bat"])

const TYPE_DIRS: Record<AgentikitAssetType, string> = {
  tool: "tools",
  skill: "skills",
  command: "commands",
  agent: "agents",
  knowledge: "knowledge",
}

// ── Index Path ──────────────────────────────────────────────────────────────

export function getIndexPath(): string {
  const cacheDir = process.env.XDG_CACHE_HOME
    || path.join(process.env.HOME || process.env.USERPROFILE || "", ".cache")
  return path.join(cacheDir, "agentikit", "index.json")
}

export function loadSearchIndex(): SearchIndex | null {
  const indexPath = getIndexPath()
  if (!fs.existsSync(indexPath)) return null
  try {
    const raw = JSON.parse(fs.readFileSync(indexPath, "utf8"))
    if (raw?.version !== INDEX_VERSION) return null
    return raw as SearchIndex
  } catch {
    return null
  }
}

// ── Indexer ──────────────────────────────────────────────────────────────────

export function agentikitIndex(options?: { stashDir?: string }): IndexResponse {
  const stashDir = options?.stashDir || resolveStashDirForIndex()
  const allEntries: IndexedEntry[] = []
  let generatedCount = 0

  for (const assetType of Object.keys(TYPE_DIRS) as AgentikitAssetType[]) {
    const typeRoot = path.join(stashDir, TYPE_DIRS[assetType])
    if (!fs.existsSync(typeRoot) || !fs.statSync(typeRoot).isDirectory()) continue

    // Group files by their immediate parent directory
    const dirGroups = collectDirectoryGroups(typeRoot, assetType)

    for (const [dirPath, files] of dirGroups) {
      // Try loading existing .stash.json
      let stash = loadStashFile(dirPath)

      if (!stash) {
        // Generate metadata
        stash = generateMetadata(dirPath, assetType, files)
        if (stash.entries.length > 0) {
          writeStashFile(dirPath, stash)
          generatedCount += stash.entries.length
        }
      }

      if (stash) {
        for (const entry of stash.entries) {
          const entryPath = entry.entry
            ? path.join(dirPath, entry.entry)
            : files[0] || dirPath
          allEntries.push({ entry, path: entryPath, dirPath })
        }
      }
    }
  }

  // Build TF-IDF index
  const adapter = new TfIdfAdapter()
  const scoredEntries: ScoredEntry[] = allEntries.map((ie) => ({
    id: `${ie.entry.type}:${ie.entry.name}`,
    text: buildSearchText(ie.entry),
    entry: ie.entry,
    path: ie.path,
  }))
  adapter.buildIndex(scoredEntries)

  // Persist index
  const indexPath = getIndexPath()
  const indexDir = path.dirname(indexPath)
  if (!fs.existsSync(indexDir)) {
    fs.mkdirSync(indexDir, { recursive: true })
  }

  const index: SearchIndex = {
    version: INDEX_VERSION,
    builtAt: new Date().toISOString(),
    stashDir,
    entries: allEntries,
    tfidf: adapter.serialize(),
  }
  fs.writeFileSync(indexPath, JSON.stringify(index) + "\n", "utf8")

  return {
    stashDir,
    totalEntries: allEntries.length,
    generatedMetadata: generatedCount,
    indexPath,
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function collectDirectoryGroups(
  typeRoot: string,
  assetType: AgentikitAssetType,
): Map<string, string[]> {
  const groups = new Map<string, string[]>()

  const walk = (dir: string): void => {
    if (!fs.existsSync(dir)) return
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name === ".stash.json") continue
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(fullPath)
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

  walk(typeRoot)
  return groups
}

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

export function buildSearchText(entry: StashEntry): string {
  const parts: string[] = [entry.name.replace(/[-_]/g, " ")]
  if (entry.description) parts.push(entry.description)
  if (entry.tags) parts.push(entry.tags.join(" "))
  if (entry.examples) parts.push(entry.examples.join(" "))
  if (entry.intent) {
    if (entry.intent.when) parts.push(entry.intent.when)
    if (entry.intent.input) parts.push(entry.intent.input)
    if (entry.intent.output) parts.push(entry.intent.output)
  }
  if (entry.toc) {
    parts.push(entry.toc.map((h) => h.text).join(" "))
  }
  return parts.join(" ").toLowerCase()
}

function resolveStashDirForIndex(): string {
  const raw = process.env.AGENTIKIT_STASH_DIR?.trim()
  if (!raw) {
    throw new Error("AGENTIKIT_STASH_DIR is not set. Run 'agentikit init' first.")
  }
  const stashDir = path.resolve(raw)
  if (!fs.existsSync(stashDir) || !fs.statSync(stashDir).isDirectory()) {
    throw new Error(`AGENTIKIT_STASH_DIR does not exist or is not a directory: "${stashDir}"`)
  }
  return stashDir
}
