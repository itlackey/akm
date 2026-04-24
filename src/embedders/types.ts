/**
 * Shared embedder types.
 *
 * Pulled out of `embedder.ts` so concrete implementations (`local.ts`,
 * `remote.ts`) and the cache layer can depend on a small, stable types
 * module without dragging in the facade or a sibling implementation.
 */

export type EmbeddingVector = number[];

/**
 * Common embedder interface implemented by both the local
 * (@huggingface/transformers) and remote (OpenAI-compatible) embedders.
 *
 * Both methods are required: query paths use `embed()`, indexer paths use
 * `embedBatch()` for throughput.
 */
export interface Embedder {
  embed(text: string): Promise<EmbeddingVector>;
  embedBatch(texts: string[]): Promise<EmbeddingVector[]>;
}

export type EmbeddingCheckResult =
  | { available: true }
  | { available: false; reason: "missing-package" | "model-download-failed" | "remote-unreachable"; message: string };

/**
 * Cosine similarity between two embedding vectors.
 *
 * Lives next to {@link EmbeddingVector} so importers (notably `db.ts`)
 * can pull just the math without dragging in the embedder facade and its
 * transitive `@huggingface/transformers` import chain.
 *
 * Returns 0 when the vectors have different dimensions — silently
 * computing on a truncated view would produce meaningless scores.
 */
export function cosineSimilarity(a: EmbeddingVector, b: EmbeddingVector): number {
  if (a.length !== b.length) {
    warn("cosineSimilarity: vector dimension mismatch (%d vs %d) — re-index recommended", a.length, b.length);
    return 0;
  }
  const len = a.length;
  if (len === 0) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

// Imported lazily to keep this types module dependency-free where possible;
// `warn` is a thin printf wrapper so the cost is negligible.
import { warn } from "../warn";
