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

import type { Database } from "bun:sqlite";
import fs from "node:fs";
import { buildActionFromContributors, defaultActionContributors } from "../core/action-contributors";
import { makeAssetRef } from "../core/asset-ref";
import { defaultRendererRegistry, type RendererRegistry } from "../core/asset-registry";
import type { AkmConfig } from "../core/config";
import { getDbPath } from "../core/paths";
import { warn } from "../core/warn";
import type { AkmSearchType, BeliefFilterMode, SearchHitSize, SourceSearchHit } from "../sources/types";
import {
  closeDatabase,
  getAllEntries,
  getEntryById,
  getEntryCount,
  getMeta,
  openExistingDatabase,
  sanitizeFtsQuery,
  searchFts,
  searchVec,
} from "./db";
import { ensureIndex } from "./ensure-index";
import {
  collectGraphRelatedHit,
  computeGraphBoost,
  type GraphBoostContext,
  loadGraphBoostContext,
} from "./graph-boost";
import { isProposedQuality, type StashEntry, type StashEntryScope } from "./metadata";
import { applyRankingRules, combineSearchScores, normalizeFtsScores } from "./ranking";
import { enrichSearchHit } from "./search-hit-enrichers";
import { buildEditHint, findSourceForPath, isEditable, type SearchSource } from "./search-source";
import {
  deriveSemanticProviderFingerprint,
  getEffectiveSemanticStatus,
  isSemanticRuntimeReady,
  readSemanticStatus,
} from "./semantic-status";

export function buildLocalAction(
  type: string,
  ref: string,
  registry: RendererRegistry = defaultRendererRegistry,
): string {
  return buildActionFromContributors({ type, ref }, defaultActionContributors(registry)) ?? `akm show ${ref}`;
}

function resolveSearchHitRef(entry: StashEntry, refName: string, source?: SearchSource): string {
  if (source?.wikiName) {
    return makeAssetRef(entry.type, entry.name);
  }
  return makeAssetRef(entry.type, refName, source?.registryId);
}

function resolveSearchHitOrigin(source?: SearchSource): string | null {
  return source?.wikiName ? null : (source?.registryId ?? null);
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
    } else {
      warnings.push(
        "Semantic search is pending verification. Run 'akm setup' or 'akm index --full' to enable semantic search.",
      );
    }
  }
  if (config.semanticSearchMode === "auto" && semanticStatus === "blocked") {
    warnings.push(
      "Semantic search is currently blocked. Using keyword search until the semantic backend is healthy again.",
    );
  }

  // Auto-index when stale so the DB is always current before querying.
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
): Promise<{
  hits: SourceSearchHit[];
  embedMs?: number;
  rankMs?: number;
}> {
  const hasSearchableTokens = query.length > 0 && sanitizeFtsQuery(query).length > 0;

  // Empty queries — including ones that sanitize down to no searchable FTS
  // tokens such as "." — should enumerate matching entries instead of
  // returning an empty result set from FTS.
  if (!hasSearchableTokens) {
    const typeFilter = searchType === "any" ? undefined : searchType;
    const allEntries = getAllEntries(db, typeFilter);
    // Deduplicate by file path — multiple entries can share the same file
    const seenFilePaths = new Set<string>();
    const uniqueEntries = allEntries.filter((ie) => {
      if (seenFilePaths.has(ie.filePath)) return false;
      seenFilePaths.add(ie.filePath);
      return true;
    });
    // Scope filter: drop entries whose stored scope does not satisfy every
    // supplied scope key. Filtering happens BEFORE the limit slice so a
    // restrictive filter still returns up to `limit` results.
    const scopeFiltered = filters
      ? uniqueEntries.filter((ie) => entryMatchesScope(ie.entry.scope, filters))
      : uniqueEntries;
    // Proposed-quality filter (v1 spec §4.2): exclude entries with
    // `quality: "proposed"` unless the caller explicitly opts in.
    const qualityFiltered = includeProposed
      ? scopeFiltered
      : scopeFiltered.filter((ie) => !isProposedQuality(ie.entry.quality));
    const beliefFiltered = qualityFiltered.filter((ie) =>
      matchBeliefFilter(ie.entry.type, ie.entry.beliefState, beliefFilter),
    );
    const selected = beliefFiltered.slice(0, limit);
    const hits = await Promise.all(
      selected.map((ie) =>
        buildDbHit({
          entry: ie.entry,
          path: ie.filePath,
          score: 1,
          query,
          rankingMode: "fts",
          defaultStashDir: stashDir,
          allSourceDirs,
          sources,
          config,
          rendererRegistry,
        }),
      ),
    );
    return { hits };
  }

  // Start the async embedding request without awaiting, then run FTS
  // synchronously while the HTTP/local embedding request is in-flight.
  const typeFilter = searchType === "any" ? undefined : searchType;
  const tEmbed0 = Date.now();
  const embeddingPromise = tryVecScores(db, query, limit * 3, config);
  const ftsResults = searchFts(db, query, limit * 3, typeFilter);
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

  applyRankingRules({ db, query, items: scored, graphContext });

  // ── minScore floor ──────────────────────────────────────────────────────
  // Drop semantic-only hits (cosine-only, no FTS match) whose score falls
  // below the configured floor. FTS hits and hybrid hits are always kept.
  // Default floor: 0.2. Set search.minScore = 0 in config to disable.
  const minScore = config.search?.minScore ?? 0.2;
  const preFilter =
    minScore > 0 ? scored.filter((item) => item.rankingMode !== "semantic" || item.score >= minScore) : scored;

  // Deterministic tiebreaker on equal scores
  preFilter.sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name));

  // Deduplicate by file path — keep only the highest-scored entry per file.
  // Multiple .stash.json entries can map to the same file (e.g. entries without
  // a filename field all collapse to files[0]). Showing the same path/ref
  // multiple times clutters results.
  const deduped = deduplicateByPath(preFilter);

  // Scope filter: drop hits whose stored scope does not satisfy every supplied
  // key. Applied AFTER ranking — filtering narrows the result set without
  // touching the single FTS5+boosts scoring pipeline.
  const scopeFiltered = filters ? deduped.filter((item) => entryMatchesScope(item.entry.scope, filters)) : deduped;

  // Proposed-quality filter (v1 spec §4.2): exclude entries with
  // `quality: "proposed"` unless the caller passed `--include-proposed`.
  // Applied AFTER ranking for the same reason as scope filtering.
  const qualityFiltered = includeProposed
    ? scopeFiltered
    : scopeFiltered.filter((item) => !isProposedQuality(item.entry.quality));
  const beliefFiltered = qualityFiltered.filter((item) =>
    matchBeliefFilter(item.entry.type, item.entry.beliefState, beliefFilter),
  );

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
      });
    }),
  );

  return { embedMs, rankMs, hits };
}

function matchBeliefFilter(type: string, beliefState: string | undefined, filter: BeliefFilterMode): boolean {
  if (filter === "all") return true;
  if (type !== "memory") return true;
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
    const { embed } = await import("../llm/embedder.js");
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
