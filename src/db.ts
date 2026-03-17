import { Database } from "bun:sqlite";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { cosineSimilarity, type EmbeddingVector } from "./embedder";
import type { StashEntry } from "./metadata";
import { getDbPath } from "./paths";
import { warn } from "./warn";

// ── Types ───────────────────────────────────────────────────────────────────

export interface DbIndexedEntry {
  id: number;
  entryKey: string;
  dirPath: string;
  filePath: string;
  stashDir: string;
  entry: StashEntry;
  searchText: string;
}

export interface DbSearchResult {
  id: number;
  filePath: string;
  entry: StashEntry;
  searchText: string;
  bm25Score: number;
}

export interface DbVecResult {
  id: number;
  distance: number;
}

// ── Constants ───────────────────────────────────────────────────────────────

export const DB_VERSION = 7;
export const EMBEDDING_DIM = 384;

// ── Database lifecycle ──────────────────────────────────────────────────────

export function openDatabase(dbPath?: string, options?: { embeddingDim?: number }): Database {
  const resolvedPath = dbPath ?? getDbPath();
  const dir = path.dirname(resolvedPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(resolvedPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");

  // Try to load sqlite-vec extension
  loadVecExtension(db);

  ensureSchema(db, options?.embeddingDim ?? EMBEDDING_DIM);

  // Warn once at init if using JS fallback with many entries
  warnIfVecMissing(db, { once: true });

  return db;
}

export function closeDatabase(db: Database): void {
  db.close();
}

// ── sqlite-vec extension ────────────────────────────────────────────────────

const vecStatus = new WeakMap<Database, boolean>();

function loadVecExtension(db: Database): void {
  try {
    const esmRequire = createRequire(import.meta.url);
    const sqliteVec = esmRequire("sqlite-vec");
    sqliteVec.load(db);
    vecStatus.set(db, true);
  } catch {
    vecStatus.set(db, false);
  }
}

export function isVecAvailable(db: Database): boolean {
  return vecStatus.get(db) ?? false;
}

const VEC_DOCS_URL = "https://github.com/itlackey/agentikit/blob/main/docs/configuration.md#sqlite-vec-extension";
const VEC_FALLBACK_THRESHOLD = 10_000;
// Per-database warning state: tracks which databases have already emitted the
// vec-missing warning so we don't spam on every openDatabase() call.
const vecInitWarnedDbs = new WeakSet<Database>();

/**
 * Warn if sqlite-vec is unavailable and embedding count exceeds threshold.
 * Called from openDatabase (once at init) and from indexer (each run).
 */
export function warnIfVecMissing(db: Database, { once }: { once: boolean } = { once: false }): void {
  if (isVecAvailable(db)) return;
  if (once && vecInitWarnedDbs.has(db)) return;

  try {
    const row = db.prepare("SELECT COUNT(*) AS cnt FROM embeddings").get() as { cnt: number } | undefined;
    const count = row?.cnt ?? 0;
    if (count >= VEC_FALLBACK_THRESHOLD) {
      warn(
        "Semantic search is using JS fallback for %d entries. Install sqlite-vec for faster performance.\n  See: %s",
        count,
        VEC_DOCS_URL,
      );
      if (once) vecInitWarnedDbs.add(db);
    }
  } catch {
    /* embeddings table may not exist yet during init */
  }
}

// ── Schema ──────────────────────────────────────────────────────────────────

function ensureSchema(db: Database, embeddingDim: number): void {
  // Create meta table first so we can check version
  db.exec(`
    CREATE TABLE IF NOT EXISTS index_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Check stored version — if it differs from DB_VERSION, drop and recreate all tables
  const storedVersion = getMeta(db, "version");
  if (storedVersion && storedVersion !== String(DB_VERSION)) {
    db.exec("DROP TABLE IF EXISTS embeddings");
    db.exec("DROP TABLE IF EXISTS entries_vec");
    db.exec("DROP TABLE IF EXISTS entries_fts");
    db.exec("DROP INDEX IF EXISTS idx_entries_dir");
    db.exec("DROP INDEX IF EXISTS idx_entries_type");
    db.exec("DROP TABLE IF EXISTS entries");
    db.exec("DELETE FROM index_meta");
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
  `);

  // Set version immediately after table creation so a crash before the end of
  // ensureSchema() does not leave the database in a versionless state on next open.
  const versionAfterCreate = getMeta(db, "version");
  if (!versionAfterCreate) {
    setMeta(db, "version", String(DB_VERSION));
  }

  // BLOB-based embedding storage (always available, no sqlite-vec needed)
  db.exec(`
    CREATE TABLE IF NOT EXISTS embeddings (
      id        INTEGER PRIMARY KEY,
      embedding BLOB NOT NULL,
      FOREIGN KEY (id) REFERENCES entries(id)
    );
  `);

  // FTS5 table — multi-column with per-field weighting via bm25()
  const ftsExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='entries_fts'").get();
  if (!ftsExists) {
    db.exec(`
      CREATE VIRTUAL TABLE entries_fts USING fts5(
        entry_id UNINDEXED,
        name,
        description,
        tags,
        hints,
        content,
        tokenize='porter unicode61'
      );
    `);
  }

  // sqlite-vec table
  if (isVecAvailable(db)) {
    // Check if stored embedding dimension differs from configured one
    const storedDim = getMeta(db, "embeddingDim");
    if (storedDim && storedDim !== String(embeddingDim)) {
      try {
        db.exec("DROP TABLE IF EXISTS entries_vec");
      } catch {
        /* ignore */
      }
      // CR-2: Delete stale BLOB embeddings so they don't produce silently wrong
      // similarity scores against the new-dimension vec table.
      try {
        db.exec("DELETE FROM embeddings");
      } catch {
        /* ignore */
      }
    }

    const vecExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='entries_vec'").get();
    if (!vecExists) {
      if (!Number.isInteger(embeddingDim) || embeddingDim <= 0 || embeddingDim > 4096) {
        throw new Error(`Invalid embedding dimension: ${embeddingDim}`);
      }
      db.exec(`
        CREATE VIRTUAL TABLE entries_vec USING vec0(
          id       INTEGER PRIMARY KEY,
          embedding FLOAT[${embeddingDim}]
        );
      `);
    }
    setMeta(db, "embeddingDim", String(embeddingDim));
  }
}

// ── Meta helpers ────────────────────────────────────────────────────────────

export function getMeta(db: Database, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM index_meta WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value;
}

export function setMeta(db: Database, key: string, value: string): void {
  db.prepare("INSERT OR REPLACE INTO index_meta (key, value) VALUES (?, ?)").run(key, value);
}

// ── Entry operations ────────────────────────────────────────────────────────

/**
 * Insert or update an entry in the `entries` table. Returns the row id.
 *
 * **Important:** This does not update the FTS index. Callers must call
 * `rebuildFts()` after all upserts are complete for full-text search to
 * reflect the changes.
 */
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
  `);
  stmt.run(entryKey, dirPath, filePath, stashDir, JSON.stringify(entry), searchText, entry.type);
  // Fetch the row id explicitly since last_insert_rowid() is unreliable for ON CONFLICT DO UPDATE
  const row = db.prepare("SELECT id FROM entries WHERE entry_key = ?").get(entryKey) as { id: number } | undefined;
  if (!row) throw new Error("upsertEntry: entry_key not found after upsert");
  return row.id;
}

export function deleteEntriesByDir(db: Database, dirPath: string): void {
  db.transaction(() => {
    const ids = db.prepare("SELECT id FROM entries WHERE dir_path = ?").all(dirPath) as Array<{ id: number }>;
    deleteRelatedRows(db, ids);
    db.prepare("DELETE FROM entries WHERE dir_path = ?").run(dirPath);
  })();
}

export function deleteEntriesByStashDir(db: Database, stashDir: string): void {
  db.transaction(() => {
    const ids = db.prepare("SELECT id FROM entries WHERE stash_dir = ?").all(stashDir) as Array<{ id: number }>;
    deleteRelatedRows(db, ids);
    db.prepare("DELETE FROM entries WHERE stash_dir = ?").run(stashDir);
  })();
}

const SQLITE_CHUNK_SIZE = 500;

function deleteRelatedRows(db: Database, ids: Array<{ id: number }>): void {
  if (ids.length === 0) return;
  const numericIds = ids.map((r) => r.id);
  const vecAvail = isVecAvailable(db);

  // Process in chunks to stay within SQLITE_MAX_VARIABLE_NUMBER
  for (let i = 0; i < numericIds.length; i += SQLITE_CHUNK_SIZE) {
    const chunk = numericIds.slice(i, i + SQLITE_CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(",");
    try {
      db.prepare(`DELETE FROM embeddings WHERE id IN (${placeholders})`).run(...chunk);
    } catch {
      /* ignore */
    }
    // HI-1: Also delete from FTS table so orphaned FTS rows don't remain
    try {
      db.prepare(`DELETE FROM entries_fts WHERE entry_id IN (${placeholders})`).run(...chunk);
    } catch {
      /* ignore */
    }
    if (vecAvail) {
      try {
        db.prepare(`DELETE FROM entries_vec WHERE id IN (${placeholders})`).run(...chunk);
      } catch {
        /* ignore */
      }
    }
  }
}

export function rebuildFts(db: Database): void {
  // CR-1: Wrap DELETE + INSERT in a single transaction so the FTS table is
  // never left empty between the two statements if a crash occurs.
  // HI-14: Store the integer id directly (FTS5 stores all content as text
  // internally; the join in searchFts compares numerically without CAST).
  //
  // S-3: Insert into separate FTS5 columns by extracting per-field text from
  // the entry_json using buildSearchFields(). The entries.search_text column
  // is kept as a concatenated fallback for embedding generation.
  // Lazy require() to avoid a circular module dependency:
  // indexer.ts imports from db.ts, so a static import here would create a cycle.
  const { buildSearchFields } = require("./indexer") as typeof import("./indexer");

  db.transaction(() => {
    db.exec("DELETE FROM entries_fts");

    const rows = db.prepare("SELECT id, entry_json FROM entries").all() as Array<{
      id: number;
      entry_json: string;
    }>;

    const insertStmt = db.prepare(
      "INSERT INTO entries_fts (entry_id, name, description, tags, hints, content) VALUES (?, ?, ?, ?, ?, ?)",
    );

    for (const row of rows) {
      let entry: import("./metadata").StashEntry;
      let fields: ReturnType<typeof buildSearchFields>;
      try {
        entry = JSON.parse(row.entry_json) as import("./metadata").StashEntry;
        fields = buildSearchFields(entry);
      } catch {
        console.warn(`[db] rebuildFts: skipping entry id=${row.id} — invalid entry_json`);
        continue;
      }
      insertStmt.run(row.id, fields.name, fields.description, fields.tags, fields.hints, fields.content);
    }
  })();
}

// ── Vector operations ───────────────────────────────────────────────────────

export function upsertEmbedding(db: Database, entryId: number, embedding: EmbeddingVector): void {
  const buf = float32Buffer(embedding);

  // Always write to BLOB table (works without sqlite-vec)
  db.prepare("INSERT OR REPLACE INTO embeddings (id, embedding) VALUES (?, ?)").run(entryId, buf);

  // Also write to sqlite-vec table when available (fast path)
  if (isVecAvailable(db)) {
    try {
      db.prepare("DELETE FROM entries_vec WHERE id = ?").run(entryId);
    } catch {
      /* ignore */
    }
    db.prepare("INSERT INTO entries_vec (id, embedding) VALUES (?, ?)").run(entryId, buf);
  }
}

export function searchVec(db: Database, queryEmbedding: EmbeddingVector, k: number): DbVecResult[] {
  // Fast path: use sqlite-vec when available
  if (isVecAvailable(db)) {
    const buf = float32Buffer(queryEmbedding);
    try {
      return db
        .prepare("SELECT id, distance FROM entries_vec WHERE embedding MATCH ? AND k = ?")
        .all(buf, k) as DbVecResult[];
    } catch (err) {
      // MD-5: Log the failure so it's visible in diagnostics
      console.warn("[db] searchVec (sqlite-vec path) failed:", err instanceof Error ? err.message : String(err));
      return [];
    }
  }

  // Fallback: JS-based cosine similarity over BLOB table
  return searchBlobVec(db, queryEmbedding, k);
}

function float32Buffer(vec: number[]): Buffer {
  const f32 = new Float32Array(vec);
  return Buffer.from(f32.buffer);
}

function bufferToFloat32(buf: Buffer): number[] {
  const f32 = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  return Array.from(f32);
}

function searchBlobVec(db: Database, queryEmbedding: EmbeddingVector, k: number): DbVecResult[] {
  try {
    const rows = db.prepare("SELECT id, embedding FROM embeddings").all() as Array<{ id: number; embedding: Buffer }>;

    if (rows.length === 0) return [];

    const scored: Array<{ id: number; similarity: number }> = [];
    for (const row of rows) {
      const embedding = bufferToFloat32(row.embedding);
      const similarity = cosineSimilarity(queryEmbedding, embedding);
      scored.push({ id: row.id, similarity });
    }

    scored.sort((a, b) => b.similarity - a.similarity);

    // Convert cosine similarity to L2 distance for compatibility with sqlite-vec interface
    // For normalized vectors: L2² = 2(1 - cos_sim)
    return scored.slice(0, k).map(({ id, similarity }) => ({
      id,
      distance: Math.sqrt(2 * Math.max(0, 1 - similarity)),
    }));
  } catch (err) {
    // MD-5: Log the failure so it's visible in diagnostics
    console.warn("[db] searchBlobVec (JS fallback) failed:", err instanceof Error ? err.message : String(err));
    return [];
  }
}

// ── FTS5 search ─────────────────────────────────────────────────────────────

export function searchFts(db: Database, query: string, limit: number, entryType?: string): DbSearchResult[] {
  const ftsQuery = sanitizeFtsQuery(query);
  if (!ftsQuery) return [];

  let sql: string;
  let params: unknown[];

  // HI-14: Join on integer entry_id directly (no CAST needed; we store integer)
  // S-3: Use bm25() with per-column weights: entry_id(0), name(10), description(5), tags(3), hints(2), content(1)
  if (entryType && entryType !== "any") {
    sql = `
      SELECT e.id, e.file_path AS filePath, e.entry_json, e.search_text AS searchText,
             bm25(entries_fts, 0, 10.0, 5.0, 3.0, 2.0, 1.0) AS bm25Score
      FROM entries_fts f
      JOIN entries e ON e.id = f.entry_id
      WHERE entries_fts MATCH ?
        AND e.entry_type = ?
      ORDER BY bm25Score
      LIMIT ?
    `;
    params = [ftsQuery, entryType, limit];
  } else {
    sql = `
      SELECT e.id, e.file_path AS filePath, e.entry_json, e.search_text AS searchText,
             bm25(entries_fts, 0, 10.0, 5.0, 3.0, 2.0, 1.0) AS bm25Score
      FROM entries_fts f
      JOIN entries e ON e.id = f.entry_id
      WHERE entries_fts MATCH ?
      ORDER BY bm25Score
      LIMIT ?
    `;
    params = [ftsQuery, limit];
  }

  try {
    const rows = db.prepare(sql).all(...(params as import("bun:sqlite").SQLQueryBindings[])) as Array<{
      id: number;
      filePath: string;
      entry_json: string;
      searchText: string;
      bm25Score: number;
    }>;

    // CR-6: Guard against corrupt JSON — skip the row rather than crashing
    const results: DbSearchResult[] = [];
    for (const row of rows) {
      let entry: StashEntry;
      try {
        entry = JSON.parse(row.entry_json) as StashEntry;
      } catch {
        console.warn(`[db] searchFts: skipping entry id=${row.id} — corrupt entry_json`);
        continue;
      }
      results.push({
        id: row.id,
        filePath: row.filePath,
        entry,
        searchText: row.searchText,
        bm25Score: row.bm25Score,
      });
    }
    return results;
  } catch {
    return [];
  }
}

export function sanitizeFtsQuery(query: string): string {
  // Allow only characters safe in FTS5 queries: letters, digits, underscores,
  // and whitespace. Everything else (hyphens, dots, quotes, parens, asterisks,
  // colons, carets, @, !, etc.) is replaced with a space so that compound
  // identifiers like "code-review" or "k8s.setup" become AND-joined tokens
  // ("code review", "k8s setup") rather than triggering FTS5 syntax errors.
  let sanitized = query.replace(/[^a-zA-Z0-9_\s]/g, " ");

  // Neutralize the NEAR operator (FTS5 proximity syntax)
  sanitized = sanitized.replace(/\bNEAR\b/g, " ");

  const tokens = sanitized.split(/\s+/).filter((t) => t.length >= 1);

  if (tokens.length === 0) return "";

  // Use implicit AND (space-separated tokens) for precision. FTS5 treats
  // space-separated tokens as an implicit AND, matching only rows that
  // contain ALL terms.
  return tokens.join(" ");
}

// ── All entries ─────────────────────────────────────────────────────────────

export function getAllEntries(db: Database, entryType?: string): DbIndexedEntry[] {
  let sql: string;
  let params: unknown[];

  if (entryType && entryType !== "any") {
    sql =
      "SELECT id, entry_key, dir_path, file_path, stash_dir, entry_json, search_text FROM entries WHERE entry_type = ?";
    params = [entryType];
  } else {
    sql = "SELECT id, entry_key, dir_path, file_path, stash_dir, entry_json, search_text FROM entries";
    params = [];
  }

  const rows = db.prepare(sql).all(...(params as import("bun:sqlite").SQLQueryBindings[])) as Array<{
    id: number;
    entry_key: string;
    dir_path: string;
    file_path: string;
    stash_dir: string;
    entry_json: string;
    search_text: string;
  }>;

  // CR-6: Guard against corrupt JSON — skip the row rather than crashing
  const entries: DbIndexedEntry[] = [];
  for (const row of rows) {
    let entry: StashEntry;
    try {
      entry = JSON.parse(row.entry_json) as StashEntry;
    } catch {
      console.warn(`[db] getAllEntries: skipping entry id=${row.id} — corrupt entry_json`);
      continue;
    }
    entries.push({
      id: row.id,
      entryKey: row.entry_key,
      dirPath: row.dir_path,
      filePath: row.file_path,
      stashDir: row.stash_dir,
      entry,
      searchText: row.search_text,
    });
  }
  return entries;
}

export function getEntryCount(db: Database): number {
  const row = db.prepare("SELECT COUNT(*) AS cnt FROM entries").get() as { cnt: number };
  return row.cnt;
}

export function getEntryById(db: Database, id: number): { filePath: string; entry: StashEntry } | undefined {
  const row = db.prepare("SELECT file_path, entry_json FROM entries WHERE id = ?").get(id) as
    | { file_path: string; entry_json: string }
    | undefined;
  if (!row) return undefined;
  // CR-6: Guard against corrupt JSON
  let entry: StashEntry;
  try {
    entry = JSON.parse(row.entry_json) as StashEntry;
  } catch {
    console.warn(`[db] getEntryById: skipping entry id=${id} — corrupt entry_json`);
    return undefined;
  }
  return { filePath: row.file_path, entry };
}

export function getEntriesByDir(db: Database, dirPath: string): DbIndexedEntry[] {
  const rows = db
    .prepare(
      "SELECT id, entry_key, dir_path, file_path, stash_dir, entry_json, search_text FROM entries WHERE dir_path = ?",
    )
    .all(dirPath) as Array<{
    id: number;
    entry_key: string;
    dir_path: string;
    file_path: string;
    stash_dir: string;
    entry_json: string;
    search_text: string;
  }>;

  // CR-6: Guard against corrupt JSON — skip the row rather than crashing
  const entries: DbIndexedEntry[] = [];
  for (const row of rows) {
    let entry: StashEntry;
    try {
      entry = JSON.parse(row.entry_json) as StashEntry;
    } catch {
      console.warn(`[db] getEntriesByDir: skipping entry id=${row.id} — corrupt entry_json`);
      continue;
    }
    entries.push({
      id: row.id,
      entryKey: row.entry_key,
      dirPath: row.dir_path,
      filePath: row.file_path,
      stashDir: row.stash_dir,
      entry,
      searchText: row.search_text,
    });
  }
  return entries;
}
