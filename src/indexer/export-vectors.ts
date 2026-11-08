// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** `akm index --export-vectors <file>`: write the current model's vectors to a vector file. */

import fs from "node:fs";
import type { AkmConfig } from "../core/config/config";
import { warn } from "../core/warn";
import { effectiveEmbedding } from "../llm/embedders/connection";
import { closeDatabase, openReadonlyExistingDatabase } from "../storage/repositories/index-connection";
import { listEmbeddedSearchTexts } from "../storage/repositories/index-vec-repository";
import { deriveSemanticProviderFingerprint, embeddingInputBuilder } from "./materialize-embeddings";
import { vectorTextHash, writeVectorFile } from "./vector-file";

/**
 * Reads the index in one read transaction — no embedder, no source walk, no
 * rebuild — and writes the vectors stamped with the configured model. The file
 * is written beside `file` and renamed into place, so a failed export leaves an
 * earlier file intact. An absent index exports an empty file.
 */
export function exportVectors(config: AkmConfig, file: string): { file: string; vectors: number; model: string } {
  const model = deriveSemanticProviderFingerprint(effectiveEmbedding(config));
  const buildInput = embeddingInputBuilder(config);
  const rows: Array<{ textHash: string; embedding: Uint8Array }> = [];
  const db = openReadonlyExistingDatabase();
  if (db) {
    try {
      db.transaction(() => {
        for (const { searchText, embedding } of listEmbeddedSearchTexts(db, model)) {
          const input = buildInput(searchText);
          if (input) rows.push({ textHash: vectorTextHash(input.text), embedding });
        }
      })();
    } finally {
      closeDatabase(db);
    }
  }
  const temp = `${file}.${process.pid}.tmp`;
  try {
    writeVectorFile(temp, model, rows);
    fs.renameSync(temp, file);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
  if (rows.length === 0)
    warn(`--export-vectors: no vectors for the current embedding model (${model}); wrote an empty file.`);
  return { file, vectors: rows.length, model };
}
