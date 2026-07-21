// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Pure, rank-aware curate quality metrics.
 *
 * These measure ORDER, not just set membership — the gap that let the curate
 * "keyword leapfrog" bug ship past a recall-only check (a junk hit and a good
 * hit both being present scores 1.0 on recall even when junk ranks first).
 *
 * Canonical home (chunk-9 WI-9.4e, anchors C.3 — moved verbatim from
 * `src/core/eval/rank-metrics.ts`, which had zero `src/` importers). Real
 * consumers: the akm-eval harness runner (`curate-bench.ts`, black-box CLI,
 * via the sibling `curate-metrics.ts` re-export shim), the in-process CI
 * guards `tests/curate-metrics.test.ts` and
 * `tests/integration/curate-golden-eval.test.ts` (both via that same shim),
 * and the R5 collapse/churn detector's INTEGRATION TEST
 * (`tests/integration/commands/improve/collapse-detector.test.ts`, which
 * imports `ndcgAtK` directly to score its collapse simulation) — NOT the
 * `src/commands/improve/collapse-detector.ts` production module itself,
 * which never imported this file. No IO, no akm imports — just arrays of
 * refs in returned order vs. labeled judgments.
 */

export interface CurateJudgment {
  /** Stable case id. */
  id: string;
  /** The curate query string. */
  query: string;
  /** Ground-truth relevant refs (order-independent set, for recall). */
  relevant: string[];
  /** Ranked ideal order (most→least relevant). Used for nDCG/MRR weighting. */
  idealOrder: string[];
  /** Clearly off-topic refs that must never outrank a relevant ref. */
  banned: string[];
  /** Curate limit to request for this case. */
  limit: number;
}

export interface CurateCaseMetrics {
  /** nDCG@k over binary relevance. 0..1. */
  ndcg: number;
  /** recall@k = |returned ∩ relevant| / |relevant|. 0..1. */
  recall: number;
  /** Reciprocal rank of the first relevant ref. 0..1. */
  mrr: number;
  /**
   * Leapfrog gate, embedder-robust: 1.0 when no banned ref outranks a present
   * relevant ref; degrades toward 0 as banned refs leapfrog relevant ones.
   */
  noBannedAboveRequired: number;
  /** Count of banned refs that outranked a present relevant ref. */
  bannedLeapfrogCount: number;
  /** Weighted composite (see DEFAULT_CURATE_WEIGHTS). 0..1. */
  score: number;
}

export const DEFAULT_CURATE_WEIGHTS = {
  ndcg: 0.5,
  recall: 0.2,
  mrr: 0.1,
  noBannedAboveRequired: 0.2,
} as const;

export type CurateWeights = typeof DEFAULT_CURATE_WEIGHTS;

/** nDCG@k with binary relevance: gain 1 for relevant refs, 0 otherwise. */
export function ndcgAtK(returned: string[], relevant: Set<string>, k: number): number {
  const top = returned.slice(0, k);
  let dcg = 0;
  for (let i = 0; i < top.length; i++) {
    if (relevant.has(top[i]!)) dcg += 1 / Math.log2(i + 2);
  }
  const idealCount = Math.min(k, relevant.size);
  let idcg = 0;
  for (let i = 0; i < idealCount; i++) idcg += 1 / Math.log2(i + 2);
  return idcg === 0 ? 1 : dcg / idcg;
}

export function recallAtK(returned: string[], relevant: Set<string>, k: number): number {
  if (relevant.size === 0) return 1;
  const top = new Set(returned.slice(0, k));
  let hit = 0;
  for (const r of relevant) if (top.has(r)) hit += 1;
  return hit / relevant.size;
}

export function mrr(returned: string[], relevant: Set<string>): number {
  for (let i = 0; i < returned.length; i++) {
    if (relevant.has(returned[i]!)) return 1 / (i + 1);
  }
  return 0;
}

/**
 * Leapfrog gate. A banned ref "leapfrogs" when it appears ABOVE at least one
 * present relevant ref. Returns the fraction of present banned refs that do
 * NOT leapfrog (1.0 when no banned ref is present, or none leapfrog), plus the
 * raw violation count.
 */
export function noBannedAboveRequired(
  returned: string[],
  relevant: Set<string>,
  banned: Set<string>,
): { score: number; leapfrogCount: number } {
  const rankOf = new Map<string, number>();
  returned.forEach((ref, i) => {
    if (!rankOf.has(ref)) rankOf.set(ref, i);
  });
  const relevantRanks = returned.map((ref, i) => (relevant.has(ref) ? i : -1)).filter((i) => i >= 0);
  if (relevantRanks.length === 0) {
    // No relevant ref present to be leapfrogged — gate is vacuously satisfied.
    return { score: 1, leapfrogCount: 0 };
  }
  const worstRelevantRank = Math.max(...relevantRanks);
  const bannedPresent = returned.filter((ref) => banned.has(ref));
  if (bannedPresent.length === 0) return { score: 1, leapfrogCount: 0 };
  let leapfrog = 0;
  for (const b of bannedPresent) {
    const rb = rankOf.get(b);
    if (rb !== undefined && rb < worstRelevantRank) leapfrog += 1;
  }
  return { score: 1 - leapfrog / bannedPresent.length, leapfrogCount: leapfrog };
}

/** Score a single curate result (ordered refs) against its judgment. */
export function scoreCurateCase(
  returned: string[],
  judgment: CurateJudgment,
  weights: CurateWeights = DEFAULT_CURATE_WEIGHTS,
): CurateCaseMetrics {
  const k = judgment.limit;
  const relevant = new Set(judgment.relevant);
  const banned = new Set(judgment.banned);
  const ndcg = ndcgAtK(returned, relevant, k);
  const recall = recallAtK(returned, relevant, k);
  const rr = mrr(returned, relevant);
  const gate = noBannedAboveRequired(returned, relevant, banned);
  const score =
    ndcg * weights.ndcg + recall * weights.recall + rr * weights.mrr + gate.score * weights.noBannedAboveRequired;
  return {
    ndcg,
    recall,
    mrr: rr,
    noBannedAboveRequired: gate.score,
    bannedLeapfrogCount: gate.leapfrogCount,
    score,
  };
}

export interface CurateSuiteSummary {
  caseCount: number;
  meanScore: number;
  meanNdcg: number;
  meanRecall: number;
  meanMrr: number;
  meanNoBannedAboveRequired: number;
  totalBannedLeapfrog: number;
}

/** Aggregate per-case metrics into a suite summary. */
export function summarizeCurateMetrics(metrics: CurateCaseMetrics[]): CurateSuiteSummary {
  const n = metrics.length;
  if (n === 0) {
    return {
      caseCount: 0,
      meanScore: 0,
      meanNdcg: 0,
      meanRecall: 0,
      meanMrr: 0,
      meanNoBannedAboveRequired: 1,
      totalBannedLeapfrog: 0,
    };
  }
  const sum = (sel: (m: CurateCaseMetrics) => number) => metrics.reduce((a, m) => a + sel(m), 0);
  return {
    caseCount: n,
    meanScore: sum((m) => m.score) / n,
    meanNdcg: sum((m) => m.ndcg) / n,
    meanRecall: sum((m) => m.recall) / n,
    meanMrr: sum((m) => m.mrr) / n,
    meanNoBannedAboveRequired: sum((m) => m.noBannedAboveRequired) / n,
    totalBannedLeapfrog: sum((m) => m.bannedLeapfrogCount),
  };
}
