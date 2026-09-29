// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { rethrowIfTestIsolationError } from "../../core/errors";
import { formatRegistryError } from "../../core/registry-url";
import { warn } from "../../core/warn";
import type { Database } from "../database";
import { closeDatabase, openIndexDatabase } from "./index-connection";

/**
 * The `registry_index_cache` table in `index.db`: the raw SQL plus the
 * "fresh cache → live fetch → stale fallback" skeleton the registry providers
 * (`src/registry/providers/*`) run their loads through.
 *
 * The open is {@link openIndexDatabase} (creates the data dir, ensures the
 * schema, tolerates a failed open) rather than the `openExistingDatabase`
 * loan helper: registry search must keep working before `index.db` exists,
 * so a failed open degrades to "no cache" instead of failing the search.
 */

/** Shape of a cached registry row as returned by {@link getRegistryIndexCache}. */
export type RegistryIndexCacheRow = {
  indexJson: string;
  etag: string | null;
  lastModified: string | null;
};

/**
 * Upsert a registry index cache entry in index.db.
 *
 * @param db          - Open index.db connection (from openDatabase / openExistingDatabase).
 * @param registryUrl - Canonical URL of the registry (used as primary key).
 * @param indexJson   - Serialised registry index document (JSON string).
 * @param opts.etag        - HTTP ETag from the response (optional).
 * @param opts.lastModified - HTTP Last-Modified from the response (optional).
 */
export function upsertRegistryIndexCache(
  db: Database,
  registryUrl: string,
  indexJson: string,
  opts?: { etag?: string; lastModified?: string },
): void {
  db.prepare(`
    INSERT INTO registry_index_cache (registry_url, fetched_at, etag, last_modified, index_json)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(registry_url) DO UPDATE SET
      fetched_at    = excluded.fetched_at,
      etag          = excluded.etag,
      last_modified = excluded.last_modified,
      index_json    = excluded.index_json
  `).run(registryUrl, new Date().toISOString(), opts?.etag ?? null, opts?.lastModified ?? null, indexJson);
}

/**
 * Look up a cached registry index entry from index.db.
 * Returns undefined when not found or when the entry is older than `maxAgeMs`.
 *
 * TTL check: if `Date.now() - new Date(fetched_at).getTime() > maxAgeMs` the
 * entry is considered a cache miss and undefined is returned.
 *
 * @param db          - Open index.db connection.
 * @param registryUrl - Canonical URL of the registry (primary key).
 * @param maxAgeMs    - Maximum age in milliseconds before the entry is stale (default: 1 hour).
 */
export function getRegistryIndexCache(
  db: Database,
  registryUrl: string,
  maxAgeMs = 3_600_000 /* 1 hour */,
): RegistryIndexCacheRow | undefined {
  const row = db
    .prepare(
      `SELECT fetched_at, etag, last_modified, index_json
       FROM registry_index_cache WHERE registry_url = ?`,
    )
    .get(registryUrl) as
    | { fetched_at: string; etag: string | null; last_modified: string | null; index_json: string }
    | undefined;

  if (!row) return undefined;

  const fetchedAt = Date.parse(row.fetched_at);
  if (Number.isNaN(fetchedAt) || Date.now() - fetchedAt > maxAgeMs) return undefined;

  return { indexJson: row.index_json, etag: row.etag, lastModified: row.last_modified };
}

/**
 * Open the cache DB (a failed open yields `db = undefined`; the bun-test
 * isolation guard is re-thrown), run `fn`, and close the DB only after `fn`
 * has fully settled — the callbacks are async, and closing earlier would tear
 * the DB down mid-write.
 */
export async function withRegistryCacheDb<T>(fn: (db: Database | undefined) => Promise<T>): Promise<T> {
  let db: Database | undefined;
  try {
    db = openIndexDatabase();
  } catch (err) {
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

/** Options for {@link fetchCachedJson}. */
export interface FetchCachedJsonOptions<T> {
  /** Cache primary key (e.g. the registry URL, or a per-query hash). */
  cacheKey: string;
  /** Max age in ms before a cached row is treated as a miss (TTL). */
  ttlMs: number;
  /**
   * Parse a cached JSON string into the provider value, or return `undefined`
   * when the cached payload is unusable. Owns its own `JSON.parse` + error
   * handling so each provider keeps its exact corrupt-cache behaviour (skills.sh
   * swallows a parse error and falls through; static-index lets it throw).
   *
   * @param json  The raw `index_json` string from the cache row.
   * @param opts.stale `true` when consulting the cache as a fetch-failure
   *   fallback (skills.sh additionally requires a non-empty result in this case).
   */
  parseCache: (json: string, opts: { stale: boolean }) => T | undefined;
  /**
   * Perform the live fetch + parse. Returns the value plus the JSON string to
   * write to the cache. Throws on fetch/parse failure so the caller can fall
   * back to a stale cache row.
   */
  fetchFresh: () => Promise<{ value: T; cacheJson: string }>;
}

/**
 * Returns a fresh cache hit when present, otherwise fetches live (writing the
 * result back best-effort), and falls back to a stale cache row when the
 * fetch fails.
 */
export async function fetchCachedJson<T>(opts: FetchCachedJsonOptions<T>): Promise<T> {
  const { cacheKey, ttlMs, parseCache, fetchFresh } = opts;

  return withRegistryCacheDb(async (db) => {
    let dbCacheResult: RegistryIndexCacheRow | undefined;
    try {
      if (db) {
        dbCacheResult = getRegistryIndexCache(db, cacheKey, ttlMs);
      }
    } catch (err) {
      // Never mask the bun-test isolation guard as "DB unavailable" — see
      // rethrowIfTestIsolationError in src/core/errors.ts.
      rethrowIfTestIsolationError(err);
      // index.db read failed (pre-migration install or test env) — fall through
    }

    if (dbCacheResult) {
      const cached = parseCache(dbCacheResult.indexJson, { stale: false });
      if (cached !== undefined) {
        return cached;
      }
    }

    try {
      const { value, cacheJson } = await fetchFresh();
      if (db) {
        try {
          upsertRegistryIndexCache(db, cacheKey, cacheJson);
        } catch {
          /* best-effort */
        }
      }
      return value;
    } catch (err) {
      // Fetch failed — use stale DB cache if available.
      if (dbCacheResult) {
        const stale = parseCache(dbCacheResult.indexJson, { stale: true });
        if (stale !== undefined) return stale;
      }
      // No in-TTL row — consult the cache PAST its TTL before giving up: a
      // briefly unreachable registry should degrade to the last-known index,
      // loudly, not hard-fail the command.
      try {
        const expiredRow = db ? getRegistryIndexCache(db, cacheKey, Number.POSITIVE_INFINITY) : undefined;
        if (expiredRow) {
          const stale = parseCache(expiredRow.indexJson, { stale: true });
          if (stale !== undefined) {
            warn(
              `Registry fetch failed (${formatRegistryError(err)}); ` +
                "serving the last cached index, which is past its refresh interval.",
            );
            return stale;
          }
        }
      } catch (cacheErr) {
        rethrowIfTestIsolationError(cacheErr);
        // cache read failed — fall through to the original fetch error
      }
      throw err;
    }
  });
}
