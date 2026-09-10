// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * STAGE-2 STUB, SUPERSEDED AT MERGE.
 *
 * Module B1 (`src/indexer/reconcile.ts`, docs/plans/index-redesign-contract.md)
 * owns `unit_texts` — content-addressed unit text, one row per distinct unit
 * hash — and is being written in parallel on a sibling worktree; it is not
 * yet in this one. `drainEmbeddingQueue` (B4, `src/indexer/drain.ts`) only
 * READS this table, so this file exists solely to give B4's tests a real
 * `unit_texts` table to seed against a temp index.db. It implements exactly
 * the DDL the contract's "Tables (final shape)" section gives for
 * `unit_texts`, nothing more (no `units_fts`, no reconcile logic — B4 never
 * touches either). The integrator takes B1's own file at merge time; nothing
 * here is a long-term implementation.
 */

import type { Database } from "../database";

/** Idempotent; safe to call on every schema ensure, matching the sibling *-repository modules' own ensure functions. */
export function ensureUnitTextsTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS unit_texts (
      unit_hash TEXT PRIMARY KEY,
      kind      TEXT NOT NULL CHECK (kind IN ('card','fragment')),
      text      TEXT NOT NULL
    );
  `);
}
