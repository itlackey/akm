// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The retirement continuity check (0.9.17-alpha.9 plan §5.4, §5.5; rule R3):
 * before the pair pass mints a `retire` proposal, replay the retired asset's
 * own past user queries through akm's own search — in-process, the same
 * ranking a user gets, no LLM — and confirm the successor ranks in the top
 * 10 for every query where the retired asset did. This is the forgetting-
 * safety lane's purpose (§4.6, §5.5), moved from a per-run salience-rank
 * comparison to a per-proposal search-rank replay, reusing
 * {@link buildRankChangeReport} as the comparator.
 *
 * No queries recorded for the retired asset: no check, no risk (nothing to
 * replay, so nothing to compare).
 */

import type { AkmConfig } from "../../../core/config/config";
import { type SearchLocalInput, searchLocal } from "../../../indexer/search/db-search";
import { listRetrievalQueries } from "../../../indexer/usage/usage-events";
import type { RetirementContinuityRisk } from "../../proposal/proposal-types";
import { type LedgerAccess, readLedgerDb, stripBundle } from "../ledger";
import { buildRankChangeReport } from "../salience";

/** At most this many of the retired asset's most recent queries are replayed (plan §5.4, §7). */
export const CONTINUITY_MAX_QUERIES = 5;
/** "Top 10" per the plan's rule — both the pass/fail cutoff and the search `limit`. */
export const CONTINUITY_TOP_N = 10;

/** One search hit's ref, the only field the check reads. */
export interface ContinuityHit {
  ref: string;
}

/** Test seam: replaces the real `searchLocal` call. Production callers omit it. */
export type ContinuitySearch = (query: string) => Promise<readonly ContinuityHit[]>;

function defaultSearch(stashDir: string, config: AkmConfig): ContinuitySearch {
  const base: Omit<SearchLocalInput, "query"> = {
    searchType: "any",
    limit: CONTINUITY_TOP_N,
    stashDir,
    sources: [{ path: stashDir, isDefault: true }],
    config,
  };
  return async (query) => (await searchLocal({ ...base, query })).hits;
}

/** 1-indexed position of `conceptId` in `hits`, or `undefined` if it is not among them. */
function rankOf(hits: readonly ContinuityHit[], conceptId: string): number | undefined {
  const index = hits.findIndex((hit) => stripBundle(hit.ref) === conceptId);
  return index === -1 ? undefined : index + 1;
}

/**
 * Replay `retiredRef`'s own past queries and check that `successorRef` ranks
 * in the top {@link CONTINUITY_TOP_N} for every one where the retired asset
 * did. Returns `undefined` when there is nothing to flag: no recorded
 * queries, the retired asset never ranked top 10 for any of them, or the
 * survivor always did too. Never throws — a search failure just drops that
 * one query from the sample, the same as a query the retired asset did not
 * rank for.
 */
export async function checkRetirementContinuity(args: {
  stashDir: string;
  config: AkmConfig;
  /** ConceptId, no bundle prefix (matches {@link RetirementMetadata}'s spelling). */
  retiredRef: string;
  successorRef: string;
  ledgerAccess: LedgerAccess;
  /** Test seam — production callers omit it and get the real search. */
  search?: ContinuitySearch;
}): Promise<RetirementContinuityRisk | undefined> {
  const queries = (readLedgerDb(args.ledgerAccess, (db) => listRetrievalQueries(db, args.retiredRef)) ?? []).slice(
    0,
    CONTINUITY_MAX_QUERIES,
  );
  if (queries.length === 0) return undefined; // no queries recorded: no check, no flag

  const search = args.search ?? defaultSearch(args.stashDir, args.config);
  const oldRanks = new Map<string, number>();
  const newRanks = new Map<string, number>();
  const rankByQuery = new Map<string, { retiredRank: number; successorRank: number | null }>();
  for (const query of queries) {
    let hits: readonly ContinuityHit[];
    try {
      hits = await search(query);
    } catch {
      continue; // a search failure never blocks minting — just drop this query from the sample
    }
    const retiredRank = rankOf(hits, args.retiredRef);
    if (retiredRank === undefined) continue; // the retired asset itself did not rank top 10 here — nothing to protect
    const successorRank = rankOf(hits, args.successorRef);
    oldRanks.set(query, retiredRank);
    // Absent from the top N: rank it one past the threshold so the comparator's
    // ">" test below fails it, without inventing a specific missing rank.
    newRanks.set(query, successorRank ?? CONTINUITY_TOP_N + 1);
    rankByQuery.set(query, { retiredRank, successorRank: successorRank ?? null });
  }
  if (oldRanks.size === 0) return undefined; // the retired asset never ranked top 10 for its own queries

  const report = buildRankChangeReport(oldRanks, newRanks, CONTINUITY_TOP_N, CONTINUITY_TOP_N);
  if (report.forgettingCandidates.length === 0) return undefined; // the survivor stayed top 10 everywhere the retired asset did

  const ranks = report.forgettingCandidates.map((c) => {
    const found = rankByQuery.get(c.ref);
    return { query: c.ref, retiredRank: found?.retiredRank ?? c.oldRank, successorRank: found?.successorRank ?? null };
  });
  return { failingQueries: ranks.length, ranks };
}
