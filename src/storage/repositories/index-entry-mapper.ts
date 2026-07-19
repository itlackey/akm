// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Shared `entries`-row projection + mapper for the `index.db` storage repos.
 *
 * Centralizes the one canonical `entries` SELECT column list and the
 * JSON-parse-guarded row → {@link DbIndexedEntry} mapping that several queries
 * used to reimplement. Corrupt `entry_json` rows are skipped (warn once) rather
 * than crashing the caller.
 *
 * Relocated from `src/indexer/db/entry-mapper.ts` (WI-5a): it now imports the
 * shared shapes from the leaf types module rather than from `db.ts`, so it no
 * longer participates in the indexer-db import cycle.
 */

import { warn } from "../../core/warn";
import type { IndexDocument } from "../../indexer/passes/metadata";
import type { DbIndexedEntry } from "./index-entry-types";

/**
 * Canonical column list for reading a full indexed entry from the `entries`
 * table, in the order {@link rowToIndexedEntry} expects.
 */
export const ENTRY_COLUMNS = "id, entry_key, dir_path, file_path, stash_dir, entry_json, search_text";

/** A raw row selected via {@link ENTRY_COLUMNS}. */
export type EntryRow = {
  id: number;
  entry_key: string;
  dir_path: string;
  file_path: string;
  stash_dir: string;
  entry_json: string;
  search_text: string;
};

/**
 * Map one raw `entries` row to a {@link DbIndexedEntry}, parsing `entry_json`.
 * Returns `null` (and warns, tagged with `context`) when the JSON is corrupt so
 * callers can skip the row instead of crashing.
 */
export function rowToIndexedEntry(row: EntryRow, context: string): DbIndexedEntry | null {
  let entry: IndexDocument;
  try {
    entry = JSON.parse(row.entry_json) as IndexDocument;
  } catch {
    warn(`[db] ${context}: skipping entry id=${row.id} — corrupt entry_json`);
    return null;
  }
  return {
    id: row.id,
    entryKey: row.entry_key,
    dirPath: row.dir_path,
    filePath: row.file_path,
    stashDir: row.stash_dir,
    entry,
    searchText: row.search_text,
  };
}
