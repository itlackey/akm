// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Semantic embedding entry point.
 *
 * The implementation has been split into:
 * - `./embedders/types`  — `EmbeddingVector`, `Embedder`, `EmbeddingCheckResult`
 * - `./embedders/local`  — `LocalEmbedder`, `DEFAULT_LOCAL_MODEL`,
 *                          `isTransformersAvailable`
 * - `./embedders/remote` — `RemoteEmbedder`, `hasRemoteEndpoint`
 * - `./embedders/cache`  — LRU `embedCache`, `clearEmbeddingCache`,
 *                          `embedCacheKey`
 *
 * This module picks the configured implementation and owns the shared cache
 * and local model lifetime.
 *
 * Tests can construct fresh `LocalEmbedder` / `RemoteEmbedder` instances
 * directly from their submodules to avoid module-level state pollution.
 */

import type { EmbeddingConnectionConfig } from "../core/config/config";
import { embedCacheKey, getCachedEmbedding, setCachedEmbedding } from "./embedders/cache";
import {
  DETERMINISTIC_EMBED_MODEL_ID,
  deterministicEmbed,
  isDeterministicEmbedEnabled,
} from "./embedders/deterministic";
import {
  DEFAULT_LOCAL_MODEL,
  isTransformersAvailable as isTransformersAvailableReal,
  LocalEmbedder,
} from "./embedders/local";
import type { EmbeddingBatchCommit, EmbeddingSkipHandler } from "./embedders/remote";
import { hasRemoteEndpoint, RemoteEmbedder } from "./embedders/remote";
import type { EmbeddingCheckResult, EmbeddingVector } from "./embedders/types";

// ── Shared exports ──────────────────────────────────────────────────────────

export { clearEmbeddingCache } from "./embedders/cache";
export { _setTransformersLoaderForTests, DEFAULT_LOCAL_MODEL } from "./embedders/local";
export type { EmbeddingBatchCommit, EmbeddingBatchSkip, EmbeddingSkipHandler } from "./embedders/remote";
export type { EmbeddingCheckResult, EmbeddingVector } from "./embedders/types";

// ── Test seam ────────────────────────────────────────────────────────────────
// Swap-and-restore overrides. Inert in production; only tests install fakes,
// via tests/_helpers/seams.ts (which restores them automatically after each
// test). See docs/architecture/specs/di-seams-plan.md.

interface EmbedderOverridesForTests {
  embed?: typeof embed;
  embedBatch?: typeof embedBatch;
  resolveEmbeddingModelId?: typeof resolveEmbeddingModelId;
  checkEmbeddingAvailability?: typeof checkEmbeddingAvailability;
  isTransformersAvailable?: () => boolean;
}

let embedderOverrides: EmbedderOverridesForTests | undefined;

/** TEST-ONLY. Swap embedder implementations; pass undefined to restore. */
export function _setEmbedderForTests(fakes?: EmbedderOverridesForTests): void {
  embedderOverrides = fakes;
}

/**
 * Check whether the external Transformers dependency is available.
 * Delegating wrapper around `./embedders/local`'s probe so tests can swap it
 * via {@link _setEmbedderForTests}.
 */
export function isTransformersAvailable(): boolean {
  if (embedderOverrides?.isTransformersAvailable) return embedderOverrides.isTransformersAvailable();
  return isTransformersAvailableReal();
}

// ── Singleton local embedder ────────────────────────────────────────────────
// `_localEmbedder` is an intentional module-level singleton but constructed
// lazily on first use. The underlying Transformers.js pipeline is
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
 * Otherwise falls back to local Transformers.js using the model from
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
  if (embedderOverrides?.embed) return embedderOverrides.embed(text, embeddingConfig, signal);

  // Deterministic mode (env-gated, test/bench only): model-free, stable.
  if (isDeterministicEmbedEnabled()) {
    return deterministicEmbed(text);
  }

  const key = embedCacheKey(text, embeddingConfig);

  const cached = getCachedEmbedding(key);
  if (cached) return cached;

  const result = await embedOnce(text, embeddingConfig, signal);

  setCachedEmbedding(key, result);
  return result;
}

/**
 * Resolve a single embedding through the configured provider.
 *
 * The local branch must honour `localModel` exactly as {@link embedBatch}
 * does. The singleton is constructed with no default model, so routing through
 * `getLocalEmbedder().embed()` silently used DEFAULT_LOCAL_MODEL: queries were
 * embedded with a different model than the index was built with. Nothing
 * detected it, because the provider fingerprint keys on `localModel`, so no
 * purge or "pending" status ever fired — a dimension mismatch made semantic
 * ranking contribute nothing, and a same-dimension override silently produced
 * meaningless cross-model scores.
 */
async function embedOnce(
  text: string,
  embeddingConfig: EmbeddingConnectionConfig | undefined,
  signal?: AbortSignal,
): Promise<EmbeddingVector> {
  if (embeddingConfig && hasRemoteEndpoint(embeddingConfig)) {
    return new RemoteEmbedder(embeddingConfig).embed(text, signal);
  }
  const localModel = embeddingConfig?.localModel;
  if (localModel) {
    return getLocalEmbedder().embedWithModel(text, localModel);
  }
  return getLocalEmbedder().embed(text, signal);
}

/**
 * Generate embeddings for multiple texts in batch.
 * Uses the OpenAI-compatible batch API for remote endpoints, batched by an
 * estimated token budget (not a fixed document count, #874). A remote
 * sub-batch or oversized document that fails is skipped rather than
 * aborting the whole call — pass `onSkip` to learn which indices were
 * skipped and why; the result array holds `undefined` at those indices.
 * Uses the LocalEmbedder.embedBatch path for the local transformer pipeline,
 * which processes texts in chunks of 32 for genuine batched inference.
 *
 * `onBatch`, when given, fires once per provider/local batch as it completes
 * (#954) so a caller can commit each batch's rows durably as they land
 * rather than buffering the whole call — see `EmbeddingBatchCommit`.
 */
export async function embedBatch(
  texts: string[],
  embeddingConfig?: EmbeddingConnectionConfig,
  signal?: AbortSignal,
  onSkip?: EmbeddingSkipHandler,
  onBatch?: EmbeddingBatchCommit,
): Promise<(EmbeddingVector | undefined)[]> {
  if (embedderOverrides?.embedBatch) {
    return embedderOverrides.embedBatch(texts, embeddingConfig, signal, onSkip, onBatch);
  }

  if (texts.length === 0) return [];

  // Deterministic mode (env-gated, test/bench only): model-free, stable.
  if (isDeterministicEmbedEnabled()) {
    const embeddings = texts.map((t) => deterministicEmbed(t));
    // One onBatch commit for the whole call, like the local/remote batched
    // paths — firing once per text opened one materializer transaction per
    // entry in deterministic (test/bench) mode.
    onBatch?.(
      embeddings.map((_embedding, i) => i),
      embeddings,
    );
    return embeddings;
  }

  if (embeddingConfig && hasRemoteEndpoint(embeddingConfig)) {
    return new RemoteEmbedder(embeddingConfig).embedBatch(texts, signal, onSkip, onBatch);
  }

  // Local transformer: use the batched path (chunks of 32 via LocalEmbedder).
  // When a localModel override is set we cannot share the singleton (which uses
  // the default model), so fall back to per-text embedWithModel in that case.
  const localModel = embeddingConfig?.localModel;
  if (!localModel) {
    return getLocalEmbedder().embedBatch(texts, signal, onBatch);
  }
  const results: EmbeddingVector[] = [];
  for (const [i, text] of texts.entries()) {
    if (signal?.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error("embedding interrupted");
    }
    const embedding = await getLocalEmbedder().embedWithModel(text, localModel);
    results.push(embedding);
    onBatch?.([i], [embedding]);
  }
  return results;
}

// ── Similarity ──────────────────────────────────────────────────────────────

// `cosineSimilarity` was moved to `./embedders/types.ts` so importers
// (notably `db.ts`) can pull the math function without dragging in this
// module and its Transformers.js import chain.
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
  if (embedderOverrides?.resolveEmbeddingModelId) return embedderOverrides.resolveEmbeddingModelId(embeddingConfig);
  if (isDeterministicEmbedEnabled()) return DETERMINISTIC_EMBED_MODEL_ID;
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
): Promise<EmbeddingCheckResult> {
  if (embedderOverrides?.checkEmbeddingAvailability) {
    return embedderOverrides.checkEmbeddingAvailability(embeddingConfig);
  }
  // Deterministic mode (env-gated): always available — no model, no network.
  if (isDeterministicEmbedEnabled()) {
    return { available: true };
  }
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
      message: "The @huggingface/transformers dependency is unavailable.",
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
