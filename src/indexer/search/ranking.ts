// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Reciprocal rank fusion (Cormack, Clarke and Büttcher, SIGIR 2009) of the
 * lexical and vector candidate lists, then one feedback factor on the fused score
 * and a recency tie-break among dated candidates — the whole of search ranking.
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
 * neighbours in the first 20 sit 1.3 to 1.6% apart and one vote (about 2%) moves
 * a hit one place (through rank 38) whatever the keyword margin between them. When both channels contribute, their
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

/** Multiplier on the fused score of a hit that matches `--prefer`; ×1.02 passed the akm-eval#196 gate, ×1.05 failed its nDCG limit. */
export const PREFER_WEIGHT = 1.02;

/** Scale the fused score of each preferred asset (a set of `itemRef`s) by {@link PREFER_WEIGHT} and reorder, with the same tie-break as fusion. */
export function applyPrefer(fused: readonly FusedCandidate[], preferred: ReadonlySet<string>): FusedCandidate[] {
  return fused
    .map((candidate) =>
      preferred.has(candidate.itemRef) ? { ...candidate, score: candidate.score * PREFER_WEIGHT } : candidate,
    )
    .sort((a, b) => b.score - a.score || compareCodePoints(a.itemRef, b.itemRef));
}

/**
 * Weight of recency among dated candidates. A dated candidate's score is scaled
 * by 1 + w·r, where r is 1 for the newest dated candidate and halves for every
 * {@link RECENCY_HALF_LIFE_DAYS} older: the newest outscores a much older one by
 * up to 4% at 0.04. In keyword-only search every fused score is 1 / (RRF_K + rank),
 * so neighbours in the first 20 ranks sit 1.3 to 1.6% apart whatever their keyword
 * margin: there the newest passes an older dated neighbour from about 0.6 to 0.8
 * years apart, two from about 1.5 to 2.5 years, and never three in the first 10
 * ranks. When both channels contribute, their ranks spread the scores and recency
 * passes only near-ties. At 0.02 it passes none of the dated retrieval set's
 * pairs (akm-eval `evals/retrieval/assets/dated`, 1 to 1.7 years apart).
 */
export const RECENCY_WEIGHT = 0.04;

/** Age, measured from the newest dated candidate, at which recency halves. */
export const RECENCY_HALF_LIFE_DAYS = 365;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Break near-ties between dated candidates in favour of the newer. Only dated
 * candidates are compared with each other: they are reordered among the places
 * dated candidates already hold, and undated candidates, with the score at
 * every place, stay where they are, so a stash with few dates ranks as before.
 * `days` maps an entry id to its `YYYY-MM-DD` date; age is measured from the
 * newest date among the candidates, never from the clock, so the order depends
 * only on the index and the query. Fewer than two distinct dates change nothing.
 */
export function applyRecency(fused: readonly FusedCandidate[], days: ReadonlyMap<number, string>): FusedCandidate[] {
  const distinct = [...new Set(days.values())].sort(compareCodePoints);
  // One date, or none, says nothing about which candidate is newer.
  if (distinct.length < 2) return [...fused];
  const newestMs = Date.parse(distinct[distinct.length - 1] as string);
  const places = fused.flatMap((candidate, place) => (days.has(candidate.id) ? [place] : []));
  const reordered = places
    .map((place) => {
      const candidate = fused[place] as FusedCandidate;
      const ageDays = (newestMs - Date.parse(days.get(candidate.id) as string)) / DAY_MS;
      return {
        candidate,
        adjusted: candidate.score * (1 + RECENCY_WEIGHT * 0.5 ** (ageDays / RECENCY_HALF_LIFE_DAYS)),
      };
    })
    .sort((a, b) => b.adjusted - a.adjusted || compareCodePoints(a.candidate.itemRef, b.candidate.itemRef));
  const out = [...fused];
  places.forEach((place, i) => {
    out[place] = {
      ...(reordered[i] as { candidate: FusedCandidate }).candidate,
      score: (fused[place] as FusedCandidate).score,
    };
  });
  return out;
}
