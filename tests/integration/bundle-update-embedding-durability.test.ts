// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #954: `akm bundle update`'s coordinator used to call `akmIndex`
 * for its embedding phase too, INSIDE the same unified `BEGIN IMMEDIATE` that
 * covers content/lock/index/state — so every per-batch commit the
 * materializer opened nested as an unobservable SAVEPOINT (#954's own
 * per-batch-commit fix never actually reached this path). This drives the
 * REAL `akmUpdate` coordinator path (a real `index.db`, hence
 * tests/integration/ per the ORG-03..06 classification rule) with a fake
 * embedder and proves:
 *
 *  1. a batch committed by the post-commit embedding pass is immediately
 *     visible to a SECOND, independent read-only connection while the run is
 *     still in progress — real durable commits, not savepoints inside a
 *     transaction nobody else can see into; and
 *  2. a post-commit embedding pass that fails (provider down) still leaves
 *     the update itself successful, reporting `semanticStatus: "blocked"`
 *     rather than failing the whole update.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import path from "node:path";
import { akmUpdate } from "../../src/commands/sources/installed-stashes";
import { saveConfig } from "../../src/core/config/config";
import { getDbPath, getRegistryCacheDir } from "../../src/core/paths";
import { akmIndex } from "../../src/indexer/indexer";
import { _setEmbedderForTests } from "../../src/llm/embedder";
import type { EmbeddingVector } from "../../src/llm/embedders/types";
import * as syncFromRefModule from "../../src/sources/providers/sync-from-ref";
import { closeDatabase, openReadonlyExistingDatabase } from "../../src/storage/repositories/index-connection";
import { getEmbeddingCount } from "../../src/storage/repositories/index-vec-repository";
import { seedLockEntries } from "../_helpers/lockfile";
import { writeMarkdownFiles } from "../_helpers/markdown-fixtures";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../_helpers/sandbox";

function makeDeferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("akm bundle update: post-commit embedding pass durability (#954)", () => {
  let storage: IsolatedAkmStorage;

  beforeEach(() => {
    storage = withIsolatedAkmStorage();
  });
  afterEach(() => {
    _setEmbedderForTests(undefined);
    storage.cleanup();
  });

  function configureManagedBundle(id: string, fileCount: number): void {
    const cacheDir = path.join(getRegistryCacheDir(), `${id}-cache`);
    const contentDir = path.join(cacheDir, "content");
    writeMarkdownFiles(contentDir, fileCount, "seed");
    saveConfig({
      semanticSearchMode: "auto",
      bundles: {
        [id]: { npm: id, components: { main: { root: ".", adapter: "akm", writable: false } } },
      },
    });
    seedLockEntries([
      {
        id,
        source: "npm",
        ref: `npm:${id}`,
        resolvedVersion: "1.0.0",
        localRoot: contentDir,
        installedAt: "2026-08-18T00:00:00.000Z",
      },
    ]);
  }

  /** Mock `syncFromRef` to stage `fileCount` fresh markdown files, mirroring a real npm re-download. */
  function mockSyncFromRef(id: string, fileCount: number): ReturnType<typeof spyOn> {
    return spyOn(syncFromRefModule, "syncFromRef").mockImplementation(async (_ref, options) => {
      const cacheRootDir = options?.cacheRootDir;
      if (!cacheRootDir) throw new Error("update did not provide an isolated cacheRootDir");
      const cacheDir = path.join(cacheRootDir, `${id}-cache`);
      const contentDir = path.join(cacheDir, "content");
      writeMarkdownFiles(contentDir, fileCount, "updated");
      return {
        id,
        source: "npm",
        ref: `npm:${id}`,
        artifactUrl: `https://registry.example/${id}.tgz`,
        resolvedVersion: "2.0.0",
        contentDir,
        cacheDir,
        extractedDir: contentDir,
        syncedAt: "2026-08-19T00:00:00.000Z",
        writable: false,
      };
    });
  }

  test("a batch committed after the coordinator's commit is visible to a second connection mid-run", async () => {
    const id = "durability-probe";
    const fileCount = 4;
    configureManagedBundle(id, fileCount);
    await akmIndex({ stashDir: storage.stashDir, hydrateSources: false, persistDetectedAdapters: false });

    const syncSpy = mockSyncFromRef(id, fileCount);
    const firstBatchCommitted = makeDeferred<void>();
    const releaseSecondBatch = makeDeferred<void>();
    const vector = (n: number): EmbeddingVector => Array.from({ length: 4 }, () => n);

    _setEmbedderForTests({
      embedBatch: async (texts, _config, _signal, _onSkip, onBatch) => {
        const mid = Math.ceil(texts.length / 2);
        const firstIndices = texts.map((_, i) => i).slice(0, mid);
        const secondIndices = texts.map((_, i) => i).slice(mid);
        onBatch?.(
          firstIndices,
          firstIndices.map(() => vector(0.1)),
        );
        firstBatchCommitted.resolve();
        await releaseSecondBatch.promise;
        onBatch?.(
          secondIndices,
          secondIndices.map(() => vector(0.2)),
        );
        return texts.map(() => vector(0.1));
      },
    });

    try {
      const updatePromise = akmUpdate({ target: id, stashDir: storage.stashDir });

      await firstBatchCommitted.promise;
      const reader = openReadonlyExistingDatabase(getDbPath());
      if (!reader) throw new Error("expected an existing index for the mid-run durability check");
      let countMidway: number;
      try {
        countMidway = getEmbeddingCount(reader);
      } finally {
        closeDatabase(reader);
      }
      // Only the FIRST batch's embeddings are visible so far — a real commit
      // on a separate connection, not a SAVEPOINT invisible outside a
      // still-open coordinator transaction.
      expect(countMidway).toBeGreaterThan(0);
      expect(countMidway).toBeLessThan(fileCount);

      releaseSecondBatch.resolve();
      const result = await updatePromise;

      expect(result.index.semanticStatus).toBeDefined();
      expect(["ready-vec", "ready-js"]).toContain(result.index.semanticStatus as string);
      const finalReader = openReadonlyExistingDatabase(getDbPath());
      if (!finalReader) throw new Error("expected an existing index after the update completed");
      try {
        expect(getEmbeddingCount(finalReader)).toBe(fileCount);
      } finally {
        closeDatabase(finalReader);
      }
    } finally {
      syncSpy.mockRestore();
    }
  });

  test("a post-commit embedding pass that fails still leaves the update successful, reporting semanticStatus blocked", async () => {
    const id = "post-commit-failure-probe";
    configureManagedBundle(id, 3);
    await akmIndex({ stashDir: storage.stashDir, hydrateSources: false, persistDetectedAdapters: false });

    const syncSpy = mockSyncFromRef(id, 3);
    _setEmbedderForTests({
      embedBatch: async (texts, _config, _signal, onSkip) => {
        for (let i = 0; i < texts.length; i++) {
          onSkip?.({
            index: i,
            reason: "batch-request-failed",
            message: "mock provider is down",
            batchStart: i === 0,
            batchSize: texts.length,
            failureKind: "network-error",
          });
        }
        return texts.map(() => undefined);
      },
    });

    try {
      const result = await akmUpdate({ target: id, stashDir: storage.stashDir });

      expect(result.processed).toHaveLength(1);
      expect(result.index.semanticStatus).toBe("blocked");
    } finally {
      syncSpy.mockRestore();
    }
  });
});
