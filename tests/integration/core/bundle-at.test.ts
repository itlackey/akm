// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * A directory no config names (`--dir`) is its own source, which `bundleAt` answers with and the facade takes as it is
 * (§4.2, §4.3): nothing is held between calls. A configured bundle is never shadowed by such a directory.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { bundleFor, bundleNameOf } from "../../../src/core/assets/bundle";
import { findAsset, listAssets, readAsset } from "../../../src/core/assets/read";
import { addressOf, writeAssets } from "../../../src/core/assets/write";
import { bundleAt } from "../../../src/core/bundle-at-dir";
import { saveConfig } from "../../../src/core/config/config";
import { writeTargetAt } from "../../../src/core/write-source";
import { akmIndex } from "../../../src/indexer/indexer";
import { taskScopeOf } from "../../../src/tasks/task-ref";
import { withFakeSecretStores } from "../../_helpers/fake-secret-stores";
import { makeSandboxDir, withIsolatedAkmStorage } from "../../_helpers/sandbox";

const cleanups: Array<() => void> = [];

beforeEach(() => {
  cleanups.push(withIsolatedAkmStorage().cleanup);
  saveConfig({ semanticSearchMode: "off" });
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function stashIn(parent: string): string {
  const dir = path.join(parent, "stash");
  fs.mkdirSync(path.join(dir, "knowledge"), { recursive: true });
  fs.writeFileSync(path.join(dir, "knowledge", "note.md"), "---\ndescription: n\n---\n\n# n\n", "utf8");
  return dir;
}

test("two unconfigured directories with one basename each read their own directory", () => {
  const a = makeSandboxDir("akm-adhoc-a-");
  const b = makeSandboxDir("akm-adhoc-b-");
  cleanups.push(a.cleanup, b.cleanup);
  const dirA = stashIn(a.dir);
  const dirB = stashIn(b.dir);

  const bundleA = bundleAt(dirA);
  const bundleB = bundleAt(dirB);

  expect(bundleNameOf(bundleA)).toBe("stash");
  expect(addressOf(bundleA, "knowledge/note").file).toBe(path.join(dirA, "knowledge", "note.md"));
  expect(addressOf(bundleB, "knowledge/note").file).toBe(path.join(dirB, "knowledge", "note.md"));
});

test("a scratch copy of a configured bundle is a bundle of its own directory: the configured one is never shadowed", () => {
  const configured = makeSandboxDir("akm-mat-config-");
  const scratch = makeSandboxDir("akm-mat-scratch-");
  cleanups.push(configured.cleanup, scratch.cleanup);
  const dir = stashIn(configured.dir);
  const copy = stashIn(scratch.dir);
  fs.writeFileSync(path.join(copy, "knowledge", "note.md"), "---\ndescription: copy\n---\n\n# copy\n", "utf8");
  saveConfig({ semanticSearchMode: "off", bundles: { docs: { path: dir } }, defaultBundle: "docs" });

  const { bundle } = taskScopeOf({ name: "docs", path: copy });

  expect(bundleNameOf(bundle)).not.toBe("docs");
  expect(addressOf(bundle, "knowledge/note").file).toBe(path.join(copy, "knowledge", "note.md"));
  expect(addressOf("docs", "knowledge/note").file).toBe(path.join(dir, "knowledge", "note.md"));
  expect(taskScopeOf({ name: "docs", path: dir }).bundle).toBe("docs");
  expect(bundleAt(dir)).toBe("docs");
  // A listing of every bundle omits the scratch copy.
  expect(listAssets().every((asset) => asset.bundle === "docs")).toBe(true);
  expect(listAssets({ bundle }).map((asset) => asset.conceptId)).toEqual(["knowledge/note"]);
});

test("AKM_BUNDLE_DIR keeps the id it always had (its basename slug), and is listed once", () => {
  const a = makeSandboxDir("akm-mat-implicit-");
  cleanups.push(a.cleanup);
  const dir = stashIn(a.dir);
  const saved = process.env.AKM_BUNDLE_DIR;
  process.env.AKM_BUNDLE_DIR = dir;
  try {
    const id = bundleNameOf(bundleAt(dir));
    expect(id).toBe("stash");
    expect(bundleFor(id).root).toBe(dir);
    expect(listAssets({ bundle: id }).map((asset) => asset.ref)).toEqual(["stash//knowledge/note"]);
  } finally {
    if (saved === undefined) delete process.env.AKM_BUNDLE_DIR;
    else process.env.AKM_BUNDLE_DIR = saved;
  }
});

test("a task source naming a configured bundle never replaces it: its adapter and location stay config's", async () => {
  const files = makeSandboxDir("akm-adhoc-files-");
  cleanups.push(files.cleanup);
  fs.mkdirSync(path.join(files.dir, "notes"), { recursive: true });
  fs.writeFileSync(path.join(files.dir, "notes", "n.md"), "# n\n", "utf8");
  saveConfig({
    semanticSearchMode: "off",
    bundles: {
      docs: { path: files.dir, adapter: "generic-files" },
      keyring: { adapter: "secret-tool", location: "akm" },
    },
    defaultBundle: "docs",
  });
  await withFakeSecretStores(
    {
      keyrings: {
        akm: [
          {
            path: "/org/freedesktop/secrets/collection/akm/1",
            label: "gh_token",
            attributes: { akm: "akm/gh_token" },
            secret: "ghp-value",
          },
        ],
      },
    },
    async () => {
      // A keyring entry is read by what the index recorded of it.
      await akmIndex({ stashDir: files.dir, full: true });
      // What a task prepare and a v5 check do: name the bundle by the source they hold, without its adapter or location.
      taskScopeOf({ name: "docs", path: files.dir });
      taskScopeOf({ name: "keyring", path: path.join(files.dir, "elsewhere") });
      expect(bundleFor("docs").adapterId).toBe("generic-files");
      // A copy of it held elsewhere (a task checked in a scratch directory) is read as config says the bundle is read.
      const scratch = makeSandboxDir("akm-adhoc-scratch-");
      cleanups.push(scratch.cleanup);
      taskScopeOf({ name: "docs", path: scratch.dir });
      expect(bundleFor("docs").adapterId).toBe("generic-files");
      expect(bundleFor("keyring").adapterId).toBe("secret-tool");
      expect(bundleFor("keyring").location).toBe("akm");
      expect(findAsset("keyring//secrets/gh_token")?.entry.content()).toBe("ghp-value");
    },
  );
});

describe("config takes precedence over a directory it names", () => {
  const loose = (): string => {
    const sandbox = makeSandboxDir("akm-mat-reload-");
    cleanups.push(sandbox.cleanup);
    // Named apart from the working bundle (`stash`), whose id a directory may otherwise share.
    const dir = path.join(sandbox.dir, "loose");
    fs.mkdirSync(path.join(dir, "knowledge"), { recursive: true });
    fs.writeFileSync(path.join(dir, "knowledge", "note.md"), "---\ndescription: n\n---\n\n# n\n", "utf8");
    return dir;
  };
  const refused = (dir: string, id: string) => {
    expect(bundleAt(dir)).toBe(id);
    expect(() => bundleFor(id)).toThrow();
    expect(() => readAsset(id, "knowledge/note")).toThrow();
    expect(findAsset(`${id}//knowledge/note`)).toBeUndefined();
    expect(() =>
      writeAssets(writeTargetAt(dir), { purpose: "test" }, (w) =>
        w.create({ type: "knowledge", name: "other", content: "x" }),
      ),
    ).toThrow(/disabled/);
    expect(fs.existsSync(path.join(dir, "knowledge", "other.md"))).toBe(false);
  };

  test("a bundle configured disabled under the directory's id", () => {
    const dir = loose();
    saveConfig({ semanticSearchMode: "off", bundles: { loose: { path: dir, enabled: false } } });
    refused(dir, "loose");
  });

  test("a bundle configured disabled at the directory's path, under another id", () => {
    const dir = loose();
    saveConfig({ semanticSearchMode: "off", bundles: { archived: { path: dir, enabled: false } } });
    refused(dir, "archived");
  });
});
