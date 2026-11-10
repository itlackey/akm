// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Real on-disk corruption of `index.db` (issue #865).
 *
 * Only narrow in-column JSON corruption (a bad `document_json` value inside an
 * otherwise-healthy database) had coverage before this file — nothing garbled
 * actual SQLite page bytes on disk to prove the driver's `SQLITE_CORRUPT`
 * report is handled rather than either crashing the CLI or silently serving an
 * empty index (indistinguishable from "found nothing").
 *
 * `index.db` is documented (src/core/state-db.ts, "Why a separate database
 * from index.db") as fully regenerable from the stash on disk, so a corrupt
 * index is recovered by deleting it and rebuilding — but nothing actually did
 * that delete before this fix (see `openIndexDatabase` in
 * src/storage/repositories/index-connection.ts): a garbled file made every
 * open throw `SQLITE_CORRUPT`, including the rebuild attempt itself, so the
 * final failure reached the user as a raw internal error.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { getDbPath } from "../src/core/paths";
import { openDatabase } from "../src/storage/database";
import { runCliCapture } from "./_helpers/cli";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "./_helpers/sandbox";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  writeSandboxConfig({ semanticSearchMode: "off" });
  fs.writeFileSync(
    path.join(storage.stashDir, "knowledge", "deploy.md"),
    "---\ndescription: Deployment guide\n---\n\nDeploy safely to production.\n",
  );
});

afterEach(() => storage.cleanup());

/**
 * Garble every page after the 100-byte file header so the driver reports
 * `SQLITE_CORRUPT` on the first query that touches any table's data, rather
 * than refusing to open at all (which would test a different, already-covered
 * code path — see index-unreadable-not-absent.test.ts for that one). Leaving
 * only the header intact keeps `openDatabase()` itself succeeding; the
 * corruption surfaces on the first real read, matching what a damaged disk
 * looks like in production.
 */
function corruptDatabaseFile(dbPath: string): void {
  const buf = fs.readFileSync(dbPath);
  for (let i = 100; i < buf.length; i++) buf[i] = 0xff;
  fs.writeFileSync(dbPath, buf);
}

test("real SQLITE_CORRUPT on index.db is detected and the index rebuilds", async () => {
  const built = await runCliCapture(["index", "--full"]);
  expect(built.code).toBe(0);

  const dbPath = getDbPath();
  expect(fs.existsSync(dbPath)).toBe(true);

  // Sanity: the healthy index actually finds the entry before we break it.
  const before = await runCliCapture(["search", "deployment", "--format=json"]);
  expect(before.code).toBe(0);
  expect(JSON.parse(before.stdout).results.length).toBeGreaterThan(0);

  // `akm index` leaves data in the WAL file, not `index.db` itself — garbling
  // only the main file would corrupt bytes SQLite never actually reads.
  // Checkpoint first so the real data lands on disk in the file we damage,
  // matching what a genuinely damaged index.db looks like in production.
  const checkpointDb = openDatabase(dbPath);
  checkpointDb.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  checkpointDb.close();

  corruptDatabaseFile(dbPath);

  // This is the CRITICAL isolation check: prove the corrupted file lives
  // inside this test's own sandboxed data dir, never the developer's real
  // index — never $HOME/.akm or anything outside `storage.root`.
  expect(path.resolve(dbPath).startsWith(path.resolve(storage.dataDir))).toBe(true);

  const after = await runCliCapture(["search", "deployment", "--format=json"]);

  // The corrupt-index gap this issue is about: silently answering "no hits"
  // is indistinguishable from a genuine empty result. Detecting SQLITE_CORRUPT
  // must rebuild and answer correctly again, not quietly go blank.
  expect(after.code).toBe(0);
  const hits = JSON.parse(after.stdout).results;
  expect(hits.length).toBeGreaterThan(0);
  expect(hits.some((hit: { ref?: string }) => hit.ref?.includes("deploy"))).toBe(true);
});
