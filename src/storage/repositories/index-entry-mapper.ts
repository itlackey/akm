// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Shared `entries`-row projection + mapper for the `index.db` storage repos.
 *
 * Centralizes the one canonical `entries` SELECT column list and the
 * JSON-parse-guarded row → {@link DbIndexedEntry} mapping that several queries
 * used to reimplement. Corrupt `document_json` rows are skipped (warn once) rather
 * than crashing the caller.
 *
 * Relocated from `src/indexer/db/entry-mapper.ts` (WI-5a): it now imports the
 * shared shapes from the leaf types module `./index-entry-types.ts` rather
 * than reaching across the storage↔indexer boundary into `db.ts`, so it no
 * longer participates in the `db.ts` / `entry-mapper.ts` / `schema.ts` import
 * cycle that used to pin them together.
 */

import { warn } from "../../core/warn";
import type { IndexDocument } from "../../indexer/passes/metadata";
import type { DbIndexedEntry } from "./index-entry-types";

/**
 * Canonical column list for reading a full indexed entry from the `entries`
 * table, in the order {@link rowToIndexedEntry} expects.
 *
 * Durable identity columns are surfaced here so every mapped entry carries
 * current indexed provenance.
 */
export const ENTRY_COLUMNS =
  "id, item_ref, bundle_id, component_id, concept_id, adapter_id, type, file_path, content_hash, document_json";

/** A raw row selected via {@link ENTRY_COLUMNS}. */
export type EntryRow = {
  id: number;
  /** Canonical durable `<bundle>//<concept-id>` ref. */
  item_ref: string;
  bundle_id: string;
  component_id: string;
  /** Durable OKF concept id (`item_ref` tail). */
  concept_id: string;
  /** Owning adapter. */
  adapter_id: string;
  type: string;
  file_path: string;
  content_hash: string | null;
  document_json: string;
};

/**
 * Map one raw `entries` row to a {@link DbIndexedEntry}, parsing `document_json`.
 * Returns `null` (and warns, tagged with `context`) when the JSON is corrupt so
 * callers can skip the row instead of crashing.
 */
export function rowToIndexedEntry(row: EntryRow, context: string): DbIndexedEntry | null {
  let entry: IndexDocument;
  try {
    entry = JSON.parse(row.document_json) as IndexDocument;
  } catch {
    warn(`[db] ${context}: skipping entry id=${row.id} — corrupt document_json`);
    return null;
  }
  return {
    id: row.id,
    filePath: row.file_path,
    entry,
    itemRef: row.item_ref,
    conceptId: row.concept_id,
    bundleId: row.bundle_id,
    componentId: row.component_id,
    adapterId: row.adapter_id,
    type: row.type,
    ...(row.content_hash ? { contentHash: row.content_hash } : {}),
  };
}
