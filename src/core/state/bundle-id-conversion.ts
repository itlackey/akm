// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Rows migration 031 carried over keep the absolute root they were filed under in `bundle_id` (a migration cannot read
 * config). {@link convertPathBundleIds} rewrites each root to the id of the bundle that directory is now
 * (`bundleAtDir`), once, in one transaction, the first time the state opener has a config to read. A row whose directory
 * no configured bundle has keeps the id that directory gets unconfigured (`bundleIdForDir`), so it reattaches if the
 * directory is configured or used again; `akm doctor` reports such rows (`state-unknown-bundle`). The conversion is
 * idempotent: it touches only a value that is a path, and an id never is (a bundle name holds no `/`, `\` or `:`).
 */

import { STATE_BUNDLE_ID_COLUMNS } from "../../storage/bundle-id-columns";
import type { Database } from "../../storage/database";
import { withImmediateTransaction } from "../../storage/sqlite-transaction";
import { bundleAtDir } from "../bundle-id";
import { loadConfig } from "../config/config";
import { rethrowIfTestIsolationError } from "../errors";

/** A value holding a path separator or a drive colon: a root, never a bundle id. */
const PATH_VALUED = (column: string) => `${column} GLOB '*[/\\:]*'`;

/** Whether any state row still holds a root where a bundle id belongs. */
function hasPathValuedRows(db: Database): boolean {
  return STATE_BUNDLE_ID_COLUMNS.some(({ table, column }) =>
    Boolean(db.prepare(`SELECT 1 AS found FROM ${table} WHERE ${PATH_VALUED(column)} LIMIT 1`).get()),
  );
}

/**
 * Rewrite every root-valued `bundle_id` of `state.db` to its bundle's id. Does nothing when no row holds a root, and
 * leaves the rows as they are (to be converted on a later open) when the config cannot be read.
 */
export function convertPathBundleIds(db: Database): void {
  if (!hasPathValuedRows(db)) return;
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig({ warn: false });
  } catch (error) {
    rethrowIfTestIsolationError(error);
    return;
  }
  withImmediateTransaction(db, () => {
    for (const { table, column } of STATE_BUNDLE_ID_COLUMNS) {
      // Newest first by rowid: when two roots of one bundle both hold the same ledger key, the last write wins.
      const roots = db
        .prepare(
          `SELECT ${column} AS root FROM ${table} WHERE ${PATH_VALUED(column)} GROUP BY ${column} ORDER BY MAX(rowid) ASC`,
        )
        .all() as Array<{ root: string }>;
      for (const { root } of roots) {
        db.prepare(`UPDATE OR REPLACE ${table} SET ${column} = ? WHERE ${column} = ?`).run(
          bundleAtDir(config, root),
          root,
        );
      }
    }
  });
}
