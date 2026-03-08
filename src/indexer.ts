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
  getDbPath,
  getMeta,
  setMeta,
  upsertEntry,
  deleteEntriesByDir,
  rebuildFts,
  upsertEmbedding,
  getEntriesByDir,
  getEntryCount,
  isVecAvailable,
  DB_VERSION,
  type DbIndexedEntry,
} from "./db"

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
  let generatedCount = 0
  let scannedDirs = 0
  let skippedDirs = 0

  // Open database
  const dbPath = getDbPath()
  const db = openDatabase(dbPath)

  // Check if we should do incremental
  const prevStashDir = getMeta(db, "stashDir")
  const prevBuiltAt = getMeta(db, "builtAt")
  const isIncremental = !options?.full && prevStashDir === stashDir && !!prevBuiltAt
  const builtAtMs = isIncremental ? new Date(prevBuiltAt!).getTime() : 0

  if (options?.full || !isIncremental) {
    // Wipe all entries for full rebuild or stashDir change
    db.exec("DELETE FROM entries")
    db.exec("DELETE FROM entries_fts")
    if (isVecAvailable()) {
      try { db.exec("DELETE FROM entries_vec") } catch { /* ignore */ }
    }
  }

  const seenPaths = new Set<string>()
  const scannedPaths = new Set<string>()
  const tWalkStart = Date.now()

  // Collect entries to insert (inside a transaction for speed)
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
          scannedPaths.add(path.resolve(dirPath))

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
          }
        }
      }
    }
  })

  // Run the synchronous transaction first
  insertTransaction()

  // LLM enhancement needs to happen outside transaction (async)
  // Collect dirs that need LLM enhancement (after transaction so seenPaths is populated)
  const dirsNeedingLlm: Array<{ dirPath: string; files: string[]; assetType: AgentikitAssetType; currentStashDir: string }> = []

  if (config.llm) {
    for (const currentStashDir of allStashDirs) {
      for (const assetType of ASSET_TYPES as AgentikitAssetType[]) {
        const typeRoot = path.join(currentStashDir, TYPE_DIRS[assetType])
        try {
          if (!fs.statSync(typeRoot).isDirectory()) continue
        } catch { continue }

        const dirGroups = walkStash(typeRoot, assetType)
        for (const { dirPath, files } of dirGroups) {
          const resolved = path.resolve(dirPath)
          if (!scannedPaths.has(resolved)) continue // only dirs actually re-scanned

          // Check if this dir's entries were generated (not from manual stash)
          const stash = loadStashFile(dirPath)
          if (stash && stash.entries.some((e) => e.generated)) {
            dirsNeedingLlm.push({ dirPath, files, assetType, currentStashDir })
          }
        }
      }
    }
  }

  // LLM enhancement (async, outside transaction)
  if (config.llm && dirsNeedingLlm.length > 0) {
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

  const tWalkEnd = Date.now()

  // Rebuild FTS after all inserts
  rebuildFts(db)
  const tFtsEnd = Date.now()

  // Generate embeddings if semantic search is enabled
  let hasEmbeddings = false
  if (config.semanticSearch && isVecAvailable()) {
    try {
      const { embed } = await import("./embedder.js")
      const allEntries = getAllEntriesForEmbedding(db)
      for (const { id, searchText } of allEntries) {
        const embedding = await embed(searchText, config.embedding)
        upsertEmbedding(db, id, embedding)
      }
      hasEmbeddings = true
    } catch {
      // Embedding provider not available, continue without
    }
  }

  const tEmbedEnd = Date.now()

  // Update metadata
  setMeta(db, "version", String(DB_VERSION))
  setMeta(db, "builtAt", new Date().toISOString())
  setMeta(db, "stashDir", stashDir)
  setMeta(db, "stashDirs", JSON.stringify(allStashDirs))
  setMeta(db, "hasEmbeddings", hasEmbeddings ? "1" : "0")

  const totalEntries = getEntryCount(db)
  closeDatabase(db)

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
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function getAllEntriesForEmbedding(db: import("bun:sqlite").Database): Array<{ id: number; searchText: string }> {
  return db
    .prepare(`
      SELECT e.id, e.search_text AS searchText FROM entries e
      WHERE NOT EXISTS (SELECT 1 FROM entries_vec v WHERE v.id = e.id)
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
