// #C1 — opens a real index.db (openIndexDatabase / bun:sqlite or
// better-sqlite3), so this belongs under tests/integration/ per the
// ORG-03/04/05/06 classification rule.
//
// Covers the FTS rowid maintenance contract: entries_fts.rowid = entry_id,
// entry_fragments_fts.rowid = entry_id * 2^20 + fragment_ordinal, the
// one-time in-place realignment of pre-existing rows, and that a targeted
// delete removes exactly its own entry's rows.
import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { splitMarkdownFragments } from "../../../src/core/asset/markdown-fragments";
import { deriveEntryProvenance } from "../../../src/indexer/installations";
import { type IndexDocument, setMarkdownFragmentContent } from "../../../src/indexer/passes/metadata";
import { buildSearchText } from "../../../src/indexer/search/search-fields";
import type { Database } from "../../../src/storage/database";
import { closeDatabase, openIndexDatabase } from "../../../src/storage/repositories/index-connection";
import { upsertEntry } from "../../../src/storage/repositories/index-entries-repository";
import { deleteFtsEntries, searchFts } from "../../../src/storage/repositories/index-fts-repository";

const FRAGMENT_ROWID_ORDINAL_SPAN = 2 ** 20;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-fts-rowid-"));
  dirs.push(dir);
  return path.join(dir, "index.db");
}

const fragmentBody = (marker: string) => `# Alpha\n${marker} alpha body\n\n# Beta\n${marker} beta body`;

function putEntry(db: Database, name: string, marker: string): number {
  const entry: IndexDocument = { name, type: "knowledge", content: "ordinary parent projection" };
  setMarkdownFragmentContent(entry, fragmentBody(marker));
  const provenance = deriveEntryProvenance(
    { bundleId: "fixture", componentId: "fixture", adapterId: "akm" },
    "knowledge",
    name,
  );
  upsertEntry(db, `/fixture/knowledge/${name}.md`, entry, buildSearchText(entry), provenance);
  return (db.prepare("SELECT id FROM entries WHERE item_ref = ?").get(`fixture//knowledge/${name}`) as { id: number })
    .id;
}

describe("FTS rowid maintenance (#C1)", () => {
  test("entries_fts and entry_fragments_fts rows carry the rowid = entry_id / encoded-fragment-rowid contract", () => {
    const db = openIndexDatabase(tempDbPath());
    try {
      const entryId = putEntry(db, "contract", "contractmarker");

      const parentRow = db.prepare("SELECT rowid FROM entries_fts WHERE entry_id = ?").get(entryId) as {
        rowid: number;
      };
      expect(parentRow.rowid).toBe(entryId);

      const fragmentRows = db
        .prepare("SELECT rowid, fragment_ordinal FROM entry_fragments_fts WHERE entry_id = ? ORDER BY fragment_ordinal")
        .all(entryId) as Array<{ rowid: number; fragment_ordinal: number }>;
      expect(fragmentRows.length).toBeGreaterThan(0);
      for (const row of fragmentRows) {
        expect(row.rowid).toBe(entryId * FRAGMENT_ROWID_ORDINAL_SPAN + row.fragment_ordinal);
      }
    } finally {
      closeDatabase(db);
    }
  });

  test("upsert cost stays close to constant as the FTS tables grow, instead of scaling with table size", () => {
    const db = openIndexDatabase(tempDbPath());
    try {
      const upsertOne = (index: number): void => {
        const name = `perf-${index}`;
        const entry: IndexDocument = { name, type: "knowledge", content: `ordinary content ${index}` };
        setMarkdownFragmentContent(entry, fragmentBody(`perfmarker${index}`));
        const provenance = deriveEntryProvenance(
          { bundleId: "fixture", componentId: "fixture", adapterId: "akm" },
          "knowledge",
          name,
        );
        upsertEntry(db, `/fixture/knowledge/${name}.md`, entry, buildSearchText(entry), provenance);
      };

      const timeBatch = (start: number, count: number): number => {
        const started = performance.now();
        for (let i = start; i < start + count; i++) upsertOne(i);
        return performance.now() - started;
      };

      const firstBatchMs = timeBatch(0, 1000);
      timeBatch(1000, 1000); // grows the tables to 2,000 rows without timing it
      const lastBatchMs = timeBatch(2000, 1000);

      // A full-table-scan delete (the pre-#C1 shape) makes each upsert's cost
      // proportional to the table's current row count, so the last batch
      // (already 2,000 rows present) costs multiple times the first batch
      // (starting from an empty table) purely from that growth. Rowid-keyed
      // maintenance keeps every upsert's cost close to constant regardless of
      // table size.
      expect(lastBatchMs).toBeLessThan(firstBatchMs * 3);
    } finally {
      closeDatabase(db);
    }
  });

  test("realigns pre-existing FTS rows to the rowid contract exactly once, without disturbing search results", () => {
    const dbPath = tempDbPath();
    const entryId = (() => {
      const db = openIndexDatabase(dbPath);
      try {
        const id = putEntry(db, "legacy", "realignmentmarker");

        // Simulate rows written by the pre-#C1 code path: inserted without an
        // explicit rowid, so FTS5 auto-assigns one unrelated to entry_id.
        db.exec("DELETE FROM entries_fts");
        db.exec("DELETE FROM entry_fragments_fts");
        db.prepare(
          "INSERT INTO entries_fts (entry_id, name, description, tags, hints, content) VALUES (?, ?, ?, ?, ?, ?)",
        ).run(id, "legacy", "", "", "", "ordinary parent projection");
        for (const fragment of splitMarkdownFragments(fragmentBody("realignmentmarker"))) {
          db.prepare(
            "INSERT INTO entry_fragments_fts (entry_id, fragment_id, fragment_ordinal, content) VALUES (?, ?, ?, ?)",
          ).run(id, fragment.fragmentId, fragment.ordinal, fragment.text.toLowerCase());
        }
        db.prepare("DELETE FROM index_meta WHERE key = 'ftsRowidLayout'").run();
        return id;
      } finally {
        closeDatabase(db);
      }
    })();

    const db = openIndexDatabase(dbPath);
    let before: unknown[];
    try {
      expect(db.prepare("SELECT value FROM index_meta WHERE key = 'ftsRowidLayout'").get()).toEqual({ value: "2" });

      const parentRow = db.prepare("SELECT rowid FROM entries_fts WHERE entry_id = ?").get(entryId) as {
        rowid: number;
      };
      expect(parentRow.rowid).toBe(entryId);

      const fragmentRows = db
        .prepare("SELECT rowid, fragment_ordinal FROM entry_fragments_fts WHERE entry_id = ? ORDER BY fragment_ordinal")
        .all(entryId) as Array<{ rowid: number; fragment_ordinal: number }>;
      expect(fragmentRows.length).toBeGreaterThan(0);
      for (const row of fragmentRows) {
        expect(row.rowid).toBe(entryId * FRAGMENT_ROWID_ORDINAL_SPAN + row.fragment_ordinal);
      }

      const hits = searchFts(db, "realignmentmarker", 5);
      expect(hits.map((hit) => hit.itemRef)).toEqual(["fixture//knowledge/legacy"]);

      before = db.prepare("SELECT rowid, entry_id FROM entries_fts ORDER BY rowid").all();
    } finally {
      closeDatabase(db);
    }

    // A second writable open is a no-op: the meta key is already set, so the
    // rows are untouched rather than rebuilt again.
    const reopened = openIndexDatabase(dbPath);
    try {
      expect(reopened.prepare("SELECT rowid, entry_id FROM entries_fts ORDER BY rowid").all()).toEqual(before);
    } finally {
      closeDatabase(reopened);
    }
  });

  test("deleteFtsEntries removes exactly the target entry's FTS and fragment rows and no other's", () => {
    const db = openIndexDatabase(tempDbPath());
    try {
      const idA = putEntry(db, "keep-a", "keepamarker");
      const idB = putEntry(db, "delete-me", "deletememarker");
      const idC = putEntry(db, "keep-c", "keepcmarker");

      deleteFtsEntries(db, [idB]);

      const countFor = (table: string, entryId: number): number =>
        (db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE entry_id = ?`).get(entryId) as { c: number }).c;

      expect(countFor("entries_fts", idB)).toBe(0);
      expect(countFor("entry_fragments_fts", idB)).toBe(0);
      expect(countFor("entries_fts", idA)).toBe(1);
      expect(countFor("entries_fts", idC)).toBe(1);
      expect(countFor("entry_fragments_fts", idA)).toBeGreaterThan(0);
      expect(countFor("entry_fragments_fts", idC)).toBeGreaterThan(0);

      expect(searchFts(db, "deletememarker", 5)).toHaveLength(0);
      expect(searchFts(db, "keepamarker", 5).map((hit) => hit.itemRef)).toEqual(["fixture//knowledge/keep-a"]);
      expect(searchFts(db, "keepcmarker", 5).map((hit) => hit.itemRef)).toEqual(["fixture//knowledge/keep-c"]);
    } finally {
      closeDatabase(db);
    }
  });
});
