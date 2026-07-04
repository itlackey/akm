// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Regression: runFtsQuery must surface query errors via warn() rather than
 * swallowing them and returning [] silently (matching sibling searchBlobVec).
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _setWarnSinkForTests } from "../src/core/warn";
import { closeDatabase, openIndexDatabase, rebuildFts, searchFts, upsertEntry } from "../src/indexer/db/db";
import type { StashEntry } from "../src/indexer/passes/metadata";
import type { Database } from "../src/storage/database";
import { type Cleanup, sandboxXdgCacheHome, sandboxXdgConfigHome } from "./_helpers/sandbox";
import { overrideSeam } from "./_helpers/seams";

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
let warnCalls: string[] = [];

beforeEach(() => {
  const cacheResult = sandboxXdgCacheHome();
  const cfgResult = sandboxXdgConfigHome(cacheResult.cleanup);
  envCleanup = cfgResult.cleanup;
  warnCalls = [];
  overrideSeam(_setWarnSinkForTests, (level, args) => {
    if (level !== "warn") return;
    warnCalls.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  });
});

afterEach(() => {
  envCleanup();
  envCleanup = () => {};
  warnCalls = [];
});

function insertEntry(db: Database, key: string, entry: StashEntry, searchText: string): number {
  return upsertEntry(db, key, "/test/dir", `/test/dir/${key}.ts`, "/test/stash", entry, searchText);
}

describe("runFtsQuery error handling", () => {
  test("warns instead of silently returning [] when the FTS query errors", () => {
    const db = openIndexDatabase(tmpDbPath());
    try {
      insertEntry(db, "deploy", { name: "deploy", type: "script", description: "deploy things" }, "deploy");
      rebuildFts(db);

      // Sanity: query works before we break the schema.
      expect(searchFts(db, "deploy", 10).length).toBe(1);

      // Break the FTS virtual table so the MATCH query throws inside runFtsQuery.
      db.exec("DROP TABLE entries_fts");
      warnCalls = [];

      const results = searchFts(db, "deploy", 10);

      // Behavior on error is unchanged: empty result set.
      expect(results).toEqual([]);
      // But the error must now be surfaced via warn(), not swallowed.
      expect(warnCalls.some((m) => m.includes("runFtsQuery"))).toBe(true);
    } finally {
      closeDatabase(db);
    }
  });
});
