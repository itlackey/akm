// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * WS-1 — Unified SALIENCE model (S1 seam).
 *
 * Replaces the three competing attention formulas that existed across:
 *   - proactive-maintenance.ts:186 — `importance × log(1+freq) × recencyDecay / log10(size)`
 *   - feedback-valence.ts:111      — `combinedEligibilityScore = utility·0.7 + valence·0.3`
 *   - getUtilityScoresByIds        — MemRL utility EMA (#386)
 *
 * ## Salience vector (three independently-stored, independently-decayable sub-scores)
 *
 * | Sub-score         | Brain analogy          | Source                          |
 * |-------------------|------------------------|---------------------------------|
 * | `encodingSalience`| Amygdala tagging (Gap 1)| Set at extract; v1 = type weight|
 * | `outcomeSalience` | Dopaminergic outcome   | WS-2 (0 until that lands)       |
 * | `retrievalSalience`| Hippocampal frequency+recency | usage_events + utility_scores |
 *
 * ## Projection
 *
 * `rankScore = (w_e·encoding + w_o·outcome + w_r·retrieval) × sizePenalty`, normalized [0,1].
 *
 * **WS-2 default-off (Part-V gate):**
 * `w_o = 0.15` is the target but is applied only when `outcomeWeightEnabled=true`
 * (set via `improve.salience.outcomeWeightEnabled: true` in config after running
 * Part-V T0 baseline). Default: WS-1 parity weights `w_e=0.30, w_r=0.70, w_o=0`.
 * `outcomeSalience` is populated from `asset_outcome.outcome_score` (WS-2) for
 * observability regardless of the flag.
 *
 * ## Plasticity
 *
 * `consecutive_no_ops` (INTEGER column in `asset_salience`) dampens CONSOLIDATION-
 * SELECTION only — it is intentionally NOT applied to `rankScore`, so a stable
 * asset stays fully retrievable while no longer consuming repeated LLM merge
 * attempts. See `getConsecutiveNoOps` / `recordNoOp` / `resetConsecutiveNoOps`.
 *
 * ## Canonical store
 *
 * The three sub-scores live in `state.db :: asset_salience` (canonical).
 * An optional frontmatter mirror of the stable `encodingSalience` is allowed for
 * portability (issue #608 may write it there), but state.db is the source of truth
 * for ranking. This prevents the frontmatter-vs-state.db split that issue #608
 * would otherwise create (#608 pull-forward decision from Part VI).
 *
 * @module salience
 */

import { makeAssetRef } from "../../core/asset/asset-ref";
import type { AkmAssetType } from "../../core/common";
import type { Database } from "../../core/state-db";
import { getAllEntries, getUtilityScoresByIds } from "../../indexer/db/db";
import type { Database as IndexDatabase } from "../../storage/database";
import { WARM_START_CAP } from "./outcome-loop";

// ── One day in ms ─────────────────────────────────────────────────────────────
const DAY_MS = 86_400_000;

// ── Recency decay half-life (mirrors the proactive-maintenance prototype) ─────
const RECENCY_HALFLIFE_DAYS = 21;

// ── Size proxy floor (avoids log10(0)) ────────────────────────────────────────
const SIZE_FLOOR_BYTES = 200;

// ── Projection weights ────────────────────────────────────────────────────────
//
// These constants reflect the WS-2 TARGET values (used when outcomeWeightEnabled=true).
// Default ranking uses WS-1 parity weights (w_e=0.30, w_r=0.70, w_o=0) until the
// maintainer opts in via `improve.salience.outcomeWeightEnabled: true` after running
// the Part-V T0 baseline (scripts/akm-eval + health report).
//
// WS-2 opt-in split (w_e=0.25, w_o=0.15, w_r=0.60, sum = 1.0):
// [exp] Expert recommendation: encoding should be moderate so a type-importance
// stub does not completely dominate; retrieval should be strong since it directly
// measures use; outcome provides a quality signal proportional to usefulness.
//
// Re-tune via the Part-V measurement protocol if the throughput/quality gate
// shows regression after enabling the outcome weight.
export const W_ENCODING = 0.25; // WS-2 target encoding weight (w_e)
export const W_OUTCOME = 0.15; // WS-2 target outcome weight (w_o)
export const W_RETRIEVAL = 0.6; // WS-2 target retrieval weight (w_r)

// Compile-time guard: weights must sum to 1.0 (±ε). The TS initializer runs
// at module load, not build time, so this acts as a startup assertion.
if (Math.abs(W_ENCODING + W_OUTCOME + W_RETRIEVAL - 1.0) > 1e-9) {
  throw new Error(
    `salience.ts: W_ENCODING + W_OUTCOME + W_RETRIEVAL must equal 1.0 (got ${W_ENCODING + W_OUTCOME + W_RETRIEVAL})`,
  );
}

// ── WS-1 parity weights ───────────────────────────────────────────────────────
//
// These constants reflect the default WS-1 parity weights used when
// `outcomeWeightEnabled` is false/absent (the default). They preserve the
// WS-1 two-way split (w_e=0.30, w_r=0.70) with w_o=0 so outcome does not
// affect rankScore until the operator opts in after the Part-V baseline run.
//
// Named here (rather than inline literals in the else branch) so a future
// re-tune has a single source of truth and the sum-to-1 guard below catches
// any accidental mis-edit.
export const W_ENCODING_PARITY = 0.3; // WS-1 parity encoding weight
export const W_OUTCOME_PARITY = 0; // WS-1 parity outcome weight (0 = disabled)
export const W_RETRIEVAL_PARITY = 0.7; // WS-1 parity retrieval weight

// Startup guard: parity triple must also sum to 1.0 (±ε).
if (Math.abs(W_ENCODING_PARITY + W_OUTCOME_PARITY + W_RETRIEVAL_PARITY - 1.0) > 1e-9) {
  throw new Error(
    `salience.ts: W_ENCODING_PARITY + W_OUTCOME_PARITY + W_RETRIEVAL_PARITY must equal 1.0 (got ${W_ENCODING_PARITY + W_OUTCOME_PARITY + W_RETRIEVAL_PARITY})`,
  );
}

// ── Type-importance stubs (Gap 1 placeholder until #608 lands) ────────────────
//
// encodingSalience v1 = a fixed weight by asset type, so the vector is seeded
// at table-creation time from type alone. The full encoding-time estimator
// (novelty/prediction-error scoring at extract) is deferred to 0.10+ (#608).
export const DEFAULT_TYPE_ENCODING_WEIGHTS: Readonly<Record<string, number>> = Object.freeze({
  skill: 0.9,
  agent: 0.9,
  command: 0.8,
  workflow: 0.8,
  lesson: 0.75,
  knowledge: 0.7,
  script: 0.6,
  memory: 0.5,
});

/** Default encoding salience for types not in the table above. */
export const DEFAULT_ENCODING_SALIENCE = 0.5;

// ── Input shape ───────────────────────────────────────────────────────────────

export interface SalienceInputs {
  /** Asset ref (`type:name`). */
  ref: string;
  /** Asset type string (parsed from ref). Empty string falls back to default weight. */
  type: string;
  /**
   * Retrieval frequency: total count of search/show/curate events for this ref.
   * From `getRetrievalCounts()` in the index DB.
   */
  retrievalFreq: number;
  /**
   * Most-recent retrieval timestamp in milliseconds (from `utility_scores.last_used_at`
   * in the index DB, or `asset_outcome.last_retrieved_at` when WS-2 is available).
   * 0 / undefined = unknown / never retrieved.
   */
  lastUseMs?: number;
  /**
   * Current MemRL utility score in [0,1] from `getUtilityScoresByIds`.
   * Used to seed `outcomeSalience` for the warm-start (WS-2).
   * Optional — defaults to 0.
   */
  utilityScore?: number;
  /**
   * Outcome salience from `asset_outcome.outcome_score` via WS-2.
   * Converted to [0,1] by `outcomeScoreToSalience` before use.
   * When absent (table not yet written) the warm-start seed from `utilityScore`
   * is used instead, so `outcomeSalience` is never zero on first run.
   *
   * Pass `undefined` when the asset has no row yet in `asset_outcome`.
   */
  outcomeSalience?: number;
  /**
   * Stash-wide maximum outcome_score (for normalisation in `outcomeSalience`).
   * Required when `outcomeSalience` is provided; ignored when absent.
   * Callers compute this once per batch from `getAllAssetOutcomes()`.
   */
  maxOutcomeScore?: number;
  /** Asset size in bytes (for the size-cost penalty denominator). Defaults to SIZE_FLOOR_BYTES. */
  sizeBytes?: number;
  /** Injectable clock (ms). Defaults to Date.now(). */
  now?: number;
  /**
   * WS-2 Part-V gate: when `true` the outcome-weight term (`w_o=0.15`) is
   * active and weights shift to `w_e=0.25, w_o=0.15, w_r=0.60`.
   *
   * Default `false` (absent) — WS-1 parity weights `w_e=0.30, w_r=0.70`
   * until the maintainer runs the Part-V measurement protocol
   * (`scripts/akm-eval` + health report) and opts in via
   * `improve.salience.outcomeWeightEnabled: true` in the config.
   */
  outcomeWeightEnabled?: boolean;
}

// ── Output shape ──────────────────────────────────────────────────────────────

export interface SalienceVector {
  /**
   * Encoding salience in [0,1] — intrinsic importance set at extract/creation.
   * v1 stub: type-importance weight. Gap 1 / #608 will replace with a real
   * novelty/prediction-error estimator at extract time.
   */
  encoding: number;
  /**
   * Outcome salience in [0,1] — differential usefulness signal (WS-2).
   * Sourced from `asset_outcome.outcome_score`, normalised by
   * `outcomeScoreToSalience`. Non-zero once WS-2 has populated the table.
   */
  outcome: number;
  /**
   * Retrieval salience in [0,1] — frequency × recency.
   * The term that `selectProactiveMaintenanceRefs` previously computed inline.
   */
  retrieval: number;
  /**
   * Scalar projection: `(w_e·encoding + w_o·outcome + w_r·retrieval) × sizePenalty`,
   * normalized to [0,1]. Used for ranking by every selector.
   */
  rankScore: number;
}

// ── Core computation ─────────────────────────────────────────────────────────

/**
 * Compute the salience vector for one asset.
 *
 * Pure function — no I/O. All inputs are pre-fetched by the caller.
 */
export function computeSalience(inputs: SalienceInputs): SalienceVector {
  const now = inputs.now ?? Date.now();

  // ── Encoding salience (Gap 1 stub) ──────────────────────────────────────────
  const encoding = DEFAULT_TYPE_ENCODING_WEIGHTS[inputs.type] ?? DEFAULT_ENCODING_SALIENCE;

  // ── Outcome salience (WS-2 active) ────────────────────────────────────────
  //
  // When `inputs.outcomeSalience` is provided (WS-2 has populated asset_outcome
  // for this ref), use it directly — it has already been normalised by
  // `outcomeScoreToSalience` in outcome-loop.ts (value in [DIVERSITY_FLOOR, 1]).
  //
  // When absent (new asset, no WS-2 row yet): fall back to the warm-start seed
  // from `utilityScore` clipped to [0, WARM_START_CAP], matching the seed
  // value that `updateAssetOutcome` writes on first row creation. This ensures
  // `outcomeSalience` is non-zero at launch for assets with utility history
  // (avoiding the starvation problem described in the plan §WS-2 warm start).
  let outcome: number;
  if (inputs.outcomeSalience !== undefined) {
    // Direct pass-through — caller already normalised via outcomeScoreToSalience.
    outcome = Math.min(1, Math.max(0, inputs.outcomeSalience));
  } else {
    // Warm-start fallback: clip utility to [0, WARM_START_CAP] so the
    // outcomeSalience term contributes a modest non-zero baseline.
    outcome = Math.min(WARM_START_CAP, Math.max(0, inputs.utilityScore ?? 0));
  }

  // ── Retrieval salience ─────────────────────────────────────────────────────
  //
  // Formula: log(1 + freq) × recencyDecay
  //   log(1+freq): sub-linear frequency term (same as proactive-maintenance prototype).
  //   recencyDecay: 0.1 + 0.5^(useAgeDays/halflife) — decays to 0.1 floor when stale.
  //     lastUseMs=0/undefined → useAgeDays=9999 → recencyDecay≈0.1 (floor).
  //
  // The recency term is MANDATORY (plan requirement §WS-1 step 2). Without it
  // retrievalSalience degenerates to a non-decaying frequency count and the WS-3
  // homeostatic step-0 demotion has nothing to act on.
  const lastUseMs = inputs.lastUseMs ?? 0;
  const useAgeDays = lastUseMs > 0 ? (now - lastUseMs) / DAY_MS : 9999;
  const recencyDecay = 0.1 + 0.5 ** (useAgeDays / RECENCY_HALFLIFE_DAYS);
  const rawRetrieval = Math.log(1 + inputs.retrievalFreq) * recencyDecay;

  // ── Size penalty ─────────────────────────────────────────────────────────────
  // 1/log10(size): larger assets are slightly deprioritized (same as proactive prototype).
  const sizeProxy = Math.max(SIZE_FLOOR_BYTES, inputs.sizeBytes ?? 0);
  const sizePenalty = 1 / Math.log10(sizeProxy);

  // ── Projection → rankScore ────────────────────────────────────────────────
  //
  // Raw projection may be > 1 (log retrieval terms can exceed 1 for high freq + fresh use).
  // Normalize by the theoretical maximum of the retrieval component:
  //   max retrievalRaw = log(1 + Infinity) × (0.1 + 1.0) = Infinity, so we
  //   cap instead — rankScore is clamped to [0,1] after applying the size penalty.
  //
  // Normalization approach: we scale the combined linear sum to [0,1] by clamping,
  // after applying the size penalty. The encoding term is already in [0,1]; the
  // retrieval term is open-ended but bounded in practice by log(1+N)×1.1 where N
  // is the retrieval count. We normalize `retrieval` to [0,1] using a soft cap:
  //   retrieval_normalized = rawRetrieval / (rawRetrieval + 1)
  // which asymptotes to 1 and equals 0.5 at rawRetrieval=1. This is the same
  // formula used for MemRL utility updates.
  const retrieval = rawRetrieval / (rawRetrieval + 1);

  // ── Weight selection (Part-V gate) ────────────────────────────────────────
  //
  // When `outcomeWeightEnabled` is false/absent (default): use WS-1 parity
  // weights (w_e=0.30, w_r=0.70, w_o=0) so ranking is unchanged from the WS-1
  // baseline. The `outcome` sub-score is still computed and stored in the
  // salience vector for observability, but it does not affect rankScore.
  //
  // When `outcomeWeightEnabled` is true (operator opt-in after Part-V run):
  // use WS-2 weights (w_e=0.25, w_o=0.15, w_r=0.60).
  //
  // The constants W_ENCODING, W_OUTCOME, W_RETRIEVAL always reflect the
  // WS-2 target values for documentation and re-tune reference.
  let we: number;
  let wo: number;
  let wr: number;
  if (inputs.outcomeWeightEnabled === true) {
    // WS-2 active: three-way split from Part-V operator opt-in.
    we = W_ENCODING; // 0.25
    wo = W_OUTCOME; // 0.15
    wr = W_RETRIEVAL; // 0.60
  } else {
    // WS-1 parity (default): w_o=0, redistribute to WS-1 proportions.
    // Original WS-1 split was w_e=0.30, w_r=0.70.
    we = W_ENCODING_PARITY;
    wo = W_OUTCOME_PARITY;
    wr = W_RETRIEVAL_PARITY;
  }

  const rawRankScore = (we * encoding + wo * outcome + wr * retrieval) * sizePenalty;
  const rankScore = Math.min(1, Math.max(0, rawRankScore));

  return { encoding, outcome, retrieval, rankScore };
}

// ── state.db persistence ─────────────────────────────────────────────────────
//
// The three sub-scores live in state.db::asset_salience. This module owns the
// read/write helpers; migrations live in state-db.ts (migration 009).

export interface AssetSalienceRow {
  asset_ref: string;
  encoding_salience: number;
  outcome_salience: number;
  retrieval_salience: number;
  rank_score: number;
  consecutive_no_ops: number;
  updated_at: number;
}

/**
 * Upsert salience scores for one asset into state.db.
 *
 * Idempotent: safe to call every run; updates all columns on conflict.
 */
export function upsertAssetSalience(db: Database, ref: string, vector: SalienceVector, now?: number): void {
  const ts = now ?? Date.now();
  db.prepare(
    `INSERT INTO asset_salience
       (asset_ref, encoding_salience, outcome_salience, retrieval_salience, rank_score, consecutive_no_ops, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, ?)
     ON CONFLICT(asset_ref) DO UPDATE SET
       encoding_salience  = excluded.encoding_salience,
       outcome_salience   = excluded.outcome_salience,
       retrieval_salience = excluded.retrieval_salience,
       rank_score         = excluded.rank_score,
       updated_at         = excluded.updated_at`,
  ).run(ref, vector.encoding, vector.outcome, vector.retrieval, vector.rankScore, ts);
}

/**
 * Load the salience row for one asset, or undefined if not yet computed.
 */
export function getAssetSalience(db: Database, ref: string): AssetSalienceRow | undefined {
  const row = db
    .prepare(
      `SELECT asset_ref, encoding_salience, outcome_salience, retrieval_salience,
              rank_score, consecutive_no_ops, updated_at
       FROM asset_salience WHERE asset_ref = ?`,
    )
    .get(ref);
  // Bun SQLite returns null (not undefined) when no row found.
  return row == null ? undefined : (row as AssetSalienceRow);
}

/**
 * Load ALL rank scores from the asset_salience table (full-stash query).
 *
 * Used by the forgetting-safety report (plan §WS-1 step 7) to compute stash-wide
 * rank positions rather than pool-relative positions. Returns an empty Map when the
 * table is empty (first WS-1 run = no pre-existing rows).
 *
 * Order is unspecified; callers must sort before assigning 1-indexed positions.
 */
export function getAllRankScores(db: Database): Map<string, number> {
  const rows = db.prepare("SELECT asset_ref, rank_score FROM asset_salience").all() as Array<{
    asset_ref: string;
    rank_score: number;
  }>;
  const result = new Map<string, number>();
  for (const row of rows) {
    result.set(row.asset_ref, row.rank_score);
  }
  return result;
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
 * and a synthetic INSERT would fabricate a rank_score=0 entry that could produce
 * false catastrophic-forgetting signals in buildRankChangeReport.
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

// ── Consolidation-selection dampener constants ────────────────────────────────
//
// Assets with consecutive_no_ops >= THRESHOLD are deprioritised in the
// SELECTION ORDER only. The persisted rank_score is intentionally left
// unchanged so stable assets remain fully retrievable by other callers.
//
// Tuning guidance:
//   THRESHOLD — how many consecutive no-op runs before dampening kicks in.
//               3 means "skipped three times in a row", which signals the
//               LLM consistently has nothing to say about this asset.
//   FACTOR    — multiplicative penalty on the effective selection score.
//               0.5 halves the apparent score so a dampened asset sorts
//               after any peer with >= half its rankScore.
export const SALIENCE_NO_OP_DAMPEN_THRESHOLD = 3;
export const SALIENCE_NO_OP_DAMPEN_FACTOR = 0.5;

// ── Forgetting-safety rank-change report ─────────────────────────────────────

export interface RankChangeEntry {
  ref: string;
  oldRank: number;
  newRank: number;
  rankDelta: number;
}

export interface RankChangeReport {
  /** Assets that were in the old top-200 but fell below position 500 in the new ranking. */
  forgettingCandidates: RankChangeEntry[];
  /** Full distribution of rank changes (all refs with a previous rank). */
  allChanges: RankChangeEntry[];
}

/**
 * Emit the forgetting-safety rank-change distribution report.
 *
 * Compares the provided `newRanks` (Map<ref, position (1-indexed)>) against
 * the provided `oldRanks` and flags refs that were in the old top-200 but
 * are now below position 500 as "forgetting candidates".
 *
 * Caller is responsible for computing old/new rank positions before and after
 * the WS-1 formula cutover. Called once at cutover, not every run.
 *
 * @param oldRanks - Map<ref, 1-indexed rank position> under the OLD formula.
 * @param newRanks - Map<ref, 1-indexed rank position> under the NEW formula.
 * @param oldTopN  - Assets in old top-N to guard (default: 200).
 * @param forgettingThreshold - New rank position below which a fall is flagged (default: 500).
 */
export function buildRankChangeReport(
  oldRanks: Map<string, number>,
  newRanks: Map<string, number>,
  oldTopN = 200,
  forgettingThreshold = 500,
): RankChangeReport {
  const allChanges: RankChangeEntry[] = [];
  const forgettingCandidates: RankChangeEntry[] = [];

  for (const [ref, oldRank] of oldRanks) {
    const newRank = newRanks.get(ref);
    if (newRank === undefined) continue; // ref not in new ranking
    const rankDelta = newRank - oldRank; // positive = fell in rank
    allChanges.push({ ref, oldRank, newRank, rankDelta });
    if (oldRank <= oldTopN && newRank > forgettingThreshold) {
      forgettingCandidates.push({ ref, oldRank, newRank, rankDelta });
    }
  }

  // Sort by magnitude of rank drop (most dramatic first).
  forgettingCandidates.sort((a, b) => b.rankDelta - a.rankDelta);

  return { forgettingCandidates, allChanges };
}

// ── Last-use timestamp lookup helper ─────────────────────────────────────────
//
// Wraps the index DB query to retrieve the last-retrieval timestamp per ref,
// so callers do not need to import the raw db helpers directly. Returns a Map
// keyed by the same ref strings passed in.
//
// Source: `utility_scores.last_used_at` (ISO-8601 string) joined to entries
// via entry_id. WS-2 may later supersede this with `asset_outcome.last_retrieved_at`.

/**
 * Build a Map<ref, lastUseMs> from the index database's utility_scores table.
 *
 * Returns only refs that have a non-null `last_used_at`. Refs absent from the
 * map should be treated as never retrieved (lastUseMs = 0).
 *
 * @param indexDb - An open read-capable index database connection.
 * @param refs    - The set of asset refs to look up.
 */
export function getLastUseMsByRef(indexDb: IndexDatabase, refs: string[]): Map<string, number> {
  const result = new Map<string, number>();
  if (refs.length === 0) return result;

  const refSet = new Set(refs);
  const allEntries = getAllEntries(indexDb);
  const idToRef = new Map<number, string>();
  for (const indexed of allEntries) {
    const ref = makeAssetRef(indexed.entry.type as AkmAssetType, indexed.entry.name);
    if (refSet.has(ref)) idToRef.set(indexed.id, ref);
  }

  const ids = [...idToRef.keys()];
  if (ids.length === 0) return result;

  const { global: scores } = getUtilityScoresByIds(indexDb, ids);
  for (const [id, row] of scores) {
    const ref = idToRef.get(id);
    if (!ref) continue;
    const lastUsedAt = row.lastUsedAt;
    if (!lastUsedAt) continue;
    const ms = typeof lastUsedAt === "number" ? lastUsedAt : Date.parse(lastUsedAt);
    if (ms > 0) result.set(ref, ms);
  }

  return result;
}
