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
import { addressOf } from "../../../src/core/assets/write";
import { bundleIdAt } from "../../../src/core/bundle-at-dir";
import { saveConfig } from "../../../src/core/config/config";
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
