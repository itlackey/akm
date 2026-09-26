// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import path from "node:path";
import { deriveEntryProvenance } from "../../../src/indexer/installations";
import { ensureUsageEventsSchema } from "../../../src/indexer/usage/usage-events";
import type { Database as AkmDatabase } from "../../../src/storage/database";
import { openIndexDatabase } from "../../../src/storage/repositories/index-connection";
import { relinkUsageEvents, upsertEntry } from "../../../src/storage/repositories/index-entries-repository";

/**
 * Focused tests for {@link relinkUsageEvents}.
 *
 * Every `usage_events.entry_ref` is the fully-qualified `bundle//conceptId`
 * item-ref spelling. Relinking resolves detached rows through the canonical
 * `findEntryIdByRef` resolver; bare durable refs are ignored.
 */
describe("relinkUsageEvents", () => {
  // usage_events lives in state.db while entries lives in index.db, so relink
  // spans both handles.
  let indexDb: AkmDatabase;
  let stateDb: AkmDatabase;

  /**
   * Seed a current `entries` row through the production writer. The durable
   * identity is `item_ref = bundle//conceptId`.
   */
  function seedEntry(bundle: string, conceptId: string, stashDir: string): number {
    const type = conceptId.startsWith("memories/") ? "memory" : "skill";
    const name = conceptId.split("/").at(-1) ?? conceptId;
    return upsertEntry(
      indexDb,
      path.join(stashDir, conceptId),
      { name, type },
      name,
      deriveEntryProvenance({ bundleId: bundle, componentId: bundle, adapterId: "akm" }, type, name, conceptId),
    );
  }

  function insertEvent(entryRef: string, entryId: number | null): void {
    stateDb
      .prepare("INSERT INTO usage_events (event_type, entry_id, entry_ref, source) VALUES ('show', ?, ?, 'user')")
      .run(entryId, entryRef);
  }

  function entryIdFor(entryRef: string): number | null {
    const row = stateDb.prepare("SELECT entry_id FROM usage_events WHERE entry_ref = ?").get(entryRef) as {
      entry_id: number | null;
    };
    return row.entry_id;
  }

  beforeEach(() => {
    indexDb = openIndexDatabase(":memory:");
    stateDb = new Database(":memory:") as unknown as AkmDatabase;
    ensureUsageEventsSchema(stateDb);
  });

  afterEach(() => {
    indexDb.close();
    stateDb.close();
  });

  test("leaves a bare conceptId ref detached", () => {
    seedEntry("stash", "skills/deploy", "/home/u/akm");
    insertEvent("skills/deploy", null); // detached (e.g. after a full rebuild)

    relinkUsageEvents(indexDb, stateDb);

    expect(entryIdFor("skills/deploy")).toBeNull();
  });

  test("relinks a fully-qualified bundle//conceptId ref by its globally-unique item_ref", () => {
    const id = seedEntry(
      "getsentry-skills",
      "knowledge/skills/skill-writer/references/workflow-routing",
      "/home/u/.cache/akm/registry/getsentry-skills/abc/extracted",
    );
    insertEvent("getsentry-skills//knowledge/skills/skill-writer/references/workflow-routing", null);

    relinkUsageEvents(indexDb, stateDb);

    expect(entryIdFor("getsentry-skills//knowledge/skills/skill-writer/references/workflow-routing")).toBe(id);
  });

  test("relinks duplicate conceptId refs by bundle without adopting a bare ref", () => {
    const stashRoot = "/home/u/akm";
    const teamRoot = "/home/u/team";
    const stashId = seedEntry("stash", "memories/duplicate", stashRoot);
    const teamId = seedEntry("team", "memories/duplicate", teamRoot);
    insertEvent("stash//memories/duplicate", null);
    insertEvent("team//memories/duplicate", null);
    insertEvent("memories/duplicate", null);

    relinkUsageEvents(indexDb, stateDb);

    expect(entryIdFor("stash//memories/duplicate")).toBe(stashId);
    expect(entryIdFor("team//memories/duplicate")).toBe(teamId);
    expect(entryIdFor("memories/duplicate")).toBeNull();
  });

  test("leaves a genuinely-orphaned ref null (no matching entry)", () => {
    seedEntry("stash", "skills/deploy", "/home/u/akm");
    insertEvent("scripts/does-not-exist", null);

    relinkUsageEvents(indexDb, stateDb);

    expect(entryIdFor("scripts/does-not-exist")).toBeNull();
  });

  test("nulls entry_ids pointing at deleted entries, then re-resolves via ref", () => {
    const id = seedEntry("stash", "skills/deploy", "/home/u/akm");
    // Event points at a stale id (99) that no longer exists, but carries a
    // resolvable ref.
    insertEvent("stash//skills/deploy", 99);

    relinkUsageEvents(indexDb, stateDb);

    expect(entryIdFor("stash//skills/deploy")).toBe(id);
  });

  test("does not clobber already-correct links", () => {
    const id = seedEntry("stash", "skills/deploy", "/home/u/akm");
    insertEvent("stash//skills/deploy", id);

    relinkUsageEvents(indexDb, stateDb);

    expect(entryIdFor("stash//skills/deploy")).toBe(id);
  });
});
