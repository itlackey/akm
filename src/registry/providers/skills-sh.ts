// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { fetchWithRetry } from "../../core/common";
import type { RegistryConfigEntry } from "../../core/config/config";
import { rethrowIfTestIsolationError } from "../../core/errors";
import { closeDatabase, getRegistryIndexCache, openDatabase, upsertRegistryIndexCache } from "../../indexer/db/db";
import { md5Hex } from "../../runtime";
import { registerProvider } from "../factory";
import type { ParsedRegistryRef, RegistryAssetSearchHit, RegistrySearchHit } from "../types";
import type {
  AssetPreview,
  KitId,
  KitManifest,
  KitResult,
  RegistryProvider,
  RegistryProviderResult,
  RegistryProviderSearchOptions,
  RegistryQuery,
} from "./types";

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

// ── Cache DB lifecycle ────────────────────────────────────────────────────────

/**
 * RAII-style lifecycle helper for the registry cache DB. Opens the DB (treating
 * a failed open exactly like the legacy fall-through: the bun-test isolation
 * guard is re-thrown, any other failure yields `db = undefined`), runs `fn`,
 * and guarantees the DB is closed in a `finally` after `fn` has fully settled
 * (the await is required: the callbacks are async, and closing before they
 * settle would tear the DB down mid-write).
 */
async function withRegistryCacheDb<T>(fn: (db: ReturnType<typeof openDatabase> | undefined) => Promise<T>): Promise<T> {
  let db: ReturnType<typeof openDatabase> | undefined;
  try {
    db = openDatabase();
  } catch (err) {
    // Never mask the bun-test isolation guard as "DB unavailable".
    rethrowIfTestIsolationError(err);
    db = undefined;
  }
  try {
    return await fn(db);
  } finally {
    if (db) {
      try {
        closeDatabase(db);
      } catch {
        /* ignore */
      }
    }
  }
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

  // ── v1-spec §3.1 surface ────────────────────────────────────────────────

  async searchKits(q: RegistryQuery): Promise<KitResult[]> {
    const result = await this.search({
      query: q.text,
      limit: q.limit ?? 20,
      includeAssets: false,
    });
    return result.hits.map((hit) => ({
      id: hit.id,
      title: hit.title,
      summary: hit.description,
      installRef: hit.installRef,
      score: hit.score,
    }));
  }

  async searchAssets(q: RegistryQuery): Promise<AssetPreview[]> {
    const result = await this.search({
      query: q.text,
      limit: q.limit ?? 20,
      includeAssets: true,
    });
    return (result.assetHits ?? []).map((hit) => ({
      kitId: hit.stash.id,
      type: hit.assetType,
      name: hit.assetName,
      summary: hit.description,
      cloneRef: hit.action.replace(/^akm add\s+/, ""),
    }));
  }

  /**
   * skills.sh has no `getKit` API — every entry corresponds to a GitHub
   * repository whose metadata we already include in the search result. We
   * synthesize a manifest from the search hit when the caller knows the stash
   * id; if not present in the most recent results, return null.
   */
  async getKit(id: KitId): Promise<KitManifest | null> {
    if (!id.startsWith("skills-sh:")) return null;
    const slug = id.slice("skills-sh:".length);
    // Best-effort: the API gives us search-by-name; extract the leaf segment.
    const segments = slug.split("/").filter(Boolean);
    const leaf = segments[segments.length - 1] ?? slug;
    const result = await this.search({ query: leaf, limit: 50, includeAssets: false });
    const match = result.hits.find((hit) => hit.id === id);
    if (!match) return null;
    return { id: match.id, installRef: match.installRef };
  }

  /**
   * skills.sh entries are always GitHub repositories. Claim only refs whose
   * parsed source is `github`; defer everything else (npm tarballs, local
   * paths, raw git URLs) to other registries.
   */
  canHandle(ref: ParsedRegistryRef): boolean {
    return ref.source === "github";
  }

  private async fetchSkills(query: string, limit: number): Promise<SkillsShEntry[]> {
    // Build a stable DB cache key for this query
    const dbCacheKey = this.queryDbCacheKey(query, limit);

    return withRegistryCacheDb(async (db) => {
      // ── Step 1: Try DB cache (index.db) ───────────────────────────────────
      let dbCacheResult: { indexJson: string; etag: string | null; lastModified: string | null } | undefined;
      try {
        if (db) {
          dbCacheResult = getRegistryIndexCache(db, dbCacheKey, QUERY_CACHE_TTL_MS);
        }
      } catch (err) {
        // Never mask the bun-test isolation guard as "DB unavailable" — see
        // rethrowIfTestIsolationError in src/core/errors.ts. Without this,
        // a leaky test silently gets a cold cache + fresh fetch instead of
        // the loud TEST_ISOLATION_MISSING failure the guard intends.
        rethrowIfTestIsolationError(err);
        // index.db not available yet (pre-migration install or test env) — fall through
      }

      if (dbCacheResult) {
        try {
          const parsed = JSON.parse(dbCacheResult.indexJson) as unknown;
          if (Array.isArray(parsed)) {
            const entries = (parsed as unknown[]).filter(isValidSkillsEntry);
            return entries;
          }
        } catch {
          /* corrupt DB entry — fall through */
        }
      }

      // ── Step 2: Fetch from API ─────────────────────────────────────────────
      const baseUrl = this.config.url.replace(/\/+$/, "");
      const url = `${baseUrl}/api/search?q=${encodeURIComponent(query)}&limit=${limit}`;

      try {
        const response = await fetchWithRetry(url, undefined, { timeout: 10_000, retries: 1 });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const data = (await response.json()) as unknown;
        const entries = parseSkillsResponse(data);

        // Write to DB cache (primary)
        if (db) {
          try {
            upsertRegistryIndexCache(db, dbCacheKey, JSON.stringify(entries));
          } catch {
            /* best-effort */
          }
        }
        return entries;
      } catch (err) {
        // Fetch failed — use stale DB cache if available
        if (dbCacheResult) {
          try {
            const parsed = JSON.parse(dbCacheResult.indexJson) as unknown;
            if (Array.isArray(parsed)) {
              const entries = (parsed as unknown[]).filter(isValidSkillsEntry);
              if (entries.length > 0) return entries;
            }
          } catch {
            /* ignore */
          }
        }
        throw err;
      }
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
