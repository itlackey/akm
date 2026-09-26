// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Issue #759 (1/3) — index GENERATIONS during a full reindex.
 *
 * `persistDirRecords` (src/indexer/indexer.ts) upserts and prunes every
 * directory's rows in ONE `db.transaction(...)` specifically so that a
 * concurrent reader never observes a half-rewritten index. That guarantee had
 * no direct test: by the time `akmIndex()` resolves, the commit has already
 * collapsed both generations into a single observable state, so nothing
 * outside the transaction can tell an atomic rewrite from a piecemeal one.
 *
 * These tests open a SECOND, independent read-only connection to the very same
 * `index.db` file from inside the in-flight transaction (via the
 * `_setIndexTransactionHookForTests` seam) and assert that reader sees exactly
 * the PREVIOUS complete generation — never zero rows, never a mix of the two.
 *
 * Why the seam is unavoidable: SQLite is synchronous, the writer holds the JS
 * thread for the whole transaction, and the property under test is only true
 * *during* a window that does not exist once the call returns. The seam fires
 * one `undefined?.()` call per reindex in production.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { saveConfig } from "../../src/core/config/config";
import { getDbPath } from "../../src/core/paths";
import { _setIndexTransactionHookForTests, akmIndex, type IndexTransactionPoint } from "../../src/indexer/indexer";
import { openReadonlyExistingDatabase } from "../../src/storage/repositories/index-connection";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../_helpers/sandbox";
import { overrideSeam } from "../_helpers/seams";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  saveConfig({
    semanticSearchMode: "off",
    bundles: {
      primary: {
        path: storage.stashDir,
        writable: true,
        components: { main: { root: ".", adapter: "akm", writable: true } },
      },
    },
    defaultBundle: "primary",
  });
});

afterEach(() => storage.cleanup());

function writeKnowledge(name: string, body: string): void {
  const file = path.join(storage.stashDir, "knowledge", `${name}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `---\ndescription: ${name}\n---\n\n# ${name}\n\n${body}\n`, "utf8");
}

/**
 * Read `entries` through a SEPARATE connection to the same file — the whole
 * point of the exercise, so this deliberately does not reuse the indexer's
 * connection or any managed/cached opener.
 */
function readEntryNamesFromSecondConnection(): string[] {
  const db = openReadonlyExistingDatabase(getDbPath());
  if (!db) throw new Error("second reader could not open index.db");
  try {
    const rows = db.prepare("SELECT concept_id FROM entries ORDER BY concept_id").all() as {
      concept_id: string;
    }[];
    return rows.map((row) => row.concept_id);
  } finally {
    db.close();
  }
}

function currentEntryNames(): string[] {
  return readEntryNamesFromSecondConnection();
}

test("a concurrent reader never observes an empty or partial index mid-reindex", async () => {
  // Generation 1: four documents.
  const generationOne = ["alpha", "bravo", "charlie", "delta"];
  for (const name of generationOne) writeKnowledge(name, `Body for ${name}.`);
  await akmIndex({ stashDir: storage.stashDir, full: true });
  const beforeNames = currentEntryNames();
  expect(beforeNames.length).toBe(generationOne.length);

  // Generation 2 has a DIFFERENT row set: two survivors, two removals, two
  // additions. A reader that saw a partial rebuild would report some blend of
  // the two — the assertion below rejects anything that is not exactly gen 1.
  fs.rmSync(path.join(storage.stashDir, "knowledge", "charlie.md"));
  fs.rmSync(path.join(storage.stashDir, "knowledge", "delta.md"));
  writeKnowledge("echo", "Body for echo.");
  writeKnowledge("foxtrot", "Body for foxtrot.");
  const generationTwo = ["alpha", "bravo", "echo", "foxtrot"].map((n) => `knowledge/${n}`);

  const observations: { point: IndexTransactionPoint; names: string[] }[] = [];
  overrideSeam(_setIndexTransactionHookForTests, (point: IndexTransactionPoint) => {
    observations.push({ point, names: readEntryNamesFromSecondConnection() });
  });

  await akmIndex({ stashDir: storage.stashDir, full: true });

  // THE property: while the writer had already rewritten and pruned the
  // tables, the concurrent reader still saw generation 1 whole. Never
  // transiently empty, never a partial/mixed blend of the two.
  for (const observation of observations) {
    expect({ point: observation.point, empty: observation.names.length === 0 }).toEqual({
      point: observation.point,
      empty: false,
    });
    expect(observation.names).toEqual(beforeNames);
  }

  // The race really interleaved: the in-transaction point fired exactly once.
  expect(observations.map((o) => o.point)).toEqual(["records-persisted"]);

  // And once committed, the new generation is fully visible.
  expect(currentEntryNames()).toEqual(generationTwo);
});

test("the mid-transaction reader is a real second connection, not the writer's own", async () => {
  writeKnowledge("solo", "Only document.");
  await akmIndex({ stashDir: storage.stashDir, full: true });

  // Sanity check on the harness itself: a WAL reader opened during the write
  // transaction must be able to read at all (i.e. it is not silently throwing
  // and being swallowed), and it must NOT see uncommitted writer state.
  let rowsSeenInsideTransaction = -1;
  let openedInsideTransaction = 0;
  writeKnowledge("second", "Added document.");
  overrideSeam(_setIndexTransactionHookForTests, (point: IndexTransactionPoint) => {
    if (point !== "records-persisted") return;
    openedInsideTransaction++;
    const db = openReadonlyExistingDatabase(getDbPath());
    if (!db) throw new Error("second reader could not open index.db");
    try {
      const row = db.prepare("SELECT COUNT(*) AS n FROM entries").get() as { n: number };
      rowsSeenInsideTransaction = row.n;
    } finally {
      db.close();
    }
  });

  await akmIndex({ stashDir: storage.stashDir, full: true });

  // The writer had already inserted `second` when the hook fired; a reader
  // that saw 2 rows would mean the write had escaped its transaction.
  expect(rowsSeenInsideTransaction).toBe(1);
  expect(openedInsideTransaction).toBe(1);
  expect(currentEntryNames()).toEqual(["knowledge/second", "knowledge/solo"]);
});
