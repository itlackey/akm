// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The one list of columns that hold a bundle id. Persisted rows follow a bundle by its name (§0.2 P8), so everything
 * that has to find or change those values (the state opener's conversion of old root-valued rows, `akm bundle rename`,
 * `akm doctor`'s `state-unknown-bundle`) reads this list and none keeps its own.
 */

import type { Database } from "./database";

export interface BundleIdColumn {
  readonly table: string;
  readonly column: string;
}

/** The `state.db` columns that hold a bundle id: the ones whose rows an akm migration or a rename carries. */
export const BUNDLE_ID_COLUMNS: readonly BundleIdColumn[] = Object.freeze([
  { table: "proposals", column: "bundle_id" },
  { table: "improve_runs", column: "bundle_id" },
  { table: "improve_ledger", column: "bundle_id" },
]);

/** Whether a stored `bundle_id` is a directory (it holds a path separator or a drive colon), never a bundle id: a bundle name holds none of them. */
export function isPathKey(value: string): boolean {
  return /[/\\:]/.test(value);
}

/**
 * Re-file every `state.db` row of bundle `oldId` under `newId` (`akm bundle rename`). A ledger row `newId` already
 * holds for the same key (left by a bundle of that name that was dropped from config) gives way to the renamed
 * bundle's: the rows being carried are the ones in use.
 */
export function renameStateBundleId(db: Database, oldId: string, newId: string): void {
  for (const { table, column } of BUNDLE_ID_COLUMNS) {
    db.prepare(`UPDATE OR REPLACE ${table} SET ${column} = ? WHERE ${column} = ?`).run(newId, oldId);
  }
}
