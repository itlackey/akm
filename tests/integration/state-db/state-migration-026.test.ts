// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * TESTS for state migration `026-proposals-strip-legacy-fragment-refs` (#898).
 *
 * Prior to the ref grammar tightening, a proposal's `ref` column could carry
 * the retired OKF export-fragment selector (`[bundle//]conceptId#fragment`).
 * `currentProposalRef` (src/storage/repositories/proposals-repository.ts) now
 * refuses ANY fragment, so every row a prior release wrote with one fails to
 * parse on every read. This migration strips the fragment once, in place,
 * instead of leaving every reader to skip-and-warn forever.
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getStateMigrationSafety,
  STATE_MIGRATION_SAFETY_BY_ID,
  STATE_MIGRATIONS,
} from "../../../src/core/state/migrations";
import { getStateDbPath, openStateDatabase } from "../../../src/core/state-db";
import { _resetWarnOnceForTests } from "../../../src/core/warn";
import { openDatabase } from "../../../src/storage/database";
import { listStateProposals } from "../../../src/storage/repositories/proposals-repository";
import { runMigrations } from "../../../src/storage/sqlite-migrations";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../_helpers/sandbox";

const MIGRATION_ID = "026-proposals-strip-legacy-fragment-refs";
const PRECEDING_MIGRATION_ID = "025-task-history-vocabulary-backfill";

const roots: string[] = [];

function statePath(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akm-state-migration-026-"));
  roots.push(root);
  return path.join(root, "state.db");
}

function migrationIndex(id: string): number {
  const index = STATE_MIGRATIONS.findIndex((migration) => migration.id === id);
  if (index < 0) throw new Error(`Missing state migration fixture ${id}`);
  return index;
}

interface RawProposalRow {
  id: string;
  ref: string;
}

function readRows(db: { prepare(sql: string): { all(...params: unknown[]): unknown } }): RawProposalRow[] {
  return db.prepare("SELECT id, ref FROM proposals ORDER BY id").all() as RawProposalRow[];
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("migration 026-proposals-strip-legacy-fragment-refs — registry position and safety classification", () => {
  test("is registered directly after 025-task-history-vocabulary-backfill", () => {
    const ids = STATE_MIGRATIONS.map((migration) => migration.id);
    const index = ids.indexOf(MIGRATION_ID);
    expect(index).toBeGreaterThan(-1);
    expect(ids[index - 1]).toBe(PRECEDING_MIGRATION_ID);
  });

  test("is a classified id in STATE_MIGRATION_SAFETY_BY_ID, classified data-preserving-rebuild", () => {
    const classifiedIds = Object.keys(STATE_MIGRATION_SAFETY_BY_ID);
    expect(classifiedIds).toContain(MIGRATION_ID);
    expect(getStateMigrationSafety(MIGRATION_ID)).toBe("data-preserving-rebuild");
  });

  test("the safety-classification registry key order matches the migration registry order exactly", () => {
    expect(Object.keys(STATE_MIGRATION_SAFETY_BY_ID)).toEqual(STATE_MIGRATIONS.map((migration) => migration.id));
  });
});

describe("migration 026-proposals-strip-legacy-fragment-refs — legacy fragment-ref backfill", () => {
  function seedPre026Db(file: string): void {
    const before026 = STATE_MIGRATIONS.slice(0, migrationIndex(MIGRATION_ID));
    const seeded = openDatabase(file);
    runMigrations(seeded, before026);
    const insert = seeded.prepare(
      `INSERT INTO proposals
         (id, stash_dir, ref, status, source, created_at, updated_at, content, frontmatter_json, metadata_json)
       VALUES (?, '/tmp/stash', ?, 'accepted', 'consolidate', ?, ?, 'legacy content', NULL, '{}')`,
    );
    // Bundle-qualified ref carrying an export fragment (the exact #898 shape).
    insert.run(
      "legacy-fragment-qualified",
      "akm//knowledge/brand-aesthetic-guidelines#standalone-frontmatter-layouts",
      "2026-05-27T10:00:00.000Z",
      "2026-05-27T10:00:00.500Z",
    );
    // Short (unqualified) ref carrying a fragment.
    insert.run(
      "legacy-fragment-short",
      "knowledge/other-guide#some-section",
      "2026-06-23T10:00:00.000Z",
      "2026-06-23T10:00:00.500Z",
    );
    // Already-current row (no fragment): must be left byte-for-byte alone.
    insert.run("current-row", "akm//knowledge/already-fine", "2026-07-01T10:00:00.000Z", "2026-07-01T10:00:00.500Z");
    seeded.close();
  }

  test("strips the fragment from every legacy ref, leaving fragment-free rows untouched", () => {
    const file = statePath();
    seedPre026Db(file);

    const upgraded = openStateDatabase(file);
    try {
      const ids = (
        upgraded.prepare("SELECT id FROM schema_migrations ORDER BY rowid").all() as Array<{ id: string }>
      ).map((row) => row.id);
      expect(ids).toContain(MIGRATION_ID);

      const rows = readRows(upgraded);
      const byId = new Map(rows.map((row) => [row.id, row]));

      expect(byId.get("legacy-fragment-qualified")?.ref).toBe("akm//knowledge/brand-aesthetic-guidelines");
      expect(byId.get("legacy-fragment-short")?.ref).toBe("knowledge/other-guide");
      expect(byId.get("current-row")?.ref).toBe("akm//knowledge/already-fine");
    } finally {
      upgraded.close();
    }
  });

  describe("listStateProposals end-to-end", () => {
    let storage: IsolatedAkmStorage;

    afterEach(() => {
      storage.cleanup();
      _resetWarnOnceForTests();
    });

    test("reads every migrated row without throwing or skip-warning, once migration 026 has run", () => {
      storage = withIsolatedAkmStorage();
      const file = getStateDbPath();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      seedPre026Db(file);

      // Exercise the migration through the same path production code uses:
      // the next open (listStateProposals's caller -> openStateDatabase())
      // applies every pending migration, including 026.
      const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
      try {
        const db = openStateDatabase(file);
        try {
          const proposals = listStateProposals(db, { stashDir: "/tmp/stash" });
          const byId = new Map(proposals.map((p) => [p.id, p]));
          expect(byId.get("legacy-fragment-qualified")?.ref).toBe("akm//knowledge/brand-aesthetic-guidelines");
          expect(byId.get("legacy-fragment-short")?.ref).toBe("knowledge/other-guide");
          expect(byId.get("current-row")?.ref).toBe("akm//knowledge/already-fine");
          expect(proposals).toHaveLength(3);
        } finally {
          db.close();
        }
        // Resolution confirmed: the migration normalized the refs, so the
        // per-row skip-and-warn path (#898) never fires for them at all.
        expect(warnSpy).not.toHaveBeenCalled();
      } finally {
        warnSpy.mockRestore();
      }
    });
  });
});
