import fs from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"
import { Database } from "bun:sqlite"
import type { StashEntry } from "./metadata"
import { cosineSimilarity, type EmbeddingVector } from "./embedder"
import { getDbPath as _getDbPath } from "./paths"

// ── Types ───────────────────────────────────────────────────────────────────

export interface DbIndexedEntry {
  id: number
  entryKey: string
  dirPath: string
  filePath: string
  stashDir: string
  entry: StashEntry
  searchText: string
}

export interface DbSearchResult {
  id: number
  filePath: string
  entry: StashEntry
  searchText: string
  bm25Score: number
}

export interface DbVecResult {
  id: number
  distance: number
}

// ── Constants ───────────────────────────────────────────────────────────────

export const DB_VERSION = 6
export const EMBEDDING_DIM = 384

// ── Path ────────────────────────────────────────────────────────────────────

export function getDbPath(): string {
  return _getDbPath()
}

// ── Database lifecycle ──────────────────────────────────────────────────────

export function openDatabase(dbPath?: string, options?: { embeddingDim?: number }): Database {
  const resolvedPath = dbPath ?? getDbPath()
  const dir = path.dirname(resolvedPath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }

  const db = new Database(resolvedPath)
  db.exec("PRAGMA journal_mode = WAL")
  db.exec("PRAGMA foreign_keys = ON")

  // Try to load sqlite-vec extension
  loadVecExtension(db)

  ensureSchema(db, options?.embeddingDim ?? EMBEDDING_DIM)

  // Warn once at init if using JS fallback with many entries
  warnIfVecMissing(db, { once: true })

  return db
}

export function closeDatabase(db: Database): void {
  db.close()
}

// ── sqlite-vec extension ────────────────────────────────────────────────────

const vecStatus = new WeakMap<Database, boolean>()

function loadVecExtension(db: Database): void {
  try {
    const esmRequire = createRequire(import.meta.url)
    const sqliteVec = esmRequire("sqlite-vec")
    sqliteVec.load(db)
    vecStatus.set(db, true)
  } catch {
    vecStatus.set(db, false)
  }
}

export function isVecAvailable(db: Database): boolean {
  return vecStatus.get(db) ?? false
}

const VEC_DOCS_URL = "https://github.com/itlackey/agentikit/blob/main/docs/configuration.md#sqlite-vec-extension"
const VEC_FALLBACK_THRESHOLD = 10_000
let vecInitWarned = false

/**
 * Warn if sqlite-vec is unavailable and embedding count exceeds threshold.
 * Called from openDatabase (once at init) and from indexer (each run).
 */
export function warnIfVecMissing(db: Database, { once }: { once: boolean } = { once: false }): void {
  if (isVecAvailable(db)) return
  if (once && vecInitWarned) return

  try {
    const row = db.prepare("SELECT COUNT(*) AS cnt FROM embeddings").get() as { cnt: number } | undefined
    const count = row?.cnt ?? 0
    if (count >= VEC_FALLBACK_THRESHOLD) {
      console.warn(
        "Semantic search is using JS fallback for %d entries. Install sqlite-vec for faster performance.\n  See: %s",
        count,
        VEC_DOCS_URL,
      )
      if (once) vecInitWarned = true
    }
  } catch { /* embeddings table may not exist yet during init */ }
}

// ── Schema ──────────────────────────────────────────────────────────────────

function ensureSchema(db: Database, embeddingDim: number): void {
  // Create meta table first so we can check version
  db.exec(`
    CREATE TABLE IF NOT EXISTS index_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `)

  // Check stored version — if it differs from DB_VERSION, drop and recreate all tables
  const storedVersion = getMeta(db, "version")
  if (storedVersion && storedVersion !== String(DB_VERSION)) {
    db.exec("DROP TABLE IF EXISTS embeddings")
    db.exec("DROP TABLE IF EXISTS entries_vec")
    db.exec("DROP TABLE IF EXISTS entries_fts")
    db.exec("DROP INDEX IF EXISTS idx_entries_dir")
    db.exec("DROP INDEX IF EXISTS idx_entries_type")
    db.exec("DROP TABLE IF EXISTS entries")
    db.exec("DELETE FROM index_meta")
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS entries (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      entry_key   TEXT NOT NULL UNIQUE,
      dir_path    TEXT NOT NULL,
      file_path   TEXT NOT NULL,
      stash_dir   TEXT NOT NULL,
      entry_json  TEXT NOT NULL,
      search_text TEXT NOT NULL,
      entry_type  TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_entries_dir ON entries(dir_path);
    CREATE INDEX IF NOT EXISTS idx_entries_type ON entries(entry_type);
  `)

  // BLOB-based embedding storage (always available, no sqlite-vec needed)
  db.exec(`
    CREATE TABLE IF NOT EXISTS embeddings (
      id        INTEGER PRIMARY KEY,
      embedding BLOB NOT NULL,
      FOREIGN KEY (id) REFERENCES entries(id)
    );
  `)

  // FTS5 table — standalone with explicit entry_id for joining
  const ftsExists = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='entries_fts'")
    .get()
  if (!ftsExists) {
    db.exec(`
      CREATE VIRTUAL TABLE entries_fts USING fts5(
        entry_id UNINDEXED,
        search_text,
        tokenize='porter unicode61'
      );
    `)
  }

  // sqlite-vec table
  if (isVecAvailable(db)) {
    // Check if stored embedding dimension differs from configured one
    const storedDim = getMeta(db, "embeddingDim")
    if (storedDim && storedDim !== String(embeddingDim)) {
      try { db.exec("DROP TABLE IF EXISTS entries_vec") } catch { /* ignore */ }
    }

    const vecExists = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='entries_vec'")
      .get()
    if (!vecExists) {
      db.exec(`
        CREATE VIRTUAL TABLE entries_vec USING vec0(
          id       INTEGER PRIMARY KEY,
          embedding FLOAT[${embeddingDim}]
        );
      `)
    }
    setMeta(db, "embeddingDim", String(embeddingDim))
  }

  // Set version if not present
  const version = getMeta(db, "version")
  if (!version) {
    setMeta(db, "version", String(DB_VERSION))
  }
}

// ── Meta helpers ────────────────────────────────────────────────────────────

export function getMeta(db: Database, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM index_meta WHERE key = ?").get(key) as
    | { value: string }
    | undefined
  return row?.value
}

export function setMeta(db: Database, key: string, value: string): void {
  db.prepare("INSERT OR REPLACE INTO index_meta (key, value) VALUES (?, ?)").run(key, value)
}

// ── Entry operations ────────────────────────────────────────────────────────

export function upsertEntry(
  db: Database,
  entryKey: string,
  dirPath: string,
  filePath: string,
  stashDir: string,
  entry: StashEntry,
  searchText: string,
): number {
  const stmt = db.prepare(`
    INSERT INTO entries (entry_key, dir_path, file_path, stash_dir, entry_json, search_text, entry_type)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(entry_key) DO UPDATE SET
      dir_path = excluded.dir_path,
      file_path = excluded.file_path,
      stash_dir = excluded.stash_dir,
      entry_json = excluded.entry_json,
      search_text = excluded.search_text,
      entry_type = excluded.entry_type
  `)
  stmt.run(entryKey, dirPath, filePath, stashDir, JSON.stringify(entry), searchText, entry.type)
  // Fetch the row id explicitly since last_insert_rowid() is unreliable for ON CONFLICT DO UPDATE
  const row = db.prepare("SELECT id FROM entries WHERE entry_key = ?").get(entryKey) as { id: number }
  return row.id
}

export function deleteEntriesByDir(db: Database, dirPath: string): void {
  const ids = db
    .prepare("SELECT id FROM entries WHERE dir_path = ?")
    .all(dirPath) as Array<{ id: number }>
  for (const { id } of ids) {
    try {
      db.prepare("DELETE FROM embeddings WHERE id = ?").run(id)
    } catch { /* ignore */ }
    if (isVecAvailable(db)) {
      try {
        db.prepare("DELETE FROM entries_vec WHERE id = ?").run(id)
      } catch { /* ignore */ }
    }
  }
  db.prepare("DELETE FROM entries WHERE dir_path = ?").run(dirPath)
}

export function rebuildFts(db: Database): void {
  db.exec("DELETE FROM entries_fts")
  db.exec("INSERT INTO entries_fts (entry_id, search_text) SELECT CAST(id AS TEXT), search_text FROM entries")
}

// ── Vector operations ───────────────────────────────────────────────────────

export function upsertEmbedding(
  db: Database,
  entryId: number,
  embedding: EmbeddingVector,
): void {
  const buf = float32Buffer(embedding)

  // Always write to BLOB table (works without sqlite-vec)
  db.prepare("INSERT OR REPLACE INTO embeddings (id, embedding) VALUES (?, ?)").run(entryId, buf)

  // Also write to sqlite-vec table when available (fast path)
  if (isVecAvailable(db)) {
    try {
      db.prepare("DELETE FROM entries_vec WHERE id = ?").run(entryId)
    } catch { /* ignore */ }
    db.prepare("INSERT INTO entries_vec (id, embedding) VALUES (?, ?)").run(entryId, buf)
  }
}

export function searchVec(
  db: Database,
  queryEmbedding: EmbeddingVector,
  k: number,
): DbVecResult[] {
  // Fast path: use sqlite-vec when available
  if (isVecAvailable(db)) {
    const buf = float32Buffer(queryEmbedding)
    try {
      return db
        .prepare("SELECT id, distance FROM entries_vec WHERE embedding MATCH ? AND k = ?")
        .all(buf, k) as DbVecResult[]
    } catch {
      return []
    }
  }

  // Fallback: JS-based cosine similarity over BLOB table
  return searchBlobVec(db, queryEmbedding, k)
}

function float32Buffer(vec: number[]): Buffer {
  const f32 = new Float32Array(vec)
  return Buffer.from(f32.buffer)
}

function bufferToFloat32(buf: Buffer): number[] {
  const f32 = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)
  return Array.from(f32)
}

function searchBlobVec(
  db: Database,
  queryEmbedding: EmbeddingVector,
  k: number,
): DbVecResult[] {
  try {
    const rows = db
      .prepare("SELECT id, embedding FROM embeddings")
      .all() as Array<{ id: number; embedding: Buffer }>

    if (rows.length === 0) return []

    const scored: Array<{ id: number; similarity: number }> = []
    for (const row of rows) {
      const embedding = bufferToFloat32(row.embedding)
      const similarity = cosineSimilarity(queryEmbedding, embedding)
      scored.push({ id: row.id, similarity })
    }

    scored.sort((a, b) => b.similarity - a.similarity)

    // Convert cosine similarity to L2 distance for compatibility with sqlite-vec interface
    // For normalized vectors: L2² = 2(1 - cos_sim)
    return scored.slice(0, k).map(({ id, similarity }) => ({
      id,
      distance: Math.sqrt(2 * Math.max(0, 1 - similarity)),
    }))
  } catch {
    return []
  }
}

// ── FTS5 search ─────────────────────────────────────────────────────────────

export function searchFts(
  db: Database,
  query: string,
  limit: number,
  entryType?: string,
): DbSearchResult[] {
  const ftsQuery = sanitizeFtsQuery(query)
  if (!ftsQuery) return []

  let sql: string
  let params: unknown[]

  if (entryType && entryType !== "any") {
    sql = `
      SELECT e.id, e.file_path AS filePath, e.entry_json, e.search_text AS searchText,
             bm25(entries_fts) AS bm25Score
      FROM entries_fts f
      JOIN entries e ON e.id = CAST(f.entry_id AS INTEGER)
      WHERE entries_fts MATCH ?
        AND e.entry_type = ?
      ORDER BY bm25Score
      LIMIT ?
    `
    params = [ftsQuery, entryType, limit]
  } else {
    sql = `
      SELECT e.id, e.file_path AS filePath, e.entry_json, e.search_text AS searchText,
             bm25(entries_fts) AS bm25Score
      FROM entries_fts f
      JOIN entries e ON e.id = CAST(f.entry_id AS INTEGER)
      WHERE entries_fts MATCH ?
      ORDER BY bm25Score
      LIMIT ?
    `
    params = [ftsQuery, limit]
  }

  try {
    const rows = db.prepare(sql).all(...(params as import("bun:sqlite").SQLQueryBindings[])) as Array<{
      id: number
      filePath: string
      entry_json: string
      searchText: string
      bm25Score: number
    }>

    return rows.map((row) => ({
      id: row.id,
      filePath: row.filePath,
      entry: JSON.parse(row.entry_json) as StashEntry,
      searchText: row.searchText,
      bm25Score: row.bm25Score,
    }))
  } catch {
    return []
  }
}

function sanitizeFtsQuery(query: string): string {
  const tokens = query
    .replace(/[^a-zA-Z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1)
  if (tokens.length === 0) return ""
  // Use unquoted tokens so the porter stemmer can normalize word forms
  return tokens.join(" ")
}

// ── All entries ─────────────────────────────────────────────────────────────

export function getAllEntries(
  db: Database,
  entryType?: string,
): DbIndexedEntry[] {
  let sql: string
  let params: unknown[]

  if (entryType && entryType !== "any") {
    sql = "SELECT id, entry_key, dir_path, file_path, stash_dir, entry_json, search_text FROM entries WHERE entry_type = ?"
    params = [entryType]
  } else {
    sql = "SELECT id, entry_key, dir_path, file_path, stash_dir, entry_json, search_text FROM entries"
    params = []
  }

  const rows = db.prepare(sql).all(...(params as import("bun:sqlite").SQLQueryBindings[])) as Array<{
    id: number
    entry_key: string
    dir_path: string
    file_path: string
    stash_dir: string
    entry_json: string
    search_text: string
  }>

  return rows.map((row) => ({
    id: row.id,
    entryKey: row.entry_key,
    dirPath: row.dir_path,
    filePath: row.file_path,
    stashDir: row.stash_dir,
    entry: JSON.parse(row.entry_json) as StashEntry,
    searchText: row.search_text,
  }))
}

export function getEntryCount(db: Database): number {
  const row = db.prepare("SELECT COUNT(*) AS cnt FROM entries").get() as { cnt: number }
  return row.cnt
}

export function getEntryById(db: Database, id: number): { filePath: string; entry: StashEntry } | undefined {
  const row = db
    .prepare("SELECT file_path, entry_json FROM entries WHERE id = ?")
    .get(id) as { file_path: string; entry_json: string } | undefined
  if (!row) return undefined
  return { filePath: row.file_path, entry: JSON.parse(row.entry_json) as StashEntry }
}

export function getEntriesByDir(db: Database, dirPath: string): DbIndexedEntry[] {
  const rows = db
    .prepare(
      "SELECT id, entry_key, dir_path, file_path, stash_dir, entry_json, search_text FROM entries WHERE dir_path = ?",
    )
    .all(dirPath) as Array<{
    id: number
    entry_key: string
    dir_path: string
    file_path: string
    stash_dir: string
    entry_json: string
    search_text: string
  }>

  return rows.map((row) => ({
    id: row.id,
    entryKey: row.entry_key,
    dirPath: row.dir_path,
    filePath: row.file_path,
    stashDir: row.stash_dir,
    entry: JSON.parse(row.entry_json) as StashEntry,
    searchText: row.search_text,
  }))
}
