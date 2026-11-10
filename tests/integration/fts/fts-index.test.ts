// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deriveEntryProvenance } from "../../../src/indexer/installations";
import { type IndexDocument, setMarkdownFragmentContent } from "../../../src/indexer/passes/metadata";
import type { Database } from "../../../src/storage/database";
import { closeDatabase, openIndexDatabase } from "../../../src/storage/repositories/index-connection";
import { upsertEntry } from "../../../src/storage/repositories/index-entries-repository";
import { deleteFtsEntries, rebuildFts, searchFts } from "../../../src/storage/repositories/index-fts-repository";
import { type Cleanup, sandboxXdgCacheHome, sandboxXdgConfigHome } from "../../_helpers/sandbox";

describe("fts-query-error-warn", () => {
  /**
   * Regression: runFtsQuery must propagate a genuine query failure (e.g. a
   * corrupt/missing `entries_fts` table) instead of swallowing it and returning
   * `[]` — a silent `[]` here is indistinguishable from "no matches" to
   * `db-search.ts` and its callers, which is exactly the false "no results"
   * answer a corrupt or locked index must never produce.
   */

  const createdTmpDirs: string[] = [];

  function tmpDbPath(label = "fts-warn"): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `akm-${label}-`));
    createdTmpDirs.push(dir);
    return path.join(dir, "test.db");
  }

  afterAll(() => {
    for (const dir of createdTmpDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  let envCleanup: Cleanup = () => {};

  beforeEach(() => {
    const cacheResult = sandboxXdgCacheHome();
    const cfgResult = sandboxXdgConfigHome(cacheResult.cleanup);
    envCleanup = cfgResult.cleanup;
  });

  afterEach(() => {
    envCleanup();
    envCleanup = () => {};
  });

  function insertEntry(db: Database, key: string, entry: IndexDocument): number {
    const provenance = deriveEntryProvenance(
      { bundleId: "test-bundle", componentId: "test-bundle", adapterId: "akm" },
      entry.type,
      key,
    );
    return upsertEntry(db, `/test/dir/${key}.ts`, entry, provenance);
  }

  describe("runFtsQuery error handling", () => {
    test("propagates a query error instead of silently returning []", () => {
      const db = openIndexDatabase(tmpDbPath());
      try {
        insertEntry(db, "deploy", { name: "deploy", type: "script", description: "deploy things" });
        rebuildFts(db);

        // Sanity: query works before we break the schema.
        expect(searchFts(db, "deploy", 10).length).toBe(1);

        // Break the FTS virtual table so the MATCH query throws inside runFtsQuery.
        db.exec("DROP TABLE entries_fts");

        expect(() => searchFts(db, "deploy", 10)).toThrow(/entries_fts/);
      } finally {
        closeDatabase(db);
      }
    });
  });
});

describe("fts-rowid-maintenance", () => {
  // Opens a real index.db (openIndexDatabase / bun:sqlite or better-sqlite3),
  // so this belongs under tests/integration/ per the ORG-03/04/05/06
  // classification rule.
  //
  // Covers the FTS rowid maintenance contract: entries_fts.rowid = entry_id,
  // constant upsert cost as the tables grow, and that a targeted delete removes
  // exactly its own entry's FTS row and fragment source. (The layout-23 → 24
  // rebuild that establishes the contract on an older index is no longer a
  // migration: an index below the layout floor is rebuilt from the sources.)

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
    upsertEntry(db, `/fixture/knowledge/${name}.md`, entry, provenance);
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
          upsertEntry(db, `/fixture/knowledge/${name}.md`, entry, provenance);
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
});
