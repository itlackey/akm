// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `index.db` vector repository: the `embeddings` table and the exact
 * nearest-neighbour scan over it.
 *
 * Each vector is one float32 BLOB row. Search reads the current model's rows
 * and scores them in JavaScript, which works on every runtime akm ships on.
 * The sqlite-vec mirror (`entries_vec`) it replaced could not load in the
 * standalone binaries, under Bun on macOS, or without the optional package,
 * and needed its own repair machinery to stay in step with this table.
 */

import type { IndexDocument } from "../../indexer/passes/metadata";
import { buildSearchText } from "../../indexer/search/search-fields";
import type { EmbeddingVector } from "../../llm/embedders/types";
import { sha256Hex } from "../../runtime";
import type { Database } from "../database";
import type { DbVecResult } from "./index-entry-types";
import { getMeta, setMeta } from "./index-meta-repository";
import { SQLITE_CHUNK_SIZE } from "./index-sql";

/**
 * The embedding model whose vectors this index currently serves: the provider
 * fingerprint the last embedding pass targeted (`index_meta.embeddingFingerprint`).
 * `undefined` on an index that has never run an embedding pass.
 */
function currentEmbeddingModel(db: Database): string | undefined {
  return getMeta(db, "embeddingFingerprint");
}

const modelColumnPresent = new WeakMap<Database, boolean>();

/**
 * Whether `embeddings` carries the per-row `model` column. A read-only open of
 * an index the writable opener has not migrated yet does not; its rows are
 * then all served as the current model. Only a positive answer is memoized:
 * the column can appear on a live connection (`ensureSchema`), never vanish.
 */
function hasModelColumn(db: Database): boolean {
  if (modelColumnPresent.get(db) === true) return true;
  let present = false;
  try {
    present = (db.prepare("PRAGMA table_info(embeddings)").all() as Array<{ name: string }>).some(
      (column) => column.name === "model",
    );
  } catch {
    present = false;
  }
  if (present) modelColumnPresent.set(db, true);
  return present;
}

/**
 * SQL predicate selecting `embeddings` rows usable for `model`. A NULL model
 * predates per-row model tracking and is trusted as the current model; when
 * no model is known at all, or the index predates the column, every row
 * qualifies.
 */
function modelPredicate(
  db: Database,
  model: string | undefined,
  alias = "embeddings",
): { sql: string; params: string[] } {
  if (model === undefined || !hasModelColumn(db)) return { sql: "1", params: [] };
  return { sql: `(${alias}.model IS NULL OR ${alias}.model = ?)`, params: [model] };
}

/** Remove the vector of an entry whose embedding input changed. */
export function deleteEntryVectors(db: Database, id: number): void {
  db.prepare("DELETE FROM embeddings WHERE id = ?").run(id);
}

/**
 * Purge every stored vector and mark the index as embedding-free. Only the
 * explicit `akm index --reembed` override calls this: a model or dimension
 * change keeps every stored row (each carries its own model) and re-embeds
 * incrementally.
 */
export function purgeEmbeddings(db: Database): void {
  db.exec("DELETE FROM embeddings");
  setMeta(db, "hasEmbeddings", "0");
}

/**
 * Store one entry's vector. `model` is the provider fingerprint it was
 * generated under (`deriveSemanticProviderFingerprint`); a row written without
 * one is trusted as the current model. Returns false, writing nothing, when
 * the entry no longer exists.
 */
export function upsertEmbedding(db: Database, entryId: number, embedding: EmbeddingVector, model?: string): boolean {
  // Pre-flight FK guard: when an entry is deleted between when its id is queued
  // for embedding and when this INSERT runs (e.g. consolidation deletes during
  // a concurrent improve cycle), the INSERT throws "FOREIGN KEY constraint failed"
  // and rolls back the entire batch transaction in the caller, losing every
  // embedding for that run. A cheap SELECT here turns the race into a clean skip.
  if (!db.prepare("SELECT 1 FROM entries WHERE id = ?").get(entryId)) return false;
  db.prepare("INSERT OR REPLACE INTO embeddings (id, embedding, model) VALUES (?, ?, ?)").run(
    entryId,
    Buffer.from(new Float32Array(embedding).buffer),
    model ?? null,
  );
  return true;
}

/** Confines a vector scan to the entries of one type in one bundle. */
export interface VecScope {
  type: string;
  bundleId: string;
}

/**
 * The `k` stored vectors nearest to `query` by cosine similarity, best first
 * (ties by id): an exact scan of the current model's rows. `distance` is
 * `sqrt(2 * (1 - cosine))`, the L2 distance between the unit-normalised
 * vectors. Rows of another width, left by a model that is no longer current,
 * never match. With a `scope`, only that bundle's entries of that type are
 * scanned: the `k` nearest of those, not the `k` nearest of everything filtered
 * afterwards.
 */
export function searchVec(db: Database, query: ArrayLike<number>, k: number, scope?: VecScope): DbVecResult[] {
  const dim = query.length;
  const q = Float64Array.from(query);
  let queryNorm = 0;
  for (let i = 0; i < dim; i++) queryNorm += q[i]! * q[i]!;
  if (k <= 0 || queryNorm === 0) return [];
  queryNorm = Math.sqrt(queryNorm);

  const current = modelPredicate(db, currentEmbeddingModel(db));
  const scoped = scope ? " AND embeddings.id IN (SELECT id FROM entries WHERE type = ? AND bundle_id = ?)" : "";
  const params = scope ? [...current.params, scope.type, scope.bundleId] : current.params;
  const ids: number[] = [];
  const similarities: number[] = [];
  const rows = db
    .prepare(`SELECT id, embedding FROM embeddings WHERE ${current.sql}${scoped}`)
    .iterate(...params) as IterableIterator<{ id: number; embedding: Uint8Array }>;
  for (const { id, embedding } of rows) {
    if (embedding.byteLength !== dim * 4) continue;
    // A Float32Array view needs 4-byte alignment; copy the rare row that lacks it.
    const vector =
      embedding.byteOffset % 4 === 0
        ? new Float32Array(embedding.buffer, embedding.byteOffset, dim)
        : new Float32Array(embedding.slice().buffer);
    let dot = 0;
    let norm = 0;
    for (let i = 0; i < dim; i++) {
      const x = vector[i]!;
      dot += x * q[i]!;
      norm += x * x;
    }
    if (norm === 0) continue;
    ids.push(id);
    similarities.push(dot / (Math.sqrt(norm) * queryNorm));
  }

  const order = ids.map((_, index) => index);
  order.sort((a, b) => similarities[b]! - similarities[a]! || ids[a]! - ids[b]!);
  return order.slice(0, k).map((index) => ({
    id: ids[index]!,
    distance: Math.sqrt(2 * Math.max(0, 1 - similarities[index]!)),
  }));
}

/**
 * The k nearest neighbours of an already-indexed entry, by its stored vector —
 * no re-embedding, no network. Returns [] when the entry has no stored
 * vector. Unscoped, the entry itself is typically returned with distance ~0;
 * callers filter it out by id. A `scope` confines the neighbours to one
 * bundle's entries of one type (see {@link searchVec}).
 */
export function getNeighborsByEntryId(db: Database, id: number, k: number, scope?: VecScope): DbVecResult[] {
  const row = db.prepare("SELECT embedding FROM embeddings WHERE id = ?").get(id) as
    | { embedding: Uint8Array }
    | undefined;
  if (!row || row.embedding.byteLength % 4 !== 0) return [];
  return searchVec(db, new Float32Array(row.embedding.slice().buffer), k, scope);
}

/** One entry the embedding pass has to (re)embed, with the text its vector is embedded from. */
export interface EntryForEmbedding {
  id: number;
  searchText: string;
  embedHash: string;
  itemRef: string;
  filePath: string;
}

/**
 * Every entry that has no embedding row for `model` (any row when no model is
 * given), or whose stored embedding-input hash is stale. Its input is derived
 * from the stored document (`buildSearchText`, whose hash `upsertEntry` keeps
 * in `entries.embed_hash`). This is the embedding pass's cursor: a row
 * generated under another model counts as missing and is replaced when the
 * entry is re-embedded, so a model change re-embeds incrementally and an
 * interrupted pass resumes where it stopped. A row whose `document_json` does
 * not parse has no text to embed and is left out.
 */
export function getAllEntriesForEmbedding(
  db: Database,
  entryIds?: readonly number[],
  model?: string,
): EntryForEmbedding[] {
  const select =
    "SELECT e.id, e.document_json AS documentJson, e.embed_hash AS embedHash, e.item_ref AS itemRef, e.file_path AS filePath";
  const current = modelPredicate(db, model, "b");
  const hasEmbedding = `EXISTS (SELECT 1 FROM embeddings b WHERE b.id = e.id AND ${current.sql})`;
  type Row = {
    id: number;
    documentJson: string;
    embedHash: string | null;
    itemRef: string;
    filePath: string;
    hasEmbedding: number;
  };
  const rows: Row[] = [];
  if (entryIds === undefined) {
    rows.push(
      ...(db
        .prepare(`${select}, ${hasEmbedding} AS hasEmbedding FROM entries e ORDER BY e.id`)
        .all(...current.params) as Row[]),
    );
  } else {
    const targets = [...new Set(entryIds)].sort((left, right) => left - right);
    for (let offset = 0; offset < targets.length; offset += SQLITE_CHUNK_SIZE) {
      const chunk = targets.slice(offset, offset + SQLITE_CHUNK_SIZE);
      const placeholders = chunk.map(() => "?").join(",");
      rows.push(
        ...(db
          .prepare(
            `${select}, ${hasEmbedding} AS hasEmbedding FROM entries e WHERE e.id IN (${placeholders}) ORDER BY e.id`,
          )
          .all(...chunk, ...current.params) as Row[]),
      );
    }
  }
  const entries: EntryForEmbedding[] = [];
  for (const { documentJson, embedHash: storedEmbedHash, hasEmbedding, ...row } of rows) {
    let document: IndexDocument;
    try {
      document = JSON.parse(documentJson) as IndexDocument;
    } catch {
      continue;
    }
    const searchText = buildSearchText(document);
    const embedHash = sha256Hex(searchText);
    if (!hasEmbedding || storedEmbedHash !== embedHash) entries.push({ ...row, searchText, embedHash });
  }
  return entries;
}

/** Stored embedding rows — for `model` when given, otherwise every row. */
export function getEmbeddingCount(db: Database, model?: string): number {
  const current = modelPredicate(db, model);
  const row = db.prepare(`SELECT COUNT(*) AS cnt FROM embeddings WHERE ${current.sql}`).get(...current.params) as {
    cnt: number;
  };
  return row.cnt;
}
