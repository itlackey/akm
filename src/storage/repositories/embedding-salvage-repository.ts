// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `index.db` embedding salvage (#955) — a transient, self-emptying table
 * that lets a full rebuild or an index-generation bump reuse vectors instead
 * of re-embedding a corpus whose content did not change.
 *
 * Zero steady-state cost by design: this is NOT a second embedding cache.
 * Rows are copied aside only at the moment they would otherwise be discarded
 * wholesale — a full-index wipe (`persistDirRecords`) or a generation bump
 * (`rebuildIncompatibleIndexGeneration`) — and are consumed by the very next
 * embedding pass (`generateEmbeddingsForDb`). A pass that completes without
 * abort or circuit-break purges whatever is left; an interrupted pass leaves
 * the table for the next attempt to pick up.
 *
 * Reuse is keyed on `sha256(search_text)` plus the fingerprint the vector was
 * generated under — a fingerprint mismatch or a single-byte content change
 * both correctly fall through to a real provider call. `content_hash` is the
 * PRIMARY KEY (not `(content_hash, fingerprint)`) so relabeling a whole
 * generation's fingerprint after a canary "keep" verdict is one UPDATE, and a
 * hash colliding across two discards simply keeps the most recent copy —
 * salvage is a best-effort optimization, not a durable multi-generation
 * archive.
 */

import { createHash } from "node:crypto";
import type { EmbeddingVector } from "../../llm/embedders/types";
import type { Database } from "../database";
import { blobToEmbedding } from "./embeddings-repository";
import { getMeta } from "./index-meta-repository";
import { SQLITE_CHUNK_SIZE } from "./index-sql";

/**
 * Create the salvage table. Additive-only DDL: it carries no bearing on the
 * `entries` generation fingerprint (`hasCanonicalEntrySchema`), so adding it
 * does not require an index-generation bump.
 */
export function ensureEmbeddingSalvageTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS embedding_salvage (
      content_hash TEXT PRIMARY KEY,
      fingerprint  TEXT NOT NULL,
      embedding    BLOB NOT NULL,
      salvaged_at  TEXT NOT NULL
    );
  `);
}

/** The one hash function salvage writes and reuse lookups must agree on. */
export function hashEmbeddableText(searchText: string): string {
  return createHash("sha256").update(searchText, "utf8").digest("hex");
}

function tableExists(db: Database, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name) != null;
}

function tableHasColumn(db: Database, table: string, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return columns.some((c) => c.name === column);
}

/**
 * Copy every (hash of search_text, embedding) pair about to be discarded
 * wholesale into `embedding_salvage`, tagged with the `embeddingFingerprint`
 * the discarded vectors were generated under. The caller MUST run this
 * inside the same transaction as the discard that follows it, so the copy
 * and the delete commit or roll back together.
 *
 * Streams `entries JOIN embeddings` in id-ordered pages of
 * {@link SQLITE_CHUNK_SIZE} instead of loading every row into memory before
 * hashing anything — a full rebuild of a large stash otherwise held the
 * entire corpus's search text and vectors in memory at once just to copy
 * them aside (#955, field-report follow-up).
 *
 * A no-op (returns 0) when there is no stored `embeddingFingerprint` to tag
 * rows with (nothing was ever verified against a provider, so there is
 * nothing worth reusing later) or the generation being discarded predates
 * the `entries.search_text` column or has no `embeddings` table at all — an
 * older generation than that has nothing this can safely read.
 */
export function salvageEmbeddingsBeforeDiscard(db: Database): number {
  const fingerprint = getMeta(db, "embeddingFingerprint");
  if (!fingerprint) return 0;
  if (!tableExists(db, "entries") || !tableExists(db, "embeddings")) return 0;
  if (!tableHasColumn(db, "entries", "search_text")) return 0;

  const page = db.prepare(
    "SELECT e.id AS id, e.search_text AS searchText, em.embedding AS embedding " +
      "FROM entries e JOIN embeddings em ON em.id = e.id WHERE e.id > ? ORDER BY e.id LIMIT ?",
  );
  const insert = db.prepare(
    "INSERT OR REPLACE INTO embedding_salvage (content_hash, fingerprint, embedding, salvaged_at) VALUES (?, ?, ?, ?)",
  );
  const salvagedAt = new Date().toISOString();

  let lastId = 0;
  let total = 0;
  for (;;) {
    const rows = page.all(lastId, SQLITE_CHUNK_SIZE) as Array<{
      id: number;
      searchText: string;
      embedding: Uint8Array;
    }>;
    if (rows.length === 0) break;
    for (const row of rows) {
      insert.run(hashEmbeddableText(row.searchText), fingerprint, row.embedding, salvagedAt);
    }
    total += rows.length;
    lastId = rows[rows.length - 1]?.id ?? lastId;
    if (rows.length < SQLITE_CHUNK_SIZE) break;
  }
  return total;
}

/**
 * Remove every salvage row. Called after an embedding pass completes without
 * abort or circuit-break (the salvaged generation has now either been reused
 * or superseded), and by `--reembed` / a canary "rebuild" verdict (the
 * salvaged vectors belong to a different model and are never reusable).
 */
export function purgeEmbeddingSalvage(db: Database): void {
  db.exec("DELETE FROM embedding_salvage");
}

/**
 * A canary "keep" verdict means the model did not actually change — only its
 * fingerprint STRING did (e.g. a gateway rename). Salvage rows tagged with
 * the old string are still valid vectors; rewrite them to the new string so
 * they remain reusable instead of silently going stale.
 */
export function relabelEmbeddingSalvageFingerprint(db: Database, fromFingerprint: string, toFingerprint: string): void {
  db.prepare("UPDATE embedding_salvage SET fingerprint = ? WHERE fingerprint = ?").run(toFingerprint, fromFingerprint);
}

export interface SalvageReuseResult<T> {
  /** Count of entries actually written via `writeReused` (its return was truthy). */
  reusedCount: number;
  /** Entries with no matching salvage row (or `writeReused` returned false) — still need a provider call. */
  remaining: T[];
}

/**
 * Reuse salvaged vectors for `entries` whose `searchText` hash matches a
 * salvage row tagged with the CURRENT `fingerprint` — never across
 * fingerprints, and never when `search_text` differs by even one byte (the
 * hash is exact-match only, by design). Matches are written via
 * `writeReused` in chunks of {@link SQLITE_CHUNK_SIZE}, each its own
 * transaction, mirroring the main pass's per-batch commit (#955) so an
 * interruption partway through the reuse step keeps whatever already wrote.
 *
 * The steady state of every ordinary run is an EMPTY salvage table (nothing
 * was just discarded), so this checks that first with one indexed lookup —
 * `SELECT 1 ... LIMIT 1` — before hashing a single pending entry. Hashing
 * every entry up front to look up a table that is empty 100% of the time
 * outside a rebuild was pure wasted work on the common path (#955,
 * field-report follow-up).
 */
export function reuseSalvagedEmbeddings<T extends { searchText: string }>(
  db: Database,
  entries: readonly T[],
  fingerprint: string,
  writeReused: (entry: T, embedding: EmbeddingVector) => boolean,
): SalvageReuseResult<T> {
  if (entries.length === 0) return { reusedCount: 0, remaining: [] };

  const anySalvageForFingerprint = db
    .prepare("SELECT 1 FROM embedding_salvage WHERE fingerprint = ? LIMIT 1")
    .get(fingerprint);
  if (!anySalvageForFingerprint) return { reusedCount: 0, remaining: [...entries] };

  const hashes = entries.map((entry) => hashEmbeddableText(entry.searchText));
  const salvageByHash = new Map<string, Uint8Array>();
  const uniqueHashes = [...new Set(hashes)];
  for (let offset = 0; offset < uniqueHashes.length; offset += SQLITE_CHUNK_SIZE) {
    const chunk = uniqueHashes.slice(offset, offset + SQLITE_CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT content_hash AS contentHash, embedding FROM embedding_salvage WHERE fingerprint = ? AND content_hash IN (${placeholders})`,
      )
      .all(fingerprint, ...chunk) as Array<{ contentHash: string; embedding: Uint8Array }>;
    for (const row of rows) salvageByHash.set(row.contentHash, row.embedding);
  }
  if (salvageByHash.size === 0) return { reusedCount: 0, remaining: [...entries] };

  let reusedCount = 0;
  const remaining: T[] = [];
  for (let offset = 0; offset < entries.length; offset += SQLITE_CHUNK_SIZE) {
    const end = Math.min(offset + SQLITE_CHUNK_SIZE, entries.length);
    const chunkMatches: Array<{ entry: T; blob: Uint8Array }> = [];
    for (let i = offset; i < end; i++) {
      const entry = entries[i] as T;
      const blob = salvageByHash.get(hashes[i] as string);
      if (blob) chunkMatches.push({ entry, blob });
      else remaining.push(entry);
    }
    if (chunkMatches.length === 0) continue;
    db.transaction(() => {
      for (const { entry, blob } of chunkMatches) {
        if (writeReused(entry, blobToEmbedding(blob))) reusedCount++;
        else remaining.push(entry);
      }
    })();
  }
  return { reusedCount, remaining };
}
