// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `index.db` embedding-unit repository (docs/plans/index-fragment-vectors.md).
 *
 * Owns the durable, content-addressed vector store: `units_vec` (the vec0
 * table, the ONE copy of every embedding), `units` (a plain lookup table
 * mirroring `units_vec`'s `(unit_hash, identity)` key — vec0 auxiliary
 * columns are not indexable, so a point lookup or an `IN (...)` filter on
 * `units_vec` directly would be a full scan), and `entry_units` (the cheap,
 * derived entry → ordinal → unit_hash mapping that a reindex rebuilds).
 *
 * Lifecycle invariant (the whole design, docs/plans/index-fragment-vectors.md
 * "Vectors are content-addressed and never rebuilt"): `units` and `units_vec`
 * are created if missing and NEVER dropped by a generation rebuild, by
 * `akm index --full`, or by any embeddings purge — only {@link dropOtherIdentities}
 * removes rows, and only for an identity other than the one being kept. A row
 * exists in `units`/`units_vec` if and only if a vector was actually written
 * for it: {@link upsertUnitVectors} and {@link dropOtherIdentities} are both
 * no-ops when sqlite-vec is unavailable, rather than recording a hash with no
 * vector behind it (which would make {@link listMissingHashes} lie).
 */

import { ConfigError } from "../../core/errors";
import type { EmbeddingVector } from "../../llm/embedders/types";
import type { Database } from "../database";
import { SQLITE_CHUNK_SIZE } from "./index-sql";
import { isVecAvailable } from "./index-vec-repository";

// ── Types ───────────────────────────────────────────────────────────────────

export interface UnitVectorRow {
  hash: string;
  identity: string;
  vector: EmbeddingVector;
}

export interface EntryUnitRef {
  ordinal: number;
  fragmentId: string | null;
  hash: string;
}

export interface UnitSearchHit {
  unitId: number;
  hash: string;
  distance: number;
}

export interface UnitEntryMatch {
  distance: number;
  fragmentId: string | null;
  hash: string;
}

export interface UnitCoverage {
  /** Distinct entries with at least one row in `entry_units`. */
  entries: number;
  /** Of those, entries whose every unit has a vector for `identity`. */
  entriesFullyCovered: number;
  /** Total `entry_units` rows (the full unit count for the current mapping). */
  unitsTotal: number;
  /** Of those, rows whose unit_hash has a vector for `identity`. */
  unitsPresent: number;
}

// ── Schema ──────────────────────────────────────────────────────────────────

function createUnitsVecTable(db: Database, dim: number): void {
  db.exec(`
    CREATE VIRTUAL TABLE units_vec USING vec0(
      unit_id   INTEGER PRIMARY KEY,
      embedding FLOAT[${dim}],
      +unit_hash TEXT,
      +identity  TEXT
    );
  `);
}

function tableExists(db: Database, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) != null;
}

/**
 * The vector width `units_vec` was created at, read back from its own DDL
 * (`sqlite_master.sql` carries the `CREATE VIRTUAL TABLE` text verbatim) so
 * there is one source of truth for "what width is this table at right now" —
 * no separate meta key to keep in sync. Returns `undefined` when the table
 * does not exist.
 */
function unitsVecDimension(db: Database): number | undefined {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'units_vec'").get() as
    | { sql: string }
    | undefined;
  const match = row?.sql.match(/FLOAT\[(\d+)\]/);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

/**
 * Create `units`, `entry_units` and (when sqlite-vec is loaded) `units_vec`
 * if they do not already exist. Idempotent and safe to call on every schema
 * ensure — it never touches an existing table's rows or drops anything.
 *
 * `dim` only matters the first time `units_vec` is created; an existing table
 * keeps its width until {@link dropOtherIdentities} recreates it for a real
 * dimension change.
 */
export function ensureUnitTables(db: Database, dim: number): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS units (
      unit_id   INTEGER PRIMARY KEY,
      unit_hash TEXT NOT NULL,
      identity  TEXT NOT NULL,
      UNIQUE (unit_hash, identity)
    );
    CREATE TABLE IF NOT EXISTS entry_units (
      entry_id    INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
      ordinal     INTEGER NOT NULL,
      fragment_id TEXT,
      unit_hash   TEXT NOT NULL,
      PRIMARY KEY (entry_id, ordinal)
    );
    CREATE INDEX IF NOT EXISTS entry_units_hash ON entry_units(unit_hash);
  `);

  // Mirrors entries_vec: a vec0 virtual table needs the extension loaded to
  // even be created. `units`/`entry_units` above are plain tables and exist
  // regardless, so lookups and the entry→hash mapping keep working; only the
  // KNN path is unavailable (see `searchUnits`).
  if (!isVecAvailable(db)) return;
  if (tableExists(db, "units_vec")) return;
  createUnitsVecTable(db, dim);
}

// ── Vector storage ──────────────────────────────────────────────────────────

function float32Buffer(vector: EmbeddingVector): Buffer {
  return Buffer.from(new Float32Array(vector).buffer);
}

/**
 * Write new (hash, identity) → vector rows. Rows whose (hash, identity)
 * already exists in `units` are left as-is in `units` (content-addressed: the
 * same text under the same identity is the same vector) but their `units_vec`
 * row is still rewritten, so a prior run that wrote the `units` row but failed
 * before its vec0 mirror (or ran while sqlite-vec was unavailable) self-heals
 * on the next call instead of leaving a permanent gap `searchUnits` can never
 * see.
 *
 * A no-op returning `{ inserted: 0 }` when sqlite-vec is unavailable: there is
 * no BLOB fallback table for units (docs/plans/index-fragment-vectors.md — one
 * copy of every vector, in vec0), so writing a `units` row with no vector
 * behind it would make it look present to {@link listMissingHashes} forever.
 */
export function upsertUnitVectors(db: Database, rows: readonly UnitVectorRow[]): { inserted: number } {
  if (rows.length === 0 || !isVecAvailable(db)) return { inserted: 0 };

  const insertUnit = db.prepare(
    "INSERT INTO units (unit_hash, identity) VALUES (?, ?) ON CONFLICT(unit_hash, identity) DO NOTHING",
  );
  const selectUnitId = db.prepare("SELECT unit_id FROM units WHERE unit_hash = ? AND identity = ?");
  const deleteVec = db.prepare("DELETE FROM units_vec WHERE unit_id = ?");
  const insertVec = db.prepare("INSERT INTO units_vec (unit_id, embedding, unit_hash, identity) VALUES (?, ?, ?, ?)");

  let inserted = 0;
  db.transaction(() => {
    for (const row of rows) {
      const result = insertUnit.run(row.hash, row.identity);
      if (Number(result.changes) > 0) inserted++;
      const unitRow = selectUnitId.get(row.hash, row.identity) as { unit_id: number } | undefined;
      if (!unitRow) continue;
      // DELETE-then-INSERT (not INSERT OR REPLACE) mirrors upsertEmbedding's
      // vec0 mirror in index-vec-repository.ts — the established pattern for
      // writing a fixed-rowid row into a vec0 table on this driver.
      deleteVec.run(unitRow.unit_id);
      insertVec.run(unitRow.unit_id, float32Buffer(row.vector), row.hash, row.identity);
    }
  })();
  return { inserted };
}

/**
 * Which of `hashes` have no vector yet for `identity`. The set-difference
 * that drives the whole indexing loop (docs/plans/index-fragment-vectors.md
 * "Indexing is a set difference"): callers hash every unit's text, ask what is
 * missing, and only send that difference to the provider.
 *
 * Deduplicated and returned in first-occurrence order — the same unit text
 * commonly recurs across entries (content-addressed), so de-duping here is
 * what keeps a shared fragment from being requested from the provider twice
 * in one pass.
 */
export function listMissingHashes(db: Database, hashes: readonly string[], identity: string): string[] {
  const unique = [...new Set(hashes)];
  if (unique.length === 0) return [];

  const present = new Set<string>();
  for (let offset = 0; offset < unique.length; offset += SQLITE_CHUNK_SIZE) {
    const chunk = unique.slice(offset, offset + SQLITE_CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = db
      .prepare(`SELECT unit_hash FROM units WHERE identity = ? AND unit_hash IN (${placeholders})`)
      .all(identity, ...chunk) as { unit_hash: string }[];
    for (const row of rows) present.add(row.unit_hash);
  }
  return unique.filter((hash) => !present.has(hash));
}

/**
 * Remove rows for every identity except `keep`, recreating `units_vec` at
 * `dim` first when its current width differs from `dim`.
 *
 * vec0's embedding column width is fixed for the whole table, so a genuine
 * dimension change (a real model swap, not a rename) cannot be expressed as a
 * row-level DELETE — the table is dropped and recreated instead. Any row that
 * survives a width mismatch could only belong to `keep`, and it could only
 * exist if it had already been written at `dim` — which the OLD, differently
 * sized table would have rejected — so nothing behind `keep` is lost by the
 * drop.
 *
 * A no-op when sqlite-vec is unavailable: `units`/`units_vec` only ever gain
 * rows when a vector was actually written (see {@link upsertUnitVectors}), so
 * there is nothing to remove and no vec0 table this could safely touch.
 */
export function dropOtherIdentities(db: Database, keep: string, dim: number): { removed: number } {
  if (!isVecAvailable(db)) return { removed: 0 };
  ensureUnitTables(db, dim);

  const staleCount = (db.prepare("SELECT COUNT(*) AS n FROM units WHERE identity != ?").get(keep) as { n: number }).n;
  if (staleCount === 0) return { removed: 0 };

  const currentDim = unitsVecDimension(db);
  if (currentDim !== undefined && currentDim !== dim) {
    db.exec("DROP TABLE IF EXISTS units_vec");
    createUnitsVecTable(db, dim);
  } else {
    const staleIds = (
      db.prepare("SELECT unit_id FROM units WHERE identity != ?").all(keep) as { unit_id: number }[]
    ).map((row) => row.unit_id);
    for (let offset = 0; offset < staleIds.length; offset += SQLITE_CHUNK_SIZE) {
      const chunk = staleIds.slice(offset, offset + SQLITE_CHUNK_SIZE);
      const placeholders = chunk.map(() => "?").join(",");
      db.prepare(`DELETE FROM units_vec WHERE unit_id IN (${placeholders})`).run(...chunk);
    }
  }

  db.prepare("DELETE FROM units WHERE identity != ?").run(keep);
  return { removed: staleCount };
}

// ── Entry → unit mapping ────────────────────────────────────────────────────

/** Replace every `entry_units` row for `entryId` with `units` (delete-then-insert). */
export function replaceEntryUnits(db: Database, entryId: number, units: readonly EntryUnitRef[]): void {
  db.transaction(() => {
    db.prepare("DELETE FROM entry_units WHERE entry_id = ?").run(entryId);
    const insert = db.prepare(
      "INSERT INTO entry_units (entry_id, ordinal, fragment_id, unit_hash) VALUES (?, ?, ?, ?)",
    );
    for (const unit of units) {
      insert.run(entryId, unit.ordinal, unit.fragmentId, unit.hash);
    }
  })();
}

/** Remove every `entry_units` row for the given entries (e.g. entries deleted outside a cascade). */
export function deleteEntryUnits(db: Database, entryIds: readonly number[]): void {
  const unique = [...new Set(entryIds)];
  if (unique.length === 0) return;
  for (let offset = 0; offset < unique.length; offset += SQLITE_CHUNK_SIZE) {
    const chunk = unique.slice(offset, offset + SQLITE_CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(",");
    db.prepare(`DELETE FROM entry_units WHERE entry_id IN (${placeholders})`).run(...chunk);
  }
}

// ── Search ──────────────────────────────────────────────────────────────────

/**
 * vec0 0.1.9 rejects a KNN query that also filters on an auxiliary column —
 * "An illegal WHERE constraint was provided on a vec0 auxiliary column in a
 * KNN query" — so `identity` cannot be pushed into the `MATCH` query itself
 * and has to be filtered afterward. Over-fetching by this factor keeps that
 * post-filter from starving recall during the rare, transient window where
 * more than one identity's rows coexist in `units_vec` (the steady state,
 * enforced by {@link dropOtherIdentities}, is exactly one identity).
 */
const UNIT_SEARCH_OVERFETCH = 4;

/**
 * KNN search over `units_vec` for the given `identity`, nearest first.
 * Throws a {@link ConfigError} when sqlite-vec is not loaded — there is no JS
 * fallback for units (docs/plans/index-fragment-vectors.md), so the caller is
 * expected to catch this and fall back to lexical search.
 */
export function searchUnits(db: Database, query: EmbeddingVector, k: number, identity: string): UnitSearchHit[] {
  if (!isVecAvailable(db)) {
    throw new ConfigError(
      "sqlite-vec is not loaded, so unit search cannot run its vec0 KNN query. Fall back to lexical search.",
      "EMBEDDING_VEC_UNAVAILABLE",
    );
  }
  if (k <= 0) return [];

  const rows = db
    .prepare(
      "SELECT unit_id AS unitId, unit_hash AS hash, identity AS identity, distance AS distance " +
        "FROM units_vec WHERE embedding MATCH ? AND k = ?",
    )
    .all(float32Buffer(query), k * UNIT_SEARCH_OVERFETCH) as Array<{
    unitId: number;
    hash: string;
    identity: string;
    distance: number;
  }>;

  return rows
    .filter((row) => row.identity === identity)
    .slice(0, k)
    .map(({ unitId, hash, distance }) => ({ unitId, hash, distance }));
}

/**
 * Group unit hits to their owning entries, keeping the best (lowest distance)
 * unit per entry. A unit hash can back more than one `entry_units` row (the
 * same fragment text shared across entries, or multiple hits sharing a hash
 * under different identities in the rare transient window `searchUnits`
 * already tolerates), so both the hit list and the hash→entries fan-out are
 * reduced to a minimum by distance.
 */
export function groupUnitHitsByEntry(db: Database, hits: readonly UnitSearchHit[]): Map<number, UnitEntryMatch> {
  const result = new Map<number, UnitEntryMatch>();
  if (hits.length === 0) return result;

  const distanceByHash = new Map<string, number>();
  for (const hit of hits) {
    const existing = distanceByHash.get(hit.hash);
    if (existing === undefined || hit.distance < existing) distanceByHash.set(hit.hash, hit.distance);
  }
  const hashes = [...distanceByHash.keys()];

  for (let offset = 0; offset < hashes.length; offset += SQLITE_CHUNK_SIZE) {
    const chunk = hashes.slice(offset, offset + SQLITE_CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT entry_id AS entryId, fragment_id AS fragmentId, unit_hash AS hash FROM entry_units WHERE unit_hash IN (${placeholders})`,
      )
      .all(...chunk) as Array<{ entryId: number; fragmentId: string | null; hash: string }>;
    for (const row of rows) {
      const distance = distanceByHash.get(row.hash);
      if (distance === undefined) continue;
      const existing = result.get(row.entryId);
      if (!existing || distance < existing.distance) {
        result.set(row.entryId, { distance, fragmentId: row.fragmentId, hash: row.hash });
      }
    }
  }
  return result;
}

// ── Coverage ────────────────────────────────────────────────────────────────

/** How much of the current `entry_units` mapping has a vector for `identity`, for progress reporting. */
export function unitCoverage(db: Database, identity: string): UnitCoverage {
  const entries = (db.prepare("SELECT COUNT(DISTINCT entry_id) AS n FROM entry_units").get() as { n: number }).n;
  const unitsTotal = (db.prepare("SELECT COUNT(*) AS n FROM entry_units").get() as { n: number }).n;
  const unitsPresent = (
    db
      .prepare("SELECT COUNT(*) AS n FROM entry_units eu JOIN units u ON u.unit_hash = eu.unit_hash AND u.identity = ?")
      .get(identity) as { n: number }
  ).n;
  const entriesFullyCovered = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM (
           SELECT eu.entry_id
           FROM entry_units eu
           LEFT JOIN units u ON u.unit_hash = eu.unit_hash AND u.identity = ?
           GROUP BY eu.entry_id
           HAVING COUNT(*) = COUNT(u.unit_id)
         )`,
      )
      .get(identity) as { n: number }
  ).n;
  return { entries, entriesFullyCovered, unitsTotal, unitsPresent };
}
