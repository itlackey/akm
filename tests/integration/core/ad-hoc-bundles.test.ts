// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * A directory no config names (`--dir`) is a bundle the facade takes by an id (§4.2, 4e.2). Each directory has one id for
 * the life of the process, and two directories with one basename never share one.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { bundleFor } from "../../../src/core/assets/bundle";
import { findAsset } from "../../../src/core/assets/read";
import { addressOf } from "../../../src/core/assets/write";
import { bundleIdAt } from "../../../src/core/bundle-at-dir";
import { saveConfig } from "../../../src/core/config/config";
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

test("two unconfigured directories with one basename get distinct ids, and each id reads its own directory", () => {
  const a = makeSandboxDir("akm-adhoc-a-");
  const b = makeSandboxDir("akm-adhoc-b-");
  cleanups.push(a.cleanup, b.cleanup);
  const dirA = stashIn(a.dir);
  const dirB = stashIn(b.dir);

  const idA = bundleIdAt(dirA);
  const idB = bundleIdAt(dirB);

  expect(idA).not.toBe(idB);
  expect(addressOf(idA, "knowledge/note").file).toBe(path.join(dirA, "knowledge", "note.md"));
  expect(addressOf(idB, "knowledge/note").file).toBe(path.join(dirB, "knowledge", "note.md"));
  // A directory keeps its id.
  expect(bundleIdAt(dirA)).toBe(idA);
  expect(bundleIdAt(dirB)).toBe(idB);
  expect(addressOf(idA, "knowledge/note").file).toBe(path.join(dirA, "knowledge", "note.md"));
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
