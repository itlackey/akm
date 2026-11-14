// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * One library reached through two path spellings (a symlink and its target,
 * macOS `/tmp` and `/private/tmp`) is one library: the index built through either
 * spelling is served through the other, with no rebuild and the same entry ids.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { resetConfigCache, saveConfig } from "../../../src/core/config/config";
import { getDbPath } from "../../../src/core/paths";
import { assertWritePathsInsideSource } from "../../../src/core/write-source";
import { akmIndex } from "../../../src/indexer/indexer";
import { findSourceForPath, resolveSourceEntries } from "../../../src/indexer/search/search-source";
import { closeDatabase, openExistingDatabase } from "../../../src/storage/repositories/index-connection";
import { setMeta } from "../../../src/storage/repositories/index-meta-repository";
import { bundleFileLocation } from "../../../src/workspace/bundle-files";
import { runCliCapture } from "../../_helpers/cli";
import { type IsolatedAkmStorage, withEnv, withIsolatedAkmStorage } from "../../_helpers/sandbox";

let storage: IsolatedAkmStorage;
let real: string;
let link: string;

function entryIds(): Record<string, number> {
  const db = openExistingDatabase(getDbPath());
  try {
    const rows = db.prepare("SELECT item_ref, id FROM entries ORDER BY item_ref").all() as {
      item_ref: string;
      id: number;
    }[];
    return Object.fromEntries(rows.map((r) => [r.item_ref, r.id]));
  } finally {
    closeDatabase(db);
  }
}

async function through<T>(dir: string, run: () => Promise<T>): Promise<T> {
  return withEnv({ AKM_BUNDLE_DIR: dir }, async () => {
    resetConfigCache();
    return run();
  });
}

async function search(dir: string): Promise<{ hits: unknown[]; warnings?: string[] }> {
  return through(dir, async () => {
    const out = await runCliCapture(["search", "deploy", "--format=json"]);
    expect(out.code).toBe(0);
    return JSON.parse(out.stdout);
  });
}

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  saveConfig({ semanticSearchMode: "off" });
  real = fs.realpathSync(storage.stashDir);
  const parentLink = path.join(storage.root, "parent-link");
  fs.symlinkSync(path.dirname(real), parentLink);
  link = path.join(parentLink, path.basename(real));
  for (let i = 0; i < 3; i++) {
    fs.writeFileSync(
      path.join(real, "knowledge", `guide-${i}.md`),
      `---\ndescription: Deploy guide ${i}\n---\n\n# Guide ${i}\n`,
    );
  }
});

afterEach(() => storage.cleanup());

describe("a library under two path spellings", () => {
  for (const [built, read] of [
    ["link", "real"],
    ["real", "link"],
  ] as const) {
    test(`index through the ${built} path: served through the ${read} path, not rebuilt, ids unchanged`, async () => {
      const dirs = { link, real };
      const first = await through(dirs[built], () => akmIndex({ stashDir: dirs[built], full: true }));
      expect(first.mode).toBe("full");
      const ids = entryIds();
      expect(Object.keys(ids).length).toBe(3);

      const served = await search(dirs[read]);
      expect(served.hits.length).toBeGreaterThan(0);
      expect((served.warnings ?? []).join("\n")).not.toMatch(/no search index/);

      const second = await through(dirs[read], () => akmIndex({ stashDir: dirs[read] }));
      expect(second.mode).toBe("incremental");
      expect(entryIds()).toEqual(ids);
    });
  }

  test("an index that stored the other spelling before it was canonical still serves", async () => {
    await through(real, () => akmIndex({ stashDir: real, full: true }));
    const db = openExistingDatabase(getDbPath());
    try {
      setMeta(db, "stashDir", link);
      setMeta(db, "stashDirs", JSON.stringify([link]));
    } finally {
      closeDatabase(db);
    }
    const served = await search(real);
    expect(served.hits.length).toBeGreaterThan(0);
    const again = await through(real, () => akmIndex({ stashDir: real }));
    expect(again.mode).toBe("incremental");
  });
});

describe("a caller's path under the symlinked spelling of a library", () => {
  test("still resolves to its source, bundle location and write target", async () => {
    await through(link, async () => {
      saveConfig({ semanticSearchMode: "off", bundles: { lib: { path: link, writable: true } } } as never);
      resetConfigCache();
      const sources = resolveSourceEntries();
      const source = sources.find((candidate) => candidate.registryId === "lib");
      expect(source?.path).toBe(real);

      const viaLink = path.join(link, "knowledge", "guide-0.md");
      expect(findSourceForPath(viaLink, sources)).toBe(source);
      expect(findSourceForPath(path.join(real, "knowledge", "guide-0.md"), sources)).toBe(source);
      expect(bundleFileLocation(viaLink)).toEqual({ bundle: "lib", path: "knowledge/guide-0.md", parent: "knowledge" });
      expect(() =>
        assertWritePathsInsideSource({ name: "lib", path: real, kind: "filesystem" } as never, [viaLink]),
      ).not.toThrow();
      expect(() =>
        assertWritePathsInsideSource({ name: "lib", path: real, kind: "filesystem" } as never, [
          path.join(link, "..", "x.md"),
        ]),
      ).toThrow();
    });
  });
});

describe("an index built before sources were keyed by real path", () => {
  test("keeps its rows and their embeddings through the first build", async () => {
    await through(real, () => akmIndex({ stashDir: real, full: true }));
    const db = openExistingDatabase(getDbPath());
    try {
      for (const { id } of db.prepare("SELECT id FROM entries").all() as { id: number }[]) {
        db.prepare("INSERT INTO embeddings (id, embedding, model) VALUES (?, ?, 'm')").run(id, new Uint8Array(4));
      }
      const swap = (column: string, table: string) =>
        db.prepare(`UPDATE ${table} SET ${column} = ? || substr(${column}, ?) WHERE ${column} LIKE ? || '%'`);
      swap("file_path", "entries").run(link, real.length + 1, real);
      swap("dir_path", "index_dir_state").run(link, real.length + 1, real);
      setMeta(db, "stashDir", link);
      setMeta(db, "stashDirs", JSON.stringify([link]));
    } finally {
      closeDatabase(db);
    }
    const ids = entryIds();

    const rebuilt = await through(real, () => akmIndex({ stashDir: real }));
    expect(rebuilt.mode).toBe("incremental");
    expect(entryIds()).toEqual(ids);
    const after = openExistingDatabase(getDbPath());
    try {
      expect((after.prepare("SELECT count(*) AS n FROM embeddings").get() as { n: number }).n).toBe(3);
      expect(
        (after.prepare("SELECT file_path FROM entries LIMIT 1").get() as { file_path: string }).file_path.startsWith(
          real,
        ),
      ).toBe(true);
    } finally {
      closeDatabase(after);
    }
  });
});
