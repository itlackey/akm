// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * A `--force` import whose target is a symbolic link inside the bundle, or sits in a folder that is one, behaves as
 * `1f2e58c9` did: the file link is replaced by a regular file, a folder link is written through. A link out of the
 * bundle or to nothing is refused.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { runCliCapture } from "../../_helpers/cli";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../_helpers/sandbox";

let storage: IsolatedAkmStorage;
let doc: string;
const kn = () => path.join(storage.stashDir, "knowledge");

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  fs.mkdirSync(path.join(kn(), "real"), { recursive: true });
  fs.writeFileSync(path.join(kn(), "real", "in.md"), "---\ndescription: old\n---\n\nOLD\n");
  fs.writeFileSync(path.join(kn(), "target.md"), "---\ndescription: old\n---\n\nOLD\n");
  fs.symlinkSync("real", path.join(kn(), "dl"));
  fs.symlinkSync("target.md", path.join(kn(), "lk.md"));
  fs.mkdirSync(path.join(storage.root, "outside"));
  fs.symlinkSync(path.join(storage.root, "outside"), path.join(kn(), "esc"));
  fs.symlinkSync("nowhere", path.join(kn(), "brk"));
  doc = path.join(storage.root, "doc.md");
  fs.writeFileSync(doc, "---\ndescription: new\n---\n\nNEW\n");
});

afterEach(() => storage.cleanup());

const imp = (...args: string[]) => runCliCapture(["import", doc, ...args, "--force", "--format=json"]);

describe("--force over links inside the bundle", () => {
  test("a link to a file is replaced by a file; what it pointed at is left", async () => {
    expect((await imp("--name", "lk")).code).toBe(0);
    expect(fs.lstatSync(path.join(kn(), "lk.md")).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(kn(), "lk.md"), "utf8")).toContain("NEW");
    expect(fs.readFileSync(path.join(kn(), "target.md"), "utf8")).toContain("OLD");
  });

  test("a folder that is a link to a folder inside the bundle is written through", async () => {
    expect((await imp("--path", "dl", "--name", "in")).code).toBe(0);
    expect(fs.readFileSync(path.join(kn(), "real", "in.md"), "utf8")).toContain("NEW");
    expect(fs.lstatSync(path.join(kn(), "dl")).isSymbolicLink()).toBe(true);
  });

  test("a folder link out of the bundle, or to nothing, is refused", async () => {
    expect((await imp("--path", "esc", "--name", "e")).code).not.toBe(0);
    expect(fs.readdirSync(path.join(storage.root, "outside"))).toEqual([]);
    expect((await imp("--path", "brk", "--name", "e")).code).not.toBe(0);
  });
});
