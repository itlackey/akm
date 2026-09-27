// Opens a real index.db (openIndexDatabase / bun:sqlite or better-sqlite3),
// so this belongs under tests/integration/ per the ORG-03/04/05/06
// classification rule.
//
// Covers the FTS rowid maintenance contract: entries_fts.rowid = entry_id,
// constant upsert cost as the tables grow, and that a targeted delete removes
// exactly its own entry's FTS row and fragment source. (The layout-23 → 24
// rebuild that establishes the contract on an older index is covered by
// tests/integration/indexer/index-layout-migration.test.ts.)
import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deriveEntryProvenance } from "../../../src/indexer/installations";
import { type IndexDocument, setMarkdownFragmentContent } from "../../../src/indexer/passes/metadata";
import { buildSearchText } from "../../../src/indexer/search/search-fields";
import type { Database } from "../../../src/storage/database";
import { closeDatabase, openIndexDatabase } from "../../../src/storage/repositories/index-connection";
import { upsertEntry } from "../../../src/storage/repositories/index-entries-repository";
import { deleteFtsEntries } from "../../../src/storage/repositories/index-fts-repository";

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
  test("entries_fts rows carry the rowid = entry_id contract, and the fragment source is stored once per entry", () => {
    const db = openIndexDatabase(tempDbPath());
    try {
      const entryId = putEntry(db, "contract", "contractmarker");

      const parentRows = db.prepare("SELECT rowid FROM entries_fts WHERE entries_fts MATCH 'name:contract'").all();
      expect(parentRows).toEqual([{ rowid: entryId }]);
      expect(db.prepare("SELECT entry_id, safe_markdown FROM entry_fragments").all()).toEqual([
        { entry_id: entryId, safe_markdown: fragmentBody("contractmarker") },
      ]);
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

  test("deleteFtsEntries removes exactly the target entry's FTS row and fragment source and no other's", () => {
    const db = openIndexDatabase(tempDbPath());
    try {
      const idA = putEntry(db, "keep-a", "keepamarker");
      const idB = putEntry(db, "delete-me", "deletememarker");
      const idC = putEntry(db, "keep-c", "keepcmarker");

      deleteFtsEntries(db, [idB]);

      const ftsRowids = (
        db.prepare("SELECT rowid FROM entries_fts ORDER BY rowid").all() as Array<{ rowid: number }>
      ).map((row) => row.rowid);
      expect(ftsRowids).toEqual([idA, idC]);
      const fragmentOwners = (
        db.prepare("SELECT entry_id FROM entry_fragments ORDER BY entry_id").all() as Array<{ entry_id: number }>
      ).map((row) => row.entry_id);
      expect(fragmentOwners).toEqual([idA, idC]);
    } finally {
      closeDatabase(db);
    }
  });
});
