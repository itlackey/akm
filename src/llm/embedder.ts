/**
 * Backward-compatible facade for the embedder module.
 *
 * The implementation has been split into:
 * - `./embedders/types`  — `EmbeddingVector`, `Embedder`, `EmbeddingCheckResult`
 * - `./embedders/local`  — `LocalEmbedder`, `DEFAULT_LOCAL_MODEL`,
 *                          `isTransformersAvailable`
 * - `./embedders/remote` — `RemoteEmbedder`, `hasRemoteEndpoint`
 * - `./embedders/cache`  — LRU `embedCache`, `clearEmbeddingCache`,
 *                          `embedCacheKey`
 *
 * This module wires them together: it picks the right implementation from the
 * (optional) embedding config, applies the cache layer, and re-exports the
 * existing public API so call sites (`db-search.ts`, `indexer.ts`, `db.ts`,
 * `setup.ts`, `semantic-status.ts`, tests) keep working unmodified.
 *
 * Tests can construct fresh `LocalEmbedder` / `RemoteEmbedder` instances
 * directly from their submodules to avoid module-level state pollution.
 */

import type { EmbeddingConnectionConfig } from "../core/config";
import { embedCacheKey, getCachedEmbedding, setCachedEmbedding } from "./embedders/cache";
import { isTransformersAvailable, LocalEmbedder } from "./embedders/local";
import { hasRemoteEndpoint, RemoteEmbedder } from "./embedders/remote";
import type { EmbeddingCheckResult, EmbeddingVector } from "./embedders/types";

// ── Re-exports (public API) ─────────────────────────────────────────────────

export { clearEmbeddingCache } from "./embedders/cache";
export { DEFAULT_LOCAL_MODEL, isTransformersAvailable } from "./embedders/local";
export type { EmbeddingCheckResult, EmbeddingVector } from "./embedders/types";

// ── Singleton local embedder ────────────────────────────────────────────────
// `localEmbedder` is an intentional module-level singleton. The underlying
// @huggingface/transformers pipeline is expensive to initialise (model download
// + WASM compilation) and is safe to share across calls because it is
// stateless once created. Storing it here avoids re-initialising on every
// embed() call.

const localEmbedder = new LocalEmbedder();

/**
 * Reset the cached local embedder pipeline. Used by tests that want a fresh
 * pipeline construction (e.g. to assert the dtype-fallback retry logic).
 */
export function resetLocalEmbedder(): void {
  localEmbedder.reset();
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Generate an embedding for the given text.
 * If embeddingConfig has a remote endpoint, uses the configured OpenAI-compatible endpoint.
 * Otherwise falls back to local @huggingface/transformers using the model from
 * `embeddingConfig.localModel` or `DEFAULT_LOCAL_MODEL`.
 *
 * Results are cached in an LRU cache (max ~100 entries) keyed by query text
 * and embedding config. Repeated identical queries return the cached vector.
 */
export async function embed(
  text: string,
  embeddingConfig?: EmbeddingConnectionConfig,
  signal?: AbortSignal,
): Promise<EmbeddingVector> {
  const key = embedCacheKey(text, embeddingConfig);

  const cached = getCachedEmbedding(key);
  if (cached) return cached;

  const result =
    embeddingConfig && hasRemoteEndpoint(embeddingConfig)
      ? await new RemoteEmbedder(embeddingConfig).embed(text, signal)
      : await localEmbedder.embed(text, signal);

  setCachedEmbedding(key, result);
  return result;
}

/**
 * Generate embeddings for multiple texts in batch.
 * Uses the OpenAI-compatible batch API for remote endpoints (batches of 100).
 * Falls back to sequential embedding for the local transformer pipeline.
 */
export async function embedBatch(
  texts: string[],
  embeddingConfig?: EmbeddingConnectionConfig,
  signal?: AbortSignal,
): Promise<EmbeddingVector[]> {
  if (texts.length === 0) return [];

  if (embeddingConfig && hasRemoteEndpoint(embeddingConfig)) {
    return new RemoteEmbedder(embeddingConfig).embedBatch(texts, signal);
  }

  // Local transformer: process sequentially (pipeline handles one at a time)
  const localModel = embeddingConfig?.localModel;
  const results: EmbeddingVector[] = [];
  for (const text of texts) {
    if (signal?.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error("embedding interrupted");
    }
    results.push(await localEmbedder.embedWithModel(text, localModel));
  }
  return results;
}

// ── Similarity ──────────────────────────────────────────────────────────────

// `cosineSimilarity` was moved to `./embedders/types.ts` so importers
// (notably `db.ts`) can pull the math function without dragging in this
// facade and its `@huggingface/transformers` import chain. Re-export
// preserves the existing public API.
export { cosineSimilarity } from "./embedders/types";

// ── Availability check ──────────────────────────────────────────────────────

/**
 * Check whether embedding is available with a detailed reason on failure.
 */
export async function checkEmbeddingAvailability(
  embeddingConfig?: EmbeddingConnectionConfig,
): Promise<EmbeddingCheckResult> {
  if (embeddingConfig && hasRemoteEndpoint(embeddingConfig)) {
    try {
      await new RemoteEmbedder(embeddingConfig).embed("test");
      return { available: true };
    } catch (err) {
      return {
        available: false,
        reason: "remote-unreachable",
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }
  // Check if the package is importable before attempting the model download.
  if (!isTransformersAvailable()) {
    return {
      available: false,
      reason: "missing-package",
      message: "@huggingface/transformers is not installed.",
    };
  }
  try {
    await localEmbedder.getPipeline(embeddingConfig?.localModel);
    return { available: true };
  } catch (err) {
    return {
      available: false,
      reason: "model-download-failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function isEmbeddingAvailable(embeddingConfig?: EmbeddingConnectionConfig): Promise<boolean> {
  const result = await checkEmbeddingAvailability(embeddingConfig);
  return result.available;
}
