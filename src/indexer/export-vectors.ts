// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** `akm index --export-vectors <file>`: write the current model's vectors to a vector file. */

import fs from "node:fs";
import path from "node:path";
import type { AkmConfig } from "../core/config/config";
import { UsageError } from "../core/errors";
import { getLogsDbPath } from "../core/logs-db";
import { getMetricsDbPath } from "../core/metrics-db";
import { getDbPath, getStateDbPathInDataDir } from "../core/paths";
import { warn } from "../core/warn";
import { effectiveEmbedding } from "../llm/embedders/connection";
import { closeDatabase, openReadonlyExistingDatabase } from "../storage/repositories/index-connection";
import { listEmbeddedSearchTexts } from "../storage/repositories/index-vec-repository";
import { deriveSemanticProviderFingerprint, embeddingInputBuilder } from "./materialize-embeddings";
import { vectorTextHash, writeVectorFile } from "./vector-file";

/** The file's real location: symlinks in its directory and in the file itself resolved where they exist. */
function realLocation(file: string): string {
  const resolved = path.resolve(file);
  try {
    return fs.realpathSync(resolved);
  } catch {
    try {
      return path.join(fs.realpathSync(path.dirname(resolved)), path.basename(resolved));
    } catch {
      return resolved;
    }
  }
}

/** Refuse to write over akm's own databases (index.db, state.db, logs.db, metrics.db and their sidecars). */
function assertNotAkmDatabase(file: string): void {
  const target = realLocation(file);
  const protectedPaths = [getDbPath(), getStateDbPathInDataDir(), getLogsDbPath(), getMetricsDbPath()].flatMap((p) => [
    p,
    `${p}-wal`,
    `${p}-shm`,
  ]);
  if (protectedPaths.some((p) => realLocation(p) === target)) {
    throw new UsageError(`--export-vectors cannot write to ${file}: it is one of akm's own databases.`);
  }
}

/**
 * Reads the index — no embedder, no source walk, no
 * rebuild — and writes the vectors stamped with the configured model. The file
 * is written beside `file` and renamed into place, so a failed export leaves an
 * earlier file intact. An absent index exports an empty file.
 */
export function exportVectors(config: AkmConfig, file: string): { file: string; vectors: number; model: string } {
  assertNotAkmDatabase(file);
  const model = deriveSemanticProviderFingerprint(effectiveEmbedding(config));
  const buildInput = embeddingInputBuilder(config);
  let vectors = 0;
  const db = openReadonlyExistingDatabase();
  function* rows(): Generator<{ textHash: string; embedding: Uint8Array }> {
    if (!db) return;
    for (const { searchText, embedding } of listEmbeddedSearchTexts(db, model)) {
      const input = buildInput(searchText);
      if (!input) continue;
      vectors++;
      yield { textHash: vectorTextHash(input.text), embedding };
    }
  }
  const temp = `${file}.${process.pid}.tmp`;
  try {
    fs.rmSync(temp, { force: true });
    writeVectorFile(temp, model, rows());
    fs.renameSync(temp, file);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  } finally {
    if (db) closeDatabase(db);
  }
  if (vectors === 0)
    warn(`--export-vectors: no vectors for the current embedding model (${model}); wrote an empty file.`);
  return { file, vectors, model };
}
