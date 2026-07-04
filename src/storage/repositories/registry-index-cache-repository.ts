// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { Database } from "../database";

/**
 * Storage repository owning the raw SQL for the `registry_index_cache` table
 * in `index.db`.
 *
 * These helpers previously lived in the indexer god-module
 * `src/indexer/db/db.ts`, which produced an inverted layering: the storage
 * seam (`registry-cache.ts`) had to import them *back out* of a higher-level
 * feature module. They now live here so the dependency arrow points
 * `indexer → storage` (db.ts thin-re-exports from this repository for
 * backwards-compatibility) rather than the reverse.
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
