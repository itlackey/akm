// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `isWalkedFile` (`src/indexer/walk/walker.ts`): the one predicate that says whether a full walk would list a
 * file. `show` (from files) and write-through use it, so neither returns a file the index would not hold.
 * Each case is also checked against the real walk.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { saveConfig } from "../../../src/core/config/config";
import { indexWrittenAssets } from "../../../src/indexer/index-written-assets";
import { akmIndex } from "../../../src/indexer/indexer";
import { isWalkedFile, walkedFiles, walkStashFlat } from "../../../src/indexer/walk/walker";
import { runCliCapture } from "../../_helpers/cli";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../_helpers/sandbox";

let storage: IsolatedAkmStorage;
const doc = "---\ndescription: marker\n---\n\n# Doc\n\nBody.\n";

function write(rel: string): string {
  const file = path.join(storage.stashDir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, doc);
  return file;
}

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  saveConfig({ semanticSearchMode: "off" });
});
afterEach(() => storage.cleanup());

const walked = ["knowledge/ok.md", "memories/.dotfile.md", "env/secret.env"];
const excluded = [
  "knowledge/.hidden/x.md",
  "knowledge/node_modules/pkg/readme.md",
  "knowledge/bin/x.md",
  "knowledge/.cache/x.md",
  "knowledge/.stash.json",
  "knowledge/.gitignore",
  ".scratch/knowledge/x.md",
  "knowledge/ignored.md",
];

describe("isWalkedFile", () => {
  test("agrees with the walk for every exclusion: skipped dirs, sidecar files, .scratch, .gitignore, symlinked dirs", () => {
    for (const rel of [...walked, ...excluded]) write(rel);
    spawnSync("git", ["init", "-q"], { cwd: storage.stashDir });
    fs.writeFileSync(path.join(storage.stashDir, ".gitignore"), "knowledge/ignored.md\nenv/\n");
    const outside = path.join(storage.root, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "target.md"), doc);
    fs.symlinkSync(outside, path.join(storage.stashDir, "knowledge", "linked"));
    const linked = path.join(storage.stashDir, "knowledge", "linked", "target.md");

    const listed = new Set(walkStashFlat(storage.stashDir).map((file) => file.absPath));
    for (const rel of [...walked, ...excluded]) {
      const file = path.join(storage.stashDir, rel);
      expect([rel, isWalkedFile(storage.stashDir, file)]).toEqual([rel, listed.has(file)]);
    }
    expect(walked.every((rel) => listed.has(path.join(storage.stashDir, rel)))).toBe(true);
    expect(listed.has(linked)).toBe(false);
    expect(isWalkedFile(storage.stashDir, linked)).toBe(false);
  });

  test("a directory the adapter walks in full keeps its dot-directories; .git and node_modules stay out", () => {
    const hidden = write("knowledge/.hidden/x.md");
    const modules = write("knowledge/node_modules/x.md");
    expect(isWalkedFile(storage.stashDir, hidden, { includeAllDirectories: true })).toBe(true);
    expect(isWalkedFile(storage.stashDir, modules, { includeAllDirectories: true })).toBe(false);
  });

  test("a deleted file under a directory that is gone is still reported, so its row can be removed", () => {
    expect(isWalkedFile(storage.stashDir, path.join(storage.stashDir, "knowledge", "gone", "x.md"))).toBe(true);
  });

  test("walkedFiles applies the rule to a list in one call, keeping order: some ignored, some not", () => {
    const kept = write("knowledge/kept.md");
    const ignored = write("knowledge/ignored.md");
    const alsoIgnored = write("knowledge/sub/also-ignored.md");
    const env = write("env/keys.md");
    const scratch = write(".scratch/knowledge/x.md");
    const another = write("memories/another.md");
    spawnSync("git", ["init", "-q"], { cwd: storage.stashDir });
    fs.writeFileSync(path.join(storage.stashDir, ".gitignore"), "knowledge/ignored.md\nknowledge/sub/\nenv/\n");
    const outside = path.join(storage.root, "elsewhere.md");

    const input = [kept, ignored, alsoIgnored, env, scratch, outside, another];
    expect(walkedFiles(storage.stashDir, input)).toEqual([kept, env, another]);
    expect(walkedFiles(storage.stashDir, input)).toEqual(input.filter((file) => isWalkedFile(storage.stashDir, file)));
    expect(walkedFiles(storage.stashDir, [])).toEqual([]);
  });

  test("a file outside the root is not walked", () => {
    expect(isWalkedFile(storage.stashDir, path.join(storage.root, "elsewhere.md"))).toBe(false);
  });
});

describe("show from files and write-through use it", () => {
  test("show returns a walked file the index has no row for and refuses every excluded one", async () => {
    for (const rel of [...walked.slice(0, 2), ...excluded]) write(rel);
    spawnSync("git", ["init", "-q"], { cwd: storage.stashDir });
    fs.writeFileSync(path.join(storage.stashDir, ".gitignore"), "knowledge/ignored.md\n");
    expect((await runCliCapture(["show", "knowledge/ok", "--format=json"])).code).toBe(0);
    for (const ref of [
      "knowledge/.hidden/x",
      "knowledge/node_modules/pkg/readme",
      "knowledge/bin/x",
      "knowledge/.cache/x",
      "knowledge/ignored",
    ]) {
      expect([ref, (await runCliCapture(["show", ref, "--format=json"])).code]).toEqual([ref, 1]);
    }
  });

  test("write-through indexes a dot-named file in a walked directory, as the walk does, and skips excluded ones", async () => {
    await akmIndex({ stashDir: storage.stashDir, full: true });
    const dotfile = write("memories/.dotfile.md");
    const hidden = write("memories/.hidden/x.md");
    expect(await indexWrittenAssets(storage.stashDir, [dotfile, hidden])).toBe(true);
    const search = await runCliCapture(["search", "marker", "--format=json", "--detail=full"]);
    const paths = JSON.parse(search.stdout).hits.map((hit: { path: string }) => hit.path);
    expect(paths).toContain(dotfile);
    expect(paths).not.toContain(hidden);
  });
});
