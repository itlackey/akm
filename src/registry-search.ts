import type { RegistrySearchHit, RegistrySearchResponse } from "./registry-types"

const GITHUB_API_BASE = "https://api.github.com"

export interface RegistrySearchOptions {
  limit?: number
}

export async function searchRegistry(query: string, options?: RegistrySearchOptions): Promise<RegistrySearchResponse> {
  const trimmed = query.trim()
  if (!trimmed) {
    return { query: "", hits: [], warnings: [] }
  }

  const limit = clampLimit(options?.limit)
  const [npmResult, githubResult] = await Promise.allSettled([
    searchNpm(trimmed, limit),
    searchGithub(trimmed, limit),
  ])

  const hits: RegistrySearchHit[] = []
  const warnings: string[] = []

  if (npmResult.status === "fulfilled") {
    hits.push(...npmResult.value)
  } else {
    warnings.push(`npm search failed: ${toErrorMessage(npmResult.reason)}`)
  }

  if (githubResult.status === "fulfilled") {
    hits.push(...githubResult.value)
  } else {
    warnings.push(`GitHub search failed: ${toErrorMessage(githubResult.reason)}`)
  }

  hits.sort((a, b) => (b.score ?? 0) - (a.score ?? 0))

  return {
    query: trimmed,
    hits: hits.slice(0, limit * 2),
    warnings,
  }
}

async function searchNpm(query: string, limit: number): Promise<RegistrySearchHit[]> {
  const url = `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(query)}&size=${limit}`
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`)
  }
  const data = await response.json() as Record<string, unknown>
  const objects = Array.isArray(data.objects) ? data.objects : []

  return objects.flatMap((raw): RegistrySearchHit[] => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return []
    const obj = raw as Record<string, unknown>
    const pkg = asRecord(obj.package)
    const name = asString(pkg.name)
    if (!name) return []

    const version = asString(pkg.version)
    const metadata: Record<string, string> = {}
    if (version) metadata.version = version
    const date = asString(pkg.date)
    if (date) metadata.updatedAt = date

    return [{
      source: "npm",
      id: `npm:${name}`,
      title: name,
      description: asString(pkg.description),
      ref: name,
      homepage: asString(asRecord(pkg.links).homepage),
      score: asNumber(obj.score),
      metadata,
    }]
  })
}

async function searchGithub(query: string, limit: number): Promise<RegistrySearchHit[]> {
  const q = encodeURIComponent(`${query} in:name,description,readme`)
  const url = `${GITHUB_API_BASE}/search/repositories?q=${q}&sort=stars&order=desc&per_page=${limit}`
  const response = await fetch(url, { headers: githubHeaders() })
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`)
  }
  const data = await response.json() as Record<string, unknown>
  const items = Array.isArray(data.items) ? data.items : []

  return items.flatMap((raw): RegistrySearchHit[] => {
    const repo = asRecord(raw)
    const fullName = asString(repo.full_name)
    if (!fullName) return []

    const metadata: Record<string, string> = {}
    const stars = asNumber(repo.stargazers_count)
    if (stars > 0) metadata.stars = String(stars)
    const language = asString(repo.language)
    if (language) metadata.language = language

    return [{
      source: "github",
      id: `github:${fullName}`,
      title: fullName,
      description: asString(repo.description),
      ref: fullName,
      homepage: asString(repo.html_url),
      score: stars,
      metadata,
    }]
  })
}

function githubHeaders(): HeadersInit {
  const token = process.env.GITHUB_TOKEN?.trim()
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "agentikit-registry",
  }
  if (token) headers.Authorization = `Bearer ${token}`
  return headers
}

function clampLimit(limit: number | undefined): number {
  if (!limit || !Number.isFinite(limit)) return 20
  return Math.min(100, Math.max(1, Math.trunc(limit)))
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
