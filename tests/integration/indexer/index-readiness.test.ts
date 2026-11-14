// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The one "is there a usable index for this library?" check
 * (`src/indexer/index-readiness.ts`): the keyword data for the library is
 * persisted. Reads serve a usable index as it is (content freshness is the
 * writers' job) and never build one.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { getDbPath } from "../../../src/core/paths";
import { openUsableIndex } from "../../../src/indexer/index-readiness";
import * as indexerModule from "../../../src/indexer/indexer";
import { openDatabase } from "../../../src/storage/database";
import { closeDatabase, openExistingDatabase } from "../../../src/storage/repositories/index-connection";
import { deleteMeta, setMeta } from "../../../src/storage/repositories/index-meta-repository";
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

/** Whether the library is usable; closes the handle `openUsableIndex` hands out. */
function usable(): { complete: boolean } | undefined {
  const index = openUsableIndex(stashDir);
  if (!index) return undefined;
  closeDatabase(index.db);
  return { complete: index.complete };
}

function editMeta(edit: (db: ReturnType<typeof openExistingDatabase>) => void): void {
  const db = openExistingDatabase(getDbPath());
  try {
    edit(db);
  } finally {
    closeDatabase(db);
  }
}

describe("usable index", () => {
  test("a built index is usable and complete", () => {
    expect(usable()).toEqual({ complete: true });
  });

  test("content-stale is still usable: reads serve it as it is", () => {
    writeMemory("second");
    expect(usable()).toEqual({ complete: true });
  });

  test("no index file: not usable, and nothing is created", () => {
    fs.rmSync(getDbPath());
    expect(usable()).toBeUndefined();
    expect(fs.existsSync(getDbPath())).toBe(false);
  });

  test("keyword data persisted but no builtAt (a build still embedding, or interrupted): usable, not complete", () => {
    editMeta((db) => deleteMeta(db, "builtAt"));
    expect(usable()).toEqual({ complete: false });
  });

  test("an index an older akm finished (builtAt, stashDir and stashDirs from its finalize) is usable as it is", () => {
    editMeta((db) => {
      setMeta(db, "builtAt", "2026-01-01T00:00:00.000Z");
      setMeta(db, "stashDir", stashDir);
      setMeta(db, "stashDirs", JSON.stringify([stashDir]));
    });
    expect(usable()).toEqual({ complete: true });
  });

  test("a stashDirs entry other than stashDir also names the library", () => {
    editMeta((db) => {
      setMeta(db, "stashDir", "/somewhere/else");
      setMeta(db, "stashDirs", JSON.stringify(["/somewhere/else", stashDir]));
    });
    expect(usable()).toEqual({ complete: true });
  });

  test("an index built for a different library is not usable", () => {
    editMeta((db) => {
      setMeta(db, "stashDir", "/somewhere/else");
      setMeta(db, "stashDirs", JSON.stringify(["/somewhere/else"]));
    });
    expect(usable()).toBeUndefined();
  });

  test("an indexed empty library is usable", async () => {
    fs.rmSync(path.join(stashDir, "memories", "first.md"));
    await indexerModule.akmIndex({ stashDir, full: true });
    expect(usable()).toEqual({ complete: true });
  });

  test("a populated pre-layout-21 index is not usable (no current entries table)", () => {
    replaceWithPopulatedV17Index();
    expect(usable()).toBeUndefined();
  });

  test("a populated layout-20 index (0.9.1) is not usable until a build migrates it (#1053)", () => {
    replaceWithPopulatedV20Index();
    expect(usable()).toBeUndefined();
  });

  test("a corrupt file is not usable and is not deleted", () => {
    for (const suffix of ["-wal", "-shm"]) fs.rmSync(`${getDbPath()}${suffix}`, { force: true });
    fs.writeFileSync(getDbPath(), Buffer.alloc(4096, 0xff));
    expect(usable()).toBeUndefined();
    expect(fs.existsSync(getDbPath())).toBe(true);
  });
});
