// Opens a real index.db (openIndexDatabase / bun:sqlite or better-sqlite3),
// so this belongs under tests/integration/ per the ORG-03/04/05/06
// classification rule.
//
// Covers the FTS rowid maintenance contract: entries_fts.rowid = entry_id,
// entry_fragments_fts.rowid = entry_id * 2^20 + fragment_ordinal, constant
// upsert cost as the tables grow, and that a targeted delete removes exactly
// its own entry's rows. (The layout-23 → 24 rebuild that establishes the
// contract on an older index is covered by
// tests/integration/indexer/index-layout-migration.test.ts.)
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

describe("FTS rowid maintenance", () => {
  test("entries_fts and entry_fragments_fts rows carry the rowid = entry_id / encoded-fragment-rowid contract", () => {
    const db = openIndexDatabase(tempDbPath());
    try {
      const entryId = putEntry(db, "contract", "contractmarker");

      const parentRows = db.prepare("SELECT rowid FROM entries_fts WHERE entries_fts MATCH 'name:contract'").all();
      expect(parentRows).toEqual([{ rowid: entryId }]);

      const fragmentRows = db
        .prepare(
          "SELECT rowid FROM entry_fragments_fts WHERE entry_fragments_fts MATCH 'contractmarker' ORDER BY rowid",
        )
        .all() as Array<{ rowid: number }>;
      expect(fragmentRows.map((row) => row.rowid)).toEqual(
        splitMarkdownFragments(fragmentBody("contractmarker")).map(
          (fragment) => entryId * FRAGMENT_ROWID_ORDINAL_SPAN + fragment.ordinal,
        ),
      );
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

  test("deleteFtsEntries removes exactly the target entry's FTS and fragment rows and no other's", () => {
    const db = openIndexDatabase(tempDbPath());
    try {
      const idA = putEntry(db, "keep-a", "keepamarker");
      const idB = putEntry(db, "delete-me", "deletememarker");
      const idC = putEntry(db, "keep-c", "keepcmarker");

      deleteFtsEntries(db, [idB]);

      const countFor = (table: string, entryId: number): number => {
        const [start, end] =
          table === "entries_fts"
            ? [entryId, entryId + 1]
            : [entryId * FRAGMENT_ROWID_ORDINAL_SPAN, (entryId + 1) * FRAGMENT_ROWID_ORDINAL_SPAN];
        return (
          db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE rowid >= ? AND rowid < ?`).get(start, end) as {
            c: number;
          }
        ).c;
      };

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
