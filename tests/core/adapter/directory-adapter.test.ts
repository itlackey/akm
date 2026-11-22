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
  bundle = { id: "stash", root: sandbox.dir };
});
afterEach(() => sandbox.cleanup());

describe("DirectoryAdapterBase", () => {
  test("place names the concept id a create would give, without writing", () => {
    expect(akmAdapter.place(bundle, { type: "knowledge", name: "notes/idea" })).toBe("knowledge/notes/idea");
    expect(fs.existsSync(path.join(bundle.root, "knowledge", "notes"))).toBe(false);
  });

  test("an adapter that writes no types refuses to place or create", () => {
    // A plain invariant: the asset facade refuses these with the sentence users see, before an adapter is asked.
    expect(() => okfAdapter.place(bundle, { type: "knowledge", name: "a" })).toThrow(/does not write knowledge assets/);
    expect(() => okfAdapter.create(bundle, { type: "knowledge", name: "a", content: "x" })).toThrow(
      /does not write knowledge assets/,
    );
    expect(() => okfAdapter.delete(bundle, "a")).toThrow();
  });

  test("read tells an asset a full walk would not reach (a dot-directory) from one it lists", () => {
    for (const rel of ["knowledge/ok.md", ".hidden/knowledge/x.md"]) {
      fs.mkdirSync(path.dirname(path.join(bundle.root, rel)), { recursive: true });
      fs.writeFileSync(path.join(bundle.root, rel), "# x\n");
    }
    expect(akmAdapter.read(bundle, "knowledge/ok")).toMatchObject({ type: "knowledge", listed: true });
    expect(akmAdapter.read(bundle, ".hidden/knowledge/x")).toMatchObject({ type: "knowledge", listed: false });
  });

  test("read knows an asset's type when it returns it, and finds nothing for a file it cannot type", () => {
    const file = path.join(bundle.root, "stray", "note.md");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "# a note\n");
    expect(akmAdapter.read(bundle, "stray/note")?.type).toBe("knowledge");
    expect(akmAdapter.read(bundle, "stray/none")).toBeUndefined();
  });

  test("a concept held by two files acts on the winner, and validate names the winner and the ignored file", async () => {
    const dir = path.join(bundle.root, "tasks");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "same.md"), "# loose\n");
    fs.writeFileSync(path.join(dir, "same.yml"), "name: same\n");
    const winner = path.join(dir, "same.yml");

    expect(akmAdapter.read(bundle, "tasks/same")?.entry.file).toBe(winner);
    akmAdapter.update(bundle, "tasks/same", "name: changed\n");
    expect(fs.readFileSync(winner, "utf8")).toBe("name: changed\n");
    expect(fs.readFileSync(path.join(dir, "same.md"), "utf8")).toBe("# loose\n");

    // List agrees with read: one entry for the concept, the winner.
    expect(
      akmAdapter
        .list(bundle)
        .entries.map((entry) => entry.relPath)
        .filter((rel) => rel.startsWith("tasks/same.")),
    ).toEqual(["tasks/same.yml"]);

    const diagnostics = await akmAdapter.validate(
      bundle,
      [{ path: "tasks/same.md", op: "delete" }] as never,
      {
        readFile: async (file: string) => fs.readFileSync(path.join(bundle.root, file), "utf8"),
      } as never,
    );
    expect(diagnostics.filter((d) => d.issue === "shadowed-spelling")).toEqual([
      expect.objectContaining({ file: "tasks/same.yml", detail: expect.stringContaining("tasks/same.md") }),
    ]);
  });

  test("forget and expireRetired answer with the files they changed, and nothing else", () => {
    akmAdapter.create(bundle, { type: "memory", name: "old", content: "# old\n" });
    const { handle } = akmAdapter.retire(bundle, "memories/old", { retiredAt: "2020-01-01T00:00:00.000Z" });
    expect(Object.keys(akmAdapter.expireRetired(bundle, new Date()))).toEqual(["changed"]);
    expect(Object.keys(akmAdapter.forget(bundle, handle))).toEqual(["changed"]);
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
