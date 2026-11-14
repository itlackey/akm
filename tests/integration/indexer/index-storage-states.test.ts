// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * index.db states a reader or `akm health` can meet, each built as a file:
 * a half-migrated schema, an older layout served as-is, a first build holding
 * the rebuild lock, a damaged page.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { readSemanticSearchState, semanticSearchCheck } from "../../../src/commands/health/semantic-search-check";
import { getDbPath, getIndexRebuildLockPath } from "../../../src/core/paths";
import { openDatabase } from "../../../src/storage/database";
import { missingEntryColumns } from "../../../src/storage/repositories/index-entry-schema";
import { ensureSchema } from "../../../src/storage/repositories/index-schema";
import { runCliCapture } from "../../_helpers/cli";
import { damageIndexInterior } from "../../_helpers/index-damage";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../../_helpers/sandbox";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  writeSandboxConfig({ semanticSearchMode: "off" });
  fs.mkdirSync(path.join(storage.stashDir, "knowledge"), { recursive: true });
  for (let i = 0; i < 400; i++) {
    fs.writeFileSync(
      path.join(storage.stashDir, "knowledge", `guide-${i}.md`),
      `---\ndescription: Deployment guide ${i} widget${i}\n---\n\n# Guide ${i}\n\nDeploy safely with gadget${i}.\n`,
    );
  }
});

afterEach(() => storage.cleanup());

function editIndex(edit: (db: Database) => void): void {
  const db = new Database(getDbPath());
  try {
    edit(db);
  } finally {
    db.close();
  }
}

describe("ensureSchema", () => {
  test("a migration that fails part-way leaves the old layout untouched, never entries without their FTS table", () => {
    const db = openDatabase(path.join(storage.root, "half-migrated.db"));
    try {
      // Layout 20: the retired columns beside the current ones, so the entries table is recreated.
      db.exec(`
        CREATE TABLE index_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        INSERT INTO index_meta VALUES ('version', '20');
        CREATE TABLE entries (id INTEGER PRIMARY KEY, item_ref TEXT, search_text TEXT);
        CREATE TRIGGER refuse_version BEFORE INSERT ON index_meta WHEN NEW.key = 'version'
          BEGIN SELECT RAISE(ABORT, 'refused'); END;
        CREATE TRIGGER refuse_version_update BEFORE UPDATE ON index_meta WHEN NEW.key = 'version'
          BEGIN SELECT RAISE(ABORT, 'refused'); END;
      `);
      expect(() => ensureSchema(db)).toThrow("refused");
      expect(missingEntryColumns(db).length).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });
});

describe("older layout served as-is", () => {
  test("a fragment selector reports the fragment unavailable, not an internal error, when entry_fragments does not exist", async () => {
    expect((await runCliCapture(["index"])).code).toBe(0);
    editIndex((db) => {
      db.exec("DROP TABLE entry_fragments; UPDATE index_meta SET value = '22' WHERE key = 'version';");
    });
    const lead = await runCliCapture(["show", "knowledge/guide-1#guide-1", "--lead", "--format=json"]);
    // The index cannot supply the fragment: the ordinary "unavailable, run akm index" refusal, not an internal error.
    expect(lead.code).toBe(1);
    expect(lead.stderr).toContain("Indexed-safe fragment context is unavailable");
  });
});

describe("akm health", () => {
  test("during a first build (meta-only index.db, live rebuild lock) it neither fails nor advises moving index.db aside", async () => {
    fs.mkdirSync(path.dirname(getDbPath()), { recursive: true });
    fs.rmSync(getDbPath(), { force: true });
    editIndex((db) => db.exec("CREATE TABLE index_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)"));
    const holder = Bun.spawn(["sleep", "60"]);
    try {
      const lock = getIndexRebuildLockPath();
      fs.mkdirSync(path.dirname(lock), { recursive: true });
      fs.writeFileSync(lock, JSON.stringify({ pid: holder.pid, startedAt: new Date().toISOString() }));
      const result = semanticSearchCheck(readSemanticSearchState("auto"));
      expect(result.status).not.toBe("fail");
      expect(result.message).not.toContain("move aside");
    } finally {
      holder.kill();
    }
  });

  test("with a page damaged inside index.db it fails, since search would", async () => {
    expect((await runCliCapture(["index"])).code).toBe(0);
    damageIndexInterior(getDbPath());
    const result = semanticSearchCheck(readSemanticSearchState("auto"));
    expect(result.status).toBe("fail");
    expect(result.message).toContain("akm index");
  });
});
