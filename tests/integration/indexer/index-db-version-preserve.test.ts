// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #664 / Step A regression: removing the nuclear drop-and-rebuild on a
 * DB_VERSION mismatch. A pre-existing index.db that carries an OLDER version
 * marker must KEEP its data on the next open — entries AND usage_events. The
 * regenerable index is converged forward by the idempotent baseline schema,
 * never wiped. Under the old code this exact scenario nuclear-dropped the whole
 * index (and round-tripped usage_events through a backup/restore dance).
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { closeDatabase, getEntryCount, openIndexDatabase, setMeta } from "../../../src/indexer/db/db";
import { countUsageEventsByType, insertUsageEvent } from "../../../src/indexer/usage/usage-events";

describe("#664 Step A — index.db preserves data across a stale version marker (no nuclear drop)", () => {
  test("an older DB_VERSION marker does not wipe entries or usage_events on reopen", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-noupgrade-"));
    const dbPath = path.join(tmpDir, "index.db");
    try {
      // Build a DB and seed an entry + a usage event (the latter is the only
      // non-regenerable data the old backup/restore dance existed to protect).
      let db = openIndexDatabase(dbPath, { embeddingDim: 384 });
      db.exec(
        `INSERT INTO entries (entry_key, dir_path, file_path, stash_dir, entry_json, search_text, entry_type)
         VALUES ('k:memory:a', '/s/memories', '/s/memories/a.md', '/s', '{"name":"a","type":"memory"}', 'a', 'memory')`,
      );
      insertUsageEvent(db, { event_type: "search", query: "hello" });
      // Stamp an OLDER version than the running binary's DB_VERSION. Under the
      // old code, the next open saw this mismatch and dropped the ENTIRE index.
      setMeta(db, "version", "1");
      expect(getEntryCount(db)).toBe(1);
      expect(countUsageEventsByType(db, "search")).toBe(1);
      closeDatabase(db);

      // Reopen: the stale marker must NOT trigger a wipe.
      db = openIndexDatabase(dbPath, { embeddingDim: 384 });
      expect(getEntryCount(db)).toBe(1); // entry preserved (not nuclear-dropped)
      expect(countUsageEventsByType(db, "search")).toBe(1); // usage_events preserved
      closeDatabase(db);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
