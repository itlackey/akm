// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `index.db` sqlite-vec extension load/availability probe.
 *
 * This module used to also own the legacy per-entry vector store (a BLOB
 * `embeddings` table, an `entries_vec` vec0 mirror, and a JS-cosine fallback
 * over the BLOB rows) — all of it dead code once the write-time indexing
 * pipeline moved to the content-addressed `units`/`units_vec` store
 * (`units-repository.ts`, docs/plans/index-fragment-vectors.md) and nothing
 * wrote to `embeddings`/`entries_vec` any more. The tables themselves, and
 * every function whose only purpose was reading or writing them, were
 * deleted in the index-redesign's final cleanup (B5h) — see
 * `docs/architecture/internals/storage-locations.md` for what replaced them.
 * What remains here — loading the extension and reporting whether it loaded
 * — is still shared by both the units store and every other vec0 consumer.
 */

import { createRequire } from "node:module";
import type { Database } from "../database";

// ── sqlite-vec extension ────────────────────────────────────────────────────

const vecStatus = new WeakMap<Database, boolean>();

/**
 * Attempt to load the sqlite-vec extension into `db`, recording availability.
 * Exported so the connection lifecycle can arm it at open time.
 */
export function loadVecExtension(db: Database): void {
  try {
    const esmRequire = createRequire(import.meta.url);
    const sqliteVec = esmRequire("sqlite-vec");
    // `db` is the storage boundary's handle. On Bun that IS the bun:sqlite
    // handle; on Node it is a wrapper, which must forward `loadExtension` for
    // this call to work at all (see openNodeDatabase in storage/database.ts —
    // it did not, so vec could never load on the entire npm distribution).
    sqliteVec.load(db);
    vecStatus.set(db, true);
  } catch {
    vecStatus.set(db, false);
  }
}

export function isVecAvailable(db: Database): boolean {
  return vecStatus.get(db) ?? false;
}
