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
import { walkStash } from "./walker"
import type { LlmConnectionConfig } from "./config"
import {
  openDatabase,
  closeDatabase,
  getMeta,
  setMeta,
  upsertEntry,
  deleteEntriesByDir,
  rebuildFts,
  upsertEmbedding,
  getEntriesByDir,
  getEntryCount,
  isVecAvailable,
  warnIfVecMissing,
  DB_VERSION,
  type DbIndexedEntry,
} from "./db"
import { getDbPath } from "./paths"

// ── Types ───────────────────────────────────────────────────────────────────

export interface IndexResponse {
  stashDir: string
  totalEntries: number
  generatedMetadata: number
  indexPath: string
  mode: "full" | "incremental"
  directoriesScanned: number
  directoriesSkipped: number
  /** Timing counters in milliseconds */
  timing?: { totalMs: number; walkMs: number; embedMs: number; ftsMs: number }
}

// ── Indexer ──────────────────────────────────────────────────────────────────

export async function agentikitIndex(options?: { stashDir?: string; full?: boolean }): Promise<IndexResponse> {
  const stashDir = options?.stashDir || resolveStashDir()

  // Load config and resolve all stash sources
  const { loadConfig } = await import("./config.js")
  const config = loadConfig()
  const { resolveAllStashDirs } = await import("./stash-source.js")
  const allStashDirs = resolveAllStashDirs(stashDir)

  const t0 = Date.now()

  // Open database — pass embedding dimension from config if available
  const dbPath = getDbPath()
  const embeddingDim = config.embedding?.dimension
  const db = openDatabase(dbPath, embeddingDim ? { embeddingDim } : undefined)

  try {
    // Check if we should do incremental
    const prevStashDir = getMeta(db, "stashDir")
    const prevBuiltAt = getMeta(db, "builtAt")
    const isIncremental = !options?.full && prevStashDir === stashDir && !!prevBuiltAt
    const builtAtMs = isIncremental ? new Date(prevBuiltAt!).getTime() : 0

    if (options?.full || !isIncremental) {
      // Wipe all entries for full rebuild or stashDir change
      // Delete from child tables first to respect foreign key constraints
      try { db.exec("DELETE FROM embeddings") } catch { /* ignore */ }
      if (isVecAvailable(db)) {
        try { db.exec("DELETE FROM entries_vec") } catch { /* ignore */ }
      }
      db.exec("DELETE FROM entries_fts")
      db.exec("DELETE FROM entries")
    }

    const tWalkStart = Date.now()

    // Walk stash dirs and index entries
    const { scannedDirs, skippedDirs, generatedCount, dirsNeedingLlm } = indexEntries(db, allStashDirs, stashDir, isIncremental, builtAtMs)

    // Enhance entries with LLM if configured
    await enhanceDirsWithLlm(db, config, dirsNeedingLlm)

    const tWalkEnd = Date.now()

    // Rebuild FTS after all inserts
    rebuildFts(db)
    const tFtsEnd = Date.now()

    // Generate embeddings if semantic search is enabled
    const hasEmbeddings = await generateEmbeddingsForDb(db, config)

    const tEmbedEnd = Date.now()

    // Update metadata
    setMeta(db, "version", String(DB_VERSION))
    setMeta(db, "builtAt", new Date().toISOString())
    setMeta(db, "stashDir", stashDir)
    setMeta(db, "stashDirs", JSON.stringify(allStashDirs))
    setMeta(db, "hasEmbeddings", hasEmbeddings ? "1" : "0")

    const totalEntries = getEntryCount(db)

    // Warn on every index run if using JS fallback with many entries
    warnIfVecMissing(db)

    const tEnd = Date.now()

    return {
      stashDir,
      totalEntries,
      generatedMetadata: generatedCount,
      indexPath: dbPath,
      mode: isIncremental ? "incremental" : "full",
      directoriesScanned: scannedDirs,
      directoriesSkipped: skippedDirs,
      timing: {
        totalMs: tEnd - t0,
        walkMs: tWalkEnd - tWalkStart,
        embedMs: tEmbedEnd - tFtsEnd,
        ftsMs: tFtsEnd - tWalkEnd,
      },
    }
  } finally {
    closeDatabase(db)
  }
}

// ── Extracted helpers for agentikitIndex ─────────────────────────────────────

function indexEntries(
  db: import("bun:sqlite").Database,
  allStashDirs: string[],
  stashDir: string,
  isIncremental: boolean,
  builtAtMs: number,
): { scannedDirs: number; skippedDirs: number; generatedCount: number; dirsNeedingLlm: Array<{ dirPath: string; files: string[]; assetType: AgentikitAssetType; currentStashDir: string }> } {
  let scannedDirs = 0
  let skippedDirs = 0
  let generatedCount = 0
  const seenPaths = new Set<string>()
  const dirsNeedingLlm: Array<{ dirPath: string; files: string[]; assetType: AgentikitAssetType; currentStashDir: string }> = []

  const insertTransaction = db.transaction(() => {
    for (const currentStashDir of allStashDirs) {
      for (const assetType of ASSET_TYPES as AgentikitAssetType[]) {
        const typeRoot = path.join(currentStashDir, TYPE_DIRS[assetType])
        try {
          if (!fs.statSync(typeRoot).isDirectory()) continue
        } catch { continue }

        const dirGroups = walkStash(typeRoot, assetType)

        for (const { dirPath, files } of dirGroups) {
          if (seenPaths.has(path.resolve(dirPath))) continue
          seenPaths.add(path.resolve(dirPath))

          // Incremental: skip directories that haven't changed
          if (isIncremental) {
            const prevEntries = getEntriesByDir(db, dirPath)
            if (prevEntries.length > 0 && !isDirStale(dirPath, files, prevEntries, builtAtMs)) {
              skippedDirs++
              continue
            }
          }

          scannedDirs++

          // Delete old entries for this dir (will be re-inserted)
          deleteEntriesByDir(db, dirPath)

          // Try loading existing .stash.json (user metadata overrides)
          let stash = loadStashFile(dirPath)

          if (stash) {
            const migration = migrateGeneratedSkillMetadata(stash, files, typeRoot)
            if (migration.changed) {
              stash = migration.stash
              writeStashFile(dirPath, stash)
            }

            // Check for files on disk that aren't covered by existing .stash.json entries.
            // This handles the case where new files are added after the initial index.
            const coveredFiles = new Set(
              stash.entries
                .map((e) => e.entry)
                .filter((e): e is string => !!e),
            )
            const uncoveredFiles = files.filter(
              (f) => !coveredFiles.has(path.basename(f)),
            )
            if (uncoveredFiles.length > 0) {
              const generated = generateMetadata(dirPath, assetType, uncoveredFiles, typeRoot)
              if (generated.entries.length > 0) {
                stash = { entries: [...stash.entries, ...generated.entries] }
                writeStashFile(dirPath, stash)
                generatedCount += generated.entries.length
              }
            }
          }

          if (!stash) {
            // Generate metadata heuristically
            stash = generateMetadata(dirPath, assetType, files, typeRoot)
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
              const entryKey = `${currentStashDir}:${entry.type}:${entry.name}`
              const searchText = buildSearchText(entry)

              upsertEntry(db, entryKey, dirPath, entryPath, currentStashDir, entry, searchText)
            }

            // Collect dirs needing LLM enhancement during the first walk
            if (stash.entries.some((e) => e.generated)) {
              dirsNeedingLlm.push({ dirPath, files, assetType, currentStashDir })
            }
          }
        }
      }
    }
  })

  insertTransaction()

  return { scannedDirs, skippedDirs, generatedCount, dirsNeedingLlm }
}

async function enhanceDirsWithLlm(
  db: import("bun:sqlite").Database,
  config: import("./config").AgentikitConfig,
  dirsNeedingLlm: Array<{ dirPath: string; files: string[]; assetType: AgentikitAssetType; currentStashDir: string }>,
): Promise<void> {
  if (!config.llm || dirsNeedingLlm.length === 0) return

  for (const { dirPath, files, currentStashDir } of dirsNeedingLlm) {
    let stash = loadStashFile(dirPath)
    if (!stash) continue
    stash = await enhanceStashWithLlm(config.llm, stash, dirPath, files)
    writeStashFile(dirPath, stash)

    // Re-upsert enhanced entries
    for (const entry of stash.entries) {
      const entryPath = entry.entry ? path.join(dirPath, entry.entry) : files[0] || dirPath
      const entryKey = `${currentStashDir}:${entry.type}:${entry.name}`
      const searchText = buildSearchText(entry)
      upsertEntry(db, entryKey, dirPath, entryPath, currentStashDir, entry, searchText)
    }
  }
}

async function generateEmbeddingsForDb(
  db: import("bun:sqlite").Database,
  config: import("./config").AgentikitConfig,
): Promise<boolean> {
  if (!config.semanticSearch) return false

  try {
    const { embedBatch } = await import("./embedder.js")
    const allEntries = getAllEntriesForEmbedding(db)
    if (allEntries.length === 0) return true
    const texts = allEntries.map((e) => e.searchText)
    const embeddings = await embedBatch(texts, config.embedding)
    for (let i = 0; i < allEntries.length; i++) {
      upsertEmbedding(db, allEntries[i].id, embeddings[i])
    }
    return true
  } catch (error) {
    console.warn("Embedding generation failed, continuing without:", error instanceof Error ? error.message : String(error))
    return false
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function getAllEntriesForEmbedding(db: import("bun:sqlite").Database): Array<{ id: number; searchText: string }> {
  return db
    .prepare(`
      SELECT e.id, e.search_text AS searchText FROM entries e
      WHERE NOT EXISTS (SELECT 1 FROM embeddings b WHERE b.id = e.id)
    `)
    .all() as Array<{ id: number; searchText: string }>
}

function isDirStale(
  dirPath: string,
  currentFiles: string[],
  previousEntries: DbIndexedEntry[],
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
    if (fs.statSync(stashPath).mtimeMs > builtAtMs) return true
  } catch {
    // file doesn't exist, not stale
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
