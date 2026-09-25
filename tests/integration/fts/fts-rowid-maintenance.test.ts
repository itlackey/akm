// Opens a real index.db (openIndexDatabase / bun:sqlite or better-sqlite3),
// so this belongs under tests/integration/ per the ORG-03/04/05/06
// classification rule.
//
// Covers the FTS rowid maintenance contract: entries_fts.rowid = entry_id,
// entry_fragments_fts.rowid = entry_id * 2^20 + fragment_ordinal, the
// one-time in-place realignment of pre-existing rows, re-detecting drift left
// by an older writer sharing the same generation, and that a targeted delete
// removes exactly its own entry's rows.
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
import { deleteEntriesByIds, upsertEntry } from "../../../src/storage/repositories/index-entries-repository";
import type { DbSearchResult } from "../../../src/storage/repositories/index-entry-types";
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

describe("FTS rowid maintenance", () => {
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

      // A full-table-scan delete (the pre-realignment shape) makes each upsert's cost
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

  test("re-detects rowid drift left by an older writer after realignment, keeping the re-upserted entry searchable", () => {
    const dbPath = tempDbPath();
    const idA = (() => {
      const db = openIndexDatabase(dbPath);
      try {
        const id = putEntry(db, "old-writer-a", "oldwritermarker");
        putEntry(db, "old-writer-b", "keepbmarker");
        putEntry(db, "old-writer-c", "keepcmarker");

        // Simulate an older binary sharing this generation (0.9.15/0.9.16,
        // or a rollback) re-upserting entry a's metadata after the layout is
        // already realigned: delete by entry_id, then insert without an
        // explicit rowid, exactly as the pre-realignment replaceFtsEntry
        // did. FTS5 appends at max(rowid)+1, so this lands outside entry a's
        // own rowid and leaves the table's highest-rowid row mismatched.
        db.prepare("DELETE FROM entries_fts WHERE entry_id = ?").run(id);
        db.prepare(
          "INSERT INTO entries_fts (entry_id, name, description, tags, hints, content) VALUES (?, ?, ?, ?, ?, ?)",
        ).run(id, "old-writer-a", "", "", "", "ordinary parent projection");
        return id;
      } finally {
        closeDatabase(db);
      }
    })();

    const db = openIndexDatabase(dbPath);
    try {
      // The meta key was already stamped, but the highest-rowid row no
      // longer matches its entry_id, so this writable open must realign
      // again rather than trust the stamp alone.
      const parentRow = db.prepare("SELECT rowid FROM entries_fts WHERE entry_id = ?").get(idA) as {
        rowid: number;
      };
      expect(parentRow.rowid).toBe(idA);

      putEntry(db, "old-writer-d", "newentrymarker");

      // Before the drift re-check, the old writer's stray row collided with
      // this next upsert's `DELETE FROM entries_fts WHERE rowid = ?`,
      // silently deleting entry a's only FTS row. The fragment search below
      // joins `entries`, not `entries_fts`, so only the row count pins the
      // parent projection itself.
      const parentRows = db.prepare("SELECT COUNT(*) AS n FROM entries_fts WHERE entry_id = ?").get(idA) as {
        n: number;
      };
      expect(parentRows.n).toBe(1);
      expect(searchFts(db, "oldwritermarker", 5).map((hit) => hit.itemRef)).toEqual([
        "fixture//knowledge/old-writer-a",
      ]);
    } finally {
      closeDatabase(db);
    }
  });

  test("realigns pre-existing FTS rows to the rowid contract without disturbing search results", () => {
    const dbPath = tempDbPath();
    const markerA = "legacyamarker";
    const markerC = "legacycmarker";
    let before: DbSearchResult[];
    const ids = (() => {
      const db = openIndexDatabase(dbPath);
      try {
        const idA = putEntry(db, "legacy-a", markerA);
        const idB = putEntry(db, "legacy-b", "legacybmarker");
        const idC = putEntry(db, "legacy-c", markerC);

        // Remove the middle entry so the survivors' entry ids (idA, idC) are
        // no longer contiguous, then simulate rows written by the
        // pre-realignment code path: wiped and reinserted without an
        // explicit rowid, so FTS5 auto-assigns compact rowids (1, 2, ...)
        // that diverge from entry_id for whichever entry lands second. A
        // single surviving entry would make rowid 1 coincidentally equal
        // entry id 1 and pass without realignment; this gap does not.
        deleteEntriesByIds(db, [idB]);
        db.exec("DELETE FROM entries_fts");
        db.exec("DELETE FROM entry_fragments_fts");
        for (const [id, name, marker] of [
          [idA, "legacy-a", markerA],
          [idC, "legacy-c", markerC],
        ] as const) {
          db.prepare(
            "INSERT INTO entries_fts (entry_id, name, description, tags, hints, content) VALUES (?, ?, ?, ?, ?, ?)",
          ).run(id, name, "", "", "", "ordinary parent projection");
          for (const fragment of splitMarkdownFragments(fragmentBody(marker))) {
            db.prepare(
              "INSERT INTO entry_fragments_fts (entry_id, fragment_id, fragment_ordinal, content) VALUES (?, ?, ?, ?)",
            ).run(id, fragment.fragmentId, fragment.ordinal, fragment.text.toLowerCase());
          }
        }
        db.prepare("DELETE FROM index_meta WHERE key = 'ftsRowidLayout'").run();

        // Captured on this still-open handle, before the writable reopen
        // that triggers realignment: searchFts only reads entry_id /
        // fragment_ordinal columns, so it reflects the pre-realignment rows
        // exactly, via the same helper used to assert the "after" results.
        before = [...searchFts(db, markerA, 5), ...searchFts(db, markerC, 5)];
        return { idA, idC };
      } finally {
        closeDatabase(db);
      }
    })();

    const db = openIndexDatabase(dbPath);
    try {
      expect(db.prepare("SELECT value FROM index_meta WHERE key = 'ftsRowidLayout'").get()).toEqual({ value: "2" });

      for (const id of [ids.idA, ids.idC]) {
        const parentRow = db.prepare("SELECT rowid FROM entries_fts WHERE entry_id = ?").get(id) as {
          rowid: number;
        };
        expect(parentRow.rowid).toBe(id);

        const fragmentRows = db
          .prepare(
            "SELECT rowid, fragment_ordinal FROM entry_fragments_fts WHERE entry_id = ? ORDER BY fragment_ordinal",
          )
          .all(id) as Array<{ rowid: number; fragment_ordinal: number }>;
        expect(fragmentRows.length).toBeGreaterThan(0);
        for (const row of fragmentRows) {
          expect(row.rowid).toBe(id * FRAGMENT_ROWID_ORDINAL_SPAN + row.fragment_ordinal);
        }
      }

      const after = [...searchFts(db, markerA, 5), ...searchFts(db, markerC, 5)];
      expect(after).toEqual(before);
    } finally {
      closeDatabase(db);
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
