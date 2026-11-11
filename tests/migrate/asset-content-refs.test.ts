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

  test("a frozen file that is not an asset keeps its legacy spelling byte-for-byte", async () => {
    configure();
    write("wikis/articles/schema.md", "---\ntitle: schema\n---\nSchema.\n");
    write("wikis/articles/raw/example.md", "---\ntitle: example\n---\nRaw.\n");
    const page = write("wikis/articles/pages/a.md", "---\ntitle: a\n---\nSee wiki:articles/raw/example.\n");
    const frozen = write("eval/frozen/inputs.json", '{"prompt":"Historical citation: wiki:articles/raw/example"}\n');
    const before = fs.readFileSync(frozen);

    const plan = await runMigration({ apply: true });

    expect(plan.assetContentRefs?.files.map((file) => file.filePath)).toEqual([page]);
    expect(fs.readFileSync(page, "utf8")).toBe("---\ntitle: a\n---\nSee wikis/articles/raw/example.\n");
    expect(fs.readFileSync(frozen).equals(before)).toBe(true);
  });

  test("live index.md and wiki schema.md are rewritten; log.md, README.md, raw/ and frozen files are not", async () => {
    configure();
    write("wikis/articles/raw/example.md", "---\ntitle: example\n---\nRaw.\n");
    const line = "See wiki:articles/raw/example.\n";
    const index = write("wikis/articles/index.md", line);
    const schema = write("wikis/articles/schema.md", line);
    const log = write("wikis/articles/log.md", line);
    const readme = write("README.md", line);
    const frozenIndex = write("eval/frozen/index.md", line);
    const rawIndex = write("wikis/articles/raw/index.md", line);
    const frozen = write("eval/frozen/inputs.json", '{"p":"wiki:articles/raw/example"}\n');

    await runMigration({ apply: true });

    expect(fs.readFileSync(index, "utf8")).toBe("See wikis/articles/raw/example.\n");
    expect(fs.readFileSync(schema, "utf8")).toBe("See wikis/articles/raw/example.\n");
    for (const file of [log, readme, frozenIndex, rawIndex]) expect(fs.readFileSync(file, "utf8")).toBe(line);
    expect(fs.readFileSync(frozen, "utf8")).toBe('{"p":"wiki:articles/raw/example"}\n');
  });

  test("an llm-wiki bundle's root schema.md is rewritten", async () => {
    write("pages/target.md", "---\ntitle: target\n---\nT.\n");
    const schema = write("schema.md", "See knowledge/pages/target.\n");
    writeSandboxConfig({
      defaultBundle: "primary",
      bundles: { primary: { path: stash(), writable: true, components: { main: { root: ".", adapter: "llm-wiki" } } } },
    });

    await runMigration({ apply: true });

    expect(fs.readFileSync(schema, "utf8")).toBe("See pages/target.\n");
  });

  test("a rewrite in a git bundle names the bundle and the next steps", async () => {
    configure();
    write("wikis/articles/schema.md", "---\ntitle: schema\n---\nSchema.\n");
    write("wikis/articles/raw/example.md", "---\ntitle: example\n---\nRaw.\n");
    write("wikis/articles/pages/a.md", "---\ntitle: a\n---\nSee wiki:articles/raw/example.\n");
    expect(Bun.spawnSync(["git", "init", "-q", stash()]).exitCode).toBe(0);

    const plan = await runMigration({ apply: true });

    expect(plan.assetContentRefs?.reconcile).toHaveLength(1);
    expect(plan.assetContentRefs?.reconcile?.[0]).toContain(stash());
    expect(plan.assetContentRefs?.reconcile?.[0]).toContain("git -C");
    expect(plan.assetContentRefs?.reconcile?.[0]).toContain("akm bundle update");
  });

  test("a bundle akm may not write is left as written", async () => {
    configure(false);
    const links = seed();
    const before = fs.readFileSync(links, "utf8");

    const plan = await runMigration({ apply: true });

    expect(plan.assetContentRefs).toMatchObject({ changed: 0, refs: 0 });
    expect(fs.readFileSync(links, "utf8")).toBe(before);
  });

  test("a nested wiki's raw files, retyped wiki-source, are rewritten from the wiki: form", async () => {
    configure();
    write("wikis/articles/schema.md", "---\ntitle: schema\n---\nSchema.\n");
    write("wikis/articles/pages/a.md", "---\ntitle: a\n---\nPage.\n");
    write("wikis/articles/raw/one.md", "---\ntitle: one\n---\nRaw.\n");
    const page = write(
      "wikis/articles/pages/b.md",
      "---\ntitle: page\nxrefs: [wiki:articles/raw/one]\n---\nSee wiki:articles/raw/one.md and knowledge/wikis/articles/raw/one.\n",
    );

    const plan = await runMigration({ apply: true });

    expect(plan.assetContentRefs).toMatchObject({ changed: 1, refs: 3 });
    expect(fs.readFileSync(page, "utf8")).toBe(
      "---\ntitle: page\nxrefs: [wikis/articles/raw/one]\n---\nSee wikis/articles/raw/one.md and wikis/articles/raw/one.\n",
    );
    resetConfigCache();
    expect((await runMigration({ apply: false })).assetContentRefs).toMatchObject({ changed: 0, refs: 0 });
  });

  test("a spelling another adapter's bundle holds is live there, so it stays as written", async () => {
    const other = path.join(path.dirname(stash()), "other");
    fs.mkdirSync(path.join(other, "skills/review"), { recursive: true });
    fs.writeFileSync(path.join(other, "skills/review/SKILL.md"), "---\nname: review\ndescription: r\n---\nSkill.\n");
    write("review.md", "---\ntitle: review\n---\nRoot.\n");
    const notes = write("notes.md", "---\ntitle: notes\n---\nSee skills/review.\n");
    writeSandboxConfig({
      defaultBundle: "primary",
      bundles: {
        primary: { path: stash(), writable: true, components: { main: { root: ".", adapter: "akm" } } },
        other: { path: other, writable: false, components: { main: { root: ".", adapter: "agent-skills" } } },
      },
    });

    const plan = await runMigration({ apply: true });

    expect(plan.assetContentRefs).toMatchObject({ changed: 0, refs: 0 });
    expect(fs.readFileSync(notes, "utf8")).toBe("---\ntitle: notes\n---\nSee skills/review.\n");
  });
});
