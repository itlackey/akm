// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { stableFtsScore } from "../../core/lexical-score";
import type { Database } from "../../storage/database";
import { getEntryById } from "../../storage/repositories/index-entries-repository";
import { getUtilityScoresByIds } from "../../storage/repositories/index-utility-repository";
import type { UnitEntryMatch, UnitSearchHit } from "../../storage/repositories/units-repository";
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

/**
 * One unit-level lexical hit from `searchUnitsLexical`/`searchUnitsLexicalPair`
 * (`db-search.ts`), 1-based rank within the list it came from.
 */
export interface UnitLexicalHit {
  unitHash: string;
  rank: number;
  /** Raw FTS5 bm25 (negative, lower/more-negative is a stronger match) — the fusion evidence; see `stableFtsScore`. */
  bm25: number;
  /** Which tier of the exact → prefix → relaxed fallback produced this hit. */
  lexicalMatch: LexicalQueryExecution;
}

/**
 * The pre-redesign lexical/semantic split (`combineSearchScores`, retired
 * with the units path but restored here — measured against `curate-golden`,
 * see docs/plans/index-redesign.md's Search section): with both present,
 * lexical evidence dominates and semantic refines it; nothing here is a new
 * tuned value.
 */
const LEXICAL_WEIGHT = 0.7;
const SEMANTIC_WEIGHT = 0.3;

interface EntryUnitWinner {
  bm25: number;
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

/**
 * Group lexical unit hits to entries via `entry_units`, keeping the
 * strongest (most negative bm25 — see `stableFtsScore`) unit per entry, not
 * merely the best-RANKED one: magnitude, not rank, is what `fuseByEntry`
 * scores on.
 */
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
      if (!existing || hit.bm25 < existing.bm25) {
        best.set(owner.entryId, {
          bm25: hit.bm25,
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
 * Which unit is reported as `matchedUnit`/`fragmentId`: a fixed priority
 * order by evidence strength — card (name/description/tags/hints, the
 * strongest, most structured signal), then fragment, then a vector
 * neighbor — never a magnitude comparison across the three. At least one of
 * the three is defined for every `entryId` this is called with.
 */
function pickFusionWinner(
  cardHit: EntryUnitWinner | undefined,
  fragmentHit: EntryUnitWinner | undefined,
  semanticHit: UnitEntryMatch | undefined,
): { unitHash: string; fragmentId: string | null } {
  if (cardHit) return { unitHash: cardHit.unitHash, fragmentId: cardHit.fragmentId };
  if (fragmentHit) return { unitHash: fragmentHit.unitHash, fragmentId: fragmentHit.fragmentId };
  const winner = semanticHit!;
  return { unitHash: winner.hash, fragmentId: winner.fragmentId };
}

/**
 * Cosine similarity from a `units_vec` L2 distance over normalized vectors —
 * exactly the retired `tryVecScores`' own conversion, guarded the same way:
 * `1 - distance²/2`, clamped at 0, non-finite results treated as no evidence.
 */
function semanticCosine(distance: number): number {
  const raw = 1 - (distance * distance) / 2;
  return Number.isFinite(raw) ? Math.max(0, raw) : 0;
}

/**
 * Fuse the card-lexical, fragment-lexical (both `units_fts`) and semantic
 * (`units_vec`) unit-level result lists into one ranked entry list
 * (index-redesign-contract.md B3, restructured for field emphasis by B5f
 * item 2). Splitting lexical into two kind-scoped lists — rather than one
 * pool mixing card and fragment units — is what replaces the old per-column
 * BM25 weights (name 10x, description 5x, tags 3x, hints 2x, content 1x): a
 * card (name/description/tags/hints) match ranks within its own small pool
 * instead of racing every fragment's body text on raw BM25, so field
 * emphasis falls out of the units' structure with no weight tuned.
 *
 * Each list is first grouped to entries via `entry_units`, keeping that
 * list's own strongest unit per entry — `groupUnitHitsByEntry` from the
 * stage-1 unit store does this (by distance) for the semantic side;
 * `groupLexicalHitsByEntry` mirrors it (by bm25) for each lexical side.
 *
 * The fused score is MAGNITUDE, not reciprocal-rank fusion: rank-only fusion
 * was measured against the `curate-golden` gate fixture and lost to this —
 * see docs/plans/index-redesign.md's Search section for the table. Lexical
 * evidence is `stableFtsScore(bm25, population)` (the calibrated, monotone,
 * per-row transform — floor 0.3, ceiling 0.8), taken as the BEST of the
 * entry's card ("parent" population) and fragment ("fragment" population)
 * magnitudes; semantic evidence is cosine similarity. Combined the way the
 * pre-redesign `combineSearchScores` combined FTS and vector scores: with
 * both present, `lexical * 0.7 + semantic * 0.3`; lexical alone is itself;
 * semantic alone is `semantic * 0.3` (never enough alone to outrank a real
 * lexical hit's 0.3 floor). `matchedUnit` reports the unit by evidence
 * priority, not magnitude (see `pickFusionWinner`).
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

  const includeTypes = opts.typeFilter && opts.typeFilter.length > 0 ? new Set(opts.typeFilter) : null;
  const excludeTypes = opts.excludeTypes && opts.excludeTypes.length > 0 ? new Set(opts.excludeTypes) : null;

  const entryIds = new Set<number>([...cardByEntry.keys(), ...fragmentByEntry.keys(), ...semanticByEntry.keys()]);
  const results: RankedEntryInput[] = [];

  for (const entryId of entryIds) {
    const cardHit = cardByEntry.get(entryId);
    const fragmentHit = fragmentByEntry.get(entryId);
    const semanticHit = semanticByEntry.get(entryId);
    const lexicalHit = cardHit ?? fragmentHit;

    const lexicalScore = Math.max(
      cardHit ? stableFtsScore(cardHit.bm25, "parent") : 0,
      fragmentHit ? stableFtsScore(fragmentHit.bm25, "fragment") : 0,
    );
    const semanticScore = semanticHit ? semanticCosine(semanticHit.distance) : undefined;
    const score = lexicalHit
      ? semanticScore === undefined
        ? lexicalScore
        : lexicalScore * LEXICAL_WEIGHT + semanticScore * SEMANTIC_WEIGHT
      : (semanticScore ?? 0) * SEMANTIC_WEIGHT;

    const { unitHash, fragmentId } = pickFusionWinner(cardHit, fragmentHit, semanticHit);

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
      ...(lexicalHit ? { lexicalMatch: lexicalHit.lexicalMatch } : {}),
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
