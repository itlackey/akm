// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Repository for the state.db `body_embeddings` table (WS-3a) — the cache of
 * per-content-hash body embedding vectors, with the Float32-BLOB codec helpers.
 * Extracted verbatim from core/state-db.ts — queries and the pure blob codec
 * unchanged, only relocated behind the repository boundary. Re-exported by
 * core/state-db.ts so existing importers resolve.
 *
 * @module embeddings-repository
 */

import type { Database } from "../database";

/**
 * Raw SQLite row shape for the `body_embeddings` table.
 * `embedding` is stored as a BLOB (raw Float32 bytes); callers convert to/from
 * `number[]` via `embeddingToBlob` / `blobToEmbedding`.
 */
export interface BodyEmbeddingRow {
  content_hash: string;
  embedding: Uint8Array; // raw Float32 bytes from SQLite BLOB
  model_id: string;
  created_at: number;
}

/**
 * Convert a `number[]` embedding vector to the `Float32Array` byte
 * representation stored in the `body_embeddings.embedding` BLOB column.
 */
export function embeddingToBlob(vec: number[]): Uint8Array {
  const f32 = new Float32Array(vec);
  return new Uint8Array(f32.buffer);
}

/**
 * Convert the raw `Uint8Array` bytes from the `body_embeddings.embedding`
 * BLOB column back to a `number[]` embedding vector.
 */
export function blobToEmbedding(blob: Uint8Array): number[] {
  // SQLite BLOB columns are returned as Uint8Array; re-interpret as Float32.
  const f32 = new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
  return Array.from(f32);
}

/**
 * Bulk-fetch cached body embeddings for a set of content hashes.
 * Returns a Map keyed by `content_hash` (embedding decoded to `number[]`).
 * Empty input → empty map (no query issued).
 *
 * If the stored `model_id` does not match `expectedModelId` the entire table
 * is cleared (drop-all on model mismatch) and an empty map is returned so
 * callers re-embed everything on this run.
 */
export function getBodyEmbeddings(
  db: Database,
  contentHashes: readonly string[],
  expectedModelId: string,
): Map<string, number[]> {
  const out = new Map<string, number[]>();
  if (contentHashes.length === 0) return out;

  // Model-id mismatch: vectors are in the wrong metric space — drop all rows.
  const firstRow = db.prepare("SELECT model_id FROM body_embeddings LIMIT 1").get() as { model_id: string } | undefined;
  if (firstRow && firstRow.model_id !== expectedModelId) {
    db.exec("DELETE FROM body_embeddings");
    return out;
  }

  // SQLite has a ~999 param ceiling; chunk if needed.
  const CHUNK = 500;
  for (let i = 0; i < contentHashes.length; i += CHUNK) {
    const chunk = contentHashes.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = db
      .prepare(`SELECT content_hash, embedding FROM body_embeddings WHERE content_hash IN (${placeholders})`)
      .all(...chunk) as Array<{ content_hash: string; embedding: Uint8Array }>;
    for (const row of rows) {
      out.set(row.content_hash, blobToEmbedding(row.embedding));
    }
  }
  return out;
}

/**
 * Upsert body-embedding rows in a single transaction.
 * Each entry maps a `cacheHash` → `number[]` vector. `model_id` is stored
 * so a future model change can trigger a drop-all purge.
 */
export function upsertBodyEmbeddings(
  db: Database,
  entries: Array<{ contentHash: string; embedding: number[]; modelId: string }>,
): void {
  if (entries.length === 0) return;
  const now = Date.now();
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO body_embeddings (content_hash, embedding, model_id, created_at)
    VALUES (?, ?, ?, ?)
  `);
  db.transaction(() => {
    for (const { contentHash, embedding, modelId } of entries) {
      stmt.run(contentHash, embeddingToBlob(embedding), modelId, now);
    }
  })();
}
