// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The one place an index row is written outside a full scan: the asset facade's refresh of the rows an akm write
 * changed (`core/assets/type.ts`) records its rows here. The row builder (`indexRowEntry`, `upsertIndexRows`) is the
 * scan's own, so a row is the same whichever wrote it.
 */

import type { Database } from "../storage/database";
import { deleteEntriesByIds, upsertEntry } from "../storage/repositories/index-entries-repository";
import { deriveEntryProvenance } from "./installations";
import { type IndexDocument, withFileSize } from "./passes/metadata";

/**
 * Busy-timeout (ms) for write-path index upserts. A real write — unlike the
 * 250ms telemetry inserts — but it must not hang `akm remember` for the full
 * default 30s behind a running build. When it times out, the upsert is
 * skipped and the asset becomes searchable after the next build instead.
 */
export const WRITE_PATH_INDEX_BUSY_TIMEOUT_MS = 5_000;

/** One recognized file to record in the index. */
export interface IndexRow {
  /** The file the asset is read from; `""` when no file holds it. */
  file: string;
  entry: IndexDocument;
  conceptId: string;
  contentHash?: string;
}

/**
 * Record `rows` in the index: the one place a row is written outside a full scan (the write path and the facade's
 * refresh). The provenance is the full-index writer's, so a row is never a NULL-item_ref straggler. A row is keyed by
 * its ref; a file has one current row, so one under another ref is superseded (how an explicitly named bundle takes a
 * file over from an earlier path-derived identity). A row no file holds supersedes nothing. Returns the ids of the
 * rows written. The caller holds the transaction.
 */
export function upsertIndexRows(
  db: Database,
  owner: { bundleId: string; adapterId: string },
  rows: readonly IndexRow[],
  maxInputTokens: number,
): number[] {
  const ids: number[] = [];
  for (const { file, entry, conceptId, contentHash } of rows) {
    const provenance = deriveEntryProvenance(owner, entry.type, entry.name, conceptId);
    if (file !== "") {
      const superseded = db
        .prepare("SELECT id FROM entries WHERE file_path = ? AND item_ref <> ?")
        .all(file, provenance.itemRef) as Array<{ id: number }>;
      deleteEntriesByIds(
        db,
        superseded.map((row) => row.id),
      );
    }
    ids.push(
      upsertEntry(db, file, file === "" ? entry : withFileSize(entry, file), provenance, contentHash, maxInputTokens),
    );
  }
  return ids;
}
