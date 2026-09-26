// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { stableFtsScore } from "../../core/lexical-score";
import type { Database } from "../../storage/database";
import type { DbSearchResult } from "../../storage/repositories/index-entry-types";
import { getUtilityScoresByIds } from "../../storage/repositories/index-utility-repository";
import type { GraphBoostContext } from "../graph/graph-boost";
import type { IndexDocument } from "../passes/metadata";
import type { ProjectContext } from "../walk/project-context";
import { buildLexicalQueryPlan } from "./fts-query";
import { lexicalNameTokens, structuralNameTokenMatch } from "./name-match";
import {
  applyScoreContributors,
  applyUtilityContributors,
  defaultRankingContributors,
  defaultUtilityRankingContributors,
} from "./ranking-contributors";
import type { RankedEntryInput } from "./ranking-types";

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

/**
 * Lower bounds keep a lexical hit competitive with a vector-only neighbour;
 * the upper bound deliberately leaves room for the ranking contributors that
 * run after retrieval (notably the bounded graph boost).  This is a
 * calibration for the one search pipeline, not a claim that BM25 is
 * comparable across different queries or FTS tables.
 */

/**
 * Convert FTS5's negative BM25 value into the lexical contribution used by
 * this pipeline.  The transform is fixed and monotone: it depends only on a
 * row's own BM25 value, so appending weaker candidates cannot rewrite an
 * existing row's score. FTS5 commonly emits relevance near 1e-6 for broad
 * queries, so first put relevance on a log scale around that observed value.
 * The shape constant intentionally makes the curve approach its ceiling
 * slowly: rare-term scores retain separation instead of all reading as 0.8.
 *
 * FTS5 produces finite non-positive values in normal operation.  Keeping the
 * defensive cases here finite makes this boundary safe if a driver or fixture
 * hands us an invalid value: `-Infinity` is the strongest possible match,
 * while NaN, +Infinity, and positive scores contribute no lexical evidence.
 */
export function normalizeFtsScores(results: DbSearchResult[]): Map<number, { score: number; result: DbSearchResult }> {
  const ftsScoreMap = new Map<number, { score: number; result: DbSearchResult }>();

  for (const result of results) {
    ftsScoreMap.set(result.id, { score: result.lexicalScore ?? stableFtsScore(result.bm25Score), result });
  }

  return ftsScoreMap;
}

export function combineSearchScores(options: {
  ftsScoreMap: Map<number, { score: number; result: DbSearchResult }>;
  embedScoreMap: Map<number, number>;
  getEntryById: (id: number) =>
    | {
        entry: IndexDocument;
        filePath: string;
        itemRef?: string | null;
        bundleId?: string | null;
        conceptId?: string | null;
      }
    | undefined;
  typeFilter?: string;
  /**
   * #627 — types excluded from the default (untyped 'any') path. The FTS and
   * enumerate paths apply this at the SQL layer, but vector-only neighbors are
   * re-added here straight from `embedScoreMap` (filtered only by `typeFilter`,
   * which is `undefined` on the 'any' path). Without this filter a `session`
   * asset that is a top-k vector neighbor but NOT an FTS match would leak into
   * default results whenever an embedding provider is configured (the default
   * `semanticSearchMode: 'auto'` production config). Empty list = no exclusion.
   */
  excludeTypes?: string[];
}): RankedEntryInput[] {
  const FTS_WEIGHT = 0.7;
  const VEC_WEIGHT = 0.3;
  const excludeTypeSet = options.excludeTypes && options.excludeTypes.length > 0 ? new Set(options.excludeTypes) : null;
  const scored: RankedEntryInput[] = [];
  const seenIds = new Set<number>();

  for (const [id, { score: ftsScore, result }] of options.ftsScoreMap) {
    seenIds.add(id);
    const embedScore = options.embedScoreMap.get(id);
    const combinedScore = embedScore !== undefined ? ftsScore * FTS_WEIGHT + embedScore * VEC_WEIGHT : ftsScore;
    scored.push({
      id,
      entry: result.entry,
      filePath: result.filePath,
      score: combinedScore,
      rankingMode: embedScore !== undefined ? "hybrid" : "fts",
      lexicalMatch: result.lexicalMatch,
      itemRef: result.itemRef,
      bundleId: result.bundleId,
      conceptId: result.conceptId,
      fragmentId: result.fragmentId,
    });
  }

  for (const [id, cosine] of options.embedScoreMap) {
    if (seenIds.has(id)) continue;
    const found = options.getEntryById(id);
    if (!found) continue;
    if (options.typeFilter && found.entry.type !== options.typeFilter) continue;
    // #627 — drop vector-only neighbors whose type is excluded on the default path.
    if (excludeTypeSet?.has(found.entry.type)) continue;
    scored.push({
      id,
      entry: found.entry,
      filePath: found.filePath,
      score: cosine * VEC_WEIGHT,
      rankingMode: "semantic",
      itemRef: found.itemRef,
      bundleId: found.bundleId,
      conceptId: found.conceptId,
    });
  }

  return scored;
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
 * callers never literally receive `0.65` just because this ceiling bound. The
 * pre-ceiling relevance is kept as ordering evidence.
 */
function applyRelaxedLexicalScoreCeiling(item: RankedEntryInput, queryTokens: string[]): void {
  if (item.lexicalMatch !== "relaxed" || lexicalNameMatchTier(item.entry, queryTokens) > 0) return;
  if (item.score > RELAXED_NON_NAME_SCORE_CEILING) {
    item.preRelaxedCeilingScore = item.score;
    item.score = RELAXED_NON_NAME_SCORE_CEILING;
  }
}
