// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `index.db` meta + per-directory index-state repository.
 *
 * Owns the raw SQL for `index_meta` (the key/value stamp table) and
 * `index_dir_state` (incremental-index bookkeeping). Extracted verbatim from
 * `src/indexer/db/db.ts` (WI-5a) so the storage layer, not the indexer god-file,
 * owns these primitives.
 */

import path from "node:path";
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

// ── Per-directory index state ───────────────────────────────────────────────

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
