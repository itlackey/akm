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
