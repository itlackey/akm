// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Repository for the state.db `asset_salience` table. Extracted verbatim from
 * commands/improve/salience.ts (#672 part 2) — queries and row-mapping
 * unchanged, only relocated behind the repository boundary. Re-exported by
 * commands/improve/salience.ts so existing importers resolve.
 *
 * `getObservedRetrievalSalience` owns the health distribution read.
 *
 * This file deliberately imports NOTHING from commands/improve/salience.ts.
 * salience.ts re-exports this module's functions (a mandatory edge in that
 * direction), so an import back from here would form a 2-node cycle —
 * `tests/architecture/import-cycle-ratchet.test.ts` enforces a zero-tolerance,
 * shrink-only baseline (currently empty) over the whole `src/` import graph,
 * counting type-only imports as graph edges same as value imports. The two
 * places that would otherwise need `SalienceVector` / `EncodingSource` from
 * salience.ts instead use a structurally-equivalent local shape: the literal
 * union `"content" | "type-stub"` and the {@link SalienceVectorLike}
 * interface below. Both are call-site compatible with the real domain types
 * (any `SalienceVector` value satisfies `SalienceVectorLike`) — this is a
 * type-shape adjustment only, not a behavior change.
 *
 * @module salience-repository
 */

import type { Database } from "../database";

/**
 * Raw SQLite row shape for the `asset_salience` table.
 */
export interface AssetSalienceRow {
  asset_ref: string;
  encoding_salience: number;
  outcome_salience: number;
  retrieval_salience: number;
  rank_score: number;
  consecutive_no_ops: number;
  updated_at: number;
  /**
   * Provenance of `encoding_salience` (#644). `"content"` = real content-derived
   * score; `"type-stub"` = type-weight fallback; `null` = unknown provenance.
   * Structurally identical to (but not imported from) salience.ts's
   * `EncodingSource` — see the module-level note on the import-cycle ratchet.
   */
  encoding_source: "content" | "type-stub" | null;
}

/**
 * Structural mirror of `SalienceVector` (commands/improve/salience.ts), used
 * instead of importing that type — see the module-level note on the
 * import-cycle ratchet. Any real `SalienceVector` value is assignable here;
 * this interface only lists the fields {@link upsertAssetSalience} reads.
 */
interface SalienceVectorLike {
  encoding: number;
  outcome: number;
  retrieval: number;
  rankScore: number;
  encodingSource?: "content" | "type-stub";
}

/**
 * Upsert salience scores for one asset into state.db.
 *
 * Idempotent: safe to call every run; updates the outcome / retrieval / rank
 * columns on conflict.
 *
 * #644 — encoding provenance guard: the `encoding_salience` + `encoding_source`
 * columns are NOT lowered from a real content-derived score to a type-weight
 * stub. When the stored row is `encoding_source = 'content'` and the incoming
 * vector is a `type-stub` fallback, the stored encoding score and its provenance
 * are preserved (only the other sub-scores and `rank_score` advance). A `content`
 * write always wins; a `type-stub` write only seeds a row that has no content
 * score yet. This stops the improve loop's type-weight fallback re-asserting the
 * stub over a distill-written score on every run.
 *
 * NOTE: when the guard preserves the stored encoding score, the incoming
 * `vector.rankScore` (computed from the stub encoding) is still written. Callers
 * that want the rank_score to reflect the preserved content score should pass the
 * stored content score back in as `inputs.encodingSalience` to `computeSalience`
 * — which the improve loop does. The guard here is the defensive backstop.
 */
export function upsertAssetSalience(db: Database, ref: string, vector: SalienceVectorLike, now?: number): void {
  const ts = now ?? Date.now();
  db.prepare(
    `INSERT INTO asset_salience
       (asset_ref, encoding_salience, outcome_salience, retrieval_salience, rank_score, consecutive_no_ops, updated_at, encoding_source)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?)
     ON CONFLICT(asset_ref) DO UPDATE SET
       -- #644: never lower a real content-derived score to a type-weight stub.
       -- Keep the stored encoding score + provenance when the stored row is
       -- 'content' and the incoming write is a 'type-stub' fallback.
       encoding_salience  = CASE
         WHEN asset_salience.encoding_source = 'content' AND excluded.encoding_source = 'type-stub'
           THEN asset_salience.encoding_salience
           ELSE excluded.encoding_salience
       END,
       encoding_source    = CASE
         WHEN asset_salience.encoding_source = 'content' AND excluded.encoding_source = 'type-stub'
           THEN asset_salience.encoding_source
           ELSE excluded.encoding_source
       END,
       outcome_salience   = excluded.outcome_salience,
       retrieval_salience = excluded.retrieval_salience,
       rank_score         = excluded.rank_score,
       updated_at         = excluded.updated_at`,
  ).run(
    ref,
    vector.encoding,
    vector.outcome,
    vector.retrieval,
    vector.rankScore,
    ts,
    vector.encodingSource ?? "type-stub",
  );
}

/**
 * Load the salience row for one asset, or undefined if not yet computed.
 */
export function getAssetSalience(db: Database, ref: string): AssetSalienceRow | undefined {
  const row = db
    .prepare(
      `SELECT asset_ref, encoding_salience, outcome_salience, retrieval_salience,
              rank_score, consecutive_no_ops, updated_at, encoding_source
       FROM asset_salience WHERE asset_ref = ?`,
    )
    .get(ref);
  // Bun SQLite returns null (not undefined) when no row found.
  return row == null ? undefined : (row as AssetSalienceRow);
}

// ── Plasticity helpers ────────────────────────────────────────────────────────

/**
 * Increment `consecutive_no_ops` for an asset. Called after a no-op reflect/distill.
 * Has NO effect on `rank_score` — the plasticity counter only dampens consolidation
 * selection, not retrieval ranking. See plan §WS-1 step 8.
 *
 * Invariant: recordNoOp must never originate rank_score semantics. If the asset has
 * no salience row yet (persistence's best-effort try/catch may have swallowed an
 * error), we do nothing — a no-op counter is meaningless without a rank_score row,
 * and a synthetic INSERT would fabricate a rank_score=0 entry with nothing behind it.
 */
export function recordNoOp(db: Database, ref: string): void {
  db.prepare(
    `UPDATE asset_salience SET consecutive_no_ops = consecutive_no_ops + 1, updated_at = ? WHERE asset_ref = ?`,
  ).run(Date.now(), ref);
  // If changes === 0 the asset has no salience row yet — leave the table unchanged.
}

/**
 * Reset `consecutive_no_ops` to 0 when an asset produces an accepted change.
 * Call after a successful proposal acceptance or detected mutation.
 */
export function resetConsecutiveNoOps(db: Database, ref: string): void {
  db.prepare(`UPDATE asset_salience SET consecutive_no_ops = 0, updated_at = ? WHERE asset_ref = ?`).run(
    Date.now(),
    ref,
  );
}

/**
 * Return the `consecutive_no_ops` count for one asset. 0 when unknown.
 */
export function getConsecutiveNoOps(db: Database, ref: string): number {
  const row = db.prepare(`SELECT consecutive_no_ops FROM asset_salience WHERE asset_ref = ?`).get(ref) as
    | { consecutive_no_ops: number }
    | undefined;
  return row?.consecutive_no_ops ?? 0;
}

// ── New in #672 part 2 ────────────────────────────────────────────────────────

/**
 * Load every observed retrieval-salience value for a currently resolvable
 * asset. Zero is the no-observation floor and is excluded so corpus sparsity
 * does not masquerade as score entrenchment.
 *
 * Health computes its distribution diagnostic over this full observed set.
 * Sampling the top-N rows by `rank_score` first truncates the distribution and
 * can make a healthy corpus look artificially uniform.
 */
export function getObservedRetrievalSalience(db: Database): Array<{ retrieval_salience: number }> {
  return db
    .prepare(
      `SELECT retrieval_salience
         FROM asset_salience
        WHERE retrieval_salience > 0
          AND missing_since IS NULL
        ORDER BY retrieval_salience ASC`,
    )
    .all() as Array<{
    retrieval_salience: number;
  }>;
}

// ── #733 orphan-GC (missing_since) ──────────────────────────────────────────
//
// Support for `runOrphanStateGcPass` (src/commands/improve/loop-stages.ts).
// `missing_since` is added by migration 021; NULL means "not currently
// unresolvable". These are the only functions that may touch that column —
// the `state-table-sql` lint rule (#672) forbids raw asset_salience SQL
// anywhere else under src/.

export interface AssetSalienceMissingRow {
  asset_ref: string;
  missing_since: number | null;
}

/** List every `asset_salience` ref with its current `missing_since` marker. */
export function listAssetSalienceMissingState(db: Database): AssetSalienceMissingRow[] {
  return db.prepare(`SELECT asset_ref, missing_since FROM asset_salience`).all() as AssetSalienceMissingRow[];
}

/**
 * Stamp `missing_since = now` for the given refs, but ONLY where it is
 * currently NULL — a ref already stamped keeps its original timestamp so the
 * grace window measures from first sighting, not last. Refs with no row at
 * all are silently skipped (0 rows affected). Returns the number of rows
 * actually stamped.
 */
export function stampAssetSalienceMissing(db: Database, refs: readonly string[], now: number): number {
  if (refs.length === 0) return 0;
  const stmt = db.prepare(`UPDATE asset_salience SET missing_since = ? WHERE asset_ref = ? AND missing_since IS NULL`);
  let changed = 0;
  for (const ref of refs) changed += Number(stmt.run(now, ref).changes);
  return changed;
}

/**
 * Clear `missing_since` for refs that resolved again. Returns the number of
 * rows actually cleared.
 */
export function clearAssetSalienceMissing(db: Database, refs: readonly string[]): number {
  if (refs.length === 0) return 0;
  const stmt = db.prepare(
    `UPDATE asset_salience SET missing_since = NULL WHERE asset_ref = ? AND missing_since IS NOT NULL`,
  );
  let changed = 0;
  for (const ref of refs) changed += Number(stmt.run(ref).changes);
  return changed;
}

/**
 * Delete `asset_salience` rows whose `missing_since` is older than
 * `cutoffMs`. A single DELETE — SQLite runs it as one implicit transaction.
 * Returns the number of rows deleted.
 */
export function deleteAssetSalienceMissingBefore(db: Database, cutoffMs: number): number {
  return Number(
    db.prepare(`DELETE FROM asset_salience WHERE missing_since IS NOT NULL AND missing_since < ?`).run(cutoffMs)
      .changes,
  );
}

/** Count `asset_salience` rows currently marked missing (the live backlog size). */
export function countAssetSalienceMissing(db: Database): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM asset_salience WHERE missing_since IS NOT NULL`).get() as {
    n: number;
  };
  return row.n;
}
