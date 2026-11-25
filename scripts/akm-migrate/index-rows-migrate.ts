// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The `indexRows` step: an index an older akm wrote keys the rows of a bundle that is no directory (a keyring, a
 * vault) under a path inside the bundle's root and marks their documents `fileless`; the index is keyed by ref now and
 * such a row holds no path (`file_path = ''`, no `fileless`). Until this step runs every command reads those rows as
 * rows with no file. The step changes no column and not the layout version; it is a plain update of the legacy rows, so
 * an older akm keeps reading the index. A rebuild (`akm index`) writes the same rows in the new form on its own.
 */

import { withAssetMutationLeaseSync } from "../../src/core/index-writer-lock";
import { getDbPath } from "../../src/core/paths";
import type { Database } from "../../src/storage/database";
import {
  closeDatabase,
  openExistingDatabase,
  openReadonlyExistingDatabase,
} from "../../src/storage/repositories/index-connection";

export interface IndexRowsSummary {
  schemaVersion: 1;
  /** Rows of the earlier form, to re-key (before the step runs) or re-keyed (after). */
  changed: number;
  message: string;
  applied?: number;
}

export interface IndexRowsMigrationStatus {
  schemaVersion: 1;
  status: "current" | "ready";
  /** Absent when no row is of the earlier form. */
  indexRows?: IndexRowsSummary;
}

const LEGACY_ROWS = "json_extract(document_json, '$.fileless') = 1";

function summarize(changed: number, verb: "to re-key" | "re-keyed"): IndexRowsSummary {
  return { schemaVersion: 1, changed, message: `index rows: ${changed} ${verb}` };
}

function countLegacyRows(db: Database): number {
  try {
    return (db.prepare(`SELECT COUNT(*) AS n FROM entries WHERE ${LEGACY_ROWS}`).get() as { n: number }).n;
  } catch {
    // An index of an older layout has no such rows; a writable open of it upgrades it.
    return 0;
  }
}

const none: IndexRowsMigrationStatus = { schemaVersion: 1, status: "current" };

/** Read-only: how many rows `apply` would re-key. */
export function inspectIndexRowsMigration(): IndexRowsMigrationStatus {
  const db = openReadonlyExistingDatabase(getDbPath());
  if (!db) return none;
  try {
    const changed = countLegacyRows(db);
    return changed > 0 ? { schemaVersion: 1, status: "ready", indexRows: summarize(changed, "to re-key") } : none;
  } finally {
    closeDatabase(db);
  }
}

/** Re-key every legacy row, in one transaction, under the index-writer lock. */
export function applyIndexRowsMigration(): IndexRowsMigrationStatus {
  if (inspectIndexRowsMigration().indexRows === undefined) return none;
  return withAssetMutationLeaseSync("migrate-index-rows", () => {
    const db = openExistingDatabase(getDbPath());
    try {
      const changed = db.transaction(() => {
        const result = db
          .prepare(
            `UPDATE entries SET file_path = '', document_json = json_remove(document_json, '$.fileless') WHERE ${LEGACY_ROWS}`,
          )
          .run();
        return Number(result.changes);
      })();
      return changed > 0
        ? {
            schemaVersion: 1,
            status: "current",
            indexRows: { ...summarize(changed, "re-keyed"), applied: changed },
          }
        : none;
    } finally {
      closeDatabase(db);
    }
  });
}
