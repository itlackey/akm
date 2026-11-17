// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * An asset that changed ref and kept its identity: its history is re-keyed to the new ref.
 *
 * Two things move an asset's ref without making it a new asset: a file that was renamed or moved on disk
 * (`pairMovedFiles`, which pairs the vanished entry with the new file of the same content), and the one-time carry-over
 * of refs that gained a different spelling (`legacy-refs.ts`). Both end in the same re-key of the rows
 * state.db keeps by ref, which is {@link rekeyStateRefs}.
 */

import fs from "node:fs";
import path from "node:path";
import { groupBy } from "../core/common";
import { withStateDb } from "../core/state-db";
import type { Database } from "../storage/database";
import type { EntryProvenance } from "../storage/repositories/index-entry-types";

/** state.db tables that store a full `bundle//conceptId` ref, with the column that holds it. */
const STATE_REF_COLUMNS = [
  ["usage_events", "entry_ref"],
  ["proposals", "ref"],
  ["events", "ref"],
  ["task_history", "target_ref"],
  ["improve_ledger", "ref"],
  ["asset_salience", "asset_ref"],
  ["asset_outcome", "asset_ref"],
  ["workflow_runs", "workflow_ref"],
] as const;

export interface RefMove {
  oldItemRef: string;
  newItemRef: string;
}

/** Re-key the state.db rows stored under the old refs. A row already at the new ref is an orphan and gives way. */
export function rekeyStateRefs(moves: readonly RefMove[]): void {
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

/** An entry row the index holds for a file. */
export interface StoredEntry {
  id: number;
  itemRef: string;
  filePath: string;
  contentHash: string | null;
}

/** A recognized file the index has no row for. */
export interface NewEntry {
  filePath: string;
  provenance: EntryProvenance;
  contentHash: string;
}

export interface PairedMove {
  id: number;
  oldItemRef: string;
  oldFilePath: string;
  entry: NewEntry;
}

export interface MovePairing {
  pairs: PairedMove[];
  /** Vanished entries whose content matches a new file they could not be paired with. */
  unpaired: StoredEntry[];
}

const sameName = <T extends { filePath: string }>(entries: readonly T[], filePath: string): T[] =>
  entries.filter((entry) => path.basename(entry.filePath) === path.basename(filePath));

/**
 * Pair each stored entry whose file is gone with the new file of the same content. A hash held by one vanished and one
 * new file pairs them; a hash held by several pairs the ones whose file names match one to one, and anything still
 * ambiguous is left unpaired (indexed as new). An entry whose file still exists is not a move.
 */
export function pairMovedFiles(stored: readonly StoredEntry[], fresh: readonly NewEntry[]): MovePairing {
  const vanished = stored.filter((entry) => entry.contentHash !== null && !fs.existsSync(entry.filePath));
  const freshByHash = groupBy([...fresh], (entry) => entry.contentHash);
  const pairs: PairedMove[] = [];
  const unpaired: StoredEntry[] = [];
  for (const [hash, candidates] of groupBy(vanished, (entry) => entry.contentHash as string)) {
    const targets = freshByHash.get(hash);
    if (!targets) continue;
    for (const from of candidates) {
      const named = sameName(targets, from.filePath);
      const matched =
        candidates.length === 1 && targets.length === 1
          ? targets[0]
          : named.length === 1 && sameName(candidates, from.filePath).length === 1
            ? named[0]
            : undefined;
      if (matched) pairs.push({ id: from.id, oldItemRef: from.itemRef, oldFilePath: from.filePath, entry: matched });
      else unpaired.push(from);
    }
  }
  return { pairs, unpaired };
}

/** An entry row moved to its new file in place: its id keeps its vector, links and scores. */
export function repointEntry(db: Database, id: number, entry: NewEntry): void {
  const { provenance } = entry;
  db.prepare(
    "UPDATE entries SET item_ref = ?, bundle_id = ?, component_id = ?, concept_id = ?, adapter_id = ?, file_path = ? WHERE id = ?",
  ).run(
    provenance.itemRef,
    provenance.bundleId,
    provenance.componentId,
    provenance.conceptId,
    provenance.adapterId,
    entry.filePath,
    id,
  );
}
