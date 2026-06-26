// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { rethrowIfTestIsolationError } from "../../core/errors";
import { closeDatabase, getRegistryIndexCache, openIndexDatabase, upsertRegistryIndexCache } from "../../indexer/db/db";
import type { Database } from "../database";

/**
 * Storage seam for the `registry_index_cache` table in `index.db`.
 *
 * Registry providers (`src/registry/providers/*`) must NOT reach into
 * `src/indexer/db/db.ts` directly — that is a layering inversion (a feature
 * module depending on a lower storage module's raw helpers). This repository
 * owns the open/close lifecycle and the cached-JSON fetch skeleton so the
 * providers depend only on `src/storage/...`.
 *
 * NOTE: this seam intentionally uses {@link openIndexDatabase} (which creates
 * the data dir + ensures schema and tolerates a failed open) rather than the
 * {@link ../repositories/index-db withIndexDb} `openExistingDatabase` loan
 * helper. Registry search must keep working before `index.db` exists / is
 * migrated; the tolerant open + `db = undefined` fall-through is load-bearing.
 */

/** Shape of a cached registry row as returned by {@link getRegistryIndexCache}. */
type RegistryCacheRow = { indexJson: string; etag: string | null; lastModified: string | null };

/**
 * RAII-style lifecycle helper for the registry cache DB. Opens the DB (treating
 * a failed open exactly like the legacy fall-through: the bun-test isolation
 * guard is re-thrown, any other failure yields `db = undefined`), runs `fn`,
 * and guarantees the DB is closed in a `finally` after `fn` has fully settled
 * (the await is required: the callbacks are async, and closing before they
 * settle would tear the DB down mid-write).
 */
export async function withRegistryCacheDb<T>(fn: (db: Database | undefined) => Promise<T>): Promise<T> {
  let db: Database | undefined;
  try {
    db = openIndexDatabase();
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

/**
 * Options for {@link fetchCachedJson}: the common "try cache → fetch fresh →
 * write cache → fall back to stale cache" skeleton shared by the registry
 * providers, parameterised by the per-provider specifics.
 */
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
   * write to the cache (and optional HTTP validators). Throws on fetch/parse
   * failure so the caller can fall back to a stale cache row.
   */
  fetchFresh: (db: Database | undefined) => Promise<{
    value: T;
    cacheJson: string;
    cacheOpts?: { etag?: string; lastModified?: string };
  }>;
}

/**
 * Shared registry index-cache fetch template. Opens the cache DB, returns a
 * fresh cache hit when present, otherwise fetches live (writing the result back
 * to the cache best-effort), and falls back to a stale cache row when the fetch
 * fails. Behaviour-preserving extraction of the logic previously duplicated in
 * `skills-sh.ts` (`fetchSkills`) and `static-index.ts` (`loadIndex`).
 */
export async function fetchCachedJson<T>(opts: FetchCachedJsonOptions<T>): Promise<T> {
  const { cacheKey, ttlMs, parseCache, fetchFresh } = opts;

  return withRegistryCacheDb(async (db) => {
    // ── Step 1: Try DB cache (index.db) ─────────────────────────────────────
    let dbCacheResult: RegistryCacheRow | undefined;
    try {
      if (db) {
        dbCacheResult = getRegistryIndexCache(db, cacheKey, ttlMs);
      }
    } catch (err) {
      // Never mask the bun-test isolation guard as "DB unavailable" — see
      // rethrowIfTestIsolationError in src/core/errors.ts. Without this, a
      // leaky test silently gets a cold cache instead of the loud
      // TEST_ISOLATION_MISSING failure the guard intends.
      rethrowIfTestIsolationError(err);
      // index.db read failed (pre-migration install or test env) — fall through
    }

    if (dbCacheResult) {
      const cached = parseCache(dbCacheResult.indexJson, { stale: false });
      if (cached !== undefined) {
        return cached;
      }
    }

    // ── Step 2: Fetch fresh ──────────────────────────────────────────────────
    try {
      const { value, cacheJson, cacheOpts } = await fetchFresh(db);
      if (db) {
        try {
          upsertRegistryIndexCache(db, cacheKey, cacheJson, cacheOpts);
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
      throw err;
    }
  });
}
