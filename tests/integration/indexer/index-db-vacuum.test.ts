// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm index` compacts index.db with VACUUM after a layout migration (the
 * writable opener's `vacuumPending` mark) and whenever more than half its
 * pages are free — the state.db threshold. Runs real index passes against a
 * real index.db, so it belongs under tests/integration/.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { resetConfigCache } from "../../../src/core/config/config";
import { getDbPath } from "../../../src/core/paths";
import { getStateDbPath, openStateDatabase } from "../../../src/core/state-db";
import { akmIndex } from "../../../src/indexer/indexer";
import { openDatabase } from "../../../src/storage/database";
import { closeDatabase, openIndexDatabase } from "../../../src/storage/repositories/index-connection";
import { getMeta, setMeta } from "../../../src/storage/repositories/index-meta-repository";
import { VACUUM_PENDING_META } from "../../../src/storage/repositories/index-schema";
import { INDEX_DB_VACUUMED_EVENT, readFreelistInfo } from "../../../src/storage/state-db-integrity";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../../_helpers/sandbox";

let storage: IsolatedAkmStorage;

beforeEach(async () => {
  storage = withIsolatedAkmStorage();
  for (const name of ["alpha", "bravo", "charlie"]) {
    fs.writeFileSync(
      path.join(storage.stashDir, "knowledge", `${name}.md`),
      `---\ndescription: ${name} note\n---\n\n# ${name}\n\nBody of ${name}.\n`,
    );
  }
  writeSandboxConfig({
    semanticSearchMode: "off",
    bundles: { stash: { path: storage.stashDir, writable: true } },
    defaultBundle: "stash",
  });
  resetConfigCache();
  await akmIndex({ stashDir: storage.stashDir, full: true });
});

afterEach(() => {
  storage.cleanup();
  resetConfigCache();
});

/** Fill then drop a table of `pages` 4 KiB rows, leaving roughly that many free pages. */
function leaveFreePages(pages: number): void {
  const db = openDatabase(getDbPath());
  try {
    db.exec("CREATE TABLE ballast (payload BLOB)");
    db.prepare(
      "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?) " +
        "INSERT INTO ballast SELECT randomblob(3000) FROM n",
    ).run(pages);
    db.exec("DROP TABLE ballast");
  } finally {
    db.close();
  }
}

function freelist() {
  const db = openIndexDatabase(getDbPath());
  try {
    return { ...readFreelistInfo(db), pending: getMeta(db, VACUUM_PENDING_META) };
  } finally {
    closeDatabase(db);
  }
}

function vacuumEvents(): Array<{ pagesBefore: number; pagesAfter: number }> {
  const db = openStateDatabase(getStateDbPath());
  try {
    return (
      db.prepare("SELECT metadata_json FROM events WHERE event_type = ?").all(INDEX_DB_VACUUMED_EVENT) as Array<{
        metadata_json: string;
      }>
    ).map((row) => JSON.parse(row.metadata_json));
  } finally {
    db.close();
  }
}

async function indexAgain(): Promise<string[]> {
  const messages: string[] = [];
  await akmIndex({ stashDir: storage.stashDir, onProgress: (event) => messages.push(event.message) });
  return messages;
}

describe("akm index compacts index.db", () => {
  test("once more than half its pages are free", async () => {
    leaveFreePages(2_000);
    const before = freelist();
    expect(before.ratio).toBeGreaterThan(0.5);

    const messages = await indexAgain();

    const after = freelist();
    expect(after.freelistCount).toBe(0);
    expect(after.pageCount).toBeLessThan(before.pageCount);
    expect(messages.some((message) => message.startsWith("Compacted index.db with VACUUM:"))).toBe(true);
    expect(vacuumEvents()).toEqual([expect.objectContaining({ pagesAfter: after.pageCount })]);
  });

  test("after a layout migration, below the free-page threshold", async () => {
    leaveFreePages(20);
    const db = openIndexDatabase(getDbPath());
    try {
      setMeta(db, VACUUM_PENDING_META, "1");
      expect(readFreelistInfo(db).ratio).toBeLessThan(0.5);
    } finally {
      closeDatabase(db);
    }

    await indexAgain();

    const after = freelist();
    expect(after.freelistCount).toBe(0);
    expect(after.pending).toBeUndefined();
    expect(vacuumEvents()).toHaveLength(1);
  });

  test("not otherwise", async () => {
    leaveFreePages(20);
    const before = freelist();
    expect(before.ratio).toBeLessThan(0.5);

    const messages = await indexAgain();

    expect(freelist().freelistCount).toBe(before.freelistCount);
    expect(messages.some((message) => message.startsWith("Compacted index.db"))).toBe(false);
    expect(vacuumEvents()).toEqual([]);
  });
});
