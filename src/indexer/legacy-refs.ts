// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * One-time carry-over of the refs of files that sit outside their type's folder.
 *
 * Releases before path refs gave such a file the ref `<type folder>/<its path>`
 * (`reports/x.md` was `knowledge/reports/x`); its ref is now its path
 * (`reports/x`). The mapping is closed-form, so each indexed entry names the old
 * ref its history is stored under, and the rows keyed by it are re-keyed in
 * place: the `entries` row (keeping its id, which keeps its usage events and
 * scores attached) and the ref-keyed state.db rows. Idempotent: once the rows
 * carry the new ref there is nothing under the old one.
 */

import { stashDirFor } from "../core/asset/asset-placement";
import { withStateDb } from "../core/state-db";
import type { Database } from "../storage/database";

/** state.db tables that store a full `bundle//conceptId` ref, with the column that holds it. */
const STATE_REF_COLUMNS = [
  ["usage_events", "entry_ref"],
  ["proposals", "ref"],
  ["events", "ref"],
  ["task_history", "target_ref"],
  ["improve_ledger", "ref"],
  ["asset_salience", "asset_ref"],
  ["asset_outcome", "asset_ref"],
] as const;

export interface LegacyRefMove {
  oldItemRef: string;
  newItemRef: string;
}

/** The ref releases before path refs gave this entry, or `undefined` when its ref never changed. */
export function legacyRefMove(bundleId: string, type: string, conceptId: string): LegacyRefMove | undefined {
  const dir = stashDirFor(type);
  if (dir === undefined || conceptId.startsWith(`${dir}/`)) return undefined;
  return { oldItemRef: `${bundleId}//${dir}/${conceptId}`, newItemRef: `${bundleId}//${conceptId}` };
}

/** Re-key the `entries` row the old ref names, in place, when the same file holds it. Returns whether one moved. */
export function rekeyLegacyEntry(db: Database, move: LegacyRefMove, conceptId: string, filePath: string): boolean {
  const old = db
    .prepare("SELECT id FROM entries WHERE item_ref = ? AND file_path = ?")
    .get(move.oldItemRef, filePath) as { id: number } | undefined | null;
  if (!old) return false;
  const stale = db.prepare("SELECT id FROM entries WHERE item_ref = ?").get(move.newItemRef) as
    | { id: number }
    | undefined
    | null;
  if (stale) return false;
  db.prepare("UPDATE entries SET item_ref = ?, concept_id = ? WHERE id = ?").run(move.newItemRef, conceptId, old.id);
  return true;
}

/** Re-key the state.db rows stored under the old refs. A row already at the new ref is an orphan and gives way. */
export function rewriteLegacyStateRefs(moves: readonly LegacyRefMove[]): void {
  if (moves.length === 0) return;
  withStateDb((db) => {
    db.transaction(() => {
      for (const [table, column] of STATE_REF_COLUMNS) {
        const update = db.prepare(`UPDATE OR REPLACE ${table} SET ${column} = ? WHERE ${column} = ?`);
        for (const move of moves) update.run(move.newItemRef, move.oldItemRef);
      }
    })();
  });
}
