// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Reciprocal rank fusion (Cormack, Clarke and Büttcher, SIGIR 2009) of the
 * lexical and vector candidate lists, then one feedback factor on the fused
 * score — the whole of search ranking.
 *
 * Fusing ranks rather than scores needs no calibration between BM25 and cosine
 * similarity, so it holds for every embedding model. On the retrieval suite,
 * BM25 fused with document vectors this way scored nDCG@10 0.568 against 0.349
 * for the additive boost stack it replaced
 * (`akm/eval/retrieval/reports/baseline-2026-09-27.md`).
 */

import { compareCodePoints } from "../../core/common";

/** The RRF constant: a candidate at rank r in a channel adds 1 / (RRF_K + r). */
export const RRF_K = 60;

/** One channel candidate: an entry id and its durable `item_ref`. */
export interface RankedRef {
  id: number;
  itemRef: string;
}

export interface FusedCandidate extends RankedRef {
  /** Sum of 1 / (RRF_K + rank) over the channels that returned the candidate. */
  score: number;
  /** One-based rank in each channel, in channel order; undefined where the channel did not return it. */
  ranks: Array<number | undefined>;
}

/**
 * Fuse ranked channels with equal weights. Candidates are ordered by fused
 * score, then by `itemRef`, so equal scores always come back in the same order.
 */
export function reciprocalRankFusion(channels: ReadonlyArray<readonly RankedRef[]>): FusedCandidate[] {
  const fused = new Map<number, FusedCandidate>();
  channels.forEach((channel, channelIndex) => {
    channel.forEach((candidate, position) => {
      let entry = fused.get(candidate.id);
      if (entry === undefined) {
        entry = { id: candidate.id, itemRef: candidate.itemRef, score: 0, ranks: channels.map(() => undefined) };
        fused.set(candidate.id, entry);
      }
      if (entry.ranks[channelIndex] !== undefined) return;
      entry.ranks[channelIndex] = position + 1;
      entry.score += 1 / (RRF_K + position + 1);
    });
  });
  return [...fused.values()].sort((a, b) => b.score - a.score || compareCodePoints(a.itemRef, b.itemRef));
}

/** User feedback recorded for one asset: how many positives and how many negatives. */
export interface FeedbackCounts {
  pos: number;
  neg: number;
}

/**
 * Weight of one log-count of feedback on the fused score. A factor of
 * 1 + w·(ln(1+pos) − ln(1+neg)) moves a score by about 2% / 3% / 5% / 9% for
 * 1 / 2 / 5 / 20 positives at 0.03. Measured on the retrieval suite's fused
 * lists, 5 positives lift a hit from rank 10 by a median of 3 places (from rank 5,
 * by 2) and 20 by 4 to 5. What a vote can pass depends on the channels. In
 * keyword-only search every fused score is exactly 1 / (RRF_K + rank), so
 * neighbours sit 1.5 to 1.6% apart and one vote (about 2%) moves a hit one place
 * whatever the keyword margin between them. When both channels contribute, their
 * ranks spread the scores and a vote passes only near-ties. At 0.05 the same
 * votes lift it 4 to 5 and 6 to 7 places, and two wrong votes cost about 1.6
 * times the nDCG@10 they cost at 0.03.
 */
export const FEEDBACK_WEIGHT = 0.03;

/**
 * The multiplier on a hit's fused score for its feedback: the same for every
 * asset, rising with the number of positives and falling with the number of
 * negatives, each by a logarithm so a heavily voted asset gains less per vote.
 */
export function feedbackFactor({ pos, neg }: FeedbackCounts): number {
  return 1 + FEEDBACK_WEIGHT * (Math.log1p(pos) - Math.log1p(neg));
}

/** Scale fused scores by the feedback of each asset (keyed by `itemRef`) and reorder, with the same tie-break as fusion. */
export function applyFeedback(
  fused: readonly FusedCandidate[],
  feedback: ReadonlyMap<string, FeedbackCounts>,
): FusedCandidate[] {
  return fused
    .map((candidate) => {
      const counts = feedback.get(candidate.itemRef);
      return counts ? { ...candidate, score: candidate.score * feedbackFactor(counts) } : candidate;
    })
    .sort((a, b) => b.score - a.score || compareCodePoints(a.itemRef, b.itemRef));
}
