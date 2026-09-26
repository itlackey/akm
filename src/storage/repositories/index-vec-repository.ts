// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `index.db` vector + embedding repository.
 *
 * Owns the sqlite-vec extension load/availability probe, the BLOB `embeddings`
 * table, the `entries_vec` virtual table, and the JS-cosine fallback path.
 */

import { createRequire } from "node:module";
import { bestEffort } from "../../core/best-effort";
import { warn } from "../../core/warn";
import { cosineSimilarity, type EmbeddingVector } from "../../llm/embedders/types";
import type { Database } from "../database";
import type { DbVecResult } from "./index-entry-types";
import { getMeta, setMeta } from "./index-meta-repository";
import { SQLITE_CHUNK_SIZE } from "./index-sql";

// ── sqlite-vec extension ────────────────────────────────────────────────────

const vecStatus = new WeakMap<Database, boolean>();

/**
 * Attempt to load the sqlite-vec extension into `db`, recording availability.
 * Exported so the connection lifecycle can arm it at open time.
 */
export function loadVecExtension(db: Database): void {
  try {
    const esmRequire = createRequire(import.meta.url);
    const sqliteVec = esmRequire("sqlite-vec");
    // `db` is the storage boundary's handle. On Bun that IS the bun:sqlite
    // handle; on Node it is a wrapper, which must forward `loadExtension` for
    // this call to work at all (see openNodeDatabase in storage/database.ts —
    // it did not, so vec could never load on the entire npm distribution).
    sqliteVec.load(db);
    vecStatus.set(db, true);
  } catch {
    vecStatus.set(db, false);
  }
}

export function isVecAvailable(db: Database): boolean {
  return vecStatus.get(db) ?? false;
}

/**
 * Meta key persisting whether the sqlite-vec fast-path table (`entries_vec`) is
 * fully populated and trustworthy for this index. Set to "0" by the embedding
 * phase when one or more vec inserts FAILED (e.g. a vec0 dimension mismatch)
 * while their BLOB rows still wrote — so semantic search reads the complete
 * BLOB table via the JS-cosine fallback instead of a partial/mismatched vec
 * table. Absent (legacy indexes) and "1" both mean the fast path is trusted.
 */
const VEC_FAST_PATH_READY_META = "vecFastPathReady";

/** Persist whether the sqlite-vec fast path is trustworthy (see the meta doc). */
export function setVecFastPathReady(db: Database, ready: boolean): void {
  setMeta(db, VEC_FAST_PATH_READY_META, ready ? "1" : "0");
}

/**
 * True unless the embedding phase recorded a vec insert failure. Reflects the
 * ACTUAL insert outcomes recorded at index time — not an inference from how many
 * BLOB rows exist — so a degraded vec table routes search to the JS fallback
 * rather than silently returning partial fast-path results.
 */
export function isVecFastPathReady(db: Database): boolean {
  if (getMeta(db, VEC_FAST_PATH_READY_META) === "0") return false;
  // The meta flag alone is not sufficient. An index built while sqlite-vec was
  // unavailable wrote only BLOB rows, and because "unavailable" outcomes were
  // not counted as failures the flag was still set to "1" against a table that
  // is empty or absent. If sqlite-vec later becomes loadable — the user installs
  // it, or the same index is opened under the other runtime — the fast path
  // would then be trusted and return zero neighbours while the BLOB table holds
  // every embedding. Indexes written by earlier versions still carry that stale
  // flag, so the read path has to verify the table really exists.
  return hasVecTable(db);
}

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

/**
 * Verify that the vec fast-path table mirrors the complete durable BLOB set
 * for the current model.
 *
 * A targeted embedding write preserves the prior readiness decision because
 * its subset cannot prove an older degraded generation is healed. Global
 * materialization uses this aggregate check before promoting the persisted
 * flag; search itself still reads the cheap flag and does not repeat the check
 * per query.
 */
export function isVecFastPathComplete(db: Database): boolean {
  if (!isVecAvailable(db) || !hasVecTable(db)) return false;
  try {
    const current = modelPredicate(db, currentEmbeddingModel(db));
    const missingVecRows = db
      .prepare(`
        SELECT id FROM embeddings WHERE ${current.sql}
        EXCEPT
        SELECT id FROM entries_vec
        LIMIT 1
      `)
      .all(...current.params);
    if (missingVecRows.length > 0) return false;

    const orphanVecRows = db
      .prepare(`
        SELECT id FROM entries_vec
        EXCEPT
        SELECT id FROM embeddings WHERE ${current.sql}
        LIMIT 1
      `)
      .all(...current.params);
    return orphanVecRows.length === 0;
  } catch {
    return false;
  }
}

export interface VecFastPathRepairResult {
  readonly available: boolean;
  readonly repaired: number;
  readonly removedOrphans: number;
  readonly rejected: number;
  readonly complete: boolean;
  readonly error?: string;
}

/**
 * Reconcile sqlite-vec's derived mirror from the durable BLOB embeddings.
 *
 * This never calls an embedding provider and never mutates the BLOB table.
 * The readiness flag is lowered before the first mutation and is promoted only
 * after a bidirectional aggregate check proves both ID sets match exactly.
 */
export function repairVecFastPath(db: Database, embeddingDim: number): VecFastPathRepairResult {
  let repaired = 0;
  let removedOrphans = 0;
  let rejected = 0;
  setVecFastPathReady(db, false);

  if (!isVecAvailable(db) || !hasVecTable(db)) {
    return { available: false, repaired, removedOrphans, rejected, complete: false };
  }

  if (!Number.isInteger(embeddingDim) || embeddingDim <= 0) {
    return {
      available: true,
      repaired,
      removedOrphans,
      rejected,
      complete: false,
      error: `Invalid embedding dimension ${embeddingDim}.`,
    };
  }

  try {
    const current = modelPredicate(db, currentEmbeddingModel(db));
    while (true) {
      const orphanIds = db
        .prepare(`
          SELECT id FROM entries_vec
          EXCEPT
          SELECT id FROM embeddings WHERE ${current.sql}
          ORDER BY id
          LIMIT ?
        `)
        .all(...current.params, SQLITE_CHUNK_SIZE) as Array<{ id: number }>;
      if (orphanIds.length === 0) break;
      db.transaction(() => {
        const remove = db.prepare("DELETE FROM entries_vec WHERE id = ?");
        for (const { id } of orphanIds) {
          remove.run(id);
          removedOrphans++;
        }
      })();
    }

    let afterId = -1;
    while (true) {
      const missingIds = db
        .prepare(`
          SELECT id FROM (
            SELECT id FROM embeddings WHERE ${current.sql}
            EXCEPT
            SELECT id FROM entries_vec
          ) AS missing
          WHERE id > ?
          ORDER BY id
          LIMIT ?
        `)
        .all(...current.params, afterId, SQLITE_CHUNK_SIZE) as Array<{ id: number }>;
      if (missingIds.length === 0) break;
      afterId = missingIds[missingIds.length - 1]!.id;
      const placeholders = missingIds.map(() => "?").join(",");
      const rows = db
        .prepare(`SELECT id, embedding FROM embeddings WHERE id IN (${placeholders}) ORDER BY id`)
        .all(...missingIds.map(({ id }) => id)) as Array<{ id: number; embedding: Uint8Array }>;

      db.transaction(() => {
        const insert = db.prepare("INSERT INTO entries_vec (id, embedding) VALUES (?, ?)");
        for (const row of rows) {
          if (row.embedding.byteLength !== embeddingDim * 4) {
            rejected++;
            continue;
          }
          try {
            insert.run(row.id, Buffer.from(row.embedding));
            repaired++;
          } catch {
            rejected++;
          }
        }
      })();
    }

    const complete = rejected === 0 && isVecFastPathComplete(db);
    setVecFastPathReady(db, complete);
    return { available: true, repaired, removedOrphans, rejected, complete };
  } catch (error) {
    setVecFastPathReady(db, false);
    return {
      available: true,
      repaired,
      removedOrphans,
      rejected,
      complete: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

const vecTablePresent = new WeakMap<Database, boolean>();

/**
 * Whether `entries_vec` exists on this connection, memoized per handle.
 *
 * openExistingDatabase loads the vec extension but deliberately does not run
 * ensureSchema, so the table is not created on read paths — its absence is a
 * normal state, not an error.
 */
function hasVecTable(db: Database): boolean {
  // Only a POSITIVE result is memoized. The table cannot vanish from a live
  // connection, but it CAN appear — ensureSchema creates it partway through an
  // index run — so caching "absent" would pin a stale answer for the rest of
  // the handle's life.
  if (vecTablePresent.get(db) === true) return true;
  let present = false;
  try {
    present =
      db.prepare("SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name = 'entries_vec'").get() !==
      undefined;
  } catch {
    present = false;
  }
  if (present) vecTablePresent.set(db, true);
  return present;
}

/** Remove both vector representations for an entry whose embedding input changed. */
export function deleteEntryVectors(db: Database, id: number): void {
  db.prepare("DELETE FROM embeddings WHERE id = ?").run(id);
  if (isVecAvailable(db)) db.prepare("DELETE FROM entries_vec WHERE id = ?").run(id);
}

/** Declared vector width of `entries_vec`, from its DDL; `undefined` when the table is absent. */
function vecTableWidth(db: Database): number | undefined {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'entries_vec'").get() as
    | { sql: string | null }
    | undefined;
  const width = row?.sql?.match(/FLOAT\[(\d+)\]/i)?.[1];
  return width === undefined ? undefined : Number(width);
}

/**
 * Make sure the sqlite-vec mirror exists at `dim`. A table declared at another
 * width is dropped and recreated (it is a mirror of the BLOB rows for the
 * current model, refilled by `repairVecFastPath`; the BLOB rows are untouched)
 * and the fast path is marked not ready until the refill completes.
 */
export function ensureVecTableWidth(db: Database, dim: number): void {
  if (!isVecAvailable(db)) return;
  const existing = vecTableWidth(db);
  if (existing === dim) return;
  if (existing !== undefined) {
    db.exec("DROP TABLE IF EXISTS entries_vec");
    setVecFastPathReady(db, false);
  }
  db.exec(`
    CREATE VIRTUAL TABLE entries_vec USING vec0(
      id       INTEGER PRIMARY KEY,
      embedding FLOAT[${dim}]
    );
  `);
}

/**
 * Empty the sqlite-vec mirror without touching the BLOB rows. Used when the
 * configured embedding model changes: the mirror serves one model at a time,
 * and the pass that follows refills it as it re-embeds each entry.
 */
export function clearVecMirror(db: Database): void {
  if (isVecAvailable(db) && hasVecTable(db)) db.exec("DELETE FROM entries_vec");
  setVecFastPathReady(db, false);
}

const VEC_DOCS_URL = "https://github.com/itlackey/akm/blob/main/docs/reference/configuration.md#sqlite-vec-extension";
const VEC_FALLBACK_THRESHOLD = 10_000;
// Per-database warning state: tracks which databases have already emitted the
// vec-missing warning so we don't spam on every openDatabase() call.
const vecInitWarnedDbs = new WeakSet<Database>();

/**
 * Warn if sqlite-vec is unavailable and embedding count exceeds threshold.
 * Called from openDatabase (once at init) and from indexer (each run).
 */
export function warnIfVecMissing(db: Database, { once }: { once: boolean } = { once: false }): void {
  if (isVecAvailable(db)) return;
  if (once && vecInitWarnedDbs.has(db)) return;

  bestEffort(() => {
    const row = db.prepare("SELECT COUNT(*) AS cnt FROM embeddings").get() as { cnt: number } | undefined;
    const count = row?.cnt ?? 0;
    if (count >= VEC_FALLBACK_THRESHOLD) {
      warn(
        "Semantic search is using JS fallback for %d entries. Install sqlite-vec for faster performance.\n  See: %s",
        count,
        VEC_DOCS_URL,
      );
      if (once) vecInitWarnedDbs.add(db);
    }
  }, "embeddings table may not exist yet during init");
}

/**
 * Purge stored embeddings (BLOB rows in `embeddings`, plus the `entries_vec`
 * virtual table) and mark the index as embedding-free. Only the explicit
 * `akm index --reembed` override calls this: a model or dimension change keeps
 * every stored row (each carries its own model) and re-embeds incrementally.
 *
 * `dropVecTable: true` DROPs `entries_vec` so the next pass recreates it at
 * the width it observes; the default clears its rows in place.
 */
export function purgeEmbeddings(db: Database, opts?: { dropVecTable?: boolean }): void {
  bestEffort(() => db.exec("DELETE FROM embeddings"), "purge embeddings");
  if (isVecAvailable(db)) {
    bestEffort(
      () => db.exec(opts?.dropVecTable ? "DROP TABLE IF EXISTS entries_vec" : "DELETE FROM entries_vec"),
      "purge entries_vec",
    );
  }
  setMeta(db, "hasEmbeddings", "0");
}

// ── Vector operations ───────────────────────────────────────────────────────

/** Outcome of the sqlite-vec fast-path write for a single embedding. */
export type VecInsertOutcome = "ok" | "unavailable" | "failed";

export interface EmbeddingUpsertResult {
  /** BLOB row written. False only on the FK pre-flight skip (entry deleted). */
  stored: boolean;
  /**
   * - `ok`          — vec fast-path row inserted.
   * - `unavailable` — sqlite-vec not loaded; the JS-cosine fallback is expected
   *                   (this is normal degradation, NOT a failure).
   * - `failed`      — the extension is loaded but the vec insert threw (vec0
   *                   dimension mismatch / missing table / constraint). The
   *                   caller counts, warns, and marks the fast path degraded.
   */
  vec: VecInsertOutcome;
}

/**
 * Store one entry's vector. `model` is the provider fingerprint it was
 * generated under (`deriveSemanticProviderFingerprint`); a row written without
 * one is trusted as the current model.
 */
export function upsertEmbedding(
  db: Database,
  entryId: number,
  embedding: EmbeddingVector,
  model?: string,
): EmbeddingUpsertResult {
  // Pre-flight FK guard: when an entry is deleted between when its id is queued
  // for embedding and when this INSERT runs (e.g. consolidation deletes during
  // a concurrent improve cycle), the INSERT throws "FOREIGN KEY constraint failed"
  // and rolls back the entire batch transaction in the caller, losing every
  // embedding for that run. A cheap SELECT here turns the race into a clean skip.
  const exists = db.prepare("SELECT 1 FROM entries WHERE id = ?").get(entryId);
  if (!exists) return { stored: false, vec: "unavailable" };

  const buf = float32Buffer(embedding);

  // Always write to BLOB table (works without sqlite-vec; the JS-cosine fallback
  // reads it, so semantic search survives a vec fast-path failure).
  db.prepare("INSERT OR REPLACE INTO embeddings (id, embedding, model) VALUES (?, ?, ?)").run(
    entryId,
    buf,
    model ?? null,
  );

  if (!isVecAvailable(db)) return { stored: true, vec: "unavailable" };

  // Fast path: mirror into the sqlite-vec table. Wrapped in a transaction so a
  // crash between DELETE and INSERT does not leave the entry missing. A THROW
  // here — previously swallowed silently by bestEffort — is now surfaced to the
  // caller so the embedding phase can count it, warn, and route search to the
  // (complete) BLOB table rather than a partial/mismatched vec table.
  try {
    db.transaction(() => {
      db.prepare("DELETE FROM entries_vec WHERE id = ?").run(entryId);
      db.prepare("INSERT INTO entries_vec (id, embedding) VALUES (?, ?)").run(entryId, buf);
    })();
    return { stored: true, vec: "ok" };
  } catch {
    return { stored: true, vec: "failed" };
  }
}

export function searchVec(db: Database, queryEmbedding: EmbeddingVector, k: number): DbVecResult[] {
  // Fast path: sqlite-vec, but ONLY when the extension is loaded AND the
  // embedding phase did not record a vec insert failure. A degraded fast-path
  // table (partial or dimension-mismatched) would return wrong or missing
  // neighbours, so we honestly fall back to the JS-cosine scan over the
  // complete BLOB table instead.
  if (isVecAvailable(db) && isVecFastPathReady(db)) {
    const buf = float32Buffer(queryEmbedding);
    try {
      return db
        .prepare("SELECT id, distance FROM entries_vec WHERE embedding MATCH ? AND k = ?")
        .all(buf, k) as DbVecResult[];
    } catch (err) {
      // A dimension mismatch (e.g. the embedding provider/model changed since
      // the fast-path table was built) is a real, expected reason this query
      // specifically cannot use the vec table — the complete BLOB table below
      // is unaffected, so fall back to it rather than either silently
      // returning [] (masking a genuinely corrupt index) or failing the whole
      // search over one degraded index.
      warn(
        "[db] searchVec (sqlite-vec path) failed, falling back to JS-cosine scan:",
        err instanceof Error ? err.message : String(err),
      );
      return searchBlobVec(db, queryEmbedding, k);
    }
  }

  // Fallback: JS-based cosine similarity over BLOB table
  return searchBlobVec(db, queryEmbedding, k);
}

/**
 * Return the k nearest neighbours of an already-indexed entry using its
 * persisted embedding — no re-embedding, no network. Decodes the stored BLOB by
 * byte length (dim = bytes / 4) and reuses searchVec (sqlite-vec fast path or
 * JS-cosine fallback). Returns [] when the entry has no stored embedding or the
 * BLOB is corrupt. The query entry itself is typically returned with distance
 * ~0 — callers should filter it out by id.
 */
export function getNeighborsByEntryId(db: Database, id: number, k: number): DbVecResult[] {
  const row = db.prepare("SELECT embedding FROM embeddings WHERE id = ?").get(id) as { embedding: Buffer } | undefined;
  if (!row) return [];
  const queryEmbedding = bufferToFloat32(row.embedding, Math.floor(row.embedding.byteLength / 4));
  if (!queryEmbedding) return [];
  return searchVec(db, queryEmbedding, k);
}

function float32Buffer(vec: number[]): Buffer {
  const f32 = new Float32Array(vec);
  return Buffer.from(f32.buffer);
}

/**
 * Decode a stored embedding BLOB into a Float32 array of `expectedDim`
 * dimensions. Returns `null` (and emits a warning) when the byte length does
 * not exactly match `expectedDim * 4`, including the legacy partial-trailing
 * float case the previous truncating-divide silently swallowed.
 *
 * BUG-M2: the previous `buf.byteLength / 4` divide would truncate any
 * trailing partial float and a misaligned `byteOffset` would throw — both
 * surfaced as opaque generic errors caught upstream.
 */
function bufferToFloat32(buf: Buffer, expectedDim: number): number[] | null {
  if (buf.byteLength !== expectedDim * 4) {
    warn(
      "[db] bufferToFloat32: skipping embedding row — expected %d bytes (%d dim x 4), got %d",
      expectedDim * 4,
      expectedDim,
      buf.byteLength,
    );
    return null;
  }
  // Copy into a fresh ArrayBuffer to sidestep any byteOffset alignment
  // requirements imposed by Float32Array's typed-array view contract.
  const aligned = new ArrayBuffer(buf.byteLength);
  new Uint8Array(aligned).set(buf);
  const f32 = new Float32Array(aligned);
  return Array.from(f32);
}

function searchBlobVec(db: Database, queryEmbedding: EmbeddingVector, k: number): DbVecResult[] {
  // Only the current model's vectors are comparable with the query vector; rows
  // left from a previous model wait, hidden, until the pass re-embeds them.
  const current = modelPredicate(db, currentEmbeddingModel(db));
  const rows = db.prepare(`SELECT id, embedding FROM embeddings WHERE ${current.sql}`).all(...current.params) as Array<{
    id: number;
    embedding: Buffer;
  }>;

  if (rows.length === 0) return [];

  const expectedDim = queryEmbedding.length;
  const scored: Array<{ id: number; similarity: number }> = [];
  for (const row of rows) {
    const embedding = bufferToFloat32(row.embedding, expectedDim);
    if (embedding === null) continue;
    const similarity = cosineSimilarity(queryEmbedding, embedding);
    scored.push({ id: row.id, similarity });
  }

  scored.sort((a, b) => b.similarity - a.similarity);

  // Convert cosine similarity to L2 distance for compatibility with sqlite-vec interface
  // For normalized vectors: L2² = 2(1 - cos_sim)
  return scored.slice(0, k).map(({ id, similarity }) => ({
    id,
    distance: Math.sqrt(2 * Math.max(0, 1 - similarity)),
  }));
}

/**
 * Return all entries that do not yet have an embedding row for `model` (any
 * row when no model is given). This is the embedding pass's cursor: a row
 * generated under another model counts as missing and is replaced when the
 * entry is re-embedded, so a model change re-embeds incrementally and an
 * interrupted pass resumes where it stopped.
 */
export function getAllEntriesForEmbedding(
  db: Database,
  entryIds?: readonly number[],
  model?: string,
): Array<{ id: number; searchText: string; itemRef: string; filePath: string }> {
  const select = `
      SELECT e.id, e.search_text AS searchText, e.item_ref AS itemRef, e.file_path AS filePath FROM entries e
    `;
  const current = modelPredicate(db, model, "b");
  const missing = `NOT EXISTS (SELECT 1 FROM embeddings b WHERE b.id = e.id AND ${current.sql})`;
  if (entryIds === undefined) {
    return db.prepare(`${select} WHERE ${missing} ORDER BY e.id`).all(...current.params) as Array<{
      id: number;
      searchText: string;
      itemRef: string;
      filePath: string;
    }>;
  }

  const targets = [...new Set(entryIds)].sort((left, right) => left - right);
  const rows: Array<{ id: number; searchText: string; itemRef: string; filePath: string }> = [];
  for (let offset = 0; offset < targets.length; offset += SQLITE_CHUNK_SIZE) {
    const chunk = targets.slice(offset, offset + SQLITE_CHUNK_SIZE);
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => "?").join(",");
    rows.push(
      ...(db
        .prepare(`${select} WHERE e.id IN (${placeholders}) AND ${missing} ORDER BY e.id`)
        .all(...chunk, ...current.params) as Array<{
        id: number;
        searchText: string;
        itemRef: string;
        filePath: string;
      }>),
    );
  }
  return rows;
}

/** Stored embedding rows — for `model` when given, otherwise every row. */
export function getEmbeddingCount(db: Database, model?: string): number {
  const current = modelPredicate(db, model);
  const row = db.prepare(`SELECT COUNT(*) AS cnt FROM embeddings WHERE ${current.sql}`).get(...current.params) as {
    cnt: number;
  };
  return row.cnt;
}
