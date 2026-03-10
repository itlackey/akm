import fs from "node:fs"
import path from "node:path"
import { fetchWithRetry } from "./common"
import type { RegistrySearchHit, RegistrySearchResponse } from "./registry-types"
import { getRegistryIndexCacheDir } from "./paths"

// ── Constants ───────────────────────────────────────────────────────────────

/** Default registry index URL. Override via config or AKM_REGISTRY_URL env var. */
const DEFAULT_REGISTRY_URL =
  "https://raw.githubusercontent.com/itlackey/agentikit-registry/main/index.json"

/** Cache TTL in milliseconds (1 hour). */
const CACHE_TTL_MS = 60 * 60 * 1000

/** Maximum age before cache is considered stale but still usable as fallback (7 days). */
const CACHE_STALE_MS = 7 * 24 * 60 * 60 * 1000

// ── Types ───────────────────────────────────────────────────────────────────

export interface RegistryIndex {
  version: number
  updatedAt: string
  kits: RegistryKitEntry[]
}

export interface RegistryKitEntry {
  id: string
  name: string
  description?: string
  ref: string
  source: "npm" | "github" | "git" | "local"
  homepage?: string
  tags?: string[]
  assetTypes?: string[]
  author?: string
  license?: string
  latestVersion?: string
  /** Whether this entry was manually reviewed and approved */
  curated?: boolean
}

export interface RegistrySearchOptions {
  limit?: number
  /** Override registry URL(s). Accepts a single URL or an array. */
  registryUrls?: string | string[]
}

// ── Public API ──────────────────────────────────────────────────────────────

export async function searchRegistry(
  query: string,
  options?: RegistrySearchOptions,
): Promise<RegistrySearchResponse> {
  const trimmed = query.trim()
  if (!trimmed) {
    return { query: "", hits: [], warnings: [] }
  }

  const limit = clampLimit(options?.limit)
  const urls = resolveRegistryUrls(options?.registryUrls)
  const warnings: string[] = []

  // Load index from all configured registries, merge kits
  const allKits: RegistryKitEntry[] = []
  for (const url of urls) {
    try {
      const index = await loadIndex(url)
      if (index) {
        allKits.push(...index.kits)
      }
    } catch (err) {
      warnings.push(`Registry ${url}: ${toErrorMessage(err)}`)
    }
  }

  // Score and rank
  const hits = scoreKits(allKits, trimmed, limit)

  return { query: trimmed, hits, warnings }
}

// ── Index loading with cache ────────────────────────────────────────────────

async function loadIndex(url: string): Promise<RegistryIndex | null> {
  const cachePath = indexCachePath(url)
  const cached = readCachedIndex(cachePath)

  // Fresh cache: return immediately
  if (cached && !isCacheExpired(cached.mtime)) {
    return cached.index
  }

  // Try to fetch fresh index
  try {
    const response = await fetchWithRetry(url, undefined, { timeout: 10_000 })
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }
    const data = (await response.json()) as unknown
    const index = parseRegistryIndex(data)
    if (index) {
      writeCachedIndex(cachePath, index)
      return index
    }
    throw new Error("Invalid registry index format")
  } catch (err) {
    // Fetch failed — use stale cache if available
    if (cached && !isCacheStale(cached.mtime)) {
      return cached.index
    }
    throw err
  }
}

function readCachedIndex(
  cachePath: string,
): { index: RegistryIndex; mtime: number } | null {
  try {
    const stat = fs.statSync(cachePath)
    const raw = JSON.parse(fs.readFileSync(cachePath, "utf8"))
    const index = parseRegistryIndex(raw)
    if (!index) return null
    return { index, mtime: stat.mtimeMs }
  } catch {
    return null
  }
}

function writeCachedIndex(cachePath: string, index: RegistryIndex): void {
  try {
    const dir = path.dirname(cachePath)
    fs.mkdirSync(dir, { recursive: true })
    const tmpPath = cachePath + `.tmp.${process.pid}`
    fs.writeFileSync(tmpPath, JSON.stringify(index), "utf8")
    fs.renameSync(tmpPath, cachePath)
  } catch {
    // Best-effort caching — don't fail the search if we can't write
  }
}

function indexCachePath(url: string): string {
  const indexDir = getRegistryIndexCacheDir()
  // Deterministic filename from URL
  const slug = url
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120)
  return path.join(indexDir, `${slug}.json`)
}

function isCacheExpired(mtimeMs: number): boolean {
  return Date.now() - mtimeMs > CACHE_TTL_MS
}

function isCacheStale(mtimeMs: number): boolean {
  return Date.now() - mtimeMs > CACHE_STALE_MS
}

// ── Index parsing ───────────────────────────────────────────────────────────

function parseRegistryIndex(data: unknown): RegistryIndex | null {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null
  const obj = data as Record<string, unknown>

  if (typeof obj.version !== "number" || obj.version !== 1) return null
  if (typeof obj.updatedAt !== "string") return null
  if (!Array.isArray(obj.kits)) return null

  const kits = obj.kits.flatMap((raw): RegistryKitEntry[] => {
    const kit = parseKitEntry(raw)
    return kit ? [kit] : []
  })

  return { version: 1, updatedAt: obj.updatedAt, kits }
}

function parseKitEntry(raw: unknown): RegistryKitEntry | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null
  const obj = raw as Record<string, unknown>

  const id = asString(obj.id)
  const name = asString(obj.name)
  const ref = asString(obj.ref)
  const source = asSource(obj.source)
  if (!id || !name || !ref || !source) return null

  return {
    id,
    name,
    ref,
    source,
    description: asString(obj.description),
    homepage: asString(obj.homepage),
    tags: asStringArray(obj.tags),
    assetTypes: asStringArray(obj.assetTypes),
    author: asString(obj.author),
    license: asString(obj.license),
    latestVersion: asString(obj.latestVersion),
    curated: obj.curated === true ? true : undefined,
  }
}

// ── Scoring ─────────────────────────────────────────────────────────────────

function scoreKits(
  kits: RegistryKitEntry[],
  query: string,
  limit: number,
): RegistrySearchHit[] {
  const tokens = query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)

  const scored: Array<{ kit: RegistryKitEntry; score: number }> = []

  for (const kit of kits) {
    const score = scoreKit(kit, tokens)
    if (score > 0) {
      scored.push({ kit, score })
    }
  }

  scored.sort((a, b) => b.score - a.score)

  return scored.slice(0, limit).map(({ kit, score }) => toSearchHit(kit, score))
}

function scoreKit(kit: RegistryKitEntry, tokens: string[]): number {
  let score = 0
  const nameLower = kit.name.toLowerCase()
  const descLower = (kit.description ?? "").toLowerCase()
  const tagsLower = (kit.tags ?? []).map((t) => t.toLowerCase())

  for (const token of tokens) {
    // Exact name match is strongest signal
    if (nameLower === token) {
      score += 1.0
    } else if (nameLower.includes(token)) {
      score += 0.6
    }

    // Tag matches are high-signal (curated keywords)
    if (tagsLower.some((tag) => tag === token)) {
      score += 0.5
    } else if (tagsLower.some((tag) => tag.includes(token))) {
      score += 0.25
    }

    // Description substring
    if (descLower.includes(token)) {
      score += 0.2
    }

    // Author match
    if (kit.author?.toLowerCase().includes(token)) {
      score += 0.15
    }
  }

  // Normalize by token count so multi-word queries don't inflate scores
  return tokens.length > 0 ? score / tokens.length : 0
}

function toSearchHit(kit: RegistryKitEntry, score: number): RegistrySearchHit {
  const metadata: Record<string, string> = {}
  if (kit.latestVersion) metadata.version = kit.latestVersion
  if (kit.author) metadata.author = kit.author
  if (kit.license) metadata.license = kit.license
  if (kit.assetTypes?.length) metadata.assetTypes = kit.assetTypes.join(", ")

  return {
    source: kit.source,
    id: kit.id,
    title: kit.name,
    description: kit.description,
    ref: kit.ref,
    homepage: kit.homepage,
    score: Math.round(score * 1000) / 1000,
    metadata,
    curated: kit.curated,
  }
}

// ── Registry URL resolution ─────────────────────────────────────────────────

function resolveRegistryUrls(override?: string | string[]): string[] {
  if (override) {
    const urls = Array.isArray(override) ? override : [override]
    return urls.filter(Boolean)
  }

  // Allow env var override (comma-separated)
  const envUrls = process.env.AKM_REGISTRY_URL?.trim()
  if (envUrls) {
    return envUrls.split(",").map((u) => u.trim()).filter(Boolean)
  }

  return [DEFAULT_REGISTRY_URL]
}

// ── Utilities ───────────────────────────────────────────────────────────────

function clampLimit(limit: number | undefined): number {
  if (!limit || !Number.isFinite(limit)) return 20
  return Math.min(100, Math.max(1, Math.trunc(limit)))
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined
}

function asSource(value: unknown): "npm" | "github" | "git" | "local" | undefined {
  if (value === "npm" || value === "github" || value === "git" || value === "local") return value
  return undefined
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const filtered = value.filter((v): v is string => typeof v === "string")
  return filtered.length > 0 ? filtered : undefined
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
