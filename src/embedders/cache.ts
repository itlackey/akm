/**
 * LRU embedding cache shared by the embedder facade.
 *
 * Caches query embeddings to avoid redundant computation for repeated
 * queries. Uses a simple Map with LRU eviction (delete + re-insert to move
 * an entry to the most-recently-used end).
 */

import type { EmbeddingConnectionConfig } from "../config";
import type { EmbeddingVector } from "./types";

const EMBED_CACHE_MAX = 100;
const embedCache = new Map<string, EmbeddingVector>();

/**
 * Build a cache key from query text and optional config.
 * Different endpoints/models should not share cached embeddings.
 * apiKey deliberately excluded: same endpoint+model produce identical embeddings regardless of auth.
 */
export function embedCacheKey(text: string, config?: EmbeddingConnectionConfig): string {
  if (!config) return `local::${text}`;
  const endpoint = config.endpoint || "";
  const model = config.model || config.localModel || "";
  return `${endpoint}:${model}:${text}`;
}

export function getCachedEmbedding(key: string): EmbeddingVector | undefined {
  const cached = embedCache.get(key);
  if (cached === undefined) return undefined;
  // Move to end (most recently used) for LRU ordering
  embedCache.delete(key);
  embedCache.set(key, cached);
  return cached;
}

export function setCachedEmbedding(key: string, value: EmbeddingVector): void {
  // Evict oldest entry if at capacity
  if (embedCache.size >= EMBED_CACHE_MAX) {
    const oldest = embedCache.keys().next().value;
    if (oldest !== undefined) {
      embedCache.delete(oldest);
    }
  }
  embedCache.set(key, value);
}

/**
 * Clear the embedding cache. Call when the embedding model changes
 * or when you want to force fresh embeddings.
 */
export function clearEmbeddingCache(): void {
  embedCache.clear();
}
