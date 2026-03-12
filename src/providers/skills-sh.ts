import fs from "node:fs";
import path from "node:path";
import { fetchWithRetry } from "../common";
import type { RegistryConfigEntry } from "../config";
import { getRegistryIndexCacheDir } from "../paths";
import { registerProvider } from "../provider-registry";
import type { RegistryProvider, RegistryProviderResult, RegistryProviderSearchOptions } from "../registry-provider";
import type { RegistryAssetSearchHit, RegistrySearchHit } from "../registry-types";

// ── Constants ───────────────────────────────────────────────────────────────

/** Per-query cache TTL in milliseconds (15 minutes). */
const QUERY_CACHE_TTL_MS = 15 * 60 * 1000;

/** Maximum age before query cache is considered stale but still usable (1 day). */
const QUERY_CACHE_STALE_MS = 24 * 60 * 60 * 1000;

// ── Response types ──────────────────────────────────────────────────────────

interface SkillsShEntry {
  id: string;
  name: string;
  installs: number;
  source: string;
}

// ── Provider class ──────────────────────────────────────────────────────────

class SkillsShProvider implements RegistryProvider {
  readonly type = "skills-sh";
  private readonly config: RegistryConfigEntry;

  constructor(config: RegistryConfigEntry) {
    this.config = config;
  }

  async search(options: RegistryProviderSearchOptions): Promise<RegistryProviderResult> {
    try {
      const entries = await this.fetchSkills(options.query, options.limit);
      const limited = entries.slice(0, options.limit);
      const hits = this.mapToHits(limited);
      let assetHits: RegistryAssetSearchHit[] | undefined;
      if (options.includeAssets) {
        assetHits = this.mapToAssetHits(limited);
      }
      return { hits, assetHits };
    } catch (err) {
      const label = this.config.name ?? "skills.sh";
      const message = err instanceof Error ? err.message : String(err);
      return { hits: [], warnings: [`Registry ${label}: ${message}`] };
    }
  }

  private async fetchSkills(query: string, limit: number): Promise<SkillsShEntry[]> {
    // Check per-query cache first
    const cachePath = this.queryCachePath(query, limit);
    const cached = this.readQueryCache(cachePath);

    if (cached && !isExpired(cached.mtime, QUERY_CACHE_TTL_MS)) {
      return cached.entries;
    }

    // Fetch from API
    const baseUrl = this.config.url.replace(/\/+$/, "");
    const url = `${baseUrl}/api/search?q=${encodeURIComponent(query)}&limit=${limit}`;

    try {
      const response = await fetchWithRetry(url, undefined, { timeout: 10_000, retries: 1 });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = (await response.json()) as unknown;
      const entries = parseSkillsResponse(data);
      this.writeQueryCache(cachePath, entries);
      return entries;
    } catch (err) {
      // Fall back to stale cache if available
      if (cached && !isExpired(cached.mtime, QUERY_CACHE_STALE_MS)) {
        return cached.entries;
      }
      throw err;
    }
  }

  private mapToHits(entries: SkillsShEntry[]): RegistrySearchHit[] {
    if (entries.length === 0) return [];

    // Assign decreasing synthetic scores for merge compatibility
    const maxInstalls = Math.max(...entries.map((e) => e.installs), 1);
    const registryName = this.config.name ?? "skills.sh";
    const baseUrl = this.config.url.replace(/\/+$/, "");

    return entries.map((entry) => {
      const owner = entry.source.split("/")[0] ?? "";
      const score = Math.round((entry.installs / maxInstalls) * 1000) / 1000;

      return {
        source: "github" as const,
        id: `skills-sh:${entry.id}`,
        title: entry.name,
        ref: entry.source,
        installRef: `github:${entry.source}`,
        homepage: `${baseUrl}/${entry.id}`,
        score,
        metadata: {
          installs: String(entry.installs),
          ...(owner ? { author: owner } : {}),
        },
        registryName,
      };
    });
  }

  private mapToAssetHits(entries: SkillsShEntry[]): RegistryAssetSearchHit[] | undefined {
    if (entries.length === 0) return undefined;

    const registryName = this.config.name ?? "skills.sh";
    const maxInstalls = Math.max(...entries.map((e) => e.installs), 1);

    const hits: RegistryAssetSearchHit[] = entries.map((entry) => ({
      type: "registry-asset",
      assetType: "skill",
      assetName: entry.name,
      kit: { id: `skills-sh:${entry.id}`, name: entry.name },
      registryName,
      action: `akm add ${entry.source}`,
      score: Math.round((entry.installs / maxInstalls) * 1000) / 1000,
    }));

    return hits.length > 0 ? hits : undefined;
  }

  // ── Per-query cache ─────────────────────────────────────────────────────

  private queryCachePath(query: string, limit: number): string {
    const cacheDir = getRegistryIndexCacheDir();
    const hasher = new Bun.CryptoHasher("md5");
    hasher.update(this.config.url);
    hasher.update("\0");
    hasher.update(query.trim().toLowerCase());
    hasher.update("\0");
    hasher.update(String(limit));
    const hash = hasher.digest("hex");
    return path.join(cacheDir, `skills-sh-search-${hash}.json`);
  }

  private readQueryCache(cachePath: string): { entries: SkillsShEntry[]; mtime: number } | null {
    try {
      const stat = fs.statSync(cachePath);
      const raw = JSON.parse(fs.readFileSync(cachePath, "utf8"));
      if (!Array.isArray(raw)) return null;
      const entries = raw.filter(isValidSkillsEntry);
      return { entries, mtime: stat.mtimeMs };
    } catch {
      return null;
    }
  }

  private writeQueryCache(cachePath: string, entries: SkillsShEntry[]): void {
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

registerProvider("skills-sh", (config) => new SkillsShProvider(config));

// ── Response parsing ────────────────────────────────────────────────────────

function parseSkillsResponse(data: unknown): SkillsShEntry[] {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return [];
  const obj = data as Record<string, unknown>;
  if (!Array.isArray(obj.skills)) return [];
  return obj.skills.filter(isValidSkillsEntry);
}

function isValidSkillsEntry(entry: unknown): entry is SkillsShEntry {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false;
  const obj = entry as Record<string, unknown>;
  return (
    typeof obj.id === "string" &&
    typeof obj.name === "string" &&
    typeof obj.installs === "number" &&
    typeof obj.source === "string"
  );
}

// ── Utilities ───────────────────────────────────────────────────────────────

function isExpired(mtimeMs: number, ttlMs: number): boolean {
  return Date.now() - mtimeMs > ttlMs;
}
