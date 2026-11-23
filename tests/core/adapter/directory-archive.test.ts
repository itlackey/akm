// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The directory bundle's recoverable archive, through the `akm` adapter:
 * retire writes the tombstone before it moves the file, restore puts it back
 * (or writes a fallback once the archived copy has expired), forget drops the
 * record, expireRetired deletes only what git holds, and an env file or a
 * secret is never retired.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmAdapter } from "../../../src/core/adapter/adapters/akm-adapter";
import { okfAdapter } from "../../../src/core/adapter/adapters/okf-adapter";
import { MEMORY_ARCHIVE_REL, resetArchiveCache } from "../../../src/core/adapter/directory-archive";
import type { Bundle } from "../../../src/core/adapter/types";
import { parseFrontmatter } from "../../../src/core/asset/frontmatter";
import { git, makeGitRepo } from "../../_helpers/git";
import { sandboxStashDir } from "../../_helpers/sandbox";

let sandbox: ReturnType<typeof sandboxStashDir>;
let bundle: Bundle & { root: string };
const CONCEPT = "memories/old-note";
const NOTE = { ref: "memories/old-note", reason: "duplicate", proposalId: "p1", retiredAt: "2020-01-01T00:00:00.000Z" };

beforeEach(() => {
  resetArchiveCache();
  sandbox = sandboxStashDir();
  bundle = { id: "stash", root: sandbox.dir };
});
afterEach(() => sandbox.cleanup());

/** What the adapter wrote for `# old`: it adds frontmatter, so tests compare against this, not the input. */
let written: string;

function createMemory(): string {
  const created = akmAdapter.create(bundle, { type: "memory", name: "old-note", content: "# old\n" });
  expect(created.conceptId).toBe(CONCEPT);
  const file = path.join(bundle.root, "memories", "old-note.md");
  expect(created.changed).toEqual([file]);
  written = fs.readFileSync(file, "utf8");
  return file;
}

describe("DirectoryArchive through the akm adapter", () => {
  test("retire writes the tombstone, then moves the file, and returns the handle", () => {
    const file = createMemory();
    const retired = akmAdapter.retire(bundle, CONCEPT, NOTE);

    expect(fs.existsSync(file)).toBe(false);
    expect(retired.handle.startsWith(`${MEMORY_ARCHIVE_REL}/`)).toBe(true);
    const dir = path.join(bundle.root, retired.handle);
    expect(fs.existsSync(path.join(dir, "memories", "old-note.md"))).toBe(true);
    const tombstone = fs.readFileSync(path.join(dir, "cleanup.md"), "utf8");
    expect(tombstone).toContain("originalPath: memories/old-note.md");
    expect(tombstone).toContain("proposalId: p1");
    expect(retired.changed).toEqual([file, path.join(dir, "memories", "old-note.md"), path.join(dir, "cleanup.md")]);

    expect(akmAdapter.retired(bundle)).toEqual([
      {
        handle: retired.handle,
        conceptId: CONCEPT,
        note: { archivedAt: expect.any(String), ...NOTE, ref: "stash//memories/old-note" },
        restorable: true,
      },
    ]);
  });

  test("a retirement is named by concept ids: a ref into the bundle loses its `bundle//`, another bundle's stays (N11)", () => {
    createMemory();
    const { handle } = akmAdapter.retire(bundle, CONCEPT, {
      ...NOTE,
      ref: "stash//memories/old-note",
      parentRef: "stash//memories/parent",
      survivorRef: "other//memories/survivor",
      successorRefs: ["stash//memories/new-note", "other//memories/elsewhere"],
    });

    expect(handle).toMatch(/^\.akm\/memory-cleanup\/archive\/[^/]+-memories-old-note$/);
    const tombstone = parseFrontmatter(fs.readFileSync(path.join(bundle.root, handle, "cleanup.md"), "utf8")).data;
    expect(tombstone).toMatchObject({
      ref: "memories/old-note",
      parentRef: "memories/parent",
      survivorRef: "other//memories/survivor",
      successorRefs: ["memories/new-note", "other//memories/elsewhere"],
    });
    // Read back, every ref is qualified.
    expect(akmAdapter.retired(bundle)[0]?.note).toMatchObject({
      ref: "stash//memories/old-note",
      parentRef: "stash//memories/parent",
      survivorRef: "other//memories/survivor",
      successorRefs: ["stash//memories/new-note", "other//memories/elsewhere"],
    });
  });

  test("a retirement with no ref names its archive by the concept id and records none", () => {
    createMemory();
    const { handle } = akmAdapter.retire(bundle, CONCEPT, { reason: "duplicate" });
    expect(handle).toMatch(/-memories-old-note$/);
    expect(akmAdapter.retired(bundle)[0]?.note).not.toHaveProperty("ref");
  });

  test("a tombstone written before N11 (qualified refs, qualified directory name) is read as written, restored and forgotten", () => {
    const file = createMemory();
    const dirName = "2026-01-05T00-00-00-000Z-stash-memories-old-note";
    const archivedRel = `${MEMORY_ARCHIVE_REL}/${dirName}/memories/old-note.md`;
    fs.mkdirSync(path.dirname(path.join(bundle.root, archivedRel)), { recursive: true });
    fs.renameSync(file, path.join(bundle.root, archivedRel));
    fs.writeFileSync(
      path.join(bundle.root, MEMORY_ARCHIVE_REL, dirName, "cleanup.md"),
      [
        "---",
        "schemaVersion: 1",
        "kind: memory-cleanup-archive",
        "archivedAt: 2026-01-05T00:00:00.000Z",
        "ref: stash//memories/old-note",
        "successorRefs:",
        "  - stash//memories/new-note",
        "  - other//memories/elsewhere",
        "originalPath: memories/old-note.md",
        `archivedPath: ${archivedRel}`,
        "---",
        "",
        "Archived derived memory for recoverable cleanup.",
        "",
      ].join("\n"),
    );

    const [only] = akmAdapter.retired(bundle);
    expect(only).toMatchObject({
      handle: `${MEMORY_ARCHIVE_REL}/${dirName}`,
      conceptId: CONCEPT,
      note: {
        ref: "stash//memories/old-note",
        successorRefs: ["stash//memories/new-note", "other//memories/elsewhere"],
      },
      restorable: true,
    });
    expect(akmAdapter.restore(bundle, only?.handle as string).changed).toContain(file);
    expect(fs.readFileSync(file, "utf8")).toBe(written);
    akmAdapter.forget(bundle, only?.handle as string);
    expect(akmAdapter.retired(bundle)).toEqual([]);
  });

  test("a note ref that is not of the ref grammar (a retired `memory:` spelling) is read as written", () => {
    createMemory();
    akmAdapter.retire(bundle, CONCEPT, { ref: "memory:old-note", survivorRef: "memory:new-note" });
    expect(akmAdapter.retired(bundle)[0]?.note).toMatchObject({
      ref: "memory:old-note",
      survivorRef: "memory:new-note",
    });
  });

  test("a crash between the tombstone and the move leaves the file in place, and restore then changes nothing", () => {
    const file = createMemory();
    const rename = spyOn(fs, "renameSync").mockImplementationOnce(() => {
      throw new Error("crash");
    });
    try {
      expect(() => akmAdapter.retire(bundle, CONCEPT, NOTE)).toThrow("crash");
    } finally {
      rename.mockRestore();
    }

    expect(fs.existsSync(file)).toBe(true);
    const [only] = akmAdapter.retired(bundle);
    expect(only?.restorable).toBe(false);
    expect(akmAdapter.restore(bundle, (only as NonNullable<typeof only>).handle).changed).toEqual([]);
    expect(fs.readFileSync(file, "utf8")).toBe(written);
  });

  test("restore moves the file back and keeps the record until forget", () => {
    const file = createMemory();
    const { handle } = akmAdapter.retire(bundle, CONCEPT, NOTE);

    const restored = akmAdapter.restore(bundle, handle);
    expect(restored.conceptId).toBe(CONCEPT);
    expect(restored.changed).toContain(file);
    expect(fs.readFileSync(file, "utf8")).toBe(written);
    expect(akmAdapter.retired(bundle).map((r) => r.handle)).toEqual([handle]);
    expect(akmAdapter.restore(bundle, handle).changed).toEqual([]); // again: already restored

    akmAdapter.forget(bundle, handle);
    expect(akmAdapter.retired(bundle)).toEqual([]);
    expect(fs.existsSync(path.join(bundle.root, handle))).toBe(false);
    expect(akmAdapter.forget(bundle, handle).changed).toEqual([]); // again: nothing to forget
    expect(() => akmAdapter.restore(bundle, handle)).toThrow(/No retirement/);
  });

  test("restore refuses to overwrite a file created since the retirement", () => {
    createMemory();
    const { handle } = akmAdapter.retire(bundle, CONCEPT, NOTE);
    const file = createMemory(); // same name, new content
    expect(() => akmAdapter.restore(bundle, handle)).toThrow(/already exists \(created since retirement\)/);
    expect(fs.readFileSync(file, "utf8")).toBe(written);
  });

  test("restore writes the fallback when the archived copy is gone, and refuses without one", () => {
    const file = createMemory();
    const { handle } = akmAdapter.retire(bundle, CONCEPT, NOTE);
    fs.rmSync(path.join(bundle.root, handle, "memories"), { recursive: true });
    expect(akmAdapter.retired(bundle)[0]?.restorable).toBe(false);

    expect(() => akmAdapter.restore(bundle, handle)).toThrow(/nothing to restore it from/);
    expect(akmAdapter.restore(bundle, handle, "# from the proposal\n").changed).toEqual([file]);
    expect(fs.readFileSync(file, "utf8")).toBe("# from the proposal\n");
  });

  test("a handle outside the archive is refused", () => {
    expect(() => akmAdapter.restore(bundle, "memories")).toThrow(/not a retirement/);
    expect(() => akmAdapter.forget(bundle, "../elsewhere")).toThrow(/not a retirement/);
  });

  test("expireRetired changes nothing in a bundle without git", () => {
    const file = createMemory();
    const { handle } = akmAdapter.retire(bundle, CONCEPT, NOTE);
    expect(akmAdapter.expireRetired(bundle, new Date()).changed).toEqual([]);
    expect(fs.existsSync(path.join(bundle.root, handle, "memories", "old-note.md"))).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
  });

  describe("in a git bundle", () => {
    beforeEach(() => {
      makeGitRepo({ dir: bundle.root });
    });

    test("expireRetired deletes the committed archived file and keeps the tombstone", () => {
      createMemory();
      const { handle } = akmAdapter.retire(bundle, CONCEPT, NOTE);
      git(bundle.root, ["add", "-A"]);
      git(bundle.root, ["commit", "-q", "-m", "retire"]);

      const expired = akmAdapter.expireRetired(bundle, new Date("2021-01-01"));
      const archived = path.join(bundle.root, handle, "memories", "old-note.md");
      expect(expired.changed).toEqual([archived]);
      expect(fs.existsSync(archived)).toBe(false);
      expect(fs.existsSync(path.join(bundle.root, handle, "cleanup.md"))).toBe(true);
      expect(akmAdapter.retired(bundle)[0]?.restorable).toBe(false);
    });

    test("expireRetired skips a retirement that is not past the cutoff, or has a dirty or untracked file", () => {
      createMemory();
      const { handle } = akmAdapter.retire(bundle, CONCEPT, NOTE);
      const archived = path.join(bundle.root, handle, "memories", "old-note.md");

      // Untracked: not committed yet.
      expect(akmAdapter.expireRetired(bundle, new Date("2021-01-01")).changed).toEqual([]);

      git(bundle.root, ["add", "-A"]);
      git(bundle.root, ["commit", "-q", "-m", "retire"]);
      // Before the cutoff.
      expect(akmAdapter.expireRetired(bundle, new Date("2019-01-01")).changed).toEqual([]);

      // Dirty: changed since the commit.
      fs.writeFileSync(archived, "edited\n");
      expect(akmAdapter.expireRetired(bundle, new Date("2021-01-01")).changed).toEqual([]);
      expect(fs.existsSync(archived)).toBe(true);
    });
  });

  test("an env file and a secret are deleted, never retired", () => {
    akmAdapter.create(bundle, { type: "env", name: "prod", content: "A=1\n" });
    akmAdapter.create(bundle, { type: "secret", name: "token", content: "v" });
    expect(() => akmAdapter.retire(bundle, "env/prod", {})).toThrow(/does not retire env assets/);
    expect(() => akmAdapter.retire(bundle, "secrets/token", {})).toThrow(/does not retire secret assets/);
    expect(fs.existsSync(path.join(bundle.root, "env", "prod.env"))).toBe(true);
    expect(fs.existsSync(path.join(bundle.root, MEMORY_ARCHIVE_REL))).toBe(false);
  });

  test("a read-only adapter refuses every retire member that would change something", () => {
    expect(okfAdapter.retires).toEqual([]);
    expect(okfAdapter.retired(bundle)).toEqual([]);
    expect(() => okfAdapter.retire(bundle, "a", {})).toThrow();
    expect(() => okfAdapter.restore(bundle, "h")).toThrow(/does not retire/);
    expect(() => okfAdapter.forget(bundle, "h")).toThrow(/does not retire/);
    expect(() => okfAdapter.expireRetired(bundle, new Date())).toThrow(/does not retire/);
  });
});
