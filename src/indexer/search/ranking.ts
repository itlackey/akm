// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { Database } from "../../storage/database";
import { getEntryById } from "../../storage/repositories/index-entries-repository";
import { getUtilityScoresByIds } from "../../storage/repositories/index-utility-repository";
import type { UnitSearchHit } from "../../storage/repositories/units-repository";
import { groupUnitHitsByEntry } from "../../storage/repositories/units-repository";
import type { GraphBoostContext } from "../graph/graph-boost";
import type { IndexDocument } from "../passes/metadata";
import type { ProjectContext } from "../walk/project-context";
import { buildLexicalQueryPlan, type LexicalQueryExecution } from "./fts-query";
import { lexicalNameTokens, structuralNameTokenMatch } from "./name-match";
import {
  applyBeliefStateScoreCeiling,
  applyScoreContributors,
  applyUtilityContributors,
  defaultRankingContributors,
  defaultUtilityRankingContributors,
} from "./ranking-contributors";
import type { MatchedUnit, RankedEntryInput } from "./ranking-types";

export interface RankEntriesOptions {
  db: Database;
  query: string;
  items: RankedEntryInput[];
  graphContext: GraphBoostContext | null;
  /**
   * Project-context tokens derived from the current working directory.
   * When supplied, assets that match these tokens receive an additive
   * ranking boost. Pass `null` to explicitly disable (e.g. `--no-project-context`).
   */
  projectContext?: ProjectContext | null;
  /**
   * Phase 2A / Rec 5: optional configurable forgetting curve. When absent,
   * the utility recency decay falls back to its pre-2A default
   * (`exp(-days/30)`). Threaded through to {@link UtilityRankingContext}.
   */
  utilityDecayConfig?: {
    halfLifeDays: number;
    feedbackStabilityBoost: number;
  };
  /**
   * Phase 2A / Rec 5: optional per-entry positive feedback counts. When
   * supplied, the utility-ranking contributor uses these to stretch the
   * effective half-life of repeatedly-helpful entries. When absent or empty
   * the contributor behaves exactly as it did pre-2A.
   */
  positiveFeedbackCounts?: Map<number, number>;
  /**
   * Scoped utility: SHA-256 project-anchor key from
   * `getCurrentWorkflowScopeKey()`. When provided the ranking pipeline loads
   * per-project utility scores in addition to the global ones and prefers the
   * scoped signal when it exists (blend 0.7 scoped + 0.3 global).
   */
  scopeKey?: string;
  /**
   * R2 / #692 — improve-loop salience scores (`asset_salience.rank_score`)
   * keyed by entry id. `salience-ranking` is NOT in
   * `defaultUtilityRankingContributors` (#692 removed it from default
   * user-facing ranking — see that contributor's doc comment), so this field
   * is consumed only by a caller that explicitly builds its own
   * utility-contributor list including it: `undefined`/`null` (default) mean
   * no data / off; a `Map` is the injected input (tests / a future gated
   * experiment). There is no state.db fallback load anymore — the prior
   * best-effort `loadSalienceRankScores` was deleted outright, along with the
   * hot-path defect it caused (a synchronous wait on the maintenance-activity
   * barrier, up to 5s, before the SQLite `busy_timeout` even applied).
   */
  salienceRankScores?: Map<number, number> | null;
}

// ── Units search fusion (index-redesign-contract.md B3) ────────────────────

/** One unit-level lexical hit from `searchUnitsLexical` (`db-search.ts`), 1-based rank. */
export interface UnitLexicalHit {
  unitHash: string;
  rank: number;
  /** Which tier of the exact → prefix → relaxed fallback produced this hit — every hit in one call shares it. */
  lexicalMatch: LexicalQueryExecution;
}

/**
 * Reciprocal Rank Fusion constant (Cormack, Clarke & Buettcher, SIGIR 2009,
 * "Reciprocal Rank Fusion outperforms Condorcet and individual Rank Learning
 * Methods"). It damps how much a #1 rank in one list dominates the fused
 * score relative to lower ranks, so a document ranked highly by only one of
 * the lists still competes with one ranked moderately by several. Nothing
 * else about the fusion is tuned — nor is this constant, per the paper's own
 * finding that results were insensitive to its exact value. `fuseByEntry`
 * fuses three lists (card lexical, fragment lexical, semantic — B5f item 2);
 * this same constant governs all three, unchanged by that count (see
 * `RRF_MAX_SCORE` below for why the list count doesn't enter the formula).
 */
export const RRF_K = 60;

/**
 * The maximum score a SINGLE list's best-ranked hit can contribute:
 * `1/(RRF_K + 1)`, independent of how many lists `fuseByEntry` fuses (three,
 * as of B5f item 2: card lexical, fragment lexical, semantic — was two
 * before). `ranking-contributors.ts`'s pipeline (graph/project/utility
 * boosts, the belief-state ceiling) is calibrated for a 0–1 fused score;
 * RRF's native range is ~0.008–0.033 at `RRF_K = 60`, which would flatten
 * every contributor's effect and make the belief-state ceiling a no-op.
 * Dividing every fused score by this constant before contributors ever see
 * it rescales a single list's rank-1 hit to 1.0 and a hit that ranks #1 in
 * every list it appears in to (list count).0 — the SAME "not a hard clamp"
 * territory contributor boosts already push a fused score into today
 * (`displaySearchScore`'s final monotone projection is what brings the
 * public score back into [0,1), per CLAUDE.md's locked contract). A
 * lexical-only exact-name match is not artificially reduced by requiring
 * agreement from lists it never had the chance to earn — semantic search can
 * be off entirely, or a match can be fragment-only (`ranking-regression.test.ts`'s
 * "Score preservation (not RRF-flattened)" describe block, lexical-only
 * throughout, still expects a clearly-exact top hit's public score above
 * 0.9). Normalising by the N-list sum instead (dividing by `N/(RRF_K+1)`)
 * was tried at N=2 and reverted: it reduces every single-list score before
 * contributors ever see it, and no contributor boost bridges that gap back
 * to what an unambiguous single-list match deserves — the same reasoning
 * holds, more strongly, at N=3, so the divisor stays anchored to ONE list's
 * max regardless of how many lists are in play (pinned by
 * `search-units-fusion.test.ts`'s three-list fusion cases).
 */
const RRF_MAX_SCORE = 1 / (RRF_K + 1);

interface EntryUnitWinner {
  /** 1-based position of this entry once its own list is sorted best-first. */
  rank: number;
  unitHash: string;
  fragmentId: string | null;
  lexicalMatch: LexicalQueryExecution;
}

/**
 * `unit_texts.kind` is redundant with `fragmentId` nullity by construction
 * (A1's `deriveUnits`: ordinal 0 is always the one structured-fields "card"
 * unit; every fragment-derived unit carries a non-null `fragmentId`), so
 * `matchedUnit.kind` is derived here instead of a second table read.
 */
function unitKindFromFragmentId(fragmentId: string | null): MatchedUnit["kind"] {
  return fragmentId === null ? "card" : "fragment";
}

/** Group lexical unit hits to entries via `entry_units`, keeping the best-ranked unit per entry. */
function groupLexicalHitsByEntry(db: Database, hits: readonly UnitLexicalHit[]): Map<number, EntryUnitWinner> {
  const best = new Map<number, EntryUnitWinner>();
  if (hits.length === 0) return best;

  const hashes = [...new Set(hits.map((hit) => hit.unitHash))];
  const placeholders = hashes.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT entry_id AS entryId, fragment_id AS fragmentId, unit_hash AS unitHash FROM entry_units WHERE unit_hash IN (${placeholders})`,
    )
    .all(...hashes) as Array<{ entryId: number; fragmentId: string | null; unitHash: string }>;

  const ownersByHash = new Map<string, Array<{ entryId: number; fragmentId: string | null }>>();
  for (const row of rows) {
    const owners = ownersByHash.get(row.unitHash) ?? [];
    owners.push({ entryId: row.entryId, fragmentId: row.fragmentId });
    ownersByHash.set(row.unitHash, owners);
  }

  for (const hit of hits) {
    for (const owner of ownersByHash.get(hit.unitHash) ?? []) {
      const existing = best.get(owner.entryId);
      if (!existing || hit.rank < existing.rank) {
        best.set(owner.entryId, {
          rank: hit.rank,
          unitHash: hit.unitHash,
          fragmentId: owner.fragmentId,
          lexicalMatch: hit.lexicalMatch,
        });
      }
    }
  }
  return best;
}

/**
 * Re-rank a per-entry "best unit" map (already the winner within its own
 * list) best-first, 1-based — competition ranking, so two entries `compare`
 * calls exactly equal (0) share a rank instead of one arbitrarily winning by
 * sort-stability/iteration order. Without this, a genuine tie collapses the
 * moment it is re-ranked here, and RRF fusion (which sums by this rank) never
 * sees the tie it needs to hand off to the final ranking comparator's
 * content-based tie-break (`canonicalContentTieKey`, db-search.ts).
 */
function rankEntryWinners<V>(
  winners: Map<number, V>,
  compare: (a: V, b: V) => number,
): Map<number, { rank: number; value: V }> {
  const ranked = new Map<number, { rank: number; value: V }>();
  const ordered = [...winners.entries()].sort((a, b) => compare(a[1], b[1]));
  let rank = 0;
  let previous: V | undefined;
  ordered.forEach(([entryId, value], index) => {
    if (previous === undefined || compare(previous, value) !== 0) rank = index + 1;
    previous = value;
    ranked.set(entryId, { rank, value });
  });
  return ranked;
}

type LexicalEntryRank = { rank: number; value: EntryUnitWinner };
type SemanticEntryRank = { rank: number; value: { distance: number; fragmentId: string | null; hash: string } };

/**
 * Pick which list's unit is reported as `matchedUnit`/`fragmentId`: whichever
 * ranked the entry best (lowest rank number) across however many of the
 * (up to three) lists it appears in; a rank tie prefers card lexical evidence
 * over fragment lexical evidence over a vector neighbor — the closer the
 * evidence is to exact-term name/description matter, the more directly it
 * reads into `whyMatched`. At least one of the three is defined for every
 * `entryId` this is called with — it comes from the union of all three
 * ranked maps' keys.
 */
function pickFusionWinner(
  cardHit: LexicalEntryRank | undefined,
  fragmentHit: LexicalEntryRank | undefined,
  semanticHit: SemanticEntryRank | undefined,
): { unitHash: string; fragmentId: string | null } {
  const candidates: Array<{ priority: number; rank: number; unitHash: string; fragmentId: string | null }> = [];
  if (cardHit) {
    candidates.push({
      priority: 0,
      rank: cardHit.rank,
      unitHash: cardHit.value.unitHash,
      fragmentId: cardHit.value.fragmentId,
    });
  }
  if (fragmentHit) {
    candidates.push({
      priority: 1,
      rank: fragmentHit.rank,
      unitHash: fragmentHit.value.unitHash,
      fragmentId: fragmentHit.value.fragmentId,
    });
  }
  if (semanticHit) {
    candidates.push({
      priority: 2,
      rank: semanticHit.rank,
      unitHash: semanticHit.value.hash,
      fragmentId: semanticHit.value.fragmentId,
    });
  }
  candidates.sort((a, b) => a.rank - b.rank || a.priority - b.priority);
  const winner = candidates[0]!;
  return { unitHash: winner.unitHash, fragmentId: winner.fragmentId };
}

/**
 * Fuse the card-lexical, fragment-lexical (both `units_fts`) and semantic
 * (`units_vec`) unit-level result lists into one ranked entry list
 * (index-redesign-contract.md B3, restructured for field emphasis by B5f
 * item 2). Splitting lexical into two kind-scoped lists — rather than one
 * pool mixing card and fragment units — is what replaces the old per-column
 * BM25 weights (name 10x, description 5x, tags 3x, hints 2x, content 1x): a
 * card (name/description/tags/hints) match now ranks within its own small
 * pool instead of racing every fragment's body text on raw BM25, so a
 * name/description match contributes a top rank in its own list structurally,
 * with no weight tuned.
 *
 * Each list is first grouped to entries via `entry_units`, keeping that
 * list's own best (lowest lexical rank / lowest vector distance) unit per
 * entry — `groupUnitHitsByEntry` from the stage-1 unit store does this for
 * the semantic side; `groupLexicalHitsByEntry` mirrors it for each lexical
 * side. That grouping produces three entry-level rankings (best entry
 * first), which are then combined by reciprocal rank:
 * `score = Σ 1/(RRF_K + rank)` over whichever of the three lists an entry
 * appears in — an entry whose card AND a fragment both match gets credit
 * from both, on top of any semantic credit; nothing here is a weight, only
 * which pool a unit's rank was earned in. `matchedUnit` reports the unit
 * belonging to whichever list ranked the entry best (see `pickFusionWinner`).
 */
export function fuseByEntry(
  db: Database,
  cardLexical: readonly UnitLexicalHit[],
  fragmentLexical: readonly UnitLexicalHit[],
  semantic: readonly UnitSearchHit[],
  opts: { typeFilter?: string[]; excludeTypes?: string[] } = {},
): RankedEntryInput[] {
  const cardByEntry = groupLexicalHitsByEntry(db, cardLexical);
  const fragmentByEntry = groupLexicalHitsByEntry(db, fragmentLexical);
  const semanticByEntry = groupUnitHitsByEntry(db, semantic);

  const cardRanked = rankEntryWinners(cardByEntry, (a, b) => a.rank - b.rank);
  const fragmentRanked = rankEntryWinners(fragmentByEntry, (a, b) => a.rank - b.rank);
  const semanticRanked = rankEntryWinners(semanticByEntry, (a, b) => a.distance - b.distance);

  const includeTypes = opts.typeFilter && opts.typeFilter.length > 0 ? new Set(opts.typeFilter) : null;
  const excludeTypes = opts.excludeTypes && opts.excludeTypes.length > 0 ? new Set(opts.excludeTypes) : null;

  const entryIds = new Set<number>([...cardRanked.keys(), ...fragmentRanked.keys(), ...semanticRanked.keys()]);
  const results: RankedEntryInput[] = [];

  for (const entryId of entryIds) {
    const cardHit = cardRanked.get(entryId);
    const fragmentHit = fragmentRanked.get(entryId);
    const semanticHit = semanticRanked.get(entryId);
    let score = 0;
    if (cardHit) score += 1 / (RRF_K + cardHit.rank);
    if (fragmentHit) score += 1 / (RRF_K + fragmentHit.rank);
    if (semanticHit) score += 1 / (RRF_K + semanticHit.rank);
    score /= RRF_MAX_SCORE;

    const { unitHash, fragmentId } = pickFusionWinner(cardHit, fragmentHit, semanticHit);
    const lexicalHit = cardHit ?? fragmentHit;

    const found = getEntryById(db, entryId);
    if (!found) continue;
    if (includeTypes && !includeTypes.has(found.entry.type)) continue;
    if (excludeTypes?.has(found.entry.type)) continue;

    results.push({
      id: entryId,
      entry: found.entry,
      filePath: found.filePath,
      score,
      rankingMode: lexicalHit && semanticHit ? "hybrid" : lexicalHit ? "fts" : "semantic",
      itemRef: found.itemRef,
      bundleId: found.bundleId,
      conceptId: found.conceptId,
      ...(lexicalHit ? { lexicalMatch: lexicalHit.value.lexicalMatch } : {}),
      ...(fragmentId ? { fragmentId } : {}),
      matchedUnit: { unitHash, fragmentId, kind: unitKindFromFragmentId(fragmentId) },
    });
  }

  return results;
}

export function applyRankingRules(options: RankEntriesOptions): RankedEntryInput[] {
  const queryTokens = buildLexicalQueryPlan(options.query).tokens.map((token) => token.toLowerCase());
  const queryLower = options.query.toLowerCase().trim();
  const rankingContext = {
    db: options.db,
    query: options.query,
    queryLower,
    queryTokens,
    graphContext: options.graphContext,
    projectContext: options.projectContext,
  };

  for (const item of options.items) {
    applyScoreContributors(item, rankingContext, defaultRankingContributors);
  }

  const { global: utilScoresMap, scoped: scopedUtilScoresMap } = getUtilityScoresByIds(
    options.db,
    options.items.map((item) => item.id),
    options.scopeKey,
  );
  // R2 / #692 — salience-ranking is not in defaultUtilityRankingContributors
  // (see ranking-contributors.ts), so this is never consumed by the default
  // ranking path below; it exists only for a caller that explicitly builds a
  // contributor list including salienceRankingContributor. undefined/null
  // both normalize to "no data" — there is no state.db fallback load.
  const salienceRankScores = options.salienceRankScores ?? new Map<number, number>();
  const utilityContext = {
    ...rankingContext,
    utilityScores: utilScoresMap,
    scopedUtilityScores: scopedUtilScoresMap,
    utilityDecayConfig: options.utilityDecayConfig,
    positiveFeedbackCounts: options.positiveFeedbackCounts,
    salienceRankScores,
  };
  for (const item of options.items) {
    applyUtilityContributors(item, utilityContext, defaultUtilityRankingContributors);
    applyRelaxedLexicalScoreCeiling(item, queryTokens);
    // SPEC-5: demoting belief states (superseded/contradicted/archived/
    // deprecated) cap the FINAL score. The additive belief penalty inside the
    // multiplicative boost sum can still overwhelm an additive belief penalty,
    // so without the ceiling a superseded incumbent can outrank its correction.
    applyBeliefStateScoreCeiling(item);
  }

  return options.items;
}

const RELAXED_NON_NAME_SCORE_CEILING = 0.65;

/**
 * Rank name evidence without relying on punctuation or ASCII-only splitting.
 * The tiers are intentionally structural: an exact normalized name, all query
 * tokens in a longer name, any query token in the name, or no name evidence.
 */
export function lexicalNameMatchTier(entry: IndexDocument, queryTokens: string[]): number {
  if (queryTokens.length === 0) return 0;
  const nameBase = entry.name.toLowerCase().split("/").pop() ?? entry.name.toLowerCase();
  const nameTokens = lexicalNameTokens(nameBase);
  if (
    nameTokens.length === queryTokens.length &&
    nameTokens.every((token, index) => structuralNameTokenMatch(token, queryTokens[index]!))
  ) {
    return 3;
  }
  const matched = queryTokens.filter((token) =>
    nameTokens.some((nameToken) => structuralNameTokenMatch(nameToken, token)),
  ).length;
  if (matched === queryTokens.length) return 2;
  return matched > 0 ? 1 : 0;
}

/**
 * A relaxed OR query admits intentionally weak candidates. Candidates with no
 * query token in their name remain visible for body-only recall, but cannot
 * share the same bounded displayed score as stronger name-bearing recoveries.
 * The raw ceiling is 0.65; the public score projection is applied later, so
 * callers never literally receive `0.65` just because this ceiling bound.
 *
 * Preserve the pre-ceiling relevance separately from `preCeilingScore`, which
 * belongs to belief-state demotion and may be written afterwards. A relaxed,
 * belief-demoted candidate otherwise loses both its body relevance and its
 * ordering signal when the second ceiling overwrites the first.
 */
function applyRelaxedLexicalScoreCeiling(item: RankedEntryInput, queryTokens: string[]): void {
  if (item.lexicalMatch !== "relaxed" || lexicalNameMatchTier(item.entry, queryTokens) > 0) return;
  if (item.score > RELAXED_NON_NAME_SCORE_CEILING) {
    item.preRelaxedCeilingScore = item.score;
    item.score = RELAXED_NON_NAME_SCORE_CEILING;
  }
}
