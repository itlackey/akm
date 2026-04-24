import path from "node:path";
import { fetchWithTimeout, isHttpUrl } from "./common";
import type { EmbeddingConnectionConfig } from "./config";
import { getCacheDir } from "./paths";
import { warn } from "./warn";

// ── Types ───────────────────────────────────────────────────────────────────

export type EmbeddingVector = number[];

// ── Default local model ─────────────────────────────────────────────────────
/**
 * Default local transformer model for embeddings.
 * `bge-small-en-v1.5` scores higher on MTEB benchmarks than the previous
 * `all-MiniLM-L6-v2` at the same 384-dimension footprint.
 */
export const DEFAULT_LOCAL_MODEL = "Xenova/bge-small-en-v1.5";

/**
 * Return the local model name that will be used for embedding.
 * When `overrideModel` is provided it takes precedence; otherwise
 * the default model is returned.
 */
function getLocalModelName(overrideModel?: string): string {
  return overrideModel || DEFAULT_LOCAL_MODEL;
}

// ── Singleton local embedder ────────────────────────────────────────────────
// localEmbedder is an intentional module-level singleton. The underlying
// @huggingface/transformers pipeline is expensive to initialise (model download +
// WASM compilation) and is safe to share across calls because it is stateless
// once created. Storing it here avoids re-initialising on every embed() call.

type TransformerPipeline = (
  text: string,
  options: { pooling: string; normalize: boolean },
) => Promise<{ data: Float32Array }>;

type TransformerPipelineFactory = (
  task: string,
  model: string,
  options?: { dtype?: string },
) => Promise<TransformerPipeline>;

const LOCAL_EMBEDDER_DTYPE = "fp32";
const LOCAL_EMBEDDER_FALLBACK_DTYPE = "auto";

// Cache the promise itself (not the resolved result) so concurrent calls share
// the same initialisation work and never download the model twice.
// The cache is keyed by model name so switching models gets a fresh pipeline.
let localEmbedderPromise: Promise<TransformerPipeline> | undefined;
let localEmbedderModelName: string | undefined;

async function getLocalEmbedder(modelName?: string): Promise<TransformerPipeline> {
  const resolvedModel = getLocalModelName(modelName);
  // If the cached pipeline was created for a different model, discard it.
  if (localEmbedderPromise && localEmbedderModelName !== resolvedModel) {
    localEmbedderPromise = undefined;
    localEmbedderModelName = undefined;
  }
  if (!localEmbedderPromise) {
    localEmbedderModelName = resolvedModel;
    localEmbedderPromise = (async () => {
      // Ensure HuggingFace model cache lives in a stable location outside
      // node_modules so it survives package reinstalls.
      if (!process.env.HF_HOME) {
        process.env.HF_HOME = path.join(getCacheDir(), "models");
      }

      let pipeline: unknown;
      try {
        const mod = await import("@huggingface/transformers");
        pipeline = mod.pipeline as unknown;
      } catch (importError) {
        const msg = importError instanceof Error ? importError.message : String(importError);
        if (/Cannot find module|MODULE_NOT_FOUND|Cannot resolve/i.test(msg)) {
          throw new Error(
            "Semantic search requires @huggingface/transformers. Install it with: bun add @huggingface/transformers",
          );
        }
        throw new Error(`Failed to load embedding runtime: ${msg}. Check platform compatibility.`);
      }
      const pipelineFn = pipeline as TransformerPipelineFactory;
      return createLocalPipeline(pipelineFn, resolvedModel);
    })();
    // HI-13: Clear the cached promise on failure so the next call retries
    // instead of permanently rejecting every subsequent call with the same error.
    localEmbedderPromise.catch(() => {
      localEmbedderPromise = undefined;
      localEmbedderModelName = undefined;
    });
  }
  return localEmbedderPromise;
}

async function createLocalPipeline(
  pipelineFn: TransformerPipelineFactory,
  modelName: string,
): Promise<TransformerPipeline> {
  try {
    return await pipelineFn("feature-extraction", modelName, { dtype: LOCAL_EMBEDDER_DTYPE });
  } catch (error) {
    if (!shouldRetryWithoutExplicitDtype(error)) {
      throw error;
    }

    warn(
      'Local embedding model "%s" rejected explicit dtype "%s"; retrying with explicit fallback dtype "%s".',
      modelName,
      LOCAL_EMBEDDER_DTYPE,
      LOCAL_EMBEDDER_FALLBACK_DTYPE,
    );
    return pipelineFn("feature-extraction", modelName, { dtype: LOCAL_EMBEDDER_FALLBACK_DTYPE });
  }
}

function shouldRetryWithoutExplicitDtype(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /dtype|fp32|precision|quant/i.test(message);
}

export function resetLocalEmbedder(): void {
  localEmbedderPromise = undefined;
  localEmbedderModelName = undefined;
}

async function embedLocal(text: string, modelName?: string): Promise<EmbeddingVector> {
  const model = await getLocalEmbedder(modelName);
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

function normalizeEmbeddingEndpoint(endpoint: string): string {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    return endpoint;
  }

  const normalizedPath = parsed.pathname.replace(/\/+$/, "");
  if (normalizedPath.endsWith("/embeddings")) {
    return parsed.toString();
  }

  parsed.pathname = normalizedPath ? `${normalizedPath}/embeddings` : "/embeddings";
  return parsed.toString();
}

function embeddingEndpointPathHint(endpoint: string): string {
  const normalizedEndpoint = normalizeEmbeddingEndpoint(endpoint);
  if (normalizedEndpoint !== endpoint) {
    return ` Check that your endpoint includes the full embeddings path (for example "${normalizedEndpoint}", not just "${endpoint}").`;
  }
  return "";
}

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

  const response = await fetchWithTimeout(normalizeEmbeddingEndpoint(config.endpoint), {
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
    throw new Error(
      `Unexpected embedding response format: missing data[0].embedding.${embeddingEndpointPathHint(config.endpoint)}`,
    );
  }

  return l2Normalize(json.data[0].embedding);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Check whether an EmbeddingConnectionConfig has a valid remote endpoint. */
function hasRemoteEndpoint(config: EmbeddingConnectionConfig): boolean {
  return isHttpUrl(config.endpoint);
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
  if (!config) return `local::${text}`;
  const endpoint = config.endpoint || "";
  const model = config.model || config.localModel || "";
  return `${endpoint}:${model}:${text}`;
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
 * If embeddingConfig has a remote endpoint, uses the configured OpenAI-compatible endpoint.
 * Otherwise falls back to local @huggingface/transformers using the model from
 * `embeddingConfig.localModel` or `DEFAULT_LOCAL_MODEL`.
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
  const result =
    embeddingConfig && hasRemoteEndpoint(embeddingConfig)
      ? await embedRemote(text, embeddingConfig)
      : await embedLocal(text, embeddingConfig?.localModel);

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

  if (embeddingConfig && hasRemoteEndpoint(embeddingConfig)) {
    return embedRemoteBatch(texts, embeddingConfig);
  }

  // Local transformer: process sequentially (pipeline handles one at a time)
  const localModel = embeddingConfig?.localModel;
  const results: EmbeddingVector[] = [];
  for (const text of texts) {
    results.push(await embedLocal(text, localModel));
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

    const response = await fetchWithTimeout(normalizeEmbeddingEndpoint(config.endpoint), {
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
        `Unexpected embedding batch response: expected ${batch.length} embeddings, got ${json.data?.length ?? 0}.${embeddingEndpointPathHint(config.endpoint)}`,
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

/**
 * Check whether the `@huggingface/transformers` package can be resolved.
 * Uses `Bun.resolve()` so we never load the module (which would trigger
 * heavy WASM/model side-effects) just to test availability.
 *
 * Falls back to `require.resolve` when `Bun.resolve` is unavailable
 * (e.g. running under Node), so the function still works in mixed runtimes.
 */
export function isTransformersAvailable(): boolean {
  try {
    if (typeof Bun !== "undefined" && typeof Bun.resolveSync === "function") {
      Bun.resolveSync("@huggingface/transformers", import.meta.dir);
      return true;
    }
  } catch {
    return false;
  }
  try {
    const req = (globalThis as { require?: { resolve?: (id: string) => string } }).require;
    if (req && typeof req.resolve === "function") {
      req.resolve("@huggingface/transformers");
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

export type EmbeddingCheckResult =
  | { available: true }
  | { available: false; reason: "missing-package" | "model-download-failed" | "remote-unreachable"; message: string };

/**
 * Check whether embedding is available with a detailed reason on failure.
 */
export async function checkEmbeddingAvailability(
  embeddingConfig?: EmbeddingConnectionConfig,
): Promise<EmbeddingCheckResult> {
  if (embeddingConfig && hasRemoteEndpoint(embeddingConfig)) {
    try {
      await embedRemote("test", embeddingConfig);
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
    await getLocalEmbedder(embeddingConfig?.localModel);
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
