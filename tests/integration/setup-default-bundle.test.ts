// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Making another directory the default never edits another bundle's entry (`bundle create --set-default`), and a
 * setup that drops one reports it by name (`setup --dir`, `removedBundles`).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../../src/core/config/config";
import { runCliCapture } from "../_helpers/cli";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../_helpers/sandbox";

let storage: IsolatedAkmStorage;
let dirA: string;
let dirB: string;

function writeDocs(dir: string, count: number): void {
  fs.mkdirSync(path.join(dir, "knowledge"), { recursive: true });
  for (let i = 0; i < count; i++) {
    fs.writeFileSync(path.join(dir, "knowledge", `doc-${i}.md`), `---\ndescription: doc ${i}\n---\n\n# Doc ${i}\n`);
  }
}

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  dirA = path.join(storage.root, "bundle-a");
  dirB = path.join(storage.root, "bundle-b");
});

afterEach(() => {
  storage.cleanup();
});

describe("bundle create --dir B --set-default", () => {
  test("adds B and makes it the default; A's entry is unchanged and A's docs stay searchable", async () => {
    expect((await runCliCapture(["setup", "--yes", "--no-probe", "--dir", dirA])).code).toBe(0);
    writeDocs(dirA, 3);
    const before = loadConfig();
    const keyA = before.defaultBundle as string;
    const entryA = structuredClone(before.bundles?.[keyA]);
    expect(entryA?.path).toBe(dirA);

    const created = await runCliCapture(["bundle", "create", "--dir", dirB, "--set-default"]);
    expect(created.code, created.stderr).toBe(0);

    const after = loadConfig();
    expect(after.bundles?.[keyA]).toEqual(entryA);
    expect(after.defaultBundle).not.toBe(keyA);
    expect(after.bundles?.[after.defaultBundle as string]?.path).toBe(dirB);

    expect((await runCliCapture(["index"])).code).toBe(0);
    const search = await runCliCapture(["search", "doc", "--format=json"]);
    expect(search.code, search.stderr).toBe(0);
    expect(search.stdout).toContain(`${keyA}//knowledge/doc-0`);
  }, 60_000);

  test("a directory already configured under key x keeps that key", async () => {
    expect((await runCliCapture(["setup", "--yes", "--no-probe", "--dir", dirA])).code).toBe(0);
    const keyA = loadConfig().defaultBundle as string;
    expect((await runCliCapture(["bundle", "create", "--dir", dirB, "--set-default"])).code).toBe(0);
    const keysBefore = Object.keys(loadConfig().bundles ?? {});

    const again = await runCliCapture(["bundle", "create", "--dir", dirA, "--set-default"]);
    expect(again.code, again.stderr).toBe(0);

    const after = loadConfig();
    expect(after.defaultBundle).toBe(keyA);
    expect(Object.keys(after.bundles ?? {})).toEqual(keysBefore);
  }, 60_000);
});

describe("setup --dir B", () => {
  test("removes the previous default's entry and names it in removedBundles; its directory is untouched", async () => {
    expect((await runCliCapture(["setup", "--yes", "--no-probe", "--dir", dirA])).code).toBe(0);
    writeDocs(dirA, 2);
    const keyA = loadConfig().defaultBundle as string;

    const moved = await runCliCapture(["setup", "--yes", "--no-probe", "--dir", dirB]);
    expect(moved.code, moved.stderr).toBe(0);

    const result = JSON.parse(moved.stdout) as { removedBundles: Array<{ id: string; path: string }> };
    expect(result.removedBundles).toEqual([{ id: keyA, path: dirA }]);
    expect(loadConfig().bundles?.[keyA]).toBeUndefined();
    expect(fs.existsSync(path.join(dirA, "knowledge", "doc-0.md"))).toBe(true);
  }, 60_000);

  test("reports no removed bundle when nothing was dropped", async () => {
    // The first setup replaces the sandbox's seeded `stash` bundle; only a repeat of the same setup drops nothing.
    expect((await runCliCapture(["setup", "--yes", "--no-probe", "--dir", dirA])).code).toBe(0);
    const again = await runCliCapture(["setup", "--yes", "--no-probe", "--dir", dirA]);
    expect((JSON.parse(again.stdout) as { removedBundles: unknown[] }).removedBundles).toEqual([]);
  }, 60_000);
});
