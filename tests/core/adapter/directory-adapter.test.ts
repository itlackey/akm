// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `DirectoryAdapterBase`'s template methods, through the `akm` adapter: placing
 * without writing, creating an asset with the files that belong to it, keeping
 * an env file out of listings with a marker, and refusing what the adapter does
 * not write.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmAdapter } from "../../../src/core/adapter/adapters/akm-adapter";
import { okfAdapter } from "../../../src/core/adapter/adapters/okf-adapter";
import type { Bundle } from "../../../src/core/adapter/types";
import { sandboxStashDir } from "../../_helpers/sandbox";

let sandbox: ReturnType<typeof sandboxStashDir>;
let bundle: Bundle;

beforeEach(() => {
  sandbox = sandboxStashDir();
  bundle = { id: "stash", root: sandbox.dir, writable: true };
});
afterEach(() => sandbox.cleanup());

describe("DirectoryAdapterBase", () => {
  test("place names the concept id a create would give, without writing", () => {
    expect(akmAdapter.place(bundle, { type: "knowledge", name: "notes/idea" })).toBe("knowledge/notes/idea");
    expect(fs.existsSync(path.join(bundle.root, "knowledge", "notes"))).toBe(false);
  });

  test("an adapter that writes no types refuses to place or create", () => {
    expect(() => okfAdapter.place(bundle, { type: "knowledge", name: "a" })).toThrow(/does not hold knowledge assets/);
    expect(() => okfAdapter.create(bundle, { type: "knowledge", name: "a", content: "x" })).toThrow(
      /does not hold knowledge assets/,
    );
    expect(() => okfAdapter.delete(bundle, "a")).toThrow();
  });

  test("create writes the asset, update replaces it, delete removes it", () => {
    const created = akmAdapter.create(bundle, { type: "knowledge", name: "idea", content: "# Idea\n" });
    expect(created.conceptId).toBe("knowledge/idea");
    expect(created.file).toBe(path.join(bundle.root, "knowledge", "idea.md"));
    expect(created.changed).toEqual([created.file as string]);

    akmAdapter.update(bundle, "knowledge/idea", "changed\n");
    const read = akmAdapter.read(bundle, "knowledge/idea");
    expect(read?.type).toBe("knowledge");
    expect(read?.entry.content()).toBe("changed\n");
    expect(read?.entry.bytes().toString("utf8")).toBe("changed\n");

    expect(akmAdapter.delete(bundle, "knowledge/idea").changed).toEqual([created.file as string]);
    expect(akmAdapter.read(bundle, "knowledge/idea")).toBeUndefined();
  });

  test("create with resources writes the package as one folder and replaces an older one whole", () => {
    const skill = { type: "skill", name: "demo", content: "---\nname: demo\n---\nbody\n" };
    const first = akmAdapter.create(bundle, {
      ...skill,
      resources: [{ path: "scripts/run.sh", content: Buffer.from("echo old\n") }],
    });
    const dir = path.join(bundle.root, "skills", "demo");
    expect(first.file).toBe(path.join(dir, "SKILL.md"));
    expect(fs.readFileSync(path.join(dir, "scripts", "run.sh"), "utf8")).toBe("echo old\n");

    const second = akmAdapter.create(bundle, {
      ...skill,
      resources: [{ path: "notes.txt", content: Buffer.from("new") }],
    });
    expect(fs.existsSync(path.join(dir, "scripts"))).toBe(false);
    expect(fs.readFileSync(path.join(dir, "notes.txt"), "utf8")).toBe("new");
    // The old files are in `changed` too, so a commit boundary records their removal.
    expect(second.changed).toContain(path.join(dir, "scripts", "run.sh"));
    expect(second.changed).toContain(path.join(dir, "notes.txt"));
    expect(fs.readdirSync(path.join(bundle.root, "skills")).filter((name) => name.includes(".tmp-"))).toEqual([]);

    const read = akmAdapter.read(bundle, "skills/demo");
    expect(read?.entry.resources?.().map((resource) => resource.path)).toEqual(["notes.txt"]);
    expect(read?.entry.resources?.()[0]?.bytes().toString("utf8")).toBe("new");
  });

  test("a resource may not leave its package", () => {
    expect(() =>
      akmAdapter.create(bundle, {
        type: "skill",
        name: "demo",
        content: "x\n",
        resources: [{ path: "../escape.txt", content: Buffer.from("x") }],
      }),
    ).toThrow(/leaves the skill package/);
    expect(fs.existsSync(path.join(bundle.root, "skills", "demo"))).toBe(false);
  });

  test("an unlisted env file has a marker: read still finds it, as not listed, and delete removes both", () => {
    const created = akmAdapter.create(bundle, { type: "env", name: "prod", content: "A=1\n", unlisted: true });
    const file = path.join(bundle.root, "env", "prod.env");
    const marker = path.join(bundle.root, "env", "prod.sensitive");
    expect(created.changed).toEqual([file, marker]);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);

    const read = akmAdapter.read(bundle, "env/prod");
    expect(read?.listed).toBe(false);
    expect(read?.type).toBe("env");

    expect(akmAdapter.delete(bundle, "env/prod").changed).toEqual([file, marker]);
    expect(fs.existsSync(marker)).toBe(false);
  });

  test("a listed asset is read as listed, and a type with no marker cannot be unlisted", () => {
    akmAdapter.create(bundle, { type: "knowledge", name: "idea", content: "x\n" });
    expect(akmAdapter.read(bundle, "knowledge/idea")?.listed).toBe(true);
    expect(() => akmAdapter.create(bundle, { type: "knowledge", name: "other", content: "x", unlisted: true })).toThrow(
      /cannot be marked sensitive/,
    );
    expect(fs.existsSync(path.join(bundle.root, "knowledge", "other.md"))).toBe(false);
  });
});
