// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * An asset's own retrieval queries from the usage log, cleaned for replay.
 * The consolidate continuity check replays them against a retiring asset's
 * successor.
 */

import { nonTaskInput } from "../../core/non-task-input";
import { listRetrievalQueries } from "../../indexer/usage/usage-events";
import { type LedgerAccess, readLedgerDb, stripBundle } from "./ledger";

/** Queries kept per asset. */
const MAX_QUERIES = 5;
/** The retrieval suite treats a longer input as a paste, not a query. */
const MAX_QUERY_CHARS = 2000;

/** Up to five distinct task queries, in the given order, whitespace collapsed. */
export function usableRetrievalQueries(raw: readonly string[]): string[] {
  const out: string[] = [];
  for (const text of raw) {
    const query = text.replace(/\s+/g, " ").trim();
    if (!query || query.length > MAX_QUERY_CHARS || nonTaskInput(query) || out.includes(query)) continue;
    out.push(query);
    if (out.length === MAX_QUERIES) break;
  }
  return out;
}

/** The asset's own retrieval queries from the usage log (none when state.db cannot be read). */
export function loadRetrievalQueries(access: LedgerAccess | undefined, ref: string): string[] {
  try {
    return usableRetrievalQueries(readLedgerDb(access, (db) => listRetrievalQueries(db, stripBundle(ref))) ?? []);
  } catch {
    return [];
  }
}
