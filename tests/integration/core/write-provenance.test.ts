// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** The run-scoped write-provenance journal (#652). */

import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { editFrontmatter, parseFrontmatter } from "../../../src/core/asset/frontmatter";
import { writeAssets } from "../../../src/core/assets/write";
import { writeTargetAt } from "../../../src/core/bundle-at-dir";
import {
  beginWriteProvenance,
  isWriteProvenanceActive,
  recordWrittenPath,
  relativeWrittenPath,
} from "../../../src/core/write-provenance";

test("records absolute, deduped, sorted paths while open — and nothing once closed", () => {
  expect(isWriteProvenanceActive()).toBe(false);
  const journal = beginWriteProvenance();
  expect(isWriteProvenanceActive()).toBe(true);

  recordWrittenPath("/stash/memories/b.md");
  recordWrittenPath("/stash/memories/a.md");
  // Duplicates and equivalent spellings collapse to one entry.
  recordWrittenPath("/stash/memories/a.md");
  recordWrittenPath("/stash/memories/../memories/a.md");
  expect(journal.writtenPaths()).toEqual(["/stash/memories/a.md", "/stash/memories/b.md"]);

  expect(journal.end()).toEqual(["/stash/memories/a.md", "/stash/memories/b.md"]);
  expect(isWriteProvenanceActive()).toBe(false);
  recordWrittenPath("/stash/memories/c.md");
  expect(journal.writtenPaths()).toEqual(["/stash/memories/a.md", "/stash/memories/b.md"]);
  // end() is idempotent — closing twice is not an error.
  expect(journal.end()).toEqual(["/stash/memories/a.md", "/stash/memories/b.md"]);
});

test("recording outside a journal is a no-op, and empty paths are ignored", () => {
  expect(() => recordWrittenPath("/stash/memories/a.md")).not.toThrow();
  const journal = beginWriteProvenance();
  try {
    recordWrittenPath("");
    recordWrittenPath(undefined);
    recordWrittenPath(null);
    expect(journal.writtenPaths()).toEqual([]);
  } finally {
    journal.end();
  }
});

test("nested journals each observe every write", () => {
  const outer = beginWriteProvenance();
  recordWrittenPath("/stash/memories/outer.md");
  const inner = beginWriteProvenance();
  recordWrittenPath("/stash/memories/inner.md");
  expect(inner.end()).toEqual(["/stash/memories/inner.md"]);
  recordWrittenPath("/stash/memories/after.md");
  expect(outer.end()).toEqual(["/stash/memories/after.md", "/stash/memories/inner.md", "/stash/memories/outer.md"]);
});

test("relativeWrittenPath returns POSIX-relative inside the root, undefined outside", () => {
  expect(relativeWrittenPath("/repo", "/repo/memories/a.md")).toBe("memories/a.md");
  expect(relativeWrittenPath("/repo", "/repo")).toBeUndefined();
  expect(relativeWrittenPath("/repo", "/elsewhere/a.md")).toBeUndefined();
  expect(relativeWrittenPath("/repo", "/repository/a.md")).toBeUndefined();
});

test("an in-place frontmatter stamp journals the asset it rewrote", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-provenance-"));
  const filePath = path.join(dir, "memories", "note.md");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "---\ntype: memory\n---\n\nBody.\n", "utf8");
  const journal = beginWriteProvenance();
  try {
    writeAssets(writeTargetAt(dir), { purpose: "test" }, (w) => {
      const held = w.read("memories/note");
      const next = editFrontmatter(held?.entry.content() as string, (parsed) => ({
        ...parsed.data,
        beliefState: "deprecated",
      }));
      w.update("memories/note", next as string);
    });
    expect(journal.writtenPaths()).toEqual([fs.realpathSync(filePath)]);
    expect(parseFrontmatter(fs.readFileSync(filePath, "utf8")).data.beliefState).toBe("deprecated");
  } finally {
    journal.end();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
