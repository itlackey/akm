// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Deterministic feature-hashing embedder.
 *
 * Gated entirely behind the `AKM_EMBED_DETERMINISTIC=1` env var. When that is
 * set, the embedding facade (`../embedder.ts`) routes BOTH index-time and
 * query-time embedding through {@link deterministicEmbed} instead of the
 * @huggingface/transformers model. The result is a stable, model-free,
 * download-free embedding whose output is byte-identical across machines,
 * runtimes, and akm source versions.
 *
 * Why this exists: the curate/search hybrid ranking (FTS 0.7 + vector 0.3)
 * can only be benchmarked reproducibly across versions if the embedding axis
 * is held constant. A real model varies with its own version and is slow to
 * load; a deterministic embedder makes any score delta attributable to akm
 * source changes, not model drift. It also enables fast, offline semantic
 * tests. It is NEVER used in production (env-gated, off by default).
 *
 * The technique is classic feature hashing (the "hashing trick"): each token
 * is hashed to a bucket and a sign, and contributions are accumulated into a
 * fixed-width vector, then L2-normalized. Texts that share vocabulary land
 * closer in cosine space — a crude but genuine "shared words ⇒ similar"
 * signal, which is what makes the hybrid path behave qualitatively like the
 * real model for ranking purposes.
 */

import type { EmbeddingVector } from "./types";

/** Env var that switches the whole embedding facade into deterministic mode. */
export const DETERMINISTIC_EMBED_ENV = "AKM_EMBED_DETERMINISTIC";

/**
 * Vector width. Matches the default local model (`bge-small`, 384 dims) so the
 * index DB's embedding column and sqlite-vec table dimensions line up without
 * any extra config.
 */
export const DETERMINISTIC_EMBED_DIM = 384;

/**
 * Stable model id reported for deterministic mode. Used as the embedding
 * `model_id` and folded into the provider fingerprint so a deterministic index
 * is never confused with a real-model index (and vice versa).
 */
export const DETERMINISTIC_EMBED_MODEL_ID = "akm-deterministic-hash-v1";

/** True when deterministic embedding is enabled via env. */
export function isDeterministicEmbedEnabled(): boolean {
  return process.env[DETERMINISTIC_EMBED_ENV] === "1";
}

/** FNV-1a 32-bit hash. Platform- and version-stable. */
function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    // 32-bit FNV prime multiply via shifts to stay in uint32.
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

/** Lowercase, split on non-alphanumeric, drop empties. */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

/**
 * Deterministically embed `text` into a unit-length vector of width `dim`
 * using feature hashing. Empty / token-less input returns a fixed unit
 * vector so cosine similarity never sees a zero vector (NaN guard).
 */
export function deterministicEmbed(text: string, dim: number = DETERMINISTIC_EMBED_DIM): EmbeddingVector {
  const vec = new Array<number>(dim).fill(0);
  const tokens = tokenize(text);
  for (const tok of tokens) {
    const h = fnv1a(tok);
    const idx = h % dim;
    // Use a higher bit for the sign so it is independent of the bucket index.
    const sign = (h >>> 16) & 1 ? 1 : -1;
    vec[idx] += sign;
  }
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm === 0) {
    // No usable tokens — return a fixed, stable unit vector.
    vec[0] = 1;
    return vec;
  }
  for (let i = 0; i < dim; i++) vec[i] /= norm;
  return vec;
}
