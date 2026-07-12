// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import { makeAssetRef } from "../../core/asset/asset-ref";
import type { AkmAssetType } from "../../core/common";
import { acquireMaintenanceActivitySync } from "../../core/maintenance-barrier";
import { getStateDbPath } from "../../core/state-db";
import { type Database, openDatabase } from "../../storage/database";
import { type DbSearchResult, getUtilityScoresByIds } from "../db/db";
import type { GraphBoostContext } from "../graph/graph-boost";
import type { StashEntry } from "../passes/metadata";
import type { ProjectContext } from "../walk/project-context";
import {
  applyBeliefStateScoreCeiling,
  applyContributorAblation,
  applyScoreContributors,
  applyUtilityContributors,
  defaultRankingContributors,
  defaultUtilityRankingContributors,
} from "./ranking-contributors";

export interface RankedEntryInput {
  id: number;
  entry: StashEntry;
  filePath: string;
  score: number;
  rankingMode: "hybrid" | "semantic" | "fts";
  utilityBoosted?: boolean;
  /**
   * Set by `applyBeliefStateScoreCeiling` when a demoting belief state's
   * ceiling clamped this item: the score BEFORE the clamp. The semantic-only
   * `minScore` floor in db-search checks this instead of the clamped score,
   * so a ceiling that sits below the floor (e.g. archived 0.15 < default
   * minScore 0.2) demotes the hit to last place instead of silently DROPPING
   * a result that would otherwise have listed.
   */
  preCeilingScore?: number;
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
  /**
   * R2 — improve-loop salience scores (`asset_salience.rank_score`) keyed by
   * entry id. `undefined` (default) = load best-effort from state.db;
   * `null` = explicitly disabled; a Map = injected (tests / callers that
   * already hold the data).
   */
  salienceRankScores?: Map<number, number> | null;
}

/**
 * R2 — best-effort load of `asset_salience.rank_score` from state.db for the
 * ranked items. Fail-open: any error (state.db locked by a concurrent improve
 * run, missing table, unreadable path) returns an empty map, which makes the
 * salience contributor a no-op — byte-identical to pre-R2 ranking.
 *
 * Deliberately NOT `openStateDatabase()`: that helper runs migrations and sets
 * a 30 s busy timeout — too heavy for a search hot path. This opens read-only,
 * never creates or migrates state.db (missing file / missing table = empty
 * map), and caps lock waits at 250 ms so a concurrent improve run can only
 * ever cost the search a quarter second, not a stall.
 */
export function loadSalienceRankScores(items: RankedEntryInput[]): Map<number, number> {
  const result = new Map<number, number>();
  if (items.length === 0) return result;
  try {
    const dbPath = getStateDbPath();
    if (!fs.existsSync(dbPath)) return result; // improve loop has never run here
    const releaseActivity = acquireMaintenanceActivitySync("state-db");
    const idByRef = new Map<string, number>();
    try {
      for (const item of items) {
        idByRef.set(makeAssetRef(item.entry.type as AkmAssetType, item.entry.name), item.id);
      }
      const stateDb = openDatabase(dbPath, { readonly: true });
      try {
        try {
          stateDb.exec("PRAGMA busy_timeout = 250");
        } catch {
          // pragma failure on a readonly handle is fine — default timeout applies
        }
        const refs = [...idByRef.keys()];
        const CHUNK = 500;
        for (let i = 0; i < refs.length; i += CHUNK) {
          const chunk = refs.slice(i, i + CHUNK);
          const placeholders = chunk.map(() => "?").join(",");
          const rows = stateDb
            .prepare(`SELECT asset_ref, rank_score FROM asset_salience WHERE asset_ref IN (${placeholders})`)
            .all(...chunk) as Array<{ asset_ref: string; rank_score: number }>;
          for (const row of rows) {
            const id = idByRef.get(row.asset_ref);
            if (id !== undefined) result.set(id, row.rank_score);
          }
        }
      } finally {
        stateDb.close();
      }
    } finally {
      releaseActivity();
    }
  } catch {
    // Fail open — search must never break because state.db is unavailable.
  }
  return result;
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

  // Eval/debug only: AKM_ABLATE_CONTRIBUTORS lets the ablation harness drop
  // named contributors to measure their effect. Resolved once per query;
  // a no-op (full lists) when the env var is unset — see applyContributorAblation.
  const ablateEnv = process.env.AKM_ABLATE_CONTRIBUTORS;
  const activeScoreContributors = applyContributorAblation(defaultRankingContributors, ablateEnv);
  const activeUtilityContributors = applyContributorAblation(defaultUtilityRankingContributors, ablateEnv);

  for (const item of options.items) {
    applyScoreContributors(item, rankingContext, activeScoreContributors);
  }

  const { global: utilScoresMap, scoped: scopedUtilScoresMap } = getUtilityScoresByIds(
    options.db,
    options.items.map((item) => item.id),
    options.scopeKey,
  );
  // R2 — compose the improve loop's salience into user-facing ranking.
  // undefined = load from state.db (default); null = explicitly disabled.
  const salienceRankScores =
    options.salienceRankScores === null
      ? new Map<number, number>()
      : (options.salienceRankScores ?? loadSalienceRankScores(options.items));
  const utilityContext = {
    ...rankingContext,
    utilityScores: utilScoresMap,
    scopedUtilityScores: scopedUtilScoresMap,
    utilityDecayConfig: options.utilityDecayConfig,
    positiveFeedbackCounts: options.positiveFeedbackCounts,
    salienceRankScores,
  };
  for (const item of options.items) {
    applyUtilityContributors(item, utilityContext, activeUtilityContributors);
    // SPEC-5: demoting belief states (superseded/contradicted/archived/
    // deprecated) cap the FINAL score. The additive belief penalty inside the
    // multiplicative boost sum cannot overcome the FTS min-max normalization
    // spread, so without the ceiling a superseded incumbent that is the best
    // keyword match outranks its own correction forever.
    applyBeliefStateScoreCeiling(item);
  }

  return options.items;
}
