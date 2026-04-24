/**
 * Local @huggingface/transformers embedder.
 *
 * Encapsulates the transformer pipeline lifecycle as instance state on a
 * `LocalEmbedder` so tests can construct fresh instances without leaking
 * pipelines across tests. The facade in `../embedder.ts` keeps a single
 * shared instance for the production code path.
 */

import path from "node:path";
import { getCacheDir } from "../paths";
import { warn } from "../warn";
import type { Embedder, EmbeddingVector } from "./types";

/**
 * Default local transformer model for embeddings.
 * `bge-small-en-v1.5` scores higher on MTEB benchmarks than the previous
 * `all-MiniLM-L6-v2` at the same 384-dimension footprint.
 */
export const DEFAULT_LOCAL_MODEL = "Xenova/bge-small-en-v1.5";

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

/**
 * Return the local model name that will be used for embedding.
 * When `overrideModel` is provided it takes precedence; otherwise
 * the default model is returned.
 */
function resolveLocalModelName(overrideModel?: string): string {
  return overrideModel || DEFAULT_LOCAL_MODEL;
}

export class LocalEmbedder implements Embedder {
  /**
   * Cache the *promise* (not the resolved result) so concurrent calls share
   * the same initialisation work and never download the model twice. Keyed
   * by model name so switching models gets a fresh pipeline.
   */
  private pipelinePromise?: Promise<TransformerPipeline>;
  private pipelineModelName?: string;

  constructor(private readonly defaultModel?: string) {}

  /** Reset the cached pipeline (used by tests and by `resetLocalEmbedder()`). */
  reset(): void {
    this.pipelinePromise = undefined;
    this.pipelineModelName = undefined;
  }

  async embed(text: string): Promise<EmbeddingVector> {
    return this.embedWithModel(text, this.defaultModel);
  }

  async embedBatch(texts: string[]): Promise<EmbeddingVector[]> {
    if (texts.length === 0) return [];
    const results: EmbeddingVector[] = [];
    for (const text of texts) {
      results.push(await this.embedWithModel(text, this.defaultModel));
    }
    return results;
  }

  /** Embed using a model name override (used by the facade for per-call model overrides). */
  async embedWithModel(text: string, modelName?: string): Promise<EmbeddingVector> {
    const pipeline = await this.getPipeline(modelName);
    const result = await pipeline(text, { pooling: "mean", normalize: true });
    return Array.from(result.data) as number[];
  }

  /**
   * Eagerly load (or return the cached) underlying pipeline. Used by
   * availability checks that want to surface model-download failures
   * without performing a real embed call.
   */
  async getPipeline(modelName?: string): Promise<TransformerPipeline> {
    const resolvedModel = resolveLocalModelName(modelName);
    if (this.pipelinePromise && this.pipelineModelName !== resolvedModel) {
      this.pipelinePromise = undefined;
      this.pipelineModelName = undefined;
    }
    if (!this.pipelinePromise) {
      this.pipelineModelName = resolvedModel;
      this.pipelinePromise = (async () => {
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
      this.pipelinePromise.catch(() => {
        this.pipelinePromise = undefined;
        this.pipelineModelName = undefined;
      });
    }
    return this.pipelinePromise;
  }
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

/**
 * Check whether the `@huggingface/transformers` package can be imported.
 * Returns `true` if it can, `false` otherwise.
 */
export async function isTransformersAvailable(): Promise<boolean> {
  try {
    await import("@huggingface/transformers");
    return true;
  } catch {
    return false;
  }
}
