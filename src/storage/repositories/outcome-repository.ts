// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Repository for the state.db `asset_outcome` table. Extracted verbatim from
 * commands/improve/outcome-loop.ts (#672 part 2) — queries and row-mapping
 * unchanged, only relocated behind the repository boundary. Re-exported by
 * commands/improve/outcome-loop.ts so existing importers resolve.
 *
 * The differential-update business logic (warm-start seeding, EMA advance,
 * score clipping) stays in outcome-loop.ts's `updateAssetOutcome` — only the
 * upsert SQL that function issued moves here, as `upsertAssetOutcome`.
 *
 * `AssetOutcomeRow` lives here (not in outcome-loop.ts) so this file imports
 * NOTHING from commands/improve/outcome-loop.ts: outcome-loop.ts re-exports
 * this module's functions (a mandatory edge in that direction), so an import
 * back from here would form a 2-node cycle —
 * `tests/architecture/import-cycle-ratchet.test.ts` enforces a zero-tolerance,
 * shrink-only baseline (currently empty) over the whole `src/` import graph,
 * counting type-only imports as graph edges same as value imports.
 * outcome-loop.ts imports `AssetOutcomeRow` back from here (one direction
 * only) and re-exports it, so external importers are unaffected.
 *
 * @module outcome-repository
 */

import type { Database } from "../database";

/**
 * Raw SQLite row shape for the `asset_outcome` table.
 */
export interface AssetOutcomeRow {
  asset_ref: string;
  last_retrieved_at: number;
  retrieval_count: number;
  expected_retrieval_rate: number;
  negative_feedback_count: number;
  accepted_change_count: number;
  outcome_score: number;
  updated_at: number;
}

/**
 * Column values for one `asset_outcome` upsert. Mirrors the INSERT column
 * list of {@link upsertAssetOutcome} verbatim.
 */
export interface AssetOutcomeUpsertValues {
  ref: string;
  lastRetrievedAt: number;
  retrievalCount: number;
  expectedRetrievalRate: number;
  negativeFeedbackCount: number;
  acceptedChangeCount: number;
  outcomeScore: number;
  updatedAt: number;
}

/**
 * Upsert one `asset_outcome` row. Extracted verbatim from the tail of
 * `updateAssetOutcome` in outcome-loop.ts — same SQL text, same bind order;
 * the business logic that computes these values (warm-start seed vs.
 * differential update) stays in outcome-loop.ts and calls this function.
 *
 * `review_pressure` is intentionally omitted from both the INSERT column list
 * and the ON CONFLICT SET clause: the column's DEFAULT 0 seeds fresh rows, and
 * omitting it from SET leaves an existing row's value untouched on update
 * (never written going forward). The column itself is dropped in migration 018.
 */
export function upsertAssetOutcome(db: Database, values: AssetOutcomeUpsertValues): void {
  db.prepare(
    `INSERT INTO asset_outcome
       (asset_ref, last_retrieved_at, retrieval_count, expected_retrieval_rate,
        negative_feedback_count, accepted_change_count,
        outcome_score, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(asset_ref) DO UPDATE SET
       last_retrieved_at      = excluded.last_retrieved_at,
       retrieval_count        = excluded.retrieval_count,
       expected_retrieval_rate= excluded.expected_retrieval_rate,
       negative_feedback_count= excluded.negative_feedback_count,
       accepted_change_count  = excluded.accepted_change_count,
       outcome_score          = excluded.outcome_score,
       updated_at             = excluded.updated_at`,
  ).run(
    values.ref,
    values.lastRetrievedAt,
    values.retrievalCount,
    values.expectedRetrievalRate,
    values.negativeFeedbackCount,
    values.acceptedChangeCount,
    values.outcomeScore,
    values.updatedAt,
  );
}

/**
 * Load the outcome row for one asset, or `undefined` if not yet written.
 */
export function getAssetOutcome(db: Database, ref: string): AssetOutcomeRow | undefined {
  const row = db
    .prepare(
      `SELECT asset_ref, last_retrieved_at, retrieval_count, expected_retrieval_rate,
              negative_feedback_count, accepted_change_count,
              outcome_score, updated_at
       FROM asset_outcome WHERE asset_ref = ?`,
    )
    .get(ref);
  return row == null ? undefined : (row as AssetOutcomeRow);
}

/**
 * Load ALL asset_outcome rows. Used for the stash-wide outcome-score
 * normalisation in improve preparation.
 */
export function getAllAssetOutcomes(db: Database): AssetOutcomeRow[] {
  return db
    .prepare(
      `SELECT asset_ref, last_retrieved_at, retrieval_count, expected_retrieval_rate,
              negative_feedback_count, accepted_change_count,
              outcome_score, updated_at
       FROM asset_outcome ORDER BY asset_ref`,
    )
    .all() as AssetOutcomeRow[];
}

/**
 * Build a Map<ref, outcome_score> for a set of refs in one query.
 * Used by `salience.ts` to populate `outcomeSalience`.
 */
export function getOutcomeScoresByRef(db: Database, refs: string[]): Map<string, number> {
  const result = new Map<string, number>();
  if (refs.length === 0) return result;
  const CHUNK = 500;
  for (let i = 0; i < refs.length; i += CHUNK) {
    const chunk = refs.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = db
      .prepare(`SELECT asset_ref, outcome_score FROM asset_outcome WHERE asset_ref IN (${placeholders})`)
      .all(...chunk) as Array<{ asset_ref: string; outcome_score: number }>;
    for (const row of rows) {
      result.set(row.asset_ref, row.outcome_score);
    }
  }
  return result;
}

// ── #733 orphan-GC (missing_since) ──────────────────────────────────────────
//
// Support for `runOrphanStateGcPass` (src/commands/improve/loop-stages.ts).
// `missing_since` is added by migration 021; NULL means "not currently
// unresolvable". These are the only functions that may touch that column —
// the `state-table-sql` lint rule (#672) forbids raw asset_outcome SQL
// anywhere else under src/. Mirrors salience-repository.ts's four functions
// of the same shape verbatim, one table apart.

export interface AssetOutcomeMissingRow {
  asset_ref: string;
  missing_since: number | null;
}

/** List every `asset_outcome` ref with its current `missing_since` marker. */
export function listAssetOutcomeMissingState(db: Database): AssetOutcomeMissingRow[] {
  return db.prepare(`SELECT asset_ref, missing_since FROM asset_outcome`).all() as AssetOutcomeMissingRow[];
}

/**
 * Stamp `missing_since = now` for the given refs, but ONLY where it is
 * currently NULL — a ref already stamped keeps its original timestamp so the
 * grace window measures from first sighting, not last. Refs with no row at
 * all are silently skipped (0 rows affected). Returns the number of rows
 * actually stamped.
 */
export function stampAssetOutcomeMissing(db: Database, refs: readonly string[], now: number): number {
  if (refs.length === 0) return 0;
  const stmt = db.prepare(`UPDATE asset_outcome SET missing_since = ? WHERE asset_ref = ? AND missing_since IS NULL`);
  let changed = 0;
  for (const ref of refs) changed += Number(stmt.run(now, ref).changes);
  return changed;
}

/**
 * Clear `missing_since` for refs that resolved again. Returns the number of
 * rows actually cleared.
 */
export function clearAssetOutcomeMissing(db: Database, refs: readonly string[]): number {
  if (refs.length === 0) return 0;
  const stmt = db.prepare(
    `UPDATE asset_outcome SET missing_since = NULL WHERE asset_ref = ? AND missing_since IS NOT NULL`,
  );
  let changed = 0;
  for (const ref of refs) changed += Number(stmt.run(ref).changes);
  return changed;
}

/**
 * Delete `asset_outcome` rows whose `missing_since` is older than
 * `cutoffMs`. A single DELETE — SQLite runs it as one implicit transaction.
 * Returns the number of rows deleted.
 */
export function deleteAssetOutcomeMissingBefore(db: Database, cutoffMs: number): number {
  return Number(
    db.prepare(`DELETE FROM asset_outcome WHERE missing_since IS NOT NULL AND missing_since < ?`).run(cutoffMs).changes,
  );
}

/** Count `asset_outcome` rows currently marked missing (the live backlog size). */
export function countAssetOutcomeMissing(db: Database): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM asset_outcome WHERE missing_since IS NOT NULL`).get() as {
    n: number;
  };
  return row.n;
}
