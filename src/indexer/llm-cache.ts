// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

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
 * @param db            - SQLite database holding the LLM result cache.
 * @param cacheKey      - Stable identifier for this asset (typically its absolute path).
 * @param body          - The content being processed; its hash determines cache validity.
 * @param reEnrich      - When true the cache is bypassed and llmFn() is always called.
 * @param llmFn         - Async function that performs the actual LLM call.
 * @param validate      - Converts the raw parsed JSON back into the pass-specific type;
 *                        returns undefined when the cached data is unusable.
 * @param precomputedHash - Optional precomputed SHA-256 of `body`. When provided,
 *                          the wrapper skips its internal hashing — callers that
 *                          already hashed the body (e.g. to reuse it elsewhere)
 *                          should pass this to avoid the redundant work.
 */
export async function withLlmCache<T>(
  db: Database,
  cacheKey: string,
  body: string,
  reEnrich: boolean,
  llmFn: () => Promise<T | undefined>,
  validate: (raw: unknown) => T | undefined,
  precomputedHash?: string,
  cacheVariant = "",
): Promise<T | undefined> {
  const bodyHash = precomputedHash ?? computeBodyHash(body);
  if (!reEnrich) {
    try {
      const cached = getLlmCacheEntry(db, cacheKey, bodyHash, cacheVariant);
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
      upsertLlmCacheEntry(db, cacheKey, bodyHash, JSON.stringify(result), cacheVariant);
    } catch {
      // Cache write failure is non-fatal
    }
  }
  return result;
}
