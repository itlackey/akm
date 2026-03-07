import fs from "node:fs"
import path from "node:path"
import { type AgentikitAssetType, resolveStashDir } from "./common"
import { ASSET_TYPES, TYPE_DIRS, deriveCanonicalAssetName } from "./asset-spec"
import {
  type StashFile,
  type StashEntry,
  loadStashFile,
  writeStashFile,
  generateMetadata,
} from "./metadata"
import { TfIdfAdapter, type ScoredEntry, type SerializedTfIdf } from "./similarity"
import { walkStash } from "./walker"
import type { EmbeddingVector } from "./embedder"
import type { LlmConnectionConfig } from "./config"

// ── Types ───────────────────────────────────────────────────────────────────

export interface IndexedEntry {
  entry: StashEntry
  path: string
  dirPath: string
  embedding?: EmbeddingVector
}

export interface SearchIndex {
  version: number
  builtAt: string
  stashDir: string
  /** All stash directories that were indexed (primary + additional) */
  stashDirs?: string[]
  entries: IndexedEntry[]
  /** Serialized TF-IDF state (term frequencies, idf values) */
  tfidf?: SerializedTfIdf
  /** Whether embeddings are included in entries */
  hasEmbeddings?: boolean
}

export interface IndexResponse {
  stashDir: string
  totalEntries: number
  generatedMetadata: number
  indexPath: string
  mode: "full" | "incremental"
  directoriesScanned: number
  directoriesSkipped: number
  /** Timing counters in milliseconds */
  timing?: { totalMs: number; walkMs: number; metadataMs: number; embedMs: number; tfidfMs: number }
}

// ── Constants ───────────────────────────────────────────────────────────────

const INDEX_VERSION = 4

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

export async function agentikitIndex(options?: { stashDir?: string; full?: boolean }): Promise<IndexResponse> {
  const stashDir = options?.stashDir || resolveStashDir()

  // Load config to get additional stash dirs and semantic search setting
  const { loadConfig } = await import("./config.js")
  const config = loadConfig(stashDir)

  const allStashDirs = [stashDir]
  for (const d of config.additionalStashDirs) {
    try {
      if (fs.statSync(d).isDirectory() && !allStashDirs.includes(path.resolve(d))) {
        allStashDirs.push(path.resolve(d))
      }
    } catch { /* skip nonexistent dirs */ }
  }

  const t0 = Date.now()
  const allEntries: IndexedEntry[] = []
  let generatedCount = 0
  let scannedDirs = 0
  let skippedDirs = 0

  // Load previous index for incremental mode
  const previousIndex = !options?.full ? loadSearchIndex() : null
  const isIncremental = previousIndex !== null && previousIndex.stashDir === stashDir
  const builtAtMs = isIncremental ? new Date(previousIndex.builtAt).getTime() : 0

  // Build lookup of previous entries by dirPath
  const previousEntriesByDir = new Map<string, IndexedEntry[]>()
  if (isIncremental) {
    for (const ie of previousIndex.entries) {
      const list = previousEntriesByDir.get(ie.dirPath) || []
      list.push(ie)
      previousEntriesByDir.set(ie.dirPath, list)
    }
  }

  const seenPaths = new Set<string>()
  const tWalkStart = Date.now()

  for (const currentStashDir of allStashDirs) {
    for (const assetType of ASSET_TYPES as AgentikitAssetType[]) {
      const typeRoot = path.join(currentStashDir, TYPE_DIRS[assetType])
      try {
        if (!fs.statSync(typeRoot).isDirectory()) continue
      } catch { continue }

      // Group files by their immediate parent directory
      const dirGroups = walkStash(typeRoot, assetType)

      for (const { dirPath, files } of dirGroups) {
        // Deduplicate by dirPath across stash dirs
        if (seenPaths.has(path.resolve(dirPath))) continue
        seenPaths.add(path.resolve(dirPath))

        // Incremental: skip directories that haven't changed
        const prevEntries = previousEntriesByDir.get(dirPath)
        if (isIncremental && prevEntries && !isDirStale(dirPath, files, prevEntries, builtAtMs)) {
          allEntries.push(...prevEntries)
          skippedDirs++
          continue
        }

        scannedDirs++

        // Try loading existing .stash.json
        let stash = loadStashFile(dirPath)

        if (stash) {
          const migration = migrateGeneratedSkillMetadata(stash, files, typeRoot)
          if (migration.changed) {
            stash = migration.stash
            writeStashFile(dirPath, stash)
          }
        }

        if (!stash) {
          // Generate metadata
          stash = generateMetadata(dirPath, assetType, files, typeRoot)
          // Enhance with LLM if configured
          if (config.llm && stash.entries.length > 0) {
            stash = await enhanceStashWithLlm(config.llm, stash, dirPath, files)
          }
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
  }

  const tWalkEnd = Date.now()

  // Build TF-IDF index
  const adapter = new TfIdfAdapter()
  const scoredEntries: ScoredEntry[] = allEntries.map((ie) => ({
    id: `${ie.entry.type}:${ie.entry.name}`,
    text: buildSearchText(ie.entry),
    entry: ie.entry,
    path: ie.path,
  }))
  adapter.buildIndex(scoredEntries)
  const tTfidfEnd = Date.now()

  // Generate embeddings if semantic search is enabled
  let hasEmbeddings = false
  if (config.semanticSearch) {
    try {
      const { embed } = await import("./embedder.js")
      for (const ie of allEntries) {
        if (!ie.embedding) {
          const text = buildSearchText(ie.entry)
          ie.embedding = await embed(text, config.embedding)
        }
      }
      hasEmbeddings = true
    } catch {
      // Embedding provider not available, continue without embeddings
    }
  }

  const tEmbedEnd = Date.now()

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
    stashDirs: allStashDirs,
    entries: allEntries,
    tfidf: adapter.serialize(),
    hasEmbeddings,
  }
  fs.writeFileSync(indexPath, JSON.stringify(index) + "\n", "utf8")

  const tEnd = Date.now()

  return {
    stashDir,
    totalEntries: allEntries.length,
    generatedMetadata: generatedCount,
    indexPath,
    mode: isIncremental ? "incremental" : "full",
    directoriesScanned: scannedDirs,
    directoriesSkipped: skippedDirs,
    timing: {
      totalMs: tEnd - t0,
      walkMs: tWalkEnd - tWalkStart, // includes metadata generation (interleaved)
      embedMs: tEmbedEnd - tTfidfEnd,
      tfidfMs: tTfidfEnd - tWalkEnd,
    },
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function isDirStale(
  dirPath: string,
  currentFiles: string[],
  previousEntries: IndexedEntry[],
  builtAtMs: number,
): boolean {
  // Check if file set changed (additions or deletions)
  const prevFileNames = new Set(
    previousEntries
      .map((ie) => ie.entry.entry)
      .filter((e): e is string => !!e),
  )
  const currFileNames = new Set(currentFiles.map((f) => path.basename(f)))
  if (prevFileNames.size !== currFileNames.size) return true
  for (const name of currFileNames) {
    if (!prevFileNames.has(name)) return true
  }

  // Check modification times of current files
  for (const file of currentFiles) {
    try {
      if (fs.statSync(file).mtimeMs > builtAtMs) return true
    } catch {
      return true
    }
  }

  // Check .stash.json modification time
  const stashPath = path.join(dirPath, ".stash.json")
  try {
    if (fs.existsSync(stashPath) && fs.statSync(stashPath).mtimeMs > builtAtMs) return true
  } catch {
    // ignore
  }

  return false
}

function migrateGeneratedSkillMetadata(
  stash: StashFile,
  files: string[],
  typeRoot: string,
): { stash: StashFile; changed: boolean } {
  const fileByBaseName = new Map(files.map((filePath) => [path.basename(filePath), filePath]))
  let changed = false

  const entries = stash.entries.map((entry) => {
    if (entry.type !== "skill" || entry.generated !== true) return entry

    const hintedFilePath = entry.entry ? fileByBaseName.get(path.basename(entry.entry)) : undefined
    const skillFilePath = hintedFilePath ?? fileByBaseName.get("SKILL.md")
    if (!skillFilePath) return entry

    const canonicalName = deriveCanonicalAssetName("skill", typeRoot, skillFilePath)
    if (!canonicalName || canonicalName === entry.name) return entry

    changed = true
    return { ...entry, name: canonicalName }
  })

  if (!changed) {
    return { stash, changed: false }
  }

  return {
    stash: { entries },
    changed: true,
  }
}

async function enhanceStashWithLlm(
  llmConfig: LlmConnectionConfig,
  stash: StashFile,
  dirPath: string,
  files: string[],
): Promise<StashFile> {
  const { enhanceMetadata } = await import("./llm.js")

  const enhanced: StashEntry[] = []
  for (const entry of stash.entries) {
    try {
      // Find the file matching this entry for content context
      const entryFile = entry.entry
        ? files.find((f) => path.basename(f) === entry.entry) ?? files[0]
        : files[0]
      let fileContent: string | undefined
      if (entryFile) {
        try {
          fileContent = fs.readFileSync(entryFile, "utf8")
        } catch { /* ignore unreadable files */ }
      }

      const improvements = await enhanceMetadata(llmConfig, entry, fileContent)
      const updated = { ...entry }
      if (improvements.description) updated.description = improvements.description
      if (improvements.intents?.length) updated.intents = improvements.intents
      if (improvements.tags?.length) updated.tags = improvements.tags
      enhanced.push(updated)
    } catch {
      // LLM enhancement failed for this entry, keep original
      enhanced.push(entry)
    }
  }
  return { entries: enhanced }
}

export function buildSearchText(entry: StashEntry): string {
  const parts: string[] = [entry.name.replace(/[-_]/g, " ")]
  if (entry.description) parts.push(entry.description)
  if (entry.tags) parts.push(entry.tags.join(" "))
  if (entry.examples) parts.push(entry.examples.join(" "))
  if (entry.aliases) parts.push(entry.aliases.join(" "))
  if (entry.intents) parts.push(entry.intents.join(" "))
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
