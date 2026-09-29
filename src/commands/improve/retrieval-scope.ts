// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * What improve may rework (#986): an asset that retrieval returned inside the
 * usage window, or newly captured material no improve stage has processed.
 *
 * Fresh feedback and an explicit `--scope <ref>` are usage evidence of their
 * own, so the signal-delta and scope lanes need no check. The fallback lanes
 * (proactive maintenance, high salience, forgetting safety) and consolidation
 * pick assets without such evidence, so they pick only inside this scope.
 */

import fs from "node:fs";
import { daysToMs } from "../../core/common";
import { warn } from "../../core/warn";
import { listUsedEntryRefs, USAGE_EVENT_RETENTION_DAYS } from "../../indexer/usage/usage-events";
import { listImproveLedgerRows } from "../../storage/repositories/improve-ledger-repository";
import { listProposalRefSources } from "../../storage/repositories/proposals-repository";
import { type LedgerAccess, PAIR_PASS_LEDGER_SOURCE, readLedgerDb, stripBundle } from "./ledger";

/**
 * Ledger and proposal sources that bring material in. Every other source is an
 * improve stage reworking an asset (reflect, distill, consolidate, schema repair).
 */
const CAPTURE_SOURCES: ReadonlySet<string> = new Set(["extract", "propose", "remember", "import"]);

export interface RetrievalScope {
  /** ConceptIds a user search, curate or show returned, or user feedback named, inside the window. */
  used: ReadonlySet<string>;
  /** ConceptIds an improve stage attempted (the ledger) or wrote (the proposal queue). */
  processed: ReadonlySet<string>;
  /** A file modified at or after this instant is newly captured. */
  sinceMs: number;
}

/**
 * Load the scope from state.db. The window is the usage log's retention: the
 * log keeps nothing older, and anything shorter would drop assets read less
 * often than the window. A `.derived` hit counts for its parent memory, whose
 * facts it carries. `undefined` (every asset eligible, as before #986) only
 * when state.db cannot be read.
 */
export function loadRetrievalScope(
  access: LedgerAccess | undefined,
  stashDir: string | undefined,
): RetrievalScope | undefined {
  const sinceMs = Date.now() - daysToMs(USAGE_EVENT_RETENTION_DAYS);
  const used = new Set<string>();
  const processed = new Set<string>();
  try {
    readLedgerDb(access, (db) => {
      for (const entryRef of listUsedEntryRefs(db, new Date(sinceMs).toISOString())) {
        const conceptId = stripBundle(entryRef);
        used.add(conceptId);
        if (conceptId.endsWith(".derived")) used.add(conceptId.slice(0, -".derived".length));
      }
      if (!stashDir) return;
      // Blocker 1 (second review round): a pair-pass ledger row must NOT mark
      // an asset "processed" — unlike every other stage, the pair pass judges
      // material against its NEIGHBOURS, not on its own merits, so its own
      // attempt is not usage evidence the fallback lanes (proactive,
      // high-salience, forgetting-safety) or promotion retries should be
      // starved by. Left in the ledger for the pair pass's OWN eligibility
      // (selectInitiators reads content_hash directly, never this scope).
      // Proposal rows are untouched: a MINTED retire proposal is real
      // evidence something happened to the asset.
      for (const row of listImproveLedgerRows(db, stashDir)) {
        if (row.source === PAIR_PASS_LEDGER_SOURCE) continue;
        if (!CAPTURE_SOURCES.has(row.source)) processed.add(stripBundle(row.ref));
      }
      for (const row of listProposalRefSources(db, stashDir)) {
        if (!CAPTURE_SOURCES.has(row.source)) processed.add(stripBundle(row.ref));
      }
    });
  } catch (error) {
    warn(
      `[improve] usage history unreadable, so every asset stays eligible: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
  return { used, processed, sinceMs };
}

/**
 * Whether improve may rework `ref` (whose file is `filePath`) under `scope`. An
 * unprocessed asset whose file cannot be read is left to the disk check that
 * follows, which reports it as missing.
 */
export function isInRetrievalScope(scope: RetrievalScope | undefined, ref: string, filePath?: string): boolean {
  if (!scope) return true;
  const conceptId = stripBundle(ref);
  if (scope.used.has(conceptId)) return true;
  if (scope.processed.has(conceptId)) return false;
  try {
    return filePath === undefined || fs.statSync(filePath).mtimeMs >= scope.sinceMs;
  } catch {
    return true;
  }
}
