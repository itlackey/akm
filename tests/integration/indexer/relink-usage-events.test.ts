// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { ensureUsageEventsSchema } from "../../../src/indexer/usage/usage-events";
import type { Database as AkmDatabase } from "../../../src/storage/database";
import { relinkUsageEvents } from "../../../src/storage/repositories/index-entries-repository";

/**
 * Focused tests for {@link relinkUsageEvents}.
 *
 * Regression guard for the finalize-phase slowness + silent link-loss bug:
 * the previous hand-rolled `substr(entry_key, ...)` suffix query matched the
 * RAW `entry_ref`, so origin-qualified refs (`source//type:name`) never
 * relinked and were re-scanned (non-indexably) on every index. The fix reuses
 * the canonical `findEntryIdByRef` resolver, which strips the `origin//`
 * qualifier via `parseAssetRef`.
 */
describe("relinkUsageEvents", () => {
  let db: AkmDatabase;

  /** Minimal `entries` schema — only the columns the resolver reads. */
  function seedEntry(entryKey: string, entryType: string, name: string): number {
    const suffix = `:${entryType}:${name}`;
    const stashDir = entryKey.endsWith(suffix) ? entryKey.slice(0, -suffix.length) : "";
    const info = db
      .prepare("INSERT INTO entries (entry_key, entry_type, stash_dir, entry_json) VALUES (?, ?, ?, ?)")
      .run(entryKey, entryType, stashDir, JSON.stringify({ type: entryType, name }));
    return Number(info.lastInsertRowid);
  }

  function insertEvent(entryRef: string, entryId: number | null): void {
    db.prepare("INSERT INTO usage_events (event_type, entry_id, entry_ref) VALUES ('show', ?, ?)").run(
      entryId,
      entryRef,
    );
  }

  function entryIdFor(entryRef: string): number | null {
    const row = db.prepare("SELECT entry_id FROM usage_events WHERE entry_ref = ?").get(entryRef) as {
      entry_id: number | null;
    };
    return row.entry_id;
  }

  beforeEach(() => {
    db = new Database(":memory:") as unknown as AkmDatabase;
    db.exec(`
      CREATE TABLE entries (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        entry_key  TEXT NOT NULL,
        entry_type TEXT NOT NULL,
        stash_dir  TEXT NOT NULL,
        entry_json TEXT NOT NULL
      );
    `);
    ensureUsageEventsSchema(db);
  });

  test("relinks a BARE type:name ref after entry ids change (existing behaviour)", () => {
    const id = seedEntry("/home/u/akm:skill:deploy", "skill", "deploy");
    insertEvent("skill:deploy", null); // detached (e.g. after a full rebuild)

    relinkUsageEvents(db, { defaultStashDir: "/home/u/akm" });

    expect(entryIdFor("skill:deploy")).toBe(id);
  });

  test("relinks an ORIGIN-QUALIFIED source//type:name ref (regression: was silently dropped)", () => {
    const id = seedEntry(
      "/home/u/.cache/akm/registry/git-github-getsentry-skills/abc/extracted:knowledge:skills/skill-writer/references/workflow-routing",
      "knowledge",
      "skills/skill-writer/references/workflow-routing",
    );
    insertEvent("github:getsentry/skills//knowledge:skills/skill-writer/references/workflow-routing", null);

    relinkUsageEvents(db, {
      sources: [
        {
          path: "/home/u/.cache/akm/registry/git-github-getsentry-skills/abc/extracted",
          registryId: "github:getsentry/skills",
        },
      ],
    });

    expect(entryIdFor("github:getsentry/skills//knowledge:skills/skill-writer/references/workflow-routing")).toBe(id);
  });

  test("relinks duplicate refs by qualified source and routes bare legacy refs only to the default root", () => {
    const stashRoot = "/home/u/akm";
    const teamRoot = "/home/u/team";
    const stashId = seedEntry(`${stashRoot}:memory:duplicate`, "memory", "duplicate");
    const teamId = seedEntry(`${teamRoot}:memory:duplicate`, "memory", "duplicate");
    insertEvent("stash//memory:duplicate", null);
    insertEvent("team//memory:duplicate", null);
    insertEvent("memory:duplicate", null);

    relinkUsageEvents(db, {
      sources: [
        { path: stashRoot, registryId: "stash" },
        { path: teamRoot, registryId: "team" },
      ],
      defaultStashDir: stashRoot,
    });

    expect(entryIdFor("stash//memory:duplicate")).toBe(stashId);
    expect(entryIdFor("team//memory:duplicate")).toBe(teamId);
    expect(entryIdFor("memory:duplicate")).toBe(stashId);
  });

  test("leaves an ambiguous bare ref detached when no historical root policy is supplied", () => {
    seedEntry("/home/u/akm:memory:duplicate", "memory", "duplicate");
    seedEntry("/home/u/team:memory:duplicate", "memory", "duplicate");
    insertEvent("memory:duplicate", null);

    relinkUsageEvents(db);

    expect(entryIdFor("memory:duplicate")).toBeNull();
  });

  test("leaves a genuinely-orphaned ref null (no matching entry)", () => {
    seedEntry("/home/u/akm:skill:deploy", "skill", "deploy");
    insertEvent("script:does-not-exist", null);

    relinkUsageEvents(db, { defaultStashDir: "/home/u/akm" });

    expect(entryIdFor("script:does-not-exist")).toBeNull();
  });

  test("nulls entry_ids pointing at deleted entries, then re-resolves via ref", () => {
    const id = seedEntry("/home/u/akm:skill:deploy", "skill", "deploy");
    // Event points at a stale id (99) that no longer exists, but carries a
    // resolvable ref.
    insertEvent("skill:deploy", 99);

    relinkUsageEvents(db, { defaultStashDir: "/home/u/akm" });

    expect(entryIdFor("skill:deploy")).toBe(id);
  });

  test("does not clobber already-correct links", () => {
    const id = seedEntry("/home/u/akm:skill:deploy", "skill", "deploy");
    insertEvent("skill:deploy", id);

    relinkUsageEvents(db);

    expect(entryIdFor("skill:deploy")).toBe(id);
  });
});
