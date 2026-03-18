import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fetchWithRetry } from "../common";
import type { StashConfigEntry } from "../config";
import { ConfigError, NotFoundError } from "../errors";
import { getRegistryIndexCacheDir } from "../paths";
import type { StashProvider, StashSearchOptions, StashSearchResult } from "../stash-provider";
import { registerStashProvider } from "../stash-provider-factory";
import type { KnowledgeView, ShowResponse, StashSearchHit } from "../stash-types";
import { isExpired, sanitizeString } from "./provider-utils";

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

/**
 * Single source of truth for OpenViking type → akm asset type mapping.
 * Used by both search hit mapping and show response mapping.
 */
const OV_TYPE_MAP: Record<string, string> = {
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

class OpenVikingStashProvider implements StashProvider {
  readonly type = "openviking";
  readonly name: string;
  private readonly config: StashConfigEntry;

  constructor(config: StashConfigEntry) {
    this.config = config;
    this.name = config.name ?? "openviking";
    // Validate baseUrl scheme to prevent SSRF via file:// or other non-HTTP schemes
    const rawUrl = config.url ?? "";
    if (rawUrl) {
      try {
        const parsed = new URL(rawUrl);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          throw new ConfigError(
            `OpenViking baseUrl must use http:// or https://, got "${parsed.protocol}" in "${rawUrl}"`,
          );
        }
      } catch (err) {
        if (err instanceof ConfigError) throw err;
        throw new ConfigError(`OpenViking baseUrl is not a valid URL: "${rawUrl}"`);
      }
    }
  }

  async search(options: StashSearchOptions): Promise<StashSearchResult> {
    try {
      const entries = await this.fetchResults(options.query, options.limit);
      const limited = entries.slice(0, options.limit);
      const hits = this.mapToStashHits(limited);
      return { hits };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { hits: [], warnings: [`Stash ${this.name}: ${message}`] };
    }
  }

  async show(ref: string, _view?: KnowledgeView): Promise<ShowResponse> {
    const trimmed = ref.trim();
    // Accept both viking:// URIs (legacy/internal) and type:name refs
    const uri = trimmed.startsWith("viking://") ? trimmed : refToVikingUri(trimmed);
    const baseUrl = this.baseUrl;
    const headers = this.authHeaders;

    const [statResult, contentResult] = await Promise.all([
      fetchOVJson(`${baseUrl}/api/v1/fs/stat?uri=${encodeURIComponent(uri)}`, headers),
      fetchOVJson(`${baseUrl}/api/v1/content/read?uri=${encodeURIComponent(uri)}&offset=0&limit=-1`, headers),
    ]);

    if (statResult == null && contentResult == null) {
      throw new NotFoundError(
        `Could not fetch remote asset "${trimmed}". The OpenViking server at ${baseUrl} may be unreachable or the resource does not exist.`,
      );
    }
    if (contentResult == null) {
      throw new NotFoundError(
        `Content not found for remote asset "${trimmed}". The server returned metadata but no content.`,
      );
    }

    const stat = (typeof statResult === "object" && statResult !== null ? statResult : {}) as Record<string, unknown>;
    const uriPath = uri.replace(/^viking:\/\//, "");
    // Sanitize untrusted fields to strip terminal control characters
    const name = sanitizeString(stat.name) || uriPath.split("/").pop() || "unknown";
    const ovType = sanitizeString(stat.type) || inferTypeFromUri(uri);
    const assetType = OV_TYPE_MAP[ovType] ?? "knowledge";
    const content = typeof contentResult === "string" ? contentResult : "";
    const description = sanitizeString(stat.abstract, 1000) || undefined;
    const assetRef = `${assetType}:${name}`;

    return {
      type: assetType,
      name,
      path: assetRef,
      action: `Remote content from OpenViking — ${assetRef}`,
      content,
      description,
      editable: false,
      origin: "remote" as const,
    };
  }

  canShow(_ref: string): boolean {
    return !!(this.config.url ?? "").trim();
  }

  private get baseUrl(): string {
    return (this.config.url ?? "").replace(/\/+$/, "");
  }

  private get authHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    const apiKey = (this.config.options?.apiKey as string) ?? undefined;
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    return headers;
  }

  private async fetchResults(query: string, limit: number): Promise<OVSearchEntry[]> {
    const cachePath = this.queryCachePath(query, limit);
    const cached = this.readQueryCache(cachePath);

    if (cached && !isExpired(cached.mtime, QUERY_CACHE_TTL_MS)) {
      return cached.entries;
    }

    const baseUrl = this.baseUrl;
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

      const headers: Record<string, string> = { "Content-Type": "application/json", ...this.authHeaders };

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

  private mapToStashHits(entries: OVSearchEntry[]): StashSearchHit[] {
    if (entries.length === 0) return [];

    const maxScore = entries.reduce((max, e) => Math.max(max, e.score), 0.01);

    return entries.map((entry) => {
      const name = sanitizeString(entry.name);
      const abstract = sanitizeString(entry.abstract, 1000);
      const type = sanitizeString(entry.type);
      const assetType = OV_TYPE_MAP[type] ?? "knowledge";
      const ref = `${assetType}:${name}`;
      return {
        type: assetType,
        name,
        path: ref,
        ref,
        origin: this.type,
        editable: false,
        description: abstract || undefined,
        action: `akm show ${ref}`,
        score: Math.round((entry.score / maxScore) * 1000) / 1000,
      };
    });
  }

  private queryCachePath(query: string, limit: number): string {
    const cacheDir = getRegistryIndexCacheDir();
    const hasher = createHash("md5");
    hasher.update(this.config.url ?? "");
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
      const tmpPath = `${cachePath}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`;
      // 0o600: owner read/write only — cache may contain search terms tied to API keys
      fs.writeFileSync(tmpPath, JSON.stringify(entries), { encoding: "utf8", mode: 0o600 });
      fs.renameSync(tmpPath, cachePath);
    } catch {
      // Best-effort caching
    }
  }
}

// ── Self-register ───────────────────────────────────────────────────────────

registerStashProvider("openviking", (config) => new OpenVikingStashProvider(config));

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Convert a type:name ref to a viking:// URI for the OpenViking API.
 * Maps the akm asset type back to the OV plural form (e.g. "skill" -> "skills").
 */
function refToVikingUri(ref: string): string {
  const colon = ref.indexOf(":");
  if (colon <= 0) return `viking://${ref}`;
  const name = ref.slice(colon + 1);
  const type = ref.slice(0, colon);
  const ovDir = AKM_TO_OV_DIR[type] ?? type;
  return `viking://${ovDir}/${name}`;
}

/** Reverse map: akm asset type → OpenViking directory name (plural). */
const AKM_TO_OV_DIR: Record<string, string> = {
  skill: "skills",
  memory: "memories",
  knowledge: "resources",
  agent: "agents",
  command: "commands",
  script: "scripts",
};

function parseOVSearchResponse(result: unknown): OVSearchEntry[] {
  if (Array.isArray(result)) return result.filter(isValidOVEntry);
  if (typeof result !== "object" || result === null) return [];

  const grouped = result as Record<string, unknown>;

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

function deduplicateGrepMatches(matches: unknown[]): OVSearchEntry[] {
  const byUri = new Map<string, { content: string; count: number; type: string }>();
  for (const m of matches) {
    if (!isValidGrepMatch(m)) continue;
    const existing = byUri.get(m.uri);
    if (existing) {
      existing.count++;
    } else {
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
  const uriPath = uri.replace(/^viking:\/\//, "");
  const segments = uriPath.split("/").filter(Boolean);
  const last = segments[segments.length - 1] ?? "unknown";
  return last.replace(/\.[^.]+$/, "");
}

async function fetchOVJson(url: string, headers: Record<string, string>): Promise<unknown> {
  try {
    const response = await fetchWithRetry(url, { headers }, { timeout: 10_000, retries: 1 });
    if (!response.ok) return null;
    const data = (await response.json()) as Record<string, unknown>;
    if (data.status !== "ok") return null;
    return data.result ?? null;
  } catch {
    return null;
  }
}

function inferTypeFromUri(uri: string): string {
  const uriPath = uri.replace(/^viking:\/\//, "");
  const firstSegment = uriPath.split("/")[0] ?? "";
  return OV_TYPE_MAP[firstSegment] ?? "knowledge";
}

// ── Exports for testing ─────────────────────────────────────────────────────

export { OpenVikingStashProvider, refToVikingUri, parseOVSearchResponse };
