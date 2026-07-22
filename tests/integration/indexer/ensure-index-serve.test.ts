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
import { getDbPath } from "../../../src/core/paths";
import { ensureIndex } from "../../../src/indexer/ensure-index";
import * as indexerModule from "../../../src/indexer/indexer";
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

  test("failed inline rebuild reports failure", async () => {
    fs.rmSync(getDbPath());
    const spy = spyOn(indexerModule, "akmIndex").mockRejectedValueOnce(new Error("boom"));
    expect(await ensureIndex(stashDir)).toBe(false);
    spy.mockRestore();
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
});
