// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { isKnownType, type KnownType } from "../../core/recognition-util";
import type { Database } from "../../storage/database";
import type { ScopedUtilityRow, UtilityScoreRow } from "../db/db";
import { computeGraphBoost, type GraphBoostContext } from "../graph/graph-boost";
import type { ProjectContext } from "../walk/project-context";
import type { RankedEntryInput } from "./ranking-types";

/**
 * Chunk 1.5 (D1.5-5) — retyped from `Record<string, number>` to a FULL
 * `Record<KnownType, number>`. Only 8/14 types carried an entry before this
 * chunk (`env`, `secret`, `wiki`, `lesson`, `task`, `session` silently fell
 * through to the `?? 0` fallback at the sole consumer,
 * {@link typeRankingContributor}). The 6 additions below are explicit `0`
 * entries — behavior-preserving (they already defaulted to `0`), but now
 * compile-time-exhaustive: adding a new `KNOWN_TYPE` forces an explicit
 * boost decision instead of silently defaulting.
 */
export const TYPE_BOOST: Record<KnownType, number> = {
  skill: 0.4,
  command: 0.35,
  workflow: 0.35,
  agent: 0.3,
  script: 0.2,
  knowledge: 0.22,
  // Facts are authoritative, durable declarations about the stash — rank them
  // alongside knowledge so they surface reliably when relevant.
  fact: 0.22,
  memory: -0.02,
  // Chunk 1.5: previously-absent entries, all defaulted to 0 pre-chunk —
  // explicit now, unchanged in effect.
  env: 0,
  secret: 0,
  wiki: 0,
  lesson: 0,
  task: 0,
  session: 0,
};

/**
 * Open-string accessor over {@link TYPE_BOOST} (plan §2.3 "ranking
 * accessor"). Foreign/unknown types (outside `KNOWN_TYPES`) fall back to `0`
 * — identical to the old `TYPE_BOOST[item.entry.type] ?? 0` behavior on a
 * loosely-typed `Record<string, number>`, now expressed safely over the
 * exhaustive `Record<KnownType, number>`.
 */
export function typeBoostFor(type: string): number {
  return isKnownType(type) ? TYPE_BOOST[type] : 0;
}

const MAX_BOOST_SUM = 3.0;
const UTILITY_WEIGHT = 0.5;
const UTILITY_MAX_BOOST = 1.5;

/**
 * R2 (docs/design/improve-self-learning-analysis.md) — weight of the improve
 * loop's `asset_salience.rank_score` in user-facing ranking. Bounded well
 * below the utility boost so the composed signal refines, never dominates,
 * lexical/semantic relevance. rank_score ∈ [0,1] → boost ∈ [1, 1.2].
 */
const SALIENCE_WEIGHT = 0.2;
const SALIENCE_MAX_BOOST = 1.2;

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
  /**
   * R2 — improve-loop salience scores (`asset_salience.rank_score`, [0,1])
   * keyed by entry id, loaded best-effort from state.db by the ranking
   * pipeline. Absent/empty map = no salience contribution (fail-open parity
   * with a fresh install where the improve loop has never run).
   */
  salienceRankScores?: Map<number, number>;
}

export interface UtilityRankingContributor {
  name: string;
  appliesTo(item: RankedEntryInput, ctx: UtilityRankingContext): boolean;
  apply(item: RankedEntryInput, ctx: UtilityRankingContext): void;
}

function beliefStateBoost(item: RankedEntryInput): number {
  const entry = item.entry;
  // 03: belief-state penalties/boosts apply to ANY flagged entry (memory OR
  // knowledge), so contradicted/superseded KNOWLEDGE is demoted from results
  // just like flagged memories. Entries without a belief state fall through to
  // the `return 0` below (default-safe — no effect on unflagged assets).
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

/**
 * Post-boost score ceilings for the demoting belief states (SPEC-5,
 * stash-conventions-code-spec.md — corrections demotion).
 *
 * Why the additive {@link beliefStateBoost} penalties alone are not enough:
 * keyword base scores are min-max normalized into [0.3, 1.0]
 * (`normalizeFtsScores`), so the spread between the best FTS hit and its
 * runner-up can be as large as 0.7 — and the boost sum then MULTIPLIES the
 * base (`score *= 1 + boostSum`, {@link applyScoreContributors}). A
 * superseded incumbent that is the best keyword match for a query therefore
 * stays clamp-pinned at 1.0 above its own correction no matter what additive
 * penalty it receives — defeating the corrections pattern's point ("so the
 * ranker demotes the stale version instead of letting it outrank your fix").
 *
 * The ceilings guarantee the demotion while keeping flagged entries VISIBLE:
 * un-demoted keyword hits floor at a 0.3 base, so any un-demoted hit outranks
 * a ceilinged one; demoted entries still list (belief FILTERING stays a
 * separate opt-in axis, `--belief`), and scores already below a ceiling keep
 * their relative ordering. Ceiling order mirrors the additive-penalty
 * severity order pinned in tests/belief-state-phase1a.test.ts:
 * deprecated (mildest) > superseded > contradicted > archived.
 */
const BELIEF_STATE_SCORE_CEILINGS: Record<string, number> = {
  deprecated: 0.28,
  superseded: 0.25,
  contradicted: 0.2,
  archived: 0.15,
};

/**
 * Clamp a ranked entry's FINAL score (after every additive and utility boost)
 * to its demoting belief state's ceiling. No-op for `asserted`/`active`/unset
 * entries. Applied once per item at the end of `applyRankingRules` so sort
 * order and displayed scores stay consistent (single scoring pipeline).
 *
 * When the ceiling clamps, the pre-clamp score is recorded as
 * `preCeilingScore` so db-search's semantic-only `minScore` floor can judge
 * the hit by what it would have scored WITHOUT the demotion — a ceiling below
 * the floor (archived 0.15 < default minScore 0.2) must demote a hit to last
 * place, never silently drop it from the results.
 */
export function applyBeliefStateScoreCeiling(item: RankedEntryInput): void {
  const state = item.entry.beliefState;
  const ceiling = state !== undefined ? BELIEF_STATE_SCORE_CEILINGS[state] : undefined;
  if (ceiling !== undefined && item.score > ceiling) {
    item.preCeilingScore = item.score;
    item.score = ceiling;
  }
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
    return typeBoostFor(item.entry.type);
  },
};

const beliefStateRankingContributor: RankingContributor = {
  name: "belief-state-ranking",
  appliesTo(item) {
    // Fire for any entry that carries a belief state, regardless of type — so
    // contradicted/superseded knowledge is demoted, not just memories. The
    // `.derived`-twin `derivedBoost` (±0.12/−0.08) is deleted (03-R3): it made
    // stale flag-free twins outrank their corrected base memory; belief-state
    // demotion is the principled signal, not the twin-name heuristic.
    return item.entry.beliefState !== undefined;
  },
  adjust(item) {
    return beliefStateBoost(item);
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
 * Pinned-fact boost.
 *
 * Facts marked `pinned: true` form the small always-injected "core context"
 * (see docs/design/fact-asset-type.md). The fact metadata contributor records
 * a `pinned` search hint; here we give those facts a modest additive boost so
 * the core outranks ordinary facts on otherwise-equal queries. Capped small so
 * it cannot overpower an exact-name match.
 */
const pinnedFactRankingContributor: RankingContributor = {
  name: "pinned-fact-ranking",
  appliesTo(item) {
    return item.entry.type === "fact" && (item.entry.searchHints?.includes("pinned") ?? false);
  },
  adjust() {
    return 0.15;
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
  beliefStateRankingContributor,
  tagRankingContributor,
  searchHintRankingContributor,
  aliasRankingContributor,
  descriptionRankingContributor,
  metadataRankingContributor,
  graphRankingContributor,
  captureModeRankingContributor,
  lessonStrengthContributor,
  pinnedFactRankingContributor,
  projectContextRankingContributor,
];

/**
 * R2 — compose the improve loop's salience core into user-facing ranking.
 *
 * `asset_salience.rank_score` (encoding + outcome + retrieval projection,
 * maintained every improve run) previously drove only improve's INTERNAL
 * maintenance selection — the "better assets surface more" loop ran solely
 * through the utility EMA. This bounded multiplicative boost closes the outer
 * loop: usage/outcome-reinforced assets rank higher in `search`/`curate`.
 */
const salienceRankingContributor: UtilityRankingContributor = {
  name: "salience-ranking",
  appliesTo(item, ctx) {
    const rank = ctx.salienceRankScores?.get(item.id);
    return rank !== undefined && rank > 0;
  },
  apply(item, ctx) {
    const rank = ctx.salienceRankScores?.get(item.id) ?? 0;
    const rawBoost = 1 + Math.min(1, Math.max(0, rank)) * SALIENCE_WEIGHT;
    item.score *= Math.min(rawBoost, SALIENCE_MAX_BOOST);
  },
};

export const defaultUtilityRankingContributors: UtilityRankingContributor[] = [
  utilityRankingContributor,
  salienceRankingContributor,
];

/**
 * EVAL/DEBUG ONLY — remove named ranking contributors from a list.
 *
 * Driven by the `AKM_ABLATE_CONTRIBUTORS` env var (comma-separated contributor
 * `name`s). A no-op — returns the input list unchanged (same reference) — when
 * the env value is unset/empty, so production ranking is never affected unless
 * the operator opts in. Its sole purpose is per-contributor ablation for the
 * curate ablation harness (see `docs/technical/ranking-ablation-and-saturation-analysis.md`
 * and `scripts/akm-eval/`): run the same fixture with and without a contributor
 * and diff the ranked results to measure whether that contributor is load-bearing.
 *
 * NOTE (see the analysis doc): a contributor's ablation delta is only observable
 * in the UNSATURATED score regime — once entries saturate at the `displayScore`
 * ceiling their contributor deltas are absorbed and ablation reads Δ=0.
 */
export function applyContributorAblation<T extends { name: string }>(
  contributors: T[],
  ablateEnv: string | undefined,
): T[] {
  if (!ablateEnv) return contributors;
  const ablated = new Set(
    ablateEnv
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  if (ablated.size === 0) return contributors;
  return contributors.filter((c) => !ablated.has(c.name));
}

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
