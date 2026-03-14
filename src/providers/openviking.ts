import fs from "node:fs";
import path from "node:path";
import { fetchWithRetry } from "../common";
import type { RegistryConfigEntry } from "../config";
import { getRegistryIndexCacheDir } from "../paths";
import { registerProvider } from "../provider-registry";
import type { RegistryProvider, RegistryProviderResult, RegistryProviderSearchOptions } from "../registry-provider";
import type { RegistryAssetSearchHit } from "../registry-types";

/** Per-query cache TTL in milliseconds (5 minutes). */
const QUERY_CACHE_TTL_MS = 5 * 60 * 1000;

/** Maximum age before query cache is considered stale but still usable (1 hour). */
const QUERY_CACHE_STALE_MS = 60 * 60 * 1000;

interface OVSearchEntry {
  uri: string;
  name: string;
  score: number;
  type?: string;
  abstract?: string;
}

interface OVResponse {
  status: "ok" | "error";
  result: unknown;
  time?: number;
  error?: string;
}

const OV_TYPE_TO_ASSET: Record<string, string> = {
  skill: "skill",
  skills: "skill",
  memory: "memory",
  memories: "memory",
  resource: "knowledge",
  resources: "knowledge",
  knowledge: "knowledge",
  agent: "agent",
  agents: "agent",
  command: "command",
  commands: "command",
  script: "script",
  scripts: "script",
};

class OpenVikingProvider implements RegistryProvider {
  readonly type = "openviking";
  private readonly config: RegistryConfigEntry;

  constructor(config: RegistryConfigEntry) {
    this.config = config;
  }

  async search(options: RegistryProviderSearchOptions): Promise<RegistryProviderResult> {
    try {
      const entries = await this.fetchResults(options.query, options.limit);
      const limited = entries.slice(0, options.limit);
      // OV results are not installable via `akm add`, so we return them
      // exclusively as asset hits (action = `akm show viking://...`).
      const assetHits = this.mapToAssetHits(limited);
      return { hits: [], assetHits };
    } catch (err) {
      const label = this.config.name ?? "openviking";
      const message = err instanceof Error ? err.message : String(err);
      return { hits: [], warnings: [`Registry ${label}: ${message}`] };
    }
  }

  private async fetchResults(query: string, limit: number): Promise<OVSearchEntry[]> {
    const cachePath = this.queryCachePath(query, limit);
    const cached = this.readQueryCache(cachePath);

    if (cached && !isExpired(cached.mtime, QUERY_CACHE_TTL_MS)) {
      return cached.entries;
    }

    const baseUrl = this.config.url.replace(/\/+$/, "");
    const searchType = (this.config.options?.searchType as string) ?? "semantic";

    try {
      let url: string;
      let body: string;

      if (searchType === "text") {
        url = `${baseUrl}/api/v1/search/grep`;
        body = JSON.stringify({ uri: "viking://", pattern: query, case_insensitive: true });
      } else {
        url = `${baseUrl}/api/v1/search/find`;
        body = JSON.stringify({ query, limit });
      }

      const headers: Record<string, string> = { "Content-Type": "application/json" };
      const apiKey = (this.config.options?.apiKey as string) ?? undefined;
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

      const response = await fetchWithRetry(url, { method: "POST", headers, body }, { timeout: 10_000, retries: 1 });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = (await response.json()) as OVResponse;
      if (data.status !== "ok") {
        throw new Error(data.error ?? "OpenViking returned error status");
      }

      const entries = parseOVSearchResponse(data.result);
      this.writeQueryCache(cachePath, entries);
      return entries;
    } catch (err) {
      if (cached && !isExpired(cached.mtime, QUERY_CACHE_STALE_MS)) {
        return cached.entries;
      }
      throw err;
    }
  }

  private mapToAssetHits(entries: OVSearchEntry[]): RegistryAssetSearchHit[] | undefined {
    if (entries.length === 0) return undefined;

    const registryName = this.config.name ?? "openviking";
    const maxScore = Math.max(...entries.map((e) => e.score), 0.01);

    const hits: RegistryAssetSearchHit[] = entries.map((entry) => {
      const assetType = OV_TYPE_TO_ASSET[entry.type ?? ""] ?? "knowledge";
      const ref = uriToVikingRef(entry.uri);
      return {
        type: "registry-asset" as const,
        assetType,
        assetName: entry.name,
        kit: { id: `openviking:${entry.uri}`, name: entry.name },
        registryName,
        action: `akm show ${ref}`,
        score: Math.round((entry.score / maxScore) * 1000) / 1000,
      };
    });

    return hits.length > 0 ? hits : undefined;
  }

  private queryCachePath(query: string, limit: number): string {
    const cacheDir = getRegistryIndexCacheDir();
    const hasher = new Bun.CryptoHasher("md5");
    hasher.update(this.config.url);
    hasher.update("\0");
    hasher.update(query.trim().toLowerCase());
    hasher.update("\0");
    hasher.update(String(limit));
    hasher.update("\0");
    const searchType = (this.config.options?.searchType as string) ?? "semantic";
    hasher.update(searchType);
    hasher.update("\0");
    const apiKey = (this.config.options?.apiKey as string) ?? "";
    hasher.update(apiKey);
    const hash = hasher.digest("hex");
    return path.join(cacheDir, `openviking-search-${hash}.json`);
  }

  private readQueryCache(cachePath: string): { entries: OVSearchEntry[]; mtime: number } | null {
    try {
      const stat = fs.statSync(cachePath);
      const raw = JSON.parse(fs.readFileSync(cachePath, "utf8"));
      if (!Array.isArray(raw)) return null;
      const entries = raw.filter(isValidOVEntry);
      return { entries, mtime: stat.mtimeMs };
    } catch {
      return null;
    }
  }

  private writeQueryCache(cachePath: string, entries: OVSearchEntry[]): void {
    try {
      const dir = path.dirname(cachePath);
      fs.mkdirSync(dir, { recursive: true });
      const tmpPath = `${cachePath}.tmp.${process.pid}`;
      fs.writeFileSync(tmpPath, JSON.stringify(entries), "utf8");
      fs.renameSync(tmpPath, cachePath);
    } catch {
      // Best-effort caching
    }
  }
}

// ── Self-register ───────────────────────────────────────────────────────────

registerProvider("openviking", (config) => new OpenVikingProvider(config));

// ── Helpers ─────────────────────────────────────────────────────────────────

function uriToVikingRef(uri: string): string {
  // Convert "viking://path/to/thing" → "viking://path/to/thing"
  // If URI doesn't have the scheme, add it
  if (uri.startsWith("viking://")) return uri;
  return `viking://${uri.replace(/^\/+/, "")}`;
}

function parseOVSearchResponse(result: unknown): OVSearchEntry[] {
  // OV search/find returns grouped results: { memories: [...], resources: [...], skills: [...] }
  // OV search/grep returns: { matches: [{ line, uri, content }], count }
  if (Array.isArray(result)) return result.filter(isValidOVEntry);
  if (typeof result !== "object" || result === null) return [];

  const grouped = result as Record<string, unknown>;

  // Handle grep response: { matches: [...], count: N }
  if (Array.isArray(grouped.matches)) {
    return deduplicateGrepMatches(grouped.matches);
  }

  const entries: OVSearchEntry[] = [];
  for (const [category, items] of Object.entries(grouped)) {
    if (category === "total") continue;
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      if (!isValidOVSearchItem(item)) continue;
      entries.push({
        uri: item.uri,
        name: extractNameFromUri(item.uri),
        score: item.score,
        type: item.context_type ?? category,
        abstract: item.abstract ?? undefined,
      });
    }
  }
  return entries;
}

interface OVGrepMatch {
  line: number;
  uri: string;
  content: string;
}

function isValidGrepMatch(item: unknown): item is OVGrepMatch {
  if (typeof item !== "object" || item === null) return false;
  const obj = item as Record<string, unknown>;
  return typeof obj.uri === "string" && typeof obj.content === "string";
}

/** Deduplicate grep matches by URI, keeping the first match content and counting occurrences for score. */
function deduplicateGrepMatches(matches: unknown[]): OVSearchEntry[] {
  const byUri = new Map<string, { content: string; count: number; type: string }>();
  for (const m of matches) {
    if (!isValidGrepMatch(m)) continue;
    const existing = byUri.get(m.uri);
    if (existing) {
      existing.count++;
    } else {
      // Infer type from URI path (e.g. viking://resources/... → resource)
      const pathSegment = m.uri.replace(/^viking:\/\//, "").split("/")[0] ?? "";
      byUri.set(m.uri, { content: m.content, count: 1, type: pathSegment });
    }
  }
  const maxCount = Math.max(...[...byUri.values()].map((v) => v.count), 1);
  const entries: OVSearchEntry[] = [];
  for (const [uri, { content, count, type }] of byUri) {
    entries.push({
      uri,
      name: extractNameFromUri(uri),
      score: count / maxCount,
      type,
      abstract: content.slice(0, 200),
    });
  }
  // Sort by score descending (most matches first)
  entries.sort((a, b) => b.score - a.score);
  return entries;
}

function isValidOVEntry(entry: unknown): entry is OVSearchEntry {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false;
  const obj = entry as Record<string, unknown>;
  return typeof obj.uri === "string" && typeof obj.name === "string" && typeof obj.score === "number";
}

interface OVSearchItem {
  uri: string;
  score: number;
  context_type?: string;
  abstract?: string;
}

function isValidOVSearchItem(item: unknown): item is OVSearchItem {
  if (typeof item !== "object" || item === null || Array.isArray(item)) return false;
  const obj = item as Record<string, unknown>;
  return typeof obj.uri === "string" && typeof obj.score === "number";
}

function extractNameFromUri(uri: string): string {
  const path = uri.replace(/^viking:\/\//, "");
  const segments = path.split("/").filter(Boolean);
  // Use last non-empty segment, strip extension
  const last = segments[segments.length - 1] ?? "unknown";
  return last.replace(/\.[^.]+$/, "");
}

function isExpired(mtimeMs: number, ttlMs: number): boolean {
  return Date.now() - mtimeMs > ttlMs;
}

// ── Exports for testing ─────────────────────────────────────────────────────

export { OpenVikingProvider, uriToVikingRef, parseOVSearchResponse };
