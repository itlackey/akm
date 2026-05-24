// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { Database } from "bun:sqlite";
import type { ScopedUtilityRow, UtilityScoreRow } from "./db";
import { computeGraphBoost, type GraphBoostContext } from "./graph-boost";
import type { ProjectContext } from "./project-context";
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

/**
 * Phase 2A / Rec 5: default recency half-life (days) used when no
 * `utilityDecayConfig` is supplied to the ranking pipeline. Matches the
 * pre-2A hardcoded `RECENCY_DECAY_DAYS = 30` constant — the formula is
 * default-safe and collapses to `exp(-days / 30)` when no overrides apply.
 */
const DEFAULT_RECENCY_HALF_LIFE_DAYS = 30;
/**
 * Cap on the effective half-life after applying the feedback stability
 * boost — prevents indefinite half-life inflation for memories with many
 * positive feedback events. `effectiveHalfLife = min(halfLife * boost^count, halfLife * 4)`.
 */
const FEEDBACK_HALF_LIFE_CAP_MULTIPLIER = 4;

export interface RankingContext {
  db: Database;
  query: string;
  queryLower: string;
  queryTokens: string[];
  graphContext: GraphBoostContext | null;
  /** Project-context tokens derived from the current working directory. */
  projectContext?: ProjectContext | null;
}

export interface RankingContributor {
  name: string;
  appliesTo(item: RankedEntryInput, ctx: RankingContext): boolean;
  adjust(item: RankedEntryInput, ctx: RankingContext): number;
}

export interface UtilityRankingContext extends RankingContext {
  utilityScores: Map<number, UtilityScoreRow>;
  /**
   * Per-project scoped utility scores loaded from `utility_scores_scoped`.
   * Keyed by entry_id. When a scoped row exists for an entry the contributor
   * blends: `finalUtility = scopedUtility * 0.7 + globalUtility * 0.3`.
   * Absent or empty map falls back to global-only behaviour.
   */
  scopedUtilityScores?: Map<number, ScopedUtilityRow>;
  /**
   * Phase 2A / Rec 5: configurable forgetting curve parameters. When absent
   * the contributor falls back to {@link DEFAULT_RECENCY_HALF_LIFE_DAYS} and
   * no feedback-stability boost, preserving the pre-2A `exp(-days/30)` curve.
   */
  utilityDecayConfig?: {
    halfLifeDays: number;
    feedbackStabilityBoost: number;
  };
  /**
   * Phase 2A / Rec 5: per-entry positive feedback counts (keyed by entry id).
   * Used to compute the stabilized half-life:
   * `halfLifeDays * (feedbackStabilityBoost ^ positiveCount)`, capped at
   * `halfLifeDays * 4`. Empty/absent means no boost (default behaviour).
   */
  positiveFeedbackCounts?: Map<number, number>;
}

export interface UtilityRankingContributor {
  name: string;
  appliesTo(item: RankedEntryInput, ctx: UtilityRankingContext): boolean;
  apply(item: RankedEntryInput, ctx: UtilityRankingContext): void;
}

function beliefStateBoost(item: RankedEntryInput): number {
  const entry = item.entry;
  if (entry.type !== "memory") return 0;
  // Phase 1A: `asserted` and `deprecated` are first-class states.
  // `asserted` carries stronger user-explicit authority than `active`.
  // `deprecated` is a frozen historical state — penalized but milder than `superseded`.
  if (entry.beliefState === "contradicted") return -0.45;
  if (entry.beliefState === "superseded") return -0.25;
  if (entry.beliefState === "archived") return -0.6;
  if (entry.beliefState === "deprecated") return -0.15;
  if (entry.beliefState === "asserted") return 0.08;
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

/**
 * Capture-mode boost — Phase 1B / Rec 7.
 *
 * Memories captured via the hot path (`akm remember`) get a modest additive
 * boost so they outrank otherwise-equal background-derived memories. Memories
 * without `captureMode` (legacy) return 0 and rank exactly as before.
 */
const captureModeRankingContributor: RankingContributor = {
  name: "capture-mode-ranking",
  appliesTo(item) {
    return item.entry.type === "memory" && item.entry.captureMode === "hot";
  },
  adjust() {
    return 0.2;
  },
};

/**
 * Lesson strength boost — Phase 7A / Advantage D4b.
 *
 * Each ref that has credited a lesson via `akm feedback --applied-to` adds
 * 0.06 to the boost (capped at 0.3 ≈ five credits). Lessons without a
 * `lessonStrength` array (or a number) return 0.
 */
const lessonStrengthContributor: RankingContributor = {
  name: "lesson-strength-ranking",
  appliesTo(item) {
    return (
      item.entry.type === "lesson" && typeof item.entry.lessonStrength === "number" && item.entry.lessonStrength > 0
    );
  },
  adjust(item) {
    const strength = item.entry.lessonStrength ?? 0;
    return Math.min(0.3, 0.06 * strength);
  },
};

/**
 * Blend ratio for scoped vs. global utility signals.
 *
 * When a scoped row exists: `effectiveUtility = scoped * 0.7 + global * 0.3`
 * This ensures the in-project signal strongly dominates while the global
 * cold-start signal still helps when scoped history is sparse.
 */
const SCOPED_UTILITY_BLEND_SCOPED = 0.7;
const SCOPED_UTILITY_BLEND_GLOBAL = 1 - SCOPED_UTILITY_BLEND_SCOPED;

const utilityRankingContributor: UtilityRankingContributor = {
  name: "utility-ranking",
  appliesTo(item, ctx) {
    const utilScore = ctx.utilityScores.get(item.id);
    const scopedScore = ctx.scopedUtilityScores?.get(item.id);
    return Boolean((utilScore && utilScore.utility > 0) || (scopedScore && scopedScore.utility > 0));
  },
  apply(item, ctx) {
    const utilScore = ctx.utilityScores.get(item.id);
    const scopedScore = ctx.scopedUtilityScores?.get(item.id);

    // Determine effective utility: prefer scoped when present, blend with global.
    const globalUtility = utilScore?.utility ?? 0;
    const scopedUtility = scopedScore?.utility ?? 0;
    const effectiveUtility =
      scopedUtility > 0
        ? scopedUtility * SCOPED_UTILITY_BLEND_SCOPED + globalUtility * SCOPED_UTILITY_BLEND_GLOBAL
        : globalUtility;

    if (effectiveUtility <= 0) return;

    // Recency decay: use the global lastUsedAt for the decay factor (it's an
    // ISO string with full resolution), falling back to scoped lastUsedAt (ms).
    let recencyFactor = 1;
    const lastUsedRaw =
      utilScore?.lastUsedAt ?? (scopedScore ? new Date(scopedScore.lastUsedAt).toISOString() : undefined);
    if (lastUsedRaw) {
      const lastUsedMs = new Date(lastUsedRaw).getTime();
      const daysSinceLastUse = Number.isNaN(lastUsedMs)
        ? Infinity
        : Math.max(0, (Date.now() - lastUsedMs) / (1000 * 60 * 60 * 24));

      // Phase 2A / Rec 5: configurable forgetting curve with optional
      // feedback-stability boost. Absent config + absent positive feedback
      // collapses to `exp(-days / 30)` — pre-2A default-safe.
      const halfLifeDays = ctx.utilityDecayConfig?.halfLifeDays ?? DEFAULT_RECENCY_HALF_LIFE_DAYS;
      const stabilityBoost = ctx.utilityDecayConfig?.feedbackStabilityBoost ?? 1.5;
      const positiveCount = ctx.positiveFeedbackCounts?.get(item.id) ?? 0;
      // `boost^count` is 1 when count is 0 OR when boost is 1.0, so neither
      // a missing feedback count nor a "no boost" config widens the half-life.
      let stabilizedHalfLife = halfLifeDays * stabilityBoost ** positiveCount;
      stabilizedHalfLife = Math.min(stabilizedHalfLife, halfLifeDays * FEEDBACK_HALF_LIFE_CAP_MULTIPLIER);
      // Defensive: half-life must stay positive to avoid div-by-zero / Infinity.
      const safeHalfLife = Math.max(0.0001, stabilizedHalfLife);

      recencyFactor = Math.exp(-daysSinceLastUse / safeHalfLife);
    }
    const rawBoost = 1 + effectiveUtility * recencyFactor * UTILITY_WEIGHT;
    item.score *= Math.min(rawBoost, UTILITY_MAX_BOOST);
    item.utilityBoosted = true;
  },
};

/**
 * Project-context boost.
 *
 * Auto-boosts assets whose name, tags, aliases, or search hints contain tokens
 * derived from the current working directory's project name. For example, when
 * running `akm search` from the `akm` git repo, assets tagged `akm` or named
 * `akm-*` receive an additive boost.
 *
 * The boost is capped at 0.5 so it can never overpower an exact-name match
 * (which contributes 2.0). Each matching token adds 0.2 up to the cap.
 *
 * Skipped entirely when `projectContext` is absent or has no tokens (e.g.
 * when running from home dir, /tmp, or when disabled via
 * `--no-project-context` / `AKM_DISABLE_PROJECT_CONTEXT=1`).
 */
const projectContextRankingContributor: RankingContributor = {
  name: "project-context-ranking",
  appliesTo(_item, ctx) {
    return ctx.projectContext != null && ctx.projectContext.tokens.size > 0;
  },
  adjust(item, ctx) {
    if (!ctx.projectContext) return 0;
    const fields = [
      item.entry.name ?? "",
      ...(item.entry.tags ?? []),
      ...(item.entry.aliases ?? []),
      ...(item.entry.searchHints ?? []),
    ].map((s) => s.toLowerCase());
    let hits = 0;
    for (const token of ctx.projectContext.tokens) {
      if (fields.some((f) => f.includes(token))) hits++;
    }
    return Math.min(0.5, hits * 0.2);
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
  captureModeRankingContributor,
  lessonStrengthContributor,
  projectContextRankingContributor,
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
