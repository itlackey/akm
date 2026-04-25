/**
 * Database-backed (SQLite + FTS5/vector) source search implementation.
 *
 * Extracted from source-search.ts to break the circular import:
 *   source-search.ts → source-providers/filesystem.ts → db-search.ts (no cycle)
 *
 * source-search.ts imports this module for the `searchLocal` export.
 * source-providers/filesystem.ts also imports `searchLocal` from here.
 *
 * Renamed from `local-search.ts` to signal that this is the DB-layer search
 * implementation, not a "local vs. remote" distinction.
 */

import type { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
import { makeAssetRef } from "../core/asset-ref";
import { defaultRendererRegistry, type RendererRegistry } from "../core/asset-registry";
import { deriveCanonicalAssetNameFromStashRoot } from "../core/asset-spec";
import type { AkmConfig } from "../core/config";
import { getDbPath } from "../core/paths";
import { warn } from "../core/warn";
import type { AkmSearchType, SearchHitSize, SourceSearchHit } from "../sources/source-types";
import {
  closeDatabase,
  type DbSearchResult,
  getAllEntries,
  getEntryById,
  getEntryCount,
  getMeta,
  getUtilityScoresByIds,
  openDatabase,
  searchFts,
  searchVec,
} from "./db";
import { getRenderer } from "./file-context";
import { generateMetadataFlat, loadStashFile, type StashEntry, shouldIndexStashFile } from "./metadata";
import { buildSearchText } from "./search-fields";
import { buildEditHint, findSourceForPath, isEditable, type SearchSource } from "./search-source";
import {
  deriveSemanticProviderFingerprint,
  getEffectiveSemanticStatus,
  isSemanticRuntimeReady,
  readSemanticStatus,
} from "./semantic-status";
import { walkStashFlat } from "./walker";

type IndexedAsset = {
  entry: StashEntry;
  path: string;
};

export async function rendererForType(type: string, registry: RendererRegistry = defaultRendererRegistry) {
  const name = registry.rendererNameFor(type);
  return name ? getRenderer(name) : undefined;
}

export function buildLocalAction(
  type: string,
  ref: string,
  registry: RendererRegistry = defaultRendererRegistry,
): string {
  const builder = registry.actionBuilderFor(type);
  return builder ? builder(ref) : `akm show ${ref}`;
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
}): Promise<{
  hits: SourceSearchHit[];
  tip?: string;
  warnings?: string[];
  embedMs?: number;
  rankMs?: number;
}> {
  const { query, searchType, limit, stashDir, sources, config } = input;
  const rendererRegistry = input.rendererRegistry ?? defaultRendererRegistry;
  const allSourceDirs = sources.map((s) => s.path);
  const rawStatus = readSemanticStatus();
  const semanticStatus = getEffectiveSemanticStatus(config, rawStatus);
  const warnings: string[] = [];
  if (config.semanticSearchMode === "auto" && semanticStatus === "pending") {
    // Distinguish between fingerprint mismatch (config changed) and never-set-up.
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

  // Try to open the database
  const dbPath = getDbPath();
  try {
    if (fs.existsSync(dbPath)) {
      const embeddingDim = config.embedding?.dimension;
      const db = openDatabase(dbPath, embeddingDim ? { embeddingDim } : undefined);
      try {
        const entryCount = getEntryCount(db);
        const storedStashDir = getMeta(db, "stashDir");
        // Accept the index if the incoming stashDir matches the primary OR
        // appears anywhere in the stored stashDirs array. This prevents
        // unnecessary substring fallback when only the primary dir changes.
        let stashDirMatch = storedStashDir === stashDir;
        if (!stashDirMatch) {
          try {
            const storedDirs = JSON.parse(getMeta(db, "stashDirs") ?? "[]") as string[];
            stashDirMatch = storedDirs.includes(stashDir);
          } catch {
            /* ignore malformed stashDirs */
          }
        }
        if (entryCount > 0 && stashDirMatch) {
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
          );
          return {
            hits,
            tip:
              hits.length === 0
                ? "No matching stash assets were found. Try running 'akm index' to rebuild."
                : undefined,
            warnings: warnings.length > 0 ? warnings : undefined,
            embedMs,
            rankMs,
          };
        }
      } finally {
        closeDatabase(db);
      }
    }
  } catch (error) {
    warn(
      "Search index unavailable, falling back to substring search:",
      error instanceof Error ? error.message : String(error),
    );
  }

  const hitArrays = await Promise.all(
    allSourceDirs.map((dir) => substringSearch(query, searchType, limit, dir, sources, config, rendererRegistry)),
  );
  const hits = hitArrays.flat().slice(0, limit);
  return {
    hits,
    tip: hits.length === 0 ? "No matching stash assets were found. Try running 'akm index' to rebuild." : undefined,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
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
): Promise<{
  hits: SourceSearchHit[];
  embedMs?: number;
  rankMs?: number;
}> {
  // Empty query: return all entries
  if (!query) {
    const typeFilter = searchType === "any" ? undefined : searchType;
    const allEntries = getAllEntries(db, typeFilter);
    // Deduplicate by file path — multiple entries can share the same file
    const seenFilePaths = new Set<string>();
    const uniqueEntries = allEntries.filter((ie) => {
      if (seenFilePaths.has(ie.filePath)) return false;
      seenFilePaths.add(ie.filePath);
      return true;
    });
    const selected = uniqueEntries.slice(0, limit);
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

  // Normalize FTS BM25 scores to 0-1 range
  const ftsScoreMap = new Map<number, { score: number; result: DbSearchResult }>();
  if (ftsResults.length > 0) {
    // BM25 scores are negative; most negative = best match
    const bestBm25 = ftsResults[0].bm25Score; // most negative (best)
    const worstBm25 = ftsResults[ftsResults.length - 1].bm25Score; // least negative (worst)
    const range = bestBm25 - worstBm25; // negative range

    for (const r of ftsResults) {
      // Normalize: best match = 1.0, worst match approaches 0
      // When range is 0 (all same score), all get 1.0
      const normalized = range !== 0 ? (r.bm25Score - worstBm25) / range : 1.0;
      // Scale to 0.3-1.0 range so even the worst FTS hit has a meaningful base score
      const ftsScore = 0.3 + normalized * 0.7;
      ftsScoreMap.set(r.id, { score: ftsScore, result: r });
    }
  }

  // Build embedding score map (cosine similarities already 0-1)
  const embedScoreMap = new Map<number, number>();
  if (embeddingScores) {
    for (const [id, cosine] of embeddingScores) {
      embedScoreMap.set(id, cosine);
    }
  }

  // ── Combine FTS + vector scores ──────────────────────────────────────
  const FTS_WEIGHT = 0.7;
  const VEC_WEIGHT = 0.3;
  const MAX_BOOST_SUM = 3.0;

  const scored: Array<{
    id: number;
    entry: StashEntry;
    filePath: string;
    score: number;
    rankingMode: "hybrid" | "semantic" | "fts";
    utilityBoosted?: boolean;
  }> = [];
  const seenIds = new Set<number>();

  // Process FTS results
  for (const [id, { score: ftsScore, result }] of ftsScoreMap) {
    seenIds.add(id);
    const embedScore = embedScoreMap.get(id);
    let combinedScore: number;
    let rankingMode: "hybrid" | "fts";
    if (embedScore !== undefined) {
      combinedScore = ftsScore * FTS_WEIGHT + embedScore * VEC_WEIGHT;
      rankingMode = "hybrid";
    } else {
      combinedScore = ftsScore;
      rankingMode = "fts";
    }
    scored.push({ id, entry: result.entry, filePath: result.filePath, score: combinedScore, rankingMode });
  }

  // Add vec-only results not already in FTS results
  if (embeddingScores) {
    for (const [id, cosine] of embeddingScores) {
      if (seenIds.has(id)) continue;
      const found = getEntryById(db, id);
      if (found) {
        if (typeFilter && found.entry.type !== typeFilter) continue;
        scored.push({
          id,
          entry: found.entry,
          filePath: found.filePath,
          score: cosine * VEC_WEIGHT, // Only vector score, no FTS
          rankingMode: "semantic",
        });
      }
    }
  }

  // ── Scoring Phase ──────────────────────────────────────────────────────
  // Apply boosts as multiplicative factors (all boosts in a single phase
  // so that sort order and displayed scores are always consistent).
  //
  // Ranking philosophy: the goal is to surface the MOST USEFUL result for the
  // user's intent. An exact name match is the strongest signal. Actionable
  // asset types (skills, commands, agents) are more useful than passive
  // reference docs. Curated metadata is more reliable than auto-generated.
  const queryTokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  const queryLower = query.toLowerCase().trim();

  for (const item of scored) {
    const entry = item.entry;
    let boostSum = 0;

    // ── 1. Exact / near-exact name match (strongest signal) ──
    // If the query IS the asset name (or very close), this is almost certainly
    // what the user wants. This is the single most important ranking signal.
    const nameLower = entry.name.toLowerCase();
    const nameBase = nameLower.split("/").pop() ?? nameLower; // last segment for path-based names
    if (nameBase === queryLower || nameLower === queryLower) {
      // Exact match: massive boost
      boostSum += 2.0;
    } else if (nameBase.includes(queryLower) || queryLower.includes(nameBase)) {
      // Near-exact: query is substring of name or vice versa
      boostSum += 1.0;
    } else {
      // Token overlap: how many query tokens appear in the base name?
      const nameTokens = nameBase.split(/[-_\s]+/).filter(Boolean);
      const matchCount = queryTokens.filter((qt) => nameTokens.some((nt) => nt === qt || nt.includes(qt))).length;
      if (matchCount > 0) {
        // Proportional to how many query tokens match (0.3 per token, max 0.9)
        boostSum += Math.min(0.9, matchCount * 0.3);
      }
    }

    // ── 2. Type relevance boost ──
    // Actionable assets (skills, commands, agents) are generally more useful
    // than passive reference material when the user is searching for something
    // to use. Knowledge docs are reference — valuable but secondary.
    const TYPE_BOOST: Record<string, number> = {
      skill: 0.4,
      command: 0.35,
      agent: 0.3,
      script: 0.2,
      memory: 0.1,
      knowledge: 0,
    };
    boostSum += TYPE_BOOST[entry.type] ?? 0;

    // ── 3. Tag exact match ──
    // Exact tag equality is a strong signal — the author explicitly tagged
    // this asset with the user's search term.
    if (entry.tags) {
      let tagBoost = 0;
      for (const tag of entry.tags) {
        if (queryTokens.some((t) => tag.toLowerCase() === t)) {
          tagBoost += 0.15;
        }
      }
      boostSum += Math.min(0.3, tagBoost);
    }

    // ── 4. Search hint match ──
    // Hints are author-curated retrieval cues (e.g. "use when deploying to k8s").
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

    // ── 5. Alias match ──
    // Aliases are alternate names the author defined for discovery.
    if (entry.aliases) {
      for (const alias of entry.aliases) {
        const aliasLower = alias.toLowerCase();
        if (aliasLower === queryLower) {
          boostSum += 1.5; // Nearly as strong as exact name match
          break;
        }
        if (queryTokens.some((t) => aliasLower.includes(t))) {
          boostSum += 0.3;
        }
      }
    }

    // ── 6. Description relevance ──
    // All query tokens appearing in description suggests strong relevance.
    if (entry.description) {
      const descLower = entry.description.toLowerCase();
      const descMatchCount = queryTokens.filter((t) => descLower.includes(t)).length;
      if (descMatchCount === queryTokens.length && queryTokens.length > 1) {
        // All query tokens found in description — high relevance
        boostSum += 0.25;
      } else if (descMatchCount > 0) {
        boostSum += 0.1;
      }
    }

    // ── 7. Metadata quality signals ──
    const qualityBoost = entry.quality === "generated" ? 0 : 0.05;
    boostSum += qualityBoost;

    const confidenceBoost =
      typeof entry.confidence === "number" ? Math.min(0.05, Math.max(0, entry.confidence) * 0.05) : 0;
    boostSum += confidenceBoost;

    const cappedBoost = Math.min(boostSum, MAX_BOOST_SUM);
    item.score = item.score * (1 + cappedBoost);
  }

  // Utility-based re-ranking (MemRL pattern).
  // After the FTS+boost scoring pass, apply a multiplicative
  // utility factor based on aggregated usage telemetry.
  // Batch-load all utility scores in one query to avoid N+1.
  const UTILITY_WEIGHT = 0.5;
  const UTILITY_MAX_BOOST = 1.5; // Cap at 1.5x multiplier
  const RECENCY_DECAY_DAYS = 30;
  const utilScoresMap = getUtilityScoresByIds(
    db,
    scored.map((s) => s.id),
  );
  for (const item of scored) {
    const utilScore = utilScoresMap.get(item.id);
    if (utilScore && utilScore.utility > 0) {
      // Compute recency factor: exponential decay based on days since last use
      let recencyFactor = 1;
      if (utilScore.lastUsedAt) {
        const lastUsedMs = new Date(utilScore.lastUsedAt).getTime();
        const daysSinceLastUse = Number.isNaN(lastUsedMs)
          ? Infinity
          : Math.max(0, (Date.now() - lastUsedMs) / (1000 * 60 * 60 * 24));
        recencyFactor = Math.exp(-daysSinceLastUse / RECENCY_DECAY_DAYS);
      }
      // Compute raw utility boost and cap it
      const rawBoost = 1 + utilScore.utility * recencyFactor * UTILITY_WEIGHT;
      const cappedBoost = Math.min(rawBoost, UTILITY_MAX_BOOST);
      item.score = item.score * cappedBoost;
      item.utilityBoosted = true;
    }
  }

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

  const rankMs = Date.now() - tRank0;

  const selected = deduped.slice(0, limit);
  const hits = await Promise.all(
    selected.map(({ entry, filePath, score, rankingMode, utilityBoosted }) =>
      buildDbHit({
        entry,
        path: filePath,
        // Round to 4 decimal places
        score: Math.round(score * 10000) / 10000,
        query,
        rankingMode,
        defaultStashDir: stashDir,
        allSourceDirs,
        sources,
        config,
        utilityBoosted,
        rendererRegistry,
      }),
    ),
  );

  return { embedMs, rankMs, hits };
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

// ── Substring fallback (no index) ───────────────────────────────────────────

async function substringSearch(
  query: string,
  searchType: AkmSearchType,
  limit: number,
  stashDir: string,
  sources: SearchSource[],
  config?: AkmConfig,
  rendererRegistry: RendererRegistry = defaultRendererRegistry,
): Promise<SourceSearchHit[]> {
  const assets = await indexAssets(stashDir, searchType, sources);
  const matched = assets.filter((asset) => !query || buildSearchText(asset.entry).includes(query));

  if (!query) {
    const sorted = matched.sort(compareAssets);
    const unique = deduplicateAssetsByPath(sorted);
    return Promise.all(
      unique
        .slice(0, limit)
        .map((asset) => assetToSearchHit(asset, stashDir, sources, config, undefined, rendererRegistry)),
    );
  }

  // Score and sort by relevance
  const scored = matched.map((asset) => ({ asset, score: scoreSubstringMatch(asset.entry, query) }));
  scored.sort((a, b) => b.score - a.score || compareAssets(a.asset, b.asset));

  // Deduplicate by path — keep highest-scored entry per file
  const dedupedScored = deduplicateByPath(scored.map((s) => ({ ...s, filePath: s.asset.path })));

  return Promise.all(
    dedupedScored
      .slice(0, limit)
      .map(({ asset, score }) => assetToSearchHit(asset, stashDir, sources, config, score, rendererRegistry)),
  );
}

function scoreSubstringMatch(entry: StashEntry, query: string): number {
  const tokens = query.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return 0.5;

  let score = 0.3;

  const nameLower = entry.name.toLowerCase().replace(/[-_]/g, " ");
  const descLower = (entry.description ?? "").toLowerCase();
  const tagsLower = (entry.tags ?? []).join(" ").toLowerCase();

  if (nameLower === query) {
    score += 0.5;
  } else if (nameLower.includes(query)) {
    score += 0.35;
  } else if (tokens.some((t) => nameLower.includes(t))) {
    score += 0.2;
  }

  if (tokens.some((t) => tagsLower.includes(t))) {
    score += 0.1;
  }

  if (tokens.some((t) => descLower.includes(t))) {
    score += 0.05;
  }

  // Issue #8: round to 4 decimal places instead of 2
  return Math.round(Math.min(1, score) * 10000) / 10000;
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
  /** Optional renderer registry override for test isolation. */
  rendererRegistry?: RendererRegistry;
}): Promise<SourceSearchHit> {
  const rendererRegistry = input.rendererRegistry ?? defaultRendererRegistry;
  const entryStashDir = findSourceForPath(input.path, input.sources)?.path ?? input.defaultStashDir;
  const canonical = deriveCanonicalAssetNameFromStashRoot(input.entry.type, entryStashDir, input.path);
  const refName =
    canonical && !canonical.startsWith("../") && !canonical.startsWith("..\\") ? canonical : input.entry.name;

  // Quality and confidence boosts are now applied in the main scoring
  // phase (searchDatabase). buildDbHit receives the already-final score and
  // passes it through without further multiplication. We still compute the
  // boost values here for buildWhyMatched reporting.
  const qualityBoost = input.entry.quality === "generated" ? 0 : 0.05;
  const confidenceBoost =
    typeof input.entry.confidence === "number" ? Math.min(0.05, Math.max(0, input.entry.confidence) * 0.05) : 0;
  // Round to 4 decimal places, no boost multiplication
  const score = Math.round(input.score * 10000) / 10000;

  const whyMatched = buildWhyMatched(
    input.entry,
    input.query,
    input.rankingMode,
    qualityBoost,
    confidenceBoost,
    input.utilityBoosted,
  );

  const source = findSourceForPath(input.path, input.sources);
  const ref = resolveSearchHitRef(input.entry, refName, source);

  const editable = isEditable(input.path, input.config);
  const estimatedTokens = typeof input.entry.fileSize === "number" ? Math.round(input.entry.fileSize / 4) : undefined;

  const hit: SourceSearchHit = {
    type: input.entry.type,
    name: input.entry.name,
    path: input.path,
    ref,
    origin: resolveSearchHitOrigin(source),
    editable,
    ...(!editable ? { editHint: buildEditHint(input.path, input.entry.type, refName, source?.registryId) } : {}),
    description: input.entry.description,
    tags: input.entry.tags,
    size: deriveSize(input.entry.fileSize),
    action: buildLocalAction(input.entry.type, ref, rendererRegistry),
    score,
    whyMatched,
    ...(estimatedTokens !== undefined ? { estimatedTokens } : {}),
  };

  const renderer = await rendererForType(input.entry.type, rendererRegistry);
  if (renderer?.enrichSearchHit) {
    renderer.enrichSearchHit(hit, entryStashDir);
  }

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
  if (utilityBoosted) reasons.push("usage history boost");

  return reasons;
}

async function assetToSearchHit(
  asset: IndexedAsset,
  stashDir: string,
  sources: SearchSource[],
  config?: AkmConfig,
  score?: number,
  rendererRegistry: RendererRegistry = defaultRendererRegistry,
): Promise<SourceSearchHit> {
  const source = findSourceForPath(asset.path, sources);
  const editable = isEditable(asset.path, config);
  const ref = resolveSearchHitRef(asset.entry, asset.entry.name, source);
  const fileSize = readFileSize(asset.path);
  const size = deriveSize(fileSize);
  const estimatedTokens = typeof fileSize === "number" ? Math.round(fileSize / 4) : undefined;
  const hit: SourceSearchHit = {
    type: asset.entry.type,
    name: asset.entry.name,
    path: asset.path,
    ref,
    origin: resolveSearchHitOrigin(source),
    editable,
    ...(!editable
      ? { editHint: buildEditHint(asset.path, asset.entry.type, asset.entry.name, source?.registryId) }
      : {}),
    description: asset.entry.description,
    tags: asset.entry.tags,
    ...(size ? { size } : {}),
    action: buildLocalAction(asset.entry.type, ref, rendererRegistry),
    ...(score !== undefined ? { score } : {}),
    ...(estimatedTokens !== undefined ? { estimatedTokens } : {}),
  };
  const renderer = await rendererForType(asset.entry.type, rendererRegistry);
  if (renderer?.enrichSearchHit) {
    renderer.enrichSearchHit(hit, stashDir);
  }
  return hit;
}

// ── Utilities ────────────────────────────────────────────────────────────────

export function deriveSize(bytes?: number): SearchHitSize | undefined {
  if (bytes === undefined) return undefined;
  if (bytes < 1024) return "small";
  if (bytes < 10240) return "medium";
  return "large";
}

function readFileSize(filePath: string): number | undefined {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return undefined;
  }
}

async function indexAssets(stashDir: string, type: AkmSearchType, sources?: SearchSource[]): Promise<IndexedAsset[]> {
  const resolvedStashDir = realpathOrResolve(stashDir);
  const source = sources?.find((entry) => realpathOrResolve(entry.path) === resolvedStashDir);
  if (source?.wikiName) {
    return indexWikiRootAssets(stashDir, source.wikiName, type);
  }

  const assets: IndexedAsset[] = [];
  const filterType = type === "any" ? undefined : type;
  const fileContexts = walkStashFlat(stashDir);
  const dirGroups = new Map<string, string[]>();

  for (const ctx of fileContexts) {
    const group = dirGroups.get(ctx.parentDirAbs);
    if (group) group.push(ctx.absPath);
    else dirGroups.set(ctx.parentDirAbs, [ctx.absPath]);
  }

  for (const [dirPath, files] of dirGroups) {
    let stash = loadStashFile(dirPath);

    if (stash) {
      const coveredFiles = new Set(
        stash.entries.map((entry) => entry.filename).filter((entry): entry is string => !!entry),
      );
      const uncoveredFiles = files.filter((file) => !coveredFiles.has(path.basename(file)));
      if (uncoveredFiles.length > 0) {
        const generated = await generateMetadataFlat(stashDir, uncoveredFiles);
        if (generated.entries.length > 0) {
          stash = { entries: [...stash.entries, ...generated.entries] };
        }
      }
    } else {
      const generated = await generateMetadataFlat(stashDir, files);
      if (generated.entries.length === 0) continue;
      stash = generated;
    }

    // Build a lookup for matching filename-less entries to actual files
    const fileBasenameMap = new Map<string, string>();
    for (const file of files) {
      const base = path.basename(file, path.extname(file));
      if (!fileBasenameMap.has(base)) fileBasenameMap.set(base, file);
    }
    for (const entry of stash.entries) {
      if (filterType && entry.type !== filterType) continue;
      let entryPath: string;
      if (entry.filename) {
        entryPath = path.join(dirPath, entry.filename);
      } else {
        // Try matching entry name to a file by basename
        entryPath =
          fileBasenameMap.get(entry.name) ??
          fileBasenameMap.get(entry.name.split("/").pop() ?? "") ??
          (files[0] || dirPath);
      }
      if (!shouldIndexStashFile(stashDir, entryPath)) continue;
      assets.push({ entry, path: entryPath });
    }
  }

  return assets;
}

async function indexWikiRootAssets(wikiRoot: string, wikiName: string, type: AkmSearchType): Promise<IndexedAsset[]> {
  if (type !== "any" && type !== "wiki") return [];

  const assets: IndexedAsset[] = [];
  for (const ctx of walkStashFlat(wikiRoot)) {
    if (ctx.ext !== ".md") continue;
    if (!shouldIndexStashFile(wikiRoot, ctx.absPath, { treatStashRootAsWikiRoot: true })) continue;
    const relNoExt = ctx.relPath.replace(/\.md$/, "");
    assets.push({
      entry: {
        name: `${wikiName}/${relNoExt}`,
        type: "wiki",
        filename: ctx.fileName,
        description: ctx.frontmatter()?.description as string | undefined,
        source: "frontmatter",
      },
      path: ctx.absPath,
    });
  }
  return assets;
}

function compareAssets(a: IndexedAsset, b: IndexedAsset): number {
  if (a.entry.type !== b.entry.type) return a.entry.type.localeCompare(b.entry.type);
  return a.entry.name.localeCompare(b.entry.name);
}

/**
 * Deduplicate scored results by file path, keeping only the highest-scored
 * entry per unique path. Sorts by score descending internally to ensure the
 * precondition is always met regardless of caller.
 */
function deduplicateByPath<T extends { filePath: string; score?: number }>(items: T[]): T[] {
  // Sort inside to enforce the descending-score precondition
  const sorted = [...items].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const seen = new Set<string>();
  return sorted.filter((item) => {
    if (seen.has(item.filePath)) return false;
    seen.add(item.filePath);
    return true;
  });
}

/**
 * Deduplicate IndexedAsset[] by path, keeping the first (highest-priority) entry.
 */
function deduplicateAssetsByPath(assets: IndexedAsset[]): IndexedAsset[] {
  const seen = new Set<string>();
  return assets.filter((asset) => {
    if (seen.has(asset.path)) return false;
    seen.add(asset.path);
    return true;
  });
}

function realpathOrResolve(targetPath: string): string {
  try {
    return fs.realpathSync(targetPath);
  } catch {
    return path.resolve(targetPath);
  }
}
