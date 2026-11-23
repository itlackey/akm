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

import { STATE_BUNDLE_ID_COLUMNS } from "../../storage/bundle-id-columns";
import type { Database } from "../../storage/database";
import { withImmediateTransaction } from "../../storage/sqlite-transaction";
import { type AkmConfig, loadConfig } from "../config/config";
import { rethrowIfTestIsolationError } from "../errors";

/** `bundleAtDir`: the configured bundle whose resolved root is `root`. */
export type BundleAtDir = (config: AkmConfig, root: string) => string | undefined;

/** A value holding a path separator or a drive colon: a root, never a bundle id. */
const PATH_VALUED = (column: string) => `${column} GLOB '*[/\\:]*'`;

/** Whether any state row still holds a root where a bundle id belongs. */
function hasPathValuedRows(db: Database): boolean {
  return STATE_BUNDLE_ID_COLUMNS.some(({ table, column }) =>
    Boolean(db.prepare(`SELECT 1 AS found FROM ${table} WHERE ${PATH_VALUED(column)} LIMIT 1`).get()),
  );
}

/**
 * Rewrite every root-valued `bundle_id` of `state.db` whose directory a configured bundle is at to that bundle's id. A
 * root no configured bundle is at stays as it is, and is looked at again on a later open (the directory may be
 * configured by then); so do all rows when the config cannot be read. Writes nothing when no root matches.
 */
export function convertPathBundleIds(db: Database, bundleAtDir: BundleAtDir): void {
  if (!hasPathValuedRows(db)) return;
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig({ warn: false });
  } catch (error) {
    rethrowIfTestIsolationError(error);
    return;
  }
  const moves: Array<{ table: string; column: string; root: string; id: string }> = [];
  for (const { table, column } of STATE_BUNDLE_ID_COLUMNS) {
    // Oldest first by rowid: when two roots of one bundle both hold the same ledger key, the last write wins.
    const roots = db
      .prepare(
        `SELECT ${column} AS root FROM ${table} WHERE ${PATH_VALUED(column)} GROUP BY ${column} ORDER BY MAX(rowid) ASC`,
      )
      .all() as Array<{ root: string }>;
    for (const { root } of roots) {
      const id = bundleAtDir(config, root);
      if (id !== undefined) moves.push({ table, column, root, id });
    }
  }
  if (moves.length === 0) return;
  withImmediateTransaction(db, () => {
    for (const { table, column, root, id } of moves) {
      db.prepare(`UPDATE OR REPLACE ${table} SET ${column} = ? WHERE ${column} = ?`).run(id, root);
    }
  });
}
