// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** A qualified ref is looked up in the bundle it names; an unqualified ref is looked up in every bundle, as before. */
import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmLint } from "../../src/commands/lint";
import { resetConfigCache } from "../../src/core/config/config";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../_helpers/sandbox";

let storage: IsolatedAkmStorage;
let other: string;

const put = (root: string, rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};
const doc = (extra = "") => `---\ndescription: D\nupdated: 2026-11-01\n${extra}---\n\nBody.\n`;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  other = path.join(storage.root, "other");
  fs.mkdirSync(other, { recursive: true });
  writeSandboxConfig({
    semanticSearchMode: "off",
    defaultBundle: "stash",
    bundles: {
      stash: { path: storage.stashDir, writable: true, adapter: "akm" },
      other: { path: other, writable: true, adapter: "akm" },
    },
  });
  resetConfigCache();
});
afterEach(() => {
  resetConfigCache();
  storage.cleanup();
});

const missing = async () =>
  (await akmLint({ dir: storage.stashDir, rule: "missing-ref" })).flagged.map((issue) => issue.detail.split(" (")[0]);

test("a qualified ref to a path that exists only in another bundle is reported", async () => {
  put(other, "knowledge/only-there.md", doc());
  put(storage.stashDir, "knowledge/a.md", doc("xrefs:\n  - stash//knowledge/only-there\n"));
  put(storage.stashDir, "knowledge/b.md", doc().replace("Body.", "See stash//knowledge/only-there now."));

  expect(await missing()).toEqual([
    "missing ref: stash//knowledge/only-there",
    "missing ref: stash//knowledge/only-there",
  ]);
});

test("a qualified ref that exists in the bundle it names is not reported", async () => {
  put(other, "knowledge/only-there.md", doc());
  put(storage.stashDir, "knowledge/a.md", doc("xrefs:\n  - other//knowledge/only-there\n"));
  put(storage.stashDir, "knowledge/b.md", doc().replace("Body.", "See other//knowledge/only-there now."));

  expect(await missing()).toEqual([]);
});

test("an unqualified ref is found in any bundle, as before", async () => {
  put(other, "knowledge/only-there.md", doc());
  put(storage.stashDir, "knowledge/a.md", doc("xrefs:\n  - knowledge/only-there\n"));

  expect(await missing()).toEqual([]);
});
