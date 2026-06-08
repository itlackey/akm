// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { closeDatabase, openExistingDatabase } from "../../indexer/db/db";
import type { Database } from "../database";
import { resolveStorageLocations } from "../locations";

/**
 * Scoped-resource (loan pattern) helper for the index database (`index.db`).
 *
 * This is the `index.db` twin of {@link ../../workflows/db withWorkflowDb} /
 * {@link ./workflow-runs-repository withWorkflowRunsRepo}: it opens the index
 * database bound to {@link StorageLocations.indexDb}, runs `fn` against the live
 * {@link Database}, and closes the connection exactly once when `fn` returns —
 * even if `fn` throws. Callers no longer hand-roll `open / try / finally / close`
 * around `index.db`, and the dead `existingDb?` caller-owns ownership flag
 * (search.ts / show.ts) is eliminated: every former call site passed
 * `undefined`, so the connection was always opened and always closed here.
 *
 * ## Connection-lifetime contract (WS5)
 *
 * `fn` MUST fully materialise any result set (`.all()` / `.get()` into plain
 * values or array copies) and return plain values BEFORE it returns. It MUST
 * NOT return a live statement iterator or cursor across the scope boundary,
 * because the connection is closed the instant `fn` settles — a leaked cursor
 * would be read against a closed database.
 *
 * This helper is intentionally **synchronous**. The migrated call sites are
 * synchronous fire-and-forget telemetry writers; keeping the lifecycle sync
 * preserves their exact (non-deferred) timing — opening the DB, doing the work,
 * and closing it within the same tick, identical to the inline blocks it
 * replaces.
 *
 * @param fn Receives the open index database; must finish all DB work before returning.
 * @returns Whatever `fn` returns.
 */
export function withIndexDb<T>(fn: (db: Database) => T): T {
  const db = openExistingDatabase(resolveStorageLocations().indexDb);
  try {
    return fn(db);
  } finally {
    closeDatabase(db);
  }
}
