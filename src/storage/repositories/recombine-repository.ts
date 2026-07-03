// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Repository for the state.db `recombine_hypotheses` table — the recombine
 * confirmation ledger (migration 014) plus its cap-aware decay sweep (#658).
 * Extracted verbatim from core/state-db.ts — queries and the Jaccard-overlap
 * matching logic unchanged, only relocated behind the repository boundary.
 * Re-exported by core/state-db.ts so existing importers resolve.
 *
 * @module recombine-repository
 */

import type { Database } from "../database";

/**
 * One row of the recombine confirmation ledger (migration 014). Keyed by the
 * deterministic `deriveRecombineLessonRef` value so re-induction of the SAME
 * member-set maps back to the SAME row across runs.
 */
export interface RecombineHypothesisRow {
  /** `lesson:recombined/<slug>-<hash>` ref — the promotion target asset. */
  hypothesis_ref: string;
  /** The cluster's shared relatedness signal (tag / entity) at induction time. */
  signature: string;
  /** Sorted member entryKeys joined — the membership fingerprint. */
  member_key: string;
  /** Current confirmation streak (reset on decay and on promotion). */
  consecutive_count: number;
  /** ISO-8601 UTC of the first induction. */
  first_seen_at: string;
  /** ISO-8601 UTC of the most recent induction. */
  last_seen_at: string;
  /** sourceRun token of the last induction; same-run idempotency guard. */
  last_run: string | null;
  /** Non-null once promoted; guards against double-promotion. */
  promoted_at: string | null;
  /** Reserved forensic metadata; defaults to '{}'. */
  metadata_json: string;
}

/**
 * Record an induction of a recombine hypothesis and return the new consecutive
 * count. INSERT … ON CONFLICT increments the streak, but the `last_run` guard
 * makes a repeated call within the SAME run idempotent (no double-increment if
 * the same ref appears twice in one run). On insert the streak starts at 1.
 */
export function recordRecombineInduction(
  db: Database,
  input: { hypothesisRef: string; signature: string; memberKey: string; seenAt: string; run: string },
): number {
  const row = db
    .prepare(`
      INSERT INTO recombine_hypotheses
        (hypothesis_ref, signature, member_key, consecutive_count, first_seen_at, last_seen_at, last_run)
      VALUES (?, ?, ?, 1, ?, ?, ?)
      ON CONFLICT(hypothesis_ref) DO UPDATE SET
        consecutive_count = consecutive_count + (CASE WHEN last_run IS excluded.last_run THEN 0 ELSE 1 END),
        last_seen_at = excluded.last_seen_at,
        last_run = excluded.last_run,
        signature = excluded.signature,
        member_key = excluded.member_key
      RETURNING consecutive_count
    `)
    .get(input.hypothesisRef, input.signature, input.memberKey, input.seenAt, input.seenAt, input.run) as {
    consecutive_count: number;
  } | null;
  return row?.consecutive_count ?? 0;
}

/**
 * #633 — find an existing pending (non-promoted) hypothesis row whose cluster
 * is the SAME generalization as a newly-induced one, matched by SIGNATURE plus
 * a Jaccard membership-overlap test, rather than an exact member-set hash.
 *
 * In a growing stash any added/removed memory changes the exact member set, so
 * the ref hash (and member_key) shift every run → a fresh row at count=1 → the
 * streak never reaches `confirmThreshold` and nothing ever promotes. Matching
 * on overlap lets a drifting-but-stable cluster keep accumulating under one row.
 *
 * Returns the matched row with the HIGHEST overlap (ties broken by most-recent
 * `last_seen_at`), or `undefined` when none clears `minOverlap`. Already-promoted
 * rows are ignored so a confirmed lesson is not reopened by a later induction.
 *
 * @param memberKey  the candidate cluster's membership fingerprint
 *                   (sorted member entryKeys joined by `|`).
 * @param minOverlap Jaccard threshold in [0,1]; a candidate matches when
 *                   |A∩B| / |A∪B| >= minOverlap.
 */
export function findMatchingRecombineHypothesis(
  db: Database,
  input: { signature: string; memberKey: string; minOverlap: number },
): RecombineHypothesisRow | undefined {
  const candidateMembers = new Set(input.memberKey.split("|").filter((m) => m.length > 0));
  if (candidateMembers.size === 0) return undefined;
  const rows = db
    .prepare(
      "SELECT * FROM recombine_hypotheses WHERE signature = ? AND promoted_at IS NULL ORDER BY last_seen_at DESC",
    )
    .all(input.signature) as RecombineHypothesisRow[];
  let best: RecombineHypothesisRow | undefined;
  let bestOverlap = -1;
  for (const row of rows) {
    const rowMembers = row.member_key.split("|").filter((m) => m.length > 0);
    if (rowMembers.length === 0) continue;
    let intersection = 0;
    for (const m of rowMembers) {
      if (candidateMembers.has(m)) intersection += 1;
    }
    const union = candidateMembers.size + rowMembers.length - intersection;
    const overlap = union === 0 ? 0 : intersection / union;
    // rows are ordered last_seen_at DESC, so a strict `>` keeps the most-recent
    // row on ties.
    if (overlap >= input.minOverlap && overlap > bestOverlap) {
      best = row;
      bestOverlap = overlap;
    }
  }
  return best;
}

/**
 * Fetch a single recombine hypothesis row, or `undefined` when the ref has
 * never been induced. Normalizes bun:sqlite null → undefined like
 * {@link getExtractedSession}.
 */
export function getRecombineHypothesis(db: Database, hypothesisRef: string): RecombineHypothesisRow | undefined {
  const row = db
    .prepare("SELECT * FROM recombine_hypotheses WHERE hypothesis_ref = ?")
    .get(hypothesisRef) as RecombineHypothesisRow | null;
  return row ?? undefined;
}

/**
 * Mark a hypothesis promoted: stamp `promoted_at` and reset the consecutive
 * count to 0, so it must re-accumulate a full confirmation streak before it can
 * promote again. The `promoted_at` non-null state is the double-promotion guard.
 */
export function markRecombineHypothesisPromoted(db: Database, hypothesisRef: string, promotedAt: string): void {
  db.prepare("UPDATE recombine_hypotheses SET promoted_at = ?, consecutive_count = 0 WHERE hypothesis_ref = ?").run(
    promotedAt,
    hypothesisRef,
  );
}

/**
 * A cluster that formed in the current run, identified the same way a hypothesis
 * row is: by its relatedness `signature` plus its membership fingerprint
 * (`memberKey` — sorted member entryKeys joined by `|`). Used by
 * {@link decayUnseenRecombineHypotheses} to spare cap-displaced hypotheses.
 */
export interface PresentCluster {
  signature: string;
  memberKey: string;
}

/**
 * #658 — does any current-run cluster match this hypothesis row under the SAME
 * signature + Jaccard-overlap rule used for re-induction? A match means the
 * cluster genuinely re-formed this run (it was merely cap-displaced out of the
 * processed top-`maxClustersPerRun` slice), so its streak must NOT be reset.
 */
function hypothesisMatchesAnyPresentCluster(
  row: { signature: string; member_key: string },
  presentClusters: readonly PresentCluster[],
  minOverlap: number,
): boolean {
  const rowMembers = row.member_key.split("|").filter((m) => m.length > 0);
  if (rowMembers.length === 0) return false;
  const rowSet = new Set(rowMembers);
  for (const cluster of presentClusters) {
    if (cluster.signature !== row.signature) continue;
    const clusterMembers = cluster.memberKey.split("|").filter((m) => m.length > 0);
    if (clusterMembers.length === 0) continue;
    let intersection = 0;
    for (const m of clusterMembers) {
      if (rowSet.has(m)) intersection += 1;
    }
    const union = rowSet.size + clusterMembers.length - intersection;
    const overlap = union === 0 ? 0 : intersection / union;
    if (overlap >= minOverlap) return true;
  }
  return false;
}

/**
 * Decay-to-zero every NON-promoted hypothesis NOT re-induced in the current run.
 *
 * A generalization that stops being supported by the corpus has lost its
 * confirmation streak, so we hard-reset `consecutive_count` to 0 (the
 * alternative — `count - 1` floored at 0 — tolerates a single noisy run but
 * blurs the "consecutive" semantics; hard-reset is the conservative choice).
 *
 * Only rows whose `hypothesis_ref` is NOT in `seenRefs` AND whose `last_run` is
 * NOT the current run are decayed. Already-promoted rows are left alone.
 *
 * #658 — CAP-AWARE decay. The recombine pass only re-inducts (and thus marks
 * `seen`) the top-`maxClustersPerRun` clusters, but a cluster genuinely
 * re-forms every run even when it is displaced below that cap. Resetting such a
 * row treats a SCHEDULING miss as a SUBSTANCE miss and traps the hypothesis
 * below `confirmThreshold` forever. When `opts.presentClusters` is supplied, a
 * row is SPARED from decay if it Jaccard-matches any present cluster (same
 * signature, overlap >= `opts.minOverlap`) — i.e. its cluster re-formed this run
 * but was cap-displaced. This does NOT advance the streak (only re-induction in
 * the processed slice does that, via {@link recordRecombineInduction}), so the
 * recurrence bar for promotion is unchanged; it only stops the cap from
 * manufacturing artificial misses. Omitting `presentClusters` preserves the
 * pre-#658 hard-reset-after-one-miss behaviour exactly.
 *
 * Returns the number of rows reset.
 */
export function decayUnseenRecombineHypotheses(
  db: Database,
  currentRun: string,
  seenRefs: readonly string[],
  opts?: { presentClusters: readonly PresentCluster[]; minOverlap: number },
): number {
  // #658 — when cap-aware sparing is requested, fold the cap-displaced rows into
  // the "seen" exclusion set: the underlying reset SQL already protects every
  // ref it is given, so sparing == treating a spared row exactly like a seen
  // row for this sweep (its count is left untouched, never advanced).
  let effectiveSeen: readonly string[] = seenRefs;
  if (opts && opts.presentClusters.length > 0) {
    const candidates = db
      .prepare(
        "SELECT hypothesis_ref, signature, member_key FROM recombine_hypotheses WHERE promoted_at IS NULL AND (last_run IS NULL OR last_run != ?) AND consecutive_count != 0",
      )
      .all(currentRun) as Array<{ hypothesis_ref: string; signature: string; member_key: string }>;
    const seenSet = new Set(seenRefs);
    for (const row of candidates) {
      if (seenSet.has(row.hypothesis_ref)) continue;
      if (hypothesisMatchesAnyPresentCluster(row, opts.presentClusters, opts.minOverlap)) {
        seenSet.add(row.hypothesis_ref);
      }
    }
    effectiveSeen = [...seenSet];
  }
  return decayUnseenRecombineHypothesesInner(db, currentRun, effectiveSeen);
}

/**
 * The raw reset sweep shared by the cap-aware wrapper above. Resets every
 * non-promoted row from a prior run whose ref is NOT in `seenRefs`. Kept private
 * so the param-ceiling chunking logic lives in one place.
 */
function decayUnseenRecombineHypothesesInner(db: Database, currentRun: string, seenRefs: readonly string[]): number {
  // Reset every eligible row, then exclude the seen refs in chunks to respect
  // the ~999 SQLite param ceiling. With no seen refs we reset all non-promoted
  // rows from prior runs in a single statement.
  if (seenRefs.length === 0) {
    const res = db
      .prepare(
        "UPDATE recombine_hypotheses SET consecutive_count = 0 WHERE promoted_at IS NULL AND (last_run IS NULL OR last_run != ?) AND consecutive_count != 0",
      )
      .run(currentRun);
    return Number(res.changes);
  }
  // A single NOT IN keeps the exclusion atomic (a chunked NOT IN would let a ref
  // excluded by one chunk still be reset by another chunk's statement). The
  // recombine pass caps RE-INDUCED clusters at `maxClustersPerRun` (a handful) —
  // but with #658 cap-aware sparing the caller folds every cap-displaced
  // (present-but-unprocessed) hypothesis into `effectiveSeen` too, so on a large
  // stash `seenRefs` here can carry MANY spared refs, not just the handful that
  // were processed. We cap defensively at ~900 (under SQLite's ~999 param
  // ceiling): if `effectiveSeen` somehow exceeds it we fall back to resetting all
  // eligible rows — which re-introduces the cap-displacement trap for THAT run
  // (spared rows get decayed because the NOT IN protection is dropped). That is a
  // rare, bounded degradation; a stash with >900 simultaneously-spared
  // hypotheses is far beyond current scale.
  if (seenRefs.length > 900) {
    const res = db
      .prepare(
        "UPDATE recombine_hypotheses SET consecutive_count = 0 WHERE promoted_at IS NULL AND (last_run IS NULL OR last_run != ?) AND consecutive_count != 0",
      )
      .run(currentRun);
    return Number(res.changes);
  }
  const placeholders = seenRefs.map(() => "?").join(",");
  const res = db
    .prepare(
      `UPDATE recombine_hypotheses SET consecutive_count = 0
       WHERE promoted_at IS NULL
         AND (last_run IS NULL OR last_run != ?)
         AND consecutive_count != 0
         AND hypothesis_ref NOT IN (${placeholders})`,
    )
    .run(currentRun, ...seenRefs);
  return Number(res.changes);
}
