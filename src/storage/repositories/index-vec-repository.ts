// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `index.db` vector + embedding repository.
 *
 * Owns the sqlite-vec extension load/availability probe, the BLOB `embeddings`
 * table, the `entries_vec` virtual table, and the JS-cosine fallback path.
 * Extracted verbatim from `src/indexer/db/db.ts` (WI-5a).
 */

import { createRequire } from "node:module";
import { bestEffort } from "../../core/best-effort";
import { warn } from "../../core/warn";
import { cosineSimilarity, type EmbeddingVector } from "../../llm/embedders/types";
import type { Database } from "../database";
import type { DbVecResult } from "./index-entry-types";
import { setMeta } from "./index-meta-repository";

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
    // `db` here is the genuine underlying driver handle returned by the storage
    // boundary (bun:sqlite on Bun, better-sqlite3 on Node) — only structurally
    // narrowed for callers. sqlite-vec's `load()` accepts either real handle,
    // so no raw-handle escape hatch is required.
    sqliteVec.load(db);
    vecStatus.set(db, true);
  } catch {
    vecStatus.set(db, false);
  }
}

export function isVecAvailable(db: Database): boolean {
  return vecStatus.get(db) ?? false;
}

const VEC_DOCS_URL = "https://github.com/itlackey/akm/blob/main/docs/configuration.md#sqlite-vec-extension";
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

export function upsertEmbedding(db: Database, entryId: number, embedding: EmbeddingVector): boolean {
  // Pre-flight FK guard: when an entry is deleted between when its id is queued
  // for embedding and when this INSERT runs (e.g. consolidation deletes during
  // a concurrent improve cycle), the INSERT throws "FOREIGN KEY constraint failed"
  // and rolls back the entire batch transaction in the caller, losing every
  // embedding for that run. A cheap SELECT here turns the race into a clean skip.
  const exists = db.prepare("SELECT 1 FROM entries WHERE id = ?").get(entryId);
  if (!exists) return false;

  const buf = float32Buffer(embedding);

  // Always write to BLOB table (works without sqlite-vec)
  db.prepare("INSERT OR REPLACE INTO embeddings (id, embedding) VALUES (?, ?)").run(entryId, buf);

  // Also write to sqlite-vec table when available (fast path).
  // Wrapped in a transaction so a crash between DELETE and INSERT does not
  // leave the entry missing from the vec table.
  if (isVecAvailable(db)) {
    bestEffort(() => {
      db.transaction(() => {
        db.prepare("DELETE FROM entries_vec WHERE id = ?").run(entryId);
        db.prepare("INSERT INTO entries_vec (id, embedding) VALUES (?, ?)").run(entryId, buf);
      })();
    }, "vec table unavailable or constraint failure");
  }
  return true;
}

export function searchVec(db: Database, queryEmbedding: EmbeddingVector, k: number): DbVecResult[] {
  // Fast path: use sqlite-vec when available
  if (isVecAvailable(db)) {
    const buf = float32Buffer(queryEmbedding);
    try {
      return db
        .prepare("SELECT id, distance FROM entries_vec WHERE embedding MATCH ? AND k = ?")
        .all(buf, k) as DbVecResult[];
    } catch (err) {
      // Log the failure so it's visible in diagnostics
      warn("[db] searchVec (sqlite-vec path) failed:", err instanceof Error ? err.message : String(err));
      return [];
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
  try {
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
  } catch (err) {
    // MD-5: Log the failure so it's visible in diagnostics
    warn("[db] searchBlobVec (JS fallback) failed:", err instanceof Error ? err.message : String(err));
    return [];
  }
}

/**
 * Return all entries that do not yet have an embedding row.
 * Used by the embedding phase to determine which entries need vectors generated.
 */
export function getAllEntriesForEmbedding(
  db: Database,
): Array<{ id: number; searchText: string; entryKey: string; filePath: string }> {
  return db
    .prepare(`
      SELECT e.id, e.search_text AS searchText, e.entry_key AS entryKey, e.file_path AS filePath FROM entries e
      WHERE NOT EXISTS (SELECT 1 FROM embeddings b WHERE b.id = e.id)
    `)
    .all() as Array<{ id: number; searchText: string; entryKey: string; filePath: string }>;
}

export function getEmbeddingCount(db: Database): number {
  const row = db.prepare("SELECT COUNT(*) AS cnt FROM embeddings").get() as { cnt: number };
  return row.cnt;
}
