// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Tests for the read-vs-blocking `ensureIndex()` contract.
 *
 * Read paths (default/background mode) serve any index that completed a build
 * for this stash AS-IS — content freshness is the writers' job
 * (`indexWrittenAssets`) plus full runs (improve cron / explicit `akm index`).
 * They rebuild inline only when the index cannot serve at all (missing DB, no
 * `builtAt`, different stash). An indexed empty stash is built, not unusable. This replaced the stale-triggered background
 * reindex that made every read on an actively-written stash spawn a writer
 * (docs/design/read-path-reindex-contention-findings.md §7).
 *
 * Blocking mode (improve) runs an incremental index and lets its per-file
 * fingerprints decide, in every bundle.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { saveConfig } from "../../../src/core/config/config";
import { getDbPath } from "../../../src/core/paths";
import { ensureIndex } from "../../../src/indexer/ensure-index";
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

function hashOf(filePath: string): string | undefined {
  const db = openExistingDatabase(getDbPath());
  try {
    return (
      db.prepare("SELECT content_hash FROM entries WHERE file_path = ?").get(filePath) as
        | { content_hash: string }
        | undefined
    )?.content_hash;
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

/** The index 0.9.1 wrote (`index-v20.sql`): the retired columns beside the current ones, `document_json` NULL, built for this stash. */
function replaceWithPopulatedV20Index(): void {
  const dbPath = getDbPath();
  for (const candidate of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) fs.rmSync(candidate, { force: true });
  const fixture = path.join(import.meta.dir, "..", "..", "fixtures", "previous-release-corpus", "index-v20.sql");
  const legacy = openDatabase(dbPath);
  try {
    legacy.exec(fs.readFileSync(fixture, "utf8").replaceAll("/fixture/stash", stashDir.replaceAll("'", "''")));
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

  test("a populated pre-layout-21 index opens without refusal but cannot serve the stash", async () => {
    replaceWithPopulatedV17Index();
    closeDatabase(openExistingDatabase(getDbPath()));
    expect(await ensureIndex(stashDir)).toBe(true);
  });

  test("an indexed empty stash is built: a read does not reindex", async () => {
    fs.rmSync(path.join(stashDir, "memories", "first.md"));
    await indexerModule.akmIndex({ stashDir, full: true });
    expect(indexedPaths().size).toBe(0);

    const spy = spyOn(indexerModule, "akmIndex");
    try {
      expect(await ensureIndex(stashDir)).toBe(false);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  test("an index that never finished a build (no builtAt) rebuilds inline", async () => {
    const db = openExistingDatabase(getDbPath());
    try {
      db.prepare("DELETE FROM index_meta WHERE key = 'builtAt'").run();
    } finally {
      closeDatabase(db);
    }
    expect(await ensureIndex(stashDir)).toBe(true);
  });

  test("a populated layout-20 index (0.9.1) cannot serve the stash, so a read rebuilds it first (#1053)", async () => {
    replaceWithPopulatedV20Index();
    closeDatabase(openExistingDatabase(getDbPath()));

    expect(await ensureIndex(stashDir)).toBe(true);
    expect(indexedPaths()).toContain(path.join(stashDir, "memories", "first.md"));
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

  test("an edit in a non-primary bundle is picked up", async () => {
    const other = sandboxStashDir();
    try {
      saveConfig({
        semanticSearchMode: "off",
        bundles: { stash: { path: stashDir }, other: { path: other.dir } },
        defaultBundle: "stash",
        registries: [],
      });
      const otherFile = path.join(other.dir, "memories", "elsewhere.md");
      fs.mkdirSync(path.dirname(otherFile), { recursive: true });
      fs.writeFileSync(otherFile, "---\ndescription: elsewhere\n---\n\n# elsewhere\n\nBody.\n", "utf8");
      expect(await ensureIndex(stashDir, { mode: "blocking" })).toBe(true);
      expect(indexedPaths().has(otherFile)).toBe(true);
      const before = hashOf(otherFile);

      fs.writeFileSync(otherFile, "---\ndescription: elsewhere edited\n---\n\n# elsewhere\n\nEdited body.\n", "utf8");
      expect(await ensureIndex(stashDir, { mode: "blocking" })).toBe(true);
      expect(hashOf(otherFile)).not.toBe(before);
    } finally {
      other.cleanup();
    }
  });

  test("onReindexTiming fires with a duration when the inline index runs", async () => {
    writeMemory("second");
    const timings: Array<{ durationMs: number }> = [];
    expect(await ensureIndex(stashDir, { mode: "blocking", onReindexTiming: (t) => timings.push(t) })).toBe(true);
    expect(timings).toHaveLength(1);
    expect(timings[0]?.durationMs).toBeGreaterThanOrEqual(0);
  });
});
