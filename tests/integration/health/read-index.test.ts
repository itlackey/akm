// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** What health's shared index reader reports for a file it was pointed at, measured on real SQLite files. */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { readHealthIndex } from "../../../src/commands/health/read-index";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../_helpers/sandbox";

const PAGE = 4096;
let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
});
afterEach(() => storage.cleanup());

describe("readHealthIndex", () => {
  test("a failed read of a damaged file at a path of its own says the file is damaged", () => {
    const dbPath = path.join(storage.root, "elsewhere.db");
    fs.writeFileSync(dbPath, Buffer.alloc(PAGE, 0xab));
    expect(readHealthIndex((db) => db.prepare("SELECT 1").get(), { dbPath })).toEqual({
      error: "index.db is damaged",
    });
  });

  test("a read that succeeds is not refused for damage it never touched", () => {
    const dbPath = path.join(storage.root, "partly-damaged.db");
    const db = new Database(dbPath);
    db.exec("PRAGMA journal_mode = DELETE");
    db.exec("CREATE TABLE t (a TEXT, b TEXT); CREATE INDEX t_a ON t (a)");
    for (let i = 0; i < 300; i++) db.prepare("INSERT INTO t VALUES (?, ?)").run(`a${i}`, `b${i}`);
    const { rootpage } = db.prepare("SELECT rootpage FROM sqlite_master WHERE name = 't_a'").get() as {
      rootpage: number;
    };
    db.close();
    const bytes = fs.readFileSync(dbPath);
    bytes.fill(0xff, (rootpage - 1) * PAGE, rootpage * PAGE);
    fs.writeFileSync(dbPath, bytes);

    // The table scan never reaches the damaged index pages.
    const read = readHealthIndex((open) => open.prepare("SELECT a, b FROM t NOT INDEXED").all().length, { dbPath });
    expect(read).toEqual({ value: 300 });
  });
});
