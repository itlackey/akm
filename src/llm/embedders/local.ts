// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Local embedder backed by the external @huggingface/transformers package.
 *
 * Encapsulates the transformer pipeline lifecycle as instance state on a
 * `LocalEmbedder` so tests can construct fresh instances without leaking
 * pipelines across tests. The facade in `../embedder.ts` keeps a single
 * shared instance for the production code path.
 */

import path from "node:path";
import { getCacheDir } from "../../core/paths";
import { warn } from "../../core/warn";
import type { Embedder, EmbeddingVector } from "./types";

/**
 * Default local transformer model for embeddings.
 * `bge-small-en-v1.5` scores higher on MTEB benchmarks than the previous
 * `all-MiniLM-L6-v2` at the same 384-dimension footprint.
 */
export const DEFAULT_LOCAL_MODEL = "Xenova/bge-small-en-v1.5";

/**
 * Batch Tensor shape returned by @huggingface/transformers feature-extraction
 * when given a string[]. The pipeline returns a single Tensor object (NOT an
 * Array<{data}>). The flat `.data` Float32Array has `batch * dim` elements;
 * `.dims` is [batch, dim] so each row is `dims[1]` floats wide.
 */
interface TransformerBatchTensor {
  data: Float32Array;
  dims: readonly [number, number];
}

/** Exact @huggingface/transformers 4.2 feature-extraction result overloads. */
interface TransformerPipeline {
  (input: string, options: { pooling: string; normalize: boolean }): Promise<{ data: Float32Array }>;
  (input: string[], options: { pooling: string; normalize: boolean }): Promise<TransformerBatchTensor>;
}

type TransformerPipelineFactory = (
  task: string,
  model: string,
  options?: { dtype?: string },
) => Promise<TransformerPipeline>;

/** Type-guard: true when the value looks like a batch Tensor (has .dims). */
function isBatchTensor(v: unknown): v is TransformerBatchTensor {
  return (
    v !== null &&
    typeof v === "object" &&
    (v as TransformerBatchTensor).data instanceof Float32Array &&
    "dims" in (v as object) &&
    Array.isArray((v as TransformerBatchTensor).dims) &&
    (v as TransformerBatchTensor).dims.length === 2 &&
    (v as TransformerBatchTensor).dims.every((dim) => Number.isInteger(dim) && dim > 0)
  );
}

// ── Test seam ────────────────────────────────────────────────────────────────
// Swap-and-restore override for the dynamic Transformers.js import.
// Inert in production; only tests install fakes, via tests/_helpers/seams.ts
// (which restores them automatically). See docs/architecture/specs/di-seams-plan.md.

interface TransformersEnvironment {
  allowRemoteModels?: boolean;
  backends?: unknown;
  cacheDir?: string | null;
}

function isEnabledEnvironmentFlag(value: string | undefined): boolean {
  return /^(?:1|true|yes|on)$/i.test(value?.trim() ?? "");
}

interface TransformersModule {
  env: TransformersEnvironment;
  pipeline: unknown;
}

export type TransformersLoader = () => Promise<TransformersModule>;

const realTransformersLoader: TransformersLoader = () =>
  import("@huggingface/transformers") as Promise<TransformersModule>;

let transformersLoader: TransformersLoader = realTransformersLoader;

/** TEST-ONLY. Swap the transformers module loader; pass undefined to restore. */
export function _setTransformersLoaderForTests(fake?: TransformersLoader): void {
  transformersLoader = fake ?? realTransformersLoader;
}

const LOCAL_EMBEDDER_DTYPE = "fp32";
const LOCAL_EMBEDDER_FALLBACK_DTYPE = "auto";

/**
 * Maximum texts per batch for the local transformers pipeline. The pipeline
 * can run genuine batched inference over a string array; 32 is a safe default
 * that fits well inside most model context budgets while providing 10–50×
 * throughput improvement over one-at-a-time calls on the cold minority.
 */
const LOCAL_BATCH_SIZE = 32;

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

  async embed(text: string, signal?: AbortSignal): Promise<EmbeddingVector> {
    if (signal?.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error("embedding interrupted");
    }
    return this.embedWithModel(text, this.defaultModel);
  }

  /**
   * Embed a batch of texts. Processes in chunks of `LOCAL_BATCH_SIZE` (32) so
   * the transformers pipeline can run genuine batched inference rather than one
   * call per text. Each chunk is checked against the AbortSignal between calls.
   *
   * `onBatch`, when given, fires once per chunk (indices into `texts` + the
   * chunk's embeddings) as it completes (#954) — parity with
   * `RemoteEmbedder.embedBatch`'s per-provider-batch commit callback, so a
   * caller committing per batch does not need to special-case the local path.
   */
  async embedBatch(
    texts: string[],
    signal?: AbortSignal,
    onBatch?: (indices: number[], embeddings: EmbeddingVector[]) => void,
  ): Promise<EmbeddingVector[]> {
    if (texts.length === 0) return [];
    if (signal?.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error("embedding interrupted");
    }
    const pipeline = await this.getPipeline(this.defaultModel);
    const results: EmbeddingVector[] = [];

    for (let i = 0; i < texts.length; i += LOCAL_BATCH_SIZE) {
      if (signal?.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new Error("embedding interrupted");
      }
      const chunk = texts.slice(i, i + LOCAL_BATCH_SIZE);
      // @huggingface/transformers 4.2 returns a single batch Tensor. Validate
      // that exact shape and propagate inference failures without re-executing
      // the same inputs through a second runtime path.
      const batchResult = await pipeline(chunk, {
        pooling: "mean",
        normalize: true,
      });
      if (!isBatchTensor(batchResult)) {
        throw new Error("unexpected pipeline return shape for batch input");
      }
      const [batch, dim] = batchResult.dims;
      if (batch !== chunk.length || batchResult.data.length !== batch * dim) {
        throw new Error("unexpected pipeline return shape for batch input");
      }
      const chunkEmbeddings: EmbeddingVector[] = [];
      for (let row = 0; row < chunk.length; row++) {
        chunkEmbeddings.push(Array.from(batchResult.data.subarray(row * dim, (row + 1) * dim)) as number[]);
      }
      results.push(...chunkEmbeddings);
      onBatch?.(
        Array.from({ length: chunk.length }, (_, row) => i + row),
        chunkEmbeddings,
      );
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
          const mod = await transformersLoader();
          // Transformers.js 4.x defaults its filesystem cache underneath the
          // installed package and no longer derives it from HF_HOME. Point the
          // public runtime setting at our stable cache explicitly so package
          // reinstalls and test-sandbox HOME rotation do not re-download the
          // model. The exact pinned 4.2 module owns this public environment.
          mod.env.cacheDir = process.env.HF_HOME;
          if (isEnabledEnvironmentFlag(process.env.HF_HUB_OFFLINE)) {
            mod.env.allowRemoteModels = false;
          }
          pipeline = mod.pipeline;
        } catch (importError) {
          const msg = importError instanceof Error ? importError.message : String(importError);
          if (/Cannot find (?:module|package)|MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND|Cannot resolve/i.test(msg)) {
            throw new Error("Semantic search requires @huggingface/transformers. Reinstall akm-cli.");
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
 * Check whether the declared Transformers dependency can be resolved without
 * loading a model.
 */
export function isTransformersAvailable(): boolean {
  try {
    import.meta.resolve("@huggingface/transformers");
    return true;
  } catch {
    return false;
  }
}
