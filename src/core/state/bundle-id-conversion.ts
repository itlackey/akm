// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Rows migration 031 carried over keep the absolute root they were filed under in `bundle_id` (a migration cannot read
 * config). {@link convertPathBundleIds} rewrites each root a configured bundle is at to that bundle's id
 * (`bundleAtDir`), in one transaction, when the state opener has a config to read. A row whose directory no configured
 * bundle has keeps its path, as `state.db` always filed it, and is rewritten on a later open once a bundle is
 * configured at that directory; `akm doctor` reports such rows (`state-unknown-bundle`). The conversion is
 * idempotent: it touches only a value that is a path, and an id never is (a bundle name holds no `/`, `\` or `:`).
 */

import { BUNDLE_ID_COLUMNS, isPathKey } from "../../storage/bundle-id-columns";
import type { Database } from "../../storage/database";
import { withImmediateTransaction } from "../../storage/sqlite-transaction";
import { loadConfig } from "../config/config";
import { bundleAtDir } from "../config/config-sources";
import { rethrowIfTestIsolationError } from "../errors";

/** The distinct values of a bundle-id column that are roots, oldest first by rowid: when two roots of one bundle both hold the same ledger key, the last write wins. */
function pathKeys(db: Database, table: string, column: string): string[] {
  const values = db
    .prepare(`SELECT ${column} AS value FROM ${table} GROUP BY ${column} ORDER BY MAX(rowid) ASC`)
    .all() as Array<{ value: string }>;
  return values.map(({ value }) => value).filter(isPathKey);
}

/** Whether any state row still holds a root where a bundle id belongs. */
export function hasPathValuedRows(db: Database): boolean {
  return BUNDLE_ID_COLUMNS.some(({ table, column }) => pathKeys(db, table, column).length > 0);
}

/**
 * Rewrite every root-valued `bundle_id` of `state.db` whose directory a configured bundle is at to that bundle's id. A
 * root no configured bundle is at stays as it is, and is looked at again on a later open (the directory may be
 * configured by then); so do all rows when the config cannot be read. Writes nothing when no root matches.
 */
export function convertPathBundleIds(db: Database): void {
  if (!hasPathValuedRows(db)) return;
  const moves: Array<{ table: string; column: string; root: string; id: string }> = [];
  try {
    const config = loadConfig({ warn: false });
    for (const { table, column } of BUNDLE_ID_COLUMNS) {
      for (const root of pathKeys(db, table, column)) {
        const id = bundleAtDir(config, root);
        if (id !== undefined) moves.push({ table, column, root, id });
      }
    }
  } catch (error) {
    rethrowIfTestIsolationError(error);
    return;
  }
  if (moves.length === 0) return;
  withImmediateTransaction(db, () => {
    for (const { table, column, root, id } of moves) {
      db.prepare(`UPDATE OR REPLACE ${table} SET ${column} = ? WHERE ${column} = ?`).run(id, root);
    }
  });
}
