// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Local @huggingface/transformers embedder.
 *
 * Encapsulates the transformer pipeline lifecycle as instance state on a
 * `LocalEmbedder` so tests can construct fresh instances without leaking
 * pipelines across tests. The facade in `../embedder.ts` keeps a single
 * shared instance for the production code path.
 */

import path from "node:path";
import { getCacheDir } from "../../core/paths";
import { warn } from "../../core/warn";
import { getDirname, resolveModule } from "../../runtime";
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
  dims: number[];
}

/**
 * The pipeline accepts both a single string and a string[]. For a single
 * string it returns `{ data: Float32Array }` (single embedding); for a string[]
 * it returns a `TransformerBatchTensor` with `.dims = [batch, dim]`.
 */
type TransformerPipeline = (
  input: string | string[],
  options: { pooling: string; normalize: boolean },
) => Promise<{ data: Float32Array } | TransformerBatchTensor>;

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
    "data" in (v as object) &&
    "dims" in (v as object) &&
    Array.isArray((v as TransformerBatchTensor).dims) &&
    (v as TransformerBatchTensor).dims.length >= 2
  );
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

/**
 * Detect whether the current process is running from a Bun-compiled binary
 * (i.e. `bun build --compile` produced a single executable). Bun marks the
 * compiled binary with a synthesized `process.execPath` that ends in the
 * binary name rather than `bun`, AND sets a flag we can probe.
 *
 * Used to gate the "install @huggingface/transformers" hint — that advice
 * is impossible to follow from a single-binary install, so we replace it
 * with the only working remediation (switch to npm/Bun install, or turn
 * semantic search off). See #482.
 */
function isCompiledBinary(): boolean {
  try {
    const flag = (Bun as unknown as { embeddedFiles?: unknown; main?: string }).embeddedFiles;
    if (flag !== undefined) return true;
  } catch {
    // Bun not available (under Node tests, for example) — treat as not-binary.
  }
  const exec = (process.execPath || "").toLowerCase();
  if (exec.endsWith("/akm") || exec.endsWith("\\akm.exe")) return true;
  return false;
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
   * call per text. Falls back to one-at-a-time if the pipeline does not support
   * array input (older versions of @huggingface/transformers). Each chunk is
   * checked against the AbortSignal between calls.
   */
  async embedBatch(texts: string[], signal?: AbortSignal): Promise<EmbeddingVector[]> {
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
      try {
        // @huggingface/transformers feature-extraction pipeline accepts a
        // string[] and returns a batch Tensor (NOT an Array<{data}>).
        // The Tensor has .data (flat Float32Array, length = batch * dim) and
        // .dims = [batch, dim]. Slice .data into per-row vectors using .dims.
        const batchResult = await pipeline(chunk, {
          pooling: "mean",
          normalize: true,
        });
        if (isBatchTensor(batchResult)) {
          const dim = batchResult.dims[1] as number;
          for (let row = 0; row < chunk.length; row++) {
            results.push(Array.from(batchResult.data.subarray(row * dim, (row + 1) * dim)) as number[]);
          }
        } else if (Array.isArray(batchResult)) {
          // Older versions of @huggingface/transformers returned Array<{data}>.
          for (const r of batchResult as Array<{ data: Float32Array }>) {
            results.push(Array.from(r.data) as number[]);
          }
        } else {
          // Single-text result returned for a chunk — should not happen for
          // string[] input, but handle defensively.
          throw new Error("unexpected pipeline return shape for batch input");
        }
      } catch {
        // Fallback: process one-at-a-time (older pipeline versions or mismatched
        // return type). Fail-open per text: a single failure aborts the chunk.
        for (const text of chunk) {
          if (signal?.aborted) {
            throw signal.reason instanceof Error ? signal.reason : new Error("embedding interrupted");
          }
          results.push(await this.embedWithModel(text, this.defaultModel));
        }
      }
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
            // #482: the prebuilt binary build is invoked with
            // `bun install --omit optional` (release.yml), so binary users
            // can NEVER load @huggingface/transformers. Telling them to
            // `bun add` it is a dead-end — there is no install target.
            // Detect the binary execution path and give the only working
            // remediation: switch to the npm/Bun install of akm-cli, or
            // turn off semantic search.
            const isBinary = isCompiledBinary();
            const hint = isBinary
              ? "You are running the prebuilt akm binary, which cannot load optional native dependencies. " +
                "To enable semantic search, install akm-cli via Bun: `curl -fsSL https://bun.sh/install | bash && bun install -g akm-cli`. " +
                "To keep using the binary, set `semanticSearchMode: off` in your config and use keyword-only FTS."
              : "Install it with: `bun add @huggingface/transformers` (or `npm install @huggingface/transformers`).";
            throw new Error(`Semantic search requires @huggingface/transformers. ${hint}`);
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
 * Check whether the `@huggingface/transformers` package can be resolved.
 * Uses the runtime boundary's `resolveModule` so we never load the module
 * (which would trigger heavy WASM/model side-effects) just to test
 * availability. `resolveModule` uses `Bun.resolveSync` on Bun and
 * `require.resolve` on Node.
 */
export function isTransformersAvailable(): boolean {
  try {
    resolveModule("@huggingface/transformers", getDirname(import.meta.url));
    return true;
  } catch {
    return false;
  }
}
