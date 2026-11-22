// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * A file renamed or moved with a plain rename keeps its asset: the index pairs the vanished entry with the new file
 * that has the same content and carries the asset's history, derived rows and vector to the new ref. Runs the indexer
 * against real databases, so it lives under tests/integration/.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { resetConfigCache } from "../../../src/core/config/config";
import { appendEvent, readEvents } from "../../../src/core/events";
import { getDbPath } from "../../../src/core/paths";
import { openStateDatabase } from "../../../src/core/state-db";
import { akmIndex } from "../../../src/indexer/indexer";
import { insertUsageEvent } from "../../../src/indexer/usage/usage-events";
import { closeDatabase, openIndexDatabase } from "../../../src/storage/repositories/index-connection";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../../_helpers/sandbox";

let storage: IsolatedAkmStorage;
let other: string;

function put(rel: string, content: string, root = storage.stashDir): string {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function move(from: string, to: string, root = storage.stashDir, toRoot = root): void {
  fs.mkdirSync(path.dirname(path.join(toRoot, to)), { recursive: true });
  fs.renameSync(path.join(root, from), path.join(toRoot, to));
}

const doc = (name: string, body = "Body."): string => `---\ndescription: ${name}\n---\n\n# ${name}\n\n${body}\n`;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  resetConfigCache();
  other = path.join(storage.root, "other");
  fs.mkdirSync(other, { recursive: true });
  writeSandboxConfig({
    semanticSearchMode: "off",
    defaultBundle: "stash",
    bundles: {
      stash: { path: storage.stashDir, writable: true, adapter: "akm" },
      other: { path: other, writable: true, adapter: "akm" },
    },
  });
});

afterEach(() => {
  resetConfigCache();
  storage.cleanup();
});

/** The state.db rows keyed by one ref, per table. */
function historyAt(ref: string): Record<string, number> {
  const db = openStateDatabase();
  try {
    const count = (sql: string): number => (db.prepare(sql).get(ref) as { n: number }).n;
    return {
      usage: count("SELECT COUNT(*) AS n FROM usage_events WHERE entry_ref = ?"),
      proposals: count("SELECT COUNT(*) AS n FROM proposals WHERE ref = ?"),
      events: count("SELECT COUNT(*) AS n FROM events WHERE ref = ? AND event_type = 'feedback'"),
      ledger: count("SELECT COUNT(*) AS n FROM improve_ledger WHERE ref = ?"),
      salience: count("SELECT COUNT(*) AS n FROM asset_salience WHERE asset_ref = ?"),
      outcome: count("SELECT COUNT(*) AS n FROM asset_outcome WHERE asset_ref = ?"),
    };
  } finally {
    db.close();
  }
}

const SEEDED = { usage: 3, proposals: 1, events: 1, ledger: 1, salience: 1, outcome: 1 };
const NONE = { usage: 0, proposals: 0, events: 0, ledger: 0, salience: 0, outcome: 0 };

function seedHistory(ref: string, entryId: number): void {
  const db = openStateDatabase();
  try {
    for (const event_type of ["show", "show"])
      insertUsageEvent(db, { event_type, entry_id: entryId, entry_ref: ref, source: "user" });
    insertUsageEvent(db, {
      event_type: "feedback",
      signal: "positive",
      entry_id: entryId,
      entry_ref: ref,
      source: "user",
    });
    db.prepare(
      "INSERT INTO proposals (id, stash_dir, ref, status, source, created_at, updated_at) VALUES (?, ?, ?, 'accepted', 'reflect', 't', 't')",
    ).run(`p-${ref}`, storage.stashDir, ref);
    db.prepare(
      "INSERT INTO improve_ledger (stash_dir, ref, source, last_attempt_at, outcome) VALUES (?, ?, 'reflect', 't', 'accepted')",
    ).run(storage.stashDir, ref);
    db.prepare("INSERT INTO asset_salience (asset_ref) VALUES (?)").run(ref);
    db.prepare("INSERT INTO asset_outcome (asset_ref) VALUES (?)").run(ref);
  } finally {
    db.close();
  }
  appendEvent({ eventType: "feedback", ref });
}

function entry(ref: string): { id: number; filePath: string; bundle: string } | undefined {
  const db = openIndexDatabase(getDbPath());
  try {
    const row = db.prepare("SELECT id, file_path, bundle_id FROM entries WHERE item_ref = ?").get(ref) as
      | { id: number; file_path: string; bundle_id: string }
      | undefined
      | null;
    return row ? { id: row.id, filePath: row.file_path, bundle: row.bundle_id } : undefined;
  } finally {
    closeDatabase(db);
  }
}

function storeVector(id: number): void {
  const db = openIndexDatabase(getDbPath());
  try {
    db.prepare("INSERT OR REPLACE INTO embeddings (id, embedding, model) VALUES (?, ?, 'test-model')").run(
      id,
      new Uint8Array(new Float32Array([0.25, 0.5, 0.75, 1]).buffer),
    );
  } finally {
    closeDatabase(db);
  }
}

function vectorOf(id: number): string | undefined {
  const db = openIndexDatabase(getDbPath());
  try {
    const row = db.prepare("SELECT hex(embedding) AS hex FROM embeddings WHERE id = ?").get(id) as
      | { hex: string }
      | undefined
      | null;
    return row?.hex;
  } finally {
    closeDatabase(db);
  }
}

function utilityOf(ref: string): { utility: number; showCount: number } | undefined {
  const db = openIndexDatabase(getDbPath());
  try {
    const row = db
      .prepare(
        "SELECT u.utility AS utility, u.show_count AS showCount FROM utility_scores u JOIN entries e ON e.id = u.entry_id WHERE e.item_ref = ?",
      )
      .get(ref) as { utility: number; showCount: number } | undefined | null;
    return row ?? undefined;
  } finally {
    closeDatabase(db);
  }
}

/** Index, then give the asset at `ref` history and a vector, so a later move has something to carry. */
async function indexWithHistory(ref: string): Promise<number> {
  await akmIndex({ stashDir: storage.stashDir });
  const found = entry(ref);
  expect(found).toBeDefined();
  seedHistory(ref, found?.id as number);
  storeVector(found?.id as number);
  await akmIndex({ stashDir: storage.stashDir });
  return found?.id as number;
}

describe("a plain rename is a move", () => {
  test("a renamed file keeps its history, its row and its vector", async () => {
    put("knowledge/alpha.md", doc("alpha"));
    const id = await indexWithHistory("stash//knowledge/alpha");
    expect(historyAt("stash//knowledge/alpha")).toEqual(SEEDED);

    move("knowledge/alpha.md", "knowledge/alpha-renamed.md");
    const result = await akmIndex({ stashDir: storage.stashDir });

    expect(result.moves).toEqual({
      moved: [{ from: "stash//knowledge/alpha", to: "stash//knowledge/alpha-renamed" }],
      unpaired: 0,
    });
    expect(historyAt("stash//knowledge/alpha-renamed")).toEqual(SEEDED);
    expect(historyAt("stash//knowledge/alpha")).toEqual(NONE);
    expect(entry("stash//knowledge/alpha")).toBeUndefined();
    expect(entry("stash//knowledge/alpha-renamed")?.id).toBe(id);
    expect(vectorOf(id)).toBe("0000803E0000003F0000403F0000803F");
    expect(readEvents({ type: "moved" }).events.map((event) => [event.ref, event.metadata?.from])).toEqual([
      ["stash//knowledge/alpha-renamed", "stash//knowledge/alpha"],
    ]);
  });

  test("a file moved to another folder, and by a full index, is the same asset", async () => {
    put("knowledge/alpha.md", doc("alpha"));
    const id = await indexWithHistory("stash//knowledge/alpha");

    move("knowledge/alpha.md", "knowledge/archive/2026/alpha.md");
    const result = await akmIndex({ stashDir: storage.stashDir, full: true });

    expect(result.moves?.moved).toEqual([
      { from: "stash//knowledge/alpha", to: "stash//knowledge/archive/2026/alpha" },
    ]);
    expect(historyAt("stash//knowledge/archive/2026/alpha")).toEqual(SEEDED);
    expect(historyAt("stash//knowledge/alpha")).toEqual(NONE);
    expect(entry("stash//knowledge/archive/2026/alpha")?.id).toBe(id);
  });

  test("a file moved to another bundle takes its history to that bundle's ref", async () => {
    put("knowledge/alpha.md", doc("alpha"));
    const id = await indexWithHistory("stash//knowledge/alpha");

    move("knowledge/alpha.md", "knowledge/alpha.md", storage.stashDir, other);
    const result = await akmIndex({ stashDir: storage.stashDir });

    expect(result.moves?.moved).toEqual([{ from: "stash//knowledge/alpha", to: "other//knowledge/alpha" }]);
    expect(historyAt("other//knowledge/alpha")).toEqual(SEEDED);
    expect(historyAt("stash//knowledge/alpha")).toEqual(NONE);
    expect(entry("other//knowledge/alpha")).toMatchObject({ id, bundle: "other" });
  });

  test("a folder of files moved is every file moved", async () => {
    put("knowledge/proj/one.md", doc("one", "First."));
    put("knowledge/proj/two.md", doc("two", "Second."));
    put("knowledge/proj/deep/three.md", doc("three", "Third."));
    await indexWithHistory("stash//knowledge/proj/one");
    fs.mkdirSync(path.join(storage.stashDir, "knowledge/archive"), { recursive: true });
    fs.renameSync(path.join(storage.stashDir, "knowledge/proj"), path.join(storage.stashDir, "knowledge/archive/proj"));

    const result = await akmIndex({ stashDir: storage.stashDir });

    expect(result.moves?.unpaired).toBe(0);
    expect(result.moves?.moved.map((m) => m.to).sort()).toEqual([
      "stash//knowledge/archive/proj/deep/three",
      "stash//knowledge/archive/proj/one",
      "stash//knowledge/archive/proj/two",
    ]);
    expect(historyAt("stash//knowledge/archive/proj/one")).toEqual(SEEDED);
    expect(historyAt("stash//knowledge/proj/one")).toEqual(NONE);
  });

  test("search utility is the same after the move", async () => {
    put("knowledge/alpha.md", doc("alpha"));
    await indexWithHistory("stash//knowledge/alpha");
    const before = utilityOf("stash//knowledge/alpha");
    expect(before?.showCount).toBeGreaterThan(0);

    move("knowledge/alpha.md", "knowledge/renamed/alpha.md");
    await akmIndex({ stashDir: storage.stashDir });

    expect(utilityOf("stash//knowledge/renamed/alpha")).toEqual(before);
  });
});

describe("a move the index cannot be sure of is a new asset", () => {
  test("a moved file that was also edited is a new asset", async () => {
    put("knowledge/alpha.md", doc("alpha"));
    await indexWithHistory("stash//knowledge/alpha");

    move("knowledge/alpha.md", "knowledge/alpha-edited.md");
    put("knowledge/alpha-edited.md", doc("alpha", "Edited body."));
    const result = await akmIndex({ stashDir: storage.stashDir });

    expect(result.moves).toBeUndefined();
    expect(historyAt("stash//knowledge/alpha-edited")).toEqual(NONE);
    expect(entry("stash//knowledge/alpha-edited")).toBeDefined();
  });

  test("identical files that moved to names that do not match are not paired, and the index says so", async () => {
    put("knowledge/a.md", doc("same", "Identical."));
    put("knowledge/b.md", doc("same", "Identical."));
    await indexWithHistory("stash//knowledge/a");
    move("knowledge/a.md", "knowledge/c.md");
    move("knowledge/b.md", "knowledge/d.md");

    const result = await akmIndex({ stashDir: storage.stashDir });

    expect(result.moves).toEqual({ moved: [], unpaired: 2 });
    expect(result.warnings?.some((warning) => warning.includes("not paired"))).toBe(true);
    expect(historyAt("stash//knowledge/c")).toEqual(NONE);
    expect(historyAt("stash//knowledge/d")).toEqual(NONE);
  });

  test("identical files whose names match one to one are paired by name", async () => {
    put("knowledge/x/note.md", doc("note", "Identical."));
    put("knowledge/y/other.md", doc("note", "Identical."));
    await indexWithHistory("stash//knowledge/x/note");
    move("knowledge/x/note.md", "knowledge/p/note.md");
    move("knowledge/y/other.md", "knowledge/q/other.md");

    const result = await akmIndex({ stashDir: storage.stashDir });

    expect(result.moves?.unpaired).toBe(0);
    expect(result.moves?.moved.map((m) => m.to).sort()).toEqual([
      "stash//knowledge/p/note",
      "stash//knowledge/q/other",
    ]);
    expect(historyAt("stash//knowledge/p/note")).toEqual(SEEDED);
  });

  test("identical files with the same name in two folders are ambiguous and not paired", async () => {
    put("knowledge/x/note.md", doc("note", "Identical."));
    put("knowledge/y/note.md", doc("note", "Identical."));
    await indexWithHistory("stash//knowledge/x/note");
    move("knowledge/x/note.md", "knowledge/p/note.md");
    move("knowledge/y/note.md", "knowledge/q/note.md");

    const result = await akmIndex({ stashDir: storage.stashDir });

    expect(result.moves).toEqual({ moved: [], unpaired: 2 });
    expect(historyAt("stash//knowledge/p/note")).toEqual(NONE);
  });

  test("a file copied, not moved, is a new asset and the original keeps its history", async () => {
    put("knowledge/alpha.md", doc("alpha"));
    await indexWithHistory("stash//knowledge/alpha");

    put("knowledge/alpha-copy.md", doc("alpha"));
    const result = await akmIndex({ stashDir: storage.stashDir });

    expect(result.moves).toBeUndefined();
    expect(historyAt("stash//knowledge/alpha")).toEqual(SEEDED);
    expect(historyAt("stash//knowledge/alpha-copy")).toEqual(NONE);
  });

  test("an index of an unchanged library reports no moves", async () => {
    put("knowledge/alpha.md", doc("alpha"));
    await akmIndex({ stashDir: storage.stashDir });
    const result = await akmIndex({ stashDir: storage.stashDir });
    expect(result.moves).toBeUndefined();
  });
});
