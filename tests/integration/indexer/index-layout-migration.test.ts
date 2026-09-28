// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The in-place index.db migrations to the current layout:
 *
 * - from layout 23 (0.9.14–0.9.17: FTS5 tables carrying their own copy of
 *   every indexed field, `embeddings` without a per-row model);
 * - from layout 24 (contentless FTS, the sqlite-vec mirror `entries_vec`, the
 *   fragment FTS table, and the embedding input stored as `search_text`) to
 *   layout 25 (vectors only in `embeddings`, no fragment FTS, `embed_hash`).
 *
 * Each fixture is built with its layout's DDL frozen from git history
 * (`index-entry-schema.ts` / `index-schema.ts` before the change), then opened
 * with the current code: read-only first (served as-is, no refusal), then
 * writable (migrated in place). Nothing derived from an LLM or an embedding
 * provider may be lost on the way.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import path from "node:path";
import type { AkmConfig } from "../../../src/core/config/config";
import { _setWarnSinkForTests } from "../../../src/core/warn";
import { deriveEntryProvenance } from "../../../src/indexer/installations";
import { generateEmbeddingsForDb } from "../../../src/indexer/materialize-embeddings";
import { buildSearchText } from "../../../src/indexer/search/search-fields";
import { _setEmbedderForTests } from "../../../src/llm/embedder";
import { sha256Hex } from "../../../src/runtime";
import { type Database, openDatabase } from "../../../src/storage/database";
import {
  closeDatabase,
  openExistingDatabase,
  openIndexDatabase,
  openReadonlyExistingDatabase,
} from "../../../src/storage/repositories/index-connection";
import { upsertEntry } from "../../../src/storage/repositories/index-entries-repository";
import { CANONICAL_INDEX_DB_VERSION } from "../../../src/storage/repositories/index-entry-schema";
import { searchFts } from "../../../src/storage/repositories/index-fts-repository";
import { getMeta } from "../../../src/storage/repositories/index-meta-repository";
import { VACUUM_PENDING_META } from "../../../src/storage/repositories/index-schema";
import { getEmbeddingCount, searchVec } from "../../../src/storage/repositories/index-vec-repository";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../_helpers/sandbox";
import { overrideSeam } from "../../_helpers/seams";

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
    const db = openIndexDatabase(dbPath);
    try {
      expect(getMeta(db, "version")).toBe(String(CANONICAL_INDEX_DB_VERSION));
      expect(getMeta(db, VACUUM_PENDING_META)).toBe("1");
      expect(warnings.filter((line) => line.includes("Rebuilding the full-text index for 3 entries"))).toHaveLength(1);

      // Entries intact, ids unchanged; search_text replaced by the hash of the stored text.
      const entries = db.prepare("SELECT id, item_ref, embed_hash FROM entries ORDER BY id").all() as Array<{
        id: number;
        item_ref: string;
        embed_hash: string;
      }>;
      expect(entries.map((row) => [row.id, row.item_ref, row.embed_hash])).toEqual(
        ENTRIES.map((fixture, index) => [
          index + 1,
          `stash//knowledge/${fixture.name}`,
          sha256Hex(`${fixture.name.replace(/-/g, " ")} ${fixture.description}`),
        ]),
      );
      expect(entryColumns(db)).not.toContain("search_text");

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

      // FTS answers queries from the rebuilt, single-copy layout; the fragment
      // FTS table is gone, and the safe Markdown `akm show` reads is kept.
      expect(tableNames(db)).not.toContain("entries_fts_content");
      expect(tableNames(db).filter((name) => name.startsWith("entry_fragments_fts"))).toEqual([]);
      expect(searchFts(db, "backup", 10).map((hit) => hit.itemRef)).toEqual(["stash//knowledge/bravo-backup"]);
      expect(
        (
          db.prepare("SELECT safe_markdown FROM entry_fragments ORDER BY entry_id").all() as Array<{
            safe_markdown: string;
          }>
        ).map((row) => row.safe_markdown),
      ).toEqual(ENTRIES.map((fixture) => fixture.body));
    } finally {
      closeDatabase(db);
    }

    // The migration is one-time: a second writable open does no rebuild.
    warnings = [];
    closeDatabase(openIndexDatabase(dbPath));
    expect(warnings.some((line) => line.includes("Rebuilding the full-text index"))).toBe(false);
  });
});

const LAYOUT_24_DDL = `
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
  CREATE TABLE entry_fragments (
    entry_id INTEGER PRIMARY KEY REFERENCES entries(id) ON DELETE CASCADE,
    safe_markdown TEXT NOT NULL
  );
  CREATE VIRTUAL TABLE entries_fts USING fts5(
    entry_id UNINDEXED, name, description, tags, hints, content,
    content='', contentless_delete=1, tokenize='porter unicode61'
  );
  CREATE VIRTUAL TABLE entry_fragments_fts USING fts5(
    entry_id UNINDEXED, fragment_id UNINDEXED, fragment_ordinal UNINDEXED, content,
    content='', contentless_delete=1, tokenize='porter unicode61'
  );
  CREATE TABLE embeddings (
    id INTEGER PRIMARY KEY, embedding BLOB NOT NULL, model TEXT, FOREIGN KEY (id) REFERENCES entries(id)
  );
  CREATE VIRTUAL TABLE entries_vec USING vec0(id INTEGER PRIMARY KEY, embedding FLOAT[3]);
`;

function fixtureDocument(fixture: FixtureEntry) {
  return { name: fixture.name, type: "knowledge" as const, description: fixture.description };
}

/** Write a layout-24 index the way this branch's parent left it: sqlite-vec mirror, fragment FTS, `search_text`. */
function buildLayout24Index(dbPath: string, stashRoot: string): void {
  const db = openDatabase(dbPath);
  try {
    createRequire(import.meta.url)("sqlite-vec").load(db);
    db.exec(LAYOUT_24_DDL);
    const meta = db.prepare("INSERT INTO index_meta (key, value) VALUES (?, ?)");
    meta.run("version", "24");
    meta.run("embeddingFingerprint", FINGERPRINT);
    meta.run("embeddingDim", "3");
    meta.run("vecFastPathReady", "1");
    meta.run("hasEmbeddings", "1");
    ENTRIES.forEach((fixture, index) => {
      const id = index + 1;
      const document = fixtureDocument(fixture);
      db.prepare(
        "INSERT INTO entries (id, item_ref, bundle_id, component_id, concept_id, adapter_id, type, file_path, content_hash, document_json, search_text) " +
          "VALUES (?, ?, 'stash', 'stash', ?, 'akm', 'knowledge', ?, ?, ?, ?)",
      ).run(
        id,
        `stash//knowledge/${fixture.name}`,
        `knowledge/${fixture.name}`,
        path.join(stashRoot, "knowledge", `${fixture.name}.md`),
        `hash-${id}`,
        JSON.stringify(document),
        buildSearchText(document),
      );
      db.prepare(
        "INSERT INTO entries_fts (rowid, name, description, tags, hints, content) VALUES (?, ?, ?, '', '', '')",
      ).run(id, fixture.name.replace(/-/g, " "), fixture.description);
      db.prepare("INSERT INTO entry_fragments (entry_id, safe_markdown) VALUES (?, ?)").run(id, fixture.body);
      db.prepare("INSERT INTO entry_fragments_fts (rowid, content) VALUES (?, ?)").run(
        id * FRAGMENT_ROWID_SPAN,
        fixture.body.toLowerCase(),
      );
      const vector = Buffer.from(new Float32Array(fixture.vector).buffer);
      db.prepare("INSERT INTO embeddings (id, embedding, model) VALUES (?, ?, ?)").run(id, vector, FINGERPRINT);
      db.prepare("INSERT INTO entries_vec (id, embedding) VALUES (?, ?)").run(id, vector);
    });
  } finally {
    db.close();
  }
}

function entryColumns(db: Database): string[] {
  return (db.prepare("PRAGMA table_info(entries)").all() as Array<{ name: string }>).map((row) => row.name);
}

describe("index.db layout 24 → 25", () => {
  let storage: IsolatedAkmStorage;
  let dbPath = "";

  beforeEach(() => {
    storage = withIsolatedAkmStorage();
    dbPath = path.join(storage.root, "layout-24.db");
    buildLayout24Index(dbPath, storage.stashDir);
  });

  afterEach(() => {
    storage.cleanup();
  });

  test("an older index opens read-only as-is and answers keyword and vector queries", () => {
    const db = openReadonlyExistingDatabase(dbPath);
    if (!db) throw new Error("expected a handle");
    try {
      expect(searchFts(db, "backup", 10).map((hit) => hit.itemRef)).toEqual(["stash//knowledge/bravo-backup"]);
      expect(searchVec(db, [0, 0, 1], 1)[0]?.id).toBe(3);
      expect(getMeta(db, "version")).toBe("24");
    } finally {
      closeDatabase(db);
    }
  });

  test("the writable open migrates in place: mirror, fragment FTS and search_text go; vectors stay valid", async () => {
    const db = openIndexDatabase(dbPath);
    try {
      expect(getMeta(db, "version")).toBe(String(CANONICAL_INDEX_DB_VERSION));
      expect(tableNames(db).filter((name) => name.startsWith("entries_vec"))).toEqual([]);
      expect(tableNames(db).filter((name) => name.startsWith("entry_fragments_fts"))).toEqual([]);
      expect(getMeta(db, "embeddingDim")).toBeUndefined();
      expect(getMeta(db, "vecFastPathReady")).toBeUndefined();
      // The next `akm index` VACUUMs the pages the dropped tables and column left free.
      expect(getMeta(db, VACUUM_PENDING_META)).toBe("1");
      expect(count(db, "entry_fragments")).toBe(3);

      // search_text is replaced by the hash of the text each vector was embedded from.
      expect(entryColumns(db)).not.toContain("search_text");
      const hashes = db.prepare("SELECT embed_hash FROM entries ORDER BY id").all() as Array<{ embed_hash: string }>;
      expect(hashes.map((row) => row.embed_hash)).toEqual(
        ENTRIES.map((fixture) => sha256Hex(buildSearchText(fixtureDocument(fixture)))),
      );

      // Vectors are kept, served, and still current: no provider call, and
      // re-persisting an unchanged entry keeps its vector.
      expect(getEmbeddingCount(db, FINGERPRINT)).toBe(3);
      expect(searchVec(db, [0, 0, 1], 1)[0]?.id).toBe(3);
      expect(searchFts(db, "backup", 10).map((hit) => hit.itemRef)).toEqual(["stash//knowledge/bravo-backup"]);
      overrideSeam(_setEmbedderForTests, {
        embedBatch: async () => {
          throw new Error("the provider must not be called — every stored vector is still current");
        },
      });
      const config: AkmConfig = {
        semanticSearchMode: "auto",
        embedding: { endpoint: "http://localhost:1", model: "embed-model", dimension: 3 },
      };
      const messages: string[] = [];
      expect((await generateEmbeddingsForDb(db, config, (event) => messages.push(event.message))).success).toBe(true);
      expect(messages).toContain("Embeddings already up to date.");
      const alpha = ENTRIES[0]!;
      upsertEntry(
        db,
        path.join(storage.stashDir, "knowledge", `${alpha.name}.md`),
        fixtureDocument(alpha),
        deriveEntryProvenance({ bundleId: "stash", componentId: "stash", adapterId: "akm" }, "knowledge", alpha.name),
      );
      expect(getEmbeddingCount(db, FINGERPRINT)).toBe(3);
    } finally {
      closeDatabase(db);
    }
  });
});

describe("index.db layout 25 (0.9.17-alpha.5 shape): retired utility_scores_scoped", () => {
  let storage: IsolatedAkmStorage;
  let dbPath = "";

  beforeEach(() => {
    storage = withIsolatedAkmStorage();
    dbPath = path.join(storage.root, "layout-25-scoped-utility.db");
    // alpha.5 shipped `utility_scores_scoped` at layout 25 (IR-7a), but no
    // code ever read or wrote a row. Build the table exactly as alpha.5's
    // ensureSchema created it, with a row present, to prove the retirement
    // drop tolerates non-empty (as well as the real, always-empty) shape.
    const db = openDatabase(dbPath);
    try {
      db.exec("CREATE TABLE index_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);");
      db.prepare("INSERT INTO index_meta (key, value) VALUES ('version', '25')").run();
      db.exec(`
        CREATE TABLE utility_scores_scoped (
          entry_id     INTEGER NOT NULL,
          scope_key    TEXT NOT NULL,
          utility      REAL NOT NULL DEFAULT 0,
          last_used_at INTEGER NOT NULL,
          PRIMARY KEY (entry_id, scope_key)
        );
        CREATE INDEX idx_utility_scores_scoped_entry_id ON utility_scores_scoped(entry_id);
      `);
      db.prepare(
        "INSERT INTO utility_scores_scoped (entry_id, scope_key, utility, last_used_at) VALUES (1, 'dir:/repo', 0.5, 1234)",
      ).run();
    } finally {
      db.close();
    }
  });

  afterEach(() => {
    storage.cleanup();
  });

  test("a writable open drops the table and keeps layout 25 — no version bump, no VACUUM flag", () => {
    const db = openIndexDatabase(dbPath);
    try {
      expect(tableNames(db)).not.toContain("utility_scores_scoped");
      // Layout 25 is still this release's layout: retiring a table already at
      // the current version must not look like a migration.
      expect(getMeta(db, "version")).toBe(String(CANONICAL_INDEX_DB_VERSION));
      expect(getMeta(db, VACUUM_PENDING_META)).toBeUndefined();
    } finally {
      closeDatabase(db);
    }
  });
});
