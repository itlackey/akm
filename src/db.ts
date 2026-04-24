import { Database } from "bun:sqlite";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { cosineSimilarity, type EmbeddingVector } from "./embedders/types";
import type { StashEntry } from "./metadata";
import { getDbPath } from "./paths";
import { buildSearchFields } from "./search-fields";
import { ensureUsageEventsSchema } from "./usage-events";
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

export const DB_VERSION = 8;
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

const VEC_DOCS_URL = "https://github.com/itlackey/akm/blob/main/docs/configuration.md#sqlite-vec-extension";
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

  // Check stored version — if it differs from DB_VERSION, drop and recreate all tables.
  // Usage events are preserved across version upgrades so that utility score
  // history is not silently lost.
  const storedVersion = getMeta(db, "version");
  if (storedVersion && storedVersion !== String(DB_VERSION)) {
    // Back up usage_events before dropping tables
    let usageBackup: Array<Record<string, unknown>> = [];
    try {
      usageBackup = db.prepare("SELECT * FROM usage_events").all() as typeof usageBackup;
    } catch {
      /* table may not exist in older versions */
    }

    db.exec("DROP TABLE IF EXISTS utility_scores");
    db.exec("DROP TABLE IF EXISTS usage_events");
    db.exec("DROP TABLE IF EXISTS embeddings");
    db.exec("DROP TABLE IF EXISTS entries_vec");
    db.exec("DROP TABLE IF EXISTS entries_fts");
    db.exec("DROP INDEX IF EXISTS idx_entries_dir");
    db.exec("DROP INDEX IF EXISTS idx_entries_type");
    db.exec("DROP TABLE IF EXISTS entries");
    db.exec("DELETE FROM index_meta");

    // Store backup for restoration after ensureUsageEventsSchema runs
    (db as unknown as Record<string, unknown>).__usageBackup = usageBackup;
    console.warn("[akm] Index rebuilt due to version upgrade. Run 'akm index' to repopulate.");
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

  // Usage events table — created by ensureUsageEventsSchema() at runtime.

  // Utility scores table (aggregated per-entry utility metrics)
  db.exec(`
    CREATE TABLE IF NOT EXISTS utility_scores (
      entry_id     INTEGER PRIMARY KEY,
      utility      REAL NOT NULL DEFAULT 0,
      show_count   INTEGER NOT NULL DEFAULT 0,
      search_count INTEGER NOT NULL DEFAULT 0,
      select_rate  REAL NOT NULL DEFAULT 0,
      last_used_at TEXT,
      updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE CASCADE
    );
  `);

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
      // Delete stale BLOB embeddings so they don't produce silently wrong
      // similarity scores against the new-dimension vec table.
      try {
        db.exec("DELETE FROM embeddings");
      } catch {
        /* ignore */
      }
      setMeta(db, "hasEmbeddings", "0");
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
  } else {
    // Also purge BLOB embeddings on dimension change (JS fallback path).
    // When sqlite-vec is unavailable, entries_vec doesn't exist but the BLOB
    // embeddings table still stores vectors. If the configured dimension
    // changes, those stored BLOBs become silently incompatible.
    const storedDim = getMeta(db, "embeddingDim");
    if (storedDim && storedDim !== String(embeddingDim)) {
      try {
        db.exec("DELETE FROM embeddings");
      } catch {
        /* ignore */
      }
      setMeta(db, "hasEmbeddings", "0");
    }
    setMeta(db, "embeddingDim", String(embeddingDim));
  }

  // Usage telemetry table
  ensureUsageEventsSchema(db);

  // Restore usage_events that were backed up during a version upgrade.
  // Wrapped in outer try/catch because schema changes across versions may
  // make the backup incompatible with the new table definition.
  const dbAny = db as unknown as Record<string, unknown>;
  const backup = dbAny.__usageBackup as Array<Record<string, unknown>> | undefined;
  if (backup && backup.length > 0) {
    try {
      db.transaction(() => {
        const cols = Object.keys(backup[0]);
        const placeholders = cols.map(() => "?").join(", ");
        const insert = db.prepare(`INSERT INTO usage_events (${cols.join(", ")}) VALUES (${placeholders})`);
        for (const row of backup) {
          try {
            insert.run(...cols.map((c) => row[c] as string | number | null));
          } catch {
            /* skip rows that fail */
          }
        }
      })();
    } catch {
      /* schema changed too much — discard backup gracefully */
    }
    delete dbAny.__usageBackup;
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
    // Also delete from FTS table so orphaned FTS rows don't remain
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
    // Clean up utility scores before deleting entries
    try {
      db.prepare(`DELETE FROM utility_scores WHERE entry_id IN (${placeholders})`).run(...chunk);
    } catch {
      /* ignore */
    }
    // Clean up usage events before deleting entries
    try {
      db.prepare(`DELETE FROM usage_events WHERE entry_id IN (${placeholders})`).run(...chunk);
    } catch {
      /* ignore */
    }
  }
}

export function rebuildFts(db: Database): void {
  // Wrap DELETE + INSERT in a single transaction so the FTS table is
  // never left empty between the two statements if a crash occurs.
  // Store the integer id directly (FTS5 stores all content as text
  // internally; the join in searchFts compares numerically without CAST).
  //
  // Insert into separate FTS5 columns by extracting per-field text from
  // the entry_json using buildSearchFields(). The entries.search_text column
  // is kept as a concatenated fallback for embedding generation.

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
        warn(`[db] rebuildFts: skipping entry id=${row.id} — invalid entry_json`);
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
      // Log the failure so it's visible in diagnostics
      warn("[db] searchVec (sqlite-vec path) failed:", err instanceof Error ? err.message : String(err));
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
    warn("[db] searchBlobVec (JS fallback) failed:", err instanceof Error ? err.message : String(err));
    return [];
  }
}

// ── FTS5 search ─────────────────────────────────────────────────────────────

export function searchFts(db: Database, query: string, limit: number, entryType?: string): DbSearchResult[] {
  const ftsQuery = sanitizeFtsQuery(query);
  if (!ftsQuery) return [];

  // Try the exact AND query first
  const exactResults = runFtsQuery(db, ftsQuery, limit, entryType);
  if (exactResults.length > 0) return exactResults;

  // Exact match returned zero results — try prefix fallback.
  // Append FTS5 `*` suffix to each token that is >= 3 characters long.
  // Short tokens (1-2 chars) are excluded from prefix expansion because
  // they produce too many false positives.
  const prefixQuery = buildPrefixQuery(ftsQuery);
  if (!prefixQuery) return [];

  return runFtsQuery(db, prefixQuery, limit, entryType);
}

/**
 * Build a prefix query from an FTS5 query string by appending `*` to each
 * token that is 3+ characters long. Tokens shorter than 3 characters are
 * kept as-is (no prefix expansion) to avoid overly broad matches.
 *
 * Returns null if no tokens qualify for prefix expansion.
 */
function buildPrefixQuery(ftsQuery: string): string | null {
  const tokens = ftsQuery.split(/\s+/).filter(Boolean);
  let hasPrefix = false;

  const prefixTokens = tokens.map((t) => {
    if (t.length >= 3) {
      hasPrefix = true;
      return `${t}*`;
    }
    return t;
  });

  if (!hasPrefix) return null;

  return prefixTokens.join(" ");
}

function runFtsQuery(db: Database, ftsQuery: string, limit: number, entryType?: string): DbSearchResult[] {
  let sql: string;
  let params: unknown[];

  // Join on integer entry_id directly (no CAST needed; we store integer)
  // Use bm25() with per-column weights: entry_id(0), name(10), description(5), tags(3), hints(2), content(1)
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

    // Guard against corrupt JSON — skip the row rather than crashing
    const results: DbSearchResult[] = [];
    for (const row of rows) {
      let entry: StashEntry;
      try {
        entry = JSON.parse(row.entry_json) as StashEntry;
      } catch {
        warn(`[db] searchFts: skipping entry id=${row.id} — corrupt entry_json`);
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

  // Guard against corrupt JSON — skip the row rather than crashing
  const entries: DbIndexedEntry[] = [];
  for (const row of rows) {
    let entry: StashEntry;
    try {
      entry = JSON.parse(row.entry_json) as StashEntry;
    } catch {
      warn(`[db] getAllEntries: skipping entry id=${row.id} — corrupt entry_json`);
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

export function getEmbeddingCount(db: Database): number {
  const row = db.prepare("SELECT COUNT(*) AS cnt FROM embeddings").get() as { cnt: number };
  return row.cnt;
}

export function getEntryById(db: Database, id: number): { filePath: string; entry: StashEntry } | undefined {
  const row = db.prepare("SELECT file_path, entry_json FROM entries WHERE id = ?").get(id) as
    | { file_path: string; entry_json: string }
    | undefined;
  if (!row) return undefined;
  // Guard against corrupt JSON
  let entry: StashEntry;
  try {
    entry = JSON.parse(row.entry_json) as StashEntry;
  } catch {
    warn(`[db] getEntryById: skipping entry id=${id} — corrupt entry_json`);
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

  // Guard against corrupt JSON — skip the row rather than crashing
  const entries: DbIndexedEntry[] = [];
  for (const row of rows) {
    let entry: StashEntry;
    try {
      entry = JSON.parse(row.entry_json) as StashEntry;
    } catch {
      warn(`[db] getEntriesByDir: skipping entry id=${row.id} — corrupt entry_json`);
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

// ── Utility score operations ────────────────────────────────────────────────

export interface UtilityScoreData {
  utility: number;
  showCount: number;
  searchCount: number;
  selectRate: number;
  lastUsedAt?: string;
}

export interface UtilityScoreRow extends UtilityScoreData {
  entryId: number;
  updatedAt: string;
}

/**
 * Get the utility score for an entry, or undefined if none exists.
 */
export function getUtilityScore(db: Database, entryId: number): UtilityScoreRow | undefined {
  const row = db
    .prepare(
      "SELECT entry_id, utility, show_count, search_count, select_rate, last_used_at, updated_at FROM utility_scores WHERE entry_id = ?",
    )
    .get(entryId) as
    | {
        entry_id: number;
        utility: number;
        show_count: number;
        search_count: number;
        select_rate: number;
        last_used_at: string | null;
        updated_at: string;
      }
    | undefined;
  if (!row) return undefined;
  return {
    entryId: row.entry_id,
    utility: row.utility,
    showCount: row.show_count,
    searchCount: row.search_count,
    selectRate: row.select_rate,
    lastUsedAt: row.last_used_at ?? undefined,
    updatedAt: row.updated_at,
  };
}

/**
 * Batch-load utility scores for multiple entry IDs in a single query.
 * Returns a Map keyed by entry_id for O(1) lookup.
 */
export function getUtilityScoresByIds(db: Database, ids: number[]): Map<number, UtilityScoreRow> {
  if (ids.length === 0) return new Map();
  const result = new Map<number, UtilityScoreRow>();
  // Process in chunks to stay within SQLITE_MAX_VARIABLE_NUMBER
  for (let i = 0; i < ids.length; i += SQLITE_CHUNK_SIZE) {
    const chunk = ids.slice(i, i + SQLITE_CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT entry_id, utility, show_count, search_count, select_rate, last_used_at, updated_at FROM utility_scores WHERE entry_id IN (${placeholders})`,
      )
      .all(...chunk) as Array<{
      entry_id: number;
      utility: number;
      show_count: number;
      search_count: number;
      select_rate: number;
      last_used_at: string | null;
      updated_at: string;
    }>;
    for (const row of rows) {
      result.set(row.entry_id, {
        entryId: row.entry_id,
        utility: row.utility,
        showCount: row.show_count,
        searchCount: row.search_count,
        selectRate: row.select_rate,
        lastUsedAt: row.last_used_at ?? undefined,
        updatedAt: row.updated_at,
      });
    }
  }
  return result;
}

/**
 * Insert or update a utility score for an entry.
 */
export function upsertUtilityScore(db: Database, entryId: number, data: UtilityScoreData): void {
  db.prepare(`
    INSERT INTO utility_scores (entry_id, utility, show_count, search_count, select_rate, last_used_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(entry_id) DO UPDATE SET
      utility = excluded.utility,
      show_count = excluded.show_count,
      search_count = excluded.search_count,
      select_rate = excluded.select_rate,
      last_used_at = excluded.last_used_at,
      updated_at = datetime('now')
  `).run(entryId, data.utility, data.showCount, data.searchCount, data.selectRate, data.lastUsedAt ?? null);
}
