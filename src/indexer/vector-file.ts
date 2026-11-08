// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The vector file behind `akm index --export-vectors` / `--import-vectors`: a
 * standalone SQLite file with one table, `vectors(model, text_hash, embedding)`.
 * `model` is the embedding provider fingerprint, `text_hash` the SHA-256 hex of
 * the exact text sent to the embedder, `embedding` the Float32 bytes the
 * `embeddings` table holds. It carries no document text and no paths, and a
 * vector is used only when both the model and the text hash match, so anything
 * else is a plain miss.
 */

import { sha256Hex } from "../runtime";
import type { Database } from "../storage/database";
import { openDatabase } from "../storage/database";

export function vectorTextHash(embeddingInput: string): string {
  return sha256Hex(embeddingInput);
}

/** Create a vector file at `file` holding `rows`, all stamped with `model`. */
export function writeVectorFile(
  file: string,
  model: string,
  rows: Iterable<{ textHash: string; embedding: Uint8Array }>,
): void {
  const db = openDatabase(file, { create: true });
  try {
    db.exec(
      "CREATE TABLE vectors (model TEXT NOT NULL, text_hash TEXT NOT NULL, embedding BLOB NOT NULL, PRIMARY KEY (model, text_hash))",
    );
    const insert = db.prepare("INSERT OR REPLACE INTO vectors (model, text_hash, embedding) VALUES (?, ?, ?)");
    db.transaction(() => {
      for (const row of rows) insert.run(model, row.textHash, row.embedding);
    })();
  } finally {
    db.close();
  }
}

export interface VectorLookup {
  /** The stored vector for this text hash, or undefined on a miss. */
  get(textHash: string): number[] | undefined;
  close(): void;
}

/**
 * Open a vector file for lookups under `model`. Returns `undefined` after a
 * single warning when the file cannot be used: missing, unreadable, not a
 * vector file, or holding nothing for this model.
 */
export function openVectorLookup(
  file: string,
  model: string,
  warn: (message: string) => void,
): VectorLookup | undefined {
  let db: Database | undefined;
  try {
    db = openDatabase(file, { readonly: true, create: false });
    const widths = db
      .prepare(
        "SELECT length(embedding) AS bytes, COUNT(*) AS n FROM vectors WHERE model = ? AND length(embedding) % 4 = 0 AND length(embedding) > 0 GROUP BY bytes ORDER BY n DESC LIMIT 1",
      )
      .all(model) as Array<{ bytes: number }>;
    const width = widths[0]?.bytes;
    if (width === undefined) {
      db.close();
      warn(
        `--import-vectors: ${file} has no vectors for the current embedding model (${model}); embedding every entry as usual.`,
      );
      return undefined;
    }
    const select = db.prepare("SELECT embedding FROM vectors WHERE model = ? AND text_hash = ?");
    const open = db;
    return {
      get(textHash) {
        const row = select.get(model, textHash) as { embedding: Uint8Array } | undefined | null;
        // A row of another width than the file's others is a miss.
        if (!row || row.embedding.byteLength !== width) return undefined;
        // Copy into an aligned array: a Node Buffer's slice() is a view into a shared pool.
        const vector = new Float32Array(width / 4);
        new Uint8Array(vector.buffer).set(row.embedding);
        return Array.from(vector);
      },
      close: () => open.close(),
    };
  } catch (error) {
    try {
      db?.close();
    } catch {
      // The file was never usable; the warning below is the outcome.
    }
    warn(
      `--import-vectors: could not read ${file} as a vector file (${error instanceof Error ? error.message : String(error)}); embedding every entry as usual.`,
    );
    return undefined;
  }
}
