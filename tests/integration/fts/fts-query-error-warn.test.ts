// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Regression: runFtsQuery must propagate a genuine query failure (e.g. a
 * corrupt/missing `entries_fts` table) instead of swallowing it and returning
 * `[]` — a silent `[]` here is indistinguishable from "no matches" to
 * `db-search.ts` and its callers, which is exactly the false "no results"
 * answer a corrupt or locked index must never produce.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deriveEntryProvenance } from "../../../src/indexer/installations";
import type { IndexDocument } from "../../../src/indexer/passes/metadata";
import type { Database } from "../../../src/storage/database";
import { closeDatabase, openIndexDatabase } from "../../../src/storage/repositories/index-connection";
import { upsertEntry } from "../../../src/storage/repositories/index-entries-repository";
import { rebuildFts, searchFts } from "../../../src/storage/repositories/index-fts-repository";
import { type Cleanup, sandboxXdgCacheHome, sandboxXdgConfigHome } from "../../_helpers/sandbox";

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
