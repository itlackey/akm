import { fetchWithTimeout } from "./common";
import type { EmbeddingConnectionConfig } from "./config";

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

let localEmbedder: TransformerPipeline | undefined;

async function getLocalEmbedder(): Promise<TransformerPipeline> {
  if (!localEmbedder) {
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
    localEmbedder = await pipelineFn("feature-extraction", "Xenova/all-MiniLM-L6-v2");
  }
  if (!localEmbedder) {
    throw new Error("Failed to initialize local embedder.");
  }
  return localEmbedder;
}

async function embedLocal(text: string): Promise<EmbeddingVector> {
  const model = await getLocalEmbedder();
  const result = await model(text, { pooling: "mean", normalize: true });
  return Array.from(result.data) as number[];
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

  return json.data[0].embedding;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Generate an embedding for the given text.
 * If embeddingConfig is provided, uses the configured OpenAI-compatible endpoint.
 * Otherwise falls back to local @xenova/transformers.
 */
export async function embed(text: string, embeddingConfig?: EmbeddingConnectionConfig): Promise<EmbeddingVector> {
  if (embeddingConfig) {
    return embedRemote(text, embeddingConfig);
  }
  return embedLocal(text);
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
      data: Array<{ embedding: number[] }>;
    };

    if (!json.data || json.data.length !== batch.length) {
      throw new Error(
        `Unexpected embedding batch response: expected ${batch.length} embeddings, got ${json.data?.length ?? 0}`,
      );
    }

    results.push(...json.data.map((d) => d.embedding));
  }

  return results;
}

// ── Similarity ──────────────────────────────────────────────────────────────

export function cosineSimilarity(a: EmbeddingVector, b: EmbeddingVector): number {
  const len = Math.min(a.length, b.length);
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
