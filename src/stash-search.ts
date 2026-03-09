import fs from "node:fs"
import path from "node:path"
import { type AgentikitAssetType } from "./common"
import { ASSET_TYPES, TYPE_DIRS, deriveCanonicalAssetName } from "./asset-spec"
import { buildSearchText } from "./indexer"
import { walkStash } from "./walker"
import { makeOpenRef } from "./stash-ref"
import type {
  AgentikitSearchType,
  LocalSearchHit,
  RegistrySearchResultHit,
  SearchHit,
  SearchResponse,
  SearchSource,
  SearchUsageMode,
} from "./stash-types"
import { loadConfig } from "./config"
import { searchRegistry } from "./registry-search"
import {
  openDatabase,
  closeDatabase,
  getDbPath,
  getMeta,
  searchFts,
  searchVec,
  getAllEntries,
  getEntryCount,
  getEntryById,
  isVecAvailable,
  type DbSearchResult,
} from "./db"
import { tryGetHandler } from "./asset-type-handler"
import { type StashSource, resolveStashSources, findSourceForPath } from "./stash-source"

// Ensure handlers are registered
import "./handlers/index"

type IndexedAsset = {
  type: AgentikitAssetType
  name: string
  path: string
}

const DEFAULT_LIMIT = 20

export async function agentikitSearch(input: {
  query: string
  type?: AgentikitSearchType
  limit?: number
  usage?: SearchUsageMode
  source?: SearchSource
}): Promise<SearchResponse> {
  const t0 = Date.now()
  const query = input.query.trim()
  const normalizedQuery = query.toLowerCase()
  const searchType = input.type ?? "any"
  const limit = normalizeLimit(input.limit)
  const usageMode = parseSearchUsageMode(input.usage)
  const source = parseSearchSource(input.source)
  const sources = resolveStashSources()
  const stashDir = sources[0].path
  const localResult = source === "registry"
    ? undefined
    : await searchLocal({
      query: normalizedQuery,
      searchType,
      limit,
      usageMode,
      stashDir,
      sources,
    })

  const registryResult = source === "local"
    ? undefined
    : await searchRegistry(query, { limit })

  if (source === "local") {
    return {
      stashDir,
      source,
      hits: localResult?.hits ?? [],
      usageGuide: localResult?.usageGuide,
      tip: localResult?.tip,
      timing: { totalMs: Date.now() - t0, rankMs: localResult?.rankMs, embedMs: localResult?.embedMs },
    }
  }

  const registryHits = (registryResult?.hits ?? []).map((hit): RegistrySearchResultHit => {
    const installRef = hit.source === "npm" ? `npm:${hit.ref}` : `github:${hit.ref}`
    return {
      hitSource: "registry",
      type: "registry",
      name: hit.title,
      id: hit.id,
      registrySource: hit.source,
      ref: hit.ref,
      description: hit.description,
      homepage: hit.homepage,
      score: hit.score,
      metadata: hit.metadata,
      installRef,
      installCmd: `akm add ${installRef}`,
    }
  })

  if (source === "registry") {
    const hits = registryHits.slice(0, limit)
    return {
      stashDir,
      source,
      hits,
      tip: hits.length === 0 ? "No matching registry entries were found." : undefined,
      warnings: registryResult?.warnings.length ? registryResult.warnings : undefined,
      timing: { totalMs: Date.now() - t0 },
    }
  }

  const mergedHits = mergeSearchHits(localResult?.hits ?? [], registryHits, limit)

  return {
    stashDir,
    source,
    hits: mergedHits,
    usageGuide: localResult?.usageGuide,
    tip: mergedHits.length === 0 ? "No matching stash assets or registry entries were found." : undefined,
    warnings: registryResult?.warnings.length ? registryResult.warnings : undefined,
    timing: { totalMs: Date.now() - t0 },
  }
}

async function searchLocal(input: {
  query: string
  searchType: AgentikitSearchType
  limit: number
  usageMode: SearchUsageMode
  stashDir: string
  sources: StashSource[]
}): Promise<{ hits: LocalSearchHit[]; usageGuide?: Partial<Record<AgentikitAssetType, string[]>>; tip?: string; embedMs?: number; rankMs?: number }> {
  const { query, searchType, limit, usageMode, stashDir, sources } = input
  const config = loadConfig()
  const allStashDirs = sources.map((s) => s.path)

  // Try to open the database
  const dbPath = getDbPath()
  try {
    if (fs.existsSync(dbPath)) {
      const db = openDatabase(dbPath)
      try {
        const entryCount = getEntryCount(db)
        const storedStashDir = getMeta(db, "stashDir")
        if (entryCount > 0 && storedStashDir === stashDir) {
          const { hits, usageGuide, embedMs, rankMs } = await searchDatabase(db, query, searchType, limit, stashDir, allStashDirs, config, usageMode, sources)
          return {
            hits,
            usageGuide,
            tip: hits.length === 0 ? "No matching stash assets were found. Try running 'akm index' to rebuild." : undefined,
            embedMs,
            rankMs,
          }
        }
      } finally {
        closeDatabase(db)
      }
    }
  } catch {
    // DB not available, fall through to substring search
  }

  const hits = allStashDirs
    .flatMap((dir) => substringSearch(query, searchType, limit, dir, sources))
    .slice(0, limit)
  const usageGuide = shouldIncludeUsageGuide(usageMode) ? buildUsageGuide(hits.map((hit) => hit.type), searchType) : undefined
  return {
    hits,
    usageGuide,
    tip: hits.length === 0 ? "No matching stash assets were found. Try running 'akm index' to rebuild." : undefined,
  }
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
  usageMode: SearchUsageMode,
  sources: StashSource[],
): Promise<{ hits: LocalSearchHit[]; usageGuide?: Partial<Record<AgentikitAssetType, string[]>>; embedMs?: number; rankMs?: number }> {
  // Empty query: return all entries
  if (!query) {
    const typeFilter = searchType === "any" ? undefined : searchType
    const allEntries = getAllEntries(db, typeFilter)
    const selected = allEntries.slice(0, limit)
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
        includeItemUsage: shouldIncludeItemUsage(usageMode),
      }),
    )
    return {
      hits,
      usageGuide: shouldIncludeUsageGuide(usageMode)
        ? buildUsageGuideFromEntries(selected.map((e) => e.entry), searchType)
        : undefined,
    }
  }

  // Score using FTS5 (BM25) and optionally sqlite-vec
  const tEmbed0 = Date.now()
  const embeddingScores = await tryVecScores(db, query, limit * 3, config)
  const embedMs = Date.now() - tEmbed0

  const tRank0 = Date.now()
  const typeFilter = searchType === "any" ? undefined : searchType
  const ftsResults = searchFts(db, query, limit * 3, typeFilter)

  // Build score map from FTS results (normalize BM25 scores)
  const ftsScoreMap = new Map<number, { score: number; result: DbSearchResult }>()
  for (const r of ftsResults) {
    // BM25 returns negative scores (more negative = better match), normalize to 0-1
    const absScore = Math.abs(r.bm25Score)
    const normalized = absScore / (1 + absScore)
    ftsScoreMap.set(r.id, { score: normalized, result: r })
  }

  // Blend scores
  const scored: Array<{ id: number; entry: import("./metadata").StashEntry; filePath: string; score: number; rankingMode: "semantic" | "fts" }> = []
  const seenIds = new Set<number>()

  // Process FTS results
  for (const [id, { score: ftsScore, result }] of ftsScoreMap) {
    seenIds.add(id)
    const embScore = embeddingScores?.get(id)

    if (embScore !== undefined) {
      const blended = embScore * 0.7 + ftsScore * 0.3
      if (blended > 0) scored.push({ id, entry: result.entry, filePath: result.filePath, score: blended, rankingMode: "semantic" })
    } else if (ftsScore > 0) {
      scored.push({ id, entry: result.entry, filePath: result.filePath, score: ftsScore, rankingMode: "fts" })
    }
  }

  // Add vec-only results not already in FTS results
  if (embeddingScores) {
    for (const [id, embScore] of embeddingScores) {
      if (seenIds.has(id)) continue
      const found = getEntryById(db, id)
      if (found) {
        scored.push({
          id,
          entry: found.entry,
          filePath: found.filePath,
          score: embScore,
          rankingMode: "semantic",
        })
      }
    }
  }

  // Apply boosts (tag, intent, name matches)
  const queryTokens = query.toLowerCase().split(/\s+/).filter(Boolean)
  for (const item of scored) {
    const entry = item.entry
    // Tag boost
    if (entry.tags) {
      for (const tag of entry.tags) {
        if (queryTokens.some((t) => tag.toLowerCase() === t)) {
          item.score += 0.15
        }
      }
    }
    // Intent boost
    if (entry.intents) {
      for (const intent of entry.intents) {
        const intentLower = intent.toLowerCase()
        for (const token of queryTokens) {
          if (intentLower.includes(token)) {
            item.score += 0.12
            break
          }
        }
      }
    }
    // Name boost
    const nameLower = entry.name.toLowerCase().replace(/[-_]/g, " ")
    if (queryTokens.some((t) => nameLower.includes(t))) {
      item.score += 0.1
    }
  }

  scored.sort((a, b) => b.score - a.score)
  const rankMs = Date.now() - tRank0

  const selected = scored.slice(0, limit)
  const hits = selected.map(({ entry, filePath, score, rankingMode }) =>
    buildDbHit({
      entry,
      path: filePath,
      score: Math.round(score * 1000) / 1000,
      query,
      rankingMode,
      defaultStashDir: stashDir,
      allStashDirs,
      sources,
      includeItemUsage: shouldIncludeItemUsage(usageMode),
    }),
  )

  return {
    embedMs,
    rankMs,
    hits,
    usageGuide: shouldIncludeUsageGuide(usageMode)
      ? buildUsageGuideFromEntries(selected.map((item) => item.entry), searchType)
      : undefined,
  }
}

// ── Vector scorer ───────────────────────────────────────────────────────────

async function tryVecScores(
  db: import("bun:sqlite").Database,
  query: string,
  k: number,
  config: import("./config").AgentikitConfig,
): Promise<Map<number, number> | null> {
  if (!config.semanticSearch || !isVecAvailable()) return null
  const hasEmbeddings = getMeta(db, "hasEmbeddings")
  if (hasEmbeddings !== "1") return null

  try {
    const { embed } = await import("./embedder.js")
    const queryEmbedding = await embed(query, config.embedding)
    const vecResults = searchVec(db, queryEmbedding, k)

    const scores = new Map<number, number>()
    for (const { id, distance } of vecResults) {
      // Convert L2 distance to cosine similarity (vectors are normalized)
      const cosineSim = 1 - (distance * distance) / 2
      scores.set(id, Math.max(0, cosineSim))
    }
    return scores
  } catch {
    return null
  }
}

// ── Substring fallback (no index) ───────────────────────────────────────────

function substringSearch(
  query: string,
  searchType: AgentikitSearchType,
  limit: number,
  stashDir: string,
  sources: StashSource[],
): LocalSearchHit[] {
  const assets = indexAssets(stashDir, searchType)
  return assets
    .filter((asset) => asset.name.toLowerCase().includes(query))
    .sort(compareAssets)
    .slice(0, limit)
    .map((asset) => assetToSearchHit(asset, stashDir, sources))
}

// ── Hit building ────────────────────────────────────────────────────────────

function findStashDirForPath(filePath: string, stashDirs: string[]): string | undefined {
  const resolved = path.resolve(filePath)
  for (const dir of stashDirs) {
    if (resolved.startsWith(path.resolve(dir) + path.sep)) return dir
  }
  return undefined
}

function buildDbHit(input: {
  entry: import("./metadata").StashEntry
  path: string
  score: number
  query: string
  rankingMode: "semantic" | "fts"
  defaultStashDir: string
  allStashDirs: string[]
  sources: StashSource[]
  includeItemUsage: boolean
}): LocalSearchHit {
  const entryStashDir = findStashDirForPath(input.path, input.allStashDirs) ?? input.defaultStashDir
  const typeRoot = path.join(entryStashDir, TYPE_DIRS[input.entry.type])
  const openRefName = deriveCanonicalAssetName(input.entry.type, typeRoot, input.path)
    ?? input.entry.name

  const qualityBoost = input.entry.generated === true ? 0 : 0.05
  const confidenceBoost = typeof input.entry.confidence === "number" ? Math.min(0.05, Math.max(0, input.entry.confidence) * 0.05) : 0
  const score = Math.round((input.score + qualityBoost + confidenceBoost) * 1000) / 1000

  const whyMatched = buildWhyMatched(input.entry, input.query, input.rankingMode, qualityBoost, confidenceBoost)

  const source = findSourceForPath(input.path, input.sources)

  const hit: LocalSearchHit = {
    hitSource: "local",
    type: input.entry.type,
    name: input.entry.name,
    path: input.path,
    openRef: makeOpenRef(input.entry.type, openRefName, source?.kind, source?.registryId),
    sourceKind: source?.kind,
    registryId: source?.registryId,
    editable: source?.writable ?? false,
    description: input.entry.description,
    tags: input.entry.tags,
    score,
    whyMatched,
  }

  if (input.includeItemUsage && input.entry.usage && input.entry.usage.length > 0) {
    hit.usage = input.entry.usage
  }

  const handler = tryGetHandler(input.entry.type)
  if (handler?.enrichSearchHit) {
    handler.enrichSearchHit(hit, entryStashDir)
  }

  return hit
}

function buildWhyMatched(
  entry: import("./metadata").StashEntry,
  query: string,
  rankingMode: "semantic" | "fts",
  qualityBoost: number,
  confidenceBoost: number,
): string[] {
  const reasons: string[] = [rankingMode === "semantic" ? "semantic similarity" : "fts bm25 relevance"]
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean)

  const name = entry.name.toLowerCase()
  const tags = entry.tags?.join(" ").toLowerCase() ?? ""
  const intents = entry.intents?.join(" ").toLowerCase() ?? ""
  const aliases = entry.aliases?.join(" ").toLowerCase() ?? ""

  if (tokens.some((t) => name.includes(t))) reasons.push("matched name tokens")
  if (tokens.some((t) => tags.includes(t))) reasons.push("matched tags")
  if (tokens.some((t) => intents.includes(t))) reasons.push("matched intents")
  if (tokens.some((t) => aliases.includes(t))) reasons.push("matched aliases")
  if (qualityBoost > 0) reasons.push("curated metadata boost")
  if (confidenceBoost > 0) reasons.push("metadata confidence boost")

  return reasons
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function assetToSearchHit(asset: IndexedAsset, stashDir: string, sources: StashSource[]): LocalSearchHit {
  const source = findSourceForPath(asset.path, sources)
  const hit: LocalSearchHit = {
    hitSource: "local",
    type: asset.type,
    name: asset.name,
    path: asset.path,
    openRef: makeOpenRef(asset.type, asset.name, source?.kind, source?.registryId),
    sourceKind: source?.kind,
    registryId: source?.registryId,
    editable: source?.writable ?? false,
  }
  const handler = tryGetHandler(asset.type)
  if (handler?.enrichSearchHit) {
    handler.enrichSearchHit(hit, stashDir)
  }
  return hit
}

function normalizeLimit(limit?: number): number {
  if (typeof limit !== "number" || Number.isNaN(limit) || limit <= 0) {
    return DEFAULT_LIMIT
  }
  return Math.min(Math.floor(limit), 200)
}

function parseSearchUsageMode(mode: SearchUsageMode | undefined): SearchUsageMode {
  if (mode === "none" || mode === "both" || mode === "item" || mode === "guide") {
    return mode
  }
  if (typeof mode === "undefined") return "both"
  throw new Error(`Invalid usage mode: ${String(mode)}. Expected one of: none|both|item|guide`)
}

function parseSearchSource(source: SearchSource | undefined): SearchSource {
  if (source === "local" || source === "registry" || source === "both") return source
  if (typeof source === "undefined") return "local"
  throw new Error(`Invalid search source: ${String(source)}. Expected one of: local|registry|both`)
}

function mergeSearchHits(localHits: LocalSearchHit[], registryHits: RegistrySearchResultHit[], limit: number): SearchHit[] {
  const merged: SearchHit[] = []
  let localIndex = 0
  let registryIndex = 0

  while (merged.length < limit && (localIndex < localHits.length || registryIndex < registryHits.length)) {
    if (localIndex < localHits.length) {
      merged.push(localHits[localIndex])
      localIndex += 1
      if (merged.length >= limit) break
    }
    if (registryIndex < registryHits.length) {
      merged.push(registryHits[registryIndex])
      registryIndex += 1
    }
  }

  return merged
}

function shouldIncludeUsageGuide(mode: SearchUsageMode): boolean {
  return mode === "both" || mode === "guide"
}

function shouldIncludeItemUsage(mode: SearchUsageMode): boolean {
  return mode === "both" || mode === "item"
}

function buildUsageGuideFromEntries(
  entries: import("./metadata").StashEntry[],
  searchType: AgentikitSearchType,
): Partial<Record<AgentikitAssetType, string[]>> | undefined {
  const types = entries.map((entry) => entry.type)
  const fallbackGuide = buildUsageGuide(types, searchType)
  const metadataByType = new Map<AgentikitAssetType, string[]>()

  for (const entry of entries) {
    if (!entry.usage || entry.usage.length === 0) continue
    const current = metadataByType.get(entry.type) ?? []
    for (const item of entry.usage) {
      const trimmed = item.trim()
      if (trimmed && !current.includes(trimmed)) current.push(trimmed)
    }
    if (current.length > 0) metadataByType.set(entry.type, current)
  }

  if (!fallbackGuide && metadataByType.size === 0) return undefined

  const result: Partial<Record<AgentikitAssetType, string[]>> = {}
  for (const assetType of resolveGuideTypes(types, searchType)) {
    const lines: string[] = []
    const metadataLines = metadataByType.get(assetType)
    if (metadataLines && metadataLines.length > 0) {
      lines.push(...metadataLines)
    }
    const fallbackLines = fallbackGuide?.[assetType]
    if (fallbackLines && fallbackLines.length > 0) {
      for (const line of fallbackLines) {
        if (!lines.includes(line)) lines.push(line)
      }
    }
    if (lines.length > 0) result[assetType] = lines
  }

  return Object.keys(result).length > 0 ? result : undefined
}

function buildUsageGuide(
  hitTypes: AgentikitAssetType[],
  searchType: AgentikitSearchType,
): Partial<Record<AgentikitAssetType, string[]>> | undefined {
  const result: Partial<Record<AgentikitAssetType, string[]>> = {}
  for (const assetType of resolveGuideTypes(hitTypes, searchType)) {
    result[assetType] = usageGuideByType(assetType)
  }
  return Object.keys(result).length > 0 ? result : undefined
}

function resolveGuideTypes(hitTypes: AgentikitAssetType[], searchType: AgentikitSearchType): AgentikitAssetType[] {
  if (searchType !== "any") return [searchType]
  return Array.from(new Set(hitTypes))
}

function usageGuideByType(type: AgentikitAssetType): string[] {
  const handler = tryGetHandler(type)
  return handler?.defaultUsageGuide ?? []
}

function fileToAsset(assetType: AgentikitAssetType, root: string, file: string): IndexedAsset | undefined {
  const name = deriveCanonicalAssetName(assetType, root, file)
  if (!name) return undefined
  return { type: assetType, name, path: file }
}

function indexAssets(stashDir: string, type: AgentikitSearchType): IndexedAsset[] {
  const assets: IndexedAsset[] = []
  const types = type === "any" ? ASSET_TYPES : [type]
  for (const assetType of types) {
    const root = path.join(stashDir, TYPE_DIRS[assetType])
    const groups = walkStash(root, assetType)
    for (const { files } of groups) {
      for (const file of files) {
        const asset = fileToAsset(assetType, root, file)
        if (asset) assets.push(asset)
      }
    }
  }
  return assets
}

function compareAssets(a: IndexedAsset, b: IndexedAsset): number {
  if (a.type !== b.type) return a.type.localeCompare(b.type)
  return a.name.localeCompare(b.name)
}
