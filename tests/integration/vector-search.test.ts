/**
 * Coverage for the legacy `embeddings`/`entries_vec` BLOB-vector repository
 * surface that outlives the old hybrid search path (index-redesign B5c).
 *
 * `searchVec`, the old `tryVecScores` hybrid scorer (FTS 0.7 + vec 0.3
 * weights, NaN/Infinity distance guard), and the `combineSearchScores`/
 * `normalizeFtsScores` fusion this file used to cover are all deleted: the
 * units search path (`db-search.ts`, `ranking.ts`'s `fuseByEntry`) is the
 * only search path now, and `searchVec` had no other caller. What remains —
 * `getAllEntriesForEmbedding` — still backs `materialize-embeddings.ts`
 * (index-redesign B5b's removal target, out of scope here), so its coverage
 * is kept rather than deleted alongside the search-path tests.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deriveEntryProvenance } from "../../src/indexer/installations";
import type { IndexDocument } from "../../src/indexer/passes/metadata";
import type { Database } from "../../src/storage/database";
import { closeDatabase, openIndexDatabase } from "../../src/storage/repositories/index-connection";
import { upsertEntry } from "../../src/storage/repositories/index-entries-repository";
import { getAllEntriesForEmbedding } from "../../src/storage/repositories/index-vec-repository";
import { type Cleanup, sandboxXdgCacheHome, sandboxXdgConfigHome } from "../_helpers/sandbox";

const createdTmpDirs: string[] = [];

function createTmpDir(prefix = "akm-vec-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  createdTmpDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of createdTmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tmpDbPath(label = "vec"): string {
  const dir = createTmpDir(`akm-${label}-`);
  return path.join(dir, "test.db");
}

function makeEntry(overrides: Partial<IndexDocument> & { name: string; type: string }): IndexDocument {
  return {
    description: "A test entry",
    ...overrides,
  };
}

function insertTestEntry(db: Database, key: string): number {
  const entry = makeEntry({ name: key, type: "script", description: `Description for ${key}` });
  return upsertEntry(
    db,
    path.join("/test/stash", `${key}.ts`),
    entry,
    `${key} ${entry.description}`,
    deriveEntryProvenance({ bundleId: "stash", componentId: "stash", adapterId: "akm" }, "script", key),
  );
}

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

describe("targeted embedding selection", () => {
  test("queries only requested missing entry IDs", () => {
    const db = openIndexDatabase(tmpDbPath("targeted-selection"));
    try {
      const unrelatedId = insertTestEntry(db, "unrelated-missing");
      const targetId = insertTestEntry(db, "target-missing");

      expect(getAllEntriesForEmbedding(db, [targetId, targetId]).map((entry) => entry.id)).toEqual([targetId]);
      expect(getAllEntriesForEmbedding(db, [unrelatedId]).map((entry) => entry.id)).toEqual([unrelatedId]);
      expect(getAllEntriesForEmbedding(db, [])).toEqual([]);
    } finally {
      closeDatabase(db);
    }
  });
});
