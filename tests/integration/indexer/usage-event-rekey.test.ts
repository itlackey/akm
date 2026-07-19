// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * akm 0.9.0 Chunk-5 flip, F4c M2 — §11.4 one-time re-key of
 * `usage_events.entry_ref` from the legacy `[origin//]type:name` namespace onto
 * the fully-qualified `bundle//conceptId` item_ref, with the orphan-quarantine
 * taxonomy (spec §11.4). Unit-level: drives {@link rekeyUsageEventsToItemRef}
 * over an in-memory DB with a minimal `entries` fixture (happy path +
 * orphan-quarantine + origin fidelity + idempotency).
 */

import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { ensureUsageEventsSchema } from "../../../src/indexer/usage/usage-events";
import type { Database as AkmDatabase } from "../../../src/storage/database";
import { rekeyUsageEventsToItemRef } from "../../../src/storage/repositories/index-entries-repository";

describe("rekeyUsageEventsToItemRef (§11.4)", () => {
  let db: AkmDatabase;

  /** Minimal `entries` fixture carrying both the legacy key and item_ref. */
  function seedEntry(entryKey: string, entryType: string, name: string, itemRef: string): number {
    const suffix = `:${entryType}:${name}`;
    const stashDir = entryKey.endsWith(suffix) ? entryKey.slice(0, -suffix.length) : "";
    const conceptId = itemRef.slice(itemRef.indexOf("//") + 2);
    const bundleId = itemRef.slice(0, itemRef.indexOf("//"));
    const info = db
      .prepare(
        `INSERT INTO entries (entry_key, entry_type, stash_dir, entry_json, item_ref, concept_id, bundle_id, type)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entryKey,
        entryType,
        stashDir,
        JSON.stringify({ type: entryType, name }),
        itemRef,
        conceptId,
        bundleId,
        entryType,
      );
    return Number(info.lastInsertRowid);
  }

  function insertEvent(entryRef: string, entryId: number | null = null): void {
    db.prepare("INSERT INTO usage_events (event_type, entry_id, entry_ref) VALUES ('show', ?, ?)").run(
      entryId,
      entryRef,
    );
  }

  function refRows(): Array<{ entry_ref: string; entry_id: number | null }> {
    return db.prepare("SELECT entry_ref, entry_id FROM usage_events ORDER BY id").all() as Array<{
      entry_ref: string;
      entry_id: number | null;
    }>;
  }

  function quarantine(): Array<{ old_ref: string; row_count: number; reason: string }> {
    return db
      .prepare("SELECT old_ref, row_count, reason FROM legacy_state WHERE surface = 'usage_events' ORDER BY old_ref")
      .all() as Array<{ old_ref: string; row_count: number; reason: string }>;
  }

  beforeEach(() => {
    db = new Database(":memory:") as unknown as AkmDatabase;
    db.exec(`
      CREATE TABLE entries (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        entry_key  TEXT NOT NULL,
        entry_type TEXT NOT NULL,
        stash_dir  TEXT NOT NULL,
        entry_json TEXT NOT NULL,
        item_ref   TEXT,
        concept_id TEXT,
        bundle_id  TEXT,
        type       TEXT
      );
    `);
    ensureUsageEventsSchema(db);
  });

  test("HAPPY PATH — a bare type:name ref re-keys onto the primary's item_ref", () => {
    const id = seedEntry("/home/u/akm:skill:deploy", "skill", "deploy", "core//skills/deploy");
    insertEvent("skill:deploy");
    insertEvent("skill:deploy"); // two rows of the same logical ref, carried as-is

    const result = rekeyUsageEventsToItemRef(db, { defaultStashDir: "/home/u/akm" });

    expect(result).toEqual({ rekeyed: 1, quarantined: 0, deferred: 0 });
    expect(refRows()).toEqual([
      { entry_ref: "core//skills/deploy", entry_id: id },
      { entry_ref: "core//skills/deploy", entry_id: id },
    ]);
    expect(quarantine()).toEqual([]);
  });

  test("ORPHAN QUARANTINE — a ref that maps to no live item is archived, kept, not deleted", () => {
    seedEntry("/home/u/akm:skill:deploy", "skill", "deploy", "core//skills/deploy");
    insertEvent("skill:deploy"); // resolves
    insertEvent("memory:gone"); // orphan — no matching entry
    insertEvent("memory:gone"); // second orphan row (same ref)

    const result = rekeyUsageEventsToItemRef(db, { defaultStashDir: "/home/u/akm" });

    expect(result).toEqual({ rekeyed: 1, quarantined: 1, deferred: 0 });
    // The orphan rows are KEPT IN PLACE, legacy-spelled — never deleted.
    expect(refRows()).toEqual([
      { entry_ref: "core//skills/deploy", entry_id: expect.any(Number) },
      { entry_ref: "memory:gone", entry_id: null },
      { entry_ref: "memory:gone", entry_id: null },
    ]);
    // ...and archived for audit, with the row count reported.
    expect(quarantine()).toEqual([{ old_ref: "memory:gone", row_count: 2, reason: "orphan" }]);
  });

  test("ORIGIN FIDELITY — two origins of one conceptId never collapse onto one key", () => {
    const stashId = seedEntry("/home/u/akm:memory:shared", "memory", "shared", "stash//memories/shared");
    // The `team` copy was deduped OUT of the index (no entry row) → its origin
    // is an expected orphan; the `stash` copy re-keys to its own bundle.
    insertEvent("stash//memory:shared");
    insertEvent("team//memory:shared");

    const result = rekeyUsageEventsToItemRef(db, {
      sources: [
        { path: "/home/u/akm", registryId: "stash" },
        { path: "/home/u/team", registryId: "team" },
      ],
      defaultStashDir: "/home/u/akm",
    });

    expect(result).toEqual({ rekeyed: 1, quarantined: 1, deferred: 0 });
    expect(refRows()).toEqual([
      { entry_ref: "stash//memories/shared", entry_id: stashId },
      { entry_ref: "team//memory:shared", entry_id: null }, // orphan, kept legacy
    ]);
    expect(quarantine()).toEqual([{ old_ref: "team//memory:shared", row_count: 1, reason: "orphan" }]);
  });

  test("DEFER — a NULL-item_ref write-back straggler is left legacy-spelled (heals next index)", () => {
    // Entry exists but item_ref is still NULL.
    db.prepare(
      "INSERT INTO entries (entry_key, entry_type, stash_dir, entry_json, item_ref) VALUES (?, 'skill', '/home/u/akm', ?, NULL)",
    ).run("/home/u/akm:skill:deploy", JSON.stringify({ type: "skill", name: "deploy" }));
    insertEvent("skill:deploy");

    const result = rekeyUsageEventsToItemRef(db, { defaultStashDir: "/home/u/akm" });

    expect(result).toEqual({ rekeyed: 0, quarantined: 0, deferred: 1 });
    expect(refRows()).toEqual([{ entry_ref: "skill:deploy", entry_id: null }]);
    expect(quarantine()).toEqual([]);
  });

  test("IDEMPOTENT — a second run over already-re-keyed rows is a no-op", () => {
    seedEntry("/home/u/akm:skill:deploy", "skill", "deploy", "core//skills/deploy");
    insertEvent("skill:deploy");

    const first = rekeyUsageEventsToItemRef(db, { defaultStashDir: "/home/u/akm" });
    expect(first).toEqual({ rekeyed: 1, quarantined: 0, deferred: 0 });

    const second = rekeyUsageEventsToItemRef(db, { defaultStashDir: "/home/u/akm" });
    expect(second).toEqual({ rekeyed: 0, quarantined: 0, deferred: 0 });
    expect(refRows()).toEqual([{ entry_ref: "core//skills/deploy", entry_id: expect.any(Number) }]);
  });
});
