// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The improve planner's entry source (#664 Seam 2).
 *
 * `akmImprove` plans which refs to work on by reading the `entries` table — it
 * needs ONLY those rows, not FTS or vectors. Yet today it opens the real index
 * DB inline (`openExistingDatabase()` + `getAllEntries`), so every improve unit
 * test must first build a full on-disk FTS index via `akmIndex({full:true})`
 * just to populate that table. {@link GetAllEntries} is the injection seam that
 * lets a test feed planner logic rows from an in-memory `:memory:` DB instead —
 * running the SAME real `getAllEntries` SQL with no disk fd and zero query-logic
 * drift (no hand-rolled JS filter to keep in sync). See
 * `tests/_helpers/seed-entries.ts` for the test wiring.
 */

import type { Database } from "../../storage/database";
import { closeDatabase, type DbIndexedEntry, getAllEntries, openExistingDatabase } from "./db";

/**
 * Reads `entries` rows, optionally filtered by type / excluded types — the same
 * shape as {@link getAllEntries}, minus the `db` handle (the adapter owns it).
 */
export type GetAllEntries = (entryType?: string, excludeTypes?: string[]) => DbIndexedEntry[];

/**
 * Default adapter: open the REAL index DB exactly as the production planner did
 * (`openExistingDatabase` — same open mode, migration-on-open and isolation
 * guard), read, and close. Behaviour is identical to the prior inline code.
 */
export function sqliteGetAllEntries(dbPath?: string): GetAllEntries {
  return (entryType, excludeTypes) => {
    const db = openExistingDatabase(dbPath);
    try {
      return getAllEntries(db, entryType, excludeTypes);
    } finally {
      closeDatabase(db);
    }
  };
}

/**
 * In-memory adapter over an already-open (typically `:memory:`) DB. Runs the
 * same real `getAllEntries` SQL against the seeded rows — no JS reimplementation
 * of the WHERE clause, so there is nothing to drift from production.
 */
export function inMemoryGetAllEntries(db: Database): GetAllEntries {
  return (entryType, excludeTypes) => getAllEntries(db, entryType, excludeTypes);
}
