// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `index.db` LLM enrichment-cache repository.
 *
 * Owns the raw SQL for `llm_enrichment_cache` — the body-hash-keyed cache that
 * lets `akm index --enrich` skip the LLM call when a file's body is unchanged.
 * Extracted verbatim from `src/indexer/db/db.ts` (WI-5a).
 */

import { bestEffort } from "../../core/best-effort";
import { sha256Hex } from "../../runtime";
import type { Database, SqlValue } from "../database";
import type { LlmCacheEntry } from "./index-entry-types";
import { SQLITE_CHUNK_SIZE } from "./index-sql";

/**
 * Look up a cached LLM result for the given asset_ref.
 *
 * Returns `undefined` when no entry exists OR when the stored body_hash
 * doesn't match `currentBodyHash` (body has changed since the result was
 * cached). In both cases the caller should invoke the LLM and write a new
 * cache entry.
 */
export function getLlmCacheEntry(
  db: Database,
  assetRef: string,
  currentBodyHash: string,
  cacheVariant = "",
): LlmCacheEntry | undefined {
  const row = db
    .prepare(
      "SELECT asset_ref, cache_variant, body_hash, result_json, updated_at FROM llm_enrichment_cache WHERE asset_ref = ? AND cache_variant = ?",
    )
    .get(assetRef, cacheVariant) as
    | { asset_ref: string; cache_variant: string; body_hash: string; result_json: string; updated_at: number }
    | undefined;
  if (!row) return undefined;
  // Hash mismatch → body changed, treat as cache miss.
  if (row.body_hash !== currentBodyHash) return undefined;
  return {
    assetRef: row.asset_ref,
    cacheVariant: row.cache_variant,
    bodyHash: row.body_hash,
    resultJson: row.result_json,
    updatedAt: row.updated_at,
  };
}

/**
 * Batched variant of {@link getLlmCacheEntry}. Fetches every cache row whose
 * `asset_ref` is in `refs` with a single `IN (...)` query (chunked to respect
 * SQLITE_MAX_VARIABLE_NUMBER), returning a `Map<assetRef, LlmCacheEntry>`.
 *
 * Unlike `getLlmCacheEntry`, this does NOT filter by body hash — callers must
 * compare `entry.bodyHash` against the current body hash themselves. This lets
 * the batch path issue one DB query per chunk instead of one per file.
 */
export function getLlmCacheEntriesByRefs(db: Database, refs: string[], cacheVariant = ""): Map<string, LlmCacheEntry> {
  const result = new Map<string, LlmCacheEntry>();
  if (refs.length === 0) return result;
  for (let i = 0; i < refs.length; i += SQLITE_CHUNK_SIZE) {
    const chunk = refs.slice(i, i + SQLITE_CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = db
      .prepare(
        `SELECT asset_ref, cache_variant, body_hash, result_json, updated_at FROM llm_enrichment_cache
         WHERE cache_variant = ? AND asset_ref IN (${placeholders})`,
      )
      .all(cacheVariant, ...(chunk as SqlValue[])) as Array<{
      asset_ref: string;
      cache_variant: string;
      body_hash: string;
      result_json: string;
      updated_at: number;
    }>;
    for (const row of rows) {
      result.set(row.asset_ref, {
        assetRef: row.asset_ref,
        cacheVariant: row.cache_variant,
        bodyHash: row.body_hash,
        resultJson: row.result_json,
        updatedAt: row.updated_at,
      });
    }
  }
  return result;
}

/**
 * Insert or update a cached LLM result for the given asset_ref.
 */
export function upsertLlmCacheEntry(
  db: Database,
  assetRef: string,
  bodyHash: string,
  resultJson: string,
  cacheVariant = "",
): void {
  db.prepare(
    `INSERT INTO llm_enrichment_cache (asset_ref, cache_variant, body_hash, result_json, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(asset_ref, cache_variant) DO UPDATE SET
        body_hash   = excluded.body_hash,
        result_json = excluded.result_json,
        updated_at  = excluded.updated_at`,
  ).run(assetRef, cacheVariant, bodyHash, resultJson, Date.now());
}

/**
 * Delete LLM cache entries whose asset_ref is no longer present in the
 * `entries` table. Should be called during the cleanup phase of each index
 * run to prevent the cache from growing unboundedly as assets are removed.
 *
 * The join uses a LIKE match against the entries `file_path` column because
 * graph/memory cache refs are absolute file paths, while enrichment cache
 * refs are entry_key strings — we preserve any entry that still has a
 * corresponding row in either the entries table (by entry_key) or that
 * matches a live file_path.
 */
export function clearStaleCacheEntries(db: Database): void {
  bestEffort(() => {
    db.exec(`
      DELETE FROM llm_enrichment_cache
      WHERE asset_ref NOT IN (SELECT file_path FROM entries)
        AND asset_ref NOT IN (SELECT entry_key FROM entries)
    `);
  }, "llm_enrichment_cache may not exist in very old DBs opened without ensureSchema");
}

/**
 * Compute a stable SHA-256 hex digest of a UTF-8 string. Used as the body_hash
 * key in `llm_enrichment_cache`. Routed through the runtime boundary so the
 * SQLite layer stays free of direct runtime-specific references.
 */
export function computeBodyHash(body: string): string {
  return sha256Hex(body);
}
