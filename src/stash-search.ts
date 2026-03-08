import fs from "node:fs"
import path from "node:path"
import { type AgentikitAssetType, hasErrnoCode, resolveStashDir } from "./common"
import { ASSET_TYPES, TYPE_DIRS, deriveCanonicalAssetName } from "./asset-spec"
import { loadSearchIndex, buildSearchText, type IndexedEntry } from "./indexer"
import { TfIdfAdapter, type ScoredEntry } from "./similarity"
import { buildToolInfo } from "./tool-runner"
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

type IndexedAsset = {
  type: AgentikitAssetType
  name: string
  path: string
}

const DEFAULT_LIMIT = 20

const DEFAULT_USAGE_GUIDE_BY_TYPE: Record<AgentikitAssetType, string[]> = {
  tool: [
    "Use the hit's runCmd for execution so runtime and working directory stay correct.",
    "Use `akm show <openRef>` to inspect the tool before running it.",
  ],
  skill: [
    "Read and apply the skill instructions as written, then adapt examples to your current repo state and task.",
    "Use `akm show <openRef>` to read the full SKILL.md for required steps and constraints.",
  ],
  command: [
    "Read the .md file, fill placeholders, and run it in the current repo context.",
    "Use `akm show <openRef>` to retrieve the command template body.",
  ],
  agent: [
    "Read the .md file and dispatch and agent using the content of the file. Use modelHint/toolPolicy when present to run the agent with compatible settings.",
    "Use with `akm show <openRef>` to get the full prompt payload.",
  ],
  knowledge: [
    "Use `akm show <openRef>` to read the document; start with `--view toc` for large files.",
    "Use `--view section` or `--view lines` to load only the part you need.",
  ],
}

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
  const stashDir = resolveStashDir()
  const localResult = source === "registry"
    ? undefined
    : await searchLocal({
      query: normalizedQuery,
      searchType,
      limit,
      usageMode,
      stashDir,
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
}): Promise<{ hits: LocalSearchHit[]; usageGuide?: Partial<Record<AgentikitAssetType, string[]>>; tip?: string; embedMs?: number; rankMs?: number }> {
  const { query, searchType, limit, usageMode, stashDir } = input
  const config = loadConfig(stashDir)
  const allStashDirs = [
    stashDir,
    ...config.additionalStashDirs.filter((d) => {
      try { return fs.statSync(d).isDirectory() } catch { return false }
    }),
  ]

  const index = loadSearchIndex()
  if (index && index.entries && index.entries.length > 0 && index.stashDir === stashDir) {
    const { hits, usageGuide, embedMs, rankMs } = await searchIndex(index, query, searchType, limit, stashDir, allStashDirs, config, usageMode)
    return {
      hits,
      usageGuide,
      tip: hits.length === 0 ? "No matching stash assets were found. Try running 'akm index' to rebuild." : undefined,
      embedMs,
      rankMs,
    }
  }

  const hits = allStashDirs
    .flatMap((dir) => substringSearch(query, searchType, limit, dir))
    .slice(0, limit)
  const usageGuide = shouldIncludeUsageGuide(usageMode) ? buildUsageGuide(hits.map((hit) => hit.type), searchType) : undefined
  return {
    hits,
    usageGuide,
    tip: hits.length === 0 ? "No matching stash assets were found. Try running 'akm index' to rebuild." : undefined,
  }
}

// ── Unified indexed search ──────────────────────────────────────────────────

async function searchIndex(
  index: import("./indexer").SearchIndex,
  query: string,
  searchType: AgentikitSearchType,
  limit: number,
  stashDir: string,
  allStashDirs: string[],
  config: import("./config").AgentikitConfig,
  usageMode: SearchUsageMode,
): Promise<{ hits: LocalSearchHit[]; usageGuide?: Partial<Record<AgentikitAssetType, string[]>>; embedMs?: number; rankMs?: number }> {
  // Filter candidates by type
  let candidates = index.entries
  if (searchType !== "any") {
    candidates = candidates.filter((ie) => ie.entry.type === searchType)
  }

  if (candidates.length === 0) {
    return {
      hits: [],
      usageGuide: shouldIncludeUsageGuide(usageMode) ? buildUsageGuide([], searchType) : undefined,
    }
  }

  // Empty query: return all entries (no scoring needed)
  if (!query) {
    const selectedCandidates = candidates.slice(0, limit)
    const hits = selectedCandidates.map((ie) =>
      buildIndexedHit({
        entry: ie.entry,
        path: ie.path,
        score: 1,
        query,
        rankingMode: "tfidf",
        defaultStashDir: stashDir,
        allStashDirs,
        includeItemUsage: shouldIncludeItemUsage(usageMode),
      }),
    )
    return {
      hits,
      usageGuide: shouldIncludeUsageGuide(usageMode)
        ? buildUsageGuideFromEntries(selectedCandidates.map((candidate) => candidate.entry), searchType)
        : undefined,
    }
  }

  // Score each candidate using available signals
  const tEmbed0 = Date.now()
  const embeddingScores = await tryEmbeddingScores(candidates, query, config)
  const embedMs = Date.now() - tEmbed0

  const tRank0 = Date.now()
  const tfidfScores = computeTfidfScores(index, candidates, query, searchType)

  const scored: Array<{ ie: IndexedEntry; score: number; rankingMode: "semantic" | "tfidf" }> = []

  for (const ie of candidates) {
    const key = ie.path
    const embScore = embeddingScores?.get(key)
    const tfidfScore = tfidfScores.get(key) ?? 0

    if (embScore !== undefined) {
      // Weighted blend: embedding dominates when available, TF-IDF boosts lexical matches
      const blended = embScore * 0.7 + tfidfScore * 0.3
      if (blended > 0) scored.push({ ie, score: blended, rankingMode: "semantic" })
    } else if (tfidfScore > 0) {
      scored.push({ ie, score: tfidfScore, rankingMode: "tfidf" })
    }
  }

  scored.sort((a, b) => b.score - a.score)
  const rankMs = Date.now() - tRank0

  const selected = scored.slice(0, limit)
  const hits = selected.map(({ ie, score, rankingMode }) =>
    buildIndexedHit({
      entry: ie.entry,
      path: ie.path,
      score: Math.round(score * 1000) / 1000,
      query,
      rankingMode,
      defaultStashDir: stashDir,
      allStashDirs,
      includeItemUsage: shouldIncludeItemUsage(usageMode),
    }),
  )

  return {
    embedMs,
    rankMs,
    hits,
    usageGuide: shouldIncludeUsageGuide(usageMode)
      ? buildUsageGuideFromEntries(selected.map((item) => item.ie.entry), searchType)
      : undefined,
  }
}

// ── Embedding scorer ────────────────────────────────────────────────────────

async function tryEmbeddingScores(
  candidates: IndexedEntry[],
  query: string,
  config: import("./config").AgentikitConfig,
): Promise<Map<string, number> | null> {
  if (!config.semanticSearch) return null

  const withEmbeddings = candidates.filter((ie) => ie.embedding && ie.embedding.length > 0)
  if (withEmbeddings.length === 0) return null

  try {
    const { embed, cosineSimilarity } = await import("./embedder.js")
    const queryEmbedding = await embed(query, config.embedding)
    const scores = new Map<string, number>()
    for (const ie of withEmbeddings) {
      scores.set(ie.path, cosineSimilarity(queryEmbedding, ie.embedding!))
    }
    return scores
  } catch {
    return null
  }
}

// ── TF-IDF scorer ───────────────────────────────────────────────────────────

function computeTfidfScores(
  index: import("./indexer").SearchIndex,
  candidates: IndexedEntry[],
  query: string,
  searchType: AgentikitSearchType,
): Map<string, number> {
  const candidateScoredEntries = toScoredEntries(candidates)

  let adapter: TfIdfAdapter
  if (index.tfidf) {
    const allScored = toScoredEntries(index.entries)
    adapter = TfIdfAdapter.deserialize(index.tfidf, allScored)
  } else {
    adapter = new TfIdfAdapter()
    adapter.buildIndex(candidateScoredEntries)
  }

  const typeFilter = searchType === "any" ? undefined : searchType
  const results = adapter.search(query, candidates.length, typeFilter)

  const scores = new Map<string, number>()
  for (const r of results) {
    scores.set(r.path, r.score)
  }
  return scores
}

// ── Substring fallback (no index) ───────────────────────────────────────────

function substringSearch(
  query: string,
  searchType: AgentikitSearchType,
  limit: number,
  stashDir: string,
): LocalSearchHit[] {
  const assets = indexAssets(stashDir, searchType)
  return assets
    .filter((asset) => asset.name.toLowerCase().includes(query))
    .sort(compareAssets)
    .slice(0, limit)
    .map((asset) => assetToSearchHit(asset, stashDir))
}

// ── Hit building ────────────────────────────────────────────────────────────

function findStashDirForPath(filePath: string, stashDirs: string[]): string | undefined {
  const resolved = path.resolve(filePath)
  for (const dir of stashDirs) {
    if (resolved.startsWith(path.resolve(dir) + path.sep)) return dir
  }
  return undefined
}

function buildIndexedHit(input: {
  entry: IndexedEntry["entry"]
  path: string
  score: number
  query: string
  rankingMode: "semantic" | "tfidf"
  defaultStashDir: string
  allStashDirs: string[]
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

  const hit: LocalSearchHit = {
    hitSource: "local",
    type: input.entry.type,
    name: input.entry.name,
    path: input.path,
    openRef: makeOpenRef(input.entry.type, openRefName),
    description: input.entry.description,
    tags: input.entry.tags,
    score,
    whyMatched,
  }

  if (input.includeItemUsage && input.entry.usage && input.entry.usage.length > 0) {
    hit.usage = input.entry.usage
  }

  if (input.entry.type === "tool") {
    try {
      const toolInfo = buildToolInfo(entryStashDir, input.path)
      hit.runCmd = toolInfo.runCmd
      hit.kind = toolInfo.kind
    } catch (error: unknown) {
      if (!hasErrnoCode(error, "ENOENT")) throw error
    }
  }

  return hit
}

function buildWhyMatched(
  entry: IndexedEntry["entry"],
  query: string,
  rankingMode: "semantic" | "tfidf",
  qualityBoost: number,
  confidenceBoost: number,
): string[] {
  const reasons: string[] = [rankingMode === "semantic" ? "semantic similarity" : "tf-idf lexical relevance"]
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

function toScoredEntries(entries: IndexedEntry[]): ScoredEntry[] {
  return entries.map((ie) => ({
    id: `${ie.entry.type}:${ie.entry.name}`,
    text: buildSearchText(ie.entry),
    entry: ie.entry,
    path: ie.path,
  }))
}

function assetToSearchHit(asset: IndexedAsset, stashDir: string): LocalSearchHit {
  if (asset.type !== "tool") {
    return {
      hitSource: "local",
      type: asset.type,
      name: asset.name,
      path: asset.path,
      openRef: makeOpenRef(asset.type, asset.name),
    }
  }
  const toolInfo = buildToolInfo(stashDir, asset.path)
  return {
    hitSource: "local",
    type: "tool",
    name: asset.name,
    path: asset.path,
    openRef: makeOpenRef("tool", asset.name),
    runCmd: toolInfo.runCmd,
    kind: toolInfo.kind,
  }
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
  entries: IndexedEntry["entry"][],
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
  return DEFAULT_USAGE_GUIDE_BY_TYPE[type]
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
