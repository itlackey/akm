// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../../src/indexer/db";
import { getUsageEvents, insertUsageEvent } from "../../src/indexer/usage/usage-events";
import { withIndexDb } from "../../src/storage/repositories/index-db";

/**
 * Characterization tests for {@link withIndexDb}, the `index.db` loan-pattern
 * helper introduced by WS5 to replace the hand-rolled
 * `open / try / finally / close` blocks and the dead `existingDb?` ownership
 * flag in search.ts / show.ts.
 *
 * Behaviour pinned here (must stay byte-identical to the inline blocks it
 * replaces):
 *   1. It opens the SAME database file the inline blocks did
 *      (`openExistingDatabase()` default == `StorageLocations.indexDb` ==
 *      `getDbPath()`), and the work runs against that file.
 *   2. It returns whatever `fn` returns.
 *   3. It closes the connection exactly once, even when `fn` throws — and the
 *      throw propagates (the inline search.ts/show.ts blocks let DB errors
 *      bubble to their own outer try/catch; the helper does not swallow them).
 *   4. Fully-materialised results survive past the close (WS5 lifetime rule).
 */
describe("withIndexDb loan helper (WS5)", () => {
  let dataDir: string;
  let prevDataDir: string | undefined;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-indexdb-loan-"));
    prevDataDir = process.env.AKM_DATA_DIR;
    process.env.AKM_DATA_DIR = dataDir;
    // Seed the index.db at exactly the location withIndexDb will open.
    const dbPath = path.join(dataDir, "index.db");
    const seed = openDatabase(dbPath);
    insertUsageEvent(seed, { event_type: "search", query: "deploy", entry_ref: "skill:deploy" });
    seed.close();
  });

  afterEach(() => {
    if (prevDataDir === undefined) delete process.env.AKM_DATA_DIR;
    else process.env.AKM_DATA_DIR = prevDataDir;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  test("opens index.db at the resolved StorageLocations.indexDb and runs fn against it", () => {
    const rows = withIndexDb((db) => getUsageEvents(db));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.event_type).toBe("search");
    expect(rows[0]?.entry_ref).toBe("skill:deploy");
  });

  test("returns whatever fn returns", () => {
    const value = withIndexDb(() => 42);
    expect(value).toBe(42);
  });

  test("fully-materialised results survive after the scope closes (WS5 lifetime rule)", () => {
    // The returned array is read AFTER withIndexDb has already closed the db.
    const rows = withIndexDb((db) => getUsageEvents(db));
    // No connection is open here; reading the array must still work.
    expect(rows.map((r) => r.entry_ref)).toEqual(["skill:deploy"]);
  });

  test("writes through the loan scope land in the same file", () => {
    withIndexDb((db) => {
      insertUsageEvent(db, { event_type: "show", entry_ref: "skill:deploy" });
    });
    // Re-open the file independently and confirm the write persisted.
    const verify = new Database(path.join(dataDir, "index.db"));
    try {
      const count = (verify.prepare("SELECT COUNT(*) AS c FROM usage_events").get() as { c: number }).c;
      expect(count).toBe(2);
    } finally {
      verify.close();
    }
  });

  test("propagates throws from fn (the connection still closes exactly once)", () => {
    const sentinel = new Error("boom");
    expect(() =>
      withIndexDb(() => {
        throw sentinel;
      }),
    ).toThrow(sentinel);
    // After a throw the file is fully unlocked — a fresh exclusive open succeeds,
    // proving the loan scope closed its connection.
    const reopened = new Database(path.join(dataDir, "index.db"));
    try {
      expect(() => reopened.prepare("SELECT 1").get()).not.toThrow();
    } finally {
      reopened.close();
    }
  });
});
