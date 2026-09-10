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
 * Verify that the vec fast-path table mirrors the complete durable BLOB set.
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
    const missingVecRows = db
      .prepare(`
        SELECT id FROM embeddings
        EXCEPT
        SELECT id FROM entries_vec
        LIMIT 1
      `)
      .all();
    if (missingVecRows.length > 0) return false;

    const orphanVecRows = db
      .prepare(`
        SELECT id FROM entries_vec
        EXCEPT
        SELECT id FROM embeddings
        LIMIT 1
      `)
      .all();
    return orphanVecRows.length === 0;
  } catch {
    return false;
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
 * virtual table) and mark the index as embedding-free. The single place that
 * invalidates embeddings — used on a dimension change, a model/provider change,
 * and a full rebuild.
 *
 * No backup: embeddings are a derived cache, fully regenerable from the markdown
 * by the next `akm index`. (Recovery model decided 2026-06-25.)
 *
 * `dropVecTable: true` DROPs `entries_vec` — used on a DIMENSION change, where
 * the vec0 table must be recreated at the new width by the caller. The default
 * clears its rows in place (same dimension, stale vectors).
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

export function upsertEmbedding(db: Database, entryId: number, embedding: EmbeddingVector): EmbeddingUpsertResult {
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
  db.prepare("INSERT OR REPLACE INTO embeddings (id, embedding) VALUES (?, ?)").run(entryId, buf);

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
  const rows = db.prepare("SELECT id, embedding FROM embeddings").all() as Array<{ id: number; embedding: Buffer }>;

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
 * Return all entries that do not yet have an embedding row.
 * Used by the embedding phase to determine which entries need vectors generated.
 */
export function getAllEntriesForEmbedding(
  db: Database,
  entryIds?: readonly number[],
): Array<{ id: number; searchText: string; itemRef: string; filePath: string }> {
  const select = `
      SELECT e.id, e.search_text AS searchText, e.item_ref AS itemRef, e.file_path AS filePath FROM entries e
    `;
  const missing = "NOT EXISTS (SELECT 1 FROM embeddings b WHERE b.id = e.id)";
  if (entryIds === undefined) {
    return db.prepare(`${select} WHERE ${missing} ORDER BY e.id`).all() as Array<{
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
      ...(db.prepare(`${select} WHERE e.id IN (${placeholders}) AND ${missing} ORDER BY e.id`).all(...chunk) as Array<{
        id: number;
        searchText: string;
        itemRef: string;
        filePath: string;
      }>),
    );
  }
  return rows;
}

export function getEmbeddingCount(db: Database): number {
  const row = db.prepare("SELECT COUNT(*) AS cnt FROM embeddings").get() as { cnt: number };
  return row.cnt;
}
