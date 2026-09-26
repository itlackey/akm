// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The salience model every improve selector ranks by. Three sub-scores in
 * [0, 1] — encoding (intrinsic importance), outcome (usefulness when used) and
 * retrieval (frequency × recency) — project to
 * `rankScore = (w_e·encoding + w_o·outcome + w_r·retrieval) × sizePenalty`.
 * The sub-scores are stored in `state.db :: asset_salience`, the source of
 * truth for ranking. `consecutive_no_ops` there dampens consolidation
 * selection only, never `rankScore`, so a stable asset stays retrievable.
 */

import type { ImproveEligibleRef } from "../../core/improve-types";
import type { Database as IndexDatabase } from "../../storage/database";
import { getAllEntries } from "../../storage/repositories/index-entries-repository";
import { getUtilityScoresByIds } from "../../storage/repositories/index-utility-repository";
import type { AssetSalienceRow } from "../../storage/repositories/salience-repository";
import { WARM_START_CAP } from "./outcome-loop";

const DAY_MS = 86_400_000;
const RECENCY_HALFLIFE_DAYS = 21;
/**
 * The recency floor itself halves every 180 days, so an asset nobody uses keeps
 * drifting down instead of parking at the floor.
 */
const RECENCY_FLOOR_HALFLIFE_DAYS = 180;
/** Keeps frequency ordinal for assets whose last use is unknown. */
const RECENCY_EPSILON = 0.01;
const SIZE_FLOOR_BYTES = 200;

/** Default weights: the outcome term is on (opt out with `improve.salience.outcomeWeightEnabled: false`). */
export const W_ENCODING = 0.25;
export const W_OUTCOME = 0.15;
export const W_RETRIEVAL = 0.6;
/** Weights with the outcome term off. */
export const W_ENCODING_PARITY = 0.3;
export const W_OUTCOME_PARITY = 0;
export const W_RETRIEVAL_PARITY = 0.7;

/** Encoding salience by type, for assets with no content-derived score yet. */
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

export const DEFAULT_ENCODING_SALIENCE = 0.5;

export interface SalienceInputs {
  ref: string;
  /** Asset type; unknown or empty falls back to {@link DEFAULT_ENCODING_SALIENCE}. */
  type: string;
  /** Content-derived encoding salience (`scoreEncodingSalience`); absent means the type weight. */
  encodingSalience?: number;
  /** Search/show/curate count. */
  retrievalFreq: number;
  /** Last retrieval (ms); 0 or absent means unknown. */
  lastUseMs?: number;
  /** MemRL utility — the warm-start outcome for an asset with no outcome row yet. */
  utilityScore?: number;
  /** Normalized outcome salience (`outcomeScoreToSalience`); absent before the first outcome row. */
  outcomeSalience?: number;
  maxOutcomeScore?: number;
  sizeBytes?: number;
  now?: number;
  /** `false` switches to the parity weights (no outcome term). */
  outcomeWeightEnabled?: boolean;
}

/** Where a stored `encoding_salience` came from; a type stub never overwrites a content score. */
export type EncodingSource = "content" | "type-stub";

export interface SalienceVector {
  encoding: number;
  outcome: number;
  retrieval: number;
  rankScore: number;
  /** Always set by {@link computeSalience}; storage treats absent as `type-stub`. */
  encodingSource?: EncodingSource;
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/** The salience vector for one asset (pure). */
export function computeSalience(inputs: SalienceInputs): SalienceVector {
  const now = inputs.now ?? Date.now();
  const encodingSource: EncodingSource = inputs.encodingSalience !== undefined ? "content" : "type-stub";
  const encoding =
    inputs.encodingSalience !== undefined
      ? clamp01(inputs.encodingSalience)
      : (DEFAULT_TYPE_ENCODING_WEIGHTS[inputs.type] ?? DEFAULT_ENCODING_SALIENCE);
  // Without an outcome row, utility (capped) seeds the outcome term — the same
  // seed the first outcome row gets — so it is not zero at launch.
  const outcome =
    inputs.outcomeSalience !== undefined
      ? clamp01(inputs.outcomeSalience)
      : Math.min(WARM_START_CAP, Math.max(0, inputs.utilityScore ?? 0));
  // log(1 + freq) × recency, where recency halves every 21 days above a floor
  // that itself halves every 180 days; soft-capped to [0, 1).
  const lastUseMs = inputs.lastUseMs ?? 0;
  const useAgeDays = lastUseMs > 0 ? (now - lastUseMs) / DAY_MS : 9999;
  const recencyDecay = Math.max(
    RECENCY_EPSILON,
    0.1 * 0.5 ** (useAgeDays / RECENCY_FLOOR_HALFLIFE_DAYS) + 0.5 ** (useAgeDays / RECENCY_HALFLIFE_DAYS),
  );
  const rawRetrieval = Math.log(1 + inputs.retrievalFreq) * recencyDecay;
  const retrieval = rawRetrieval / (rawRetrieval + 1);
  // Larger assets rank slightly lower.
  const sizePenalty = 1 / Math.log10(Math.max(SIZE_FLOOR_BYTES, inputs.sizeBytes ?? 0));
  const [we, wo, wr] =
    inputs.outcomeWeightEnabled !== false
      ? [W_ENCODING, W_OUTCOME, W_RETRIEVAL]
      : [W_ENCODING_PARITY, W_OUTCOME_PARITY, W_RETRIEVAL_PARITY];
  const rankScore = clamp01((we * encoding + wo * outcome + wr * retrieval) * sizePenalty);
  return { encoding, outcome, retrieval, rankScore, encodingSource };
}

export {
  getAllRankScores,
  getAssetSalience,
  getConsecutiveNoOps,
  recordNoOp,
  resetConsecutiveNoOps,
  upsertAssetSalience,
} from "../../storage/repositories/salience-repository";
export type { AssetSalienceRow };

/** Whether a stored row's encoding salience is content-derived (unknown provenance is not). */
export function isContentEncodingRow(row: AssetSalienceRow): boolean {
  return row.encoding_source === "content";
}

/**
 * Consolidation selection only: an asset whose last three runs were no-ops
 * sorts at half its score. The stored rank is untouched.
 */
export const SALIENCE_NO_OP_DAMPEN_THRESHOLD = 3;
export const SALIENCE_NO_OP_DAMPEN_FACTOR = 0.5;

export interface RankChangeEntry {
  ref: string;
  oldRank: number;
  newRank: number;
  rankDelta: number;
}

export interface RankChangeReport {
  /** Refs that were in the old top `oldTopN` and fell below `forgettingThreshold`, biggest drop first. */
  forgettingCandidates: RankChangeEntry[];
  allChanges: RankChangeEntry[];
}

/** Forgetting safety: compare 1-indexed rank positions between two rankings. */
export function buildRankChangeReport(
  oldRanks: Map<string, number>,
  newRanks: Map<string, number>,
  oldTopN = 200,
  forgettingThreshold = 500,
): RankChangeReport {
  const allChanges: RankChangeEntry[] = [];
  for (const [ref, oldRank] of oldRanks) {
    const newRank = newRanks.get(ref);
    if (newRank !== undefined) allChanges.push({ ref, oldRank, newRank, rankDelta: newRank - oldRank });
  }
  const forgettingCandidates = allChanges
    .filter((c) => c.oldRank <= oldTopN && c.newRank > forgettingThreshold)
    .sort((a, b) => b.rankDelta - a.rankDelta);
  return { forgettingCandidates, allChanges };
}

/** `ref → last retrieval (ms)` from the index's utility scores; absent means never retrieved. */
export function getLastUseMsByRef(
  indexDb: IndexDatabase,
  candidates: readonly Pick<ImproveEligibleRef, "ref" | "itemRef">[],
): Map<string, number> {
  const result = new Map<string, number>();
  if (candidates.length === 0) return result;
  const refByItemRef = new Map(
    candidates.flatMap((candidate) => (candidate.itemRef ? [[candidate.itemRef, candidate.ref] as const] : [])),
  );
  const idToRef = new Map<number, string>();
  for (const indexed of getAllEntries(indexDb)) {
    const ref = refByItemRef.get(indexed.itemRef);
    if (ref) idToRef.set(indexed.id, ref);
  }
  if (idToRef.size === 0) return result;
  const { global: scores } = getUtilityScoresByIds(indexDb, [...idToRef.keys()]);
  for (const [id, row] of scores) {
    const ref = idToRef.get(id);
    const lastUsedAt = row.lastUsedAt;
    if (!ref || !lastUsedAt) continue;
    const ms = typeof lastUsedAt === "number" ? lastUsedAt : Date.parse(lastUsedAt);
    if (ms > 0) result.set(ref, ms);
  }
  return result;
}
