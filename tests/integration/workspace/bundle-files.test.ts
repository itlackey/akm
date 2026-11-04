// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Integration: builds and reads a real index in isolated storage.
import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { resetConfigCache } from "../../../src/core/config/config";
import { getDbPath } from "../../../src/core/paths";
import { akmIndex } from "../../../src/indexer/indexer";
import { assets } from "../../../src/workspace";
import { bundleFileLocation, listBundleFiles } from "../../../src/workspace/bundle-files";
import { makeConfig } from "../../_helpers/factories";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../../_helpers/sandbox";

let storage: IsolatedAkmStorage;
beforeEach(() => {
  storage = withIsolatedAkmStorage();
  writeSandboxConfig({ ...makeConfig(storage.stashDir), semanticSearchMode: "off" });
  resetConfigCache();
});
afterEach(() => storage.cleanup());

test("lists real immediate entries with canonical indexed refs, never contents or fabricated refs", async () => {
  const dir = path.join(storage.stashDir, "knowledge");
  fs.writeFileSync(path.join(dir, "guide.md"), "---\ndescription: A guide\n---\n# A guide\nRead this.\n");
  await akmIndex({ stashDir: storage.stashDir, full: true });
  fs.writeFileSync(path.join(dir, "draft.txt"), "not indexed, private bytes");
  fs.mkdirSync(path.join(dir, "nested"));
  fs.writeFileSync(path.join(dir, "nested", "child.md"), "not an immediate entry");
  const before = fs.readFileSync(getDbPath());
  const result = listBundleFiles("stash", "knowledge");
  expect(result.parent).toBe("");
  expect(result.indexAvailable).toBe(true);
  expect(result.entries.map((entry) => entry.name)).toEqual(["nested", "draft.txt", "guide.md"]);
  expect(result.entries[1]?.assets).toEqual([]);
  expect(result.entries[2]?.assets).toEqual([{ ref: "stash//knowledge/guide", type: "knowledge" }]);
  expect(JSON.stringify(result)).not.toContain("private bytes");
  expect(fs.readFileSync(getDbPath())).toEqual(before);
  expect(bundleFileLocation(path.join(dir, "guide.md"))).toEqual({
    bundle: "stash",
    path: "knowledge/guide.md",
    parent: "knowledge",
  });
  const asset = (await assets.show({ ref: "stash//knowledge/guide" })) as {
    location: unknown;
  };
  expect(asset.location).toEqual(bundleFileLocation(path.join(dir, "guide.md")));
});

test("browsing without an index remains truthful and does not create one", () => {
  fs.writeFileSync(path.join(storage.stashDir, "knowledge", "new.md"), "# New\n");
  const result = listBundleFiles("stash", "knowledge");
  expect(result.indexAvailable).toBe(false);
  expect(result.entries[0]?.assets).toEqual([]);
  expect(fs.existsSync(getDbPath())).toBe(false);
});

test("hidden entries are explicit and a large immediate folder is not silently capped", () => {
  const dir = path.join(storage.stashDir, "knowledge");
  for (let i = 0; i < 505; i++) fs.writeFileSync(path.join(dir, `file-${i}.txt`), "");
  fs.writeFileSync(path.join(dir, ".hidden"), "");
  expect(listBundleFiles("stash", "knowledge").entries).toHaveLength(505);
  expect(listBundleFiles("stash", "knowledge", true).entries).toHaveLength(506);
  expect(listBundleFiles("stash").parent).toBeNull();
});

test("rejects escaping and missing paths while showing unavailable links without following them", () => {
  fs.mkdirSync(path.join(storage.stashDir, "knowledge", "nested"));
  fs.symlinkSync(storage.dataDir, path.join(storage.stashDir, "outside"));
  fs.symlinkSync(path.join(storage.stashDir, "knowledge"), path.join(storage.stashDir, "inside"));
  fs.symlinkSync(path.join(storage.stashDir, "missing"), path.join(storage.stashDir, "broken"));
  const rows = listBundleFiles("stash").entries;
  expect(rows.find((entry) => entry.name === "outside")?.unavailable).toContain("outside");
  expect(rows.find((entry) => entry.name === "broken")?.unavailable).toContain("unavailable");
  expect(rows.find((entry) => entry.name === "inside")?.kind).toBe("directory");
  expect(listBundleFiles("stash", "inside").entries[0]?.name).toBe("nested");
  for (const relative of ["../", storage.dataDir, "outside", "outside/missing"])
    expect(() => listBundleFiles("stash", relative)).toThrow();
  expect(() => listBundleFiles("stash", "missing")).toThrow("no longer exists");
  expect(() => listBundleFiles("unknown")).toThrow("disabled or unavailable");
});

test("a disabled bundle cannot be browsed", () => {
  writeSandboxConfig({
    ...makeConfig(storage.stashDir),
    bundles: { other: { path: storage.dataDir, enabled: false } },
    defaultBundle: undefined,
    defaultWriteTarget: undefined,
  });
  resetConfigCache();
  expect(() => listBundleFiles("other")).toThrow("disabled or unavailable");
});

test("internal folder and file links retain their indexed asset identity", async () => {
  const guide = path.join(storage.stashDir, "knowledge", "guide.md");
  fs.writeFileSync(guide, "---\ndescription: A guide\n---\n# A guide\n");
  await akmIndex({ stashDir: storage.stashDir, full: true });
  fs.symlinkSync(path.dirname(guide), path.join(storage.stashDir, "shortcut"));
  fs.symlinkSync(guide, path.join(storage.stashDir, "guide-link.md"));
  expect(listBundleFiles("stash", "shortcut").entries[0]).toMatchObject({
    path: "shortcut/guide.md",
    assets: [{ ref: "stash//knowledge/guide", type: "knowledge" }],
  });
  expect(listBundleFiles("stash").entries.find((entry) => entry.name === "guide-link.md")).toMatchObject({
    path: "guide-link.md",
    symlink: true,
    assets: [{ ref: "stash//knowledge/guide", type: "knowledge" }],
  });
});

test("a symlinked bundle root keeps its configured identity when browsing internal links", async () => {
  const alias = path.join(path.dirname(storage.stashDir), "bundle-link");
  fs.symlinkSync(storage.stashDir, alias);
  process.env.AKM_BUNDLE_DIR = alias;
  writeSandboxConfig({ ...makeConfig(alias), semanticSearchMode: "off" });
  resetConfigCache();
  fs.writeFileSync(path.join(alias, "knowledge/guide.md"), "---\ndescription: A guide\n---\n# A guide\n");
  await akmIndex({ stashDir: alias, full: true });
  fs.symlinkSync(path.join(storage.stashDir, "knowledge"), path.join(alias, "shortcut"));
  expect(listBundleFiles("stash", "knowledge").entries[0]?.assets).toEqual([
    { ref: "stash//knowledge/guide", type: "knowledge" },
  ]);
  expect(listBundleFiles("stash", "shortcut").entries[0]?.assets).toEqual([
    { ref: "stash//knowledge/guide", type: "knowledge" },
  ]);
});
