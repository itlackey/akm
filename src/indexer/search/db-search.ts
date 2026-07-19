// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Database-backed (SQLite + FTS5/vector) source search implementation.
 *
 * Extracted from source-search.ts to break the circular import:
 *   source-search.ts → sources/providers/filesystem.ts → db-search.ts (no cycle)
 *
 * source-search.ts imports this module for the `searchLocal` export.
 * sources/providers/filesystem.ts also imports `searchLocal` from here.
 *
 * Renamed from `local-search.ts` to signal that this is the DB-layer search
 * implementation, not a "local vs. remote" distinction.
 */

import fs from "node:fs";
import { buildActionFromContributors, defaultActionContributors } from "../../core/action-contributors";
import { placementTypes } from "../../core/asset/asset-placement";
import { displayRef } from "../../core/asset/resolve-ref";
import type { AkmConfig, ImproveConfig } from "../../core/config/config";
import { getDbPath } from "../../core/paths";
import { defaultRendererRegistry, type RendererRegistry } from "../../core/type-presentation";
import { warn } from "../../core/warn";
import type { AkmSearchType, BeliefFilterMode, SearchHitSize, SourceSearchHit } from "../../sources/types";
import type { Database } from "../../storage/database";
import { closeDatabase, openExistingDatabase } from "../../storage/repositories/index-connection";
import {
  getAllEntries,
  getBaseBeliefStatesForDerivedTwins,
  getEntryById,
  getEntryCount,
  getPositiveFeedbackCountsByIds,
} from "../../storage/repositories/index-entries-repository";
import { searchFts } from "../../storage/repositories/index-fts-repository";
import { getMeta } from "../../storage/repositories/index-meta-repository";
import { searchVec } from "../../storage/repositories/index-vec-repository";
import { getCurrentWorkflowScopeKey } from "../../workflows/authoring/scope-key";
import { ensureIndex } from "../ensure-index";
import {
  collectGraphRelatedHit,
  computeGraphBoost,
  type GraphBoostContext,
  loadGraphBoostContext,
} from "../graph/graph-boost";
import { isProposedQuality, type StashEntry, type StashEntryScope } from "../passes/metadata";
import { resolveProjectContext } from "../walk/project-context";
import { parseRefPrefixQuery, sanitizeFtsQuery } from "./fts-query";
import { applyRankingRules, combineSearchScores, normalizeFtsScores } from "./ranking";
import { enrichSearchHit } from "./search-hit-enrichers";
import { buildEditHint, findSourceForPath, isEditable, type SearchSource } from "./search-source";
import {
  deriveSemanticProviderFingerprint,
  getEffectiveSemanticStatus,
  isSemanticRuntimeReady,
  readSemanticStatus,
} from "./semantic-status";

/**
 * Age past which search surfaces a "run akm index" hint. Reads serve the
 * existing index as-is (freshness is the writers' job — `indexWrittenAssets`
 * plus full runs), so on installs with no improve cron a hand-edited or
 * git-pulled file stays invisible until someone reindexes. The hint makes that
 * actionable without re-introducing read-triggered reindexing.
 */
const STALE_INDEX_HINT_MS = 7 * 24 * 60 * 60 * 1000;

function buildStaleIndexHint(db: Database): string | undefined {
  try {
    const builtAt = getMeta(db, "builtAt");
    if (!builtAt) return undefined;
    const ageMs = Date.now() - new Date(builtAt).getTime();
    if (!Number.isFinite(ageMs) || ageMs < STALE_INDEX_HINT_MS) return undefined;
    const days = Math.floor(ageMs / (24 * 60 * 60 * 1000));
    return `Search index was last built ${days} day(s) ago. Files added or edited outside akm since then are not searchable — run 'akm index' to refresh.`;
  } catch {
    return undefined;
  }
}

export function buildLocalAction(
  type: string,
  ref: string,
  registry: RendererRegistry = defaultRendererRegistry,
): string {
  return buildActionFromContributors({ type, ref }, defaultActionContributors(registry)) ?? `akm show ${ref}`;
}

function resolveSearchHitRef(entry: StashEntry, refName: string, source?: SearchSource): string {
  // F4b output-spelling flip: emit the 0.9.0 conceptId grammar for the hit's
  // user-facing ref (short conceptId in the primary bundle, `bundle//conceptId`
  // for a slug-clean non-default source). `displayRef` prefers the row's stored
  // conceptId and derives `stashDir/name` (== the old makeAssetRef body) when it
  // is absent, so this is a pure ref-spelling change over the old output.
  return displayRef({
    type: entry.type,
    name: refName,
    conceptId: entry.conceptId,
    bundleId: source?.registryId ?? undefined,
  });
}

function resolveSearchHitOrigin(source?: SearchSource): string | null {
  return source?.registryId ?? null;
}

/**
 * Phase 2A / Rec 5: gate for the per-search `getPositiveFeedbackCountsByIds`
 * lookup. Returns `true` only when the user has explicitly opted into
 * `improve.utilityDecay` AND configured a `feedbackStabilityBoost > 1.0`.
 * Either condition being false makes the DB query pure overhead (the ranking
 * contributor ignores `positiveFeedbackCounts` when `utilityDecayConfig` is
 * absent, and `1.0^count == 1` collapses the boost into a no-op).
 *
 * Exported for unit testing — keeps the gate decision pinned so a future edit
 * can't quietly broaden the hot path.
 */
export function shouldQueryPositiveFeedbackCounts(utilityDecayRaw: ImproveConfig["utilityDecay"]): boolean {
  if (utilityDecayRaw === undefined) return false;
  const boost = utilityDecayRaw.feedbackStabilityBoost ?? 1.5;
  return boost > 1.0;
}

// ── Main search entrypoint ───────────────────────────────────────────────────

export async function searchLocal(input: {
  query: string;
  searchType: AkmSearchType;
  limit: number;
  stashDir: string;
  sources: SearchSource[];
  config: AkmConfig;
  /** Optional renderer registry override for test isolation. */
  rendererRegistry?: RendererRegistry;
  /**
   * Optional scope filter (`user`, `agent`, `run`, `channel`). When present,
   * hits whose `entry.scope` does not satisfy every supplied key are dropped
   * AFTER ranking — filtering narrows the result set, it does not alter the
   * single FTS5+boosts scoring pipeline.
   */
  filters?: StashEntryScope;
  /**
   * When true, entries with `quality === "proposed"` are kept in the result
   * set. By default (false) they are filtered out post-ranking per v1
   * spec §4.2. Filtering happens AFTER scoring — there is still one
   * scoring pipeline.
   */
  includeProposed?: boolean;
  beliefFilter?: BeliefFilterMode;
  /**
   * When true, hits are restricted to entries whose file path lives under one of
   * the provided `sources`. Set by callers that narrowed `sources` via a
   * `--source <name>` filter so the FTS index (which spans all sources) does
   * not leak hits from sources the caller did not request. Default false
   * preserves prior behavior for the unnamed default search path.
   */
  restrictToSources?: boolean;
  /**
   * #627 — when true, re-include the asset types normally hidden from the
   * default (untyped) path via `config.search.defaultExcludeTypes` (notably
   * `session`). No effect when an explicit `--type` is supplied.
   */
  includeExcludedTypes?: boolean;
  /** Disable project-context ranking for this invocation only. */
  disableProjectContext?: boolean;
  /** Disable scoped-utility ranking for this invocation only. */
  disableScopedUtility?: boolean;
}): Promise<{
  hits: SourceSearchHit[];
  tip?: string;
  warnings?: string[];
  embedMs?: number;
  rankMs?: number;
  /** Whether embedding-based ranking was used (`'semantic'`) or keyword-only (`'keyword'`). */
  mode: "semantic" | "keyword";
}> {
  const { query, searchType, limit, stashDir, sources, config } = input;
  const filters = input.filters;
  const includeProposed = input.includeProposed === true;
  const beliefFilter = input.beliefFilter ?? "all";
  const restrictToSources = input.restrictToSources === true;
  const includeExcludedTypes = input.includeExcludedTypes === true;
  const disableProjectContext = input.disableProjectContext === true;
  const disableScopedUtility = input.disableScopedUtility === true;
  const rendererRegistry = input.rendererRegistry ?? defaultRendererRegistry;
  const allSourceDirs = sources.map((s) => s.path);
  const rawStatus = readSemanticStatus();
  const semanticStatus = getEffectiveSemanticStatus(config, rawStatus);
  const warnings: string[] = [];
  if (config.semanticSearchMode === "auto" && semanticStatus === "pending") {
    const currentFingerprint = deriveSemanticProviderFingerprint(config.embedding);
    if (rawStatus && rawStatus.providerFingerprint !== currentFingerprint) {
      warnings.push(
        "Embedding config changed. Run 'akm index --full' to rebuild the semantic index with the new provider.",
      );
    } else if (!config.embedding?.endpoint || !config.embedding?.model) {
      // #480: when semantic mode is `auto` but no embedding provider is
      // configured (e.g. `akm setup --yes` ran without picking one), telling
      // the user to "run akm setup" is misleading — they just did. Surface
      // the actual remediation: configure an embedding endpoint OR switch
      // semanticSearchMode to `off` to silence the warning.
      warnings.push(
        "Semantic search is enabled (semanticSearchMode='auto') but no embedding provider is configured. " +
          'Either: (a) `akm config set embedding \'{"endpoint":"...","model":"..."}\'`, or ' +
          "(b) `akm config set semanticSearchMode off` to use keyword-only search.",
      );
    } else {
      warnings.push(
        "Semantic search is pending verification. Run 'akm index --full' to build the semantic index now, or wait for the next background index pass.",
      );
    }
  }
  if (config.semanticSearchMode === "auto" && semanticStatus === "blocked") {
    warnings.push(
      "Semantic search is currently blocked. Using keyword search until the semantic backend is healthy again.",
    );
  }

  // Bootstrap-only: builds the index inline when it cannot serve this stash.
  // Content freshness is the writers' job (indexWrittenAssets + full runs);
  // reads serve the existing index as-is.
  await ensureIndex(stashDir);

  const dbPath = getDbPath();
  if (!fs.existsSync(dbPath)) {
    return {
      hits: [],
      tip: "No search index available. Run 'akm index' to build one.",
      warnings: warnings.length > 0 ? warnings : undefined,
      mode: "keyword",
    };
  }

  const db = openExistingDatabase(dbPath);
  try {
    const entryCount = getEntryCount(db);
    if (entryCount === 0) {
      return {
        hits: [],
        tip: "Index is empty. Run 'akm index' to populate it.",
        warnings: warnings.length > 0 ? warnings : undefined,
        mode: "keyword",
      };
    }

    const staleHint = buildStaleIndexHint(db);
    if (staleHint) warnings.push(staleHint);

    const { hits, embedMs, rankMs } = await searchDatabase(
      db,
      query,
      searchType,
      limit,
      stashDir,
      allSourceDirs,
      config,
      sources,
      rendererRegistry,
      filters,
      includeProposed,
      beliefFilter,
      restrictToSources,
      includeExcludedTypes,
      disableProjectContext,
      disableScopedUtility,
    );
    return {
      hits,
      tip:
        hits.length === 0
          ? "No matching stash assets were found. Try a different query or run 'akm index' to rebuild."
          : undefined,
      warnings: warnings.length > 0 ? warnings : undefined,
      embedMs,
      rankMs,
      mode: embedMs !== undefined && embedMs > 0 ? "semantic" : "keyword",
    };
  } finally {
    closeDatabase(db);
  }
}

// ── Database search ─────────────────────────────────────────────────────────

async function searchDatabase(
  db: Database,
  query: string,
  searchType: AkmSearchType,
  limit: number,
  stashDir: string,
  allSourceDirs: string[],
  config: AkmConfig,
  sources: SearchSource[],
  rendererRegistry: RendererRegistry = defaultRendererRegistry,
  filters?: StashEntryScope,
  includeProposed = false,
  beliefFilter: BeliefFilterMode = "all",
  restrictToSources = false,
  includeExcludedTypes = false,
  disableProjectContext = false,
  disableScopedUtility = false,
): Promise<{
  hits: SourceSearchHit[];
  embedMs?: number;
  rankMs?: number;
}> {
  const hasSearchableTokens = query.length > 0 && sanitizeFtsQuery(query).length > 0;

  // #627 — resolve the default type-exclusion policy. It applies ONLY on the
  // untyped ('any') path and only when the caller did not opt back in via
  // `includeExcludedTypes`. When the config key is ABSENT a built-in default of
  // ['session'] is applied; an explicit empty list disables exclusion.
  const defaultExcludes =
    searchType === "any" && !includeExcludedTypes ? (config.search?.defaultExcludeTypes ?? ["session"]) : [];

  // SPEC-4 — ref-prefix queries (`<type>:` / `<type>:<prefix>/`) translate to
  // a typed enumeration narrowed by name prefix, instead of degenerating into
  // the AND-token FTS query their sanitized form would produce ("memory
  // projecta" — noise). The branch fires only on the untyped path: an explicit
  // `--type` flag expresses stronger intent and wins. The PARSED type is
  // itself explicit intent, so `defaultExcludeTypes` does not apply — a bare
  // `session:` enumerates sessions exactly like `--type session` does.
  const refPrefix = searchType === "any" ? parseRefPrefixQuery(query, placementTypes()) : null;
  if (refPrefix) {
    return enumerateEntries({
      db,
      query,
      typeFilter: refPrefix.type,
      excludeTypes: [],
      namePrefix: refPrefix.namePrefix,
      limit,
      stashDir,
      allSourceDirs,
      sources,
      config,
      rendererRegistry,
      filters,
      includeProposed,
      beliefFilter,
      restrictToSources,
    });
  }

  // Empty queries — including ones that sanitize down to no searchable FTS
  // tokens such as "." — should enumerate matching entries instead of
  // returning an empty result set from FTS.
  if (!hasSearchableTokens) {
    return enumerateEntries({
      db,
      query,
      typeFilter: searchType === "any" ? undefined : searchType,
      excludeTypes: defaultExcludes,
      limit,
      stashDir,
      allSourceDirs,
      sources,
      config,
      rendererRegistry,
      filters,
      includeProposed,
      beliefFilter,
      restrictToSources,
    });
  }

  // Start the async embedding request without awaiting, then run FTS
  // synchronously while the HTTP/local embedding request is in-flight.
  const typeFilter = searchType === "any" ? undefined : searchType;
  const tEmbed0 = Date.now();
  const embeddingPromise = tryVecScores(db, query, limit * 3, config);
  const ftsResults = searchFts(db, query, limit * 3, typeFilter, defaultExcludes);
  const embeddingScores = await embeddingPromise;
  const embedMs = Date.now() - tEmbed0;

  const tRank0 = Date.now();

  // ── Score normalization ──────────────────────────────────────────────
  // Normalized BM25 + cosine similarity with weighted addition
  // (FTS 0.7, vector 0.3) for well-differentiated combined scores.
  const ftsScoreMap = normalizeFtsScores(ftsResults);

  // Build embedding score map (cosine similarities already 0-1)
  const embedScoreMap = new Map<number, number>();
  if (embeddingScores) {
    for (const [id, cosine] of embeddingScores) {
      embedScoreMap.set(id, cosine);
    }
  }

  // ── Combine FTS + vector scores ──────────────────────────────────────
  const scored = combineSearchScores({
    ftsScoreMap,
    embedScoreMap,
    getEntryById: (id) => getEntryById(db, id) ?? undefined,
    typeFilter,
    // #627 — also exclude default-hidden types from the vector-only branch so a
    // session asset that is a top-k vector neighbor (but not an FTS match) does
    // not leak into default ('any') results. defaultExcludes is already []
    // unless this is the untyped path without includeExcludedTypes.
    excludeTypes: defaultExcludes,
  });

  // ── Scoring Phase ──────────────────────────────────────────────────────
  // Apply boosts as multiplicative factors (all boosts in a single phase
  // so that sort order and displayed scores are always consistent).
  //
  // Ranking philosophy: the goal is to surface the MOST USEFUL result for the
  // user's intent. An exact name match is the strongest signal. Actionable
  // asset types (skills, commands, agents) are more useful than passive
  // reference docs. Curated metadata is more reliable than auto-generated.
  // Graph boost context (#207). Built once per query and reused across
  // every scored entry so the disk read + JSON parse only happens once
  // per search invocation. `null` when no graph file is present, when
  // the schema doesn't match, or when no query token matches a graph
  // entity — in all of those cases the per-entry call is skipped and
  // graph contributes nothing. The graph signal feeds this single
  // FTS5+boosts loop as ONE additive component (CLAUDE.md / spec §6:
  // one scoring pipeline, no parallel SearchHit scorer).
  const graphContext: GraphBoostContext | null = (() => {
    // Search across all source dirs; the graph file lives next to the
    // primary source root. Cache misses are silent — the helper handles
    // missing files internally and returns `null` instead of throwing.
    if (allSourceDirs.length === 0) return null;
    return loadGraphBoostContext(allSourceDirs, query, config, db);
  })();

  // Resolve project-context tokens from the current working directory once
  // per search invocation. Returns null when running from home dir / /tmp,
  // or when the caller has set AKM_DISABLE_PROJECT_CONTEXT=1.
  const projectContext = disableProjectContext ? null : resolveProjectContext(process.cwd());

  // Phase 2A / Rec 5: resolve forgetting-curve config and skip the feedback
  // count query when the boost cannot make a difference (default ≤ 1.0 means
  // boost^count == 1 — zero overhead for the common case).
  const utilityDecayRaw = config.improve?.utilityDecay;
  const halfLifeDays = utilityDecayRaw?.halfLifeDays ?? 30;
  const feedbackStabilityBoost = utilityDecayRaw?.feedbackStabilityBoost ?? 1.5;
  const utilityDecayConfig = utilityDecayRaw !== undefined ? { halfLifeDays, feedbackStabilityBoost } : undefined;
  // Gate the feedback-count query on the user having explicitly opted into
  // utilityDecay. Without an opt-in, `utilityDecayConfig` is undefined and the
  // ranking contributor ignores `positiveFeedbackCounts` — so running the DB
  // query here would be pure overhead. The boost > 1.0 sub-gate then skips the
  // query when the configured boost is a no-op (1.5^count when boost==1 is 1).
  const positiveFeedbackCounts = shouldQueryPositiveFeedbackCounts(utilityDecayRaw)
    ? getPositiveFeedbackCountsByIds(
        db,
        scored.map((item) => item.id),
      )
    : undefined;

  // Resolve per-project scope key for scoped utility scoring.
  // AKM_DISABLE_SCOPED_UTILITY=1 opts out (e.g. for registry searches or tests).
  let scopeKey: string | undefined;
  try {
    scopeKey = disableScopedUtility ? undefined : getCurrentWorkflowScopeKey();
  } catch {
    // Non-fatal — ranking proceeds without scoped utility on any error.
  }

  // 03-R3: derived twins inherit their base's demoting belief state before
  // ranking, so the (03) belief-state ranker demotes a stale flag-free twin.
  inheritDerivedTwinBeliefStates(db, scored);

  applyRankingRules({
    db,
    query,
    items: scored,
    graphContext,
    projectContext,
    utilityDecayConfig,
    positiveFeedbackCounts,
    scopeKey,
  });

  // ── minScore floor ──────────────────────────────────────────────────────
  // Drop semantic-only hits (cosine-only, no FTS match) whose score falls
  // below the configured floor. FTS hits and hybrid hits are always kept.
  // Default floor: 0.2. Set search.minScore = 0 in config to disable.
  // Judged on the PRE-ceiling score when a demoting belief state clamped the
  // item (`preCeilingScore`): the belief ceilings can sit below this floor
  // (archived 0.15 < 0.2), and a demotion must rank the hit last, not
  // silently remove a result that would otherwise have listed.
  const minScore = config.search?.minScore ?? 0.2;
  const preFilter =
    minScore > 0
      ? scored.filter((item) => item.rankingMode !== "semantic" || (item.preCeilingScore ?? item.score) >= minScore)
      : scored;

  // Deterministic tiebreaker on equal scores.
  //
  // CRITICAL: sort on the SAME clamped+rounded value the user sees (see the
  // `finalScore`/round-to-4dp logic below at buildDbHit), NOT the raw pre-clamp
  // `item.score`. The boost loop can push scores above 1.0 (utility, graph,
  // project boosts) and carries ~15 significant digits. Two entries that DISPLAY
  // an identical score (e.g. both clamp to 1.0000) can still differ in their raw
  // pre-clamp score by a timing-dependent epsilon — utility recency uses
  // `Date.now()` and `last_used_at`, so the same query run twice in one process
  // can yield raw scores that diverge at the 6th decimal. Sorting on the raw
  // value lets that invisible epsilon decide the order, so the visible name
  // tiebreaker never engages and the order flips run-to-run (Issue #14). Quantize
  // to the display value first; only then does `localeCompare` break true ties.
  const displayScore = (s: number): number => Math.round(Math.min(1, Math.max(0, s)) * 10000) / 10000;
  preFilter.sort((a, b) => displayScore(b.score) - displayScore(a.score) || a.entry.name.localeCompare(b.entry.name));

  // Deduplicate by file path — keep only the highest-scored entry per file.
  // Multiple .stash.json entries can map to the same file (e.g. entries without
  // a filename field all collapse to files[0]). Showing the same path/ref
  // multiple times clutters results.
  const deduped = deduplicateByPath(preFilter);

  // Source filter: when the caller narrowed `sources` via `--source <name>`,
  // drop hits whose filePath does not live under any of the requested
  // sources. The FTS/vector index spans every configured source, so without
  // this filter a narrowed --source request would still leak results from
  // other sources that happened to match the query text.
  const sourceFiltered = restrictToSources
    ? deduped.filter((item) => findSourceForPath(item.filePath, sources) !== undefined)
    : deduped;

  // Scope filter: drop hits whose stored scope does not satisfy every supplied
  // key. Applied AFTER ranking — filtering narrows the result set without
  // touching the single FTS5+boosts scoring pipeline.
  const scopeFiltered = filters
    ? sourceFiltered.filter((item) => entryMatchesScope(item.entry.scope, filters))
    : sourceFiltered;

  // Proposed-quality filter (v1 spec §4.2): exclude entries with
  // `quality: "proposed"` unless the caller passed `--include-proposed`.
  // Applied AFTER ranking for the same reason as scope filtering.
  const qualityFiltered = includeProposed
    ? scopeFiltered
    : scopeFiltered.filter((item) => !isProposedQuality(item.entry.quality));
  const beliefFiltered = qualityFiltered.filter((item) => matchBeliefFilter(item.entry.beliefState, beliefFilter));

  const rankMs = Date.now() - tRank0;

  const selected = beliefFiltered.slice(0, limit);
  const hits = await Promise.all(
    selected.map(({ entry, filePath, score, rankingMode, utilityBoosted }) => {
      // CLAUDE.md locks SearchHit.score in [0,1]. The boost loop above can
      // exceed 1.0 (this was a pre-existing breach that #207's graph boost
      // — up to ~1.05 additive contribution — made detectable); clamp here
      // so the score handed to buildDbHit always satisfies the spec.
      const finalScore = Math.min(1, Math.max(0, score));
      return buildDbHit({
        entry,
        path: filePath,
        // Round to 4 decimal places
        score: Math.round(finalScore * 10000) / 10000,
        query,
        rankingMode,
        defaultStashDir: stashDir,
        allSourceDirs,
        sources,
        config,
        utilityBoosted,
        graphContext,
        rendererRegistry,
        db,
      });
    }),
  );

  return { embedMs, rankMs, hits };
}

// ── Enumeration (browse) path ────────────────────────────────────────────────

/**
 * Enumerate index entries without FTS scoring — the browse path shared by
 * empty/unsearchable queries and SPEC-4 ref-prefix queries (`<type>:` /
 * `<type>:<prefix>/`). Applies the same post-ranking filters as the scored
 * path (source narrowing, scope, proposed-quality, belief) before the limit
 * slice. Hits carry the fixed browse score 1 in insertion order — this is a
 * deterministic listing, not a relevance ranking.
 */
async function enumerateEntries(opts: {
  db: Database;
  query: string;
  /** Restrict enumeration to a single asset type; undefined enumerates all. */
  typeFilter?: string;
  /** Types hidden from untyped enumeration (config `defaultExcludeTypes`). */
  excludeTypes: string[];
  /**
   * SPEC-4 name-prefix narrowing (e.g. `"projecta/"`, trailing slash retained
   * for exact `/`-boundary subtree semantics). Compared case-insensitively:
   * the command layer lowercases queries while on-disk directory names — and
   * therefore entry names — may carry mixed case. Empty/undefined keeps every
   * entry of the type.
   */
  namePrefix?: string;
  limit: number;
  stashDir: string;
  allSourceDirs: string[];
  sources: SearchSource[];
  config: AkmConfig;
  rendererRegistry: RendererRegistry;
  filters?: StashEntryScope;
  includeProposed: boolean;
  beliefFilter: BeliefFilterMode;
  restrictToSources: boolean;
}): Promise<{ hits: SourceSearchHit[] }> {
  const { db, query, sources, config, rendererRegistry, filters, beliefFilter } = opts;
  const allEntries = getAllEntries(db, opts.typeFilter, opts.excludeTypes);
  // SPEC-4: narrow to the requested subtree. `startsWith` on the full
  // slash-retaining prefix is exact — "projecta/" cannot match a sibling
  // "projectalpha/…" scope.
  const namePrefix = opts.namePrefix?.toLowerCase() ?? "";
  const prefixFiltered =
    namePrefix.length > 0 ? allEntries.filter((ie) => ie.entry.name.toLowerCase().startsWith(namePrefix)) : allEntries;
  // Deduplicate by file path — multiple entries can share the same file
  const seenFilePaths = new Set<string>();
  const uniqueEntries = prefixFiltered.filter((ie) => {
    if (seenFilePaths.has(ie.filePath)) return false;
    seenFilePaths.add(ie.filePath);
    return true;
  });
  // Source filter: when the caller narrowed `sources` via `--source <name>`,
  // drop entries whose filePath does not live under any of the requested
  // sources. The FTS index spans every configured source, so without this
  // filter a narrowed --source request would still leak results.
  const sourceFiltered = opts.restrictToSources
    ? uniqueEntries.filter((ie) => findSourceForPath(ie.filePath, sources) !== undefined)
    : uniqueEntries;
  // Scope filter: drop entries whose stored scope does not satisfy every
  // supplied scope key. Filtering happens BEFORE the limit slice so a
  // restrictive filter still returns up to `limit` results.
  const scopeFiltered = filters
    ? sourceFiltered.filter((ie) => entryMatchesScope(ie.entry.scope, filters))
    : sourceFiltered;
  // Proposed-quality filter (v1 spec §4.2): exclude entries with
  // `quality: "proposed"` unless the caller explicitly opts in.
  const qualityFiltered = opts.includeProposed
    ? scopeFiltered
    : scopeFiltered.filter((ie) => !isProposedQuality(ie.entry.quality));
  // 03-R3: derived twins inherit their base's demoting belief state here too,
  // so the belief FILTER (and the reported hit state) stays consistent on the
  // enumerate/browse path — not only on the FTS-scored path.
  inheritDerivedTwinBeliefStates(db, qualityFiltered);
  const beliefFiltered = qualityFiltered.filter((ie) => matchBeliefFilter(ie.entry.beliefState, beliefFilter));
  const selected = beliefFiltered.slice(0, opts.limit);
  const hits = await Promise.all(
    selected.map((ie) =>
      buildDbHit({
        entry: ie.entry,
        path: ie.filePath,
        score: 1,
        query,
        rankingMode: "fts",
        defaultStashDir: opts.stashDir,
        allSourceDirs: opts.allSourceDirs,
        sources,
        config,
        rendererRegistry,
        db,
      }),
    ),
  );
  return { hits };
}

/**
 * 03-R3: let each `.derived` twin inherit its base memory's demoting belief
 * state for this ranking pass, so a stale flag-free twin is demoted like its
 * corrected base. The base carries the flag (a contradicted base takes a real
 * ranking penalty); its near-duplicate `.derived` twin carries none and would
 * otherwise outrank the corrected copy. Done in-memory at search time — NOT by
 * writing the twin's frontmatter — because the SCC belief resolver refreshes any
 * non-frozen state written to a derived memory back to `active` on the next
 * improve run, erasing it. Only twins with no state of their own inherit; an
 * explicit twin state always wins. Reuses the (03) belief-state ranker + filter.
 */
function inheritDerivedTwinBeliefStates(db: Database, items: Array<{ id: number; entry: StashEntry }>): void {
  const DEMOTING = new Set(["contradicted", "superseded", "deprecated", "archived"]);
  const twins = items.filter(
    (it) =>
      it.entry.type === "memory" &&
      it.entry.beliefState === undefined &&
      it.entry.name.toLowerCase().endsWith(".derived"),
  );
  if (twins.length === 0) return;
  const baseBeliefByTwinId = getBaseBeliefStatesForDerivedTwins(
    db,
    twins.map((t) => t.id),
  );
  for (const t of twins) {
    const baseBelief = baseBeliefByTwinId.get(t.id);
    // Only inherit DEMOTIONS — never let a base's active/asserted state lift a twin.
    if (baseBelief && DEMOTING.has(baseBelief)) {
      t.entry.beliefState = baseBelief as StashEntry["beliefState"];
    }
  }
}

function matchBeliefFilter(beliefState: string | undefined, filter: BeliefFilterMode): boolean {
  if (filter === "all") return true;
  // 03: the belief filter applies to ANY flagged entry, not just memories, so
  // `current`/`historical` filters catch contradicted/superseded KNOWLEDGE too.
  // Unflagged entries (beliefState === undefined) still pass the `current` filter.
  if (filter === "current") {
    // Phase 1A: `asserted` is a "current" state (stronger authority than `active`);
    // `deprecated` is excluded from current results.
    return beliefState === undefined || beliefState === "active" || beliefState === "asserted";
  }
  // historical
  return (
    beliefState === "contradicted" ||
    beliefState === "superseded" ||
    beliefState === "deprecated" ||
    beliefState === "archived"
  );
}

// ── Vector scorer ───────────────────────────────────────────────────────────

async function tryVecScores(
  db: Database,
  query: string,
  k: number,
  config: AkmConfig,
): Promise<Map<number, number> | null> {
  const semanticStatus = getEffectiveSemanticStatus(config, readSemanticStatus());
  if (!isSemanticRuntimeReady(semanticStatus)) return null;
  const hasEmbeddings = getMeta(db, "hasEmbeddings");
  if (hasEmbeddings !== "1") return null;

  try {
    const { embed } = await import("../../llm/embedder.js");
    const queryEmbedding = await embed(query, config.embedding);
    const vecResults = searchVec(db, queryEmbedding, k);

    const scores = new Map<number, number>();
    for (const { id, distance } of vecResults) {
      // Convert L2 distance to cosine similarity (vectors are normalized).
      // Guard against NaN/Infinity from sqlite-vec edge cases.
      const raw = 1 - (distance * distance) / 2;
      scores.set(id, Number.isFinite(raw) ? Math.max(0, raw) : 0);
    }
    return scores;
  } catch (error) {
    warn("Vector search failed, skipping:", error instanceof Error ? error.message : String(error));
    return null;
  }
}

// ── Hit building ────────────────────────────────────────────────────────────

export async function buildDbHit(input: {
  entry: StashEntry;
  path: string;
  score: number;
  query: string;
  rankingMode: "hybrid" | "semantic" | "fts";
  defaultStashDir: string;
  allSourceDirs: string[];
  sources: SearchSource[];
  config?: AkmConfig;
  utilityBoosted?: boolean;
  graphContext?: GraphBoostContext | null;
  /** Optional renderer registry override for test isolation. */
  rendererRegistry?: RendererRegistry;
  /**
   * Phase 5A / Advantage D5: open DB connection threaded into the search-hit
   * enricher pipeline so the derived-memory enricher can resolve parent→child
   * via the `entries.derived_from` index. Absent for unit tests / call sites
   * that build hits without a DB — the enricher then becomes a no-op.
   */
  db?: Database;
}): Promise<SourceSearchHit> {
  const rendererRegistry = input.rendererRegistry ?? defaultRendererRegistry;
  const entryStashDir = findSourceForPath(input.path, input.sources)?.path ?? input.defaultStashDir;

  // Quality and confidence boosts are now applied in the main scoring
  // phase (searchDatabase). buildDbHit receives the already-final score and
  // passes it through without further multiplication. We still compute the
  // boost values here for buildWhyMatched reporting.
  // Mirrors the boost computation in `searchDatabase`; only `curated`
  // contributes a positive boost. Used for `whyMatched` reporting only.
  const qualityBoost = input.entry.quality === "curated" ? 0.05 : 0;
  const confidenceBoost =
    typeof input.entry.confidence === "number" ? Math.min(0.05, Math.max(0, input.entry.confidence) * 0.05) : 0;
  // Round to 4 decimal places, no boost multiplication
  const score = Math.round(input.score * 10000) / 10000;

  const graphBoost = input.graphContext ? computeGraphBoost(input.graphContext, input.path) : 0;

  const whyMatched = buildWhyMatched(
    input.entry,
    input.query,
    input.rankingMode,
    qualityBoost,
    confidenceBoost,
    input.utilityBoosted,
    graphBoost,
  );

  const graphHit = input.graphContext ? collectGraphRelatedHit(input.graphContext, input.path) : null;

  const source = findSourceForPath(input.path, input.sources);
  const ref = resolveSearchHitRef(input.entry, input.entry.name, source);

  const editable = isEditable(input.path, input.config);
  const estimatedTokens = typeof input.entry.fileSize === "number" ? Math.round(input.entry.fileSize / 4) : undefined;

  const hit: SourceSearchHit = {
    type: input.entry.type,
    name: input.entry.name,
    path: input.path,
    ref,
    origin: resolveSearchHitOrigin(source),
    editable,
    ...(!editable
      ? { editHint: buildEditHint(input.path, input.entry.type, input.entry.name, source?.registryId) }
      : {}),
    description: input.entry.description,
    tags: input.entry.tags,
    size: deriveSize(input.entry.fileSize),
    action: buildLocalAction(input.entry.type, ref, rendererRegistry),
    score,
    whyMatched,
    ...(estimatedTokens !== undefined ? { estimatedTokens } : {}),
    // Surface optional quality (v1 spec §4.2). Omitted when entry has
    // no `quality` field so payloads stay compact for the common case.
    ...(input.entry.quality ? { quality: input.entry.quality } : {}),
    ...(input.entry.beliefState ? { beliefState: input.entry.beliefState } : {}),
    ...(input.entry.currentBeliefRefs ? { currentBeliefRefs: input.entry.currentBeliefRefs } : {}),
    ...(graphHit ? { graph: { entities: graphHit.entities, relations: graphHit.relations } } : {}),
  };

  await enrichSearchHit(hit, {
    type: input.entry.type,
    stashDir: entryStashDir,
    rendererRegistry,
    db: input.db,
  });

  return hit;
}

export function buildWhyMatched(
  entry: StashEntry,
  query: string,
  // "hybrid" ranking mode
  rankingMode: "hybrid" | "semantic" | "fts",
  qualityBoost: number,
  confidenceBoost: number,
  utilityBoosted?: boolean,
  graphBoost?: number,
): string[] {
  const reasons: string[] = [
    rankingMode === "hybrid"
      ? "hybrid (fts + semantic)"
      : rankingMode === "semantic"
        ? "semantic similarity"
        : "fts bm25 relevance",
  ];
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);

  const queryLower = query.toLowerCase().trim();
  const name = entry.name.toLowerCase();
  const nameBase = name.split("/").pop() ?? name;
  const tags = entry.tags?.join(" ").toLowerCase() ?? "";
  const searchHints = entry.searchHints?.join(" ").toLowerCase() ?? "";
  const aliases = entry.aliases?.join(" ").toLowerCase() ?? "";
  const desc = entry.description?.toLowerCase() ?? "";

  // Name match quality
  if (nameBase === queryLower || name === queryLower) {
    reasons.push("exact name match");
  } else if (nameBase.includes(queryLower) || queryLower.includes(nameBase)) {
    reasons.push("near-exact name match");
  } else if (tokens.some((t) => nameBase.includes(t))) {
    reasons.push("matched name tokens");
  }

  // Type relevance
  if (entry.type === "skill" || entry.type === "command" || entry.type === "agent") {
    reasons.push(`${entry.type} type boost`);
  }

  if (tokens.some((t) => tags.includes(t))) reasons.push("matched tags");
  if (tokens.some((t) => searchHints.includes(t))) reasons.push("matched searchHints");
  if (tokens.some((t) => aliases.includes(t))) reasons.push("matched aliases");
  if (tokens.some((t) => desc.includes(t))) reasons.push("matched description");
  if (qualityBoost > 0) reasons.push("curated metadata boost");
  if (confidenceBoost > 0) reasons.push("metadata confidence boost");
  if (entry.beliefState === "active") reasons.push("active belief state");
  if (entry.beliefState === "asserted") reasons.push("asserted belief state");
  if (entry.beliefState === "contradicted") reasons.push("contradicted belief state");
  if (entry.beliefState === "superseded") reasons.push("superseded belief state");
  if (entry.beliefState === "deprecated") reasons.push("deprecated belief state");
  if (entry.beliefState === "archived") reasons.push("archived belief state");
  if (utilityBoosted) reasons.push("usage history boost");
  if (typeof graphBoost === "number" && graphBoost > 0) {
    reasons.push(`graph boost +${graphBoost.toFixed(2)}`);
  }

  return reasons;
}

// ── Utilities ────────────────────────────────────────────────────────────────

export function deriveSize(bytes?: number): SearchHitSize | undefined {
  if (bytes === undefined) return undefined;
  if (bytes < 1024) return "small";
  if (bytes < 10240) return "medium";
  return "large";
}

/**
 * Deduplicate scored results by file path, keeping only the highest-scored
 * entry per unique path. Sorts by score descending internally to ensure the
 * precondition is always met regardless of caller.
 */
function deduplicateByPath<T extends { filePath: string; score?: number }>(items: T[]): T[] {
  const sorted = [...items].sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.filePath.localeCompare(b.filePath));
  const seen = new Set<string>();
  return sorted.filter((item) => {
    if (seen.has(item.filePath)) return false;
    seen.add(item.filePath);
    return true;
  });
}

/**
 * Exact-match scope filter check. Legacy entries without a `scope` object only
 * match when no filter is supplied — which is what the caller guards on
 * before invoking this helper.
 */
function entryMatchesScope(scope: StashEntryScope | undefined, filters: StashEntryScope): boolean {
  for (const key of ["user", "agent", "run", "channel"] as const) {
    const expected = filters[key];
    if (expected === undefined) continue;
    if (!scope || scope[key] !== expected) return false;
  }
  return true;
}
