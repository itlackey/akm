// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Behavioral coverage for `findEntryIdByRef` — the resolver used at INSERT
 * time by `akm show` (show.ts) and `akm feedback` (feedback-cli.ts) to attach
 * an `entry_id` to a usage_events row.
 *
 * This function is the direct SIBLING of the `relinkUsageEvents` bug: it too
 * runs a `substr(entry_key, …)` suffix match. The difference is that
 * findEntryIdByRef calls `parseAssetRef(ref)` FIRST, stripping any
 * `origin//` qualifier before building the `type:name` suffix. The relink bug
 * proved that a suffix match on the RAW ref silently fails for origin-qualified
 * refs (`source//type:name`). The only prior test of findEntryIdByRef was a
 * comment; every branch below (origin-qualified, .md ↔ non-.md variants,
 * cross-type isolation, near-miss suffix collision, absent→undefined) was
 * previously unexercised, so a regression to the relink shape would have
 * shipped green.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { closeDatabase, findEntryIdByRef, openIndexDatabase, upsertEntry } from "../../src/indexer/db/db";
import type { StashEntry } from "../../src/indexer/passes/metadata";
import type { Database } from "../../src/storage/database";
import { type Cleanup, sandboxXdgCacheHome, sandboxXdgConfigHome } from "../_helpers/sandbox";

// ── Temp directory management ───────────────────────────────────────────────

const createdTmpDirs: string[] = [];

function tmpDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-find-entry-id-"));
  createdTmpDirs.push(dir);
  return path.join(dir, "index.db");
}

afterAll(() => {
  for (const dir of createdTmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

// ── Environment isolation ───────────────────────────────────────────────────

let envCleanup: Cleanup = () => {};

beforeEach(() => {
  const cacheResult = sandboxXdgCacheHome();
  const cfgResult = sandboxXdgConfigHome(cacheResult.cleanup);
  envCleanup = cfgResult.cleanup;
});

afterEach(() => {
  envCleanup();
  envCleanup = () => {};
});

// ── Seed helper ──────────────────────────────────────────────────────────────
//
// Real indexer entry_key form is `${stashDir}:${type}:${name}` (see
// indexer.ts / index-written-assets.ts). findEntryIdByRef matches the
// `type:name` SUFFIX of that key, filtered by entry_type. Seed keys in the
// production shape so the suffix logic is exercised for real.

const STASH = "/home/user/.local/share/akm";

function seed(db: Database, type: StashEntry["type"], name: string, stashDir = STASH): number {
  const entryKey = `${stashDir}:${type}:${name}`;
  const filePath = `${stashDir}/${type}/${name}`;
  const entry = { description: `desc ${name}`, type, name } as unknown as StashEntry;
  return upsertEntry(db, entryKey, path.dirname(filePath), filePath, stashDir, entry, `${name} desc`);
}

function withDb(fn: (db: Database) => void): void {
  const db = openIndexDatabase(tmpDbPath());
  try {
    fn(db);
  } finally {
    closeDatabase(db);
  }
}

describe("findEntryIdByRef — bug-class coverage", () => {
  test("bare ref (type:name) resolves the entry id", () => {
    withDb((db) => {
      const id = seed(db, "skill", "deploy");
      expect(findEntryIdByRef(db, "skill:deploy")).toBe(id);
    });
  });

  // THE RELINK-CLASS GAP: an origin-qualified ref must resolve to the SAME id
  // as the bare form. The relink bug's suffix match on the raw ref dropped
  // exactly these; findEntryIdByRef only survives because it parses first.
  test("origin-qualified ref (local//type:name) resolves to the same id as the bare ref", () => {
    withDb((db) => {
      const id = seed(db, "skill", "deploy");
      expect(findEntryIdByRef(db, "local//skill:deploy")).toBe(id);
    });
  });

  test("registry-origin ref (owner/repo//type:name) resolves to the local entry", () => {
    withDb((db) => {
      const id = seed(db, "skill", "deploy");
      expect(findEntryIdByRef(db, "owner/repo//skill:deploy")).toBe(id);
      expect(findEntryIdByRef(db, "npm:@scope/pkg//skill:deploy")).toBe(id);
    });
  });

  test(".md ↔ non-.md variant: ref without .md resolves an entry stored WITH .md", () => {
    withDb((db) => {
      const id = seed(db, "knowledge", "guide.md");
      // Stored name has the .md suffix; a bare `knowledge:guide` ref must still hit it.
      expect(findEntryIdByRef(db, "knowledge:guide")).toBe(id);
      // And the exact spelling resolves too.
      expect(findEntryIdByRef(db, "knowledge:guide.md")).toBe(id);
    });
  });

  test(".md ↔ non-.md variant: ref WITH .md resolves an entry stored WITHOUT .md", () => {
    withDb((db) => {
      const id = seed(db, "knowledge", "guide");
      expect(findEntryIdByRef(db, "knowledge:guide.md")).toBe(id);
      expect(findEntryIdByRef(db, "knowledge:guide")).toBe(id);
    });
  });

  test("origin-qualified + .md variant compose (local//knowledge:guide → stored guide.md)", () => {
    withDb((db) => {
      const id = seed(db, "knowledge", "guide.md");
      expect(findEntryIdByRef(db, "local//knowledge:guide")).toBe(id);
    });
  });

  test("name with slash (nested path) resolves via full type:name suffix", () => {
    withDb((db) => {
      const id = seed(db, "knowledge", "db/migrate/guide.md");
      expect(findEntryIdByRef(db, "knowledge:db/migrate/guide.md")).toBe(id);
      expect(findEntryIdByRef(db, "knowledge:db/migrate/guide")).toBe(id);
      expect(findEntryIdByRef(db, "local//knowledge:db/migrate/guide.md")).toBe(id);
    });
  });

  // MISS CASE: this is what determines whether a usage_events row gets a real
  // entry_id or NULL. An absent entry MUST return undefined (→ entry_id null),
  // never a false-positive id.
  test("absent entry returns undefined (records entry_id = null)", () => {
    withDb((db) => {
      seed(db, "skill", "deploy");
      expect(findEntryIdByRef(db, "skill:nonexistent")).toBeUndefined();
      expect(findEntryIdByRef(db, "local//skill:nonexistent")).toBeUndefined();
    });
  });

  test("cross-type isolation: same name under a different type does NOT match", () => {
    withDb((db) => {
      const skillId = seed(db, "skill", "deploy");
      seed(db, "script", "deploy"); // same name, different type
      // skill:deploy must resolve the skill row, never the script row.
      expect(findEntryIdByRef(db, "skill:deploy")).toBe(skillId);
      // A type with no such name resolves to undefined even though the name
      // exists under other types.
      expect(findEntryIdByRef(db, "command:deploy")).toBeUndefined();
    });
  });

  // NEAR-MISS SUFFIX COLLISION: the suffix match must be anchored by the
  // `type:` prefix so `skill:deploy` does not accidentally match
  // `skill:redeploy`. Without the leading `skill:` in the suffix this would
  // false-positive.
  test("near-miss suffix does not collide (skill:deploy ≠ skill:redeploy)", () => {
    withDb((db) => {
      const redeployId = seed(db, "skill", "redeploy");
      // Only `redeploy` exists. Querying the shorter `deploy` must NOT match it.
      expect(findEntryIdByRef(db, "skill:deploy")).toBeUndefined();
      // Sanity: the real ref still resolves.
      expect(findEntryIdByRef(db, "skill:redeploy")).toBe(redeployId);
    });
  });

  test("resolves across multiple stashes when the type:name suffix matches (origin-insensitive)", () => {
    withDb((db) => {
      // Same asset indexed from a non-primary stash. findEntryIdByRef strips
      // the origin entirely, so an origin-qualified ref still resolves the row.
      const id = seed(db, "lesson", "postmortem", "/mnt/team-stash");
      expect(findEntryIdByRef(db, "lesson:postmortem")).toBe(id);
      expect(findEntryIdByRef(db, "local//lesson:postmortem")).toBe(id);
    });
  });
});
