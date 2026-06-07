// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { Database } from "bun:sqlite";
import { type DbSearchResult, getUtilityScoresByIds } from "../db/db";
import type { GraphBoostContext } from "../graph/graph-boost";
import type { StashEntry } from "../passes/metadata";
import type { ProjectContext } from "../walk/project-context";
import { applyScoreContributors, applyUtilityContributors } from "./ranking-contributors";

export interface RankedEntryInput {
  id: number;
  entry: StashEntry;
  filePath: string;
  score: number;
  rankingMode: "hybrid" | "semantic" | "fts";
  utilityBoosted?: boolean;
}

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
}

export function normalizeFtsScores(results: DbSearchResult[]): Map<number, { score: number; result: DbSearchResult }> {
  const ftsScoreMap = new Map<number, { score: number; result: DbSearchResult }>();
  if (results.length === 0) return ftsScoreMap;

  const bestBm25 = results[0].bm25Score;
  const worstBm25 = results[results.length - 1].bm25Score;
  const range = bestBm25 - worstBm25;

  for (const result of results) {
    const normalized = range !== 0 ? (result.bm25Score - worstBm25) / range : 1.0;
    const ftsScore = 0.3 + normalized * 0.7;
    ftsScoreMap.set(result.id, { score: ftsScore, result });
  }

  return ftsScoreMap;
}

export function combineSearchScores(options: {
  ftsScoreMap: Map<number, { score: number; result: DbSearchResult }>;
  embedScoreMap: Map<number, number>;
  getEntryById: (id: number) => { entry: StashEntry; filePath: string } | undefined;
  typeFilter?: string;
}): RankedEntryInput[] {
  const FTS_WEIGHT = 0.7;
  const VEC_WEIGHT = 0.3;
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
    });
  }

  for (const [id, cosine] of options.embedScoreMap) {
    if (seenIds.has(id)) continue;
    const found = options.getEntryById(id);
    if (!found) continue;
    if (options.typeFilter && found.entry.type !== options.typeFilter) continue;
    scored.push({
      id,
      entry: found.entry,
      filePath: found.filePath,
      score: cosine * VEC_WEIGHT,
      rankingMode: "semantic",
    });
  }

  return scored;
}

export function applyRankingRules(options: RankEntriesOptions): RankedEntryInput[] {
  const queryTokens = options.query.toLowerCase().split(/\s+/).filter(Boolean);
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
    applyScoreContributors(item, rankingContext);
  }

  const { global: utilScoresMap, scoped: scopedUtilScoresMap } = getUtilityScoresByIds(
    options.db,
    options.items.map((item) => item.id),
    options.scopeKey,
  );
  const utilityContext = {
    ...rankingContext,
    utilityScores: utilScoresMap,
    scopedUtilityScores: scopedUtilScoresMap,
    utilityDecayConfig: options.utilityDecayConfig,
    positiveFeedbackCounts: options.positiveFeedbackCounts,
  };
  for (const item of options.items) {
    applyUtilityContributors(item, utilityContext);
  }

  return options.items;
}
