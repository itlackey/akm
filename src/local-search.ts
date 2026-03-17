/**
 * Local (filesystem + SQLite) stash search implementation.
 *
 * Extracted from stash-search.ts to break the circular import:
 *   stash-search.ts → stash-providers/filesystem.ts → local-search.ts (no cycle)
 *
 * stash-search.ts imports this module for the `searchLocal` export.
 * stash-providers/filesystem.ts also imports `searchLocal` from here.
 */

import fs from "node:fs";
import path from "node:path";
import { ACTION_BUILDERS, TYPE_TO_RENDERER } from "./asset-registry";
import { deriveCanonicalAssetNameFromStashRoot } from "./asset-spec";
import type { AkmConfig } from "./config";
import {
  closeDatabase,
  type DbSearchResult,
  getAllEntries,
  getEntryById,
  getEntryCount,
  getMeta,
  openDatabase,
  searchFts,
  searchVec,
} from "./db";
import { getRenderer } from "./file-context";
import { buildSearchText } from "./indexer";
import { generateMetadataFlat, loadStashFile, type StashEntry } from "./metadata";
import { getDbPath } from "./paths";
import { buildEditHint, findSourceForPath, isEditable, type SearchSource } from "./search-source";
import { makeAssetRef } from "./stash-ref";
import type { AkmSearchType, SearchHitSize, StashSearchHit } from "./stash-types";
import { walkStashFlat } from "./walker";
import { warn } from "./warn";

type IndexedAsset = {
  entry: StashEntry;
  path: string;
};

export async function rendererForType(type: string) {
  const name = TYPE_TO_RENDERER[type];
  return name ? getRenderer(name) : undefined;
}

export function buildLocalAction(type: string, ref: string): string {
  const builder = ACTION_BUILDERS[type];
  return builder ? builder(ref) : `akm show ${ref}`;
}

// ── Main search entrypoint ───────────────────────────────────────────────────

export async function searchLocal(input: {
  query: string;
  searchType: AkmSearchType;
  limit: number;
  stashDir: string;
  sources: SearchSource[];
  config: AkmConfig;
}): Promise<{
  hits: StashSearchHit[];
  tip?: string;
  warnings?: string[];
  embedMs?: number;
  rankMs?: number;
}> {
  const { query, searchType, limit, stashDir, sources, config } = input;
  const allStashDirs = sources.map((s) => s.path);

  // Try to open the database
  const dbPath = getDbPath();
  try {
    if (fs.existsSync(dbPath)) {
      const embeddingDim = config.embedding?.dimension;
      const db = openDatabase(dbPath, embeddingDim ? { embeddingDim } : undefined);
      try {
        const entryCount = getEntryCount(db);
        const storedStashDir = getMeta(db, "stashDir");
        if (entryCount > 0 && storedStashDir === stashDir) {
          const { hits, embedMs, rankMs } = await searchDatabase(
            db,
            query,
            searchType,
            limit,
            stashDir,
            allStashDirs,
            config,
            sources,
          );
          return {
            hits,
            tip:
              hits.length === 0
                ? "No matching stash assets were found. Try running 'akm index' to rebuild."
                : undefined,
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
    allStashDirs.map((dir) => substringSearch(query, searchType, limit, dir, sources, config)),
  );
  const hits = hitArrays.flat().slice(0, limit);
  return {
    hits,
    tip: hits.length === 0 ? "No matching stash assets were found. Try running 'akm index' to rebuild." : undefined,
  };
}

// ── Database search ─────────────────────────────────────────────────────────

async function searchDatabase(
  db: import("bun:sqlite").Database,
  query: string,
  searchType: AkmSearchType,
  limit: number,
  stashDir: string,
  allStashDirs: string[],
  config: AkmConfig,
  sources: SearchSource[],
): Promise<{
  hits: StashSearchHit[];
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
          allStashDirs,
          sources,
          config,
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

  // Reciprocal Rank Fusion (RRF) constant
  const RRF_K = 60;

  // Build FTS rank map: rank 1 = best BM25, rank 2 = second best, etc.
  const ftsRankMap = new Map<number, { rank: number; result: DbSearchResult }>();
  for (let i = 0; i < ftsResults.length; i++) {
    const r = ftsResults[i];
    ftsRankMap.set(r.id, { rank: i + 1, result: r });
  }

  // Build embedding rank map: sort by cosine similarity descending
  const embedRankMap = new Map<number, number>();
  if (embeddingScores) {
    const sortedEmbeddings = [...embeddingScores.entries()].sort((a, b) => b[1] - a[1]);
    for (let i = 0; i < sortedEmbeddings.length; i++) {
      embedRankMap.set(sortedEmbeddings[i][0], i + 1);
    }
  }

  // Merge results using RRF
  // Issue #15: "hybrid" for results appearing in both FTS and vec results.
  const scored: Array<{
    id: number;
    entry: StashEntry;
    filePath: string;
    score: number;
    rankingMode: "hybrid" | "semantic" | "fts";
  }> = [];
  const seenIds = new Set<number>();

  // Process FTS results
  for (const [id, { rank, result }] of ftsRankMap) {
    seenIds.add(id);
    const ftsRrf = 1 / (RRF_K + rank);
    const embedRank = embedRankMap.get(id);
    const embedRrf = embedRank !== undefined ? 1 / (RRF_K + embedRank) : 0;
    const rrfScore = ftsRrf + embedRrf;
    // Issue #15: combined FTS+vec results are "hybrid", not "semantic"
    const rankingMode = embedRrf > 0 ? ("hybrid" as const) : ("fts" as const);
    scored.push({ id, entry: result.entry, filePath: result.filePath, score: rrfScore, rankingMode });
  }

  // Add vec-only results not already in FTS results
  if (embeddingScores) {
    for (const [id] of embeddingScores) {
      if (seenIds.has(id)) continue;
      const embedRank = embedRankMap.get(id);
      if (embedRank === undefined) continue;
      const found = getEntryById(db, id);
      if (found) {
        if (typeFilter && found.entry.type !== typeFilter) continue;
        const rrfScore = 1 / (RRF_K + embedRank);
        scored.push({
          id,
          entry: found.entry,
          filePath: found.filePath,
          score: rrfScore,
          rankingMode: "semantic",
        });
      }
    }
  }

  // Apply boosts as multiplicative factors (all boosts in a single phase
  // so that sort order and displayed scores are always consistent — Issue #1).
  const queryTokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  for (const item of scored) {
    const entry = item.entry;
    let boostSum = 0;

    // Tag boost — capped at 0.30 (Issue #7)
    // Tag boost retained: FTS5 bm25 weights term frequency, but exact-tag equality
    // (e.g. query token "deploy" exactly matching tag "deploy") is a stronger signal
    // than partial term overlap in the tags column. This distinguishes exact tag
    // identity from incidental keyword presence.
    if (entry.tags) {
      let tagBoost = 0;
      for (const tag of entry.tags) {
        if (queryTokens.some((t) => tag.toLowerCase() === t)) {
          tagBoost += 0.15;
        }
      }
      boostSum += Math.min(0.3, tagBoost);
    }

    // Search hint boost — capped at 0.24 (Issue #7)
    // Hint boost retained: hints are author-curated retrieval cues (e.g. "use when
    // deploying to k8s"). A substring match between a query token and a hint
    // carries intent-level relevance that FTS5 term-frequency scoring alone cannot
    // capture, so the post-FTS boost remains valuable.
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

    // S-3: Name boost removed — FTS5 multi-column bm25() weights now handle
    // name-match ranking natively via the 10.0 weight on the name column.

    // Quality boost (Issue #1: moved from buildDbHit to single-phase)
    const qualityBoost = entry.quality === "generated" ? 0 : 0.05;
    boostSum += qualityBoost;

    // Confidence boost (Issue #1: moved from buildDbHit to single-phase)
    const confidenceBoost =
      typeof entry.confidence === "number" ? Math.min(0.05, Math.max(0, entry.confidence) * 0.05) : 0;
    boostSum += confidenceBoost;

    item.score = item.score * (1 + boostSum);
  }

  // Issue #14: deterministic tiebreaker on equal scores
  scored.sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name));

  // Deduplicate by file path — keep only the highest-scored entry per file.
  // Multiple .stash.json entries can map to the same file (e.g. entries without
  // a filename field all collapse to files[0]). Showing the same path/ref
  // multiple times clutters results.
  const deduped = deduplicateByPath(scored);

  const rankMs = Date.now() - tRank0;

  const selected = deduped.slice(0, limit);
  const hits = await Promise.all(
    selected.map(({ entry, filePath, score, rankingMode }) =>
      buildDbHit({
        entry,
        path: filePath,
        // Issue #8: round to 4 decimal places instead of 2
        score: Math.round(score * 10000) / 10000,
        query,
        rankingMode,
        defaultStashDir: stashDir,
        allStashDirs,
        sources,
        config,
      }),
    ),
  );

  return { embedMs, rankMs, hits };
}

// ── Vector scorer ───────────────────────────────────────────────────────────

async function tryVecScores(
  db: import("bun:sqlite").Database,
  query: string,
  k: number,
  config: AkmConfig,
): Promise<Map<number, number> | null> {
  if (!config.semanticSearch) return null;
  const hasEmbeddings = getMeta(db, "hasEmbeddings");
  if (hasEmbeddings !== "1") return null;

  try {
    const { embed } = await import("./embedder.js");
    const queryEmbedding = await embed(query, config.embedding);
    const vecResults = searchVec(db, queryEmbedding, k);

    const scores = new Map<number, number>();
    for (const { id, distance } of vecResults) {
      // Convert L2 distance to cosine similarity (vectors are normalized).
      // Issue #3: guard against NaN/Infinity from sqlite-vec edge cases.
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
): Promise<StashSearchHit[]> {
  const assets = await indexAssets(stashDir, searchType);
  const matched = assets.filter((asset) => !query || buildSearchText(asset.entry).includes(query));

  if (!query) {
    const sorted = matched.sort(compareAssets);
    const unique = deduplicateAssetsByPath(sorted);
    return Promise.all(
      unique.slice(0, limit).map((asset) => assetToSearchHit(asset, query, stashDir, sources, config)),
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
      .map(({ asset, score }) => assetToSearchHit(asset, query, stashDir, sources, config, score)),
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
  // Issue #15: added "hybrid" for combined FTS+vec results
  rankingMode: "hybrid" | "semantic" | "fts";
  defaultStashDir: string;
  allStashDirs: string[];
  sources: SearchSource[];
  config?: AkmConfig;
}): Promise<StashSearchHit> {
  const entryStashDir = findSourceForPath(input.path, input.sources)?.path ?? input.defaultStashDir;
  const canonical = deriveCanonicalAssetNameFromStashRoot(input.entry.type, entryStashDir, input.path);
  const refName =
    canonical && !canonical.startsWith("../") && !canonical.startsWith("..\\") ? canonical : input.entry.name;

  // Issue #1: Quality and confidence boosts are now applied in the main scoring
  // phase (searchDatabase). buildDbHit receives the already-final score and
  // passes it through without further multiplication. We still compute the
  // boost values here for buildWhyMatched reporting.
  const qualityBoost = input.entry.quality === "generated" ? 0 : 0.05;
  const confidenceBoost =
    typeof input.entry.confidence === "number" ? Math.min(0.05, Math.max(0, input.entry.confidence) * 0.05) : 0;
  // Issue #8: round to 4 decimal places, no boost multiplication
  const score = Math.round(input.score * 10000) / 10000;

  const whyMatched = buildWhyMatched(input.entry, input.query, input.rankingMode, qualityBoost, confidenceBoost);

  const source = findSourceForPath(input.path, input.sources);

  const editable = isEditable(input.path, input.config);
  const estimatedTokens = typeof input.entry.fileSize === "number" ? Math.round(input.entry.fileSize / 4) : undefined;

  const hit: StashSearchHit = {
    type: input.entry.type,
    name: input.entry.name,
    path: input.path,
    ref: makeAssetRef(input.entry.type, refName, source?.registryId),
    origin: source?.registryId ?? null,
    editable,
    ...(!editable ? { editHint: buildEditHint(input.path, input.entry.type, refName, source?.registryId) } : {}),
    description: input.entry.description,
    tags: input.entry.tags,
    size: deriveSize(input.entry.fileSize),
    action: buildLocalAction(input.entry.type, makeAssetRef(input.entry.type, refName, source?.registryId)),
    score,
    whyMatched,
    ...(estimatedTokens !== undefined ? { estimatedTokens } : {}),
  };

  const renderer = await rendererForType(input.entry.type);
  if (renderer?.enrichSearchHit) {
    renderer.enrichSearchHit(hit, entryStashDir);
  }

  return hit;
}

export function buildWhyMatched(
  entry: StashEntry,
  query: string,
  // Issue #15: added "hybrid" ranking mode
  rankingMode: "hybrid" | "semantic" | "fts",
  qualityBoost: number,
  confidenceBoost: number,
): string[] {
  // Issue #15: "hybrid" label for combined FTS+vec results
  const reasons: string[] = [
    rankingMode === "hybrid"
      ? "hybrid (fts + semantic)"
      : rankingMode === "semantic"
        ? "semantic similarity"
        : "fts bm25 relevance",
  ];
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);

  const name = entry.name.toLowerCase();
  const tags = entry.tags?.join(" ").toLowerCase() ?? "";
  const searchHints = entry.searchHints?.join(" ").toLowerCase() ?? "";
  const aliases = entry.aliases?.join(" ").toLowerCase() ?? "";
  // Issue #12: include description in match reasons
  const desc = entry.description?.toLowerCase() ?? "";

  if (tokens.some((t) => name.includes(t))) reasons.push("matched name tokens");
  if (tokens.some((t) => tags.includes(t))) reasons.push("matched tags");
  if (tokens.some((t) => searchHints.includes(t))) reasons.push("matched searchHints");
  if (tokens.some((t) => aliases.includes(t))) reasons.push("matched aliases");
  // Issue #12: report description matches
  if (tokens.some((t) => desc.includes(t))) reasons.push("matched description");
  if (qualityBoost > 0) reasons.push("curated metadata boost");
  if (confidenceBoost > 0) reasons.push("metadata confidence boost");

  return reasons;
}

async function assetToSearchHit(
  asset: IndexedAsset,
  _query: string,
  stashDir: string,
  sources: SearchSource[],
  config?: AkmConfig,
  score?: number,
): Promise<StashSearchHit> {
  const source = findSourceForPath(asset.path, sources);
  const editable = isEditable(asset.path, config);
  const ref = makeAssetRef(asset.entry.type, asset.entry.name, source?.registryId);
  const fileSize = readFileSize(asset.path);
  const size = deriveSize(fileSize);
  const estimatedTokens = typeof fileSize === "number" ? Math.round(fileSize / 4) : undefined;
  const hit: StashSearchHit = {
    type: asset.entry.type,
    name: asset.entry.name,
    path: asset.path,
    ref,
    origin: source?.registryId ?? null,
    editable,
    ...(!editable
      ? { editHint: buildEditHint(asset.path, asset.entry.type, asset.entry.name, source?.registryId) }
      : {}),
    description: asset.entry.description,
    tags: asset.entry.tags,
    ...(size ? { size } : {}),
    action: buildLocalAction(asset.entry.type, ref),
    ...(score !== undefined ? { score } : {}),
    ...(estimatedTokens !== undefined ? { estimatedTokens } : {}),
  };
  const renderer = await rendererForType(asset.entry.type);
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

async function indexAssets(stashDir: string, type: AkmSearchType): Promise<IndexedAsset[]> {
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
      assets.push({ entry, path: entryPath });
    }
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
 * precondition is always met regardless of caller (Issue #4).
 */
function deduplicateByPath<T extends { filePath: string; score?: number }>(items: T[]): T[] {
  // Issue #4: sort inside to enforce the descending-score precondition
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
