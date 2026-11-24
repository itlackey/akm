// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * One link rule for every write: a link is followed only when it leads to an existing file or folder inside the
 * bundle. A `--force` create whose target is such a link is replaced by a regular file, one in a folder that is such a
 * link is written through, and an update writes where the link leads and keeps it. A link out of the bundle or to
 * nothing is refused.
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

describe("every create follows the same rule", () => {
  const wf = () => path.join(storage.stashDir, "workflows");

  test("workflow create --force over a link to a file inside the bundle replaces the link; into a linked folder it writes the real one", async () => {
    fs.mkdirSync(path.join(wf(), "real"), { recursive: true });
    fs.writeFileSync(path.join(wf(), "target.md"), "OLD\n");
    fs.symlinkSync("target.md", path.join(wf(), "lk.md"));
    fs.symlinkSync("real", path.join(wf(), "dl"));

    expect((await runCliCapture(["workflow", "create", "lk", "--force", "--format=json"])).code).toBe(0);
    expect(fs.lstatSync(path.join(wf(), "lk.md")).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(wf(), "target.md"), "utf8")).toBe("OLD\n");

    expect((await runCliCapture(["workflow", "create", "x", "--path", "dl", "--format=json"])).code).toBe(0);
    expect(fs.existsSync(path.join(wf(), "real", "x.md"))).toBe(true);
    expect(fs.lstatSync(path.join(wf(), "dl")).isSymbolicLink()).toBe(true);
  });

  test("secret set over a link to a file inside the bundle replaces the link with a regular file of the secret's mode", async () => {
    const secrets = path.join(storage.stashDir, "secrets");
    fs.mkdirSync(secrets, { recursive: true });
    fs.writeFileSync(path.join(secrets, "target"), "old");
    fs.symlinkSync("target", path.join(secrets, "lk"));
    const value = path.join(storage.root, "value");
    fs.writeFileSync(value, "new");

    expect((await runCliCapture(["secret", "set", "secrets/lk", "--from-file", value, "--format=json"])).code).toBe(0);
    expect(fs.lstatSync(path.join(secrets, "lk")).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(secrets, "lk"), "utf8")).toBe("new");
    expect(fs.statSync(path.join(secrets, "lk")).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(path.join(secrets, "target"), "utf8")).toBe("old");
  });
});

describe("an update through a link inside the bundle", () => {
  test("feedback --replace writes where the link leads and keeps the link", async () => {
    fs.writeFileSync(path.join(kn(), "target.md"), "---\ndescription: old\n---\n\nThe sky is green.\n");
    expect((await runCliCapture(["index", "--format=json"])).code).toBe(0);

    const result = await runCliCapture([
      "feedback",
      "knowledge/lk",
      "--negative",
      "--reason",
      "colour",
      "--replace",
      "green",
      "--with",
      "blue",
      "--source",
      "https://example.com",
      "--format=json",
    ]);

    expect(result.code).toBe(0);
    expect(fs.lstatSync(path.join(kn(), "lk.md")).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(kn(), "target.md"), "utf8")).toContain("The sky is blue.");
  });
});
