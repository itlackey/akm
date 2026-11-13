// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * A read that finds no usable index while another process is building it waits
 * up to 5 seconds for that build, then serves the keyword index from whatever
 * the build has persisted, instead of failing with INDEX_DB_CONTENDED
 * (akm-plugins#175). Real CLI children for the race itself; the rebuild lock
 * (held by this test) forces the ordering deterministically for the other cases.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { saveConfig } from "../../../src/core/config/config";
import { getDbPath, getIndexRebuildLockPath } from "../../../src/core/paths";
import { _resetBuildWaitForTests, ensureIndex } from "../../../src/indexer/ensure-index";
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
  _resetBuildWaitForTests();
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

  test("the wait is bounded: a live lock that never clears is reported as a build in progress, never an error or a build", async () => {
    removeIndex();
    const lockPath = plantLock(process.pid);
    let builds = 0;
    _setAkmIndexForTests(async () => {
      builds++;
      throw new Error("must not build");
    });
    let reported = 0;

    const started = Date.now();
    const built = await ensureIndex(storage.stashDir, {
      buildWait: { timeoutMs: 300, pollMs: 20 },
      onBuildInProgress: () => reported++,
    });
    expect(built).toBe(false);
    expect(reported).toBe(1);
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);

    // Later reads in the same process (curate shows each hit) do not wait again.
    const again = Date.now();
    await ensureIndex(storage.stashDir, {
      buildWait: { timeoutMs: 5000, pollMs: 20 },
      onBuildInProgress: () => reported++,
    });
    expect(reported).toBe(2);
    expect(Date.now() - again).toBeLessThan(1000);

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

  test("after 5 s a read serves the persisted keyword index with a warning, exit 0, and never builds", async () => {
    // A build that has persisted its entries but not yet finished: no builtAt.
    await akmIndex({ stashDir: storage.stashDir, implicit: true, hydrateSources: false });
    const db = openExistingDatabase(getDbPath());
    try {
      db.exec("DELETE FROM index_meta WHERE key = 'builtAt'");
    } finally {
      closeDatabase(db);
    }
    const lockPath = plantLock(process.pid);
    // A file the build has not reached yet.
    fs.writeFileSync(
      path.join(storage.stashDir, "memories", "late.md"),
      "---\ndescription: late\n---\n\n# Late\n\nintro\n\n## Part\n\npart text\n",
      "utf8",
    );

    const started = Date.now();
    const [search, curate, shown, late, lateFragment, missing] = await Promise.all([
      spawnCli(["search", "widgets"]).done,
      spawnCli(["curate", "widgets"]).done,
      spawnCli(["show", "memories/note-5"]).done,
      spawnCli(["show", "memories/late"]).done,
      spawnCli(["show", "memories/late#part"]).done,
      spawnCli(["show", "memories/note-9999"]).done,
    ]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(5000);

    for (const r of [search, curate, shown]) {
      expect(r.code).toBe(0);
      expect(r.stderr).not.toContain("INDEX_DB_CONTENDED");
    }
    const searched = JSON.parse(search.stdout);
    expect(searched.searchMode).toBe("keyword");
    expect(searched.hits.length).toBeGreaterThan(0);
    expect(searched.warnings.join("\n")).toContain("still being built by another akm process");
    const curated = JSON.parse(curate.stdout);
    expect(curated.searchMode).toBe("keyword");
    expect(curated.warnings.join("\n")).toContain("still being built");
    expect(JSON.parse(shown.stdout).name).toBe("note-5");
    expect(shown.stderr).toContain("still being built");

    // A ref the build has not persisted is read from the file, with the same warning.
    for (const r of [late, lateFragment]) {
      expect(r.code).toBe(0);
      expect(r.stderr).toContain("still being built");
    }
    expect(JSON.parse(late.stdout).content).toContain("intro");
    expect(JSON.parse(lateFragment.stdout).content).toContain("part text");
    expect(JSON.parse(lateFragment.stdout).content).not.toContain("intro");

    // Only a file that is not there is not found, and the message says the build is still running.
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("still being built");

    expect(fs.existsSync(lockPath)).toBe(true);
    const check = openExistingDatabase(getDbPath());
    try {
      expect(getMeta(check, "builtAt")).toBeUndefined(); // no second build finished the index
    } finally {
      closeDatabase(check);
    }
  }, 60_000);

  test("after 5 s with nothing persisted yet, reads return an empty result with the warning and exit 0", async () => {
    removeIndex();
    const lockPath = plantLock(process.pid);

    const [search, shown] = await Promise.all([
      spawnCli(["search", "widgets"]).done,
      spawnCli(["show", "memories/note-5"]).done,
    ]);

    expect(search.code).toBe(0);
    const searched = JSON.parse(search.stdout);
    expect(searched.hits).toEqual([]);
    expect(searched.searchMode).toBe("keyword");
    expect(searched.warnings.join("\n")).toContain("still being built by another akm process");
    expect(shown.code).toBe(0); // no index at all: show reads the file
    expect(JSON.parse(shown.stdout).name).toBe("note-5");
    expect(shown.stderr).toContain("still being built");
    expect(fs.existsSync(getDbPath())).toBe(false); // nothing was built
    expect(fs.existsSync(lockPath)).toBe(true);
  }, 60_000);
});
