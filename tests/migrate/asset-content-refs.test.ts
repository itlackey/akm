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
import { withStateDb } from "../../src/core/state-db";
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
  /** One row per ref-keyed state.db table under `ref`, each with a payload to check it survives. */
  function seedHistory(ref: string): void {
    withStateDb((db) => {
      db.prepare(
        "INSERT INTO usage_events (event_type, entry_id, entry_ref, signal, source) VALUES ('feedback', 42, ?, 'positive', 'user')",
      ).run(ref);
      db.prepare("INSERT INTO events (event_type, ts, ref) VALUES ('show', '2026-01-01T00:00:00Z', ?)").run(ref);
      db.prepare("INSERT INTO asset_salience (asset_ref, rank_score) VALUES (?, 0.9)").run(ref);
      db.prepare("INSERT INTO asset_outcome (asset_ref, retrieval_count) VALUES (?, 7)").run(ref);
      db.prepare(
        "INSERT INTO proposals (id, stash_dir, ref, source, created_at, updated_at, content) VALUES ('p1', '/s', ?, 'reflect', 't', 't', 'kept body')",
      ).run(ref);
      db.prepare(
        "INSERT INTO improve_ledger (stash_dir, ref, source, last_attempt_at, outcome, detail) VALUES ('/s', ?, 'reflect', 't', 'proposed', 'kept detail')",
      ).run(ref);
      db.prepare("INSERT INTO task_history (task_id, status, started_at, target_ref) VALUES ('t', 'done', 't', ?)").run(
        ref,
      );
    });
  }

  function historyRefs(): Record<string, string[]> {
    return withStateDb((db) => {
      const col = (sql: string): string[] => (db.prepare(sql).all() as Array<{ r: string }>).map((row) => row.r);
      return {
        usage: col("SELECT entry_ref AS r FROM usage_events"),
        events: col("SELECT ref AS r FROM events"),
        salience: col("SELECT asset_ref AS r FROM asset_salience"),
        outcome: col("SELECT asset_ref AS r FROM asset_outcome"),
        proposals: col("SELECT ref AS r FROM proposals"),
        ledger: col("SELECT ref AS r FROM improve_ledger"),
        tasks: col("SELECT target_ref AS r FROM task_history"),
      };
    });
  }

  test("state.db rows keyed by an old spelling move to the new one with their data, and a second run changes nothing", async () => {
    configure();
    write("WORK/note.md", "---\ntitle: note\n---\nNote.\n");
    write("knowledge/guide.md", "---\ntitle: guide\n---\nGuide.\n");
    seedHistory("primary//knowledge/WORK/note");
    // A file under its type folder never changed ref, so its history is not touched.
    withStateDb((db) => {
      db.prepare("INSERT INTO asset_salience (asset_ref, rank_score) VALUES ('primary//knowledge/guide', 0.4)").run();
    });

    const status = await runMigration({ apply: false });
    expect(status.status).toBe("ready");
    expect(status.assetContentRefs?.stateRows).toBe(7);
    expect(historyRefs().usage).toEqual(["primary//knowledge/WORK/note"]);

    resetConfigCache();
    const plan = await runMigration({ apply: true });
    expect(plan.failedSteps).toBeUndefined();
    expect(plan.status).toBe("current");

    const moved = ["primary//WORK/note"];
    expect(historyRefs()).toEqual({
      usage: moved,
      events: moved,
      salience: [...moved, "primary//knowledge/guide"].sort(),
      outcome: moved,
      proposals: moved,
      ledger: moved,
      tasks: moved,
    });
    withStateDb((db) => {
      expect(db.prepare("SELECT content FROM proposals").get()).toEqual({ content: "kept body" });
      expect(db.prepare("SELECT detail FROM improve_ledger").get()).toEqual({ detail: "kept detail" });
      expect(db.prepare("SELECT retrieval_count AS n FROM asset_outcome").get()).toEqual({ n: 7 });
      expect(db.prepare("SELECT signal, entry_id FROM usage_events").get()).toEqual({
        signal: "positive",
        entry_id: null,
      });
    });

    resetConfigCache();
    const again = await runMigration({ apply: true });
    expect(again.status).toBe("current");
    expect(again.assetContentRefs?.stateRows).toBe(0);
  });

  test("history under a spelling another file holds as its live ref stays with that file", async () => {
    configure();
    write("wikis/b.md", "---\ntitle: b\n---\nOutside.\n");
    write("knowledge/wikis/b.md", "---\ntitle: b2\n---\nInside.\n");
    withStateDb((db) => {
      db.prepare("INSERT INTO asset_salience (asset_ref, rank_score) VALUES ('primary//knowledge/wikis/b', 0.4)").run();
    });

    const plan = await runMigration({ apply: true });

    expect(plan.assetContentRefs?.stateRows).toBe(0);
    expect(historyRefs().salience).toEqual(["primary//knowledge/wikis/b"]);
  });
});
