// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * stage-2 stub, superseded at merge.
 *
 * Module A2 of docs/plans/index-units-contract.md owns the real
 * `units-repository.ts` (the durable content-addressed vector store: `units`,
 * `units_vec`, `entry_units`, and the full A2 export surface). This file
 * exists only so module B3 (search over units,
 * docs/plans/index-redesign-contract.md) has the DDL and the two A2
 * functions it consumes — `searchUnits` and `groupUnitHitsByEntry` — to
 * build and test against while A2 lands on `wt/index-units` in parallel. It
 * also exports `ensureUnitTables`, which is not one of the two functions B3
 * calls at search time but is the only way B3's own tests can materialize
 * the DDL below on a temp `index.db` (A2's contract wires the real one into
 * `index-schema.ts`, a file this stub deliberately does not touch). The
 * integrator takes A2's file wholesale at merge; do not extend this stub
 * with anything B3 does not itself need.
 *
 * DEVIATION (reported, not silently resolved — see the B3 delivery report):
 * the stage-1 contract's DDL declares `+identity TEXT` as a plain vec0
 * AUXILIARY column and asserts inline `WHERE ... AND identity = ?` filtering
 * "verified to work on this build". Empirically, on the vendored sqlite-vec
 * 0.1.9, combining a KNN `MATCH` with a WHERE constraint on an auxiliary
 * column throws `SQLiteError: An illegal WHERE constraint was provided on a
 * vec0 auxiliary column in a KNN query.` `identity TEXT PARTITION KEY`
 * (tested, works) is the idiomatic fix; this stub keeps the contract's exact
 * DDL as instructed and works around the limitation by over-fetching the KNN
 * unfiltered and filtering `identity` in JS, so `searchUnits` behaves
 * correctly (just not index-accelerated on `identity`) until A2 lands.
 */

import { ConfigError } from "../../core/errors";
import type { EmbeddingVector } from "../../llm/embedders/types";
import type { Database } from "../database";
import { isVecAvailable } from "./index-vec-repository";

/** One semantic KNN hit over the unit vector space. */
export interface UnitVecHit {
  unitId: number;
  hash: string;
  distance: number;
}

/**
 * Multiplier applied to `k` when over-fetching `units_vec` KNN rows to
 * post-filter by `identity` in JS (see the DEVIATION note above — this
 * build's vec0 rejects an inline aux-column WHERE combined with KNN).
 * 4x keeps the common case (one active identity, so almost every KNN row
 * already matches) cheap while giving a second coexisting identity room to
 * still fill out `k` real hits.
 */
const UNITS_VEC_IDENTITY_OVERFETCH_MULTIPLIER = 4;
/**
 * Floor added to the multiplier above so a small `k` (e.g. 1-5, common for
 * focused test fixtures) still over-fetches enough rows to find `k` matches
 * of the requested identity when other identities are interleaved.
 */
const UNITS_VEC_IDENTITY_OVERFETCH_FLOOR = 50;

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

  if (!isVecAvailable(db)) return;
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='units_vec'").get();
  if (exists) return;
  db.exec(`
    CREATE VIRTUAL TABLE units_vec USING vec0(
      unit_id   INTEGER PRIMARY KEY,
      embedding FLOAT[${dim}],
      +unit_hash TEXT,
      +identity  TEXT
    );
  `);
}

function float32Buffer(vec: EmbeddingVector): Buffer {
  return Buffer.from(new Float32Array(vec).buffer);
}

export function searchUnits(db: Database, query: EmbeddingVector, k: number, identity: string): UnitVecHit[] {
  if (!isVecAvailable(db)) {
    throw new ConfigError(
      "sqlite-vec is not available; semantic unit search requires the loaded extension.",
      "EMBEDDING_NOT_CONFIGURED",
      "Install sqlite-vec, or rely on lexical search until it is available.",
    );
  }
  if (k <= 0) return [];
  const buf = float32Buffer(query);
  const overfetch = Math.max(k * UNITS_VEC_IDENTITY_OVERFETCH_MULTIPLIER, k + UNITS_VEC_IDENTITY_OVERFETCH_FLOOR);
  const rows = db
    .prepare(`
      SELECT unit_id AS unitId, unit_hash AS hash, identity, distance
      FROM units_vec
      WHERE embedding MATCH ? AND k = ?
    `)
    .all(buf, overfetch) as Array<{ unitId: number; hash: string; identity: string; distance: number }>;
  return rows
    .filter((row) => row.identity === identity)
    .slice(0, k)
    .map(({ unitId, hash, distance }) => ({ unitId, hash, distance }));
}

export function groupUnitHitsByEntry(
  db: Database,
  hits: readonly UnitVecHit[],
): Map<number, { distance: number; fragmentId: string | null; hash: string }> {
  const result = new Map<number, { distance: number; fragmentId: string | null; hash: string }>();
  if (hits.length === 0) return result;

  const hashes = [...new Set(hits.map((hit) => hit.hash))];
  const placeholders = hashes.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT entry_id AS entryId, fragment_id AS fragmentId, unit_hash AS unitHash FROM entry_units WHERE unit_hash IN (${placeholders})`,
    )
    .all(...hashes) as Array<{ entryId: number; fragmentId: string | null; unitHash: string }>;

  const ownersByHash = new Map<string, Array<{ entryId: number; fragmentId: string | null }>>();
  for (const row of rows) {
    const owners = ownersByHash.get(row.unitHash) ?? [];
    owners.push({ entryId: row.entryId, fragmentId: row.fragmentId });
    ownersByHash.set(row.unitHash, owners);
  }

  for (const hit of hits) {
    for (const owner of ownersByHash.get(hit.hash) ?? []) {
      const existing = result.get(owner.entryId);
      if (!existing || hit.distance < existing.distance) {
        result.set(owner.entryId, { distance: hit.distance, fragmentId: owner.fragmentId, hash: hit.hash });
      }
    }
  }
  return result;
}
