// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Semantic-search asset preparation for the setup wizard. Isolates the one
 * `bun add @huggingface/transformers` subprocess and the sqlite-vec probe so
 * the rest of setup stays free of subprocess/DB I/O.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as p from "../cli/clack";
import { isHttpUrl } from "../core/common";
import type { AkmConfig, EmbeddingConnectionConfig } from "../core/config/config";
import { checkEmbeddingAvailability, DEFAULT_LOCAL_MODEL, isTransformersAvailable } from "../llm/embedder";
import { getDirname, spawn } from "../runtime";
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

  // For local embeddings, ensure the required package is installed first.
  if (!remote) {
    if (!isTransformersAvailable()) {
      const spin = p.spinner();
      spin.start("Installing @huggingface/transformers...");
      try {
        const pkgRoot = path.resolve(getDirname(import.meta.url), "../..");
        const proc = spawn(["bun", "add", "@huggingface/transformers"], {
          cwd: pkgRoot,
          stdout: "pipe",
          stderr: "pipe",
        });
        await proc.exited;
        if (proc.exitCode !== 0) {
          const stderr = await new Response(proc.stderr).text();
          throw new Error(stderr || `exit code ${proc.exitCode}`);
        }
        spin.stop("@huggingface/transformers installed.");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        spin.stop("Could not install @huggingface/transformers.");
        p.log.warn(
          `Automatic install failed: ${msg}\n` +
            "Install it manually with: bun add @huggingface/transformers\n" +
            "Then re-run `akm setup` or `akm index --full --verbose`.",
        );
        return { ok: false, reason: "missing-package", message: `Automatic install failed: ${msg}` };
      }
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
        "@huggingface/transformers is not installed. Install it with: bun add @huggingface/transformers\n" +
          "Then re-run `akm setup` or `akm index --full --verbose`.",
      );
      return { ok: false, reason: "missing-package", message: "@huggingface/transformers is not installed." };
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
        "sqlite-vec is not available. Semantic search will use the JS fallback until the optional extension is installed.",
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    p.log.warn(
      `Could not open the local database or check for sqlite-vec. Semantic search will use the JS fallback. (${message})\n` +
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
