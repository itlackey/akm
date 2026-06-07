// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Secret indexer-leakage safety — the critical security test.
 *
 * A secret is discoverable by NAME, but the file's bytes (the value) must never
 * reach the FTS index, entries.search_text, entry_json, or `akm show` output.
 * Mirrors tests/vault.test.ts "vault indexer safety".
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { setSecret } from "../src/commands/env/secret";
import { getDbPath } from "../src/core/paths";
import { closeDatabase, getAllEntries, openDatabase } from "../src/indexer/db/db";
import { resetGraphBoostCache } from "../src/indexer/graph/graph-boost";
import { akmIndex } from "../src/indexer/indexer";
import { clearEmbeddingCache, resetLocalEmbedder } from "../src/llm/embedder";
import { runCliCapture } from "./_helpers/cli";
import { type Cleanup, sandboxStashDir, sandboxXdgCacheHome, sandboxXdgConfigHome, withEnv } from "./_helpers/sandbox";

const SECRET_VALUE = "correct-horse-battery-staple-secret-do-not-leak";

let currentStashDir = "";
let envCleanup: Cleanup = () => {};

beforeEach(() => {
  clearEmbeddingCache();
  resetLocalEmbedder();
  resetGraphBoostCache();

  const cacheResult = sandboxXdgCacheHome();
  const cfgResult = sandboxXdgConfigHome(cacheResult.cleanup);
  const stashResult = sandboxStashDir(cfgResult.cleanup);
  currentStashDir = stashResult.dir;
  envCleanup = stashResult.cleanup;

  const dbPath = getDbPath();
  for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try {
      fs.unlinkSync(f);
    } catch {
      /* ignore */
    }
  }
});

afterEach(() => {
  envCleanup();
  envCleanup = () => {};
  currentStashDir = "";
  clearEmbeddingCache();
  resetLocalEmbedder();
  resetGraphBoostCache();
});

describe("secret indexer safety", () => {
  test("secret values never appear in the FTS index, search_text, or entry_json", async () => {
    const stashDir = currentStashDir;
    setSecret(path.join(stashDir, "secrets", "deploy-key"), Buffer.from(`${SECRET_VALUE}\nmultiline\n`));

    const result = await akmIndex({ stashDir, full: true });
    expect(result.totalEntries).toBe(1);

    const db = openDatabase();
    try {
      const entries = getAllEntries(db);
      expect(entries.length).toBe(1);
      const secretEntry = entries[0];

      // 1. Classified as a secret, discoverable by name.
      expect(secretEntry.entry.type).toBe("secret");
      expect(secretEntry.entry.name).toBe("deploy-key");
      expect(secretEntry.entry.tags ?? []).toContain("secret");

      // 2. CRITICAL: the value is nowhere in the persisted record.
      expect(JSON.stringify(secretEntry)).not.toContain(SECRET_VALUE);

      // 3. CRITICAL: the value is not in search_text or entry_json.
      type Row = { search_text: string | null; entry_json: string };
      const rows = db.query("SELECT search_text, entry_json FROM entries WHERE entry_type = ?").all("secret") as Row[];
      expect(rows.length).toBe(1);
      expect(rows[0].search_text ?? "").not.toContain(SECRET_VALUE);
      expect(rows[0].entry_json).not.toContain(SECRET_VALUE);

      // 4. CRITICAL: the value cannot be retrieved via FTS5 search.
      type FtsRow = { c: number };
      const ftsHit = db
        .query("SELECT count(*) AS c FROM entries_fts WHERE entries_fts MATCH ?")
        .get("correct") as FtsRow;
      expect(ftsHit.c).toBe(0);
    } finally {
      closeDatabase(db);
    }
  });

  test("secrets are searchable by name", async () => {
    const stashDir = currentStashDir;
    setSecret(path.join(stashDir, "secrets", "stripe-api-key"), Buffer.from("sk_live_should_not_be_indexed"));
    await akmIndex({ stashDir, full: true });

    const db = openDatabase();
    try {
      type FtsRow = { c: number };
      const byName = db
        .query("SELECT count(*) AS c FROM entries_fts WHERE entries_fts MATCH ?")
        .get("stripe") as FtsRow;
      expect(byName.c).toBe(1);
    } finally {
      closeDatabase(db);
    }
  });

  test("a sibling .sensitive marker excludes the secret from indexing", async () => {
    const stashDir = currentStashDir;
    const fp = path.join(stashDir, "secrets", "hidden");
    setSecret(fp, Buffer.from("v"));
    fs.writeFileSync(`${fp}.sensitive`, "");

    const result = await akmIndex({ stashDir, full: true });
    expect(result.totalEntries).toBe(0);
  });

  test("`akm show` never emits the secret value", async () => {
    const stashDir = currentStashDir;
    setSecret(path.join(stashDir, "secrets", "demo"), Buffer.from(SECRET_VALUE));

    const { stdout, code } = await withEnv({ AKM_STASH_DIR: stashDir }, () =>
      runCliCapture(["show", "secret:demo", "--format", "json"]),
    );
    expect(code).toBe(0);
    expect(stdout).not.toContain(SECRET_VALUE);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.type).toBe("secret");
    expect(parsed.content).toBeUndefined();
  });
});
