// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `index.db` meta repository.
 *
 * Owns the raw SQL for `index_meta` (the key/value stamp table). Lives in the
 * storage layer, not the indexer, so the storage layer owns this primitive.
 */

import type { Database } from "../database";

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
