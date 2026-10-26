// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Local embedder: a BERT-family embedding model run with onnxruntime-node,
 * its text encoded by @huggingface/tokenizers, mean-pooled over the attention
 * mask and L2-normalised.
 *
 * Encapsulates the model's lifecycle as instance state on a `LocalEmbedder` so
 * tests can construct fresh instances without leaking loaded models across
 * tests. The facade in `../embedder.ts` keeps a single shared instance for the
 * production code path.
 */

import fs from "node:fs";
import path from "node:path";
import { preloadOnnxRuntimeLibrary } from "../../standalone/onnxruntime-library";
import { ensureLocalModelFiles } from "./local-model-files";
import type { Embedder, EmbeddingVector } from "./types";

/**
 * Default local model for embeddings.
 * `bge-small-en-v1.5` scores higher on MTEB benchmarks than the previous
 * `all-MiniLM-L6-v2` at the same 384-dimension footprint.
 */
export const DEFAULT_LOCAL_MODEL = "Xenova/bge-small-en-v1.5";

/** The runtime the local embedder reports once its model has loaded. */
export const LOCAL_EMBEDDING_RUNTIME = "onnxruntime-node";

/** The loaded model: one L2-normalised vector per text, in order. */
type LocalPipeline = (texts: string[]) => Promise<Float32Array[]>;

/** The embedding runtime is not usable on this machine (no native library, a failed load). */
export class LocalRuntimeUnavailableError extends Error {}

// ── Test seam ────────────────────────────────────────────────────────────────
// Swap-and-restore override for the model loader (model files, runtime, tokenizer).
// Inert in production; only tests install fakes, via tests/_helpers/seams.ts
// (which restores them automatically). See docs/architecture/specs/di-seams-plan.md.

export type LocalPipelineLoader = (modelName: string) => Promise<LocalPipeline>;

let pipelineLoader: LocalPipelineLoader = loadOnnxPipeline;

/** TEST-ONLY. Swap the model loader; pass undefined to restore. */
export function _setLocalPipelineLoaderForTests(fake?: LocalPipelineLoader): void {
  pipelineLoader = fake ?? loadOnnxPipeline;
}

/**
 * Maximum texts per batch for the local model. 32 is a safe default that fits
 * well inside most model context budgets while providing 10–50× throughput
 * improvement over one-at-a-time calls on the cold minority.
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
 * A standalone binary built for a target with no native library (`none`) must not
 * bundle the package: its addon for that platform does not exist. The bundler
 * drops only the branch a build constant rules out, so the import sits in an
 * `else`, not after the `throw`.
 */
async function importOnnxRuntime(): Promise<typeof import("onnxruntime-node")> {
  if (typeof AKM_STANDALONE_NATIVE_MODULE !== "undefined" && AKM_STANDALONE_NATIVE_MODULE === "./native/none") {
    throw new Error("no native library is available for this platform");
  } else {
    await preloadOnnxRuntimeLibrary();
    return import("onnxruntime-node");
  }
}

async function loadOnnxRuntime(): Promise<typeof import("onnxruntime-node")> {
  try {
    return await importOnnxRuntime();
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    // Only the package itself missing calls for a reinstall; a platform it ships no addon for (Intel macOS) fails on
    // `../bin/napi-v6/<platform>/<arch>/onnxruntime_binding.node` and is reported below.
    if (/Cannot find (?:module|package) ['"]onnxruntime-node['"]/.test(msg)) {
      throw new LocalRuntimeUnavailableError("Semantic search requires onnxruntime-node. Reinstall akm-cli.");
    }
    throw new LocalRuntimeUnavailableError(
      `Failed to load the embedding runtime (onnxruntime-node): ${msg}. Semantic search with the local model is unavailable; keyword search still works.`,
    );
  }
}

/** The mean of one text's token vectors (padding excluded), scaled to unit length. */
function meanPooled(hidden: Float32Array, offset: number, tokens: number, dim: number): Float32Array {
  const vector = new Float32Array(dim);
  for (let token = 0; token < tokens; token++) {
    for (let k = 0; k < dim; k++) vector[k] = vector[k]! + hidden[offset + token * dim + k]!;
  }
  let norm = 0;
  for (let k = 0; k < dim; k++) {
    vector[k] = vector[k]! / tokens;
    norm += vector[k]! ** 2;
  }
  return vector.map((value) => value / Math.sqrt(norm));
}

async function loadOnnxPipeline(modelName: string): Promise<LocalPipeline> {
  const ort = await loadOnnxRuntime();
  const { Tokenizer } = await import("@huggingface/tokenizers");
  const modelDir = await ensureLocalModelFiles(modelName);
  const readJson = (file: string): object => JSON.parse(fs.readFileSync(path.join(modelDir, file), "utf8"));
  const tokenizerConfig = readJson("tokenizer_config.json") as { model_max_length?: unknown };
  const tokenizer = new Tokenizer(readJson("tokenizer.json"), tokenizerConfig);
  const maxLength =
    typeof tokenizerConfig.model_max_length === "number" ? tokenizerConfig.model_max_length : Number.POSITIVE_INFINITY;
  const session = await ort.InferenceSession.create(path.join(modelDir, "onnx", "model.onnx"), {
    executionProviders: ["cpu"],
    logSeverityLevel: 3,
  });

  return async (texts) => {
    // A text longer than the model's maximum is cut to it. Shorter ones are padded
    // to the longest in the batch; the mask keeps padding out of the pooling.
    const encoded = texts.map((text) => tokenizer.encode(text).ids.slice(0, maxLength));
    const length = Math.max(...encoded.map((row) => row.length));
    const ids = new BigInt64Array(texts.length * length);
    const mask = new BigInt64Array(texts.length * length);
    encoded.forEach((row, i) => {
      row.forEach((id, j) => {
        ids[i * length + j] = BigInt(id);
        mask[i * length + j] = 1n;
      });
    });
    const dims = [texts.length, length];
    const inputs: Record<string, import("onnxruntime-node").Tensor> = {
      input_ids: new ort.Tensor("int64", ids, dims),
      attention_mask: new ort.Tensor("int64", mask, dims),
      token_type_ids: new ort.Tensor("int64", new BigInt64Array(texts.length * length), dims),
    };
    // Models that take fewer inputs (no token_type_ids) are fed only theirs.
    const feeds = Object.fromEntries(
      session.inputNames.flatMap((name) => (inputs[name] ? [[name, inputs[name]]] : [])),
    );
    const outputs = await session.run(feeds);
    const hidden = (outputs.last_hidden_state ?? outputs.token_embeddings ?? outputs.logits)?.data as Float32Array;
    const dim = hidden.length / (texts.length * length);
    return encoded.map((row, i) => meanPooled(hidden, i * length * dim, row.length, dim));
  };
}

export class LocalEmbedder implements Embedder {
  /**
   * Cache the *promise* (not the resolved result) so concurrent calls share
   * the same initialisation work and never download the model twice. Keyed
   * by model name so switching models gets a fresh pipeline.
   */
  private pipelinePromise?: Promise<LocalPipeline>;
  private pipelineModelName?: string;

  /** The runtime this embedder embeds with: set once a model has loaded, `undefined` before. */
  runtime?: typeof LOCAL_EMBEDDING_RUNTIME;

  constructor(private readonly defaultModel?: string) {}

  /** Reset the cached pipeline (used by tests and by `resetLocalEmbedder()`). */
  reset(): void {
    this.pipelinePromise = undefined;
    this.pipelineModelName = undefined;
    this.runtime = undefined;
  }

  async embed(text: string, signal?: AbortSignal): Promise<EmbeddingVector> {
    if (signal?.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error("embedding interrupted");
    }
    return this.embedWithModel(text, this.defaultModel);
  }

  /**
   * Embed a batch of texts. Processes in chunks of `LOCAL_BATCH_SIZE` (32) so
   * the model can run genuine batched inference rather than one call per text.
   * Each chunk is checked against the AbortSignal between calls.
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
      const chunkEmbeddings = (await pipeline(chunk)).map((vector) => Array.from(vector));
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
    const [vector] = await pipeline([text]);
    return Array.from(vector as Float32Array);
  }

  /**
   * Eagerly load (or return the cached) model. Used by availability checks
   * that want to surface model-download and runtime failures without
   * performing a real embed call.
   */
  async getPipeline(modelName?: string): Promise<LocalPipeline> {
    const resolvedModel = resolveLocalModelName(modelName);
    if (this.pipelinePromise && this.pipelineModelName !== resolvedModel) {
      this.pipelinePromise = undefined;
      this.pipelineModelName = undefined;
    }
    if (!this.pipelinePromise) {
      this.pipelineModelName = resolvedModel;
      this.pipelinePromise = pipelineLoader(resolvedModel).then((pipeline) => {
        this.runtime = LOCAL_EMBEDDING_RUNTIME;
        return pipeline;
      });
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
