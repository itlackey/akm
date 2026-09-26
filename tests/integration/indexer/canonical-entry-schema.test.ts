// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deriveEntryProvenance } from "../../../src/indexer/installations";
import { openDatabase } from "../../../src/storage/database";
import { closeDatabase, openIndexDatabase } from "../../../src/storage/repositories/index-connection";
import { upsertEntry } from "../../../src/storage/repositories/index-entries-repository";
import { searchFts } from "../../../src/storage/repositories/index-fts-repository";
import { DB_VERSION, ensureSchema } from "../../../src/storage/repositories/index-schema";

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
        // This fails at a later required DDL surface. Before the v23 ordering
        // fix, the version was already stamped just after entries creation.
        partial.exec("CREATE VIEW index_dir_state AS SELECT 1 AS placeholder");
        expect(() => ensureSchema(partial, undefined)).toThrow(/Cannot add a column to a view/);
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

  test("a layout-21 index keeps its entries and gets its full-text index rebuilt from them", () => {
    withTempIndex((dbPath) => {
      const legacy = openIndexDatabase(dbPath);
      const entry = {
        type: "knowledge" as const,
        name: "layout-21",
        description: "kept across the upgrade",
        filename: "layout-21.md",
      };
      const provenance = deriveEntryProvenance(
        { bundleId: "primary", componentId: "primary", adapterId: "akm" },
        entry.type,
        entry.name,
      );
      const id = upsertEntry(legacy, "/primary/knowledge/layout-21.md", entry, "kept across the upgrade", provenance);
      // Layout 21: content-bearing FTS (here left stale and empty), a dirty
      // queue, and no fragment tables.
      legacy.exec(`
        DROP TABLE entries_fts;
        DROP TABLE entry_fragments_fts;
        DROP TABLE entry_fragments;
        CREATE VIRTUAL TABLE entries_fts USING fts5(
          entry_id UNINDEXED, name, description, tags, hints, content, tokenize='porter unicode61'
        );
        CREATE TABLE entries_fts_dirty (entry_id INTEGER PRIMARY KEY);
      `);
      legacy.prepare("INSERT INTO entries_fts_dirty (entry_id) VALUES (?)").run(id);
      legacy.prepare("UPDATE index_meta SET value = '21' WHERE key = 'version'").run();
      closeDatabase(legacy);

      const current = openIndexDatabase(dbPath);
      try {
        expect(current.prepare("SELECT id FROM entries").all()).toEqual([{ id }]);
        expect(searchFts(current, "upgrade", 10).map((hit) => hit.id)).toEqual([id]);
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
});
