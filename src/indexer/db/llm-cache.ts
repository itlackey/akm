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

import { bestEffort } from "../../core/best-effort";
import type { Database } from "../../storage/database";
import {
  computeBodyHash,
  getLlmCacheEntry,
  upsertLlmCacheEntry,
} from "../../storage/repositories/index-llm-cache-repository";

/**
 * Optional cache-event sink. Passes that want to track cache hit rate
 * (e.g. for the `memoryInference.cacheHits` telemetry) supply an
 * `onCacheHit` callback that the wrapper fires when a fresh cache hit
 * short-circuits the LLM call. The signal is "this call would have hit
 * the LLM but didn't" — fires once per `withLlmCache` invocation that
 * returns a validated cached result, and never for misses.
 */
export interface WithLlmCacheHooks {
  onCacheHit?: () => void;
}

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
 * @param cacheVariant  - Namespace token for the cache row so different passes'
 *                        rows do not collide (e.g. memory-inference vs graph).
 * @param hooks         - Optional event sink for telemetry (see {@link WithLlmCacheHooks}).
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
  hooks?: WithLlmCacheHooks,
): Promise<T | undefined> {
  const bodyHash = precomputedHash ?? computeBodyHash(body);
  if (!reEnrich) {
    const cacheHit = bestEffort(() => {
      const cached = getLlmCacheEntry(db, cacheKey, bodyHash, cacheVariant);
      if (cached) {
        const result = validate(JSON.parse(cached.resultJson));
        if (result !== undefined) {
          hooks?.onCacheHit?.();
          return result;
        }
      }
      return undefined;
    }, "llm cache read corrupt — fall through to recompute");
    if (cacheHit !== undefined) return cacheHit;
  }
  const result = await llmFn();
  if (result !== undefined) {
    bestEffort(
      () => upsertLlmCacheEntry(db, cacheKey, bodyHash, JSON.stringify(result), cacheVariant),
      "llm cache write failure is non-fatal",
    );
  }
  return result;
}
