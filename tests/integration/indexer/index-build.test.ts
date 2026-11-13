// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `buildIndex` (`src/indexer/index-build.ts`): the one way to build the live
 * index. Every build takes the rebuild lock; `"wait"` waits for a running build
 * (notice, then build, bounded by `INDEX_DB_CONTENDED`), `"try"` steps aside.
 * New behaviour: before it, only `akm index` took the lock and a held lock meant
 * "warn and build unlocked".
 *
 * The lock is held by this test process's own pid, released by the test, so
 * nothing here depends on timing beyond short polls.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { saveConfig } from "../../../src/core/config/config";
import { TransientError } from "../../../src/core/errors";
import { getDbPath, getIndexRebuildLockPath } from "../../../src/core/paths";
import { _setWarnSinkForTests } from "../../../src/core/warn";
import { _setIndexBuildWaitTimingForTests, buildIndex, isSkippedIndexBuild } from "../../../src/indexer/index-build";
import { heldRebuildLock } from "../../../src/indexer/index-rebuild-lock";
import * as indexerModule from "../../../src/indexer/indexer";
import { closeDatabase, openExistingDatabase } from "../../../src/storage/repositories/index-connection";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../_helpers/sandbox";

let storage: IsolatedAkmStorage;
const lockPath = () => getIndexRebuildLockPath();

function holdLock(): void {
  fs.mkdirSync(path.dirname(lockPath()), { recursive: true });
  fs.writeFileSync(lockPath(), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), "utf8");
}

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  saveConfig({ semanticSearchMode: "off" });
  fs.writeFileSync(path.join(storage.stashDir, "knowledge", "a.md"), "# A\n\nBody.\n");
});

afterEach(() => {
  _setIndexBuildWaitTimingForTests(undefined);
  _setWarnSinkForTests(undefined);
  storage.cleanup();
});

describe("buildIndex", () => {
  test("holds the rebuild lock while the build runs and releases it after", async () => {
    let heldDuringBuild = false;
    const spy = spyOn(indexerModule, "akmIndex");
    spy.mockImplementationOnce(async (options) => {
      heldDuringBuild = heldRebuildLock() !== undefined;
      return indexerModule.akmIndex(options);
    });
    try {
      await buildIndex({ stashDir: storage.stashDir }, "wait");
    } finally {
      spy.mockRestore();
    }
    expect(heldDuringBuild).toBe(true);
    expect(fs.existsSync(lockPath())).toBe(false);
  });

  test('"try" does not build when a live process holds the lock, and leaves the holder\'s lock alone', async () => {
    holdLock();
    const spy = spyOn(indexerModule, "akmIndex");
    try {
      const result = await buildIndex({ stashDir: storage.stashDir }, "try");
      expect(isSkippedIndexBuild(result)).toBe(true);
      expect(result).toMatchObject({ skipped: { pid: process.pid } });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
    expect(JSON.parse(fs.readFileSync(lockPath(), "utf8")).pid).toBe(process.pid);
  });

  test('"try" builds when the lock is free, and reclaims a dead holder\'s lock', async () => {
    fs.mkdirSync(path.dirname(lockPath()), { recursive: true });
    fs.writeFileSync(lockPath(), JSON.stringify({ pid: 999_999, startedAt: new Date(0).toISOString() }), "utf8");
    const result = await buildIndex({ stashDir: storage.stashDir }, "try");
    expect(isSkippedIndexBuild(result)).toBe(false);
    expect(fs.existsSync(lockPath())).toBe(false);
  });

  test('"wait" prints a notice while a live process holds the lock, then builds once it is released', async () => {
    holdLock();
    const notices: string[] = [];
    _setWarnSinkForTests((level, args) => {
      if (level === "warn") notices.push(args.map(String).join(" "));
    });
    const build = buildIndex({ stashDir: storage.stashDir }, "wait");
    await new Promise((resolve) => setTimeout(resolve, 350));
    // Still waiting: nothing has built beside the holder.
    expect(JSON.parse(fs.readFileSync(lockPath(), "utf8")).pid).toBe(process.pid);
    fs.rmSync(lockPath());
    const result = await build;
    expect(isSkippedIndexBuild(result)).toBe(false);
    expect(notices.filter((n) => /waiting for another index run/.test(n))).toHaveLength(1);
    expect(fs.existsSync(lockPath())).toBe(false);
  });

  test('"wait" repeats the notice at its cadence', async () => {
    holdLock();
    _setIndexBuildWaitTimingForTests({ noticeIntervalMs: 100 });
    const notices: string[] = [];
    _setWarnSinkForTests((level, args) => {
      if (level === "warn") notices.push(args.map(String).join(" "));
    });
    const build = buildIndex({ stashDir: storage.stashDir }, "wait");
    await new Promise((resolve) => setTimeout(resolve, 450));
    fs.rmSync(lockPath());
    await build;
    expect(notices.filter((n) => /waiting for another index run/.test(n)).length).toBeGreaterThanOrEqual(3);
  });

  test('"wait" gives up past its bound with INDEX_DB_CONTENDED, without building', async () => {
    holdLock();
    _setIndexBuildWaitTimingForTests({ maxWaitMs: 250 });
    const spy = spyOn(indexerModule, "akmIndex");
    try {
      const error = await buildIndex({ stashDir: storage.stashDir }, "wait").catch((e) => e);
      expect(error).toBeInstanceOf(TransientError);
      expect((error as TransientError).code).toBe("INDEX_DB_CONTENDED");
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  test('"wait" stops waiting when its signal aborts', async () => {
    holdLock();
    const controller = new AbortController();
    const build = buildIndex({ stashDir: storage.stashDir, signal: controller.signal }, "wait");
    setTimeout(() => controller.abort(new Error("index interrupted")), 150);
    await expect(build).rejects.toThrow("index interrupted");
  });

  test("a failed build releases the lock", async () => {
    const spy = spyOn(indexerModule, "akmIndex").mockRejectedValueOnce(new Error("boom"));
    try {
      await expect(buildIndex({ stashDir: storage.stashDir }, "wait")).rejects.toThrow("boom");
    } finally {
      spy.mockRestore();
    }
    expect(fs.existsSync(lockPath())).toBe(false);
  });

  test("an incremental build picks up an edit in a non-primary bundle", async () => {
    const other = path.join(storage.root, "other-bundle");
    fs.mkdirSync(path.join(other, "memories"), { recursive: true });
    const file = path.join(other, "memories", "elsewhere.md");
    fs.writeFileSync(file, "---\ndescription: elsewhere\n---\n\n# elsewhere\n\nBody.\n");
    saveConfig({
      semanticSearchMode: "off",
      bundles: { stash: { path: storage.stashDir }, other: { path: other } },
      defaultBundle: "stash",
      registries: [],
    });
    await buildIndex({ stashDir: storage.stashDir }, "wait");
    const hash = () => {
      const db = openExistingDatabase(getDbPath());
      try {
        return (
          db.prepare("SELECT content_hash FROM entries WHERE file_path = ?").get(file) as { content_hash: string }
        ).content_hash;
      } finally {
        closeDatabase(db);
      }
    };
    const before = hash();
    fs.writeFileSync(file, "---\ndescription: elsewhere edited\n---\n\n# elsewhere\n\nEdited body.\n");
    await buildIndex({ stashDir: storage.stashDir }, "wait");
    expect(hash()).not.toBe(before);
  });

  test("consecutive builds in one process each take and release the lock (no build calls another)", async () => {
    await buildIndex({ stashDir: storage.stashDir }, "wait");
    await buildIndex({ stashDir: storage.stashDir }, "wait");
    expect(fs.existsSync(lockPath())).toBe(false);
  });
});
