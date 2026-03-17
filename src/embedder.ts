import { fetchWithTimeout } from "./common";
import type { EmbeddingConnectionConfig } from "./config";
import { warn } from "./warn";

// ── Types ───────────────────────────────────────────────────────────────────

export type EmbeddingVector = number[];

// ── Singleton local embedder ────────────────────────────────────────────────
// localEmbedder is an intentional module-level singleton. The underlying
// @xenova/transformers pipeline is expensive to initialise (model download +
// WASM compilation) and is safe to share across calls because it is stateless
// once created. Storing it here avoids re-initialising on every embed() call.

type TransformerPipeline = (
  text: string,
  options: { pooling: string; normalize: boolean },
) => Promise<{ data: Float32Array }>;

// Cache the promise itself (not the resolved result) so concurrent calls share
// the same initialisation work and never download the model twice.
let localEmbedderPromise: Promise<TransformerPipeline> | undefined;

async function getLocalEmbedder(): Promise<TransformerPipeline> {
  if (!localEmbedderPromise) {
    localEmbedderPromise = (async () => {
      let pipeline: unknown;
      try {
        const mod = await import("@xenova/transformers");
        pipeline = mod.pipeline as unknown;
      } catch {
        throw new Error(
          "Semantic search requires @xenova/transformers. Install it with: npm install @xenova/transformers",
        );
      }
      const pipelineFn = pipeline as (task: string, model: string) => Promise<TransformerPipeline>;
      return pipelineFn("feature-extraction", "Xenova/all-MiniLM-L6-v2");
    })();
    // HI-13: Clear the cached promise on failure so the next call retries
    // instead of permanently rejecting every subsequent call with the same error.
    localEmbedderPromise.catch(() => {
      localEmbedderPromise = undefined;
    });
  }
  return localEmbedderPromise;
}

async function embedLocal(text: string): Promise<EmbeddingVector> {
  const model = await getLocalEmbedder();
  const result = await model(text, { pooling: "mean", normalize: true });
  return Array.from(result.data) as number[];
}

// ── Vector normalization ─────────────────────────────────────────────────────

/**
 * L2-normalize a vector to unit length.
 * Required for remote embeddings because the scoring pipeline's L2-to-cosine
 * conversion formula (1 - distance^2/2) is only correct for unit vectors.
 * The local embedder already normalizes via `normalize: true`.
 */
function l2Normalize(vec: number[]): number[] {
  const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
  if (norm === 0) return vec;
  return vec.map((v) => v / norm);
}

// ── OpenAI-compatible remote embedder ───────────────────────────────────────

async function embedRemote(text: string, config: EmbeddingConnectionConfig): Promise<EmbeddingVector> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.apiKey) {
    headers.Authorization = `Bearer ${config.apiKey}`;
  }

  const body: { input: string; model: string; dimensions?: number } = {
    input: text,
    model: config.model,
  };
  if (config.dimension) {
    body.dimensions = config.dimension;
  }

  const response = await fetchWithTimeout(config.endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Embedding request failed (${response.status}): ${body}`);
  }

  const json = (await response.json()) as {
    data: Array<{ embedding: number[] }>;
  };

  if (!json.data?.[0]?.embedding) {
    throw new Error("Unexpected embedding response format: missing data[0].embedding");
  }

  return l2Normalize(json.data[0].embedding);
}

// ── LRU embedding cache ─────────────────────────────────────────────────────
// Caches query embeddings to avoid redundant computation for repeated queries.
// Uses a simple Map with LRU eviction (delete + re-insert to move to end).

const EMBED_CACHE_MAX = 100;
const embedCache = new Map<string, EmbeddingVector>();

/**
 * Build a cache key from query text and optional config.
 * Different endpoints/models should not share cached embeddings.
 * apiKey deliberately excluded: same endpoint+model produce identical embeddings regardless of auth
 */
function embedCacheKey(text: string, config?: EmbeddingConnectionConfig): string {
  if (!config) return `local:${text}`;
  return `${config.endpoint}:${config.model}:${text}`;
}

/**
 * Clear the embedding cache. Call when the embedding model changes
 * or when you want to force fresh embeddings.
 */
export function clearEmbeddingCache(): void {
  embedCache.clear();
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Generate an embedding for the given text.
 * If embeddingConfig is provided, uses the configured OpenAI-compatible endpoint.
 * Otherwise falls back to local @xenova/transformers.
 *
 * Results are cached in an LRU cache (max ~100 entries) keyed by query text
 * and embedding config. Repeated identical queries return the cached vector.
 */
export async function embed(text: string, embeddingConfig?: EmbeddingConnectionConfig): Promise<EmbeddingVector> {
  const key = embedCacheKey(text, embeddingConfig);

  // Check cache first
  const cached = embedCache.get(key);
  if (cached) {
    // Move to end (most recently used) for LRU ordering
    embedCache.delete(key);
    embedCache.set(key, cached);
    return cached;
  }

  // Compute the embedding
  const result = embeddingConfig ? await embedRemote(text, embeddingConfig) : await embedLocal(text);

  // Evict oldest entry if at capacity
  if (embedCache.size >= EMBED_CACHE_MAX) {
    const oldest = embedCache.keys().next().value;
    if (oldest !== undefined) {
      embedCache.delete(oldest);
    }
  }

  embedCache.set(key, result);
  return result;
}

// ── Batch embedding ─────────────────────────────────────────────────────────

/**
 * Generate embeddings for multiple texts in batch.
 * Uses the OpenAI-compatible batch API for remote endpoints (batches of 100).
 * Falls back to sequential embedding for local transformer pipeline.
 */
export async function embedBatch(
  texts: string[],
  embeddingConfig?: EmbeddingConnectionConfig,
): Promise<EmbeddingVector[]> {
  if (texts.length === 0) return [];

  if (embeddingConfig) {
    return embedRemoteBatch(texts, embeddingConfig);
  }

  // Local transformer: process sequentially (pipeline handles one at a time)
  const results: EmbeddingVector[] = [];
  for (const text of texts) {
    results.push(await embedLocal(text));
  }
  return results;
}

async function embedRemoteBatch(texts: string[], config: EmbeddingConnectionConfig): Promise<EmbeddingVector[]> {
  const BATCH_SIZE = 100;
  const results: EmbeddingVector[] = [];
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.apiKey) {
    headers.Authorization = `Bearer ${config.apiKey}`;
  }

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const body: { input: string[]; model: string; dimensions?: number } = {
      input: batch,
      model: config.model,
    };
    if (config.dimension) {
      body.dimensions = config.dimension;
    }

    const response = await fetchWithTimeout(config.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const respBody = await response.text().catch(() => "");
      throw new Error(`Embedding batch request failed (${response.status}): ${respBody}`);
    }

    const json = (await response.json()) as {
      data: Array<{ embedding: number[]; index: number }>;
    };

    if (!json.data || json.data.length !== batch.length) {
      throw new Error(
        `Unexpected embedding batch response: expected ${batch.length} embeddings, got ${json.data?.length ?? 0}`,
      );
    }

    // Sort by index to guarantee correct order (OpenAI API doesn't guarantee order)
    const sorted = [...json.data].sort((a, b) => a.index - b.index);

    for (const [idx, d] of sorted.entries()) {
      if (!Array.isArray(d.embedding)) {
        throw new Error(`Unexpected embedding at batch index ${idx}: missing or invalid`);
      }
      results.push(l2Normalize(d.embedding));
    }
  }

  return results;
}

// ── Similarity ──────────────────────────────────────────────────────────────

export function cosineSimilarity(a: EmbeddingVector, b: EmbeddingVector): number {
  if (a.length !== b.length) {
    // MD-4: Return 0 on dimension mismatch rather than silently computing on a
    // truncated view, which would produce meaningless similarity scores.
    warn("cosineSimilarity: vector dimension mismatch (%d vs %d) — re-index recommended", a.length, b.length);
    return 0;
  }
  const len = a.length;
  if (len === 0) return 0;
  let dot = 0,
    magA = 0,
    magB = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

// ── Availability check ──────────────────────────────────────────────────────

export async function isEmbeddingAvailable(embeddingConfig?: EmbeddingConnectionConfig): Promise<boolean> {
  if (embeddingConfig) {
    try {
      await embedRemote("test", embeddingConfig);
      return true;
    } catch {
      return false;
    }
  }
  try {
    await getLocalEmbedder();
    return true;
  } catch {
    return false;
  }
}
