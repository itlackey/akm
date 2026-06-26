// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { fetchWithRetry } from "../../core/common";
import type { RegistryConfigEntry } from "../../core/config/config";
import { md5Hex } from "../../runtime";
import { fetchCachedJson } from "../../storage/repositories/registry-cache";
import { registerProvider } from "../factory";
import type { RegistryAssetSearchHit, RegistrySearchHit } from "../types";
import type { RegistryProvider, RegistryProviderResult, RegistryProviderSearchOptions } from "./types";

// ── Constants ───────────────────────────────────────────────────────────────

/** Per-query cache TTL in milliseconds (15 minutes). */
const QUERY_CACHE_TTL_MS = 15 * 60 * 1000;

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
    // Build a stable DB cache key for this query
    const dbCacheKey = this.queryDbCacheKey(query, limit);
    const baseUrl = this.config.url.replace(/\/+$/, "");
    const url = `${baseUrl}/api/search?q=${encodeURIComponent(query)}&limit=${limit}`;

    return fetchCachedJson<SkillsShEntry[]>({
      cacheKey: dbCacheKey,
      ttlMs: QUERY_CACHE_TTL_MS,
      // A fresh hit returns even an empty array; a stale fallback only when
      // non-empty. Corrupt cache JSON is swallowed and treated as a miss.
      parseCache: (json, { stale }) => {
        try {
          const parsed = JSON.parse(json) as unknown;
          if (!Array.isArray(parsed)) return undefined;
          const entries = (parsed as unknown[]).filter(isValidSkillsEntry);
          if (stale && entries.length === 0) return undefined;
          return entries;
        } catch {
          return undefined;
        }
      },
      fetchFresh: async () => {
        const response = await fetchWithRetry(url, undefined, { timeout: 10_000, retries: 1 });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const data = (await response.json()) as unknown;
        const entries = parseSkillsResponse(data);
        return { value: entries, cacheJson: JSON.stringify(entries) };
      },
    });
  }

  private mapToHits(entries: SkillsShEntry[]): RegistrySearchHit[] {
    if (entries.length === 0) return [];

    // Assign decreasing synthetic scores for merge compatibility
    const maxInstalls = Math.max(...entries.map((e) => e.installs), 1);
    const registryName = this.config.name ?? "skills.sh";
    const baseUrl = this.config.url.replace(/\/+$/, "");

    return entries.map((entry) => {
      const segments = entry.source.split("/");
      const owner = segments[0] ?? "";
      const repo = segments[1] ?? "";
      const ownerRepo = owner && repo ? `${owner}/${repo}` : entry.source;
      const score = Math.round((entry.installs / maxInstalls) * 1000) / 1000;

      return {
        source: "github" as const,
        id: `skills-sh:${entry.id}`,
        title: entry.name,
        ref: ownerRepo,
        installRef: `github:${ownerRepo}`,
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

    const hits: RegistryAssetSearchHit[] = entries.map((entry) => {
      const segments = entry.source.split("/");
      const owner = segments[0] ?? "";
      const repo = segments[1] ?? "";
      const ownerRepo = owner && repo ? `${owner}/${repo}` : entry.source;
      return {
        type: "registry-asset",
        assetType: "skill",
        assetName: entry.name,
        stash: { id: `skills-sh:${entry.id}`, name: entry.name },
        registryName,
        action: `akm add github:${ownerRepo}`,
        score: Math.round((entry.installs / maxInstalls) * 1000) / 1000,
      };
    });

    return hits.length > 0 ? hits : undefined;
  }

  // ── DB cache key ────────────────────────────────────────────────────────

  private queryDbCacheKey(query: string, limit: number): string {
    const hash = md5Hex(`${this.config.url}\0${query.trim().toLowerCase()}\0${String(limit)}`);
    return `skills-sh:${hash}`;
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
