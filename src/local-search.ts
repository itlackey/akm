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
import { _setAssetTypeHooks, deriveCanonicalAssetNameFromStashRoot } from "./asset-spec";
import type { AgentikitConfig } from "./config";
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
import { makeAssetRef } from "./stash-ref";
import { buildEditHint, findSourceForPath, isEditable, type StashSource } from "./stash-source";
import type { AgentikitSearchType, SearchHitSize, StashSearchHit } from "./stash-types";
import { walkStashFlat } from "./walker";
import { warn } from "./warn";

type IndexedAsset = {
  entry: StashEntry;
  path: string;
};

// ── Type renderer/action maps (re-exported so stash-search.ts can register) ──

/** Map asset types to their primary renderer names. */
export const TYPE_TO_RENDERER: Record<string, string> = {
  script: "script-source",
  skill: "skill-md",
  command: "command-md",
  agent: "agent-md",
  knowledge: "knowledge-md",
  memory: "memory-md",
};

export const ACTION_BUILDERS: Record<string, (ref: string) => string> = {
  script: (ref) => `akm show ${ref} -> execute the run command`,
  skill: (ref) => `akm show ${ref} -> follow the instructions`,
  command: (ref) => `akm show ${ref} -> fill placeholders and dispatch`,
  agent: (ref) => `akm show ${ref} -> dispatch with full prompt`,
  knowledge: (ref) => `akm show ${ref} -> read reference material`,
  memory: (ref) => `akm show ${ref} -> recall context`,
};

// Wire asset-spec's deferred hooks so that registerAssetType() automatically
// populates TYPE_TO_RENDERER and ACTION_BUILDERS when the optional spec fields
// rendererName / actionBuilder are provided.
_setAssetTypeHooks(
  (type, rendererName) => {
    TYPE_TO_RENDERER[type] = rendererName;
  },
  (type, builder) => {
    ACTION_BUILDERS[type] = builder;
  },
);

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
  searchType: AgentikitSearchType;
  limit: number;
  stashDir: string;
  sources: StashSource[];
  config: AgentikitConfig;
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
  searchType: AgentikitSearchType,
  limit: number,
  stashDir: string,
  allStashDirs: string[],
  config: AgentikitConfig,
  sources: StashSource[],
): Promise<{
  hits: StashSearchHit[];
  embedMs?: number;
  rankMs?: number;
}> {
  // Empty query: return all entries
  if (!query) {
    const typeFilter = searchType === "any" ? undefined : searchType;
    const allEntries = getAllEntries(db, typeFilter);
    const selected = allEntries.slice(0, limit);
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

  // Score using FTS5 (BM25) and optionally sqlite-vec
  const tEmbed0 = Date.now();
  const embeddingScores = await tryVecScores(db, query, limit * 3, config);
  const embedMs = Date.now() - tEmbed0;

  const tRank0 = Date.now();
  const typeFilter = searchType === "any" ? undefined : searchType;
  const ftsResults = searchFts(db, query, limit * 3, typeFilter);

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
  const scored: Array<{
    id: number;
    entry: StashEntry;
    filePath: string;
    score: number;
    rankingMode: "semantic" | "fts";
  }> = [];
  const seenIds = new Set<number>();

  // Process FTS results
  for (const [id, { rank, result }] of ftsRankMap) {
    seenIds.add(id);
    const ftsRrf = 1 / (RRF_K + rank);
    const embedRank = embedRankMap.get(id);
    const embedRrf = embedRank !== undefined ? 1 / (RRF_K + embedRank) : 0;
    const rrfScore = ftsRrf + embedRrf;
    const rankingMode = embedRrf > 0 ? ("semantic" as const) : ("fts" as const);
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

  // Apply boosts as multiplicative factors
  const queryTokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  for (const item of scored) {
    const entry = item.entry;
    let boostSum = 0;
    // Tag boost
    if (entry.tags) {
      for (const tag of entry.tags) {
        if (queryTokens.some((t) => tag.toLowerCase() === t)) {
          boostSum += 0.15;
        }
      }
    }
    // Search hint boost
    if (entry.searchHints) {
      for (const hint of entry.searchHints) {
        const hintLower = hint.toLowerCase();
        for (const token of queryTokens) {
          if (hintLower.includes(token)) {
            boostSum += 0.12;
            break;
          }
        }
      }
    }
    // Name boost
    const nameLower = entry.name.toLowerCase().replace(/[-_]/g, " ");
    if (queryTokens.some((t) => nameLower.includes(t))) {
      boostSum += 0.1;
    }
    item.score = item.score * (1 + boostSum);
  }

  scored.sort((a, b) => b.score - a.score);
  const rankMs = Date.now() - tRank0;

  const selected = scored.slice(0, limit);
  const hits = await Promise.all(
    selected.map(({ entry, filePath, score, rankingMode }) =>
      buildDbHit({
        entry,
        path: filePath,
        score: Math.round(score * 100) / 100,
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
  config: AgentikitConfig,
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
      // Convert L2 distance to cosine similarity (vectors are normalized)
      const cosineSim = 1 - (distance * distance) / 2;
      scores.set(id, Math.max(0, cosineSim));
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
  searchType: AgentikitSearchType,
  limit: number,
  stashDir: string,
  sources: StashSource[],
  config?: AgentikitConfig,
): Promise<StashSearchHit[]> {
  const assets = await indexAssets(stashDir, searchType);
  const matched = assets.filter((asset) => !query || buildSearchText(asset.entry).includes(query));

  if (!query) {
    return Promise.all(
      matched
        .sort(compareAssets)
        .slice(0, limit)
        .map((asset) => assetToSearchHit(asset, query, stashDir, sources, config)),
    );
  }

  // Score and sort by relevance
  const scored = matched.map((asset) => ({ asset, score: scoreSubstringMatch(asset.entry, query) }));
  scored.sort((a, b) => b.score - a.score || compareAssets(a.asset, b.asset));

  return Promise.all(
    scored.slice(0, limit).map(({ asset, score }) => assetToSearchHit(asset, query, stashDir, sources, config, score)),
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

  return Math.round(Math.min(1, score) * 100) / 100;
}

// ── Hit building ────────────────────────────────────────────────────────────

export async function buildDbHit(input: {
  entry: StashEntry;
  path: string;
  score: number;
  query: string;
  rankingMode: "semantic" | "fts";
  defaultStashDir: string;
  allStashDirs: string[];
  sources: StashSource[];
  config?: AgentikitConfig;
}): Promise<StashSearchHit> {
  const entryStashDir = findSourceForPath(input.path, input.sources)?.path ?? input.defaultStashDir;
  const canonical = deriveCanonicalAssetNameFromStashRoot(input.entry.type, entryStashDir, input.path);
  const refName =
    canonical && !canonical.startsWith("../") && !canonical.startsWith("..\\") ? canonical : input.entry.name;

  const qualityBoost = input.entry.quality === "generated" ? 0 : 0.05;
  const confidenceBoost =
    typeof input.entry.confidence === "number" ? Math.min(0.05, Math.max(0, input.entry.confidence) * 0.05) : 0;
  const score = Math.round(input.score * (1 + qualityBoost + confidenceBoost) * 100) / 100;

  const whyMatched = buildWhyMatched(input.entry, input.query, input.rankingMode, qualityBoost, confidenceBoost);

  const source = findSourceForPath(input.path, input.sources);

  const editable = isEditable(input.path, input.config);
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
  rankingMode: "semantic" | "fts",
  qualityBoost: number,
  confidenceBoost: number,
): string[] {
  const reasons: string[] = [rankingMode === "semantic" ? "semantic similarity" : "fts bm25 relevance"];
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);

  const name = entry.name.toLowerCase();
  const tags = entry.tags?.join(" ").toLowerCase() ?? "";
  const searchHints = entry.searchHints?.join(" ").toLowerCase() ?? "";
  const aliases = entry.aliases?.join(" ").toLowerCase() ?? "";

  if (tokens.some((t) => name.includes(t))) reasons.push("matched name tokens");
  if (tokens.some((t) => tags.includes(t))) reasons.push("matched tags");
  if (tokens.some((t) => searchHints.includes(t))) reasons.push("matched searchHints");
  if (tokens.some((t) => aliases.includes(t))) reasons.push("matched aliases");
  if (qualityBoost > 0) reasons.push("curated metadata boost");
  if (confidenceBoost > 0) reasons.push("metadata confidence boost");

  return reasons;
}

async function assetToSearchHit(
  asset: IndexedAsset,
  _query: string,
  stashDir: string,
  sources: StashSource[],
  config?: AgentikitConfig,
  score?: number,
): Promise<StashSearchHit> {
  const source = findSourceForPath(asset.path, sources);
  const editable = isEditable(asset.path, config);
  const ref = makeAssetRef(asset.entry.type, asset.entry.name, source?.registryId);
  const fileSize = readFileSize(asset.path);
  const size = deriveSize(fileSize);
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

async function indexAssets(stashDir: string, type: AgentikitSearchType): Promise<IndexedAsset[]> {
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

    for (const entry of stash.entries) {
      if (filterType && entry.type !== filterType) continue;
      const entryPath = entry.filename ? path.join(dirPath, entry.filename) : files[0] || dirPath;
      assets.push({ entry, path: entryPath });
    }
  }

  return assets;
}

function compareAssets(a: IndexedAsset, b: IndexedAsset): number {
  if (a.entry.type !== b.entry.type) return a.entry.type.localeCompare(b.entry.type);
  return a.entry.name.localeCompare(b.entry.name);
}
