// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Reciprocal rank fusion (Cormack, Clarke and Büttcher, SIGIR 2009) of the
 * lexical and vector candidate lists — the whole of search ranking.
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
