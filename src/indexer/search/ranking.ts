// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Search ranking: reciprocal rank fusion (Cormack, Clarke and Büttcher, SIGIR
 * 2009) of the lexical and vector candidate lists, then one bounded factor from
 * the feedback score that `akm feedback` moves.
 *
 * Fusing ranks rather than scores needs no calibration between BM25 and cosine
 * similarity, so it holds for every embedding model. On the retrieval suite,
 * BM25 fused with document vectors this way scored nDCG@10 0.568 against 0.349
 * for the additive boost stack it replaced
 * (`akm/eval/retrieval/reports/baseline-2026-09-27.md`). The utility factor is
 * bounded to a quarter of a candidate's score either way, so it cannot
 * reproduce that stack.
 */

import { compareCodePoints } from "../../core/common";
import type { UtilityScoreRow } from "../../storage/repositories/index-entry-types";
import { NEUTRAL_UTILITY } from "../feedback/utility-policy";

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
  return [...fused.values()].sort(byScoreThenRef);
}

/**
 * How far utility moves a fused score: the factor is
 * `1 + UTILITY_RANK_WEIGHT * (utility - 0.5)`, so utility 0 scales a score by
 * 0.75, utility 1 by 1.25, and the 0.5 midpoint by exactly 1.
 */
export const UTILITY_RANK_WEIGHT = 0.5;

/**
 * Scale each fused score by its entry's utility and re-sort with the same
 * tie-break as {@link reciprocalRankFusion}. An entry absent from
 * `utilityByEntryId`, or with a non-finite utility, is neutral: its candidate
 * comes back unchanged. Returns a new array and does not modify `fused`.
 *
 * The factor is bounded (0.75 to 1.25) on purpose. RRF scores of adjacent
 * ranks differ by about 1.6 percent, so the bound lets a well-rated asset climb
 * several places while a candidate that both channels agree on, whose score is
 * roughly double a one-channel match, still wins. Feedback adjusts the order of
 * near-equal matches; it does not override a clear lexical or semantic win.
 */
export function applyUtilityToFused(
  fused: readonly FusedCandidate[],
  utilityByEntryId: ReadonlyMap<number, number>,
): FusedCandidate[] {
  return fused
    .map((candidate) => {
      const utility = utilityByEntryId.get(candidate.id);
      if (utility === undefined || !Number.isFinite(utility)) return candidate;
      const bounded = Math.min(1, Math.max(0, utility));
      return { ...candidate, score: candidate.score * (1 + UTILITY_RANK_WEIGHT * (bounded - NEUTRAL_UTILITY)) };
    })
    .sort(byScoreThenRef);
}

/**
 * The scores search may rank by: the feedback score of every row with feedback.
 *
 * `utility_scores.utility` is not usable here. `akm index` recomputes it from
 * searches and shows, starting at 0, so a row for an asset that was searched
 * but never shown holds 0, and used as a factor it would demote every asset
 * that merely appeared in results. `feedback_score` is separate: it starts at
 * the 0.5 midpoint, moves on feedback alone, and `akm index` rebuilds it by
 * replaying the feedback events. A row with no feedback (`feedback_count` 0, or
 * a score the index has not written yet) is neutral and left out, so assets
 * nobody gave feedback keep their fused scores whatever their search and show
 * history.
 */
export function feedbackUtilities(rows: ReadonlyMap<number, UtilityScoreRow>): Map<number, number> {
  const scores = new Map<number, number>();
  for (const [entryId, row] of rows) {
    if (row.feedbackCount > 0 && row.feedbackScore !== undefined) scores.set(entryId, row.feedbackScore);
  }
  return scores;
}

function byScoreThenRef(a: FusedCandidate, b: FusedCandidate): number {
  return b.score - a.score || compareCodePoints(a.itemRef, b.itemRef);
}
