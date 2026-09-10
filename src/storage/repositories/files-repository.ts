// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `index.db` file-staleness and unit-text tables (docs/plans/index-redesign-contract.md,
 * B1 "Tables (final shape)").
 *
 * `files` is the stat cache `../../indexer/reconcile.ts` diffs against on
 * every run: one row per file that currently has an `entries` row, keyed by
 * absolute path, carrying exactly the `(size, mtime_ms)` pair needed to tell
 * "definitely unchanged" from "must be re-parsed" without reading the file.
 *
 * `unit_texts` is the content-addressed body for every embedding unit
 * (A1's `deriveUnits`, `src/indexer/units/unit.ts`) any entry currently
 * references, keyed by `unit_hash`; `units_fts` mirrors it for lexical
 * search (B3). Both are populated only for hashes `reconcile.ts` has not
 * seen before (`INSERT OR IGNORE` on `unit_texts`, driving whether the
 * `units_fts` mirror row is written at all — FTS5 has no unique constraint
 * of its own to dedupe against) and pruned only by {@link pruneOrphanUnitTexts},
 * once no entry's `entry_units` mapping references the hash any more. Vectors
 * (`units`/`units_vec`, A2 — `units-repository.ts`) are a separate, never-
 * pruned-by-this-module store keyed by the same hash: dropping a unit_texts
 * row never removes its vector, so a hash that comes back (the same text
 * re-appears, e.g. a revert) resumes serving search without re-embedding.
 *
 * Lives in `storage/repositories/` (not inside `reconcile.ts` itself) so that
 * `index-schema.ts`'s ensure path — storage layer — can wire
 * {@link ensureFileAndUnitTextTables} in without a storage → indexer import,
 * mirroring A2's `units-repository.ts` split from A1's `unit.ts`.
 */

import type { Database } from "../database";
import { SQLITE_CHUNK_SIZE } from "./index-sql";

// ── Types ───────────────────────────────────────────────────────────────────

export interface FileStateRow {
  path: string;
  bundleId: string;
  size: number;
  mtimeMs: number;
  blobHash: string;
  /**
   * The adapter id that produced this row's `entries` write. A file's own
   * `(size, mtime)` cannot change when only its BUNDLE's configured adapter
   * changes (e.g. `okf` → `akm`), so `reconcile.ts`'s stat short-circuit
   * additionally compares this against the root's current adapter — a
   * mismatch forces a re-parse under the new adapter even though the file
   * itself is untouched.
   */
  adapterId: string;
}

export type UnitTextKind = "card" | "fragment";

export interface NewUnitText {
  hash: string;
  kind: UnitTextKind;
  text: string;
}

// ── Schema ──────────────────────────────────────────────────────────────────

/**
 * Create `files`, `unit_texts` and `units_fts` if they do not already exist.
 * Idempotent; never drops or rewrites an existing row. Safe to call on every
 * schema ensure, same as `units-repository.ts`'s `ensureUnitTables`.
 */
export function ensureFileAndUnitTextTables(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      path       TEXT PRIMARY KEY,
      bundle_id  TEXT NOT NULL,
      size       INTEGER NOT NULL,
      mtime_ms   REAL NOT NULL,
      blob_hash  TEXT NOT NULL,
      adapter_id TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS files_bundle ON files(bundle_id);

    CREATE TABLE IF NOT EXISTS unit_texts (
      unit_hash TEXT PRIMARY KEY,
      kind      TEXT NOT NULL CHECK (kind IN ('card','fragment')),
      text      TEXT NOT NULL
    );
    -- index-redesign-contract.md B5f item 2: search runs the lexical query as
    -- two kind-scoped lists (card, fragment) so a name/description match
    -- ranks in its own small pool instead of competing with body text in one
    -- BM25 pool. That kind filter runs on every search, so it needs an index.
    CREATE INDEX IF NOT EXISTS unit_texts_kind ON unit_texts(kind);

    CREATE VIRTUAL TABLE IF NOT EXISTS units_fts USING fts5(
      unit_hash UNINDEXED, text, tokenize='porter unicode61'
    );
  `);
  ensureFilesAdapterIdColumn(db);
}

/**
 * `adapter_id` was added after `files`' first release, so a database created
 * before it needs an `ALTER TABLE` (`CREATE TABLE IF NOT EXISTS` only shapes
 * a fresh table). Idempotent. A pre-existing row's default `''` matches no
 * real adapter id, so the very next reconcile sees it as a mismatch and
 * re-parses that one file under its current adapter — a one-time,
 * self-healing cost, not a correctness gap.
 */
function ensureFilesAdapterIdColumn(db: Database): void {
  const columns = db.prepare("PRAGMA table_info(files)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "adapter_id")) {
    db.exec("ALTER TABLE files ADD COLUMN adapter_id TEXT NOT NULL DEFAULT ''");
  }
}

// ── files ───────────────────────────────────────────────────────────────────

function rowToFileState(row: {
  path: string;
  bundle_id: string;
  size: number;
  mtime_ms: number;
  blob_hash: string;
  adapter_id: string;
}): FileStateRow {
  return {
    path: row.path,
    bundleId: row.bundle_id,
    size: row.size,
    mtimeMs: row.mtime_ms,
    blobHash: row.blob_hash,
    adapterId: row.adapter_id,
  };
}

/** The stored stat/hash row for one path, or `undefined` if it has never been reconciled. */
export function getFileState(db: Database, path: string): FileStateRow | undefined {
  const row = db
    .prepare("SELECT path, bundle_id, size, mtime_ms, blob_hash, adapter_id FROM files WHERE path = ?")
    .get(path) as
    | { path: string; bundle_id: string; size: number; mtime_ms: number; blob_hash: string; adapter_id: string }
    | undefined;
  return row ? rowToFileState(row) : undefined;
}

/** Every stored `files` row for one bundle — the stat cache `reconcileRoots` diffs one root's walk against. */
export function getFileStatesByBundle(db: Database, bundleId: string): FileStateRow[] {
  const rows = db
    .prepare("SELECT path, bundle_id, size, mtime_ms, blob_hash, adapter_id FROM files WHERE bundle_id = ?")
    .all(bundleId) as Array<{
    path: string;
    bundle_id: string;
    size: number;
    mtime_ms: number;
    blob_hash: string;
    adapter_id: string;
  }>;
  return rows.map(rowToFileState);
}

/** Insert or replace one file's stat/hash row. */
export function upsertFileState(db: Database, row: FileStateRow): void {
  db.prepare(
    `INSERT INTO files (path, bundle_id, size, mtime_ms, blob_hash, adapter_id) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET bundle_id = excluded.bundle_id, size = excluded.size,
         mtime_ms = excluded.mtime_ms, blob_hash = excluded.blob_hash, adapter_id = excluded.adapter_id`,
  ).run(row.path, row.bundleId, row.size, row.mtimeMs, row.blobHash, row.adapterId);
}

/** Remove `files` rows for paths that no longer have an entry (gone, or the adapter no longer recognizes them). */
export function deleteFileStates(db: Database, paths: readonly string[]): void {
  for (let offset = 0; offset < paths.length; offset += SQLITE_CHUNK_SIZE) {
    const chunk = paths.slice(offset, offset + SQLITE_CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(",");
    db.prepare(`DELETE FROM files WHERE path IN (${placeholders})`).run(...chunk);
  }
}

// ── unit_texts / units_fts ───────────────────────────────────────────────────

/**
 * Write the text for every hash in `units` reconcile has not stored before.
 * `unit_texts` dedupes itself (`INSERT OR IGNORE` on its `unit_hash` PRIMARY
 * KEY); a `units_fts` mirror row is written ONLY when the `unit_texts` insert
 * actually happened (FTS5 has no PRIMARY KEY to `OR IGNORE` against, so
 * inserting unconditionally would duplicate a hash already indexed).
 */
export function insertNewUnitTexts(db: Database, units: readonly NewUnitText[]): { inserted: number } {
  if (units.length === 0) return { inserted: 0 };
  const insertText = db.prepare("INSERT OR IGNORE INTO unit_texts (unit_hash, kind, text) VALUES (?, ?, ?)");
  const insertFts = db.prepare("INSERT INTO units_fts (unit_hash, text) VALUES (?, ?)");
  let inserted = 0;
  for (const unit of units) {
    const result = insertText.run(unit.hash, unit.kind, unit.text);
    if (Number(result.changes) > 0) {
      insertFts.run(unit.hash, unit.text);
      inserted++;
    }
  }
  return { inserted };
}

/**
 * Delete `unit_texts`/`units_fts` rows no `entry_units` row references any
 * more — a single `NOT EXISTS` sweep, run once at the end of `reconcileRoots`
 * (never `reconcilePaths`, whose small known-paths scope makes a full-table
 * sweep wasteful for the write-path caller it serves). Vectors
 * (`units`/`units_vec`) are never touched here — dropping the text does not
 * drop the embedding, so a hash that comes back later resumes serving search
 * without re-embedding.
 */
export function pruneOrphanUnitTexts(db: Database): { removed: number } {
  const before = (db.prepare("SELECT COUNT(*) AS n FROM unit_texts").get() as { n: number }).n;
  db.exec(
    "DELETE FROM units_fts WHERE unit_hash IN (SELECT unit_hash FROM unit_texts WHERE NOT EXISTS " +
      "(SELECT 1 FROM entry_units WHERE entry_units.unit_hash = unit_texts.unit_hash))",
  );
  db.exec(
    "DELETE FROM unit_texts WHERE NOT EXISTS (SELECT 1 FROM entry_units WHERE entry_units.unit_hash = unit_texts.unit_hash)",
  );
  const after = (db.prepare("SELECT COUNT(*) AS n FROM unit_texts").get() as { n: number }).n;
  return { removed: before - after };
}
