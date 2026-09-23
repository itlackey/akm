// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Tests for the read-vs-blocking `ensureIndex()` contract.
 *
 * Read paths (default/background mode) serve any populated index built for
 * this stash AS-IS — content freshness is the writers' job
 * (`indexWrittenAssets`) plus full runs (improve cron / explicit `akm index`).
 * They rebuild inline only when the index cannot serve at all (missing DB,
 * zero rows, different stash). This replaced the stale-triggered background
 * reindex that made every read on an actively-written stash spawn a writer
 * (docs/design/read-path-reindex-contention-findings.md §7).
 *
 * Blocking mode (improve) still treats content-staleness as a rebuild trigger.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { ConfigError } from "../../../src/core/errors";
import { getDbPath } from "../../../src/core/paths";
import { ensureIndex, isIndexStale } from "../../../src/indexer/ensure-index";
import { indexWrittenAssets } from "../../../src/indexer/index-written-assets";
import * as indexerModule from "../../../src/indexer/indexer";
import { openDatabase } from "../../../src/storage/database";
import { closeDatabase, openExistingDatabase } from "../../../src/storage/repositories/index-connection";
import { getIndexedFilePaths } from "../../../src/storage/repositories/index-entries-repository";
import {
  type Cleanup,
  sandboxEnvDir,
  sandboxStashDir,
  sandboxXdgCacheHome,
  sandboxXdgConfigHome,
} from "../../_helpers/sandbox";

let stashDir = "";
let cleanup: Cleanup = () => {};

function writeMemory(name: string): string {
  const filePath = path.join(stashDir, "memories", `${name}.md`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `---\ndescription: ${name}\n---\n\n# ${name}\n\nBody.\n`, "utf8");
  return filePath;
}

function indexedPaths(): Set<string> {
  const db = openExistingDatabase(getDbPath());
  try {
    return getIndexedFilePaths(db);
  } finally {
    closeDatabase(db);
  }
}

function replaceWithPopulatedV17Index(): void {
  const dbPath = getDbPath();
  for (const candidate of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) fs.rmSync(candidate, { force: true });
  const legacy = openDatabase(dbPath);
  try {
    legacy.exec(`
      CREATE TABLE index_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO index_meta (key, value) VALUES
        ('version', '17'),
        ('stashDir', '${stashDir.replaceAll("'", "''")}'),
        ('stashDirs', '${JSON.stringify([stashDir]).replaceAll("'", "''")}');
      CREATE TABLE entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entry_key TEXT NOT NULL UNIQUE,
        dir_path TEXT NOT NULL,
        file_path TEXT NOT NULL,
        stash_dir TEXT NOT NULL,
        entry_json TEXT NOT NULL,
        search_text TEXT NOT NULL,
        entry_type TEXT NOT NULL
      );
      INSERT INTO entries
        (entry_key, dir_path, file_path, stash_dir, entry_json, search_text, entry_type)
      VALUES
        ('legacy:memory:first', '${path.join(stashDir, "memories").replaceAll("'", "''")}',
         '${path.join(stashDir, "memories", "first.md").replaceAll("'", "''")}',
         '${stashDir.replaceAll("'", "''")}', '{"name":"first","type":"memory"}', 'first', 'memory');
    `);
  } finally {
    legacy.close();
  }
}

beforeEach(async () => {
  const stash = sandboxStashDir();
  stashDir = stash.dir;
  let chain = sandboxXdgConfigHome(stash.cleanup).cleanup;
  chain = sandboxXdgCacheHome(chain).cleanup;
  chain = sandboxEnvDir("akm-ensure-serve-data", "AKM_DATA_DIR", chain).cleanup;
  chain = sandboxEnvDir("akm-ensure-serve-state", "AKM_STATE_DIR", chain).cleanup;
  cleanup = chain;
  writeMemory("first");
  await indexerModule.akmIndex({ stashDir });
});

afterEach(() => {
  cleanup();
});

describe("ensureIndex read-path (background mode)", () => {
  test("fresh servable index: no-op", async () => {
    expect(await ensureIndex(stashDir)).toBe(false);
  });

  test("content-stale but servable index is served AS-IS (no reindex)", async () => {
    const added = writeMemory("second");
    expect(await ensureIndex(stashDir)).toBe(false);
    expect(indexedPaths().has(added)).toBe(false);
  });

  test("missing index rebuilds inline", async () => {
    fs.rmSync(getDbPath());
    expect(await ensureIndex(stashDir)).toBe(true);
    expect(indexedPaths().size).toBeGreaterThan(0);
  });

  test("failed inline rebuild propagates the error", async () => {
    fs.rmSync(getDbPath());
    const spy = spyOn(indexerModule, "akmIndex").mockRejectedValueOnce(new Error("boom"));
    await expect(ensureIndex(stashDir)).rejects.toThrow("boom");
    spy.mockRestore();
  });

  test("a populated pre-current generation is rejected before a reader can query it", () => {
    replaceWithPopulatedV17Index();
    expect(() => openExistingDatabase(getDbPath())).toThrow(ConfigError);
    try {
      openExistingDatabase(getDbPath());
    } catch (error) {
      expect((error as ConfigError).code).toBe("INDEX_SCHEMA_INCOMPATIBLE");
      expect((error as Error).message).toContain("Run 'akm index'");
    }
  });

  test("a populated pre-current generation rebuilds from materialized sources before serving", async () => {
    replaceWithPopulatedV17Index();

    expect(await ensureIndex(stashDir)).toBe(true);
    expect(indexedPaths()).toContain(path.join(stashDir, "memories", "first.md"));

    const db = openExistingDatabase(getDbPath());
    try {
      const row = db.prepare("SELECT item_ref FROM entries LIMIT 1").get() as { item_ref: string } | undefined;
      expect(row?.item_ref).toContain("//memories/first");
    } finally {
      closeDatabase(db);
    }
  });
});

describe("ensureIndex blocking mode (improve)", () => {
  test("content-stale index rebuilds inline", async () => {
    const added = writeMemory("second");
    expect(await ensureIndex(stashDir, { mode: "blocking" })).toBe(true);
    expect(indexedPaths().has(added)).toBe(true);
  });

  test("fresh index: no-op", async () => {
    expect(await ensureIndex(stashDir, { mode: "blocking" })).toBe(false);
  });

  test("onReindexTiming fires with a duration when a rebuild runs, and not when it is a no-op", async () => {
    writeMemory("second");
    const timings: Array<{ durationMs: number }> = [];
    expect(await ensureIndex(stashDir, { mode: "blocking", onReindexTiming: (t) => timings.push(t) })).toBe(true);
    expect(timings).toHaveLength(1);
    expect(timings[0]?.durationMs).toBeGreaterThanOrEqual(0);

    // Fresh now — a second call is a no-op and must not fire the callback.
    const timingsAfterNoop: Array<{ durationMs: number }> = [];
    expect(await ensureIndex(stashDir, { mode: "blocking", onReindexTiming: (t) => timingsAfterNoop.push(t) })).toBe(
      false,
    );
    expect(timingsAfterNoop).toHaveLength(0);
  });
});

/** Deterministic staleness regardless of filesystem mtime resolution (mirrors dir-staleness-precheck.test.ts). */
function bumpMtimeIntoFuture(filePath: string): void {
  const future = new Date(Date.now() + 60_000);
  fs.utimesSync(filePath, future, future);
}

describe("ensureIndex blocking mode: per-file staleness (R6)", () => {
  test("a brand-new file that was never indexed is stale", () => {
    writeMemory("second");
    expect(isIndexStale(stashDir)).toBe(true);
  });

  test(
    "a file indexed incrementally after being written is NOT stale, even though its mtime " +
      "is newer than builtAt (indexWrittenAssets does not bump builtAt)",
    async () => {
      const added = writeMemory("second");
      bumpMtimeIntoFuture(added);
      await indexWrittenAssets(stashDir, [added]);
      expect(indexedPaths().has(added)).toBe(true);

      // Acceptance test: without the R6 per-file staleness check this would
      // still report stale purely from mtime > builtAt, forcing a full
      // rescan on every subsequent call even though the content is current.
      expect(isIndexStale(stashDir)).toBe(false);
    },
  );

  test("a file edited in place after the last build IS stale, even though it was already indexed", () => {
    const filePath = path.join(stashDir, "memories", "first.md");
    fs.writeFileSync(filePath, "---\ndescription: first\n---\n\n# first\n\nEdited body.\n", "utf8");
    bumpMtimeIntoFuture(filePath);

    expect(isIndexStale(stashDir)).toBe(true);
  });
});
