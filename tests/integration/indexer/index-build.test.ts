// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `buildIndex` (`src/indexer/index-build.ts`): the one way to build the live
 * index. Every build takes the rebuild lock; while a live process holds it the
 * build is skipped with a warning, never waited for.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { saveConfig } from "../../../src/core/config/config";
import { getDbPath, getIndexRebuildLockPath } from "../../../src/core/paths";
import { _setWarnSinkForTests } from "../../../src/core/warn";
import { buildIndex, isSkippedIndexBuild, withIndexBuildLock } from "../../../src/indexer/index-build";
import { heldRebuildLock } from "../../../src/indexer/index-rebuild-lock";
import * as indexerModule from "../../../src/indexer/indexer";
import { closeDatabase, openExistingDatabase } from "../../../src/storage/repositories/index-connection";
import { type LiveHolder, spawnLiveHolder, stopLiveHolders } from "../../_helpers/live-holder";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../_helpers/sandbox";

let storage: IsolatedAkmStorage;
const lockPath = () => getIndexRebuildLockPath();

let holder: LiveHolder;

function holdLock(): void {
  holder = spawnLiveHolder();
  fs.mkdirSync(path.dirname(lockPath()), { recursive: true });
  fs.writeFileSync(lockPath(), holder.payload(), "utf8");
}

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  saveConfig({ semanticSearchMode: "off" });
  fs.writeFileSync(path.join(storage.stashDir, "knowledge", "a.md"), "# A\n\nBody.\n");
});

afterEach(() => {
  stopLiveHolders();
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
      await buildIndex({ stashDir: storage.stashDir });
    } finally {
      spy.mockRestore();
    }
    expect(heldDuringBuild).toBe(true);
    expect(fs.existsSync(lockPath())).toBe(false);
  });

  test("does not build when a live process holds the lock, warns, and leaves the holder's lock alone", async () => {
    holdLock();
    const notices: string[] = [];
    _setWarnSinkForTests((level, args) => {
      if (level === "warn") notices.push(args.map(String).join(" "));
    });
    const spy = spyOn(indexerModule, "akmIndex");
    try {
      const result = await buildIndex({ stashDir: storage.stashDir });
      expect(isSkippedIndexBuild(result)).toBe(true);
      expect(notices.filter((n) => /another index run holds the lock/.test(n))).toHaveLength(1);
      expect(result).toMatchObject({ skipped: { pid: holder.pid } });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
    expect(JSON.parse(fs.readFileSync(lockPath(), "utf8")).pid).toBe(holder.pid);
  });

  test("builds when the lock is free, and reclaims a dead holder's lock", async () => {
    fs.mkdirSync(path.dirname(lockPath()), { recursive: true });
    fs.writeFileSync(lockPath(), JSON.stringify({ pid: 999_999, startedAt: new Date(0).toISOString() }), "utf8");
    const result = await buildIndex({ stashDir: storage.stashDir });
    expect(isSkippedIndexBuild(result)).toBe(false);
    expect(fs.existsSync(lockPath())).toBe(false);
  });

  test("withIndexBuildLock runs the caller's work and skips its build when a live process holds the lock", async () => {
    holdLock();
    const spy = spyOn(indexerModule, "akmIndex");
    let published = false;
    try {
      const result = await withIndexBuildLock(async (build) => {
        published = true;
        return build({ stashDir: storage.stashDir });
      });
      expect(published).toBe(true);
      expect(isSkippedIndexBuild(result)).toBe(true);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
    expect(JSON.parse(fs.readFileSync(lockPath(), "utf8")).pid).toBe(holder.pid);
  });

  test("a failed build releases the lock", async () => {
    const spy = spyOn(indexerModule, "akmIndex").mockRejectedValueOnce(new Error("boom"));
    try {
      await expect(buildIndex({ stashDir: storage.stashDir })).rejects.toThrow("boom");
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
    await buildIndex({ stashDir: storage.stashDir });
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
    await buildIndex({ stashDir: storage.stashDir });
    expect(hash()).not.toBe(before);
  });

  test("consecutive builds in one process each take and release the lock (no build calls another)", async () => {
    await buildIndex({ stashDir: storage.stashDir });
    await buildIndex({ stashDir: storage.stashDir });
    expect(fs.existsSync(lockPath())).toBe(false);
  });
});
