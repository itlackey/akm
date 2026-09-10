// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * units-repository — the durable, content-addressed embedding-unit store
 * (docs/plans/index-fragment-vectors.md; index-units-contract.md module A2).
 *
 * Opens a REAL temp index.db via the raw `openDatabase`/`loadVecExtension`
 * pair (not `openIndexDatabase`/`openExistingDatabase` from
 * index-connection.ts) plus `ensureSchema` directly — the same pattern as
 * tests/storage/finalize-on-close.test.ts and
 * tests/storage/abi-mismatch-diagnostic.test.ts, so this stays outside
 * tests/integration/ under AGENTS.md's ORG-03/04/05/06 classification rule.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigError } from "../../src/core/errors";
import type { Database } from "../../src/storage/database";
import { openDatabase } from "../../src/storage/database";
import { deleteAllEntries } from "../../src/storage/repositories/index-entries-repository";
import { setMeta } from "../../src/storage/repositories/index-meta-repository";
import { ensureSchema } from "../../src/storage/repositories/index-schema";
import { isVecAvailable, loadVecExtension, purgeEmbeddings } from "../../src/storage/repositories/index-vec-repository";
import {
  deleteEntryUnits,
  dropOtherIdentities,
  ensureUnitTables,
  getNeighborsByEntryId,
  groupUnitHitsByEntry,
  listMissingHashes,
  replaceEntryUnits,
  searchUnits,
  unitCoverage,
  upsertUnitVectors,
} from "../../src/storage/repositories/units-repository";

const DIM = 4;
const IDENTITY_A = "local:test-model|4";
const IDENTITY_B = "local:other-model|4";

function withTempDb(run: (db: Database, dbPath: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-units-repo-"));
  const dbPath = path.join(dir, "index.db");
  const db = openDatabase(dbPath);
  loadVecExtension(db);
  try {
    ensureSchema(db, DIM);
    run(db, dbPath);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** A trivially distinct DIM-wide vector, offset by `seed` so callers can tell rows apart. */
function vector(seed: number): number[] {
  return [seed, seed + 1, seed + 2, seed + 3];
}

function insertEntry(db: Database, itemRef: string): number {
  const result = db
    .prepare(
      `INSERT INTO entries (item_ref, bundle_id, component_id, concept_id, adapter_id, type, file_path, document_json, search_text)
       VALUES (?, 'stash', 'stash', ?, 'akm', 'memory', ?, '{}', '')`,
    )
    .run(itemRef, itemRef, `/tmp/${itemRef}.md`);
  return Number(result.lastInsertRowid);
}

describe("units-repository", () => {
  test("sqlite-vec loads in this test environment (a precondition for every other test here)", () => {
    withTempDb((db) => {
      expect(isVecAvailable(db)).toBe(true);
    });
  });

  test("ensureUnitTables is idempotent and creates units, entry_units, units_vec", () => {
    withTempDb((db) => {
      // ensureSchema already wired ensureUnitTables in; calling it again
      // directly must be a safe no-op, not an error.
      ensureUnitTables(db, DIM);
      const names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(
        (row) => row.name,
      );
      expect(names).toContain("units");
      expect(names).toContain("entry_units");
      expect(names).toContain("units_vec");
    });
  });

  test("upsertUnitVectors + listMissingHashes round-trip", () => {
    withTempDb((db) => {
      expect(listMissingHashes(db, ["h1", "h2"], IDENTITY_A)).toEqual(["h1", "h2"]);

      const result = upsertUnitVectors(db, [
        { hash: "h1", identity: IDENTITY_A, vector: vector(0) },
        { hash: "h2", identity: IDENTITY_A, vector: vector(10) },
      ]);
      expect(result.inserted).toBe(2);

      expect(listMissingHashes(db, ["h1", "h2", "h3"], IDENTITY_A)).toEqual(["h3"]);
      // A different identity has not seen these hashes at all.
      expect(listMissingHashes(db, ["h1"], IDENTITY_B)).toEqual(["h1"]);
    });
  });

  test("listMissingHashes dedupes and preserves first-occurrence order", () => {
    withTempDb((db) => {
      upsertUnitVectors(db, [{ hash: "h1", identity: IDENTITY_A, vector: vector(0) }]);
      expect(listMissingHashes(db, ["h2", "h1", "h3", "h2"], IDENTITY_A)).toEqual(["h2", "h3"]);
    });
  });

  test("listMissingHashes chunks the IN clause beyond SQLITE_CHUNK_SIZE", () => {
    withTempDb((db) => {
      const hashes = Array.from({ length: 520 }, (_, i) => `h${i}`);
      // Only the first is actually stored; the rest must still come back
      // missing even though the lookup spans more than one chunk.
      upsertUnitVectors(db, [{ hash: "h0", identity: IDENTITY_A, vector: vector(0) }]);
      const missing = listMissingHashes(db, hashes, IDENTITY_A);
      expect(missing.length).toBe(519);
      expect(missing).not.toContain("h0");
    });
  });

  test("upsertUnitVectors is idempotent: re-upserting an existing hash does not grow `inserted`", () => {
    withTempDb((db) => {
      const first = upsertUnitVectors(db, [{ hash: "h1", identity: IDENTITY_A, vector: vector(0) }]);
      expect(first.inserted).toBe(1);
      const second = upsertUnitVectors(db, [{ hash: "h1", identity: IDENTITY_A, vector: vector(0) }]);
      expect(second.inserted).toBe(0);
      const count = db
        .prepare("SELECT COUNT(*) AS n FROM units WHERE unit_hash = ? AND identity = ?")
        .get("h1", IDENTITY_A) as { n: number };
      expect(count.n).toBe(1);
    });
  });

  test("upsertUnitVectors keys by (hash, identity): the same hash under two identities is two units rows", () => {
    withTempDb((db) => {
      upsertUnitVectors(db, [
        { hash: "shared", identity: IDENTITY_A, vector: vector(0) },
        { hash: "shared", identity: IDENTITY_B, vector: vector(100) },
      ]);
      const count = db.prepare("SELECT COUNT(*) AS n FROM units WHERE unit_hash = ?").get("shared") as { n: number };
      expect(count.n).toBe(2);
    });
  });

  test("upsertUnitVectors is a no-op when sqlite-vec is unavailable (no BLOB fallback for units)", () => {
    withTempDb((db) => {
      const unavailable = {} as unknown as Database;
      const result = upsertUnitVectors(unavailable, [{ hash: "h1", identity: IDENTITY_A, vector: vector(0) }]);
      expect(result).toEqual({ inserted: 0, failed: 0 });
    });
  });

  test("upsertUnitVectors: one wrong-width vector in a batch does not roll back its good siblings", () => {
    withTempDb((db) => {
      // units_vec was created at DIM=4; a 6-wide vector is a genuine vec0
      // insert failure ("Dimension mismatch"), mid-batch, alongside two
      // good rows — the exact shape of a provider bug that returns the
      // wrong width for one document in an otherwise-fine response.
      const result = upsertUnitVectors(db, [
        { hash: "good1", identity: IDENTITY_A, vector: vector(0) },
        { hash: "bad", identity: IDENTITY_A, vector: [1, 2, 3, 4, 5, 6] },
        { hash: "good2", identity: IDENTITY_A, vector: vector(10) },
      ]);
      expect(result.inserted).toBe(2);
      expect(result.failed).toBe(1);

      // Both good rows are durably present and searchable...
      expect(listMissingHashes(db, ["good1", "good2"], IDENTITY_A)).toEqual([]);
      // ...while the bad row was left out of `units` entirely (not stranded
      // there with no vector behind it), so the next drain retries it
      // instead of treating it as permanently satisfied.
      expect(listMissingHashes(db, ["bad"], IDENTITY_A)).toEqual(["bad"]);
      const badCount = db.prepare("SELECT COUNT(*) AS n FROM units WHERE unit_hash = 'bad'").get() as { n: number };
      expect(badCount.n).toBe(0);
    });
  });

  test("replaceEntryUnits replaces the full ordinal set for an entry", () => {
    withTempDb((db) => {
      const entryId = insertEntry(db, "stash//memories/a");
      replaceEntryUnits(db, entryId, [
        { ordinal: 0, fragmentId: null, hash: "h0" },
        { ordinal: 1, fragmentId: "frag-1", hash: "h1" },
      ]);
      let rows = db
        .prepare(
          "SELECT ordinal, fragment_id AS fragmentId, unit_hash AS hash FROM entry_units WHERE entry_id = ? ORDER BY ordinal",
        )
        .all(entryId);
      expect(rows).toEqual([
        { ordinal: 0, fragmentId: null, hash: "h0" },
        { ordinal: 1, fragmentId: "frag-1", hash: "h1" },
      ]);

      // A second, shorter call drops the stale ordinal-1 row.
      replaceEntryUnits(db, entryId, [{ ordinal: 0, fragmentId: null, hash: "h0-v2" }]);
      rows = db
        .prepare("SELECT ordinal, fragment_id AS fragmentId, unit_hash AS hash FROM entry_units WHERE entry_id = ?")
        .all(entryId);
      expect(rows).toEqual([{ ordinal: 0, fragmentId: null, hash: "h0-v2" }]);
    });
  });

  test("deleteEntryUnits removes rows for the given entries only", () => {
    withTempDb((db) => {
      const a = insertEntry(db, "stash//memories/a");
      const b = insertEntry(db, "stash//memories/b");
      replaceEntryUnits(db, a, [{ ordinal: 0, fragmentId: null, hash: "ha" }]);
      replaceEntryUnits(db, b, [{ ordinal: 0, fragmentId: null, hash: "hb" }]);

      deleteEntryUnits(db, [a]);

      expect(db.prepare("SELECT COUNT(*) AS n FROM entry_units WHERE entry_id = ?").get(a)).toEqual({ n: 0 });
      expect(db.prepare("SELECT COUNT(*) AS n FROM entry_units WHERE entry_id = ?").get(b)).toEqual({ n: 1 });
    });
  });

  test("deleteEntryUnits chunks beyond SQLITE_CHUNK_SIZE", () => {
    withTempDb((db) => {
      const ids: number[] = [];
      for (let i = 0; i < 520; i++) {
        const id = insertEntry(db, `stash//memories/bulk-${i}`);
        replaceEntryUnits(db, id, [{ ordinal: 0, fragmentId: null, hash: `h${i}` }]);
        ids.push(id);
      }
      deleteEntryUnits(db, ids);
      expect(db.prepare("SELECT COUNT(*) AS n FROM entry_units").get()).toEqual({ n: 0 });
    });
  });

  test("searchUnits returns nearest units first, scoped by identity", () => {
    withTempDb((db) => {
      upsertUnitVectors(db, [
        { hash: "near", identity: IDENTITY_A, vector: [1, 0, 0, 0] },
        { hash: "far", identity: IDENTITY_A, vector: [0, 0, 0, 1] },
        { hash: "other-identity", identity: IDENTITY_B, vector: [1, 0, 0, 0] },
      ]);
      const hits = searchUnits(db, [1, 0, 0, 0], 2, IDENTITY_A);
      expect(hits.map((h) => h.hash)).toEqual(["near", "far"]);
      expect(hits[0]?.distance).toBeLessThan(hits[1]?.distance ?? Number.POSITIVE_INFINITY);
      expect(hits.every((h) => h.hash !== "other-identity")).toBe(true);
    });
  });

  test("searchUnits returns [] for k <= 0 without querying", () => {
    withTempDb((db) => {
      upsertUnitVectors(db, [{ hash: "h1", identity: IDENTITY_A, vector: vector(0) }]);
      expect(searchUnits(db, vector(0), 0, IDENTITY_A)).toEqual([]);
    });
  });

  test("searchUnits throws a ConfigError when sqlite-vec is unavailable", () => {
    withTempDb(() => {
      const unavailable = {} as unknown as Database;
      expect(() => searchUnits(unavailable, [1, 0, 0, 0], 3, IDENTITY_A)).toThrow(ConfigError);
      expect(() => searchUnits(unavailable, [1, 0, 0, 0], 3, IDENTITY_A)).toThrow(/sqlite-vec/);
    });
  });

  test("groupUnitHitsByEntry keeps the best (lowest distance) unit per entry", () => {
    withTempDb((db) => {
      const entryId = insertEntry(db, "stash//memories/multi");
      replaceEntryUnits(db, entryId, [
        { ordinal: 0, fragmentId: null, hash: "unit-0" },
        { ordinal: 1, fragmentId: "frag-1", hash: "unit-1" },
      ]);
      const other = insertEntry(db, "stash//memories/other");
      replaceEntryUnits(db, other, [{ ordinal: 0, fragmentId: null, hash: "unit-2" }]);

      const hits = [
        { unitId: 1, hash: "unit-0", distance: 0.9 },
        { unitId: 2, hash: "unit-1", distance: 0.1 },
        { unitId: 3, hash: "unit-2", distance: 0.5 },
      ];
      const grouped = groupUnitHitsByEntry(db, hits);
      expect(grouped.get(entryId)).toEqual({ distance: 0.1, fragmentId: "frag-1", hash: "unit-1" });
      expect(grouped.get(other)).toEqual({ distance: 0.5, fragmentId: null, hash: "unit-2" });
      expect(grouped.size).toBe(2);
    });
  });

  test("groupUnitHitsByEntry ignores hits with no entry_units row and returns an empty map for no hits", () => {
    withTempDb((db) => {
      expect(groupUnitHitsByEntry(db, []).size).toBe(0);
      const grouped = groupUnitHitsByEntry(db, [{ unitId: 1, hash: "orphan", distance: 0.2 }]);
      expect(grouped.size).toBe(0);
    });
  });

  describe("getNeighborsByEntryId", () => {
    test("returns the k nearest OTHER entries by card-unit distance, via a units rowid lookup", () => {
      withTempDb((db) => {
        setMeta(db, "embeddingIdentity", IDENTITY_A);
        const near = insertEntry(db, "stash//memories/near");
        replaceEntryUnits(db, near, [{ ordinal: 0, fragmentId: null, hash: "near-card" }]);
        const far = insertEntry(db, "stash//memories/far");
        replaceEntryUnits(db, far, [{ ordinal: 0, fragmentId: null, hash: "far-card" }]);
        const query = insertEntry(db, "stash//memories/query");
        replaceEntryUnits(db, query, [{ ordinal: 0, fragmentId: null, hash: "query-card" }]);
        upsertUnitVectors(db, [
          { hash: "query-card", identity: IDENTITY_A, vector: [1, 0, 0, 0] },
          { hash: "near-card", identity: IDENTITY_A, vector: [1, 0, 0, 0] },
          { hash: "far-card", identity: IDENTITY_A, vector: [0, 0, 0, 1] },
        ]);

        const neighbors = getNeighborsByEntryId(db, query, 2);

        expect(neighbors.map((n) => n.id)).toEqual([near, far]);
        expect(neighbors[0]?.distance).toBeLessThan(neighbors[1]?.distance ?? Number.POSITIVE_INFINITY);
      });
    });

    test("returns [] for k <= 0, no active identity, or a query entry with no vector", () => {
      withTempDb((db) => {
        const entryId = insertEntry(db, "stash//memories/lonely");
        replaceEntryUnits(db, entryId, [{ ordinal: 0, fragmentId: null, hash: "lonely-card" }]);

        // No embeddingIdentity meta set yet.
        expect(getNeighborsByEntryId(db, entryId, 5)).toEqual([]);

        setMeta(db, "embeddingIdentity", IDENTITY_A);
        // k <= 0 short-circuits before any lookup.
        expect(getNeighborsByEntryId(db, entryId, 0)).toEqual([]);
        // Card unit has no vector for the active identity yet (drain hasn't reached it).
        expect(getNeighborsByEntryId(db, entryId, 5)).toEqual([]);
      });
    });
  });

  test("unitCoverage reports entries, coverage, and unit counts for an identity", () => {
    withTempDb((db) => {
      const full = insertEntry(db, "stash//memories/full");
      replaceEntryUnits(db, full, [
        { ordinal: 0, fragmentId: null, hash: "f0" },
        { ordinal: 1, fragmentId: "frag", hash: "f1" },
      ]);
      const partial = insertEntry(db, "stash//memories/partial");
      replaceEntryUnits(db, partial, [
        { ordinal: 0, fragmentId: null, hash: "p0" },
        { ordinal: 1, fragmentId: "frag", hash: "p1" },
      ]);

      upsertUnitVectors(db, [
        { hash: "f0", identity: IDENTITY_A, vector: vector(0) },
        { hash: "f1", identity: IDENTITY_A, vector: vector(1) },
        { hash: "p0", identity: IDENTITY_A, vector: vector(2) },
        // p1 intentionally missing — `partial` stays uncovered.
      ]);

      expect(unitCoverage(db, IDENTITY_A)).toEqual({
        entries: 2,
        entriesFullyCovered: 1,
        unitsTotal: 4,
        unitsPresent: 3,
      });
      expect(unitCoverage(db, IDENTITY_B)).toEqual({
        entries: 2,
        entriesFullyCovered: 0,
        unitsTotal: 4,
        unitsPresent: 0,
      });
    });
  });

  describe("dropOtherIdentities", () => {
    test("same width: deletes only rows for other identities", () => {
      withTempDb((db) => {
        upsertUnitVectors(db, [
          { hash: "a1", identity: IDENTITY_A, vector: vector(0) },
          { hash: "b1", identity: IDENTITY_B, vector: vector(1) },
        ]);

        const result = dropOtherIdentities(db, IDENTITY_A, DIM);
        expect(result.removed).toBe(1);
        expect(db.prepare("SELECT COUNT(*) AS n FROM units").get()).toEqual({ n: 1 });
        expect(db.prepare("SELECT identity FROM units").get()).toEqual({ identity: IDENTITY_A });
        expect(db.prepare("SELECT COUNT(*) AS n FROM units_vec").get()).toEqual({ n: 1 });
        // The kept identity's vector is still searchable afterward.
        const hits = searchUnits(db, vector(0), 1, IDENTITY_A);
        expect(hits.map((h) => h.hash)).toEqual(["a1"]);
      });
    });

    test("is a no-op when only the kept identity is present", () => {
      withTempDb((db) => {
        upsertUnitVectors(db, [{ hash: "a1", identity: IDENTITY_A, vector: vector(0) }]);
        const result = dropOtherIdentities(db, IDENTITY_A, DIM);
        expect(result.removed).toBe(0);
        expect(db.prepare("SELECT COUNT(*) AS n FROM units").get()).toEqual({ n: 1 });
      });
    });

    test("different width: recreates units_vec at the new dimension", () => {
      withTempDb((db) => {
        upsertUnitVectors(db, [{ hash: "a1", identity: IDENTITY_A, vector: vector(0) }]);

        const newDim = 6;
        const result = dropOtherIdentities(db, IDENTITY_B, newDim);
        expect(result.removed).toBe(1);
        expect(db.prepare("SELECT COUNT(*) AS n FROM units").get()).toEqual({ n: 0 });

        // The recreated table actually accepts vectors of the new width now.
        const inserted = upsertUnitVectors(db, [{ hash: "b1", identity: IDENTITY_B, vector: [1, 2, 3, 4, 5, 6] }]);
        expect(inserted.inserted).toBe(1);
        const hits = searchUnits(db, [1, 2, 3, 4, 5, 6], 1, IDENTITY_B);
        expect(hits.map((h) => h.hash)).toEqual(["b1"]);
      });
    });

    test("is a no-op when sqlite-vec is unavailable", () => {
      withTempDb(() => {
        const unavailable = {} as unknown as Database;
        expect(dropOtherIdentities(unavailable, IDENTITY_A, DIM)).toEqual({ removed: 0 });
      });
    });
  });

  describe("lifecycle: units/units_vec survive destructive index operations", () => {
    test("ensureSchema wires ensureUnitTables so units/entry_units/units_vec exist on a fresh index", () => {
      withTempDb((db) => {
        const names = (
          db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
        ).map((row) => row.name);
        expect(names).toContain("units");
        expect(names).toContain("entry_units");
        expect(names).toContain("units_vec");
      });
    });

    test("rebuildIncompatibleIndexGeneration (an older stamped generation) leaves units/units_vec intact", () => {
      withTempDb((db, dbPath) => {
        upsertUnitVectors(db, [{ hash: "keep-me", identity: IDENTITY_A, vector: vector(0) }]);
        db.close();

        // Re-open and force a generation rebuild by stamping an older version
        // with the pre-v21 transitional entries shape, mirroring
        // tests/integration/indexer/canonical-entry-schema.test.ts's "opening
        // a pre-current index rebuilds its derived entry generation".
        const reopened = openDatabase(dbPath);
        loadVecExtension(reopened);
        const stored = reopened.prepare("SELECT value FROM index_meta WHERE key = 'version'").get() as {
          value: string;
        };
        const olderVersion = String(Number(stored.value) - 1);
        reopened.prepare("UPDATE index_meta SET value = ? WHERE key = 'version'").run(olderVersion);
        reopened.exec("DROP TABLE entries");
        reopened.exec(`
          CREATE TABLE entries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            entry_key TEXT NOT NULL UNIQUE,
            dir_path TEXT NOT NULL,
            file_path TEXT NOT NULL,
            stash_dir TEXT NOT NULL,
            entry_json TEXT NOT NULL,
            search_text TEXT NOT NULL,
            entry_type TEXT NOT NULL
          );
        `);

        ensureSchema(reopened, DIM);

        expect(reopened.prepare("SELECT value FROM index_meta WHERE key = 'version'").get()).not.toEqual({
          value: olderVersion,
        });
        expect(reopened.prepare("SELECT COUNT(*) AS n FROM units WHERE unit_hash = 'keep-me'").get()).toEqual({
          n: 1,
        });
        const hits = searchUnits(reopened, vector(0), 1, IDENTITY_A);
        expect(hits.map((h) => h.hash)).toEqual(["keep-me"]);
        reopened.close();
      });
    });

    test("the --full drop path (deleteAllEntries) leaves units/units_vec intact", () => {
      withTempDb((db) => {
        upsertUnitVectors(db, [{ hash: "keep-me", identity: IDENTITY_A, vector: vector(0) }]);
        const entryId = insertEntry(db, "stash//memories/full-wipe");
        replaceEntryUnits(db, entryId, [{ ordinal: 0, fragmentId: null, hash: "keep-me" }]);

        // deleteAllEntries is the primitive persistDirRecords' full-rebuild
        // wipe uses (src/indexer/indexer.ts, the `akm index --full` path).
        // foreign_keys is only ever ON via the managed connection in
        // production (sqlite-pragmas.ts); this raw test connection enables it
        // explicitly to exercise entry_units' ON DELETE CASCADE the same way.
        db.exec("PRAGMA foreign_keys = ON");
        deleteAllEntries(db);

        expect(db.prepare("SELECT COUNT(*) AS n FROM entries").get()).toEqual({ n: 0 });
        // entry_units (derived, entry_id-keyed) cascades away with its entry...
        expect(db.prepare("SELECT COUNT(*) AS n FROM entry_units").get()).toEqual({ n: 0 });
        // ...but the durable, content-addressed vector store does not.
        expect(db.prepare("SELECT COUNT(*) AS n FROM units WHERE unit_hash = 'keep-me'").get()).toEqual({ n: 1 });
        const hits = searchUnits(db, vector(0), 1, IDENTITY_A);
        expect(hits.map((h) => h.hash)).toEqual(["keep-me"]);
      });
    });

    test("purgeEmbeddings (the entries_vec / embeddings purge) does not touch units/units_vec", () => {
      withTempDb((db) => {
        upsertUnitVectors(db, [{ hash: "keep-me", identity: IDENTITY_A, vector: vector(0) }]);
        purgeEmbeddings(db, { dropVecTable: true });
        expect(db.prepare("SELECT COUNT(*) AS n FROM units WHERE unit_hash = 'keep-me'").get()).toEqual({ n: 1 });
        const hits = searchUnits(db, vector(0), 1, IDENTITY_A);
        expect(hits.map((h) => h.hash)).toEqual(["keep-me"]);
      });
    });
  });
});
