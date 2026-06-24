// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

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

import type { EmbeddingConnectionConfig } from "../core/config/config";
import { embedCacheKey, getCachedEmbedding, setCachedEmbedding } from "./embedders/cache";
import { DEFAULT_LOCAL_MODEL, isTransformersAvailable, LocalEmbedder } from "./embedders/local";
import { hasRemoteEndpoint, RemoteEmbedder, type RemoteEmbedderDeps } from "./embedders/remote";
import type { EmbeddingCheckResult, EmbeddingVector } from "./embedders/types";

// ── Re-exports (public API) ─────────────────────────────────────────────────

export { clearEmbeddingCache } from "./embedders/cache";
export { DEFAULT_LOCAL_MODEL, isTransformersAvailable } from "./embedders/local";
export type { EmbeddingCheckResult, EmbeddingVector } from "./embedders/types";

// ── Singleton local embedder ────────────────────────────────────────────────
// `_localEmbedder` is an intentional module-level singleton but constructed
// lazily on first use. The underlying @huggingface/transformers pipeline is
// expensive to initialise (model download + WASM compilation) and is safe to
// share across calls because it is stateless once created. Deferring
// construction to first call keeps the module side-effect-free at import time,
// which matters for the test suite (single Bun process, ~120 test files).

let _localEmbedder: LocalEmbedder | undefined;

function getLocalEmbedder(): LocalEmbedder {
  if (!_localEmbedder) {
    _localEmbedder = new LocalEmbedder();
  }
  return _localEmbedder;
}

/**
 * Reset the cached local embedder pipeline. Used by tests that want a fresh
 * pipeline construction (e.g. to assert the dtype-fallback retry logic).
 */
export function resetLocalEmbedder(): void {
  getLocalEmbedder().reset();
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
  deps?: RemoteEmbedderDeps,
): Promise<EmbeddingVector> {
  const key = embedCacheKey(text, embeddingConfig);

  const cached = getCachedEmbedding(key);
  if (cached) return cached;

  const result =
    embeddingConfig && hasRemoteEndpoint(embeddingConfig)
      ? await new RemoteEmbedder(embeddingConfig, deps).embed(text, signal)
      : await getLocalEmbedder().embed(text, signal);

  setCachedEmbedding(key, result);
  return result;
}

/**
 * Generate embeddings for multiple texts in batch.
 * Uses the OpenAI-compatible batch API for remote endpoints (batches of 100).
 * Uses the LocalEmbedder.embedBatch path for the local transformer pipeline,
 * which processes texts in chunks of 32 for genuine batched inference.
 */
export async function embedBatch(
  texts: string[],
  embeddingConfig?: EmbeddingConnectionConfig,
  signal?: AbortSignal,
  deps?: RemoteEmbedderDeps,
): Promise<EmbeddingVector[]> {
  if (texts.length === 0) return [];

  if (embeddingConfig && hasRemoteEndpoint(embeddingConfig)) {
    return new RemoteEmbedder(embeddingConfig, deps).embedBatch(texts, signal);
  }

  // Local transformer: use the batched path (chunks of 32 via LocalEmbedder).
  // When a localModel override is set we cannot share the singleton (which uses
  // the default model), so fall back to per-text embedWithModel in that case.
  const localModel = embeddingConfig?.localModel;
  if (!localModel) {
    return getLocalEmbedder().embedBatch(texts, signal);
  }
  const results: EmbeddingVector[] = [];
  for (const text of texts) {
    if (signal?.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error("embedding interrupted");
    }
    results.push(await getLocalEmbedder().embedWithModel(text, localModel));
  }
  return results;
}

// ── Similarity ──────────────────────────────────────────────────────────────

// `cosineSimilarity` was moved to `./embedders/types.ts` so importers
// (notably `db.ts`) can pull the math function without dragging in this
// facade and its `@huggingface/transformers` import chain. Re-export
// preserves the existing public API.
export { cosineSimilarity } from "./embedders/types";

// ── Model ID resolution ─────────────────────────────────────────────────────

/**
 * Derive a stable string identifier for the embedding model in use.
 * This is the `model_id` stored in `body_embeddings` (and used for the
 * drop-all-on-mismatch purge when the model changes).
 *
 * Rules:
 *   - Remote endpoint: use `config.model` (the API-level model name).
 *   - Local transformers: use `config.localModel ?? DEFAULT_LOCAL_MODEL`.
 *   - No config: use `DEFAULT_LOCAL_MODEL` (the shared singleton model).
 */
export function resolveEmbeddingModelId(embeddingConfig?: EmbeddingConnectionConfig): string {
  if (!embeddingConfig) return DEFAULT_LOCAL_MODEL;
  if (hasRemoteEndpoint(embeddingConfig)) return embeddingConfig.model ?? "remote";
  return embeddingConfig.localModel ?? DEFAULT_LOCAL_MODEL;
}

// ── Availability check ──────────────────────────────────────────────────────

/**
 * Check whether embedding is available with a detailed reason on failure.
 */
export async function checkEmbeddingAvailability(
  embeddingConfig?: EmbeddingConnectionConfig,
  deps?: RemoteEmbedderDeps,
): Promise<EmbeddingCheckResult> {
  if (embeddingConfig && hasRemoteEndpoint(embeddingConfig)) {
    try {
      await new RemoteEmbedder(embeddingConfig, deps).embed("test");
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
    await getLocalEmbedder().getPipeline(embeddingConfig?.localModel);
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
