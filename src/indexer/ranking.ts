import type { Database } from "bun:sqlite";
import { type DbSearchResult, getUtilityScoresByIds } from "./db";
import { computeGraphBoost, type GraphBoostContext } from "./graph-boost";
import type { StashEntry } from "./metadata";

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
}

const TYPE_BOOST: Record<string, number> = {
  skill: 0.4,
  command: 0.35,
  workflow: 0.35,
  agent: 0.3,
  script: 0.2,
  memory: 0.1,
  knowledge: 0,
};

const MAX_BOOST_SUM = 3.0;
const UTILITY_WEIGHT = 0.5;
const UTILITY_MAX_BOOST = 1.5;
const RECENCY_DECAY_DAYS = 30;

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

  for (const item of options.items) {
    const entry = item.entry;
    let boostSum = 0;
    const nameLower = entry.name.toLowerCase();
    const rawNameBase = nameLower.split("/").pop() ?? nameLower;
    const nameBase =
      entry.type === "memory" && rawNameBase.endsWith(".derived")
        ? rawNameBase.slice(0, -".derived".length)
        : rawNameBase;
    if (nameBase === queryLower || nameLower === queryLower) {
      boostSum += 2.0;
    } else if (nameBase.includes(queryLower) || queryLower.includes(nameBase)) {
      boostSum += 1.0;
    } else {
      const nameTokens = nameBase.split(/[-_\s]+/).filter(Boolean);
      const matchCount = queryTokens.filter((qt) => nameTokens.some((nt) => nt === qt || nt.includes(qt))).length;
      if (matchCount > 0) boostSum += Math.min(0.9, matchCount * 0.3);
    }

    boostSum += TYPE_BOOST[entry.type] ?? 0;

    if (entry.type === "memory") {
      boostSum += entry.name.toLowerCase().endsWith(".derived") ? 0.18 : -0.08;
    }

    if (entry.tags) {
      let tagBoost = 0;
      for (const tag of entry.tags) {
        if (queryTokens.some((token) => tag.toLowerCase() === token)) tagBoost += 0.15;
      }
      boostSum += Math.min(0.3, tagBoost);
    }

    if (entry.searchHints) {
      let hintBoost = 0;
      for (const hint of entry.searchHints) {
        const hintLower = hint.toLowerCase();
        for (const token of queryTokens) {
          if (hintLower.includes(token)) {
            hintBoost += 0.12;
            break;
          }
        }
      }
      boostSum += Math.min(0.24, hintBoost);
    }

    if (entry.aliases) {
      for (const alias of entry.aliases) {
        const aliasLower = alias.toLowerCase();
        if (aliasLower === queryLower) {
          boostSum += 1.5;
          break;
        }
        if (queryTokens.some((token) => aliasLower.includes(token))) boostSum += 0.3;
      }
    }

    if (entry.description) {
      const descLower = entry.description.toLowerCase();
      const descMatchCount = queryTokens.filter((token) => descLower.includes(token)).length;
      if (descMatchCount === queryTokens.length && queryTokens.length > 1) boostSum += 0.25;
      else if (descMatchCount > 0) boostSum += 0.1;
    }

    boostSum += entry.quality === "curated" ? 0.05 : 0;
    if (typeof entry.confidence === "number") {
      boostSum += Math.min(0.05, Math.max(0, entry.confidence) * 0.05);
    }

    if (options.graphContext) {
      boostSum += computeGraphBoost(options.graphContext, item.filePath);
    }

    item.score *= 1 + Math.min(boostSum, MAX_BOOST_SUM);
  }

  const utilScoresMap = getUtilityScoresByIds(
    options.db,
    options.items.map((item) => item.id),
  );
  for (const item of options.items) {
    const utilScore = utilScoresMap.get(item.id);
    if (!utilScore || utilScore.utility <= 0) continue;
    let recencyFactor = 1;
    if (utilScore.lastUsedAt) {
      const lastUsedMs = new Date(utilScore.lastUsedAt).getTime();
      const daysSinceLastUse = Number.isNaN(lastUsedMs)
        ? Infinity
        : Math.max(0, (Date.now() - lastUsedMs) / (1000 * 60 * 60 * 24));
      recencyFactor = Math.exp(-daysSinceLastUse / RECENCY_DECAY_DAYS);
    }
    const rawBoost = 1 + utilScore.utility * recencyFactor * UTILITY_WEIGHT;
    item.score *= Math.min(rawBoost, UTILITY_MAX_BOOST);
    item.utilityBoosted = true;
  }

  return options.items;
}
