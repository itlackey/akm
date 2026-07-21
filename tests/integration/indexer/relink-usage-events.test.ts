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
 * Post-Chunk-8 WI-8.5c: every `usage_events.entry_ref` is the fully-qualified
 * `bundle//conceptId` item_ref spelling (the one-time legacy→item_ref re-key is
 * owned by the migration cutover). The relink re-resolves detached rows through
 * the canonical `findEntryIdByRef` resolver, which keys on the durable
 * `entries.item_ref`. A short conceptId (no bundle) resolves within the default
 * stash root.
 */
describe("relinkUsageEvents", () => {
  // Chunk-8 WI-8.3: usage_events lives in state.db; `entries` in index.db. The
  // relink now spans both handles.
  let indexDb: AkmDatabase;
  let stateDb: AkmDatabase;

  /**
   * Minimal `entries` row (index.db) — only the columns the resolver reads. The
   * durable identity is `item_ref = bundle//conceptId`; `entry_key` carries the
   * stash root prefix so the id-change on rebuild is modelled.
   */
  function seedEntry(bundle: string, conceptId: string, stashDir: string): number {
    const itemRef = `${bundle}//${conceptId}`;
    const info = indexDb
      .prepare(
        "INSERT INTO entries (entry_key, entry_type, stash_dir, entry_json, item_ref, bundle_id, concept_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(`${stashDir}:${conceptId}`, conceptId.split("/")[0]!, stashDir, "{}", itemRef, bundle, conceptId);
    return Number(info.lastInsertRowid);
  }

  function insertEvent(entryRef: string, entryId: number | null): void {
    stateDb
      .prepare("INSERT INTO usage_events (event_type, entry_id, entry_ref) VALUES ('show', ?, ?)")
      .run(entryId, entryRef);
  }

  function entryIdFor(entryRef: string): number | null {
    const row = stateDb.prepare("SELECT entry_id FROM usage_events WHERE entry_ref = ?").get(entryRef) as {
      entry_id: number | null;
    };
    return row.entry_id;
  }

  beforeEach(() => {
    indexDb = new Database(":memory:") as unknown as AkmDatabase;
    indexDb.exec(`
      CREATE TABLE entries (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        entry_key  TEXT NOT NULL,
        entry_type TEXT NOT NULL,
        stash_dir  TEXT NOT NULL,
        entry_json TEXT NOT NULL,
        item_ref   TEXT,
        bundle_id  TEXT,
        concept_id TEXT
      );
    `);
    stateDb = new Database(":memory:") as unknown as AkmDatabase;
    ensureUsageEventsSchema(stateDb);
  });

  test("relinks a short conceptId ref within the default root after entry ids change", () => {
    const id = seedEntry("stash", "skills/deploy", "/home/u/akm");
    insertEvent("skills/deploy", null); // detached (e.g. after a full rebuild)

    relinkUsageEvents(indexDb, stateDb, { defaultStashDir: "/home/u/akm" });

    expect(entryIdFor("skills/deploy")).toBe(id);
  });

  test("relinks a fully-qualified bundle//conceptId ref by its globally-unique item_ref", () => {
    const id = seedEntry(
      "getsentry-skills",
      "knowledge/skills/skill-writer/references/workflow-routing",
      "/home/u/.cache/akm/registry/getsentry-skills/abc/extracted",
    );
    insertEvent("getsentry-skills//knowledge/skills/skill-writer/references/workflow-routing", null);

    relinkUsageEvents(indexDb, stateDb, {});

    expect(entryIdFor("getsentry-skills//knowledge/skills/skill-writer/references/workflow-routing")).toBe(id);
  });

  test("relinks duplicate conceptId refs by bundle and routes a short ref to the default root", () => {
    const stashRoot = "/home/u/akm";
    const teamRoot = "/home/u/team";
    const stashId = seedEntry("stash", "memories/duplicate", stashRoot);
    const teamId = seedEntry("team", "memories/duplicate", teamRoot);
    insertEvent("stash//memories/duplicate", null);
    insertEvent("team//memories/duplicate", null);
    insertEvent("memories/duplicate", null);

    relinkUsageEvents(indexDb, stateDb, {
      sources: [
        { path: stashRoot, registryId: "stash" },
        { path: teamRoot, registryId: "team" },
      ],
      defaultStashDir: stashRoot,
    });

    expect(entryIdFor("stash//memories/duplicate")).toBe(stashId);
    expect(entryIdFor("team//memories/duplicate")).toBe(teamId);
    expect(entryIdFor("memories/duplicate")).toBe(stashId);
  });

  test("leaves a genuinely-orphaned ref null (no matching entry)", () => {
    seedEntry("stash", "skills/deploy", "/home/u/akm");
    insertEvent("scripts/does-not-exist", null);

    relinkUsageEvents(indexDb, stateDb, { defaultStashDir: "/home/u/akm" });

    expect(entryIdFor("scripts/does-not-exist")).toBeNull();
  });

  test("nulls entry_ids pointing at deleted entries, then re-resolves via ref", () => {
    const id = seedEntry("stash", "skills/deploy", "/home/u/akm");
    // Event points at a stale id (99) that no longer exists, but carries a
    // resolvable ref.
    insertEvent("skills/deploy", 99);

    relinkUsageEvents(indexDb, stateDb, { defaultStashDir: "/home/u/akm" });

    expect(entryIdFor("skills/deploy")).toBe(id);
  });

  test("does not clobber already-correct links", () => {
    const id = seedEntry("stash", "skills/deploy", "/home/u/akm");
    insertEvent("skills/deploy", id);

    relinkUsageEvents(indexDb, stateDb);

    expect(entryIdFor("skills/deploy")).toBe(id);
  });
});
