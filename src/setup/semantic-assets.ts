// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Semantic-search asset preparation for the setup wizard. The embedding
 * runtime (onnxruntime-node) is a normal package dependency; setup never
 * mutates the installed CLI. This module only prepares the model.
 */

import * as p from "../cli/clack";
import { isHttpUrl } from "../core/common";
import type { AkmConfig, EmbeddingConnectionConfig } from "../core/config/config";
import { checkEmbeddingAvailability, DEFAULT_LOCAL_MODEL } from "../llm/embedder";
import { effectiveEmbedding } from "../llm/embedders/connection";

// Approximate first-download size of the default local model (DEFAULT_LOCAL_MODEL), used in the setup note.
const LOCAL_MODEL_APPROX_SIZE_MB = 127;

export function isRemoteEmbeddingConfig(embedding?: EmbeddingConnectionConfig): boolean {
  return isHttpUrl(embedding?.endpoint);
}

/**
 * @internal Exported for testing only.
 */
export function describeSemanticSearchAssets(embedding?: EmbeddingConnectionConfig): string[] {
  if (isRemoteEmbeddingConfig(embedding)) {
    return [`• Embedding endpoint: ${embedding?.provider ?? "custom"} / ${embedding?.model} (no local model download)`];
  }

  return [
    `• Local embedding model: ${embedding?.localModel ?? DEFAULT_LOCAL_MODEL} (~${LOCAL_MODEL_APPROX_SIZE_MB} MB download on first use)`,
  ];
}

export async function prepareSemanticSearchAssets(
  config: AkmConfig,
): Promise<{ ok: true } | { ok: false; message: string; reason: string }> {
  const embedding = effectiveEmbedding(config);
  const remote = isRemoteEmbeddingConfig(embedding);

  const spin = p.spinner();
  spin.start(
    remote
      ? "Checking remote embedding endpoint..."
      : `Downloading local embedding model (${embedding?.localModel ?? DEFAULT_LOCAL_MODEL})...`,
  );

  const result = await checkEmbeddingAvailability(embedding);
  if (!result.available) {
    spin.stop("Semantic-search assets could not be prepared.");
    if (result.reason === "remote-unreachable") {
      p.log.warn(
        "The remote embedding endpoint is not reachable. Check your endpoint and credentials, then retry `akm index --full --verbose`.",
      );
      return { ok: false, reason: "remote-network", message: "The remote embedding endpoint is not reachable." };
    } else if (result.reason === "runtime-unavailable") {
      p.log.warn(`${result.message}\nSet \`embedding.endpoint\` to use a remote embedding service instead.`);
      return { ok: false, reason: "runtime-unavailable", message: result.message };
    } else {
      p.log.warn(
        `The local embedding model could not be downloaded: ${result.message}\n` +
          "Retry `akm index --full --verbose` after confirming local model downloads are permitted.",
      );
      return { ok: false, reason: "local-model-download", message: result.message };
    }
  }

  spin.stop(remote ? "Remote embedding endpoint is ready." : "Local embedding model downloaded and ready.");

  return { ok: true };
}
