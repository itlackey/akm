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
import type { PackageFile } from "../../../src/core/adapter/bundle-adapter";
import type { Bundle } from "../../../src/core/adapter/types";
import { sandboxStashDir } from "../../_helpers/sandbox";

let sandbox: ReturnType<typeof sandboxStashDir>;
let bundle: Bundle & { root: string };

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

  test("an asset a full walk would not reach (a dot-directory) is no asset: read and list agree", () => {
    for (const rel of ["knowledge/ok.md", ".hidden/knowledge/x.md"]) {
      fs.mkdirSync(path.dirname(path.join(bundle.root, rel)), { recursive: true });
      fs.writeFileSync(path.join(bundle.root, rel), "# x\n");
    }
    expect(akmAdapter.read(bundle, "knowledge/ok")?.conceptId).toBe("knowledge/ok");
    expect(akmAdapter.read(bundle, ".hidden/knowledge/x")).toBeUndefined();
    expect(akmAdapter.list(bundle).assets.map((asset) => asset.conceptId)).toEqual(["knowledge/ok"]);
  });

  test("read finds a loose file under its path-derived concept id, and nothing for a file that is not there", () => {
    const file = path.join(bundle.root, "stray", "note.md");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "# a note\n");
    expect(akmAdapter.read(bundle, "stray/note")?.entry.file).toBe(file);
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
        .assets.map((asset) => asset.entry.key)
        .filter((rel) => rel.startsWith("tasks/same.")),
    ).toEqual(["tasks/same.yml"]);

    const diagnostics = await akmAdapter.validate(bundle, [{ conceptId: "tasks/same", op: "update" }], {});
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
    const ideaFile = path.join(bundle.root, "knowledge", "idea.md");
    expect(created.changed).toEqual([ideaFile]);

    akmAdapter.update(bundle, "knowledge/idea", "changed\n");
    const read = akmAdapter.read(bundle, "knowledge/idea");
    expect(read?.entry.content()).toBe("changed\n");
    expect(read?.entry.bytes().toString("utf8")).toBe("changed\n");

    expect(akmAdapter.delete(bundle, "knowledge/idea").changed).toEqual([ideaFile]);
    expect(akmAdapter.read(bundle, "knowledge/idea")).toBeUndefined();
  });

  test("create with resources writes the package as one folder and replaces an older one whole", () => {
    const skill = { type: "skill", name: "demo", content: "---\nname: demo\n---\nbody\n" };
    const first = akmAdapter.create(bundle, {
      ...skill,
      resources: [{ path: "scripts/run.sh", content: Buffer.from("echo old\n") }],
    });
    const dir = path.join(bundle.root, "skills", "demo");
    expect(first.changed).toContain(path.join(dir, "SKILL.md"));
    expect(fs.readFileSync(path.join(dir, "scripts", "run.sh"), "utf8")).toBe("echo old\n");

    // The adapter refuses to create over an asset: the facade takes a package out whole first (a delete cascades).
    const deleted = akmAdapter.delete(bundle, "skills/demo");
    expect(deleted.changed).toContain(path.join(dir, "scripts", "run.sh"));
    expect(fs.existsSync(dir)).toBe(false);
    const second = akmAdapter.create(bundle, {
      ...skill,
      resources: [{ path: "notes.txt", content: Buffer.from("new") }],
    });
    expect(fs.existsSync(path.join(dir, "scripts"))).toBe(false);
    expect(fs.readFileSync(path.join(dir, "notes.txt"), "utf8")).toBe("new");
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

  test("an env file is private, and a leftover `.sensitive` marker beside it changes nothing", () => {
    const created = akmAdapter.create(bundle, { type: "env", name: "prod", content: "A=1\n" });
    const file = path.join(bundle.root, "env", "prod.env");
    const marker = path.join(bundle.root, "env", "prod.sensitive");
    expect(created.changed).toEqual([file]);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    fs.writeFileSync(marker, "");

    expect(akmAdapter.read(bundle, "env/prod")?.conceptId).toBe("env/prod");

    // Delete removes the asset's file only: a marker left in the bundle is not the asset's.
    expect(akmAdapter.delete(bundle, "env/prod").changed).toEqual([file]);
    expect(fs.existsSync(marker)).toBe(true);
  });

  test("a file in a directory a full walk skips is not an asset of the bundle", () => {
    fs.mkdirSync(path.join(bundle.root, "knowledge", ".hidden"), { recursive: true });
    fs.writeFileSync(path.join(bundle.root, "knowledge", ".hidden", "idea.md"), "x\n");
    akmAdapter.create(bundle, { type: "knowledge", name: "idea", content: "x\n" });
    expect(akmAdapter.read(bundle, "knowledge/idea")?.conceptId).toBe("knowledge/idea");
    expect(akmAdapter.read(bundle, "knowledge/.hidden/idea")).toBeUndefined();
  });

  describe("packages (§0.2 P12)", () => {
    const entry = (bytes: string): PackageFile => ({ path: "SKILL.md", bytes: Buffer.from(bytes), mode: 0o644 });
    const dir = () => path.join(bundle.root, "skills", "demo");
    const skill = { type: "skill", name: "demo" };

    test("packageFiles lists every file of the package, non-assets and dot files included, with bytes and mode", () => {
      akmAdapter.mirrorPackage(bundle, skill, [
        entry("---\nname: demo\n---\nbody\n"),
        { path: "scripts/run.sh", bytes: Buffer.from("#!/bin/sh\n"), mode: 0o755 },
        { path: ".env.example", bytes: Buffer.from("A=1\n"), mode: 0o644 },
        { path: "data/blob.bin", bytes: Buffer.from([0, 255, 1]), mode: 0o644 },
      ]);
      const files = akmAdapter.packageFiles(bundle, "skills/demo");
      expect(files.map((file) => file.path)).toEqual([".env.example", "SKILL.md", "data/blob.bin", "scripts/run.sh"]);
      expect(files.find((file) => file.path === "scripts/run.sh")?.mode).toBe(0o755);
      expect([...(files.find((file) => file.path === "data/blob.bin")?.bytes ?? [])]).toEqual([0, 255, 1]);
    });

    test("mirrorPackage keeps bytes exactly (Markdown included) and an executable script's mode", () => {
      const markdown = "---\nname: demo\n---\r\nno trailing newline";
      akmAdapter.mirrorPackage(bundle, skill, [
        entry(markdown),
        { path: "notes.md", bytes: Buffer.from("# Notes\r\n  \n"), mode: 0o644 },
        { path: "scripts/run.sh", bytes: Buffer.from("#!/bin/sh\n"), mode: 0o755 },
      ]);
      expect(fs.readFileSync(path.join(dir(), "SKILL.md"), "utf8")).toBe(markdown);
      expect(fs.readFileSync(path.join(dir(), "notes.md"), "utf8")).toBe("# Notes\r\n  \n");
      expect(fs.statSync(path.join(dir(), "scripts", "run.sh")).mode & 0o777).toBe(0o755);
    });

    test("an existing package is refused without replace, with the sentence naming it", () => {
      akmAdapter.mirrorPackage(bundle, skill, [entry("one\n")]);
      expect(() => akmAdapter.mirrorPackage(bundle, skill, [entry("two\n")])).toThrow(
        `Asset already exists in bundle "stash": ${dir()}. Use --force to overwrite.`,
      );
      expect(fs.readFileSync(path.join(dir(), "SKILL.md"), "utf8")).toBe("one\n");
    });

    test("replace overwrites existing files and removes the target's files the source lacks, assets or not", () => {
      akmAdapter.mirrorPackage(bundle, skill, [
        entry("old\n"),
        { path: "stale.txt", bytes: Buffer.from("x"), mode: 0o644 },
        { path: "deep/stale.md", bytes: Buffer.from("x"), mode: 0o644 },
        { path: "kept.txt", bytes: Buffer.from("old"), mode: 0o644 },
      ]);
      const changes = akmAdapter.mirrorPackage(
        bundle,
        skill,
        [entry("new\n"), { path: "kept.txt", bytes: Buffer.from("new"), mode: 0o644 }],
        { replace: true },
      );
      expect(fs.readdirSync(dir()).sort()).toEqual(["SKILL.md", "kept.txt"]);
      expect(fs.readFileSync(path.join(dir(), "kept.txt"), "utf8")).toBe("new");
      // The entry's change comes first and lists the old files too, so a commit boundary records their removal.
      expect(changes[0]?.conceptId).toBe("skills/demo");
      expect(changes[0]?.changed).toContain(path.join(dir(), "stale.txt"));
      // A file the akm adapter reads as an asset of its own is that asset's change.
      expect(changes.flatMap((change) => change.changed)).toContain(path.join(dir(), "deep", "stale.md"));
      expect(changes[0]?.changed).toContain(path.join(dir(), "kept.txt"));
    });

    test("a failure leaves the target as it was and no staging folder behind", () => {
      akmAdapter.mirrorPackage(bundle, skill, [
        entry("old\n"),
        { path: "a.txt", bytes: Buffer.from("a"), mode: 0o644 },
      ]);
      // A file that is a folder in the same package cannot be staged.
      const broken = [
        entry("new\n"),
        { path: "x", bytes: Buffer.from("1"), mode: 0o644 },
        { path: "x/y", bytes: Buffer.from("2"), mode: 0o644 },
      ];
      expect(() => akmAdapter.mirrorPackage(bundle, skill, broken, { replace: true })).toThrow();
      expect(fs.readFileSync(path.join(dir(), "SKILL.md"), "utf8")).toBe("old\n");
      expect(fs.readFileSync(path.join(dir(), "a.txt"), "utf8")).toBe("a");
      expect(fs.readdirSync(path.join(bundle.root, "skills"))).toEqual(["demo"]);
    });

    test("a package without its entry, or with a path that leaves it, is refused before anything is written", () => {
      expect(() =>
        akmAdapter.mirrorPackage(bundle, skill, [{ path: "a.txt", bytes: Buffer.from("a"), mode: 0o644 }]),
      ).toThrow(/no SKILL.md/);
      expect(() =>
        akmAdapter.mirrorPackage(bundle, skill, [
          entry("x\n"),
          { path: "../escape.txt", bytes: Buffer.from("a"), mode: 0o644 },
        ]),
      ).toThrow(/leaves the skill package/);
      expect(fs.existsSync(dir())).toBe(false);
    });

    test("deleting a package entry deletes the package, resources and all", () => {
      akmAdapter.mirrorPackage(bundle, skill, [
        entry("x\n"),
        { path: "scripts/run.sh", bytes: Buffer.from("echo\n"), mode: 0o755 },
      ]);
      const deleted = akmAdapter.delete(bundle, "skills/demo");
      expect(deleted.changed.sort()).toEqual([path.join(dir(), "SKILL.md"), path.join(dir(), "scripts", "run.sh")]);
      expect(fs.existsSync(dir())).toBe(false);
      expect(akmAdapter.read(bundle, "skills/demo")).toBeUndefined();
    });
  });
});
