import type { Database } from "bun:sqlite";
import type { UtilityScoreRow } from "./db";
import { computeGraphBoost, type GraphBoostContext } from "./graph-boost";
import type { RankedEntryInput } from "./ranking";

const TYPE_BOOST: Record<string, number> = {
  skill: 0.4,
  command: 0.35,
  workflow: 0.35,
  agent: 0.3,
  script: 0.2,
  knowledge: 0.22,
  memory: -0.02,
};

const MAX_BOOST_SUM = 3.0;
const UTILITY_WEIGHT = 0.5;
const UTILITY_MAX_BOOST = 1.5;
const RECENCY_DECAY_DAYS = 30;

export interface RankingContext {
  db: Database;
  query: string;
  queryLower: string;
  queryTokens: string[];
  graphContext: GraphBoostContext | null;
}

export interface RankingContributor {
  name: string;
  appliesTo(item: RankedEntryInput, ctx: RankingContext): boolean;
  adjust(item: RankedEntryInput, ctx: RankingContext): number;
}

export interface UtilityRankingContext extends RankingContext {
  utilityScores: Map<number, UtilityScoreRow>;
}

export interface UtilityRankingContributor {
  name: string;
  appliesTo(item: RankedEntryInput, ctx: UtilityRankingContext): boolean;
  apply(item: RankedEntryInput, ctx: UtilityRankingContext): void;
}

function beliefStateBoost(item: RankedEntryInput): number {
  const entry = item.entry;
  if (entry.type !== "memory") return 0;
  if (entry.beliefState === "contradicted") return -0.45;
  if (entry.beliefState === "superseded") return -0.25;
  if (entry.beliefState === "archived") return -0.6;
  if (entry.beliefState === "active") return 0.06;
  return 0;
}

const exactNameRankingContributor: RankingContributor = {
  name: "exact-name-ranking",
  appliesTo: () => true,
  adjust(item, ctx) {
    const entry = item.entry;
    const nameLower = entry.name.toLowerCase();
    const rawNameBase = nameLower.split("/").pop() ?? nameLower;
    const nameBase =
      entry.type === "memory" && rawNameBase.endsWith(".derived")
        ? rawNameBase.slice(0, -".derived".length)
        : rawNameBase;
    if (nameBase === ctx.queryLower || nameLower === ctx.queryLower) {
      return 2.0;
    }
    if (nameBase.includes(ctx.queryLower) || ctx.queryLower.includes(nameBase)) {
      return 1.0;
    }
    const nameTokens = nameBase.split(/[-_\s]+/).filter(Boolean);
    const matchCount = ctx.queryTokens.filter((qt) => nameTokens.some((nt) => nt === qt || nt.includes(qt))).length;
    return matchCount > 0 ? Math.min(0.9, matchCount * 0.3) : 0;
  },
};

const typeRankingContributor: RankingContributor = {
  name: "type-ranking",
  appliesTo: () => true,
  adjust(item) {
    return TYPE_BOOST[item.entry.type] ?? 0;
  },
};

const memoryRankingContributor: RankingContributor = {
  name: "memory-ranking",
  appliesTo(item) {
    return item.entry.type === "memory";
  },
  adjust(item) {
    const derivedBoost = item.entry.name.toLowerCase().endsWith(".derived") ? 0.12 : -0.08;
    return derivedBoost + beliefStateBoost(item);
  },
};

const tagRankingContributor: RankingContributor = {
  name: "tag-ranking",
  appliesTo(item) {
    return Array.isArray(item.entry.tags) && item.entry.tags.length > 0;
  },
  adjust(item, ctx) {
    let tagBoost = 0;
    for (const tag of item.entry.tags ?? []) {
      if (ctx.queryTokens.some((token) => tag.toLowerCase() === token)) tagBoost += 0.15;
    }
    return Math.min(0.3, tagBoost);
  },
};

const searchHintRankingContributor: RankingContributor = {
  name: "search-hint-ranking",
  appliesTo(item) {
    return Array.isArray(item.entry.searchHints) && item.entry.searchHints.length > 0;
  },
  adjust(item, ctx) {
    let hintBoost = 0;
    for (const hint of item.entry.searchHints ?? []) {
      const hintLower = hint.toLowerCase();
      for (const token of ctx.queryTokens) {
        if (hintLower.includes(token)) {
          hintBoost += 0.12;
          break;
        }
      }
    }
    return Math.min(0.24, hintBoost);
  },
};

const aliasRankingContributor: RankingContributor = {
  name: "alias-ranking",
  appliesTo(item) {
    return Array.isArray(item.entry.aliases) && item.entry.aliases.length > 0;
  },
  adjust(item, ctx) {
    let boost = 0;
    for (const alias of item.entry.aliases ?? []) {
      const aliasLower = alias.toLowerCase();
      if (aliasLower === ctx.queryLower) {
        boost += 1.5;
        break;
      }
      if (ctx.queryTokens.some((token) => aliasLower.includes(token))) boost += 0.3;
    }
    return boost;
  },
};

const descriptionRankingContributor: RankingContributor = {
  name: "description-ranking",
  appliesTo(item) {
    return typeof item.entry.description === "string" && item.entry.description.length > 0;
  },
  adjust(item, ctx) {
    const descLower = item.entry.description?.toLowerCase() ?? "";
    const descMatchCount = ctx.queryTokens.filter((token) => descLower.includes(token)).length;
    if (descMatchCount === ctx.queryTokens.length && ctx.queryTokens.length > 1) return 0.25;
    if (descMatchCount > 0) return 0.1;
    return 0;
  },
};

const metadataRankingContributor: RankingContributor = {
  name: "metadata-ranking",
  appliesTo: () => true,
  adjust(item) {
    let boost = item.entry.quality === "curated" ? 0.05 : 0;
    if (typeof item.entry.confidence === "number") {
      boost += Math.min(0.05, Math.max(0, item.entry.confidence) * 0.05);
    }
    return boost;
  },
};

const graphRankingContributor: RankingContributor = {
  name: "graph-ranking",
  appliesTo(_item, ctx) {
    return ctx.graphContext !== null;
  },
  adjust(item, ctx) {
    return ctx.graphContext ? computeGraphBoost(ctx.graphContext, item.filePath) : 0;
  },
};

const utilityRankingContributor: UtilityRankingContributor = {
  name: "utility-ranking",
  appliesTo(item, ctx) {
    const utilScore = ctx.utilityScores.get(item.id);
    return Boolean(utilScore && utilScore.utility > 0);
  },
  apply(item, ctx) {
    const utilScore = ctx.utilityScores.get(item.id);
    if (!utilScore || utilScore.utility <= 0) return;
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
  },
};

export const defaultRankingContributors: RankingContributor[] = [
  exactNameRankingContributor,
  typeRankingContributor,
  memoryRankingContributor,
  tagRankingContributor,
  searchHintRankingContributor,
  aliasRankingContributor,
  descriptionRankingContributor,
  metadataRankingContributor,
  graphRankingContributor,
];

export const defaultUtilityRankingContributors: UtilityRankingContributor[] = [utilityRankingContributor];

export function applyScoreContributors(
  item: RankedEntryInput,
  ctx: RankingContext,
  contributors: RankingContributor[] = defaultRankingContributors,
): void {
  let boostSum = 0;
  for (const contributor of contributors) {
    if (!contributor.appliesTo(item, ctx)) continue;
    boostSum += contributor.adjust(item, ctx);
  }
  item.score *= 1 + Math.min(boostSum, MAX_BOOST_SUM);
}

export function applyUtilityContributors(
  item: RankedEntryInput,
  ctx: UtilityRankingContext,
  contributors: UtilityRankingContributor[] = defaultUtilityRankingContributors,
): void {
  for (const contributor of contributors) {
    if (!contributor.appliesTo(item, ctx)) continue;
    contributor.apply(item, ctx);
  }
}
