// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * One owner for index builds, and reads that never build
 * (`docs/architecture/internals/indexing.md`, "Who builds the index" and "How
 * reads degrade"). Every test here covers behaviour that did not exist before:
 * on the previous release a read on a cold library built the index inline (and
 * a second concurrent read failed with exit 75), `show` needed an index row, a
 * missing `builtAt` meant "rebuild", the write-through skipped while a build ran,
 * and only `akm index` took the rebuild lock.
 *
 * In-process cases drive the CLI through `runCliCapture`; cases that cross
 * processes spawn real `bun src/cli.ts` children against the same sandbox.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { saveConfig } from "../../../src/core/config/config";
import { readEvents } from "../../../src/core/events";
import { getDbPath, getIndexRebuildLockPath } from "../../../src/core/paths";
import { indexBuildRunning } from "../../../src/indexer/index-rebuild-lock";
import { indexWrittenAssets } from "../../../src/indexer/index-written-assets";
import * as indexerModule from "../../../src/indexer/indexer";
import { _setIndexTransactionHookForTests, akmIndex } from "../../../src/indexer/indexer";
import {
  closeDatabase,
  openExistingDatabase,
  openIndexDatabase,
} from "../../../src/storage/repositories/index-connection";
import { deleteMeta, getMeta, setMeta } from "../../../src/storage/repositories/index-meta-repository";
import { runCliCapture } from "../../_helpers/cli";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../_helpers/sandbox";

const repoRoot = path.resolve(import.meta.dir, "../../..");
const NO_INDEX = /no search index for this library yet/;

let storage: IsolatedAkmStorage;

function write(relative: string, content: string): string {
  const file = path.join(storage.stashDir, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
  return file;
}

function seedLibrary(count = 3): void {
  for (let i = 0; i < count; i++) {
    write(
      `knowledge/guide-${i}.md`,
      `---\ndescription: Deployment guide ${i}\n---\n\n# Guide ${i}\n\nDeploy safely.\n`,
    );
  }
}

function editMeta(edit: (db: ReturnType<typeof openExistingDatabase>) => void): void {
  const db = openExistingDatabase(getDbPath());
  try {
    edit(db);
  } finally {
    closeDatabase(db);
  }
}

function holdLock(): string {
  const lockPath = getIndexRebuildLockPath();
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), "utf8");
  return lockPath;
}

async function cli(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return runCliCapture(args);
}

async function child(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", "src/cli.ts", ...args], {
    cwd: repoRoot,
    env: { ...process.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  saveConfig({ semanticSearchMode: "off" });
});

afterEach(() => {
  _setIndexTransactionHookForTests(undefined);
  storage.cleanup();
});

describe("reads on a cold library never build", () => {
  test("search, curate and show exit 0; search and curate are empty with the one warning; show returns the file; no index is created", async () => {
    seedLibrary();

    const search = await cli("search", "deployment", "--format=json");
    expect(search.code).toBe(0);
    const searched = JSON.parse(search.stdout);
    expect(searched.hits).toEqual([]);
    expect(searched.warnings.join("\n")).toMatch(NO_INDEX);
    expect(searched.warnings.join("\n")).toContain("akm index");

    const curate = await cli("curate", "deploy the app safely", "--format=json");
    expect(curate.code).toBe(0);
    const curated = JSON.parse(curate.stdout);
    expect(curated.items).toEqual([]);
    expect(curated.warnings.join("\n")).toMatch(NO_INDEX);

    const show = await cli("show", "knowledge/guide-0", "--format=json");
    expect(show.code).toBe(0);
    expect(JSON.parse(show.stdout).path).toBe(path.join(storage.stashDir, "knowledge", "guide-0.md"));

    expect(fs.existsSync(getDbPath())).toBe(false);
  });

  test("the warning says a build is running while a live process holds the rebuild lock", async () => {
    seedLibrary();
    holdLock();
    const search = await cli("search", "deployment", "--format=json");
    expect(search.code).toBe(0);
    const warnings = JSON.parse(search.stdout).warnings.join("\n");
    expect(warnings).toContain("being built");
    expect(warnings).not.toMatch(NO_INDEX);
    expect(fs.existsSync(getDbPath())).toBe(false);
  });

  test("several reads started at once (real processes) all exit 0 and none builds", async () => {
    seedLibrary();
    const results = await Promise.all([
      child("search", "deployment", "--format=json"),
      child("search", "guide", "--format=json"),
      child("curate", "deploy the app", "--format=json"),
      child("show", "knowledge/guide-1", "--format=json"),
    ]);
    for (const result of results) expect(result.code).toBe(0);
    expect(JSON.parse(results[0]!.stdout).hits).toEqual([]);
    expect(JSON.parse(results[3]!.stdout).path).toContain("guide-1.md");
    expect(fs.existsSync(getDbPath())).toBe(false);
    expect(readEvents({ type: "index_completed" }).events).toHaveLength(0);
  }, 60_000);

  test("reads beside a running `akm index` all exit 0 and the index run is the only build", async () => {
    seedLibrary(40);
    const [indexed, ...reads] = await Promise.all([
      child("index", "--full", "--format=json"),
      child("search", "deployment", "--format=json"),
      child("search", "guide", "--format=json"),
      child("curate", "deploy the app", "--format=json"),
      child("show", "knowledge/guide-1", "--format=json"),
    ]);
    expect(indexed.code).toBe(0);
    for (const read of reads) expect(read.code).toBe(0);
    expect(readEvents({ type: "index_completed" }).events).toHaveLength(1);
  }, 60_000);
});

describe("a read of an index that is only partly there", () => {
  test("keyword data persisted but no builtAt: results are served with the may-be-incomplete warning and nothing rebuilds", async () => {
    seedLibrary();
    await akmIndex({ stashDir: storage.stashDir, full: true });
    editMeta((db) => deleteMeta(db, "builtAt"));

    const search = await cli("search", "deployment", "--format=json");
    expect(search.code).toBe(0);
    const response = JSON.parse(search.stdout);
    expect(response.hits.length).toBeGreaterThan(0);
    expect(response.warnings.join("\n")).toContain("may be incomplete");

    const curate = await cli("curate", "deploy the app safely", "--format=json");
    expect(curate.code).toBe(0);
    expect(JSON.parse(curate.stdout).warnings.join("\n")).toContain("may be incomplete");

    editMeta((db) => expect(getMeta(db, "builtAt")).toBeUndefined());
    expect(readEvents({ type: "index_completed" }).events).toHaveLength(1);
  });

  test("an index built for a different library: empty result and the warning, and no rebuild from the read", async () => {
    seedLibrary();
    await akmIndex({ stashDir: storage.stashDir, full: true });
    editMeta((db) => {
      setMeta(db, "stashDir", "/somewhere/else");
      setMeta(db, "stashDirs", JSON.stringify(["/somewhere/else"]));
    });

    const search = await cli("search", "deployment", "--format=json");
    expect(search.code).toBe(0);
    const response = JSON.parse(search.stdout);
    expect(response.hits).toEqual([]);
    expect(response.warnings.join("\n")).toMatch(NO_INDEX);
    editMeta((db) => expect(getMeta(db, "stashDir")).toBe("/somewhere/else"));
    expect(readEvents({ type: "index_completed" }).events).toHaveLength(1);
  });

  test("feedback with no usable index says the same thing and exits 2", async () => {
    seedLibrary();
    const feedback = await cli("feedback", "knowledge/guide-0", "--positive");
    expect(feedback.code).toBe(2);
    expect(feedback.stderr).toMatch(NO_INDEX);
    expect(fs.existsSync(getDbPath())).toBe(false);
  });
});

describe("show resolves from the bundle's files", () => {
  test("a file added outside akm after the last build is returned; #heading selects its section; a missing ref is not found", async () => {
    seedLibrary();
    await akmIndex({ stashDir: storage.stashDir, full: true });
    const added = write("knowledge/added-later.md", "# Added\n\nIntro.\n\n## Rollback\n\nUse the previous release.\n");

    const whole = await cli("show", "knowledge/added-later", "--format=json");
    expect(whole.code).toBe(0);
    expect(JSON.parse(whole.stdout).path).toBe(added);

    const section = await cli("show", "knowledge/added-later#rollback", "--format=json");
    expect(section.code).toBe(0);
    expect(JSON.parse(section.stdout).content).toContain("Use the previous release.");

    const missing = await cli("show", "knowledge/does-not-exist", "--format=json");
    expect(missing.code).toBe(1);
  });

  test("--lead on a ref the index has no row for shows the exact section with a warning instead of failing", async () => {
    seedLibrary();
    write("knowledge/lead.md", "# Lead\n\nIntro.\n\n## Details\n\nThe details.\n");
    const lead = await cli("show", "knowledge/lead#details", "--lead", "--format=json");
    expect(lead.code).toBe(0);
    expect(lead.stderr).toContain("Indexed-safe fragment context is unavailable");
    expect(JSON.parse(lead.stdout).content).toContain("The details.");
  });

  test("a file under a symlinked directory is not in the bundle", async () => {
    seedLibrary();
    const outside = path.join(storage.root, "outside");
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, "secret.md"), "# Outside\n");
    fs.symlinkSync(outside, path.join(storage.stashDir, "knowledge", "linked"));
    expect((await cli("show", "knowledge/linked/secret", "--format=json")).code).toBe(1);
  });
});

describe("every build path takes the rebuild lock", () => {
  test("bundle add, update and remove build while holding it", async () => {
    const original = indexerModule.akmIndex;
    const heldDuringBuild: boolean[] = [];
    const spy = spyOn(indexerModule, "akmIndex").mockImplementation(async (options) => {
      heldDuringBuild.push(indexBuildRunning());
      return original(options);
    });
    try {
      const extra = path.join(storage.root, "extra-bundle");
      fs.mkdirSync(path.join(extra, "knowledge"), { recursive: true });
      fs.writeFileSync(path.join(extra, "knowledge", "extra.md"), "# Extra\n");

      expect((await cli("bundle", "add", extra, "--name", "extra")).code).toBe(0);
      const afterAdd = heldDuringBuild.length;
      expect(afterAdd).toBeGreaterThan(0);

      expect((await cli("bundle", "update", "extra")).code).toBe(0);
      const afterUpdate = heldDuringBuild.length;
      expect(afterUpdate).toBeGreaterThan(afterAdd);

      expect((await cli("bundle", "remove", "extra", "--yes")).code).toBe(0);
      const afterRemove = heldDuringBuild.length;
      expect(afterRemove).toBeGreaterThan(afterUpdate);
    } finally {
      spy.mockRestore();
    }
    expect(heldDuringBuild.every(Boolean)).toBe(true);
    expect(fs.existsSync(getIndexRebuildLockPath())).toBe(false);
  }, 60_000);

  test("`akm bundle add` waits for a running build instead of building beside it", async () => {
    const lockPath = holdLock();
    const extra = path.join(storage.root, "extra-bundle");
    fs.mkdirSync(path.join(extra, "knowledge"), { recursive: true });
    fs.writeFileSync(path.join(extra, "knowledge", "extra.md"), "# Extra\n");
    const spy = spyOn(indexerModule, "akmIndex");
    try {
      const added = cli("bundle", "add", extra, "--name", "extra");
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(spy).not.toHaveBeenCalled();
      fs.rmSync(lockPath);
      expect((await added).code).toBe(0);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("write-through and the persist transaction", () => {
  test("a write that overlaps a build does not fail the writing command, and the asset is searchable after the next build", async () => {
    seedLibrary();
    await akmIndex({ stashDir: storage.stashDir, full: true });
    const note = write(
      "memories/overlap-note.md",
      "---\ndescription: Written during a build\n---\n\nOverlap marker text.\n",
    );
    // Force the build to redo `knowledge/` so its persist transaction is open, holding the write lock, at the hook.
    write("knowledge/guide-0.md", "---\ndescription: Deployment guide, edited\n---\n\n# Guide 0\n\nEdited.\n");

    let duringBuild: boolean | undefined;
    _setIndexTransactionHookForTests(() => {
      // Same process, second connection: the build holds the write lock, so this runs out its 5 s busy timeout.
      void indexWrittenAssets(storage.stashDir, [note]).then((ok) => {
        duringBuild = ok;
      });
    });
    await akmIndex({ stashDir: storage.stashDir });
    _setIndexTransactionHookForTests(undefined);
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Fail-open: it reported and threw nothing (true when it indexed, false when it gave up on the lock).
    expect(typeof duringBuild).toBe("boolean");

    await akmIndex({ stashDir: storage.stashDir });
    const search = await cli("search", "overlap marker", "--format=json");
    expect(JSON.parse(search.stdout).hits.map((hit: { name: string }) => hit.name)).toContain("overlap-note");
  }, 30_000);

  test("the persist transaction takes the write lock up front (BEGIN IMMEDIATE on index.db)", async () => {
    seedLibrary();
    const original = Database.prototype.exec;
    const begun: string[] = [];
    const exec = spyOn(Database.prototype, "exec").mockImplementation(function (this: Database, sql: string) {
      if (this.filename === getDbPath() && /^\s*BEGIN/i.test(sql)) begun.push(sql.trim().toUpperCase());
      return original.call(this, sql);
    });
    try {
      await akmIndex({ stashDir: storage.stashDir, full: true });
    } finally {
      exec.mockRestore();
    }
    expect(begun).toContain("BEGIN IMMEDIATE");
  });

  test("the library marker commits with the entries: a build killed after the persist leaves a usable index", async () => {
    seedLibrary();
    // Abort the build right after the persist transaction (before embeddings and finalize).
    const controller = new AbortController();
    _setIndexTransactionHookForTests(() => queueMicrotask(() => controller.abort(new Error("killed"))));
    await expect(akmIndex({ stashDir: storage.stashDir, full: true, signal: controller.signal })).rejects.toThrow();
    _setIndexTransactionHookForTests(undefined);

    editMeta((db) => {
      expect(getMeta(db, "builtAt")).toBeUndefined();
      expect(getMeta(db, "stashDir")).toBe(storage.stashDir);
      expect(JSON.parse(getMeta(db, "stashDirs") ?? "[]")).toContain(storage.stashDir);
    });
    const search = await cli("search", "deployment", "--format=json");
    expect(search.code).toBe(0);
    const response = JSON.parse(search.stdout);
    expect(response.hits.length).toBeGreaterThan(0);
    expect(response.warnings.join("\n")).toContain("may be incomplete");
  });
});

describe("corruption", () => {
  function corrupt(): Buffer {
    const dbPath = getDbPath();
    const db = new Database(dbPath);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.close();
    const bytes = fs.readFileSync(dbPath);
    for (let i = 100; i < bytes.length; i++) bytes[i] = 0xff;
    fs.writeFileSync(dbPath, bytes);
    return bytes;
  }

  test("a writable opener that is not a build raises instead of deleting the corrupt file; a build rebuilds it", async () => {
    seedLibrary();
    await akmIndex({ stashDir: storage.stashDir, full: true });
    const damaged = corrupt();

    expect(() => openIndexDatabase(getDbPath())).toThrow();
    expect(fs.readFileSync(getDbPath()).equals(damaged)).toBe(true);

    await akmIndex({ stashDir: storage.stashDir, full: true });
    const search = await cli("search", "deployment", "--format=json");
    expect(JSON.parse(search.stdout).hits.length).toBeGreaterThan(0);
  });
});
