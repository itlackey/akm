import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { akmUpdate } from "../../src/commands/sources/installed-stashes";
import { saveConfig } from "../../src/core/config/config";
import { getDbPath, getRegistryCacheDir } from "../../src/core/paths";
import { akmIndex } from "../../src/indexer/indexer";
import { readLockfile } from "../../src/integrations/lockfile";
import { _setEmbedderForTests } from "../../src/llm/embedder";
import type { EmbeddingVector } from "../../src/llm/embedders/types";
import * as syncFromRefModule from "../../src/sources/providers/sync-from-ref";
import { closeDatabase, openReadonlyExistingDatabase } from "../../src/storage/repositories/index-connection";
import { getEmbeddingCount } from "../../src/storage/repositories/index-vec-repository";
import { runCliCapture } from "../_helpers/cli";
import { seedLockEntries } from "../_helpers/lockfile";
import { writeMarkdownFiles } from "../_helpers/markdown-fixtures";
import { type IsolatedAkmStorage, withEnv, withIsolatedAkmStorage } from "../_helpers/sandbox";

describe("bundle-update-unchanged-revision", () => {
  // INTEGRATION TEST — spawns real Git processes against a local repository
  // standing in for the upstream of a managed git bundle (the git+ ref is mapped
  // to it by a process-scoped Git insteadOf rule, so no public network is used).

  const GIT_URL = "https://git.example.test/acme/revision-fixture.git";
  const BUNDLE = "revision-fixture";

  let storage: IsolatedAkmStorage;
  let remote: string;
  let fixtureEnv: Record<string, string>;

  function git(args: string[]): void {
    const result = spawnSync("git", args, { encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  }

  function commitToRemote(note: string): void {
    fs.mkdirSync(path.join(remote, "knowledge"), { recursive: true });
    fs.writeFileSync(path.join(remote, "knowledge", "hello.md"), `---\ndescription: ${note}\n---\n\n# ${note}\n`);
    git(["-C", remote, "add", "."]);
    git(["-C", remote, "commit", "-m", note]);
  }

  async function bundleCli(...args: string[]): Promise<Record<string, unknown>> {
    const result = await withEnv(fixtureEnv, () => runCliCapture(["bundle", ...args, "--format=json"]), 60_000);
    expect(result.code, result.stderr).toBe(0);
    return JSON.parse(result.stdout);
  }

  /** The lock's content root, the `<rev>` directory holding it and that directory's parent. */
  function installDirs(): { localRoot: string; revDir: string; slugDir: string } {
    const localRoot = readLockfile().find((entry) => entry.id === BUNDLE)?.localRoot ?? "";
    const [slug, rev] = path.relative(getRegistryCacheDir(), localRoot).split(path.sep);
    const slugDir = path.join(getRegistryCacheDir(), slug ?? "");
    return { localRoot, revDir: path.join(slugDir, rev ?? ""), slugDir };
  }

  function revisionDirs(slugDir: string): string[] {
    return fs.readdirSync(slugDir).sort();
  }

  function processedChanged(result: Record<string, unknown>): boolean {
    const processed = result.processed as Array<{ changed: { any: boolean } }>;
    return processed[0]?.changed.any === true;
  }

  beforeEach(async () => {
    storage = withIsolatedAkmStorage();
    remote = path.join(storage.root, "remote");
    fs.mkdirSync(remote, { recursive: true });
    git(["init", "--initial-branch=main", remote]);
    git(["-C", remote, "config", "user.name", "AKM Test"]);
    git(["-C", remote, "config", "user.email", "akm@example.test"]);
    git(["-C", remote, "config", "commit.gpgsign", "false"]);
    commitToRemote("first");
    fixtureEnv = {
      GIT_ALLOW_PROTOCOL: "file",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: `url.${pathToFileURL(remote).href}.insteadOf`,
      GIT_CONFIG_VALUE_0: GIT_URL,
    };
    await bundleCli("add", `git+${GIT_URL}`, "--name", BUNDLE);
  });

  afterEach(() => {
    storage.cleanup();
  });

  describe("akm bundle update on a read-only git bundle (#1235)", () => {
    test("an unchanged upstream revision leaves the extracted directory in place and reports unchanged", async () => {
      const { localRoot } = installDirs();
      const inodeBefore = fs.statSync(localRoot).ino;
      const lockBefore = readLockfile().find((entry) => entry.id === BUNDLE);

      const result = await bundleCli("update", BUNDLE);

      expect(processedChanged(result)).toBe(false);
      expect(fs.statSync(localRoot).ino).toBe(inodeBefore);
      expect(readLockfile().find((entry) => entry.id === BUNDLE)).toEqual(lockBefore);
    });

    test("--force still fetches the revision again", async () => {
      const { localRoot } = installDirs();
      const inodeBefore = fs.statSync(localRoot).ino;

      await bundleCli("update", BUNDLE, "--force");

      expect(fs.statSync(localRoot).ino).not.toBe(inodeBefore);
    });

    test("an unchanged revision whose directory is gone is fetched again", async () => {
      const { localRoot, revDir } = installDirs();
      fs.rmSync(revDir, { recursive: true, force: true });

      await bundleCli("update", BUNDLE);

      expect(fs.existsSync(localRoot)).toBe(true);
    });

    test("two real updates keep the current and the previous revision directories and no empty parent", async () => {
      const first = installDirs();

      commitToRemote("second");
      const secondResult = await bundleCli("update", BUNDLE);
      expect(processedChanged(secondResult)).toBe(true);
      const second = installDirs();
      expect(second.revDir).not.toBe(first.revDir);
      expect(revisionDirs(second.slugDir)).toEqual(
        [first.revDir, second.revDir].map((dir) => path.basename(dir)).sort(),
      );
      expect(fs.existsSync(first.localRoot)).toBe(true);

      commitToRemote("third");
      await bundleCli("update", BUNDLE);
      const third = installDirs();
      expect(revisionDirs(third.slugDir)).toEqual(
        [second.revDir, third.revDir].map((dir) => path.basename(dir)).sort(),
      );
      expect(fs.existsSync(first.revDir)).toBe(false);
      for (const dir of revisionDirs(third.slugDir)) {
        expect(fs.readdirSync(path.join(third.slugDir, dir)).length).toBeGreaterThan(0);
      }
    });
  });
});

/**
 * #954: `akm bundle update` once ran its embedding phase inside an enclosing
 * `BEGIN IMMEDIATE`, so every per-batch commit nested as an unobservable
 * SAVEPOINT and a SIGKILL mid-run lost every embedding of the run. This drives
 * the REAL `akmUpdate` path (a real `index.db`, hence tests/integration/ per
 * the ORG-03..06 classification rule) with a fake embedder and proves:
 *
 *  1. a batch committed during the update's embedding phase is immediately
 *     visible to a SECOND, independent read-only connection while the run is
 *     still in progress — real durable commits, not savepoints inside a
 *     transaction nobody else can see into; and
 *  2. an embedding phase that fails (provider down) still leaves the update
 *     itself successful, reporting `semanticStatus: "blocked"` rather than
 *     failing the whole update.
 */

function makeDeferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("akm bundle update: embedding durability (#954)", () => {
  let storage: IsolatedAkmStorage;

  beforeEach(() => {
    storage = withIsolatedAkmStorage();
  });
  afterEach(() => {
    _setEmbedderForTests(undefined);
    storage.cleanup();
  });

  /**
   * Install `id` as a bundle of `fileCount` files and build the index the update runs over. The seed index runs
   * with semantic search off: only the update's embedding phase is under test, and with it on, the seed index
   * would download the default local model from Hugging Face into the test's empty cache.
   */
  async function seedManagedBundle(id: string, fileCount: number): Promise<void> {
    const cacheDir = path.join(getRegistryCacheDir(), `${id}-cache`);
    const contentDir = path.join(cacheDir, "content");
    writeMarkdownFiles(contentDir, fileCount, "seed");
    const bundles = { [id]: { npm: id, components: { main: { root: ".", adapter: "akm", writable: false } } } };
    saveConfig({ semanticSearchMode: "off", bundles });
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
    await akmIndex({ stashDir: storage.stashDir, hydrateSources: false, persistDetectedAdapters: false });
    saveConfig({ semanticSearchMode: "auto", bundles });
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

  test("an embedding batch committed mid-update is visible to a second connection", async () => {
    const id = "durability-probe";
    const fileCount = 4;
    await seedManagedBundle(id, fileCount);

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
      // on a separate connection, not a SAVEPOINT invisible outside an
      // enclosing transaction.
      expect(countMidway).toBeGreaterThan(0);
      expect(countMidway).toBeLessThan(fileCount);

      releaseSecondBatch.resolve();
      const result = await updatePromise;

      expect(result.index.semanticStatus).toBeDefined();
      expect(result.index.semanticStatus).toBe("ready-js");
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

  test("a failing embedding phase still leaves the update successful, reporting semanticStatus blocked", async () => {
    const id = "post-commit-failure-probe";
    await seedManagedBundle(id, 3);

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
