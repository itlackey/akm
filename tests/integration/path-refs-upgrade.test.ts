// Classification (tests/integration/ iff it opens a real database): opens index.db and state.db.

/**
 * A file outside its type folder had the ref `<type folder>/<its path>` before refs became bundle-relative paths.
 * The first index after the upgrade gives it its path as its ref and carries the history stored under the old ref
 * over to it, in index.db (the row keeps its id) and in state.db.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmShowUnified } from "../../src/commands/read/show";
import { getDbPath } from "../../src/core/paths";
import { getStateDbPath, withStateDb } from "../../src/core/state-db";
import { _resetWarnOnceForTests, _setWarnSinkForTests } from "../../src/core/warn";
import { akmIndex } from "../../src/indexer/indexer";
import { openDatabase } from "../../src/storage/database";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../_helpers/sandbox";
import { withSeam } from "../_helpers/seams";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  writeSandboxConfig({ semanticSearchMode: "off" });
  _resetWarnOnceForTests();
});

afterEach(() => storage.cleanup());

function write(rel: string, body: string): string {
  const file = path.join(storage.stashDir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `---\ndescription: ${body}\n---\n\n# ${body}\n`);
  return file;
}

function entryRows(): Array<{ id: number; item_ref: string; concept_id: string }> {
  const db = openDatabase(getDbPath(), { readonly: true });
  try {
    return db.prepare("SELECT id, item_ref, concept_id FROM entries ORDER BY id").all() as never;
  } finally {
    db.close();
  }
}

/** What a previous release left behind: the index row and the history rows under the old spelling. */
function leaveOldSpelling(newRef: string, oldRef: string): void {
  const db = openDatabase(getDbPath());
  try {
    db.prepare("UPDATE entries SET item_ref = ?, concept_id = ? WHERE item_ref = ?").run(
      `stash//${oldRef}`,
      oldRef,
      `stash//${newRef}`,
    );
  } finally {
    db.close();
  }
  withStateDb((state) => {
    const old = `stash//${oldRef}`;
    state
      .prepare(
        "INSERT INTO usage_events (event_type, entry_ref, signal, source) VALUES ('feedback', ?, 'positive', 'user')",
      )
      .run(old);
    state.prepare("INSERT INTO events (event_type, ts, ref) VALUES ('show', '2026-01-01T00:00:00Z', ?)").run(old);
    state.prepare("INSERT INTO asset_salience (asset_ref, rank_score) VALUES (?, 0.9)").run(old);
  });
}

function stateRefs(): { usage: string[]; events: string[]; salience: string[] } {
  return withStateDb((state) => ({
    usage: (state.prepare("SELECT entry_ref AS r FROM usage_events").all() as Array<{ r: string }>).map((x) => x.r),
    events: (state.prepare("SELECT ref AS r FROM events WHERE ref IS NOT NULL").all() as Array<{ r: string }>).map(
      (x) => x.r,
    ),
    salience: (state.prepare("SELECT asset_ref AS r FROM asset_salience").all() as Array<{ r: string }>).map(
      (x) => x.r,
    ),
  }));
}

describe("upgrading a bundle that has files outside their type folder", () => {
  test("the index gives the file its path as its ref and carries its history to it", async () => {
    write("reports/x.md", "quarterly report");
    write("knowledge/guide.md", "a guide");
    await akmIndex({ stashDir: storage.stashDir, full: true });
    const before = entryRows();
    const loose = before.find((row) => row.concept_id === "reports/x");
    expect(loose).toBeDefined();
    expect(before.map((row) => row.item_ref)).toContain("stash//knowledge/guide");

    leaveOldSpelling("reports/x", "knowledge/reports/x");
    expect(entryRows().find((row) => row.id === loose?.id)?.item_ref).toBe("stash//knowledge/reports/x");

    await akmIndex({ stashDir: storage.stashDir, full: true });

    const after = entryRows();
    // The same row, under the new ref: what hangs off its id is still attached.
    expect(after.find((row) => row.id === loose?.id)).toMatchObject({
      item_ref: "stash//reports/x",
      concept_id: "reports/x",
    });
    expect(after.map((row) => row.item_ref)).not.toContain("stash//knowledge/reports/x");
    // A file under its type folder never changed ref.
    expect(after.map((row) => row.item_ref)).toContain("stash//knowledge/guide");

    const state = stateRefs();
    expect(state.usage).toEqual(["stash//reports/x"]);
    expect(state.events).toEqual(["stash//reports/x"]);
    expect(state.salience).toEqual(["stash//reports/x"]);
    expect(fs.existsSync(getStateDbPath())).toBe(true);
  });

  test("the history carries over when the old index row is already gone, and a second index changes nothing", async () => {
    write("WORK/note.md", "a note");
    await akmIndex({ stashDir: storage.stashDir, full: true });
    withStateDb((state) => {
      state
        .prepare(
          "INSERT INTO usage_events (event_type, entry_ref, signal, source) VALUES ('feedback', ?, 'positive', 'user')",
        )
        .run("stash//knowledge/WORK/note");
    });

    await akmIndex({ stashDir: storage.stashDir, full: true });
    expect(stateRefs().usage).toEqual(["stash//WORK/note"]);

    await akmIndex({ stashDir: storage.stashDir, full: true });
    expect(stateRefs().usage).toEqual(["stash//WORK/note"]);
  });
});

describe("show resolves a loose file by its path", () => {
  test("the path ref shows it; the old spelling shows it too, and warns once that it is outdated", async () => {
    write("reports/x.md", "quarterly report");
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const shown = await akmShowUnified({ ref: "reports/x", readOnly: true });
    expect(shown.ref).toBe("reports/x");
    expect(shown.type).toBe("knowledge");

    const warnings: string[] = [];
    await withSeam(
      _setWarnSinkForTests,
      (level, args) => {
        if (level === "warn") warnings.push(args.map(String).join(" "));
      },
      async () => {
        const old = await akmShowUnified({ ref: "knowledge/reports/x", readOnly: true });
        expect(old.path).toBe(shown.path);
        await akmShowUnified({ ref: "knowledge/reports/x", readOnly: true });
      },
    );
    expect(warnings.filter((w) => /outdated/.test(w))).toHaveLength(1);
  });
});

describe("links authored with the old spelling", () => {
  test("resolve to the loose file in both directions", async () => {
    write("reports/x.md", "quarterly report");
    const citer = path.join(storage.stashDir, "memories", "citer.md");
    fs.mkdirSync(path.dirname(citer), { recursive: true });
    fs.writeFileSync(citer, "---\ndescription: cites a report\nxrefs:\n  - knowledge/reports/x\n---\n\n# Cites\n");
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const outgoing = await akmShowUnified({ ref: "memories/citer", readOnly: true });
    expect(outgoing.links).toEqual({ outgoing: { xref: { total: 1, refs: ["reports/x"] } } });
    const incoming = await akmShowUnified({ ref: "reports/x", readOnly: true });
    expect(incoming.links).toEqual({ incoming: { xref: { total: 1, refs: ["memories/citer"] } } });
  });
});
