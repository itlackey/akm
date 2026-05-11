/**
 * Generic LLM-result cache wrapper shared across indexer passes.
 *
 * Each pass that calls an LLM and wants to skip re-processing unchanged
 * content can delegate the cache check/write to `withLlmCache` instead of
 * duplicating the hash-compute → lookup → write pattern inline.
 */

import type { Database } from "bun:sqlite";
import { computeBodyHash, getLlmCacheEntry, upsertLlmCacheEntry } from "./db";

/**
 * Generic LLM cache wrapper. Returns cached result if body unchanged,
 * otherwise calls llmFn(), caches the result, and returns it.
 * Returns undefined if llmFn() returns undefined or throws.
 *
 * @param db        - SQLite database holding the LLM result cache.
 * @param cacheKey  - Stable identifier for this asset (typically its absolute path).
 * @param body      - The content being processed; its hash determines cache validity.
 * @param reEnrich  - When true the cache is bypassed and llmFn() is always called.
 * @param llmFn     - Async function that performs the actual LLM call.
 * @param validate  - Converts the raw parsed JSON back into the pass-specific type;
 *                    returns undefined when the cached data is unusable.
 */
export async function withLlmCache<T>(
  db: Database,
  cacheKey: string,
  body: string,
  reEnrich: boolean,
  llmFn: () => Promise<T | undefined>,
  validate: (raw: unknown) => T | undefined,
): Promise<T | undefined> {
  const bodyHash = computeBodyHash(body);
  if (!reEnrich) {
    try {
      const cached = getLlmCacheEntry(db, cacheKey, bodyHash);
      if (cached) {
        const result = validate(JSON.parse(cached.resultJson));
        if (result !== undefined) return result;
      }
    } catch {
      // Cache corrupt — fall through
    }
  }
  const result = await llmFn();
  if (result !== undefined) {
    try {
      upsertLlmCacheEntry(db, cacheKey, bodyHash, JSON.stringify(result));
    } catch {
      // Cache write failure is non-fatal
    }
  }
  return result;
}
