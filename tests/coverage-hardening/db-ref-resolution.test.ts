// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Coverage-hardening: ref/entry_key resolution + usage_events relinking.
 *
 * These are the exact functions where the "relink" bug class lives: they map a
 * caller-supplied ref (`[origin//]type:name`, `.md`/non-`.md`, cross-stash
 * collisions) onto a stored `entry_key` of the production shape
 * `<stashDir>:<type>:<name>` via SQL suffix matching. The pre-existing suite
 * had NO direct test for `findEntryIdByRef` or `relinkUsageEvents`, so a whole
 * ref SHAPE could break without a single red test. This closes that gap by
 * exercising every input shape, not just the happy bare ref.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  closeDatabase,
  findEntryIdByRef,
  getEntryByRef,
  openIndexDatabase,
  relinkUsageEvents,
  upsertEntry,
} from "../../src/indexer/db/db";
import type { StashEntry } from "../../src/indexer/passes/metadata";
import { getUsageEvents, insertUsageEvent } from "../../src/indexer/usage/usage-events";
import type { Database } from "../../src/storage/database";
import { type Cleanup, sandboxXdgCacheHome, sandboxXdgConfigHome } from "../_helpers/sandbox";

// ── Temp dir + env isolation (mirrors tests/db.test.ts) ─────────────────────
const createdTmpDirs: string[] = [];
function tmpDb(): Database {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-covdb-"));
  createdTmpDirs.push(dir);
  return openIndexDatabase(path.join(dir, "test.db"));
}
afterAll(() => {
  for (const dir of createdTmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

let envCleanup: Cleanup = () => {};
beforeEach(() => {
  const cache = sandboxXdgCacheHome();
  envCleanup = sandboxXdgConfigHome(cache.cleanup).cleanup;
});
afterEach(() => {
  envCleanup();
  envCleanup = () => {};
});

// Production entry_key shape is `${stashDir}:${type}:${name}` (see indexer.ts).
function seedEntry(db: Database, stashDir: string, type: StashEntry["type"], name: string): number {
  const key = `${stashDir}:${type}:${name}`;
  const entry = { name, type, description: `desc ${name}` } as StashEntry;
  return upsertEntry(db, key, `${stashDir}/d`, `${stashDir}/d/${name}.md`, stashDir, entry, `${name} desc`);
}

// ── findEntryIdByRef ────────────────────────────────────────────────────────
describe("findEntryIdByRef — ref shape matrix", () => {
  test("resolves a bare type:name ref against the stashDir-prefixed entry_key", () => {
    const db = tmpDb();
    try {
      const id = seedEntry(db, "/home/u/.local/share/akm", "skill", "deploy");
      expect(findEntryIdByRef(db, "skill:deploy")).toBe(id);
    } finally {
      closeDatabase(db);
    }
  });

  test("resolves an ORIGIN-QUALIFIED ref (origin// is stripped before matching)", () => {
    // This is the exemplar shape that silently failed in the relink bug: a
    // resolver must not treat `local//` / `npm:@x/y//` as part of the key.
    const db = tmpDb();
    try {
      const id = seedEntry(db, "/s", "skill", "deploy");
      expect(findEntryIdByRef(db, "local//skill:deploy")).toBe(id);
      expect(findEntryIdByRef(db, "npm:@scope/pkg//skill:deploy")).toBe(id);
      expect(findEntryIdByRef(db, "owner/repo//skill:deploy")).toBe(id);
    } finally {
      closeDatabase(db);
    }
  });

  test("resolves across the .md / non-.md name boundary in BOTH directions", () => {
    const db = tmpDb();
    try {
      // entry stored WITHOUT .md → a ".md" query still resolves it.
      const noMd = seedEntry(db, "/s", "skill", "deploy");
      expect(findEntryIdByRef(db, "skill:deploy.md")).toBe(noMd);
      // entry stored WITH .md → a bare query still resolves it.
      const withMd = seedEntry(db, "/s", "knowledge", "guide.md");
      expect(findEntryIdByRef(db, "knowledge:guide")).toBe(withMd);
      expect(findEntryIdByRef(db, "knowledge:guide.md")).toBe(withMd);
    } finally {
      closeDatabase(db);
    }
  });

  test("returns undefined for a missing entry (not a throw, not a false match)", () => {
    const db = tmpDb();
    try {
      seedEntry(db, "/s", "skill", "deploy");
      expect(findEntryIdByRef(db, "skill:nonexistent")).toBeUndefined();
      // Same name, WRONG type must not match (entry_type is part of the filter).
      expect(findEntryIdByRef(db, "command:deploy")).toBeUndefined();
    } finally {
      closeDatabase(db);
    }
  });

  test("a similarly-suffixed name does not false-match (type: boundary protects)", () => {
    // `re-deploy` must not be resolved by a query for `deploy`: the `type:`
    // prefix in the suffix comparison prevents bare name-suffix collisions.
    const db = tmpDb();
    try {
      const redeploy = seedEntry(db, "/s", "skill", "redeploy");
      expect(findEntryIdByRef(db, "skill:redeploy")).toBe(redeploy);
      expect(findEntryIdByRef(db, "skill:deploy")).toBeUndefined();
    } finally {
      closeDatabase(db);
    }
  });

  test("throws (does not silently resolve) on an empty / malformed ref", () => {
    const db = tmpDb();
    try {
      seedEntry(db, "/s", "skill", "deploy");
      expect(() => findEntryIdByRef(db, "")).toThrow();
      expect(() => findEntryIdByRef(db, "   ")).toThrow();
      expect(() => findEntryIdByRef(db, "no-colon")).toThrow();
    } finally {
      closeDatabase(db);
    }
  });
});

// ── getEntryByRef — exact-key resolver (contrast with the suffix matcher) ────
describe("getEntryByRef — exact bare-key resolver", () => {
  test("matches only the exact bare `type:name` key, not the stashDir-prefixed key", () => {
    const db = tmpDb();
    try {
      // Production keys carry a stashDir prefix, so getEntryByRef (which builds
      // `type:name` and compares entry_key exactly) only hits entries indexed
      // with a bare key. Assert the exact-match contract explicitly.
      const bareId = upsertEntry(
        db,
        "memory:claude-prefs",
        "/d",
        "/d/claude-prefs.md",
        "/d",
        { name: "claude-prefs", type: "memory", description: "d" } as StashEntry,
        "claude-prefs",
      );
      expect(getEntryByRef(db, "memory", "claude-prefs")?.id).toBe(bareId);
      // A stashDir-prefixed key of the same asset is NOT an exact bare match.
      seedEntry(db, "/s", "memory", "other");
      expect(getEntryByRef(db, "memory", "other")).toBeNull();
    } finally {
      closeDatabase(db);
    }
  });
});

// ── relinkUsageEvents ───────────────────────────────────────────────────────
describe("relinkUsageEvents — re-resolve entry_id after a rebuild", () => {
  test("step 1: nulls out entry_ids that no longer exist in entries", () => {
    const db = tmpDb();
    try {
      // A usage event pointing at an entry_id that is not in `entries`.
      insertUsageEvent(db, { event_type: "search", entry_ref: "skill:gone", entry_id: 987654 });
      relinkUsageEvents(db, { defaultStashDir: "/stash" });
      const rows = getUsageEvents(db);
      expect(rows).toHaveLength(1);
      // Its ref cannot be resolved (no such entry) → stays null, never a stale id.
      expect(rows[0].entry_id).toBeNull();
    } finally {
      closeDatabase(db);
    }
  });

  test("step 2: re-resolves a BARE ref onto the current entry row after id churn", () => {
    const db = tmpDb();
    try {
      // Simulate post-rebuild state: the event's old entry_id is stale (999),
      // the real entry now lives under a different id.
      const id = seedEntry(db, "/stash", "skill", "deploy");
      expect(id).not.toBe(999);
      insertUsageEvent(db, { event_type: "search", entry_ref: "skill:deploy", entry_id: 999 });
      relinkUsageEvents(db, { sources: [{ path: "/stash" }], defaultStashDir: "/stash" });
      const [row] = getUsageEvents(db);
      expect(row.entry_id).toBe(id); // stale 999 → nulled → re-resolved to id
    } finally {
      closeDatabase(db);
    }
  });

  test("a still-valid entry_id is preserved (not disturbed)", () => {
    const db = tmpDb();
    try {
      const id = seedEntry(db, "/stash", "skill", "keep");
      insertUsageEvent(db, { event_type: "show", entry_ref: "skill:keep", entry_id: id });
      relinkUsageEvents(db);
      const [row] = getUsageEvents(db);
      expect(row.entry_id).toBe(id);
    } finally {
      closeDatabase(db);
    }
  });

  test("is a no-op-safe best-effort call on an empty usage_events table", () => {
    const db = tmpDb();
    try {
      expect(() => relinkUsageEvents(db)).not.toThrow();
      expect(getUsageEvents(db)).toHaveLength(0);
    } finally {
      closeDatabase(db);
    }
  });

  // Regression guard for the exemplar bug: origin-qualified refs
  // (`local//skill:deploy`, written routinely by search/show/curate) must
  // relink after id churn. The old step-2 query compared the RAW `entry_ref`
  // against the entry_key suffix without stripping the `origin//` prefix, so
  // these silently stayed null. Now resolved via the canonical findEntryIdByRef
  // (parseAssetRef strips the origin) — this asserts the branch a bare-ref-only
  // test would miss.
  test("step 2: re-resolves an ORIGIN-QUALIFIED ref after id churn", () => {
    const db = tmpDb();
    try {
      const id = seedEntry(db, "/stash", "skill", "deploy");
      insertUsageEvent(db, { event_type: "search", entry_ref: "local//skill:deploy", entry_id: 999 });
      relinkUsageEvents(db, { sources: [{ path: "/stash" }], defaultStashDir: "/stash" });
      const [row] = getUsageEvents(db);
      expect(row.entry_id).toBe(id);
    } finally {
      closeDatabase(db);
    }
  });
});
