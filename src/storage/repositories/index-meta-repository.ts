// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `index.db` meta + per-directory index-state repository.
 *
 * Owns the raw SQL for `index_meta` (the key/value stamp table) and
 * `index_dir_state` (incremental-index bookkeeping). Lives in the storage
 * layer, not the indexer, so the storage layer owns these primitives.
 */

import type { Database } from "../database";
import type { IndexDirState } from "./index-entry-types";

// ── Meta helpers ────────────────────────────────────────────────────────────

export function getMeta(db: Database, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM index_meta WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value;
}

export function setMeta(db: Database, key: string, value: string): void {
  db.prepare("INSERT OR REPLACE INTO index_meta (key, value) VALUES (?, ?)").run(key, value);
}

/**
 * Remove a meta key entirely.
 *
 * Distinct from writing an empty string: absence is what callers test for
 * (`getMeta(...) === undefined`), and it is what lets a value be re-derived —
 * clearing `embeddingDim` after a model change is how the vec table gets
 * rebuilt at the new width.
 */
export function deleteMeta(db: Database, key: string): void {
  db.prepare("DELETE FROM index_meta WHERE key = ?").run(key);
}

// ── Per-directory index state ───────────────────────────────────────────────

export function getIndexDirState(db: Database, dirPath: string): IndexDirState | undefined {
  const row = db
    .prepare(
      "SELECT dir_path, file_set_hash, file_mtime_max_ms, reason, updated_at, row_count, index_variant FROM index_dir_state WHERE dir_path = ?",
    )
    .get(dirPath) as
    | {
        dir_path: string;
        file_set_hash: string;
        file_mtime_max_ms: number;
        reason: string;
        updated_at: string;
        row_count: number | null;
        index_variant: string | null;
      }
    | undefined;
  if (!row) return undefined;
  return {
    dirPath: row.dir_path,
    fileSetHash: row.file_set_hash,
    fileMtimeMaxMs: row.file_mtime_max_ms,
    reason: row.reason,
    updatedAt: row.updated_at,
    rowCount: row.row_count ?? undefined,
    indexVariant: row.index_variant ?? undefined,
  };
}

export function upsertIndexDirState(
  db: Database,
  state: Pick<IndexDirState, "dirPath" | "fileSetHash" | "fileMtimeMaxMs" | "reason" | "rowCount" | "indexVariant">,
): void {
  db.prepare(
    `INSERT INTO index_dir_state (dir_path, file_set_hash, file_mtime_max_ms, reason, updated_at, row_count, index_variant)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(dir_path) DO UPDATE SET
       file_set_hash = excluded.file_set_hash,
       file_mtime_max_ms = excluded.file_mtime_max_ms,
       reason = excluded.reason,
       updated_at = excluded.updated_at,
       row_count = excluded.row_count,
       index_variant = excluded.index_variant`,
  ).run(
    state.dirPath,
    state.fileSetHash,
    state.fileMtimeMaxMs,
    state.reason,
    new Date().toISOString(),
    state.rowCount ?? null,
    state.indexVariant ?? null,
  );
}

export function deleteIndexDirState(db: Database, dirPath: string): void {
  db.prepare("DELETE FROM index_dir_state WHERE dir_path = ?").run(dirPath);
}
