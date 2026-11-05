// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The `assetContentRefs` step: refs in a writable bundle's text files that use the spelling from before refs became
 * bundle paths (`knowledge/WORK/x`, now `WORK/x`) are rewritten under one backup directory per run, except an old
 * spelling that is now another file's live ref. Runs through `runMigration` against an isolated bundle.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { runMigration } from "../../scripts/akm-migrate/run-migrate";
import { resetConfigCache } from "../../src/core/config/config";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../_helpers/sandbox";

describe("the step", () => {
  let storage: IsolatedAkmStorage;
  const stash = (): string => storage.stashDir;

  beforeEach(() => {
    storage = withIsolatedAkmStorage();
    resetConfigCache();
  });
  afterEach(() => {
    resetConfigCache();
    storage.cleanup();
  });

  function write(relative: string, text: string): string {
    const file = path.join(stash(), relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    return file;
  }

  function configure(writable = true): void {
    writeSandboxConfig({
      defaultBundle: "primary",
      bundles: { primary: { path: stash(), writable, components: { main: { root: ".", adapter: "akm" } } } },
    });
  }

  // `wikis/a/page` and `WORK/note` sit outside `knowledge/`, so their old spellings are `knowledge/wikis/a/page` and
  // `knowledge/WORK/note`; `knowledge/run.sh` is a script outside `scripts/`. `wikis/b` and `knowledge/wikis/b` are a
  // shadowed pair: the old spelling of the first is the live ref of the second.
  function seed(): string {
    write("wikis/a/page.md", "---\ntitle: page\n---\nPage.\n");
    write("WORK/note.md", "---\ntitle: note\n---\nNote.\n");
    write("knowledge/run.sh", "#!/bin/sh\necho hi\n");
    write("wikis/b.md", "---\ntitle: b\n---\nOutside.\n");
    write("knowledge/wikis/b.md", "---\ntitle: b2\n---\nInside.\n");
    return write(
      "knowledge/links.md",
      [
        "---",
        "title: links",
        "xrefs: [wiki:a/page, knowledge/wikis/a/page, primary//knowledge/WORK/note]",
        "---",
        "Path: see knowledge/WORK/note.md and knowledge/WORK/note.",
        "Typed: knowledge:WORK/note, script:knowledge/run.sh, wiki:a/page.md.",
        "Qualified: primary//knowledge/WORK/note.",
        "Shadowed stays: wiki:b and knowledge/wikis/b.",
        "A URL https://example.com/knowledge/WORK/note and a longer path knowledge/WORK/note/deeper stay.",
        "So do a sibling knowledge/WORK/notes and primary//knowledge/WORK/notes.",
        "",
      ].join("\n"),
    );
  }

  const REWRITTEN = [
    "---",
    "title: links",
    "xrefs: [wikis/a/page, wikis/a/page, primary//WORK/note]",
    "---",
    "Path: see WORK/note.md and WORK/note.",
    "Typed: WORK/note, knowledge/run.sh, wikis/a/page.md.",
    "Qualified: primary//WORK/note.",
    "Shadowed stays: wiki:b and knowledge/wikis/b.",
    "A URL https://example.com/knowledge/WORK/note and a longer path knowledge/WORK/note/deeper stay.",
    "So do a sibling knowledge/WORK/notes and primary//knowledge/WORK/notes.",
    "",
  ].join("\n");

  test("status counts the old-spelling refs per file and lists the shadowed pair, changing nothing", async () => {
    configure();
    const links = seed();
    const before = fs.readFileSync(links, "utf8");

    const plan = await runMigration({ apply: false });

    expect(plan.failedSteps).toBeUndefined();
    expect(plan.status).toBe("ready");
    expect(plan.assetContentRefs).toMatchObject({
      changed: 1,
      refs: 9,
      files: [{ filePath: links, status: "changed", refs: 9 }],
      shadowed: [{ bundleId: "primary", from: "knowledge/wikis/b", to: "wikis/b" }],
    });
    expect(fs.readFileSync(links, "utf8")).toBe(before);
  });

  test("apply rewrites frontmatter and body tokens of every form under one backup, and a second run changes nothing", async () => {
    configure();
    const links = seed();
    const original = fs.readFileSync(links, "utf8");

    const plan = await runMigration({ apply: true });

    expect(plan.failedSteps).toBeUndefined();
    expect(plan.assetContentRefs).toMatchObject({ changed: 1, skipped: 0, applied: 1, refs: 9 });
    expect(fs.readFileSync(links, "utf8")).toBe(REWRITTEN);
    const backup = plan.assetContentRefs?.backupPath as string;
    expect(
      fs
        .readdirSync(path.join(backup, "files"))
        .map((name) => fs.readFileSync(path.join(backup, "files", name), "utf8")),
    ).toEqual([original]);

    resetConfigCache();
    const again = await runMigration({ apply: true });
    expect(again.assetContentRefs).toMatchObject({ changed: 0, refs: 0, shadowed: [{ from: "knowledge/wikis/b" }] });
    expect(again.assetContentRefs?.backupPath).toBeUndefined();
    expect(fs.readFileSync(links, "utf8")).toBe(REWRITTEN);
  });

  test("only the files the runtime walks are read, and a link is left a link", async () => {
    configure();
    const links = seed();
    const hidden = write(".scratch/notes.md", "See knowledge/WORK/note.\n");
    const link = path.join(stash(), "knowledge/link.md");
    fs.symlinkSync(links, link);

    const plan = await runMigration({ apply: true });

    expect(plan.assetContentRefs?.files.map((file) => file.filePath)).toEqual([links]);
    expect(fs.readFileSync(hidden, "utf8")).toBe("See knowledge/WORK/note.\n");
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
  });

  test("a bundle akm may not write is left as written", async () => {
    configure(false);
    const links = seed();
    const before = fs.readFileSync(links, "utf8");

    const plan = await runMigration({ apply: true });

    expect(plan.assetContentRefs).toMatchObject({ changed: 0, refs: 0 });
    expect(fs.readFileSync(links, "utf8")).toBe(before);
  });
});
