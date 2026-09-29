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
 * comparison to a per-proposal search-rank replay.
 *
 * No queries recorded for the retired asset: no check, no risk (nothing to
 * replay, so nothing to compare).
 */

import type { AkmConfig } from "../../../core/config/config";
import { type SearchLocalInput, searchLocal } from "../../../indexer/search/db-search";
import type { SearchExecutionMode } from "../../../sources/types";
import type { ContinuityRiskRank, RetirementContinuityRisk } from "../../proposal/proposal-types";
import { stripFrontmatterBody } from "../content-hash";
import { type LedgerAccess, stripBundle } from "../ledger";
import { loadRetrievalQueries } from "../retrieval-gate";

/** At most this many of the retired asset's most recent queries are replayed (plan §5.4, §7). */
export const CONTINUITY_MAX_QUERIES = 5;
/** "Top 10" per the plan's rule — both the pass/fail cutoff and the search `limit`. */
export const CONTINUITY_TOP_N = 10;

/** One search hit's ref, the only field the check reads. */
export interface ContinuityHit {
  ref: string;
}

/** One search call's result: the hits, and which ranking actually produced them (S2). */
export interface ContinuitySearchResult {
  hits: readonly ContinuityHit[];
  mode: SearchExecutionMode;
  /**
   * True when THIS call ran after the same `ContinuitySearch` instance had
   * already switched to forced keyword-only because an earlier query in the
   * same run hit `mode: "fts-fallback"`. Such a call reports `mode:
   * "keyword"` on its own — `semanticSearchMode` was deliberately forced
   * off, so nothing failed THIS time — but the ranking is still degraded
   * for the same reason (a presumed-down endpoint), not because the bundle
   * is genuinely configured for keyword-only search. Omitted (falsy) for a
   * call made with the endpoint still believed reachable.
   */
  forcedKeywordOnly?: boolean;
}

/** Test seam: replaces the real `searchLocal` call. Production callers get {@link createContinuitySearch}. */
export type ContinuitySearch = (query: string) => Promise<ContinuitySearchResult>;

/**
 * Builds the real search call the continuity check uses, stateful across
 * every query asked of ONE instance (S2): the first time a query falls back
 * to keyword-only ranking (`mode: "fts-fallback"` — most often a down or
 * unreachable embedding endpoint), every later call through THIS instance
 * forces `semanticSearchMode: "off"` instead of attempting semantic search
 * again, so a dead endpoint costs one failed attempt per run, not one per
 * remaining query (a hanging endpoint at ~3s/query, 300 proposals x 5
 * queries, would otherwise cost on the order of an hour). Construct exactly
 * one instance per pair-pass run and reuse it for every proposal judged, so
 * the throttle covers the whole run, not just one proposal's own queries —
 * and every call made once it has switched, across every remaining proposal
 * in the run, reports `forcedKeywordOnly: true`, not just the one call that
 * discovered the fallback (round-3 review: the first fix only marked THAT
 * call unverified, so a second proposal checked while the endpoint was
 * still down came back with a clean, `mode: "keyword"` — and therefore
 * bulk-acceptable — result).
 */
export function createContinuitySearch(stashDir: string, config: AkmConfig): ContinuitySearch {
  const base: Omit<SearchLocalInput, "query" | "config"> = {
    searchType: "any",
    limit: CONTINUITY_TOP_N,
    stashDir,
    sources: [{ path: stashDir, isDefault: true }],
  };
  let keywordOnly = false;
  return async (query) => {
    const forcedKeywordOnly = keywordOnly;
    const callConfig: AkmConfig = keywordOnly ? { ...config, semanticSearchMode: "off" } : config;
    const result = await searchLocal({ ...base, query, config: callConfig });
    if (result.mode === "fts-fallback") keywordOnly = true;
    return { hits: result.hits, mode: result.mode, forcedKeywordOnly };
  };
}

/** 1-indexed position of `conceptId` in `hits`, or `undefined` if it is not among them. */
function rankOf(hits: readonly ContinuityHit[], conceptId: string): number | undefined {
  const index = hits.findIndex((hit) => stripBundle(hit.ref) === conceptId);
  return index === -1 ? undefined : index + 1;
}

/** Body only, whitespace collapsed — the same shape `db-search.ts`'s own content-dedupe compares (S3b). */
function normalizedBody(raw: string): string {
  return stripFrontmatterBody(raw).replace(/\s+/g, " ").trim();
}

/**
 * Replay `retiredRef`'s own past queries and check that `successorRef` ranks
 * in the top {@link CONTINUITY_TOP_N} for every one where the retired asset
 * did. Returns `undefined` when there is nothing to flag: the two bodies are
 * content-identical, no recorded queries, or every query ran on the real
 * ranking and either the retired asset never ranked top 10 for it, or the
 * survivor always did too. Never throws.
 *
 * S3: two fixes against false flags measured on a real night-1 admission
 * (300 pairs, 6 flags, half spurious):
 *  - queries are the SAME cleaned set `loadRetrievalQueries` replays for the
 *    retrieval regression gate (`../retrieval-gate.ts`) — stash-README
 *    boilerplate, harness/tool envelopes, pastes over 2,000 characters, and
 *    duplicates are dropped before replay, not just capped at 5 raw entries;
 *  - when the retired and successor bodies normalize identical, the check
 *    never runs at all: search's own content-dedupe (`db-search.ts`) already
 *    hides the successor behind the retired asset for every such query, so a
 *    "successor missing from the top 10" finding here would not be a real
 *    risk, just that dedupe working as designed.
 *
 * S2: a query that never ran (the search call threw), ran on the
 * keyword-only fallback (`mode: "fts-fallback"` — the real ranking was
 * attempted and failed, most often a down or unreachable embedding
 * endpoint), or ran after the shared search instance had already switched
 * to forced keyword-only because an EARLIER query in the same run fell back
 * (`forcedKeywordOnly`) is "unverified" — it is dropped from the rank
 * comparison below (its hits cannot be trusted as "the ranking a user
 * actually gets"), but unlike a query the retired asset simply did not rank
 * for, it can never by itself lead to a silent `undefined` — at least one
 * unverified query always produces a `continuityRisk`, so a dead endpoint
 * reads as "risk unknown" for every proposal it touches that run, never as
 * "no risk found" for the ones checked after the first failure.
 */
export async function checkRetirementContinuity(args: {
  stashDir: string;
  config: AkmConfig;
  /** ConceptId, no bundle prefix (matches {@link RetirementMetadata}'s spelling). */
  retiredRef: string;
  successorRef: string;
  /** Full file text (frontmatter included — stripped internally) of each side, for the S3b identical-body skip. */
  retiredRaw: string;
  successorRaw: string;
  ledgerAccess: LedgerAccess;
  /** Test seam — production callers omit it and get the real search. */
  search?: ContinuitySearch;
}): Promise<RetirementContinuityRisk | undefined> {
  // S3b: identical bodies — search's own content-dedupe already hides the
  // successor for every query that would rank the retired asset, so there is
  // no real risk here to check for.
  if (normalizedBody(args.retiredRaw) === normalizedBody(args.successorRaw)) return undefined;

  // S3a: the SAME cleaned queries the retrieval regression gate replays —
  // boilerplate, envelopes, pastes and duplicates dropped before replay.
  const queries = loadRetrievalQueries(args.ledgerAccess, args.retiredRef).slice(0, CONTINUITY_MAX_QUERIES);
  if (queries.length === 0) return undefined; // no queries recorded: no check, no flag

  const search = args.search ?? createContinuitySearch(args.stashDir, args.config);
  // N2: no rank-change-report abstraction — a query only ever needs "did the
  // retired asset rank top 10, and if so, did the successor too?", and
  // `rankOf` (search itself returning at most CONTINUITY_TOP_N hits) already
  // answers both directly.
  const ranks: ContinuityRiskRank[] = [];
  let unverifiedQueries = 0;
  for (const query of queries) {
    let hits: readonly ContinuityHit[];
    try {
      const result = await search(query);
      if (result.mode === "fts-fallback" || result.forcedKeywordOnly) {
        unverifiedQueries++; // S2: never silently compare keyword-only ranks
        continue;
      }
      hits = result.hits;
    } catch {
      unverifiedQueries++; // S2: a query that never ran cannot be "no risk"
      continue;
    }
    const retiredRank = rankOf(hits, args.retiredRef);
    if (retiredRank === undefined) continue; // the retired asset itself did not rank top 10 here — nothing to protect
    const successorRank = rankOf(hits, args.successorRef);
    if (successorRank === undefined) ranks.push({ query, retiredRank, successorRank: null });
  }
  // Every query verified, and either the retired asset never ranked top 10
  // for any of them, or the survivor always did too: nothing to flag.
  if (unverifiedQueries === 0 && ranks.length === 0) return undefined;

  return {
    failingQueries: ranks.length,
    ranks,
    ...(unverifiedQueries > 0 ? { unverifiedQueries } : {}),
  };
}
