/**
 * OpenAI-compatible remote embedder.
 *
 * Calls the configured `/embeddings` endpoint and L2-normalizes the returned
 * vectors so the scoring pipeline's L2-to-cosine conversion is correct.
 */

import { fetchWithTimeout, isHttpUrl } from "../../core/common";
import type { EmbeddingConnectionConfig } from "../../core/config";
import type { Embedder, EmbeddingVector } from "./types";

const DEFAULT_REMOTE_BATCH_SIZE = 100;

/** Cheap token estimator: 4 chars ≈ 1 token. Used in verbose logging and error messages. */
export function estimateTokenCount(text: string): number {
  return Math.round(text.length / 4);
}

export class RemoteEmbedder implements Embedder {
  constructor(private readonly config: EmbeddingConnectionConfig) {}

  async embed(text: string, signal?: AbortSignal): Promise<EmbeddingVector> {
    const headers = this.buildHeaders();
    const body: { input: string; model: string; dimensions?: number; options?: { num_ctx?: number } } = {
      input: text,
      model: this.config.model,
    };
    if (this.config.dimension) {
      body.dimensions = this.config.dimension;
    }
    const ollamaOpts = resolveOllamaOptions(this.config);
    if (ollamaOpts) {
      body.options = ollamaOpts;
    }

    const response = await fetchWithTimeout(normalizeEmbeddingEndpoint(this.config.endpoint), {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => "");
      throw new Error(`Embedding request failed (${response.status}): ${errBody}`);
    }

    const json = (await response.json()) as { data: Array<{ embedding: number[] }> };

    if (!json.data?.[0]?.embedding) {
      throw new Error(
        `Unexpected embedding response format: missing data[0].embedding.${embeddingEndpointPathHint(this.config.endpoint)}`,
      );
    }

    return l2Normalize(json.data[0].embedding);
  }

  async embedBatch(texts: string[], signal?: AbortSignal): Promise<EmbeddingVector[]> {
    if (texts.length === 0) return [];
    const results: EmbeddingVector[] = [];
    const headers = this.buildHeaders();

    const ollamaOpts = resolveOllamaOptions(this.config);
    const batchSize = this.config.batchSize ?? DEFAULT_REMOTE_BATCH_SIZE;
    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      const body: { input: string[]; model: string; dimensions?: number; options?: { num_ctx?: number } } = {
        input: batch,
        model: this.config.model,
      };
      if (this.config.dimension) {
        body.dimensions = this.config.dimension;
      }
      if (ollamaOpts) {
        body.options = ollamaOpts;
      }

      const response = await fetchWithTimeout(normalizeEmbeddingEndpoint(this.config.endpoint), {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal,
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
          `Unexpected embedding batch response: expected ${batch.length} embeddings, got ${json.data?.length ?? 0}.${embeddingEndpointPathHint(this.config.endpoint)}`,
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

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.config.apiKey) {
      headers.Authorization = `Bearer ${this.config.apiKey}`;
    }
    return headers;
  }
}

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

export function normalizeEmbeddingEndpoint(endpoint: string): string {
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

/**
 * Resolve Ollama-native `options` from the embedding config.
 *
 * Resolution order:
 *   1. `ollamaOptions` — forwarded verbatim (explicit opt-in, takes precedence).
 *   2. `contextLength` — wrapped as `{ num_ctx: contextLength }`.
 *   3. Neither set → returns `undefined` (no `options` field in the request body).
 *
 * These options are only meaningful for Ollama's native `/api/embed` endpoint.
 * OpenAI-compatible endpoints ignore unknown request fields, so passing them to
 * other providers is harmless but has no effect.
 */
function resolveOllamaOptions(config: EmbeddingConnectionConfig): { num_ctx?: number } | undefined {
  if (config.ollamaOptions && Object.keys(config.ollamaOptions).length > 0) {
    return config.ollamaOptions;
  }
  if (config.contextLength) {
    return { num_ctx: config.contextLength };
  }
  return undefined;
}

/** Check whether an EmbeddingConnectionConfig has a valid remote endpoint. */
export function hasRemoteEndpoint(config: EmbeddingConnectionConfig): boolean {
  return isHttpUrl(config.endpoint);
}
