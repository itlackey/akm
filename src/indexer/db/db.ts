// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { createRequire } from "node:module";
import path from "node:path";
import { parseAssetRef } from "../../core/asset/asset-ref";
import { bestEffort } from "../../core/best-effort";
import { getDbPath } from "../../core/paths";
import { warn } from "../../core/warn";
import { cosineSimilarity, type EmbeddingVector } from "../../llm/embedders/types";
import { sha256Hex } from "../../runtime";
import type { Database, SqlValue } from "../../storage/database";
import { openManagedDatabase } from "../../storage/managed-db";
import {
  computeNextUtility,
  type FeedbackUtilityResult,
  HIGH_UTILITY_THRESHOLD,
  UTILITY_REVIEW_THRESHOLD,
} from "../feedback/utility-policy";
import type { StashEntry } from "../passes/metadata";
import { buildPrefixQuery, sanitizeFtsQuery } from "../search/fts-query";
import { buildSearchFields } from "../search/search-fields";
import { ENTRY_COLUMNS, type EntryRow, rowToIndexedEntry } from "./entry-mapper";
import { ensureSchema } from "./schema";

// ── Re-exports from extracted sibling modules ────────────────────────────────
// The MemRL feedback policy and the pure FTS query helpers were carried out of
// this god-file into focused modules. Re-export the previously-public symbols
// here so importers of this module keep working unchanged.
export type { FeedbackUtilityResult };
export { HIGH_UTILITY_THRESHOLD, sanitizeFtsQuery, UTILITY_REVIEW_THRESHOLD };

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

export interface IndexDirState {
  dirPath: string;
  fileSetHash: string;
  fileMtimeMaxMs: number;
  reason: string;
  updatedAt: string;
}

// ── Database lifecycle ──────────────────────────────────────────────────────

export function openIndexDatabase(dbPath?: string, options?: { embeddingDim?: number }): Database {
  return openManagedDatabase({
    path: dbPath ?? getDbPath(),
    init: (db) => {
      // Try to load sqlite-vec extension
      loadVecExtension(db);

      // Dim resolution: explicit option wins; otherwise consult the on-disk
      // config so unparameterised opens (registry providers, graph helpers,
      // ad-hoc CLI subcommands) honour the operator-declared dimension. Only if
      // both are absent do we fall through to the no-clobber path, which keeps
      // ensureSchema from touching `index_meta.embeddingDim` at all.
      const resolvedDim = options?.embeddingDim ?? resolveConfiguredEmbeddingDim();
      ensureSchema(db, resolvedDim);

      // Warn once at init if using JS fallback with many entries
      warnIfVecMissing(db, { once: true });
    },
  });
}

/**
 * Read the operator-configured embedding dimension from the on-disk config.
 * Returns `undefined` when no config file is present, when the config has
 * no `embedding.dimension` set, or when reading the config throws (e.g.
 * inside isolated test fixtures with no XDG home). Failure is silent on
 * purpose — every openDatabase() call would otherwise have to handle a
 * config-not-found error path, and the fallback (no-clobber semantics) is
 * already correct.
 */
function resolveConfiguredEmbeddingDim(): number | undefined {
  try {
    const { loadConfig } = require("../../core/config/config") as typeof import("../../core/config/config");
    const dim = loadConfig().embedding?.dimension;
    if (typeof dim === "number" && Number.isInteger(dim) && dim > 0 && dim <= 4096) {
      return dim;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function openExistingDatabase(dbPath?: string): Database {
  // Existing-DB callers must not mutate schema or embedding metadata on open,
  // but some paths still need write access to usage_events and other tables —
  // so init only loads the vec extension, it does not run ensureSchema.
  return openManagedDatabase({ path: dbPath ?? getDbPath(), init: loadVecExtension });
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
    // `db` here is the genuine underlying driver handle returned by the storage
    // boundary (bun:sqlite on Bun, better-sqlite3 on Node) — only structurally
    // narrowed for callers. sqlite-vec's `load()` accepts either real handle,
    // so no raw-handle escape hatch is required.
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

  bestEffort(() => {
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
  }, "embeddings table may not exist yet during init");
}

/**
 * Purge stored embeddings (BLOB rows in `embeddings`, plus the `entries_vec`
 * virtual table) and mark the index as embedding-free. The single place that
 * invalidates embeddings — used on a dimension change, a model/provider change,
 * and a full rebuild.
 *
 * No backup: embeddings are a derived cache, fully regenerable from the markdown
 * by the next `akm index`. (Recovery model decided 2026-06-25.)
 *
 * `dropVecTable: true` DROPs `entries_vec` — used on a DIMENSION change, where
 * the vec0 table must be recreated at the new width by the caller. The default
 * clears its rows in place (same dimension, stale vectors).
 */
export function purgeEmbeddings(db: Database, opts?: { dropVecTable?: boolean }): void {
  bestEffort(() => db.exec("DELETE FROM embeddings"), "purge embeddings");
  if (isVecAvailable(db)) {
    bestEffort(
      () => db.exec(opts?.dropVecTable ? "DROP TABLE IF EXISTS entries_vec" : "DELETE FROM entries_vec"),
      "purge entries_vec",
    );
  }
  setMeta(db, "hasEmbeddings", "0");
}

// ── Meta helpers ────────────────────────────────────────────────────────────

export function getMeta(db: Database, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM index_meta WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value;
}

export function setMeta(db: Database, key: string, value: string): void {
  db.prepare("INSERT OR REPLACE INTO index_meta (key, value) VALUES (?, ?)").run(key, value);
}

export function getIndexDirState(db: Database, dirPath: string): IndexDirState | undefined {
  const row = db
    .prepare(
      "SELECT dir_path, file_set_hash, file_mtime_max_ms, reason, updated_at FROM index_dir_state WHERE dir_path = ?",
    )
    .get(dirPath) as
    | {
        dir_path: string;
        file_set_hash: string;
        file_mtime_max_ms: number;
        reason: string;
        updated_at: string;
      }
    | undefined;
  if (!row) return undefined;
  return {
    dirPath: row.dir_path,
    fileSetHash: row.file_set_hash,
    fileMtimeMaxMs: row.file_mtime_max_ms,
    reason: row.reason,
    updatedAt: row.updated_at,
  };
}

export function upsertIndexDirState(
  db: Database,
  state: Pick<IndexDirState, "dirPath" | "fileSetHash" | "fileMtimeMaxMs" | "reason">,
): void {
  db.prepare(
    `INSERT INTO index_dir_state (dir_path, file_set_hash, file_mtime_max_ms, reason, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(dir_path) DO UPDATE SET
       file_set_hash = excluded.file_set_hash,
       file_mtime_max_ms = excluded.file_mtime_max_ms,
       reason = excluded.reason,
       updated_at = excluded.updated_at`,
  ).run(state.dirPath, state.fileSetHash, state.fileMtimeMaxMs, state.reason, new Date().toISOString());
}

export function deleteIndexDirState(db: Database, dirPath: string): void {
  db.prepare("DELETE FROM index_dir_state WHERE dir_path = ?").run(dirPath);
}

export function deleteIndexDirStatesByStashDir(db: Database, stashDir: string): void {
  db.prepare("DELETE FROM index_dir_state WHERE dir_path = ? OR dir_path LIKE ?").run(
    stashDir,
    `${stashDir}${path.sep}%`,
  );
}

// ── Entry operations ────────────────────────────────────────────────────────

/**
 * SQLite parameter chunk size — chosen well below SQLITE_MAX_VARIABLE_NUMBER
 * (default 999 on most builds) so multi-row `IN (?, ?, ...)` queries stay
 * within bounds. Shared by helpers below.
 */
const SQLITE_CHUNK_SIZE = 500;

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
  // Hot path during indexing — cache the two prepared statements per
  // database connection so we don't pay the SQL parse/compile cost on
  // every call. The dirty-mark INSERT and the upsert-with-RETURNING
  // share the same WeakMap so they live and die with the connection.
  const stmts = getUpsertStmts(db);
  // Phase 5A / Advantage D5: surface derived memory parent ref into the
  // dedicated `derived_from` column so retrieval-time lookup (parent→child)
  // does not have to scan + JSON-decode every memory row.
  const derivedFrom =
    typeof entry.derivedFrom === "string" && entry.derivedFrom.trim() ? entry.derivedFrom.trim() : null;
  const result = stmts.upsert.get(
    entryKey,
    dirPath,
    filePath,
    stashDir,
    JSON.stringify(entry),
    searchText,
    entry.type,
    derivedFrom,
  ) as { id: number } | undefined;
  if (!result) throw new Error("upsertEntry: entry_key not found after upsert");

  // Mark this entry as FTS-dirty so `rebuildFts({ incremental: true })`
  // only revisits entries that actually changed. INSERT OR IGNORE is
  // idempotent across multiple upserts of the same row.
  stmts.markDirty.run(result.id);
  return result.id;
}

interface UpsertStmts {
  upsert: ReturnType<Database["prepare"]>;
  markDirty: ReturnType<Database["prepare"]>;
}

const upsertStmtsByDb = new WeakMap<Database, UpsertStmts>();

function getUpsertStmts(db: Database): UpsertStmts {
  const existing = upsertStmtsByDb.get(db);
  if (existing) return existing;
  const stmts: UpsertStmts = {
    // RETURNING id handles ON CONFLICT DO UPDATE correctly — no second
    // SELECT round-trip needed (last_insert_rowid() is unreliable for
    // ON CONFLICT). Use `.get()` so a single row comes back.
    upsert: db.prepare(`
      INSERT INTO entries (entry_key, dir_path, file_path, stash_dir, entry_json, search_text, entry_type, derived_from)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(entry_key) DO UPDATE SET
        dir_path = excluded.dir_path,
        file_path = excluded.file_path,
        stash_dir = excluded.stash_dir,
        entry_json = excluded.entry_json,
        search_text = excluded.search_text,
        entry_type = excluded.entry_type,
        derived_from = excluded.derived_from
      RETURNING id
    `),
    markDirty: db.prepare("INSERT OR IGNORE INTO entries_fts_dirty (entry_id) VALUES (?)"),
  };
  upsertStmtsByDb.set(db, stmts);
  return stmts;
}

/**
 * Phase 5A / Advantage D5: look up the derived-memory child row whose
 * `derived_from` column matches `parentRef` (e.g. `"memory:claude-prefs"`).
 *
 * Returns the most-recently-updated derived child when multiple exist (one
 * parent should yield exactly one `.derived` child in practice, but the
 * ordering keeps results deterministic). Returns `null` when no derived
 * child has been indexed for this parent.
 */
export function getDerivedForParent(db: Database, parentRef: string): DbIndexedEntry | null {
  if (!parentRef) return null;
  try {
    const row = db
      .prepare(
        `SELECT ${ENTRY_COLUMNS}
         FROM entries
         WHERE derived_from = ?
         ORDER BY id DESC
         LIMIT 1`,
      )
      .get(parentRef) as EntryRow | undefined;
    if (!row) return null;
    return rowToIndexedEntry(row, "getDerivedForParent");
  } catch {
    /* `derived_from` column may not exist on legacy DBs that haven't been
       rebuilt; treat as "no derived child". */
    return null;
  }
}

/**
 * Phase 2A / Rec 5: bulk-load positive feedback event counts for the given
 * entry ids. Used by the utility-decay forgetting curve to stabilize
 * (extend the half-life of) memories that have repeatedly proven useful.
 *
 * Returns a `Map<entryId, count>` containing only entries with at least one
 * positive feedback event — missing ids implicitly map to `0`. Chunks at
 * `SQLITE_CHUNK_SIZE` (500) to respect `SQLITE_MAX_VARIABLE_NUMBER`.
 *
 * Cheap when called with zero ids, and silently empty when the
 * `usage_events` table is missing.
 */
export function getPositiveFeedbackCountsByIds(db: Database, ids: number[]): Map<number, number> {
  const result = new Map<number, number>();
  if (ids.length === 0) return result;
  for (let i = 0; i < ids.length; i += SQLITE_CHUNK_SIZE) {
    const chunk = ids.slice(i, i + SQLITE_CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(",");
    bestEffort(() => {
      const rows = db
        .prepare(
          `SELECT entry_id, COUNT(*) AS cnt
             FROM usage_events
             WHERE event_type = 'feedback'
               AND signal = 'positive'
               AND entry_id IN (${placeholders})
             GROUP BY entry_id`,
        )
        .all(...chunk) as Array<{ entry_id: number | null; cnt: number }>;
      for (const row of rows) {
        if (row.entry_id !== null && row.cnt > 0) {
          result.set(row.entry_id, row.cnt);
        }
      }
    }, "usage_events table may be missing on legacy DBs — treat as zero counts");
  }
  return result;
}

function deleteEntriesWhere(db: Database, column: "dir_path" | "stash_dir", value: string): void {
  db.transaction(() => {
    const ids = db.prepare(`SELECT id FROM entries WHERE ${column} = ?`).all(value) as Array<{ id: number }>;
    deleteRelatedRows(db, ids);
    db.prepare(`DELETE FROM entries WHERE ${column} = ?`).run(value);
  })();
}

export function deleteEntriesByDir(db: Database, dirPath: string): void {
  deleteEntriesWhere(db, "dir_path", dirPath);
}

export function deleteEntriesByStashDir(db: Database, stashDir: string): void {
  deleteEntriesWhere(db, "stash_dir", stashDir);
}

function deleteRelatedRows(db: Database, ids: Array<{ id: number }>): void {
  if (ids.length === 0) return;
  const numericIds = ids.map((r) => r.id);
  const vecAvail = isVecAvailable(db);

  // Drop matching FTS rows + dirty markers immediately so an incremental
  // rebuild after a deletion doesn't try to re-index entries that no longer
  // exist (and so a full scan after deletion sees a consistent FTS).
  for (let i = 0; i < numericIds.length; i += SQLITE_CHUNK_SIZE) {
    const chunk = numericIds.slice(i, i + SQLITE_CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(",");
    bestEffort(
      () => db.prepare(`DELETE FROM entries_fts WHERE entry_id IN (${placeholders})`).run(...chunk),
      "fts table may not exist on a brand-new db",
    );
    bestEffort(
      () => db.prepare(`DELETE FROM entries_fts_dirty WHERE entry_id IN (${placeholders})`).run(...chunk),
      "fts dirty table is created lazily by upsertEntry",
    );
  }

  // Process in chunks to stay within SQLITE_MAX_VARIABLE_NUMBER
  for (let i = 0; i < numericIds.length; i += SQLITE_CHUNK_SIZE) {
    const chunk = numericIds.slice(i, i + SQLITE_CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(",");
    bestEffort(
      () => db.prepare(`DELETE FROM embeddings WHERE id IN (${placeholders})`).run(...chunk),
      "delete embeddings for entries",
    );
    if (vecAvail) {
      bestEffort(
        () => db.prepare(`DELETE FROM entries_vec WHERE id IN (${placeholders})`).run(...chunk),
        "delete entries_vec for entries",
      );
    }
    // Clean up utility scores before deleting entries
    bestEffort(
      () => db.prepare(`DELETE FROM utility_scores WHERE entry_id IN (${placeholders})`).run(...chunk),
      "delete utility_scores for entries",
    );
    bestEffort(
      () => db.prepare(`DELETE FROM utility_scores_scoped WHERE entry_id IN (${placeholders})`).run(...chunk),
      "delete utility_scores_scoped for entries",
    );
    // Clean up usage events before deleting entries
    bestEffort(
      () => db.prepare(`DELETE FROM usage_events WHERE entry_id IN (${placeholders})`).run(...chunk),
      "delete usage_events for entries",
    );
  }

  // #624-P1: graph_files is NO LONGER keyed on entries.id, so deleting an
  // entries row must NOT wipe the extracted graph (that is the whole point —
  // the graph survives a reindex when body_hash is unchanged). We therefore do
  // NOT delete graph_files here. We DO, however, recompute graph_meta counts
  // for the stash roots touched by the deleted entries so the summary numbers
  // stay consistent with the live child rows (the counts are derived, and the
  // entries delete may have changed which files are considered/indexed).
  //
  // Resolve the affected stash roots from the entries rows BEFORE deletion.
  const affectedStashRoots = new Set<string>();
  for (let i = 0; i < numericIds.length; i += SQLITE_CHUNK_SIZE) {
    const chunk = numericIds.slice(i, i + SQLITE_CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(",");
    bestEffort(() => {
      const rows = db
        .prepare(`SELECT DISTINCT stash_dir FROM entries WHERE id IN (${placeholders})`)
        .all(...chunk) as Array<{ stash_dir: string }>;
      for (const row of rows) {
        if (row.stash_dir) affectedStashRoots.add(row.stash_dir);
      }
    }, "resolve stash roots for graph_meta recompute");
  }
  for (const stashRoot of affectedStashRoots) {
    bestEffort(
      () =>
        db
          .prepare(
            `UPDATE graph_meta
             SET extracted_files = (SELECT COUNT(*) FROM graph_files WHERE stash_root = ?),
                 entity_count    = (SELECT COUNT(*) FROM graph_file_entities WHERE stash_root = ?),
                 relation_count  = (SELECT COUNT(*) FROM graph_file_relations WHERE stash_root = ?)
             WHERE stash_root = ?`,
          )
          .run(stashRoot, stashRoot, stashRoot, stashRoot),
      "sync graph_meta counts after entries delete",
    );
  }
}

/**
 * Delete entries by their primary key IDs, along with all related rows
 * (embeddings, entries_vec, entries_fts, utility_scores, usage_events).
 *
 * Used by the `--clean` post-pass to remove stale entries whose source files
 * no longer exist on disk.
 */
export function deleteEntriesByIds(db: Database, ids: number[]): void {
  if (ids.length === 0) return;
  db.transaction(() => {
    const idObjs = ids.map((id) => ({ id }));
    deleteRelatedRows(db, idObjs);
    for (let i = 0; i < ids.length; i += SQLITE_CHUNK_SIZE) {
      const chunk = ids.slice(i, i + SQLITE_CHUNK_SIZE);
      const placeholders = chunk.map(() => "?").join(",");
      db.prepare(`DELETE FROM entries WHERE id IN (${placeholders})`).run(...chunk);
    }
  })();
}

/**
 * Rebuild the FTS5 search index.
 *
 * `incremental` (default `false`): when true, only rebuild rows that
 * `upsertEntry` marked dirty since the last `rebuildFts` call. The full path
 * (default) wipes `entries_fts` and re-inserts every row from `entries` —
 * appropriate for `akm index --full` and version-upgrade rebuilds.
 *
 * Both paths are wrapped in a single transaction so the FTS table is never
 * left in a half-rebuilt state.
 *
 * Skipped corrupt-JSON rows are aggregated into one warning instead of
 * spamming stderr per-entry.
 */
export function rebuildFts(db: Database, options?: { incremental?: boolean }): void {
  const incremental = options?.incremental === true;

  db.transaction(() => {
    let rows: Array<{ id: number; entry_json: string }>;
    if (incremental) {
      // Read the dirty queue and join against entries to get the JSON.
      // Then drop the matching rows from entries_fts so the INSERT below
      // doesn't double-up. The dirty list is drained at the end.
      rows = db
        .prepare(
          `SELECT e.id AS id, e.entry_json AS entry_json
             FROM entries_fts_dirty d
             JOIN entries e ON e.id = d.entry_id`,
        )
        .all() as typeof rows;
      if (rows.length === 0) return;
      const ids = rows.map((r) => r.id);
      // Delete only the dirty FTS rows — chunk to stay under
      // SQLITE_MAX_VARIABLE_NUMBER on large dirty queues.
      for (let i = 0; i < ids.length; i += SQLITE_CHUNK_SIZE) {
        const chunk = ids.slice(i, i + SQLITE_CHUNK_SIZE);
        const placeholders = chunk.map(() => "?").join(",");
        db.prepare(`DELETE FROM entries_fts WHERE entry_id IN (${placeholders})`).run(...chunk);
      }
    } else {
      // Full path: wipe and re-read every row.
      db.exec("DELETE FROM entries_fts");
      rows = db.prepare("SELECT id, entry_json FROM entries").all() as typeof rows;
    }

    const insertStmt = db.prepare(
      "INSERT INTO entries_fts (entry_id, name, description, tags, hints, content) VALUES (?, ?, ?, ?, ?, ?)",
    );

    let skipped = 0;
    for (const row of rows) {
      let entry: import("../passes/metadata").StashEntry;
      let fields: ReturnType<typeof buildSearchFields>;
      try {
        entry = JSON.parse(row.entry_json) as import("../passes/metadata").StashEntry;
        fields = buildSearchFields(entry);
      } catch {
        skipped++;
        continue;
      }
      insertStmt.run(row.id, fields.name, fields.description, fields.tags, fields.hints, fields.content);
    }

    if (skipped > 0) {
      warn(`[db] rebuildFts: skipped ${skipped} entr${skipped === 1 ? "y" : "ies"} with invalid entry_json`);
    }

    // Always drain the dirty queue — both paths converge here. The
    // incremental path drains it because we just consumed every dirty row;
    // the full path drains it because a full rebuild covers everything the
    // dirty list tracks. The table is guaranteed to exist (created by
    // ensureSchema()).
    //
    // BUG-L1: previously the if/else arms ran identical statements — the
    // duplication has been collapsed.
    db.exec("DELETE FROM entries_fts_dirty");
  })();
}

// ── Vector operations ───────────────────────────────────────────────────────

export function upsertEmbedding(db: Database, entryId: number, embedding: EmbeddingVector): boolean {
  // Pre-flight FK guard: when an entry is deleted between when its id is queued
  // for embedding and when this INSERT runs (e.g. consolidation deletes during
  // a concurrent improve cycle), the INSERT throws "FOREIGN KEY constraint failed"
  // and rolls back the entire batch transaction in the caller, losing every
  // embedding for that run. A cheap SELECT here turns the race into a clean skip.
  const exists = db.prepare("SELECT 1 FROM entries WHERE id = ?").get(entryId);
  if (!exists) return false;

  const buf = float32Buffer(embedding);

  // Always write to BLOB table (works without sqlite-vec)
  db.prepare("INSERT OR REPLACE INTO embeddings (id, embedding) VALUES (?, ?)").run(entryId, buf);

  // Also write to sqlite-vec table when available (fast path).
  // Wrapped in a transaction so a crash between DELETE and INSERT does not
  // leave the entry missing from the vec table.
  if (isVecAvailable(db)) {
    bestEffort(() => {
      db.transaction(() => {
        db.prepare("DELETE FROM entries_vec WHERE id = ?").run(entryId);
        db.prepare("INSERT INTO entries_vec (id, embedding) VALUES (?, ?)").run(entryId, buf);
      })();
    }, "vec table unavailable or constraint failure");
  }
  return true;
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

/**
 * Return the k nearest neighbours of an already-indexed entry using its
 * persisted embedding — no re-embedding, no network. Decodes the stored BLOB by
 * byte length (dim = bytes / 4) and reuses searchVec (sqlite-vec fast path or
 * JS-cosine fallback). Returns [] when the entry has no stored embedding or the
 * BLOB is corrupt. The query entry itself is typically returned with distance
 * ~0 — callers should filter it out by id.
 */
export function getNeighborsByEntryId(db: Database, id: number, k: number): DbVecResult[] {
  const row = db.prepare("SELECT embedding FROM embeddings WHERE id = ?").get(id) as { embedding: Buffer } | undefined;
  if (!row) return [];
  const queryEmbedding = bufferToFloat32(row.embedding, Math.floor(row.embedding.byteLength / 4));
  if (!queryEmbedding) return [];
  return searchVec(db, queryEmbedding, k);
}

function float32Buffer(vec: number[]): Buffer {
  const f32 = new Float32Array(vec);
  return Buffer.from(f32.buffer);
}

/**
 * Decode a stored embedding BLOB into a Float32 array of `expectedDim`
 * dimensions. Returns `null` (and emits a warning) when the byte length does
 * not exactly match `expectedDim * 4`, including the legacy partial-trailing
 * float case the previous truncating-divide silently swallowed.
 *
 * BUG-M2: the previous `buf.byteLength / 4` divide would truncate any
 * trailing partial float and a misaligned `byteOffset` would throw — both
 * surfaced as opaque generic errors caught upstream.
 */
function bufferToFloat32(buf: Buffer, expectedDim: number): number[] | null {
  if (buf.byteLength !== expectedDim * 4) {
    warn(
      "[db] bufferToFloat32: skipping embedding row — expected %d bytes (%d dim x 4), got %d",
      expectedDim * 4,
      expectedDim,
      buf.byteLength,
    );
    return null;
  }
  // Copy into a fresh ArrayBuffer to sidestep any byteOffset alignment
  // requirements imposed by Float32Array's typed-array view contract.
  const aligned = new ArrayBuffer(buf.byteLength);
  new Uint8Array(aligned).set(buf);
  const f32 = new Float32Array(aligned);
  return Array.from(f32);
}

function searchBlobVec(db: Database, queryEmbedding: EmbeddingVector, k: number): DbVecResult[] {
  try {
    const rows = db.prepare("SELECT id, embedding FROM embeddings").all() as Array<{ id: number; embedding: Buffer }>;

    if (rows.length === 0) return [];

    const expectedDim = queryEmbedding.length;
    const scored: Array<{ id: number; similarity: number }> = [];
    for (const row of rows) {
      const embedding = bufferToFloat32(row.embedding, expectedDim);
      if (embedding === null) continue;
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

export function searchFts(
  db: Database,
  query: string,
  limit: number,
  entryType?: string,
  excludeTypes?: string[],
): DbSearchResult[] {
  const ftsQuery = sanitizeFtsQuery(query);
  if (!ftsQuery) return [];

  // Try the exact AND query first
  const exactResults = runFtsQuery(db, ftsQuery, limit, entryType, excludeTypes);
  if (exactResults.length > 0) return exactResults;

  // Exact match returned zero results — try prefix fallback.
  // Append FTS5 `*` suffix to each token that is >= 3 characters long.
  // Short tokens (1-2 chars) are excluded from prefix expansion because
  // they produce too many false positives.
  const prefixQuery = buildPrefixQuery(ftsQuery);
  if (!prefixQuery) return [];

  return runFtsQuery(db, prefixQuery, limit, entryType, excludeTypes);
}

function runFtsQuery(
  db: Database,
  ftsQuery: string,
  limit: number,
  entryType?: string,
  excludeTypes?: string[],
): DbSearchResult[] {
  // #627 — exclude-type clause. Only applies on the untyped ('any') path; an
  // explicit include filter (entryType) already narrows to a single type, so
  // exclusion is redundant there. An empty list skips the clause entirely
  // (never emit `NOT IN ()`, which is a SQL error / always-false).
  const excludes = excludeTypes && excludeTypes.length > 0 ? excludeTypes : [];

  // The typed and untyped paths differ ONLY by one WHERE clause (an entry_type
  // equality vs. an optional NOT IN exclusion) and their param order — the
  // SELECT/JOIN/ORDER/LIMIT is shared, so build it once. Join on integer
  // entry_id directly (no CAST; we store integer). bm25() per-column weights:
  // entry_id(0), name(10), description(5), tags(3), hints(2), content(1).
  let filterClause: string;
  let params: unknown[];
  if (entryType && entryType !== "any") {
    filterClause = "AND e.entry_type = ?";
    params = [ftsQuery, entryType, limit];
  } else {
    filterClause = excludes.length > 0 ? `AND e.entry_type NOT IN (${excludes.map(() => "?").join(", ")})` : "";
    // Param order: MATCH, then the NOT IN values, then LIMIT.
    params = [ftsQuery, ...excludes, limit];
  }

  const sql = `
    SELECT e.id, e.file_path AS filePath, e.entry_json, e.search_text AS searchText,
           bm25(entries_fts, 0, 10.0, 5.0, 3.0, 2.0, 1.0) AS bm25Score
    FROM entries_fts f
    JOIN entries e ON e.id = f.entry_id
    WHERE entries_fts MATCH ?
      ${filterClause}
    ORDER BY bm25Score, e.id ASC
    LIMIT ?
  `;

  try {
    const rows = db.prepare(sql).all(...(params as SqlValue[])) as Array<{
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
  } catch (err) {
    warn("[db] runFtsQuery failed:", err instanceof Error ? err.message : String(err));
    return [];
  }
}

// ── All entries ─────────────────────────────────────────────────────────────

function parseEntryRows(rows: Array<Record<string, unknown>>, context: string): DbIndexedEntry[] {
  const entries: DbIndexedEntry[] = [];
  for (const row of rows as EntryRow[]) {
    const mapped = rowToIndexedEntry(row, context);
    if (mapped) entries.push(mapped);
  }
  return entries;
}

export function getAllEntries(db: Database, entryType?: string, excludeTypes?: string[]): DbIndexedEntry[] {
  let sql: string;
  let params: unknown[];

  // #627 — exclude-type clause applies only on the untyped ('any') path. Empty
  // list skips the clause (never `NOT IN ()`).
  const excludes = excludeTypes && excludeTypes.length > 0 ? excludeTypes : [];

  if (entryType && entryType !== "any") {
    sql = `SELECT ${ENTRY_COLUMNS} FROM entries WHERE entry_type = ?`;
    params = [entryType];
  } else if (excludes.length > 0) {
    sql = `SELECT ${ENTRY_COLUMNS} FROM entries WHERE entry_type NOT IN (${excludes.map(() => "?").join(", ")})`;
    params = [...excludes];
  } else {
    sql = `SELECT ${ENTRY_COLUMNS} FROM entries`;
    params = [];
  }

  const rows = db.prepare(sql).all(...(params as SqlValue[])) as Array<Record<string, unknown>>;
  return parseEntryRows(rows, "getAllEntries");
}

/**
 * #609 — read graph entities (normalized) for a set of entry ids. Used by the
 * recombine pass to cluster memories by shared graph entity ("graph"
 * relatedness source). Returns a map of `entry_id -> entity_norm[]`. Entries
 * with no graph entities (graph extraction has not run, or the file produced
 * no entities) are simply absent from the map — callers must fail open
 * (fall back to tag relatedness) when the map is empty.
 */
export function getEntitiesByEntryIds(db: Database, entryIds: number[]): Map<number, string[]> {
  const result = new Map<number, string[]>();
  if (entryIds.length === 0) return result;
  // #624-P1: graph_file_entities no longer carries entry_id. Re-derive the
  // entry_id -> entity_norm[] contract by JOINing through entries on
  // (stash_dir, file_path) -> graph_files. Chunk the IN(?) list because the
  // recombine pass can pass 10k+ entry ids (well over the SQLite param limit).
  for (let i = 0; i < entryIds.length; i += SQLITE_CHUNK_SIZE) {
    const chunk = entryIds.slice(i, i + SQLITE_CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = db
      .prepare(
        `SELECT e.id AS entry_id, gfe.entity_norm AS entity_norm
           FROM entries e
           JOIN graph_files gf
             ON gf.stash_root = e.stash_dir AND gf.file_path = e.file_path
           JOIN graph_file_entities gfe
             ON gfe.stash_root = gf.stash_root
            AND gfe.file_path = gf.file_path
            AND gfe.body_hash = gf.body_hash
          WHERE e.id IN (${placeholders})
          ORDER BY e.id, gfe.entity_order`,
      )
      .all(...(chunk as SqlValue[])) as Array<{ entry_id: number; entity_norm: string }>;
    for (const row of rows) {
      const list = result.get(row.entry_id);
      if (list) list.push(row.entity_norm);
      else result.set(row.entry_id, [row.entity_norm]);
    }
  }
  return result;
}

export function findEntryIdByRef(db: Database, ref: string): number | undefined {
  const parsed = parseAssetRef(ref);
  const nameVariants = [parsed.name];
  if (parsed.name.endsWith(".md")) {
    nameVariants.push(parsed.name.slice(0, -3));
  } else {
    nameVariants.push(`${parsed.name}.md`);
  }

  const stmt = db.prepare(
    "SELECT id FROM entries WHERE entry_type = ? AND substr(entry_key, length(entry_key) - length(?) + 1) = ? LIMIT 1",
  );

  for (const name of nameVariants) {
    const suffix = `${parsed.type}:${name}`;
    const row = stmt.get(parsed.type, suffix, suffix) as { id: number } | undefined;
    if (row) return row.id;
  }

  return undefined;
}

export function getEntryCount(db: Database): number {
  const row = db.prepare("SELECT COUNT(*) AS cnt FROM entries").get() as { cnt: number };
  return row.cnt;
}

export function getEmbeddableEntryCount(db: Database): number {
  const row = db.prepare("SELECT COUNT(*) AS cnt FROM entries").get() as {
    cnt: number;
  };
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
  const rows = db.prepare(`SELECT ${ENTRY_COLUMNS} FROM entries WHERE dir_path = ?`).all(dirPath) as Array<
    Record<string, unknown>
  >;
  return parseEntryRows(rows, "getEntriesByDir");
}

/**
 * Resolve a single `entries.id` by exact `file_path` (the canonical on-disk
 * path), or `undefined` if no row matches.
 *
 * Lifted verbatim (WS5) from the inline `SELECT id FROM entries WHERE
 * file_path = ? LIMIT 1` in commands/search.ts so all `entries` SQL lives in
 * this module. The result is a plain number materialised before return —
 * nothing lazy crosses a connection boundary.
 */
export function getEntryIdByFilePath(db: Database, filePath: string): number | undefined {
  const row = db.prepare("SELECT id FROM entries WHERE file_path = ? LIMIT 1").get(filePath) as
    | { id: number }
    | undefined;
  return row?.id;
}

/**
 * Set of every non-empty `entries.file_path` currently indexed (across all
 * stashes/sources). Used by staleness detection to spot files that exist on
 * disk but were never indexed — a clock-independent signal for newly-added
 * assets that an mtime-vs-builtAt comparison can miss when the two clocks
 * (filesystem vs wall-clock) are skewed within the same millisecond.
 */
export function getIndexedFilePaths(db: Database): Set<string> {
  const rows = db
    .prepare("SELECT DISTINCT file_path FROM entries WHERE file_path IS NOT NULL AND file_path <> ''")
    .all() as Array<{
    file_path: string;
  }>;
  return new Set(rows.map((r) => r.file_path));
}

/**
 * Resolve a single `entries.file_path` by primary key, or `undefined` if no
 * row matches.
 *
 * Lifted verbatim (WS5) from the inline `SELECT file_path FROM entries WHERE
 * id = ?` in commands/feedback-cli.ts. Unlike {@link getEntryById}, this does
 * NOT parse `entry_json`, so a row with corrupt JSON still yields its path —
 * preserving feedback-cli's pre-extraction behaviour byte-for-byte.
 */
export function getEntryFilePathById(db: Database, id: number): string | undefined {
  const row = db.prepare("SELECT file_path FROM entries WHERE id = ?").get(id) as { file_path: string } | undefined;
  return row?.file_path;
}

/** A raw `(file_path, entry_json)` pair from the `entries` table. */
export interface EntryRefRow {
  file_path: string;
  entry_json: string;
}

/**
 * Fetch every `(file_path, entry_json)` row whose entry belongs to a given
 * stash root — matched either by exact `stash_dir` OR by `file_path` prefix.
 *
 * Lifted verbatim (WS5) from the inline query in commands/graph.ts'
 * `buildRefByPath`. The full result set is materialised with `.all()` before
 * return so callers can iterate it after the connection closes (WS5
 * connection-lifetime rule). JSON parsing stays with the caller, unchanged.
 */
export function getEntryRefRowsForStashRoot(db: Database, stashRoot: string): EntryRefRow[] {
  return db
    .prepare("SELECT file_path, entry_json FROM entries WHERE stash_dir = ? OR file_path LIKE ?")
    .all(stashRoot, `${stashRoot}%`) as EntryRefRow[];
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
 * A single row from `utility_scores_scoped`.
 */
export interface ScopedUtilityRow {
  entryId: number;
  scopeKey: string;
  utility: number;
  lastUsedAt: number;
}

/**
 * Batch-load utility scores for multiple entry IDs in a single query.
 * Returns a `{ global, scoped }` pair, both Maps keyed by entry_id.
 *
 * When `scopeKey` is provided a second query runs against
 * `utility_scores_scoped` and the result is returned as `scoped`.
 * Both maps are always present; `scoped` is empty when `scopeKey` is absent.
 */
export function getUtilityScoresByIds(
  db: Database,
  ids: number[],
  scopeKey?: string,
): { global: Map<number, UtilityScoreRow>; scoped: Map<number, ScopedUtilityRow> } {
  const global = new Map<number, UtilityScoreRow>();
  const scoped = new Map<number, ScopedUtilityRow>();
  if (ids.length === 0) return { global, scoped };
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
      global.set(row.entry_id, {
        entryId: row.entry_id,
        utility: row.utility,
        showCount: row.show_count,
        searchCount: row.search_count,
        selectRate: row.select_rate,
        lastUsedAt: row.last_used_at ?? undefined,
        updatedAt: row.updated_at,
      });
    }
    if (scopeKey) {
      const scopedRows = db
        .prepare(
          `SELECT entry_id, scope_key, utility, last_used_at FROM utility_scores_scoped WHERE scope_key = ? AND entry_id IN (${placeholders})`,
        )
        .all(scopeKey, ...chunk) as Array<{
        entry_id: number;
        scope_key: string;
        utility: number;
        last_used_at: number;
      }>;
      for (const row of scopedRows) {
        scoped.set(row.entry_id, {
          entryId: row.entry_id,
          scopeKey: row.scope_key,
          utility: row.utility,
          lastUsedAt: row.last_used_at,
        });
      }
    }
  }
  return { global, scoped };
}

/**
 * Insert or update a utility score for an entry.
 */
export function upsertUtilityScore(db: Database, entryId: number, data: UtilityScoreData): boolean {
  // Pre-flight FK guard (mirrors `upsertEmbedding`): when an entry is
  // deleted between when its id is aggregated from usage_events and when
  // this INSERT runs, the FK constraint fails and rolls back the entire
  // finalize transaction. A cheap SELECT here turns the race into a
  // clean skip. Returns false when the entry no longer exists.
  const exists = db.prepare("SELECT 1 FROM entries WHERE id = ?").get(entryId);
  if (!exists) return false;

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
  return true;
}

// ── LLM enrichment cache ────────────────────────────────────────────────────

/**
 * A cached LLM enrichment result keyed by a stable asset_ref string.
 * The body_hash (SHA-256 hex) guards against stale results when the
 * underlying file changes between index runs.
 */
export interface LlmCacheEntry {
  assetRef: string;
  cacheVariant: string;
  bodyHash: string;
  resultJson: string;
  updatedAt: number;
}

/**
 * Look up a cached LLM result for the given asset_ref.
 *
 * Returns `undefined` when no entry exists OR when the stored body_hash
 * doesn't match `currentBodyHash` (body has changed since the result was
 * cached). In both cases the caller should invoke the LLM and write a new
 * cache entry.
 */
export function getLlmCacheEntry(
  db: Database,
  assetRef: string,
  currentBodyHash: string,
  cacheVariant = "",
): LlmCacheEntry | undefined {
  const row = db
    .prepare(
      "SELECT asset_ref, cache_variant, body_hash, result_json, updated_at FROM llm_enrichment_cache WHERE asset_ref = ? AND cache_variant = ?",
    )
    .get(assetRef, cacheVariant) as
    | { asset_ref: string; cache_variant: string; body_hash: string; result_json: string; updated_at: number }
    | undefined;
  if (!row) return undefined;
  // Hash mismatch → body changed, treat as cache miss.
  if (row.body_hash !== currentBodyHash) return undefined;
  return {
    assetRef: row.asset_ref,
    cacheVariant: row.cache_variant,
    bodyHash: row.body_hash,
    resultJson: row.result_json,
    updatedAt: row.updated_at,
  };
}

/**
 * Batched variant of {@link getLlmCacheEntry}. Fetches every cache row whose
 * `asset_ref` is in `refs` with a single `IN (...)` query (chunked to respect
 * SQLITE_MAX_VARIABLE_NUMBER), returning a `Map<assetRef, LlmCacheEntry>`.
 *
 * Unlike `getLlmCacheEntry`, this does NOT filter by body hash — callers must
 * compare `entry.bodyHash` against the current body hash themselves. This lets
 * the batch path issue one DB query per chunk instead of one per file.
 */
export function getLlmCacheEntriesByRefs(db: Database, refs: string[], cacheVariant = ""): Map<string, LlmCacheEntry> {
  const result = new Map<string, LlmCacheEntry>();
  if (refs.length === 0) return result;
  for (let i = 0; i < refs.length; i += SQLITE_CHUNK_SIZE) {
    const chunk = refs.slice(i, i + SQLITE_CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = db
      .prepare(
        `SELECT asset_ref, cache_variant, body_hash, result_json, updated_at FROM llm_enrichment_cache
         WHERE cache_variant = ? AND asset_ref IN (${placeholders})`,
      )
      .all(cacheVariant, ...(chunk as SqlValue[])) as Array<{
      asset_ref: string;
      cache_variant: string;
      body_hash: string;
      result_json: string;
      updated_at: number;
    }>;
    for (const row of rows) {
      result.set(row.asset_ref, {
        assetRef: row.asset_ref,
        cacheVariant: row.cache_variant,
        bodyHash: row.body_hash,
        resultJson: row.result_json,
        updatedAt: row.updated_at,
      });
    }
  }
  return result;
}

/**
 * Insert or update a cached LLM result for the given asset_ref.
 */
export function upsertLlmCacheEntry(
  db: Database,
  assetRef: string,
  bodyHash: string,
  resultJson: string,
  cacheVariant = "",
): void {
  db.prepare(
    `INSERT INTO llm_enrichment_cache (asset_ref, cache_variant, body_hash, result_json, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(asset_ref, cache_variant) DO UPDATE SET
        body_hash   = excluded.body_hash,
        result_json = excluded.result_json,
        updated_at  = excluded.updated_at`,
  ).run(assetRef, cacheVariant, bodyHash, resultJson, Date.now());
}

/**
 * Delete LLM cache entries whose asset_ref is no longer present in the
 * `entries` table. Should be called during the cleanup phase of each index
 * run to prevent the cache from growing unboundedly as assets are removed.
 *
 * The join uses a LIKE match against the entries `file_path` column because
 * graph/memory cache refs are absolute file paths, while enrichment cache
 * refs are entry_key strings — we preserve any entry that still has a
 * corresponding row in either the entries table (by entry_key) or that
 * matches a live file_path.
 */
export function clearStaleCacheEntries(db: Database): void {
  bestEffort(() => {
    db.exec(`
      DELETE FROM llm_enrichment_cache
      WHERE asset_ref NOT IN (SELECT file_path FROM entries)
        AND asset_ref NOT IN (SELECT entry_key FROM entries)
    `);
  }, "llm_enrichment_cache may not exist in very old DBs opened without ensureSchema");
}

/**
 * Compute a stable SHA-256 hex digest of a UTF-8 string. Used as the body_hash
 * key in `llm_enrichment_cache`. Routed through the runtime boundary so the
 * SQLite layer stays free of direct runtime-specific references.
 */
export function computeBodyHash(body: string): string {
  return sha256Hex(body);
}

/**
 * Reduce a ref to its bare `type:name` form, dropping any `origin//` prefix.
 *
 * usage_events store entry_ref inconsistently: search/show writers persist
 * whatever ref the result carried, which is sometimes stash-prefixed
 * (`origin//type:name`) and sometimes bare (`type:name`). Retrieval counting
 * keys on the bare form so both spellings of the same asset collapse together.
 *
 * Returns the bare form, or the original string when it cannot be parsed (best
 * effort — never throws so a malformed stored ref can't break counting).
 */
function bareRef(ref: string): string {
  try {
    const parsed = parseAssetRef(ref);
    return `${parsed.type}:${parsed.name}`;
  } catch {
    return ref;
  }
}

/**
 * Count retrieval events for the given entry refs.
 *
 * Counts `search`, `show`, and `curate` usage events. Returns a
 * Map<inputRef, count> keyed by the *input* ref strings (only those with at
 * least one matching event appear). Used by the improve loop to find
 * high-retrieval assets without feedback.
 *
 * Matching is normalization-aware: each stored `entry_ref` is reduced to its
 * bare `type:name` form before comparison, so a stash-prefixed stored ref
 * (`origin//type:name`) still matches a bare input ref (`type:name`) and vice
 * versa. Previously the raw `entry_ref IN (...)` comparison silently dropped
 * roughly half the signal whenever the two spellings disagreed.
 *
 * `curate` events are included: their per-item rows are written with
 * entry_ref populated (see logCurateEvent), so curation is a real retrieval
 * signal here. Legacy summary-only curate rows with a NULL entry_ref simply
 * contribute nothing.
 *
 * Machine-sourced events (`source` = 'improve' or 'task') are EXCLUDED: this
 * count feeds salience/ranking, and pipeline probe traffic counting as demand
 * creates a self-reinforcing loop (meta-review 05 DRIFT-6). NULL sources
 * (pre-column rows) count as user demand.
 */
export function getRetrievalCounts(db: Database, refs: string[]): Map<string, number> {
  if (refs.length === 0) return new Map();

  // Map each distinct bare form back to the input ref(s) that produced it so we
  // can re-key DB results (grouped by bare form) onto the caller's ref strings.
  const bareToInputs = new Map<string, string[]>();
  for (const ref of refs) {
    const bare = bareRef(ref);
    const existing = bareToInputs.get(bare);
    if (existing) existing.push(ref);
    else bareToInputs.set(bare, [ref]);
  }
  const bareForms = [...bareToInputs.keys()];

  // Accumulate counts per bare form across chunks before re-keying.
  const countsByBare = new Map<string, number>();
  // Chunk to stay within SQLITE_MAX_VARIABLE_NUMBER (same pattern as getUtilityScoresByIds).
  for (let i = 0; i < bareForms.length; i += SQLITE_CHUNK_SIZE) {
    const chunk = bareForms.slice(i, i + SQLITE_CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(", ");
    // Normalize the stored entry_ref to its bare form inside SQL by stripping
    // everything up to and including the last `//` separator. SQLite has no
    // rfind, but stored origins never themselves contain `//`, so a stash ref
    // has exactly one `//` and `substr(... instr ...)` is exact; bare refs have
    // no `//` and pass through unchanged.
    const rows = db
      .prepare(
        `SELECT
           CASE
             WHEN instr(entry_ref, '//') > 0
               THEN substr(entry_ref, instr(entry_ref, '//') + 2)
             ELSE entry_ref
           END AS bare_ref,
           COUNT(*) AS cnt
         FROM usage_events
         WHERE event_type IN ('search','show','curate')
           AND entry_ref IS NOT NULL
           AND (source IS NULL OR source NOT IN ('improve','task'))
           AND CASE
                 WHEN instr(entry_ref, '//') > 0
                   THEN substr(entry_ref, instr(entry_ref, '//') + 2)
                 ELSE entry_ref
               END IN (${placeholders})
         GROUP BY bare_ref`,
      )
      .all(...(chunk as SqlValue[])) as Array<{ bare_ref: string; cnt: number }>;
    for (const r of rows) {
      countsByBare.set(r.bare_ref, (countsByBare.get(r.bare_ref) ?? 0) + r.cnt);
    }
  }

  // Re-key bare-form counts onto every input ref that maps to that bare form.
  const result = new Map<string, number>();
  for (const [bare, count] of countsByBare) {
    for (const input of bareToInputs.get(bare) ?? []) {
      result.set(input, count);
    }
  }
  return result;
}

/**
 * Apply a MemRL reward signal to a batch of entries via exponential moving
 * average (EMA): next = clamp(current + lr * (reward - current), 0, 1).
 *
 * Wrapped in a single transaction so all bumps succeed or fail together.
 * The indexer (`akm index`) will overwrite these values at next reindex run;
 * bumps are intentionally temporary hints between index runs, not permanent
 * overrides.
 *
 * When `scopeKey` is provided, also writes a scoped bump to
 * `utility_scores_scoped` so per-project usage signals accumulate alongside
 * the global ones. The global table is always updated regardless.
 */
export function bumpUtilityScoresBatch(
  db: Database,
  entryIds: number[],
  reward: number,
  lr = 0.1,
  scopeKey?: string,
): void {
  if (entryIds.length === 0) return;
  db.transaction(() => {
    const { global: scoreMap } = getUtilityScoresByIds(db, entryIds);
    const now = new Date().toISOString();
    const nowMs = Date.now();
    const stmt = db.prepare(
      `INSERT INTO utility_scores (entry_id, utility, show_count, search_count, select_rate, last_used_at, updated_at)
       VALUES (?, ?, 0, 0, 0, ?, ?)
       ON CONFLICT(entry_id) DO UPDATE SET
         utility = excluded.utility,
         updated_at = excluded.updated_at`,
    );
    // Prepare scoped upsert once outside the loop when scopeKey is present.
    const scopedStmt = scopeKey
      ? db.prepare(
          `INSERT INTO utility_scores_scoped (entry_id, scope_key, utility, last_used_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(entry_id, scope_key) DO UPDATE SET
             utility = excluded.utility,
             last_used_at = excluded.last_used_at`,
        )
      : null;
    for (const entryId of entryIds) {
      const existing = scoreMap.get(entryId);
      const current = existing?.utility ?? 0;
      const next = Math.max(0, Math.min(1, current + lr * (reward - current)));
      stmt.run(entryId, next, now, now);
      if (scopedStmt && scopeKey) {
        // Retrieve the current scoped utility so we can apply the same EMA.
        const scopedCurrent = getScopedUtility(db, entryId, scopeKey);
        const scopedNext = Math.max(0, Math.min(1, scopedCurrent + lr * (reward - scopedCurrent)));
        scopedStmt.run(entryId, scopeKey, scopedNext, nowMs);
      }
    }
  })();
}

/**
 * Return the current utility value for a single (entry_id, scope_key) pair.
 * Returns 0 when no row exists yet.
 */
function getScopedUtility(db: Database, entryId: number, scopeKey: string): number {
  const row = db
    .prepare("SELECT utility FROM utility_scores_scoped WHERE entry_id = ? AND scope_key = ?")
    .get(entryId, scopeKey) as { utility: number } | undefined;
  return row?.utility ?? 0;
}

// ── Indexer-phase helpers (moved from indexer.ts) ────────────────────────────

/**
 * Return all entries that do not yet have an embedding row.
 * Used by the embedding phase to determine which entries need vectors generated.
 */
export function getAllEntriesForEmbedding(
  db: Database,
): Array<{ id: number; searchText: string; entryKey: string; filePath: string }> {
  return db
    .prepare(`
      SELECT e.id, e.search_text AS searchText, e.entry_key AS entryKey, e.file_path AS filePath FROM entries e
      WHERE NOT EXISTS (SELECT 1 FROM embeddings b WHERE b.id = e.id)
    `)
    .all() as Array<{ id: number; searchText: string; entryKey: string; filePath: string }>;
}

/**
 * Upsert a workflow document record for an indexed entry.
 * Persists the parsed workflow AST as JSON alongside a FNV-1a hash of the
 * source content for future incremental fast-paths.
 */
export function upsertWorkflowDocument(
  db: Database,
  entryId: number,
  doc: import("../../workflows/schema").WorkflowDocument,
  content: Buffer,
): void {
  const sourceHash = computeSourceHash(content);
  db.prepare(
    `INSERT INTO workflow_documents (entry_id, schema_version, document_json, source_path, source_hash, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(entry_id) DO UPDATE SET
       schema_version = excluded.schema_version,
       document_json = excluded.document_json,
       source_path = excluded.source_path,
       source_hash = excluded.source_hash,
       updated_at = excluded.updated_at`,
  ).run(entryId, doc.schemaVersion, JSON.stringify(doc), doc.source.path, sourceHash, new Date().toISOString());
}

/**
 * Compute a cheap FNV-1a hash of a buffer for source-identity tracking.
 * Not security-sensitive; used as an incremental fast-path skip key.
 */
export function computeSourceHash(content: Buffer): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < content.length; i++) {
    hash ^= content[i];
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

/**
 * Return distinct zero-result search queries from the `usage_events` table
 * within the given lookback window.
 *
 * Reads from `usage_events` (event_type = 'search') where the metadata JSON
 * blob contains `resultCount = 0`. The `search_events` table never existed;
 * all errors are caught and an empty array is returned so callers never need
 * to guard against DB schema differences.
 */
export function getZeroResultSearches(db: Database, sinceDays = 30): string[] {
  const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString();
  try {
    const rows = db
      .prepare(
        `SELECT DISTINCT json_extract(metadata, '$.query') AS query
         FROM usage_events
         WHERE event_type = 'search'
           AND created_at >= ?
           AND json_extract(metadata, '$.resultCount') = 0
         ORDER BY created_at DESC LIMIT 20`,
      )
      .all(since) as { query: string | null }[];
    return rows.map((r) => r.query).filter((q): q is string => q !== null);
  } catch {
    return []; // table may not exist in older DBs
  }
}

/**
 * Look up an entry by its integer numeric id.
 * Returns null when no matching row is found.
 */
export function getEntryByRef(db: Database, type: string, name: string): { id: number } | null {
  return db.prepare("SELECT id FROM entries WHERE entry_type = ? AND entry_key = ?").get(type, `${type}:${name}`) as {
    id: number;
  } | null;
}

/**
 * Apply accumulated feedback counts to the utility score of an entry, persisting
 * the result. The bounded-step EMA policy itself (MemRL, F-5 / #386,
 * arXiv:2601.03192) lives in {@link computeNextUtility} (feedback/utility-policy);
 * this function only reads the current utility, applies the policy, and writes
 * the new value.
 *
 * A new entry starts at 0.5 (neutral midpoint) before the EMA step is applied.
 * When there is no feedback (both counts zero) the score is left untouched — no
 * DB write. Returns a {@link FeedbackUtilityResult} so the caller can detect a
 * previously high-utility asset crossing below the review threshold and escalate.
 */
export function applyFeedbackToUtilityScore(
  db: Database,
  entryId: number,
  positiveCount: number,
  negativeCount: number,
): FeedbackUtilityResult {
  const existing = getUtilityScore(db, entryId);
  const previousUtility = existing?.utility ?? 0.5;

  const result = computeNextUtility(previousUtility, positiveCount, negativeCount);

  if (positiveCount === 0 && negativeCount === 0) {
    return result;
  }

  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO utility_scores (entry_id, utility, show_count, search_count, select_rate, last_used_at, updated_at)
    VALUES (?, ?, 0, 0, 0, ?, ?)
    ON CONFLICT(entry_id) DO UPDATE SET
      utility    = ?,
      updated_at = ?
  `).run(entryId, result.nextUtility, now, now, result.nextUtility, now);

  return result;
}

/**
 * Re-link detached usage_events to their current entry_ids via entry_ref.
 *
 * After a full rebuild, entry IDs change. This restores each event's link
 * using the stable `entry_ref` column so usage history survives a reindex.
 */
export function relinkUsageEvents(db: Database): void {
  bestEffort(() => {
    // Step 1: null out stale entry_ids (entry was deleted, re-keyed, etc).
    // Leaving them in place would let `recomputeUtilityScores` aggregate
    // by an entry_id that no longer exists in `entries`, then trip the FK
    // constraint on the utility_scores INSERT and roll back the entire
    // finalize transaction. Nulled rows can be re-resolved by step 2 below;
    // events whose entry is permanently gone simply stay null and age out
    // via the 90-day retention policy.
    db.exec(`
      UPDATE usage_events
      SET entry_id = NULL
      WHERE entry_id IS NOT NULL
        AND entry_id NOT IN (SELECT id FROM entries)
    `);

    // Step 2: re-resolve any null entry_id from entry_ref against the current
    // entries table, reusing the SAME canonical resolver the read path uses at
    // insert time (`findEntryIdByRef` → `parseAssetRef`). Resolving per DISTINCT
    // ref keeps this O(distinct-refs) indexed lookups instead of the previous
    // O(events × entries) non-indexable `substr(entry_key, …)` scan. It also
    // fixes a silent correctness bug: the old suffix match compared the RAW
    // `entry_ref`, so origin-qualified refs ("source//type:name") never matched
    // an `entry_key` and lost their usage history on every full rebuild.
    const refs = db
      .prepare("SELECT DISTINCT entry_ref AS ref FROM usage_events WHERE entry_id IS NULL AND entry_ref IS NOT NULL")
      .all() as { ref: string }[];

    const update = db.prepare("UPDATE usage_events SET entry_id = ? WHERE entry_ref = ? AND entry_id IS NULL");
    const relinkTx = db.transaction(() => {
      for (const { ref } of refs) {
        let id: number | undefined;
        try {
          id = findEntryIdByRef(db, ref);
        } catch (err) {
          if (err instanceof Error && err.name === "UsageError") continue;
          throw err;
        }
        if (id !== undefined) update.run(id, ref);
      }
    });
    relinkTx();
  }, "usage_events table may not exist yet during entry_id re-resolution");
}

// ── registry_index_cache helpers ─────────────────────────────────────────────

/**
 * Upsert a registry index cache entry in index.db.
 *
 * @param db          - Open index.db connection (from openDatabase / openExistingDatabase).
 * @param registryUrl - Canonical URL of the registry (used as primary key).
 * @param indexJson   - Serialised registry index document (JSON string).
 * @param opts.etag        - HTTP ETag from the response (optional).
 * @param opts.lastModified - HTTP Last-Modified from the response (optional).
 */
export function upsertRegistryIndexCache(
  db: Database,
  registryUrl: string,
  indexJson: string,
  opts?: { etag?: string; lastModified?: string },
): void {
  db.prepare(`
    INSERT INTO registry_index_cache (registry_url, fetched_at, etag, last_modified, index_json)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(registry_url) DO UPDATE SET
      fetched_at    = excluded.fetched_at,
      etag          = excluded.etag,
      last_modified = excluded.last_modified,
      index_json    = excluded.index_json
  `).run(registryUrl, new Date().toISOString(), opts?.etag ?? null, opts?.lastModified ?? null, indexJson);
}

/**
 * Look up a cached registry index entry from index.db.
 * Returns undefined when not found or when the entry is older than `maxAgeMs`.
 *
 * TTL check: if `Date.now() - new Date(fetched_at).getTime() > maxAgeMs` the
 * entry is considered a cache miss and undefined is returned.
 *
 * @param db          - Open index.db connection.
 * @param registryUrl - Canonical URL of the registry (primary key).
 * @param maxAgeMs    - Maximum age in milliseconds before the entry is stale (default: 1 hour).
 */
export function getRegistryIndexCache(
  db: Database,
  registryUrl: string,
  maxAgeMs = 3_600_000 /* 1 hour */,
): { indexJson: string; etag: string | null; lastModified: string | null } | undefined {
  const row = db
    .prepare(
      `SELECT fetched_at, etag, last_modified, index_json
       FROM registry_index_cache WHERE registry_url = ?`,
    )
    .get(registryUrl) as
    | { fetched_at: string; etag: string | null; last_modified: string | null; index_json: string }
    | undefined;

  if (!row) return undefined;

  const fetchedAt = Date.parse(row.fetched_at);
  if (Number.isNaN(fetchedAt) || Date.now() - fetchedAt > maxAgeMs) return undefined;

  return { indexJson: row.index_json, etag: row.etag, lastModified: row.last_modified };
}

/**
 * Walk indexed entries and collect a deduplicated set of tags. When
 * `entryType` is provided, only entries of that type contribute tags.
 *
 * Pure read; never mutates the DB. Used by `akm lessons coverage` (Phase 7A)
 * to compute the diff between all-asset tags and lesson tags. Tags are
 * normalised by trimming and lower-casing, and blank tags are dropped.
 *
 * SQL owner: this module owns ALL raw SQL against the `entries` table (WS5),
 * so the `lessons coverage` read lives here rather than leaking into cli.ts.
 * The result set is fully materialised (`.all()` then iterate) before return.
 */
export function collectTagSetFromEntries(db: Database, entryType: string | undefined): Set<string> {
  const tags = new Set<string>();
  const stmt = entryType
    ? db.prepare("SELECT entry_json FROM entries WHERE entry_type = ?")
    : db.prepare("SELECT entry_json FROM entries");
  const rows = (entryType ? stmt.all(entryType) : stmt.all()) as Array<{ entry_json: string }>;
  for (const row of rows) {
    let parsed: { tags?: unknown };
    try {
      parsed = JSON.parse(row.entry_json) as { tags?: unknown };
    } catch {
      continue;
    }
    if (!Array.isArray(parsed.tags)) continue;
    for (const tag of parsed.tags) {
      if (typeof tag === "string" && tag.trim().length > 0) {
        tags.add(tag.trim().toLowerCase());
      }
    }
  }
  return tags;
}
