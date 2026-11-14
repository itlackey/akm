// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm remember` while a live rebuild holds the index rebuild lock (#956
 * addendum): the write must return in seconds and never wait on the rebuild.
 * Write-through does not look for the lock: it upserts into the usable index
 * at once (a build that overlaps the upsert itself is covered in
 * `tests/integration/indexer/index-ownership.test.ts`). Integration-scoped
 * (ORG-03): drives the real CLI via `runCliCapture`, which opens a real index.db.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { saveConfig } from "../../src/core/config/config";
import { getDbPath, getIndexRebuildLockPath } from "../../src/core/paths";
import { openExistingDatabase } from "../../src/storage/repositories/index-connection";
import { runCliCapture } from "../_helpers/cli";
import { type Cleanup, withDefaultBundle, withIsolatedAkmStorage } from "../_helpers/sandbox";

let cleanup: Cleanup = () => {};

beforeEach(() => {
  const storage = withIsolatedAkmStorage();
  cleanup = storage.cleanup;
  saveConfig(withDefaultBundle({ semanticSearchMode: "off" }, storage.stashDir));
});

afterEach(() => {
  cleanup();
  cleanup = () => {};
});

function entryCountForPath(filePath: string): number {
  const db = openExistingDatabase(getDbPath());
  try {
    return (db.prepare("SELECT COUNT(*) AS c FROM entries WHERE file_path = ?").get(filePath) as { c: number }).c;
  } finally {
    db.close();
  }
}

describe("akm remember while a rebuild holds the lock (#956)", () => {
  test("returns quickly, writes the file, and indexes it without looking for the lock", async () => {
    // Seed an index so index.db exists (indexWrittenAssets fails open on an absent index).
    expect((await runCliCapture(["index", "--full", "--format=json"])).code).toBe(0);

    const lockPath = getIndexRebuildLockPath();
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), "utf8");

    const startedAt = Date.now();
    const remembered = await runCliCapture([
      "remember",
      "Deploy runbook note for the staging cluster",
      "--format=json",
    ]);
    const elapsedMs = Date.now() - startedAt;

    expect(remembered.code).toBe(0);
    expect(elapsedMs).toBeLessThan(5_000);
    const parsed = JSON.parse(remembered.stdout) as { ok: boolean; path: string };
    expect(parsed.ok).toBe(true);
    expect(fs.existsSync(parsed.path)).toBe(true);
    expect(entryCountForPath(parsed.path)).toBeGreaterThan(0);
    fs.rmSync(lockPath);
  });
});
