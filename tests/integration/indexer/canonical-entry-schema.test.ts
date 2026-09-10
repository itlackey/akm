// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { Database as BunDatabase } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deriveEntryProvenance } from "../../../src/indexer/installations";
import { ensureUsageEventsSchema } from "../../../src/indexer/usage/usage-events";
import type { Database } from "../../../src/storage/database";
import { openDatabase } from "../../../src/storage/database";
import {
  closeDatabase,
  openExistingDatabase,
  openIndexDatabase,
  openReadonlyExistingDatabase,
} from "../../../src/storage/repositories/index-connection";
import { relinkUsageEvents, upsertEntry } from "../../../src/storage/repositories/index-entries-repository";
import { DB_VERSION, ensureSchema } from "../../../src/storage/repositories/index-schema";
import { isVecAvailable } from "../../../src/storage/repositories/index-vec-repository";

const CURRENT_ENTRY_COLUMNS: string[] = [
  "id",
  "item_ref",
  "bundle_id",
  "component_id",
  "concept_id",
  "adapter_id",
  "type",
  "file_path",
  "content_hash",
  "document_json",
  "search_text",
  "derived_from",
];

const CURRENT_ENTRY_COLUMN_CONTRACT = [
  { name: "id", type: "INTEGER", notnull: 0, pk: 1 },
  { name: "item_ref", type: "TEXT", notnull: 1, pk: 0 },
  { name: "bundle_id", type: "TEXT", notnull: 1, pk: 0 },
  { name: "component_id", type: "TEXT", notnull: 1, pk: 0 },
  { name: "concept_id", type: "TEXT", notnull: 1, pk: 0 },
  { name: "adapter_id", type: "TEXT", notnull: 1, pk: 0 },
  { name: "type", type: "TEXT", notnull: 1, pk: 0 },
  { name: "file_path", type: "TEXT", notnull: 1, pk: 0 },
  { name: "content_hash", type: "TEXT", notnull: 0, pk: 0 },
  { name: "document_json", type: "TEXT", notnull: 1, pk: 0 },
  { name: "search_text", type: "TEXT", notnull: 1, pk: 0 },
  { name: "derived_from", type: "TEXT", notnull: 0, pk: 0 },
];

const CANONICAL_ENTRIES_DDL = `
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
`;

const CANONICAL_ENTRY_INDEXES_DDL = `
  CREATE INDEX idx_entries_bundle ON entries(bundle_id);
  CREATE INDEX idx_entries_type ON entries(type);
  CREATE INDEX idx_entries_file_path ON entries(file_path);
  CREATE INDEX idx_entries_derived_from ON entries(derived_from);
`;

const CANONICAL_PARENT_FTS_DDL = `
  CREATE VIRTUAL TABLE entries_fts USING fts5(
    entry_id UNINDEXED,
    name,
    description,
    tags,
    hints,
    content,
    tokenize='porter unicode61'
  );
`;

const CANONICAL_FRAGMENT_SURFACES_DDL = `
  CREATE TABLE entry_fragments (
    entry_id INTEGER PRIMARY KEY REFERENCES entries(id) ON DELETE CASCADE,
    safe_markdown TEXT NOT NULL
  );
  CREATE VIRTUAL TABLE entry_fragments_fts USING fts5(
    entry_id UNINDEXED,
    fragment_id UNINDEXED,
    fragment_ordinal UNINDEXED,
    content,
    tokenize='porter unicode61'
  );
`;

function withTempIndex(run: (dbPath: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akm-current-index-schema-"));
  try {
    run(path.join(root, "index.db"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function entryColumns(dbPath: string): string[] {
  const db = openDatabase(dbPath, { readonly: true, create: false });
  try {
    return (db.prepare("PRAGMA table_info(entries)").all() as Array<{ name: string }>).map((row) => row.name);
  } finally {
    db.close();
  }
}

function seedStampedEntriesSchema(dbPath: string, entriesDdl: string, indexesDdl = ""): void {
  const db = openDatabase(dbPath);
  try {
    db.exec(`
      CREATE TABLE index_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO index_meta (key, value) VALUES ('version', '${DB_VERSION}');
      ${entriesDdl}
      ${indexesDdl}
    `);
    db.prepare(
      `INSERT INTO entries
         (id, item_ref, bundle_id, component_id, concept_id, adapter_id, type,
          file_path, content_hash, document_json, search_text, derived_from)
       VALUES (1, 'stash//memories/hostile', 'stash', 'stash', 'memories/hostile',
               'akm', 'memory', '/tmp/hostile.md', NULL,
               '{"name":"hostile","type":"memory"}', 'hostile', NULL)`,
    ).run();
  } finally {
    db.close();
  }
}

function expectCanonicalGenerationRebuilt(dbPath: string): void {
  const db = openIndexDatabase(dbPath);
  try {
    expect((db.prepare("SELECT COUNT(*) AS count FROM entries").get() as { count: number }).count).toBe(0);
    const columns = db.prepare("PRAGMA table_info(entries)").all() as Array<{
      name: string;
      type: string;
      notnull: number;
      pk: number;
    }>;
    expect(columns.map(({ name, type, notnull, pk }) => ({ name, type, notnull, pk }))).toEqual(
      CURRENT_ENTRY_COLUMN_CONTRACT,
    );

    const indexes = db.prepare("PRAGMA index_list(entries)").all() as Array<{
      name: string;
      unique: number;
    }>;
    const indexColumns = new Map(
      indexes.map((index) => [
        index.name,
        (db.prepare(`PRAGMA index_info('${index.name}')`).all() as Array<{ name: string }>).map((row) => row.name),
      ]),
    );
    expect(indexes.some((index) => index.unique === 1 && indexColumns.get(index.name)?.join(",") === "item_ref")).toBe(
      true,
    );
    expect(indexColumns.get("idx_entries_bundle")).toEqual(["bundle_id"]);
    expect(indexColumns.get("idx_entries_type")).toEqual(["type"]);
    expect(indexColumns.get("idx_entries_file_path")).toEqual(["file_path"]);
    expect(indexColumns.get("idx_entries_derived_from")).toEqual(["derived_from"]);
  } finally {
    closeDatabase(db);
  }
}

function expectReadOpenerToRejectPartialGeneration(dbPath: string): void {
  let existing: Database | undefined;
  try {
    expect(() => {
      existing = openExistingDatabase(dbPath);
    }).toThrow(/not usable with this akm's derived schema/);
  } finally {
    if (existing) closeDatabase(existing);
  }

  let readonly: Database | undefined;
  try {
    expect(() => {
      readonly = openReadonlyExistingDatabase(dbPath);
    }).toThrow(/not usable with this akm's derived schema/);
  } finally {
    if (readonly) closeDatabase(readonly);
  }
}

describe("canonical derived-index entry schema", () => {
  test("a fresh index has one current entries shape and no transitional columns", () => {
    withTempIndex((dbPath) => {
      const db = openIndexDatabase(dbPath);
      closeDatabase(db);

      expect(entryColumns(dbPath)).toEqual(CURRENT_ENTRY_COLUMNS);
    });
  });

  test("does not stamp a generation until every required DDL surface succeeds", () => {
    withTempIndex((dbPath) => {
      const partial = openDatabase(dbPath);
      try {
        // This fails at a later required DDL surface (the sqlite-vec virtual
        // table, which — unlike every `CREATE TABLE IF NOT EXISTS` around it —
        // has no `IF NOT EXISTS` guard and so cannot silently coexist with a
        // same-named view). index-redesign (docs/plans/index-redesign.md, B5)
        // removed the previous trigger for this test (`index_dir_state`'s
        // `ALTER TABLE ... ADD COLUMN`, the only unguarded DDL statement
        // `ensureSchema` used to run) along with the table itself; this
        // exercises the same "version stamped only after every required DDL
        // surface succeeds" invariant against the DDL surface that replaced
        // it as the last unguarded one.
        if (!isVecAvailable(partial)) return;
        partial.exec("CREATE VIEW entries_vec AS SELECT 1 AS placeholder");
        expect(() => ensureSchema(partial, undefined)).toThrow(/entries_vec already exists/);
      } finally {
        partial.close();
      }

      const raw = openDatabase(dbPath, { readonly: true, create: false });
      try {
        expect(raw.prepare("SELECT value FROM index_meta WHERE key = 'version'").get()).toBeNull();
      } finally {
        raw.close();
      }
    });
  });

  test("opening a pre-current index rebuilds its derived entry generation", () => {
    withTempIndex((dbPath) => {
      const legacy = openDatabase(dbPath);
      legacy.exec(`
        CREATE TABLE index_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        INSERT INTO index_meta (key, value) VALUES ('version', '${DB_VERSION - 1}');
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
        INSERT INTO entries
          (entry_key, dir_path, file_path, stash_dir, entry_json, search_text, entry_type)
        VALUES
          ('/old:memory:stale', '/old/memories', '/old/memories/stale.md', '/old',
           '{"type":"memory","name":"stale"}', 'stale', 'memory');
      `);
      legacy.close();

      const current = openIndexDatabase(dbPath);
      try {
        const count = current.prepare("SELECT COUNT(*) AS count FROM entries").get() as { count: number };
        expect(count.count).toBe(0);
        expect(
          current.prepare("SELECT value FROM index_meta WHERE key = 'version'").get() as { value: string },
        ).toEqual({ value: String(DB_VERSION) });
      } finally {
        closeDatabase(current);
      }

      expect(entryColumns(dbPath)).toEqual(CURRENT_ENTRY_COLUMNS);
    });
  });

  test("a newer generation than this binary understands is left alone instead of wiped", () => {
    withTempIndex((dbPath) => {
      const newer = openDatabase(dbPath);
      newer.exec(`
        CREATE TABLE index_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        INSERT INTO index_meta (key, value) VALUES ('version', '${DB_VERSION + 1}');
        CREATE TABLE entries (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          item_ref TEXT NOT NULL UNIQUE,
          from_the_future TEXT NOT NULL
        );
        INSERT INTO entries (item_ref, from_the_future) VALUES ('stash//memories/future', 'do not wipe me');
      `);
      newer.close();

      expect(() => openIndexDatabase(dbPath)).toThrow(/newer akm/);

      const survivor = openDatabase(dbPath, { readonly: true, create: false });
      try {
        expect(
          survivor.prepare("SELECT value FROM index_meta WHERE key = 'version'").get() as { value: string },
        ).toEqual({ value: String(DB_VERSION + 1) });
        expect(survivor.prepare("SELECT COUNT(*) AS count FROM entries").get()).toEqual({ count: 1 });
        expect(
          survivor.prepare("SELECT from_the_future FROM entries WHERE item_ref = 'stash//memories/future'").get(),
        ).toEqual({ from_the_future: "do not wipe me" });
      } finally {
        survivor.close();
      }
    });
  });

  test("a hostile v21 generation with stale FTS state is discarded wholesale", () => {
    withTempIndex((dbPath) => {
      const legacy = openIndexDatabase(dbPath);
      const entry = {
        type: "knowledge" as const,
        name: "hostile-v21",
        description: "stale FTS state",
        filename: "hostile-v21.md",
      };
      const provenance = deriveEntryProvenance(
        { bundleId: "primary", componentId: "primary", adapterId: "akm" },
        entry.type,
        entry.name,
      );
      const oldId = upsertEntry(legacy, "/primary/knowledge/hostile-v21.md", entry, "stale FTS state", provenance);
      legacy.exec("CREATE TABLE entries_fts_dirty (entry_id INTEGER PRIMARY KEY)");
      legacy.prepare("INSERT INTO entries_fts_dirty (entry_id) VALUES (?)").run(oldId);
      legacy.prepare("UPDATE index_meta SET value = '21' WHERE key = 'version'").run();
      closeDatabase(legacy);

      const current = openIndexDatabase(dbPath);
      try {
        expect(current.prepare("SELECT COUNT(*) AS count FROM entries").get()).toEqual({ count: 0 });
        expect(current.prepare("SELECT COUNT(*) AS count FROM entries_fts").get()).toEqual({ count: 0 });
        expect(
          current.prepare("SELECT 1 AS present FROM sqlite_master WHERE name = 'entries_fts_dirty'").get(),
        ).toBeNull();
        expect(current.prepare("SELECT value FROM index_meta WHERE key = 'version'").get()).toEqual({
          value: String(DB_VERSION),
        });
      } finally {
        closeDatabase(current);
      }
    });
  });

  test("a stale partial generation is rebuilt even when entries is missing", () => {
    withTempIndex((dbPath) => {
      const stale = openDatabase(dbPath);
      stale.exec(`
        CREATE TABLE index_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        INSERT INTO index_meta (key, value) VALUES ('version', '${DB_VERSION - 1}');
        CREATE TABLE llm_enrichment_cache (legacy_payload TEXT NOT NULL);
      `);
      stale.close();

      const current = openIndexDatabase(dbPath);
      try {
        const columns = (
          current.prepare("PRAGMA table_info(llm_enrichment_cache)").all() as Array<{ name: string }>
        ).map((row) => row.name);
        expect(columns).toEqual(["asset_ref", "cache_variant", "body_hash", "result_json", "updated_at"]);
      } finally {
        closeDatabase(current);
      }

      expect(entryColumns(dbPath)).toEqual(CURRENT_ENTRY_COLUMNS);
    });
  });

  test("a stamped v23 generation missing or impersonating required FTS surfaces is rejected for reads and rebuilt", () => {
    const partialSearchSurfaceSchemas = [
      {
        name: "missing parent FTS",
        ddl: CANONICAL_FRAGMENT_SURFACES_DDL,
      },
      {
        name: "ordinary table impersonating parent FTS",
        ddl: `
          CREATE TABLE entries_fts (
            entry_id INTEGER,
            name TEXT,
            description TEXT,
            tags TEXT,
            hints TEXT,
            content TEXT
          );
          ${CANONICAL_FRAGMENT_SURFACES_DDL}
        `,
      },
      {
        name: "missing fragment tables",
        ddl: CANONICAL_PARENT_FTS_DDL,
      },
      {
        name: "fragment source missing its safe Markdown projection",
        ddl: `
          ${CANONICAL_PARENT_FTS_DDL}
          CREATE TABLE entry_fragments (
            entry_id INTEGER PRIMARY KEY REFERENCES entries(id) ON DELETE CASCADE
          );
          CREATE VIRTUAL TABLE entry_fragments_fts USING fts5(
            entry_id UNINDEXED,
            fragment_id UNINDEXED,
            fragment_ordinal UNINDEXED,
            content,
            tokenize='porter unicode61'
          );
        `,
      },
      {
        name: "ordinary table impersonating fragment FTS",
        ddl: `
          ${CANONICAL_PARENT_FTS_DDL}
          CREATE TABLE entry_fragments (
            entry_id INTEGER PRIMARY KEY REFERENCES entries(id) ON DELETE CASCADE,
            safe_markdown TEXT NOT NULL
          );
          CREATE TABLE entry_fragments_fts (
            entry_id INTEGER,
            fragment_id TEXT,
            fragment_ordinal INTEGER,
            content TEXT
          );
        `,
      },
    ];

    for (const partial of partialSearchSurfaceSchemas) {
      withTempIndex((dbPath) => {
        seedStampedEntriesSchema(dbPath, CANONICAL_ENTRIES_DDL, `${CANONICAL_ENTRY_INDEXES_DDL}\n${partial.ddl}`);

        expectReadOpenerToRejectPartialGeneration(dbPath);

        const rebuilt = openIndexDatabase(dbPath);
        try {
          expect(rebuilt.prepare("SELECT value FROM index_meta WHERE key = 'version'").get()).toEqual({
            value: String(DB_VERSION),
          });
          expect(rebuilt.prepare("SELECT sql FROM sqlite_master WHERE name = 'entry_fragments'").get()).toEqual({
            sql: expect.stringContaining("entry_id INTEGER PRIMARY KEY REFERENCES entries(id) ON DELETE CASCADE"),
          });
          expect(rebuilt.prepare("SELECT sql FROM sqlite_master WHERE name = 'entry_fragments_fts'").get()).toEqual({
            sql: expect.stringContaining("CREATE VIRTUAL TABLE entry_fragments_fts USING fts5"),
          });
          expect(rebuilt.prepare("SELECT sql FROM sqlite_master WHERE name = 'entries_fts'").get()).toEqual({
            sql: expect.stringContaining("CREATE VIRTUAL TABLE entries_fts USING fts5"),
          });
        } finally {
          closeDatabase(rebuilt);
        }

        // The same reader gates that rejected the partial stamp must accept
        // the fully rebuilt generation without another writable open.
        const existing = openExistingDatabase(dbPath);
        closeDatabase(existing);
        const readonly = openReadonlyExistingDatabase(dbPath);
        expect(readonly).toBeDefined();
        if (readonly) closeDatabase(readonly);
      });
    }
  });

  test("exact column names cannot disguise missing types, NOT NULL constraints, or the primary key", () => {
    withTempIndex((dbPath) => {
      seedStampedEntriesSchema(
        dbPath,
        `CREATE TABLE entries (
          id, item_ref, bundle_id, component_id, concept_id, adapter_id,
          type, file_path, content_hash, document_json, search_text, derived_from
        );`,
        CANONICAL_ENTRY_INDEXES_DDL,
      );
      expectCanonicalGenerationRebuilt(dbPath);
    });
  });

  test("a stamped exact-name schema without UNIQUE(item_ref) is rebuilt", () => {
    withTempIndex((dbPath) => {
      seedStampedEntriesSchema(
        dbPath,
        CANONICAL_ENTRIES_DDL.replace("item_ref      TEXT NOT NULL UNIQUE", "item_ref      TEXT NOT NULL"),
        CANONICAL_ENTRY_INDEXES_DDL,
      );
      expectCanonicalGenerationRebuilt(dbPath);
    });
  });

  test("a stamped exact-name schema without AUTOINCREMENT is rebuilt before ids can be reused", () => {
    withTempIndex((dbPath) => {
      seedStampedEntriesSchema(
        dbPath,
        CANONICAL_ENTRIES_DDL.replace("INTEGER PRIMARY KEY AUTOINCREMENT", "INTEGER PRIMARY KEY"),
        CANONICAL_ENTRY_INDEXES_DDL,
      );

      const indexDb = openIndexDatabase(dbPath);
      const stateDb = new BunDatabase(":memory:") as unknown as Database;
      try {
        ensureUsageEventsSchema(stateDb);
        let oldId = (
          indexDb.prepare("SELECT id FROM entries WHERE item_ref = 'stash//memories/hostile'").get() as
            | { id: number }
            | undefined
        )?.id;
        if (oldId === undefined) {
          oldId = upsertEntry(
            indexDb,
            "/tmp/a.md",
            { name: "a", type: "memory" },
            "a",
            deriveEntryProvenance({ bundleId: "stash", componentId: "stash", adapterId: "akm" }, "memory", "a"),
          );
        }
        const oldRef = (
          indexDb.prepare("SELECT item_ref AS itemRef FROM entries WHERE id = ?").get(oldId) as {
            itemRef: string;
          }
        ).itemRef;
        stateDb
          .prepare("INSERT INTO usage_events (event_type, entry_id, entry_ref, source) VALUES ('show', ?, ?, 'user')")
          .run(oldId, oldRef);

        indexDb.exec("DELETE FROM entries");
        const replacementId = upsertEntry(
          indexDb,
          "/tmp/b.md",
          { name: "b", type: "memory" },
          "b",
          deriveEntryProvenance({ bundleId: "stash", componentId: "stash", adapterId: "akm" }, "memory", "b"),
        );
        relinkUsageEvents(indexDb, stateDb);
        const event = stateDb.prepare("SELECT entry_id AS entryId FROM usage_events").get() as {
          entryId: number | null;
        };

        expect({ replacementIdIsNew: replacementId > oldId, durableEventLink: event.entryId }).toEqual({
          replacementIdIsNew: true,
          durableEventLink: null,
        });
      } finally {
        stateDb.close();
        closeDatabase(indexDb);
      }
    });
  });

  test("a stamped exact-name schema missing required lookup indexes is rebuilt instead of repaired in place", () => {
    withTempIndex((dbPath) => {
      seedStampedEntriesSchema(dbPath, CANONICAL_ENTRIES_DDL);
      expectCanonicalGenerationRebuilt(dbPath);
    });
  });

  test("required index names on the wrong columns cannot pass the generation fingerprint", () => {
    withTempIndex((dbPath) => {
      seedStampedEntriesSchema(
        dbPath,
        CANONICAL_ENTRIES_DDL,
        `CREATE INDEX idx_entries_bundle ON entries(type);
         CREATE INDEX idx_entries_type ON entries(bundle_id);
         CREATE INDEX idx_entries_file_path ON entries(concept_id);
         CREATE INDEX idx_entries_derived_from ON entries(search_text);`,
      );
      expectCanonicalGenerationRebuilt(dbPath);
    });
  });

  test("a stamped schema with a hidden generated legacy column is rebuilt", () => {
    withTempIndex((dbPath) => {
      seedStampedEntriesSchema(
        dbPath,
        CANONICAL_ENTRIES_DDL.replace(
          "derived_from  TEXT\n  );",
          "derived_from  TEXT,\n    entry_key    TEXT GENERATED ALWAYS AS (item_ref) VIRTUAL\n  );",
        ),
        CANONICAL_ENTRY_INDEXES_DDL,
      );

      expectCanonicalGenerationRebuilt(dbPath);

      const db = openDatabase(dbPath, { readonly: true, create: false });
      try {
        const columns = db.prepare("PRAGMA table_xinfo(entries)").all() as Array<{ name: string }>;
        expect(columns.map((column) => column.name)).toEqual(CURRENT_ENTRY_COLUMNS);
      } finally {
        db.close();
      }
    });
  });

  test("a NOCASE item_ref uniqueness constraint is rejected and rebuilt with case-sensitive identity", () => {
    withTempIndex((dbPath) => {
      seedStampedEntriesSchema(
        dbPath,
        CANONICAL_ENTRIES_DDL.replace(
          "item_ref      TEXT NOT NULL UNIQUE",
          "item_ref      TEXT COLLATE NOCASE NOT NULL UNIQUE",
        ),
        CANONICAL_ENTRY_INDEXES_DDL,
      );

      const db = openIndexDatabase(dbPath);
      try {
        expect((db.prepare("SELECT COUNT(*) AS count FROM entries").get() as { count: number }).count).toBe(0);
        const insert = db.prepare(
          `INSERT INTO entries
             (item_ref, bundle_id, component_id, concept_id, adapter_id, type,
              file_path, content_hash, document_json, search_text, derived_from)
           VALUES (?, 'stash', 'stash', ?, 'akm', 'knowledge', ?, NULL, ?, '', NULL)`,
        );
        for (const conceptId of ["knowledge/Guide", "knowledge/guide"]) {
          insert.run(
            `stash//${conceptId}`,
            conceptId,
            `/tmp/${conceptId.replace("/", "-")}.md`,
            JSON.stringify({ name: conceptId, type: "knowledge" }),
          );
        }

        expect(
          (db.prepare("SELECT item_ref FROM entries ORDER BY id").all() as Array<{ item_ref: string }>).map(
            (row) => row.item_ref,
          ),
        ).toEqual(["stash//knowledge/Guide", "stash//knowledge/guide"]);
        const uniqueIndex = (
          db.prepare("PRAGMA index_list(entries)").all() as Array<{ name: string; unique: number; origin: string }>
        ).find((index) => index.unique === 1 && index.origin === "u");
        expect(uniqueIndex).toBeDefined();
        const keyColumns = db.prepare(`PRAGMA index_xinfo('${uniqueIndex?.name ?? ""}')`).all() as Array<{
          name: string | null;
          desc: number;
          coll: string;
          key: number;
        }>;
        expect(
          keyColumns
            .filter((column) => column.key === 1)
            .map(({ name, desc, coll, key }) => ({ name, desc, coll, key })),
        ).toEqual([{ name: "item_ref", desc: 0, coll: "BINARY", key: 1 }]);
      } finally {
        closeDatabase(db);
      }
    });
  });
});
