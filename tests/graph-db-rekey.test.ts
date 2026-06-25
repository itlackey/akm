// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * RED tests for #624-P1 — re-key the graph tables on
 * (stash_root, file_path, body_hash) and drop the entries.id dependency.
 *
 * THE HEADLINE WIN (AC#2): graph data must SURVIVE an entries delete +
 * reinsert (a reindex) as long as the file's body_hash is unchanged. Under
 * the current schema the graph_files PK is entry_id REFERENCES entries(id)
 * ON DELETE CASCADE, so deleting the entries row wipes the graph rows — this
 * test proves the new self-keyed shape keeps them.
 *
 * These tests are written to FAIL against the current (schema v3 / DB v17)
 * code for the RIGHT reason: the feature (composite key, hasGraphData,
 * re-keyed getEntitiesByEntryIds, survival on reindex) is not implemented yet.
 *
 * Isolation: no host state. A temp .db file per test; XDG sandboxed so any
 * config read inside openDatabase cannot touch the developer's real config.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import path from "node:path";

import {
  closeDatabase,
  DB_VERSION,
  deleteEntriesByIds,
  GRAPH_SCHEMA_VERSION,
  getEntitiesByEntryIds,
  getEntryIdByFilePath,
  getMeta,
  openDatabase,
  upsertEntry,
} from "../src/indexer/db/db";
import * as graphDb from "../src/indexer/db/graph-db";
import { loadStoredGraphSnapshot, replaceStoredGraph } from "../src/indexer/db/graph-db";

// hasGraphData is a NEW P1 deliverable. It is not exported yet, so a static
// `import { hasGraphData }` would throw at module load and abort the whole
// file before any AC can demonstrate its own RED reason. Reference it via the
// namespace so resolution is deferred to call time: today it is `undefined`
// (the AC#2 invocation throws "not a function" — RED for the right reason),
// and once P1 lands it resolves to the real export.
const hasGraphData = (graphDb as { hasGraphData?: (db: Database, stashRoot: string, filePath: string) => boolean })
  .hasGraphData as (db: Database, stashRoot: string, filePath: string) => boolean;

import type { GraphFile, GraphFileNode } from "../src/indexer/graph/graph-extraction";
import { buildSearchText } from "../src/indexer/search/search-fields";
import type { Database } from "../src/storage/database";
import { makeSandboxDir, withIsolatedAkmStorage } from "./_helpers/sandbox";

// ── Temp / env management ───────────────────────────────────────────────────
//
// All host state is sandboxed: withIsolatedAkmStorage() redirects every AKM/XDG
// env var at a per-test temp root (so openDatabase's config read can never touch
// real user data), and makeSandboxDir() mints disposable dirs for the .db files.
// Both register their cleanups, drained in afterEach.

const cleanups: Array<() => void> = [];

function tmpDbPath(): string {
  const { dir, cleanup } = makeSandboxDir("akm-rekey-db");
  cleanups.push(cleanup);
  return path.join(dir, "test.db");
}

beforeEach(() => {
  const storage = withIsolatedAkmStorage();
  cleanups.push(storage.cleanup);
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

// ── Seeding helpers ─────────────────────────────────────────────────────────

const STASH = "/tmp/akm-rekey-stash";

/** Insert a minimal entries row for a file so it is not treated as an orphan. */
function seedEntry(db: Database, filePath: string, name: string, type = "memory"): number {
  const entry = { name, type, filename: path.basename(filePath) };
  return upsertEntry(
    db,
    `${STASH}:${type}:${name}`,
    path.dirname(filePath),
    filePath,
    STASH,
    entry as Parameters<typeof upsertEntry>[5],
    buildSearchText(entry as Parameters<typeof buildSearchText>[0]),
  );
}

function fileNode(
  filePath: string,
  bodyHash: string,
  entities: string[],
  relations: GraphFileNode["relations"] = [],
): GraphFileNode {
  return {
    path: filePath,
    type: "memory",
    bodyHash,
    entities,
    relations,
  };
}

function graphFor(files: GraphFileNode[]): GraphFile {
  return {
    schemaVersion: GRAPH_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    stashRoot: STASH,
    files,
  };
}

function tableInfoColumns(db: Database, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info('${table}')`).all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

// ─────────────────────────────────────────────────────────────────────────────

describe("#624-P1 graph re-key on (stash_root, file_path, body_hash)", () => {
  // AC#1 — schema shape ------------------------------------------------------
  test("AC#1: graph tables drop entry_id and adopt the composite key", () => {
    const db = openDatabase(tmpDbPath());
    try {
      // entry_id must be ABSENT from all three graph tables.
      expect(tableInfoColumns(db, "graph_files")).not.toContain("entry_id");
      expect(tableInfoColumns(db, "graph_file_entities")).not.toContain("entry_id");
      expect(tableInfoColumns(db, "graph_file_relations")).not.toContain("entry_id");

      // graph_files PK columns are exactly (stash_root, file_path, body_hash).
      const pkCols = (db.prepare(`PRAGMA table_info('graph_files')`).all() as Array<{ name: string; pk: number }>)
        .filter((r) => r.pk > 0)
        .sort((a, b) => a.pk - b.pk)
        .map((r) => r.name);
      expect(pkCols).toEqual(["stash_root", "file_path", "body_hash"]);

      // child tables carry file_path + body_hash.
      for (const child of ["graph_file_entities", "graph_file_relations"]) {
        expect(tableInfoColumns(db, child)).toContain("file_path");
        expect(tableInfoColumns(db, child)).toContain("body_hash");
      }

      // A UNIQUE index on (stash_root, file_path) enforces one row per path.
      const indexList = db.prepare(`PRAGMA index_list('graph_files')`).all() as Array<{
        name: string;
        unique: number;
      }>;
      const pathIdx = indexList.find((i) => i.name === "idx_graph_files_path");
      expect(pathIdx, "expected unique index idx_graph_files_path").toBeDefined();
      expect(pathIdx?.unique).toBe(1);
      const pathIdxCols = (
        db.prepare(`PRAGMA index_info('idx_graph_files_path')`).all() as Array<{ name: string }>
      ).map((r) => r.name);
      expect(pathIdxCols).toEqual(["stash_root", "file_path"]);

      // Composite FK on child tables -> graph_files with CASCADE delete.
      for (const child of ["graph_file_entities", "graph_file_relations"]) {
        const fks = db.prepare(`PRAGMA foreign_key_list('${child}')`).all() as Array<{
          table: string;
          from: string;
          to: string;
          on_delete: string;
        }>;
        const toGraphFiles = fks.filter((f) => f.table === "graph_files");
        const fromCols = toGraphFiles.map((f) => f.from).sort();
        expect(fromCols, `${child} must FK on the composite key`).toEqual(["body_hash", "file_path", "stash_root"]);
        expect(toGraphFiles.every((f) => f.on_delete.toUpperCase() === "CASCADE")).toBe(true);
      }
    } finally {
      closeDatabase(db);
    }
  });

  // AC#1 — one row per path --------------------------------------------------
  test("AC#1: two body_hashes for one path collide on the unique path index", () => {
    const db = openDatabase(tmpDbPath());
    try {
      const file = path.join(STASH, "a.md");
      seedEntry(db, file, "a");
      replaceStoredGraph(db, graphFor([fileNode(file, "hashA", ["alpha"])]));

      // A raw second insert with a DIFFERENT body_hash for the same path must
      // violate the UNIQUE(stash_root, file_path) index — proving one row per
      // path even though body_hash differs in the PK.
      expect(() =>
        db
          .prepare(
            `INSERT INTO graph_files (stash_root, file_path, file_order, file_type, body_hash, status)
             VALUES (?, ?, ?, ?, ?, 'extracted')`,
          )
          .run(STASH, file, 0, "memory", "hashB"),
      ).toThrow();
    } finally {
      closeDatabase(db);
    }
  });

  // AC#2 — THE CORE P1 WIN ---------------------------------------------------
  test("AC#2: graph data survives an entries delete + reinsert (reindex)", () => {
    const db = openDatabase(tmpDbPath());
    try {
      const file = path.join(STASH, "survivor.md");
      seedEntry(db, file, "survivor");
      replaceStoredGraph(
        db,
        graphFor([
          fileNode(
            file,
            "stablehash",
            ["entity-one", "entity-two"],
            [{ from: "entity-one", to: "entity-two", type: "relates" }],
          ),
        ]),
      );

      const before = loadStoredGraphSnapshot(STASH, db);
      expect(before?.entities).toContain("entity-one");
      expect(before?.relations.length).toBe(1);

      // Simulate a reindex: delete the entries row, then re-insert a NEW
      // entries row for the SAME path with a DIFFERENT id. The graph tables
      // are NOT touched here.
      const oldId = getEntryIdByFilePath(db, file);
      expect(oldId).toBeDefined();
      deleteEntriesByIds(db, [oldId as number]);
      const newId = seedEntry(db, file, "survivor");
      expect(newId).not.toBe(oldId);

      // THE WIN: graph data is still present.
      const after = loadStoredGraphSnapshot(STASH, db);
      expect(after?.entities).toContain("entity-one");
      expect(after?.entities).toContain("entity-two");
      expect(after?.relations.length).toBe(1);

      // hasGraphData (new P1 helper) reports true post-reindex.
      expect(hasGraphData(db, STASH, file)).toBe(true);
    } finally {
      closeDatabase(db);
    }
  });

  // AC#3 — unchanged hash reused, changed hash re-extracts -------------------
  test("AC#3: same body_hash reuses the row; a new body_hash replaces children", () => {
    const db = openDatabase(tmpDbPath());
    try {
      const file = path.join(STASH, "churn.md");
      seedEntry(db, file, "churn");

      replaceStoredGraph(db, graphFor([fileNode(file, "h1", ["one", "two"])]));
      const firstRunId = (
        db.prepare(`SELECT extraction_run_id FROM graph_files WHERE stash_root=? AND file_path=?`).get(STASH, file) as
          | { extraction_run_id: string | null }
          | undefined
      )?.extraction_run_id;

      // Same body_hash again — no child-row churn: still exactly one graph_files
      // row and the same entity set.
      replaceStoredGraph(db, graphFor([fileNode(file, "h1", ["one", "two"])]));
      const fileRowCount = (
        db.prepare(`SELECT COUNT(*) AS c FROM graph_files WHERE stash_root=? AND file_path=?`).get(STASH, file) as {
          c: number;
        }
      ).c;
      expect(fileRowCount).toBe(1);
      const reused = loadStoredGraphSnapshot(STASH, db);
      expect(reused?.entities.sort()).toEqual(["one", "two"]);
      void firstRunId;

      // Different body_hash — old children gone, new ones inserted, single
      // surviving graph_files row carries the NEW hash.
      replaceStoredGraph(db, graphFor([fileNode(file, "h2", ["three"])]));
      const rows = db
        .prepare(`SELECT body_hash FROM graph_files WHERE stash_root=? AND file_path=?`)
        .all(STASH, file) as Array<{ body_hash: string }>;
      expect(rows.length).toBe(1);
      expect(rows[0]?.body_hash).toBe("h2");
      const reextracted = loadStoredGraphSnapshot(STASH, db);
      expect(reextracted?.entities).toEqual(["three"]);
      expect(reextracted?.entities).not.toContain("one");
    } finally {
      closeDatabase(db);
    }
  });

  // AC#4 — graph_meta counts stay consistent after an entries delete ---------
  test("AC#4: deleting entries preserves graph rows and keeps graph_meta counts live", () => {
    const db = openDatabase(tmpDbPath());
    try {
      const file = path.join(STASH, "meta.md");
      seedEntry(db, file, "meta");
      replaceStoredGraph(db, graphFor([fileNode(file, "mhash", ["a", "b"], [{ from: "a", to: "b" }])]));

      const id = getEntryIdByFilePath(db, file) as number;
      deleteEntriesByIds(db, [id]);

      // graph_files rows must NOT have been cascade-wiped by the entries delete.
      const liveFiles = (
        db.prepare(`SELECT COUNT(*) AS c FROM graph_files WHERE stash_root=?`).get(STASH) as { c: number }
      ).c;
      const liveEntities = (
        db.prepare(`SELECT COUNT(*) AS c FROM graph_file_entities WHERE stash_root=?`).get(STASH) as { c: number }
      ).c;
      const liveRelations = (
        db
          .prepare(
            `SELECT COUNT(*) AS c FROM graph_file_relations gfr
             JOIN graph_files gf ON gf.stash_root=gfr.stash_root AND gf.file_path=gfr.file_path AND gf.body_hash=gfr.body_hash
             WHERE gf.stash_root=?`,
          )
          .get(STASH) as { c: number }
      ).c;
      expect(liveFiles).toBe(1);
      expect(liveEntities).toBe(2);
      expect(liveRelations).toBe(1);

      // graph_meta counts must match the live child-row counts (no stale counts).
      const meta = db
        .prepare(`SELECT extracted_files, entity_count, relation_count FROM graph_meta WHERE stash_root=?`)
        .get(STASH) as { extracted_files: number; entity_count: number; relation_count: number } | undefined;
      expect(meta?.extracted_files).toBe(liveFiles);
      expect(meta?.entity_count).toBe(liveEntities);
      expect(meta?.relation_count).toBe(liveRelations);
    } finally {
      closeDatabase(db);
    }
  });

  // AC#5 — version + graph-schema lock --------------------------------------
  // The graph re-key is migrated via a TARGETED graph-only path, NOT a DB_VERSION
  // bump. index.db has no nuclear drop-and-rebuild path (a DB_VERSION mismatch is
  // a forensic stamp only now), so DB_VERSION must stay 17; GRAPH_SCHEMA_VERSION 4
  // marks the new graph shape.
  test("AC#5: DB_VERSION stays 17 (no nuclear bump), GRAPH_SCHEMA_VERSION is 4, graph DDL is the new shape", () => {
    expect(DB_VERSION).toBe(17);
    expect(GRAPH_SCHEMA_VERSION).toBe(4);

    const db = openDatabase(tmpDbPath());
    try {
      expect(getMeta(db, "version")).toBe(String(17));

      // Lock the three graph table DDLs to the new (composite-key) shape.
      const ddl = (
        db
          .prepare(
            `SELECT name, sql FROM sqlite_master
             WHERE type='table' AND name IN ('graph_files','graph_file_entities','graph_file_relations')
             ORDER BY name`,
          )
          .all() as Array<{ name: string; sql: string }>
      ).map((r) => r.sql.replace(/\s+/g, " ").trim());

      const joined = ddl.join("\n");
      expect(joined).not.toMatch(/entry_id/);
      expect(joined).toMatch(/PRIMARY KEY \(stash_root, file_path, body_hash\)/);
      expect(joined).toMatch(/REFERENCES graph_files\(stash_root, file_path, body_hash\)/);
      expect(joined).toMatch(/ON DELETE CASCADE/);
    } finally {
      closeDatabase(db);
    }
  });

  // AC#6 — THE SAFETY GUARANTEE: upgrading a legacy (entry_id-keyed) DB must
  // (a) PRESERVE entries + embeddings (index.db has no nuclear drop, so a schema
  // change never wipes them), AND (b) MIGRATE
  // the existing graph data into the new tables rather than dropping it (graph
  // re-extraction is ~19s/file of LLM work). This locks the targeted, data-
  // preserving graph-only migration.
  test("AC#6: legacy entry_id graph schema migrates data + preserves entries/embeddings", () => {
    const dbPath = tmpDbPath();
    let db = openDatabase(dbPath);
    try {
      // Seed real index content that must survive: an entry + its embedding.
      const file = path.join(STASH, "keepme.md");
      const entryId = seedEntry(db, file, "keepme");
      db.prepare("INSERT OR REPLACE INTO embeddings (id, embedding) VALUES (?, ?)").run(
        entryId,
        new Uint8Array([1, 2, 3, 4]),
      );

      // Downgrade the graph tables to the LEGACY entry_id-keyed shape to simulate
      // an existing pre-#624 database, and seed real graph data (file + entities +
      // a relation) that must be MIGRATED, not lost.
      db.exec("DROP TABLE IF EXISTS graph_file_relations");
      db.exec("DROP TABLE IF EXISTS graph_file_entities");
      db.exec("DROP TABLE IF EXISTS graph_files");
      db.exec(`
        CREATE TABLE graph_files (
          entry_id          INTEGER PRIMARY KEY REFERENCES entries(id) ON DELETE CASCADE,
          stash_root        TEXT NOT NULL,
          file_path         TEXT NOT NULL,
          file_order        INTEGER NOT NULL,
          file_type         TEXT NOT NULL,
          body_hash         TEXT NOT NULL,
          confidence        REAL,
          status            TEXT NOT NULL DEFAULT 'extracted',
          reason            TEXT,
          extraction_run_id TEXT,
          UNIQUE(stash_root, file_path)
        );
        CREATE TABLE graph_file_entities (
          entry_id     INTEGER NOT NULL,
          entity_order INTEGER NOT NULL,
          stash_root   TEXT NOT NULL,
          entity_norm  TEXT NOT NULL,
          entity       TEXT NOT NULL,
          PRIMARY KEY (entry_id, entity_order)
        );
        CREATE TABLE graph_file_relations (
          entry_id       INTEGER NOT NULL,
          relation_order INTEGER NOT NULL,
          from_entity_norm TEXT NOT NULL,
          from_entity    TEXT NOT NULL,
          to_entity_norm TEXT NOT NULL,
          to_entity      TEXT NOT NULL,
          relation_type  TEXT,
          confidence     REAL,
          PRIMARY KEY (entry_id, relation_order)
        );
      `);
      db.prepare(
        "INSERT INTO graph_files (entry_id, stash_root, file_path, file_order, file_type, body_hash) VALUES (?, ?, ?, 0, 'memory', 'bh1')",
      ).run(entryId, STASH, file);
      db.prepare(
        "INSERT INTO graph_file_entities (entry_id, entity_order, stash_root, entity_norm, entity) VALUES (?, 0, ?, 'alpha', 'Alpha'), (?, 1, ?, 'beta', 'Beta')",
      ).run(entryId, STASH, entryId, STASH);
      db.prepare(
        "INSERT INTO graph_file_relations (entry_id, relation_order, from_entity_norm, from_entity, to_entity_norm, to_entity, relation_type) VALUES (?, 0, 'alpha', 'Alpha', 'beta', 'Beta', 'relates')",
      ).run(entryId);
      // graph_meta is unchanged by the re-key and is written alongside the data by
      // replaceStoredGraph in production; seed it so loadStoredGraphSnapshot (which
      // returns null without a meta row) reflects a realistic legacy DB.
      db.prepare(
        "INSERT OR REPLACE INTO graph_meta (stash_root, schema_version, generated_at, extracted_files, entity_count, relation_count) VALUES (?, 3, ?, 1, 2, 1)",
      ).run(STASH, new Date().toISOString());
      expect(tableInfoColumns(db, "graph_files")).toContain("entry_id");
      // Version is the SAME (17) — no nuclear upgrade path; the graph migration
      // fires on schema shape, independent of DB_VERSION.
      expect(getMeta(db, "version")).toBe(String(17));
      closeDatabase(db);

      // Reopen → ensureSchema → migrateGraphFilesSchema + migrateGraphDataFromLegacy.
      db = openDatabase(dbPath);

      // The graph table is now the NEW shape; legacy tables are gone.
      expect(tableInfoColumns(db, "graph_files")).not.toContain("entry_id");
      expect(tableInfoColumns(db, "graph_files")).toContain("body_hash");
      const legacyLeft = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'graph_%_legacy'")
        .all();
      expect(legacyLeft).toEqual([]);

      // GUARANTEE (a): entry + embedding UNTOUCHED (no re-embed).
      expect((db.prepare("SELECT COUNT(*) c FROM entries").get() as { c: number }).c).toBe(1);
      const embRow = db.prepare("SELECT embedding FROM embeddings WHERE id = ?").get(entryId) as
        | { embedding: Uint8Array }
        | undefined;
      expect(Array.from(embRow?.embedding ?? [])).toEqual([1, 2, 3, 4]);

      // GUARANTEE (b): graph DATA migrated into the new (composite-key) tables —
      // NOT dropped, NOT re-extracted.
      const snap = loadStoredGraphSnapshot(STASH, db);
      expect(snap?.entities.slice().sort()).toEqual(["Alpha", "Beta"]);
      expect(snap?.relations.length).toBe(1);
      expect(snap?.relations[0]?.from).toBe("Alpha");
      expect(snap?.relations[0]?.to).toBe("Beta");
      // hasGraphData reports true post-migration (no re-extraction needed).
      expect(hasGraphData(db, STASH, file)).toBe(true);
    } finally {
      closeDatabase(db);
    }
  });

  // Regression — getEntitiesByEntryIds keeps the entry_id -> entities contract.
  test("regression: getEntitiesByEntryIds returns entry_id->entities after re-key", () => {
    const db = openDatabase(tmpDbPath());
    try {
      const fileA = path.join(STASH, "ra.md");
      const fileB = path.join(STASH, "rb.md");
      const idA = seedEntry(db, fileA, "ra");
      const idB = seedEntry(db, fileB, "rb");

      replaceStoredGraph(db, graphFor([fileNode(fileA, "ha", ["Alpha", "Beta"]), fileNode(fileB, "hb", ["Gamma"])]));

      const map = getEntitiesByEntryIds(db, [idA, idB]);
      expect(map.get(idA)?.sort()).toEqual(["alpha", "beta"]);
      expect(map.get(idB)).toEqual(["gamma"]);
    } finally {
      closeDatabase(db);
    }
  });
});
