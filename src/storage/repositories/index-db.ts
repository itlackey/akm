// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { Database } from "../database";
import { resolveStorageLocations } from "../locations";
import { withManagedDb } from "../managed-db";
import { openExistingDatabase } from "./index-connection";

/**
 * Busy-timeout (ms) for read-path telemetry writers. Small on purpose: a
 * usage-event insert contending with a background reindex should be dropped,
 * not waited on for the default 30s.
 */
export const TELEMETRY_BUSY_TIMEOUT_MS = 250;

export interface WithIndexDbOptions {
  /**
   * Override the connection's `busy_timeout` (the standard pragmas set 30s).
   * Read-path TELEMETRY writers pass a small value (e.g. 250) so a usage-event
   * insert can never stall a `search`/`show`/`curate` command behind a
   * background reindex holding the write lock — under contention the write is
   * skipped (fire-and-forget) instead of waited for.
   */
  busyTimeoutMs?: number;
}

/**
 * Scoped-resource (loan pattern) helper for the index database (`index.db`).
 *
 * This is the `index.db` twin of the state.db loan helpers ({@link
 * ../../core/state-db withStateDb} / {@link ./workflow-runs-repository
 * withWorkflowRunsRepo}): it opens the index
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
export function withIndexDb<T>(fn: (db: Database) => T, opts?: WithIndexDbOptions): T {
  return withManagedDb(
    () => openExistingDatabase(resolveStorageLocations().indexDb),
    (db) => {
      if (opts?.busyTimeoutMs !== undefined) {
        db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(opts.busyTimeoutMs))}`);
      }
      return fn(db);
    },
  );
}
