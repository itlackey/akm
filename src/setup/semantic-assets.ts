// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Semantic-search asset preparation for the setup wizard. Transformers.js is
 * a normal external package dependency; setup never mutates the installed CLI.
 * This module only prepares the model and probes sqlite-vec.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as p from "../cli/clack";
import { isHttpUrl } from "../core/common";
import type { AkmConfig, EmbeddingConnectionConfig } from "../core/config/config";
import { checkEmbeddingAvailability, DEFAULT_LOCAL_MODEL, isTransformersAvailable } from "../llm/embedder";
import { closeDatabase, openIndexDatabase } from "../storage/repositories/index-connection";
import { isVecAvailable } from "../storage/repositories/index-vec-repository";

// Approximate first-download sizes used in the setup note.
// LOCAL_MODEL_APPROX_SIZE_MB tracks the default local model (DEFAULT_LOCAL_MODEL).
const LOCAL_MODEL_APPROX_SIZE_MB = 130;
// SQLITE_VEC_APPROX_SIZE_MB reflects the optional sqlite-vec install footprint.
const SQLITE_VEC_APPROX_SIZE_MB = 5;

export function isRemoteEmbeddingConfig(embedding?: EmbeddingConnectionConfig): boolean {
  return isHttpUrl(embedding?.endpoint);
}

/**
 * @internal Exported for testing only.
 */
export function describeSemanticSearchAssets(embedding?: EmbeddingConnectionConfig): string[] {
  if (isRemoteEmbeddingConfig(embedding)) {
    return [
      `• Embedding endpoint: ${embedding?.provider ?? "custom"} / ${embedding?.model} (no local model download)`,
      `• sqlite-vec acceleration: optional native extension (~${SQLITE_VEC_APPROX_SIZE_MB} MB when installed separately)`,
    ];
  }

  return [
    `• Local embedding model: ${embedding?.localModel ?? DEFAULT_LOCAL_MODEL} (~${LOCAL_MODEL_APPROX_SIZE_MB} MB download on first use)`,
    `• sqlite-vec acceleration: optional native extension (~${SQLITE_VEC_APPROX_SIZE_MB} MB when installed separately)`,
  ];
}

export async function prepareSemanticSearchAssets(
  config: AkmConfig,
): Promise<{ ok: true } | { ok: false; message: string; reason: string }> {
  const remote = isRemoteEmbeddingConfig(config.embedding);

  // Local embeddings require the declared Transformers dependency.
  if (!remote) {
    if (!isTransformersAvailable()) {
      const message =
        "The @huggingface/transformers dependency is unavailable. Reinstall akm-cli, then re-run `akm setup` or `akm index --full --verbose`.";
      p.log.warn(message);
      return { ok: false, reason: "missing-package", message };
    }
  }

  const spin = p.spinner();
  spin.start(
    remote
      ? "Checking remote embedding endpoint..."
      : `Downloading local embedding model (${config.embedding?.localModel ?? DEFAULT_LOCAL_MODEL})...`,
  );

  const result = await checkEmbeddingAvailability(config.embedding);
  if (!result.available) {
    spin.stop("Semantic-search assets could not be prepared.");
    if (result.reason === "remote-unreachable") {
      p.log.warn(
        "The remote embedding endpoint is not reachable. Check your endpoint and credentials, then retry `akm index --full --verbose`.",
      );
      return { ok: false, reason: "remote-network", message: "The remote embedding endpoint is not reachable." };
    } else if (result.reason === "missing-package") {
      p.log.warn(
        "The @huggingface/transformers dependency is unavailable. Reinstall akm-cli, then re-run `akm setup` or `akm index --full --verbose`.",
      );
      return { ok: false, reason: "missing-package", message: "The local embedding runtime is unavailable." };
    } else {
      p.log.warn(
        `The local embedding model could not be downloaded: ${result.message}\n` +
          "Retry `akm index --full --verbose` after confirming local model downloads are permitted.",
      );
      return { ok: false, reason: "local-model-download", message: result.message };
    }
  }

  spin.stop(remote ? "Remote embedding endpoint is ready." : "Local embedding model downloaded and ready.");

  let db: ReturnType<typeof openIndexDatabase> | undefined;
  let probeDir: string | undefined;
  try {
    probeDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-setup-vec-probe-"));
    db = openIndexDatabase(
      path.join(probeDir, "probe.db"),
      config.embedding?.dimension ? { embeddingDim: config.embedding.dimension } : undefined,
    );
    if (isVecAvailable(db)) {
      p.log.info("sqlite-vec is available for fast vector search.");
    } else {
      p.log.info(
        "sqlite-vec is not available. Semantic search will stay unavailable (keyword search still works) until the optional extension is installed.",
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    p.log.warn(
      `Could not open the local database or check for sqlite-vec. Semantic search will stay unavailable. (${message})\n` +
        "Check file permissions and available disk space in the cache directory, or run `akm index --full --verbose` to diagnose.",
    );
  } finally {
    if (db) closeDatabase(db);
    if (probeDir) {
      try {
        fs.rmSync(probeDir, { recursive: true, force: true });
      } catch {
        /* ignore cleanup failure */
      }
    }
  }

  return { ok: true };
}
