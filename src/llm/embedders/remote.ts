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

/**
 * Estimate token count from character count using the ~4 chars/token heuristic.
 * No external dependency — pure arithmetic.
 */
export function estimateTokenCount(text: string): number {
  return Math.round(text.length / 4);
}

export class RemoteEmbedder implements Embedder {
  constructor(private readonly config: EmbeddingConnectionConfig) {}

  async embed(text: string): Promise<EmbeddingVector> {
    const headers = this.buildHeaders();
    const body: { input: string; model: string; dimensions?: number } = {
      input: text,
      model: this.config.model,
    };
    if (this.config.dimension) {
      body.dimensions = this.config.dimension;
    }

    const response = await fetchWithTimeout(normalizeEmbeddingEndpoint(this.config.endpoint), {
      method: "POST",
      headers,
      body: JSON.stringify(body),
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

  async embedBatch(texts: string[]): Promise<EmbeddingVector[]> {
    if (texts.length === 0) return [];
    const results: EmbeddingVector[] = [];
    const headers = this.buildHeaders();

    const batchSize = this.config.batchSize ?? DEFAULT_REMOTE_BATCH_SIZE;
    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      const batchNum = Math.floor(i / batchSize) + 1;
      const totalBatches = Math.ceil(texts.length / batchSize);
      const body: { input: string[]; model: string; dimensions?: number } = {
        input: batch,
        model: this.config.model,
      };
      if (this.config.dimension) {
        body.dimensions = this.config.dimension;
      }

      const response = await fetchWithTimeout(normalizeEmbeddingEndpoint(this.config.endpoint), {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const respBody = (await response.text().catch(() => "")).slice(0, 500);
        const docInfo = batch
          .map((text, idx) => `  [${i + idx}] ${text.length} chars, est. ${estimateTokenCount(text)} tokens`)
          .join("\n");
        const baseMsg =
          `Embedding API ${response.status} on batch ${batchNum}/${totalBatches} ` +
          `(${batch.length} doc${batch.length === 1 ? "" : "s"}):\n${docInfo}\nResponse: ${respBody}`;

        // On 400, retry each document individually to isolate the offender.
        if (response.status === 400 && batch.length > 1) {
          const offenders: number[] = [];
          for (let j = 0; j < batch.length; j++) {
            const singleBody: { input: string; model: string; dimensions?: number } = {
              input: batch[j],
              model: this.config.model,
            };
            if (this.config.dimension) {
              singleBody.dimensions = this.config.dimension;
            }
            const singleRes = await fetchWithTimeout(normalizeEmbeddingEndpoint(this.config.endpoint), {
              method: "POST",
              headers,
              body: JSON.stringify(singleBody),
            });
            if (!singleRes.ok) {
              offenders.push(i + j);
            } else {
              // Consume body to avoid resource leak
              await singleRes.json().catch(() => {});
            }
          }
          if (offenders.length > 0) {
            const offenderInfo = offenders
              .map(
                (absIdx) =>
                  `  [${absIdx}] ${batch[absIdx - i].length} chars, est. ${estimateTokenCount(batch[absIdx - i])} tokens`,
              )
              .join("\n");
            throw new Error(
              `${baseMsg}\nIsolation retry identified ${offenders.length} offending doc${offenders.length === 1 ? "" : "s"} (zero-based indices in full batch):\n${offenderInfo}`,
            );
          }
        }

        throw new Error(baseMsg);
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

/** Check whether an EmbeddingConnectionConfig has a valid remote endpoint. */
export function hasRemoteEndpoint(config: EmbeddingConnectionConfig): boolean {
  return isHttpUrl(config.endpoint);
}
