// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm bundle update` takes the rebuild lock before the asset mutation lease, and when its index step fails after
 * the publish it says the bundle is updated and rethrows the original error.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmUpdate } from "../../src/commands/sources/installed-stashes";
import { saveConfig } from "../../src/core/config/config";
import { TransientError } from "../../src/core/errors";
import { probeLock } from "../../src/core/file-lock";
import { getIndexRebuildLockPath, getIndexWriterLockPath, getRegistryCacheDir } from "../../src/core/paths";
import { _setWarnSinkForTests } from "../../src/core/warn";
import * as indexerModule from "../../src/indexer/indexer";
import { akmIndex } from "../../src/indexer/indexer";
import * as syncFromRefModule from "../../src/sources/providers/sync-from-ref";
import { spawnLiveHolder, stopLiveHolders } from "../_helpers/live-holder";
import { seedLockEntries } from "../_helpers/lockfile";
import { writeMarkdownFiles } from "../_helpers/markdown-fixtures";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../_helpers/sandbox";

const ID = "lock-order-probe";
let storage: IsolatedAkmStorage;

beforeEach(async () => {
  storage = withIsolatedAkmStorage();
  const contentDir = path.join(getRegistryCacheDir(), `${ID}-cache`, "content");
  writeMarkdownFiles(contentDir, 2, "seed");
  saveConfig({
    semanticSearchMode: "off",
    bundles: { [ID]: { npm: ID, components: { main: { root: ".", adapter: "akm", writable: false } } } },
  });
  seedLockEntries([
    {
      id: ID,
      source: "npm",
      ref: `npm:${ID}`,
      resolvedVersion: "1.0.0",
      localRoot: contentDir,
      installedAt: "2026-08-18T00:00:00.000Z",
    },
  ]);
  await akmIndex({ stashDir: storage.stashDir, hydrateSources: false, persistDetectedAdapters: false });
  spyOn(syncFromRefModule, "syncFromRef").mockImplementation(async (_ref, options) => {
    const cacheDir = path.join(options?.cacheRootDir as string, `${ID}-cache`);
    const staged = path.join(cacheDir, "content");
    writeMarkdownFiles(staged, 2, "updated");
    return {
      id: ID,
      source: "npm",
      ref: `npm:${ID}`,
      artifactUrl: `https://registry.example/${ID}.tgz`,
      resolvedVersion: "2.0.0",
      contentDir: staged,
      cacheDir,
      extractedDir: staged,
      syncedAt: "2026-08-19T00:00:00.000Z",
      writable: false,
    };
  });
});

afterEach(() => {
  stopLiveHolders();
  _setWarnSinkForTests(undefined);
  storage.cleanup();
});

describe("akm bundle update lock order", () => {
  test("waiting for another build does not hold the asset mutation lease", async () => {
    const rebuildLock = getIndexRebuildLockPath();
    fs.mkdirSync(path.dirname(rebuildLock), { recursive: true });
    fs.writeFileSync(rebuildLock, spawnLiveHolder().payload(), "utf8");

    const updating = akmUpdate({ target: ID, stashDir: storage.stashDir });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(probeLock(getIndexWriterLockPath()).state).toBe("absent");

    fs.rmSync(rebuildLock);
    const result = await updating;
    expect(result.index).toBeDefined();
  }, 30_000);

  test("an index step that fails after the publish warns that the bundle is updated and rethrows the original error", async () => {
    const warned: string[] = [];
    _setWarnSinkForTests((level, args) => {
      if (level === "warn") warned.push(args.map(String).join(" "));
    });
    const failure = new TransientError("index is busy", "INDEX_DB_CONTENDED");
    spyOn(indexerModule, "akmIndex").mockRejectedValue(failure);

    await expect(akmUpdate({ target: ID, stashDir: storage.stashDir })).rejects.toBe(failure);

    expect(warned.join("\n")).toContain("The bundle was updated but its search index was not refreshed");
    expect(warned.join("\n")).toContain("`akm index`");
  });
});
