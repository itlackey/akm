// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `entries_fts` is contentless, and FTS5 cannot take a deleted row out of a
 * contentless table's BM25 totals (the row count and the token counts the
 * average document length comes from). Every removed or replaced row left them
 * one row too high, so an index that had been updated scored differently from a
 * fresh index of the same files, and `akm index --full` doubled them (#1048).
 * SQLite has no command that recomputes them (`delete` and `rebuild` are
 * refused on such a table), so `akm index` rebuilds the table from `entries`
 * when rows have left it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { getDbPath } from "../../../src/core/paths";
import { indexWrittenAssets } from "../../../src/indexer/index-written-assets";
import { akmIndex } from "../../../src/indexer/indexer";
import { openDatabase } from "../../../src/storage/database";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../../_helpers/sandbox";

const QUERIES = ["topic3", "widget7", "note", "words", "twice"];
const REBUILT = "Rebuilt the full-text search index to recompute its totals.";
const CURRENT = "Full-text search index is current.";

let storage: IsolatedAkmStorage;

function notePath(i: number): string {
  return path.join(storage.stashDir, "knowledge", `note-${i}.md`);
}

function writeNote(i: number, extra = ""): void {
  fs.mkdirSync(path.dirname(notePath(i)), { recursive: true });
  fs.writeFileSync(
    notePath(i),
    `---\ndescription: Note ${i} about topic${i % 7} and widget${i}.\n---\n# Note ${i}\n\nIt mentions topic${i % 7} twice: topic${i % 7}. ${extra}\n`,
    "utf8",
  );
}

/** Index and report what the "fts" phase said, so a rebuild can be told from a no-op. */
async function index(options: { full?: boolean } = {}): Promise<string> {
  let ftsMessage = "";
  await akmIndex({
    stashDir: storage.stashDir,
    ...options,
    onProgress: (event) => {
      if (event.phase === "fts") ftsMessage = event.message;
    },
  });
  return ftsMessage;
}

/** FTS5's own row total for `entries_fts`: the first varint of its averages record. */
function ftsRowTotal(): number {
  const db = openDatabase(getDbPath(), { readonly: true });
  try {
    const row = db.prepare("SELECT block FROM entries_fts_data WHERE id = 1").get() as { block: Uint8Array } | null;
    let total = 0;
    let shift = 0;
    for (const byte of row ? new Uint8Array(row.block) : []) {
      total += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return total;
  } finally {
    db.close();
  }
}

function entryCount(): number {
  const db = openDatabase(getDbPath(), { readonly: true });
  try {
    return (db.prepare("SELECT COUNT(*) AS n FROM entries").get() as { n: number }).n;
  } finally {
    db.close();
  }
}

/** BM25 score of every entry each query matches, by `item_ref`. */
function scores(): Record<string, Record<string, number>> {
  const db = openDatabase(getDbPath(), { readonly: true });
  try {
    const out: Record<string, Record<string, number>> = {};
    for (const query of QUERIES) {
      const rows = db
        .prepare(
          `SELECT e.item_ref AS ref, bm25(entries_fts, 0, 1, 1, 1, 1, 1) AS score
             FROM entries_fts JOIN entries e ON e.id = entries_fts.rowid
            WHERE entries_fts MATCH ? ORDER BY e.item_ref`,
        )
        .all(query) as Array<{ ref: string; score: number }>;
      out[query] = Object.fromEntries(rows.map((row) => [row.ref, row.score]));
    }
    return out;
  } finally {
    db.close();
  }
}

/** Index the same files into a brand-new index.db and score them. */
async function freshScores(): Promise<Record<string, Record<string, number>>> {
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${getDbPath()}${suffix}`, { force: true });
  await index();
  return scores();
}

function expectSameScores(
  actual: Record<string, Record<string, number>>,
  expected: Record<string, Record<string, number>>,
) {
  expect(Object.keys(actual)).toEqual(Object.keys(expected));
  for (const query of Object.keys(expected)) {
    expect(Object.keys(actual[query] ?? {})).toEqual(Object.keys(expected[query] ?? {}));
    for (const [ref, score] of Object.entries(expected[query] ?? {})) {
      expect(actual[query]?.[ref]).toBeCloseTo(score, 10);
    }
  }
}

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  writeSandboxConfig({ semanticSearchMode: "off" });
  for (let i = 1; i <= 30; i++) writeNote(i);
});

afterEach(() => storage.cleanup());

describe("the BM25 totals of entries_fts", () => {
  test("an index updated in place scores like a fresh index of the same files", async () => {
    await index();
    expect(ftsRowTotal()).toBe(30);

    writeNote(3, "Words added to one note.");
    fs.rmSync(notePath(5));
    writeNote(31, "A note added later, with words.");
    expect(await index()).toBe(REBUILT);

    expect(entryCount()).toBe(30);
    expect(ftsRowTotal()).toBe(30);
    const updated = scores();
    expectSameScores(updated, await freshScores());
  });

  test("`akm index --full` over an existing index does not add its rows to the totals again", async () => {
    await index();
    writeNote(3, "Words added to one note.");
    await index();

    expect(await index({ full: true })).toBe(REBUILT);
    expect(ftsRowTotal()).toBe(30);
    expectSameScores(scores(), await freshScores());
  });

  test("a row replaced by the write-path index is settled by the next `akm index`", async () => {
    await index();
    expect(ftsRowTotal()).toBe(30);

    // `akm remember`, `akm proposal accept` and the like index the file they wrote in a process of their own.
    writeNote(7, "Words added to one note.");
    expect(await indexWrittenAssets(storage.stashDir, [notePath(7)])).toBe(true);
    expect(ftsRowTotal()).toBe(31);

    // Nothing else changed, so this run replaces no row itself.
    expect(await index()).toBe(REBUILT);
    expect(ftsRowTotal()).toBe(30);
    expectSameScores(scores(), await freshScores());
  });

  test("a run that removed or replaced no row leaves the table alone", async () => {
    expect(await index()).toBe(CURRENT);
    writeNote(31, "A note added later.");
    expect(await index()).toBe(CURRENT);
    expect(ftsRowTotal()).toBe(31);
    expect(await index()).toBe(CURRENT);
  });
});
