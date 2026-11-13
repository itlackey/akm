// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `ensureIndex()`, improve's pre-run index: an incremental build under the
 * rebuild lock in `"try"` mode. Its per-file fingerprints decide what changed, in
 * every bundle; when a live process holds the lock it builds nothing and says so.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { saveConfig } from "../../../src/core/config/config";
import { getDbPath, getIndexRebuildLockPath } from "../../../src/core/paths";
import { ensureIndex } from "../../../src/indexer/ensure-index";
import { isSkippedIndexBuild } from "../../../src/indexer/index-build";
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

describe("ensureIndex (improve's pre-run index)", () => {
  test("a content-stale index is rebuilt incrementally", async () => {
    const added = writeMemory("second");
    const result = await ensureIndex(stashDir);
    expect(result).toMatchObject({ mode: "incremental" });
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
      await ensureIndex(stashDir);
      expect(indexedPaths().has(otherFile)).toBe(true);
      const before = hashOf(otherFile);

      fs.writeFileSync(otherFile, "---\ndescription: elsewhere edited\n---\n\n# elsewhere\n\nEdited body.\n", "utf8");
      await ensureIndex(stashDir);
      expect(hashOf(otherFile)).not.toBe(before);
    } finally {
      other.cleanup();
    }
  });

  test("onReindexTiming fires with a duration when the build runs", async () => {
    writeMemory("second");
    const timings: Array<{ durationMs: number }> = [];
    await ensureIndex(stashDir, { onReindexTiming: (t) => timings.push(t) });
    expect(timings).toHaveLength(1);
    expect(timings[0]?.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("a live process holding the rebuild lock: nothing is built, the result says skipped, no timing is reported", async () => {
    const lockPath = getIndexRebuildLockPath();
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), "utf8");
    const added = writeMemory("second");
    const timings: unknown[] = [];
    try {
      const result = await ensureIndex(stashDir, { onReindexTiming: (t) => timings.push(t) });
      expect(isSkippedIndexBuild(result)).toBe(true);
      expect(timings).toEqual([]);
      expect(indexedPaths().has(added)).toBe(false);
    } finally {
      fs.rmSync(lockPath, { force: true });
    }
  });

  test("a failed build propagates the error and releases the lock", async () => {
    const spy = spyOn(indexerModule, "akmIndex").mockRejectedValueOnce(new Error("boom"));
    try {
      await expect(ensureIndex(stashDir)).rejects.toThrow("boom");
    } finally {
      spy.mockRestore();
    }
    expect(fs.existsSync(getIndexRebuildLockPath())).toBe(false);
  });
});
