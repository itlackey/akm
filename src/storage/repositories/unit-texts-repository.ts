// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * stage-2 stub, superseded at merge.
 *
 * Module B1 of docs/plans/index-redesign-contract.md owns `unit_texts` and
 * `units_fts` (created inline in `reconcile.ts`'s write path, per that
 * module's contract). This file exists only so module B3 (search over
 * units) has that DDL to build and test against ahead of B1 landing on
 * `wt/index-units` in parallel. B3 never reads or writes `unit_texts` in
 * production code — `entry_units.fragment_id` alone already distinguishes a
 * card unit (ordinal 0, `fragment_id IS NULL`) from a fragment unit, so
 * `matchedUnit.kind` is derived from that instead of a `unit_texts` lookup.
 * The table exists here purely so tests can seed `units_fts` rows and
 * exercise `searchUnitsLexical` against a real FTS5 index. The integrator
 * takes B1's file wholesale at merge; do not extend this stub with anything
 * B3 does not itself need.
 */

import type { Database } from "../database";

export function ensureUnitTextTables(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS unit_texts (
      unit_hash TEXT PRIMARY KEY,
      kind      TEXT NOT NULL CHECK (kind IN ('card','fragment')),
      text      TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS units_fts USING fts5(
      unit_hash UNINDEXED, text, tokenize='porter unicode61'
    );
  `);
}
