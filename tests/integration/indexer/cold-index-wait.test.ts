// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * A read that finds no usable index while another process is building it waits
 * for that build instead of failing with INDEX_DB_CONTENDED (akm-plugins#175).
 * Real CLI children for the race itself; the rebuild lock (held by this test)
 * forces the ordering deterministically for the wait, bound and failed-build cases.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { saveConfig } from "../../../src/core/config/config";
import { TransientError } from "../../../src/core/errors";
import { getDbPath, getIndexRebuildLockPath } from "../../../src/core/paths";
import { ensureIndex } from "../../../src/indexer/ensure-index";
import { _setAkmIndexForTests, akmIndex } from "../../../src/indexer/indexer";
import { closeDatabase, openExistingDatabase } from "../../../src/storage/repositories/index-connection";
import { getMeta } from "../../../src/storage/repositories/index-meta-repository";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../_helpers/sandbox";

const repoRoot = path.resolve(import.meta.dir, "../../..");
let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  saveConfig({ semanticSearchMode: "off" });
  const dir = path.join(storage.stashDir, "memories");
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 300; i++) {
    fs.writeFileSync(path.join(dir, `note-${i}.md`), `---\ndescription: widgets ${i}\n---\n\nwidgets ${i}\n`, "utf8");
  }
});

afterEach(() => {
  _setAkmIndexForTests();
  storage.cleanup();
});

function removeIndex(): void {
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${getDbPath()}${suffix}`, { force: true });
}

function builtAt(): string | undefined {
  const db = openExistingDatabase(getDbPath());
  try {
    return getMeta(db, "builtAt");
  } finally {
    closeDatabase(db);
  }
}

function plantLock(pid: number): string {
  const lockPath = getIndexRebuildLockPath();
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, JSON.stringify({ pid, startedAt: new Date().toISOString() }), "utf8");
  return lockPath;
}

function spawnCli(args: string[]) {
  const child = Bun.spawn(["bun", "src/cli.ts", ...args, "--format=json"], {
    cwd: repoRoot,
    env: { ...process.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const done = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]).then(
    ([stdout, stderr, code]) => ({ stdout, stderr, code }),
  );
  return { done, exited: () => child.exitCode !== null };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("cold index: reads wait for the build in progress", () => {
  test("concurrent real reads on a cold index all succeed with results", async () => {
    for (let trial = 0; trial < 4; trial++) {
      removeIndex();
      const runs = [
        spawnCli(["search", "widgets"]),
        spawnCli(["curate", "widgets"]),
        spawnCli(["show", "memories/note-5"]),
      ].map((c) => c.done);
      for (const r of await Promise.all(runs)) {
        expect(r.stderr).not.toContain("INDEX_DB_CONTENDED");
        expect(r.code).toBe(0);
        expect(r.stdout.length).toBeGreaterThan(0);
      }
    }
  }, 120_000);

  test("a read started during another process's build waits for it, then reads without building again", async () => {
    removeIndex();
    const lockPath = plantLock(process.pid); // the "builder" is alive for as long as this test says
    const reader = spawnCli(["search", "widgets"]);
    await sleep(1500);
    expect(reader.exited()).toBe(false); // still waiting, not failed

    // The builder finishes: index built, then lock released.
    await akmIndex({ stashDir: storage.stashDir, implicit: true, hydrateSources: false });
    const builtBefore = builtAt();
    fs.rmSync(lockPath);

    const result = await reader.done;
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).hits.length).toBeGreaterThan(0);
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(builtAt()).toBe(builtBefore); // the reader did not build a second time
  }, 60_000);

  test("a reader and an `akm index` writer started together both succeed", async () => {
    for (let trial = 0; trial < 3; trial++) {
      removeIndex();
      const writer = spawnCli(["index"]);
      await sleep(250);
      const readers = [spawnCli(["search", "widgets"]), spawnCli(["curate", "widgets"])];
      for (const r of await Promise.all([writer.done, ...readers.map((c) => c.done)])) {
        expect(r.stderr).not.toContain("INDEX_DB_CONTENDED");
        expect(r.code).toBe(0);
      }
    }
  }, 120_000);

  test("the wait is bounded: a live lock that never clears fails with INDEX_DB_CONTENDED and never builds", async () => {
    removeIndex();
    const lockPath = plantLock(process.pid);
    let builds = 0;
    _setAkmIndexForTests(async () => {
      builds++;
      throw new Error("must not build");
    });

    const started = Date.now();
    const err = await ensureIndex(storage.stashDir, { buildWait: { timeoutMs: 300, pollMs: 20 } }).catch((e) => e);

    expect(err).toBeInstanceOf(TransientError);
    expect((err as TransientError).code).toBe("INDEX_DB_CONTENDED");
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
    expect(builds).toBe(0);
    expect(fs.existsSync(lockPath)).toBe(true); // someone else's lock is left alone
  });

  test("when the awaited build fails and leaves no index, this read builds", async () => {
    removeIndex();
    const lockPath = plantLock(process.pid);
    let builds = 0;
    _setAkmIndexForTests((async () => {
      builds++;
      return {} as Awaited<ReturnType<typeof akmIndex>>;
    }) as typeof akmIndex);

    setTimeout(() => fs.rmSync(lockPath), 150); // the builder gives up without an index
    const built = await ensureIndex(storage.stashDir, { buildWait: { timeoutMs: 5000, pollMs: 20 } });

    expect(built).toBe(true);
    expect(builds).toBe(1);
    expect(fs.existsSync(lockPath)).toBe(false); // released after its own build
  });

  test("a lock left by a dead process is reclaimed at once, not waited out", async () => {
    removeIndex();
    plantLock(999_999);
    let builds = 0;
    _setAkmIndexForTests((async () => {
      builds++;
      return {} as Awaited<ReturnType<typeof akmIndex>>;
    }) as typeof akmIndex);

    const started = Date.now();
    await ensureIndex(storage.stashDir, { buildWait: { timeoutMs: 5000, pollMs: 20 } });

    expect(builds).toBe(1);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
