// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The one-time index.db migration from layout 23 (0.9.14–0.9.17: FTS5 tables
 * carrying their own copy of every indexed field, `embeddings` without a
 * per-row model) to layout 24 (contentless FTS over `entries` /
 * `entry_fragments`, `embeddings.model`).
 *
 * The fixture is built with the layout-23 DDL frozen from git history
 * (`index-entry-schema.ts` / `index-schema.ts` before this change), then opened
 * with the current code: read-only first (served as-is, no refusal), then
 * writable (migrated in place). Nothing derived from an LLM or an embedding
 * provider may be lost on the way.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import path from "node:path";
import { _setWarnSinkForTests } from "../../../src/core/warn";
import { type Database, openDatabase } from "../../../src/storage/database";
import {
  closeDatabase,
  openExistingDatabase,
  openIndexDatabase,
  openReadonlyExistingDatabase,
} from "../../../src/storage/repositories/index-connection";
import { CANONICAL_INDEX_DB_VERSION } from "../../../src/storage/repositories/index-entry-schema";
import { searchFts } from "../../../src/storage/repositories/index-fts-repository";
import { getMeta } from "../../../src/storage/repositories/index-meta-repository";
import { getEmbeddingCount, searchVec } from "../../../src/storage/repositories/index-vec-repository";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../_helpers/sandbox";

const LAYOUT_23_DDL = `
  CREATE TABLE index_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE entries (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    item_ref      TEXT NOT NULL UNIQUE,
    bundle_id     TEXT NOT NULL,
    component_id  TEXT NOT NULL,
    concept_id    TEXT NOT NULL,
    adapter_id    TEXT NOT NULL,
    type          TEXT NOT NULL,
    file_path     TEXT NOT NULL,
    content_hash  TEXT,
    document_json TEXT NOT NULL,
    search_text   TEXT NOT NULL,
    derived_from  TEXT
  );
  CREATE INDEX idx_entries_bundle ON entries(bundle_id);
  CREATE INDEX idx_entries_type ON entries(type);
  CREATE INDEX idx_entries_file_path ON entries(file_path);
  CREATE INDEX idx_entries_derived_from ON entries(derived_from);
  CREATE VIRTUAL TABLE entries_fts USING fts5(
    entry_id UNINDEXED, name, description, tags, hints, content, tokenize='porter unicode61'
  );
  CREATE TABLE entry_fragments (
    entry_id INTEGER PRIMARY KEY REFERENCES entries(id) ON DELETE CASCADE,
    safe_markdown TEXT NOT NULL
  );
  CREATE VIRTUAL TABLE entry_fragments_fts USING fts5(
    entry_id UNINDEXED, fragment_id UNINDEXED, fragment_ordinal UNINDEXED, content, tokenize='porter unicode61'
  );
  CREATE TABLE embeddings (id INTEGER PRIMARY KEY, embedding BLOB NOT NULL, FOREIGN KEY (id) REFERENCES entries(id));
  CREATE TABLE embedding_salvage (content_hash TEXT NOT NULL, fingerprint TEXT NOT NULL, embedding BLOB NOT NULL,
    salvaged_at TEXT NOT NULL, PRIMARY KEY (content_hash, fingerprint));
  CREATE TABLE utility_scores (
    entry_id INTEGER PRIMARY KEY, utility REAL NOT NULL DEFAULT 0, show_count INTEGER NOT NULL DEFAULT 0,
    search_count INTEGER NOT NULL DEFAULT 0, select_rate REAL NOT NULL DEFAULT 0, last_used_at TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')), FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE CASCADE
  );
  CREATE TABLE index_dir_state (
    dir_path TEXT PRIMARY KEY, file_set_hash TEXT NOT NULL, file_mtime_max_ms REAL NOT NULL, reason TEXT NOT NULL,
    updated_at TEXT NOT NULL, row_count INTEGER
  );
  CREATE TABLE llm_enrichment_cache (
    asset_ref TEXT NOT NULL, cache_variant TEXT NOT NULL, body_hash TEXT NOT NULL, result_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL, PRIMARY KEY (asset_ref, cache_variant)
  );
  CREATE TABLE graph_files (
    stash_root TEXT NOT NULL, file_path TEXT NOT NULL, file_order INTEGER NOT NULL, file_type TEXT NOT NULL,
    body_hash TEXT NOT NULL, confidence REAL, status TEXT NOT NULL DEFAULT 'extracted', reason TEXT,
    extraction_run_id TEXT, PRIMARY KEY (stash_root, file_path, body_hash)
  );
  CREATE TABLE graph_file_entities (
    stash_root TEXT NOT NULL, file_path TEXT NOT NULL, body_hash TEXT NOT NULL, entity_order INTEGER NOT NULL,
    entity_norm TEXT NOT NULL, entity TEXT NOT NULL, PRIMARY KEY (stash_root, file_path, body_hash, entity_order),
    FOREIGN KEY (stash_root, file_path, body_hash)
      REFERENCES graph_files(stash_root, file_path, body_hash) ON DELETE CASCADE
  );
`;

const FRAGMENT_ROWID_SPAN = 2 ** 20;
const FINGERPRINT = "remote:embed-model|3";

interface FixtureEntry {
  name: string;
  description: string;
  body: string;
  vector: number[];
}

const ENTRIES: FixtureEntry[] = [
  {
    name: "alpha-deploy",
    description: "deploy the alpha cluster",
    body: "# Alpha\n\nZeppelin rollout notes.",
    vector: [1, 0, 0],
  },
  {
    name: "bravo-backup",
    description: "nightly backup routine",
    body: "# Bravo\n\nSnapshot retention.",
    vector: [0, 1, 0],
  },
  {
    name: "charlie-cache",
    description: "cache warming",
    body: "# Charlie\n\nPrefetch the hot keys.",
    vector: [0, 0, 1],
  },
];

/** Write a layout-23 index the way 0.9.14–0.9.17 left it: realigned FTS rowids, fingerprint, salvage table. */
function buildLayout23Index(dbPath: string, stashRoot: string): void {
  const db = openDatabase(dbPath);
  try {
    db.exec(LAYOUT_23_DDL);
    const meta = db.prepare("INSERT INTO index_meta (key, value) VALUES (?, ?)");
    meta.run("version", "23");
    meta.run("embeddingFingerprint", FINGERPRINT);
    meta.run("embeddingDim", "3");
    meta.run("hasEmbeddings", "1");
    ENTRIES.forEach((fixture, index) => {
      const id = index + 1;
      const filePath = path.join(stashRoot, "knowledge", `${fixture.name}.md`);
      const document = {
        name: fixture.name,
        type: "knowledge",
        description: fixture.description,
        filename: `${fixture.name}.md`,
      };
      const searchText = `${fixture.name.replace(/-/g, " ")} ${fixture.description}`;
      db.prepare(
        "INSERT INTO entries (id, item_ref, bundle_id, component_id, concept_id, adapter_id, type, file_path, content_hash, document_json, search_text) " +
          "VALUES (?, ?, 'stash', 'stash', ?, 'akm', 'knowledge', ?, ?, ?, ?)",
      ).run(
        id,
        `stash//knowledge/${fixture.name}`,
        `knowledge/${fixture.name}`,
        filePath,
        `hash-${id}`,
        JSON.stringify(document),
        searchText,
      );
      db.prepare(
        "INSERT INTO entries_fts (rowid, entry_id, name, description, tags, hints, content) VALUES (?, ?, ?, ?, '', '', '')",
      ).run(id, id, fixture.name.replace(/-/g, " "), fixture.description);
      db.prepare("INSERT INTO entry_fragments (entry_id, safe_markdown) VALUES (?, ?)").run(id, fixture.body);
      db.prepare(
        "INSERT INTO entry_fragments_fts (rowid, entry_id, fragment_id, fragment_ordinal, content) VALUES (?, ?, ?, 0, ?)",
      ).run(id * FRAGMENT_ROWID_SPAN, id, "stale-fragment-id", fixture.body.toLowerCase());
      db.prepare("INSERT INTO embeddings (id, embedding) VALUES (?, ?)").run(
        id,
        Buffer.from(new Float32Array(fixture.vector).buffer),
      );
    });
    db.prepare("INSERT INTO embedding_salvage VALUES ('h', ?, x'00', '2026-09-01')").run(FINGERPRINT);
    db.prepare("INSERT INTO utility_scores (entry_id, utility, show_count) VALUES (1, 0.75, 4)").run();
    db.prepare("INSERT INTO index_dir_state VALUES (?, 'fp', 1, 'updated', '2026-09-01', 3)").run(
      path.join(stashRoot, "knowledge"),
    );
    db.prepare(
      "INSERT INTO llm_enrichment_cache VALUES ('stash//knowledge/alpha-deploy', '', 'bh', '{\"tags\":[\"x\"]}', 1)",
    ).run();
    db.prepare(
      "INSERT INTO graph_files VALUES (?, 'knowledge/alpha-deploy.md', 0, 'knowledge', 'bh', 0.9, 'extracted', NULL, 'run-1')",
    ).run(stashRoot);
    db.prepare(
      "INSERT INTO graph_file_entities VALUES (?, 'knowledge/alpha-deploy.md', 'bh', 0, 'zeppelin', 'Zeppelin')",
    ).run(stashRoot);
  } finally {
    db.close();
  }
}

function tableNames(db: Database): string[] {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>
  ).map((row) => row.name);
}

function count(db: Database, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

describe("index.db layout 23 → 24", () => {
  let storage: IsolatedAkmStorage;
  let dbPath = "";
  let warnings: string[] = [];

  beforeEach(() => {
    storage = withIsolatedAkmStorage();
    dbPath = path.join(storage.root, "layout-23.db");
    buildLayout23Index(dbPath, storage.stashDir);
    warnings = [];
    _setWarnSinkForTests((_level, args) => warnings.push(args.map(String).join(" ")));
  });

  afterEach(() => {
    _setWarnSinkForTests(undefined);
    storage.cleanup();
  });

  test("an older index opens read-only without refusal and answers keyword and vector queries", () => {
    for (const open of [() => openReadonlyExistingDatabase(dbPath), () => openExistingDatabase(dbPath)]) {
      const db = open();
      if (!db) throw new Error("expected a handle");
      try {
        expect(searchFts(db, "zeppelin", 10).map((hit) => hit.itemRef)).toEqual(["stash//knowledge/alpha-deploy"]);
        expect(searchFts(db, "backup", 10).map((hit) => hit.itemRef)).toEqual(["stash//knowledge/bravo-backup"]);
        expect(getEmbeddingCount(db, FINGERPRINT)).toBe(3);
        expect(searchVec(db, [0, 1, 0], 1)[0]?.id).toBe(2);
        expect(getMeta(db, "version")).toBe("23");
      } finally {
        closeDatabase(db);
      }
    }
    expect(warnings.some((line) => line.includes("older layout") && line.includes("akm index"))).toBe(true);
  });

  test("the writable open migrates in place: FTS rebuilt once, nothing else dropped", () => {
    const db = openIndexDatabase(dbPath, { embeddingDim: 3 });
    try {
      expect(getMeta(db, "version")).toBe(String(CANONICAL_INDEX_DB_VERSION));
      expect(warnings.filter((line) => line.includes("Rebuilding the full-text index for 3 entries"))).toHaveLength(1);

      // Entries intact, ids unchanged.
      const entries = db.prepare("SELECT id, item_ref FROM entries ORDER BY id").all() as Array<{
        id: number;
        item_ref: string;
      }>;
      expect(entries.map((row) => [row.id, row.item_ref])).toEqual(
        ENTRIES.map((fixture, index) => [index + 1, `stash//knowledge/${fixture.name}`]),
      );

      // Embeddings kept byte-for-byte and labelled with the model they were generated under.
      const vectors = db.prepare("SELECT id, embedding, model FROM embeddings ORDER BY id").all() as Array<{
        id: number;
        embedding: Uint8Array;
        model: string | null;
      }>;
      expect(vectors.map((row) => row.model)).toEqual([FINGERPRINT, FINGERPRINT, FINGERPRINT]);
      expect(vectors.map((row) => [...new Float32Array(new Uint8Array(row.embedding).buffer)])).toEqual(
        ENTRIES.map((fixture) => fixture.vector),
      );
      expect(getEmbeddingCount(db, FINGERPRINT)).toBe(3);

      // Graph, LLM cache and utility rows untouched; the salvage table is retired.
      expect(count(db, "graph_files")).toBe(1);
      expect(count(db, "graph_file_entities")).toBe(1);
      expect(count(db, "llm_enrichment_cache")).toBe(1);
      expect(db.prepare("SELECT utility, show_count FROM utility_scores WHERE entry_id = 1").get()).toEqual({
        utility: 0.75,
        show_count: 4,
      });
      expect(count(db, "index_dir_state")).toBe(1);
      expect(tableNames(db)).not.toContain("embedding_salvage");

      // FTS answers queries from the rebuilt, single-copy layout.
      expect(tableNames(db)).not.toContain("entries_fts_content");
      expect(tableNames(db)).not.toContain("entry_fragments_fts_content");
      expect(searchFts(db, "backup", 10).map((hit) => hit.itemRef)).toEqual(["stash//knowledge/bravo-backup"]);
      const fragmentHit = searchFts(db, "zeppelin", 10);
      expect(fragmentHit.map((hit) => hit.itemRef)).toEqual(["stash//knowledge/alpha-deploy"]);
      expect(fragmentHit[0]?.fragmentId).toBeDefined();
      expect(fragmentHit[0]?.fragmentId).not.toBe("stale-fragment-id");
    } finally {
      closeDatabase(db);
    }

    // The migration is one-time: a second writable open does no rebuild.
    warnings = [];
    closeDatabase(openIndexDatabase(dbPath, { embeddingDim: 3 }));
    expect(warnings.some((line) => line.includes("Rebuilding the full-text index"))).toBe(false);
  });
});
