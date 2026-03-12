import fs from "node:fs";
import path from "node:path";
import { deriveCanonicalAssetName, TYPE_DIRS } from "./asset-spec";
import type { AgentikitAssetType } from "./common";
import { type AgentikitConfig, loadConfig } from "./config";
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
import { UsageError } from "./errors";
import { getRenderer } from "./file-context";
import { buildSearchText } from "./indexer";
import { generateMetadataFlat, loadStashFile, type StashEntry } from "./metadata";
import { getDbPath } from "./paths";
import { searchRegistry } from "./registry-search";
import { makeAssetRef } from "./stash-ref";
import { buildEditHint, findSourceForPath, isEditable, resolveStashSources, type StashSource } from "./stash-source";
import type {
  AgentikitSearchType,
  LocalSearchHit,
  RegistrySearchResultHit,
  SearchHit,
  SearchHitSize,
  SearchResponse,
  SearchSource,
} from "./stash-types";
import { walkStashFlat } from "./walker";
import { warn } from "./warn";

type IndexedAsset = {
  entry: StashEntry;
  path: string;
};

const DEFAULT_LIMIT = 20;

export async function agentikitSearch(input: {
  query: string;
  type?: AgentikitSearchType;
  limit?: number;
  source?: SearchSource;
}): Promise<SearchResponse> {
  const t0 = Date.now();
  const query = input.query.trim();
  const normalizedQuery = query.toLowerCase();
  const searchType = input.type ?? "any";
  const limit = normalizeLimit(input.limit);
  const source = parseSearchSource(input.source);
  const config = loadConfig();
  const sources = resolveStashSources(undefined, config);
  if (sources.length === 0) {
    return {
      schemaVersion: 1,
      stashDir: "",
      source,
      hits: [],
      warnings: ["No stash sources configured. Run `akm init` first."],
      timing: { totalMs: Date.now() - t0 },
    };
  }
  const stashDir = sources[0].path;
  const localResult =
    source === "registry"
      ? undefined
      : await searchLocal({
          query: normalizedQuery,
          searchType,
          limit,
          stashDir,
          sources,
          config,
        });

  const registryResult =
    source === "local" ? undefined : await searchRegistry(query, { limit, registries: config.registries });

  if (source === "local") {
    return {
      schemaVersion: 1,
      stashDir,
      source,
      hits: localResult?.hits ?? [],
      tip: localResult?.tip,
      warnings: localResult?.warnings,
      timing: { totalMs: Date.now() - t0, rankMs: localResult?.rankMs, embedMs: localResult?.embedMs },
    };
  }

  const registryHits = (registryResult?.hits ?? []).map((hit): RegistrySearchResultHit => {
    const installRef =
      hit.source === "npm" ? `npm:${hit.ref}` : hit.source === "git" ? `git+${hit.ref}` : `github:${hit.ref}`;
    return {
      type: "registry",
      name: hit.title,
      id: hit.id,
      description: hit.description,
      action: `akm add ${installRef} -> then search again`,
      score: hit.score,
      curated: hit.curated,
      registryName: hit.registryName,
    };
  });

  if (source === "registry") {
    const hits = registryHits.slice(0, limit);
    return {
      schemaVersion: 1,
      stashDir,
      source,
      hits,
      tip: hits.length === 0 ? "No matching registry entries were found." : undefined,
      warnings: registryResult?.warnings.length ? registryResult.warnings : undefined,
      timing: { totalMs: Date.now() - t0 },
    };
  }

  const mergedHits = mergeSearchHits(localResult?.hits ?? [], registryHits, limit);
  const warnings = [...(localResult?.warnings ?? []), ...(registryResult?.warnings ?? [])];

  return {
    schemaVersion: 1,
    stashDir,
    source,
    hits: mergedHits,
    tip: mergedHits.length === 0 ? "No matching stash assets or registry entries were found." : undefined,
    warnings: warnings.length ? warnings : undefined,
    timing: { totalMs: Date.now() - t0 },
  };
}

async function searchLocal(input: {
  query: string;
  searchType: AgentikitSearchType;
  limit: number;
  stashDir: string;
  sources: StashSource[];
  config: AgentikitConfig;
}): Promise<{
  hits: LocalSearchHit[];
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

  const hits = allStashDirs
    .flatMap((dir) => substringSearch(query, searchType, limit, dir, sources, config))
    .slice(0, limit);
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
  config: import("./config").AgentikitConfig,
  sources: StashSource[],
): Promise<{
  hits: LocalSearchHit[];
  embedMs?: number;
  rankMs?: number;
}> {
  // Empty query: return all entries
  if (!query) {
    const typeFilter = searchType === "any" ? undefined : searchType;
    const allEntries = getAllEntries(db, typeFilter);
    const selected = allEntries.slice(0, limit);
    const hits = selected.map((ie) =>
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
    );
    return {
      hits,
    };
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
  // FTS results are already sorted by bm25Score (ascending, more negative = better)
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
    entry: import("./metadata").StashEntry;
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
  const hits = selected.map(({ entry, filePath, score, rankingMode }) =>
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
  );

  return {
    embedMs,
    rankMs,
    hits,
  };
}

// ── Vector scorer ───────────────────────────────────────────────────────────

async function tryVecScores(
  db: import("bun:sqlite").Database,
  query: string,
  k: number,
  config: import("./config").AgentikitConfig,
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

function substringSearch(
  query: string,
  searchType: AgentikitSearchType,
  limit: number,
  stashDir: string,
  sources: StashSource[],
  config?: import("./config").AgentikitConfig,
): LocalSearchHit[] {
  const assets = indexAssets(stashDir, searchType);
  return assets
    .filter((asset) => !query || buildSearchText(asset.entry).includes(query))
    .sort(compareAssets)
    .slice(0, limit)
    .map((asset) => assetToSearchHit(asset, stashDir, sources, config));
}

// ── Hit building ────────────────────────────────────────────────────────────

function buildDbHit(input: {
  entry: import("./metadata").StashEntry;
  path: string;
  score: number;
  query: string;
  rankingMode: "semantic" | "fts";
  defaultStashDir: string;
  allStashDirs: string[];
  sources: StashSource[];
  config?: import("./config").AgentikitConfig;
}): LocalSearchHit {
  const entryStashDir = findSourceForPath(input.path, input.sources)?.path ?? input.defaultStashDir;
  const typeRoot = path.join(entryStashDir, TYPE_DIRS[input.entry.type]);
  const canonical = deriveCanonicalAssetName(input.entry.type, typeRoot, input.path);
  // Guard against path traversal when the file is outside the expected type root
  // (e.g. source detection fell back to defaultStashDir for a file from another source)
  const refName =
    canonical && !canonical.startsWith("../") && !canonical.startsWith("..\\") ? canonical : input.entry.name;

  const qualityBoost = input.entry.quality === "generated" ? 0 : 0.05;
  const confidenceBoost =
    typeof input.entry.confidence === "number" ? Math.min(0.05, Math.max(0, input.entry.confidence) * 0.05) : 0;
  const score = Math.round(input.score * (1 + qualityBoost + confidenceBoost) * 100) / 100;

  const whyMatched = buildWhyMatched(input.entry, input.query, input.rankingMode, qualityBoost, confidenceBoost);

  const source = findSourceForPath(input.path, input.sources);

  const editable = isEditable(input.path, input.config);
  const hit: LocalSearchHit = {
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

  const renderer = rendererForType(input.entry.type);
  if (renderer?.enrichSearchHit) {
    renderer.enrichSearchHit(hit, entryStashDir);
  }

  return hit;
}

function buildWhyMatched(
  entry: import("./metadata").StashEntry,
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

// ── Helpers ─────────────────────────────────────────────────────────────────

function assetToSearchHit(
  asset: IndexedAsset,
  stashDir: string,
  sources: StashSource[],
  config?: import("./config").AgentikitConfig,
): LocalSearchHit {
  const source = findSourceForPath(asset.path, sources);
  const editable = isEditable(asset.path, config);
  const ref = makeAssetRef(asset.entry.type, asset.entry.name, source?.registryId);
  const fileSize = readFileSize(asset.path);
  const size = deriveSize(fileSize);
  const hit: LocalSearchHit = {
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
  };
  const renderer = rendererForType(asset.entry.type);
  if (renderer?.enrichSearchHit) {
    renderer.enrichSearchHit(hit, stashDir);
  }
  return hit;
}

function normalizeLimit(limit?: number): number {
  if (typeof limit !== "number" || Number.isNaN(limit) || limit <= 0) {
    return DEFAULT_LIMIT;
  }
  return Math.min(Math.floor(limit), 200);
}

function parseSearchSource(source: SearchSource | undefined): SearchSource {
  if (source === "local" || source === "registry" || source === "both") return source;
  if (typeof source === "undefined") return "local";
  throw new UsageError(`Invalid search source: ${String(source)}. Expected one of: local|registry|both`);
}

function mergeSearchHits(
  localHits: LocalSearchHit[],
  registryHits: RegistrySearchResultHit[],
  limit: number,
): SearchHit[] {
  const all: SearchHit[] = [...localHits, ...registryHits];
  all.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  return all.slice(0, limit);
}

/** Map asset types to their primary renderer names. */
const TYPE_TO_RENDERER: Record<AgentikitAssetType, string> = {
  script: "script-source",
  skill: "skill-md",
  command: "command-md",
  agent: "agent-md",
  knowledge: "knowledge-md",
};

function rendererForType(type: AgentikitAssetType) {
  return getRenderer(TYPE_TO_RENDERER[type]);
}

function buildLocalAction(type: AgentikitAssetType, ref: string): string {
  switch (type) {
    case "script":
      return `akm show ${ref} -> execute the run command`;
    case "skill":
      return `akm show ${ref} -> follow the instructions`;
    case "command":
      return `akm show ${ref} -> fill placeholders and dispatch`;
    case "agent":
      return `akm show ${ref} -> dispatch with full prompt`;
    case "knowledge":
      return `akm show ${ref} -> read reference material`;
  }
}

function deriveSize(bytes?: number): SearchHitSize | undefined {
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

function indexAssets(stashDir: string, type: AgentikitSearchType): IndexedAsset[] {
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
        const generated = generateMetadataFlat(stashDir, uncoveredFiles);
        if (generated.entries.length > 0) {
          stash = { entries: [...stash.entries, ...generated.entries] };
        }
      }
    } else {
      const generated = generateMetadataFlat(stashDir, files);
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
