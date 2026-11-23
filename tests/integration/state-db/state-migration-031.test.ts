// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * TESTS for state migration `031-bundle-id-columns` and the state opener's conversion after it (§0.2 P8): the
 * `proposals`, `improve_runs` and `improve_ledger` tables name a row's bundle by id (`bundle_id`), not by the root
 * (`stash_dir`) it was filed under. The migration renames the column and copies each root; the opener then rewrites
 * every root to the id of the bundle that directory is, once the config can be read.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { resetConfigCache } from "../../../src/core/config/config";
import { getStateMigrationSafety, STATE_MIGRATIONS } from "../../../src/core/state/migrations";
import { openStateDatabase, openStateReadSnapshot } from "../../../src/core/state-db";
import { STATE_BUNDLE_ID_COLUMNS } from "../../../src/storage/bundle-id-columns";
import { openDatabase } from "../../../src/storage/database";
import { runMigrations } from "../../../src/storage/sqlite-migrations";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../../_helpers/sandbox";

const MIGRATION_ID = "031-bundle-id-columns";
let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  resetConfigCache();
});

afterEach(() => {
  storage.cleanup();
  resetConfigCache();
});

const statePath = () => path.join(storage.dataDir, "akm", "state.db");

/** A state.db at the schema 0.9.x left it (one migration short), with one row of each table filed under `root`. */
function seedPre031(roots: { proposal: string; run: string; ledger: string }): void {
  fs.mkdirSync(path.dirname(statePath()), { recursive: true });
  const db = openDatabase(statePath());
  try {
    runMigrations(
      db,
      STATE_MIGRATIONS.slice(
        0,
        STATE_MIGRATIONS.findIndex((m) => m.id === MIGRATION_ID),
      ),
    );
    db.prepare(
      `INSERT INTO proposals (id, stash_dir, ref, status, source, created_at, updated_at, content, metadata_json)
       VALUES ('p1', ?, 'work//knowledge/a', 'pending', 'reflect', 't', 't', 'body', '{}')`,
    ).run(roots.proposal);
    db.prepare(
      `INSERT INTO improve_runs (id, started_at, stash_dir, scope_mode, ok, result_json)
       VALUES ('r1', 't', ?, 'all', 1, '{}')`,
    ).run(roots.run);
    db.prepare(
      `INSERT INTO improve_ledger (stash_dir, ref, source, last_attempt_at, outcome)
       VALUES (?, 'work//knowledge/a', 'reflect', 't', 'proposed')`,
    ).run(roots.ledger);
  } finally {
    db.close();
  }
}

const bundleIds = (db: ReturnType<typeof openStateDatabase>): Record<string, string[]> =>
  Object.fromEntries(
    STATE_BUNDLE_ID_COLUMNS.map(({ table, column }) => [
      table,
      (db.prepare(`SELECT ${column} AS id FROM ${table} ORDER BY ${column}`).all() as Array<{ id: string }>).map(
        (row) => row.id,
      ),
    ]),
  );

describe("migration 031-bundle-id-columns", () => {
  test("is classified so the database is copied first", () => {
    expect(getStateMigrationSafety(MIGRATION_ID)).toBe("historical-destructive");
  });

  test("a fresh database has bundle_id and no stash_dir in the three tables", () => {
    const db = openStateDatabase(statePath());
    try {
      for (const { table, column } of STATE_BUNDLE_ID_COLUMNS) {
        const names = (
          db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as Array<{ name: string }>
        ).map((row) => row.name);
        expect(names).toContain(column);
        expect(names).not.toContain("stash_dir");
      }
      const indexes = (
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%bundle%'").all() as Array<{
          name: string;
        }>
      ).map((row) => row.name);
      expect(indexes.sort()).toEqual([
        "idx_improve_runs_bundle_scope",
        "idx_proposals_bundle_status",
        "idx_proposals_bundle_status_ref_source",
      ]);
    } finally {
      db.close();
    }
  });

  test("upgrades a pre-031 database: a root becomes the id of the bundle at it, the rest of each row is kept", () => {
    writeSandboxConfig({
      semanticSearchMode: "off",
      bundles: { work: { path: storage.stashDir, writable: true } },
      defaultBundle: "work",
    });
    resetConfigCache();
    seedPre031({ proposal: storage.stashDir, run: storage.stashDir, ledger: storage.stashDir });

    const db = openStateDatabase(statePath());
    try {
      expect(bundleIds(db)).toEqual({ proposals: ["work"], improve_runs: ["work"], improve_ledger: ["work"] });
      expect(db.prepare("SELECT ref, status, content FROM proposals").get()).toEqual({
        ref: "work//knowledge/a",
        status: "pending",
        content: "body",
      });
      expect(db.prepare("SELECT scope_mode, ok FROM improve_runs").get()).toEqual({ scope_mode: "all", ok: 1 });
      expect(db.prepare("SELECT outcome FROM improve_ledger").get()).toEqual({ outcome: "proposed" });
    } finally {
      db.close();
    }
    // The copy taken before the migration still holds the roots.
    const backup = openDatabase(`${statePath()}.pre-${MIGRATION_ID}.bak`, { readonly: true, create: false });
    try {
      expect(backup.prepare("SELECT stash_dir FROM proposals").get()).toEqual({ stash_dir: storage.stashDir });
    } finally {
      backup.close();
    }
  });

  test("a root no configured bundle is at keeps its path, and a bundle configured at it later takes the rows", () => {
    const library = path.join(storage.root, "moved-away", "old-library");
    fs.mkdirSync(library, { recursive: true });
    writeSandboxConfig({
      semanticSearchMode: "off",
      bundles: { work: { path: storage.stashDir, writable: true } },
      defaultBundle: "work",
    });
    resetConfigCache();
    seedPre031({ proposal: library, run: library, ledger: library });

    const first = openStateDatabase(statePath());
    try {
      expect(bundleIds(first)).toEqual({ proposals: [library], improve_runs: [library], improve_ledger: [library] });
    } finally {
      first.close();
    }
    // Not looked at as another bundle's: a bundle called like the directory does not take them.
    writeSandboxConfig({
      bundles: {
        work: { path: storage.stashDir, writable: true },
        "old-library": { path: path.join(storage.root, "elsewhere"), writable: true },
      },
    });
    fs.mkdirSync(path.join(storage.root, "elsewhere"), { recursive: true });
    resetConfigCache();
    const second = openStateDatabase(statePath());
    try {
      expect(bundleIds(second).proposals).toEqual([library]);
    } finally {
      second.close();
    }
    // A bundle configured at the directory does.
    writeSandboxConfig({
      bundles: { work: { path: storage.stashDir, writable: true }, library: { path: library, writable: true } },
    });
    resetConfigCache();
    const third = openStateDatabase(statePath());
    try {
      expect(bundleIds(third)).toEqual({
        proposals: ["library"],
        improve_runs: ["library"],
        improve_ledger: ["library"],
      });
    } finally {
      third.close();
    }
  });

  test("two unconfigured directories with the same basename keep separate rows", () => {
    const first = path.join(storage.root, "a", "akm");
    const second = path.join(storage.root, "b", "akm");
    resetConfigCache();
    seedPre031({ proposal: first, run: first, ledger: first });
    const seeded = openDatabase(statePath());
    seeded.prepare("UPDATE proposals SET stash_dir = ? WHERE id = 'p1'").run(second);
    seeded.close();

    const db = openStateDatabase(statePath());
    try {
      expect(bundleIds(db).proposals).toEqual([second]);
      expect(bundleIds(db).improve_ledger).toEqual([first]);
    } finally {
      db.close();
    }
  });

  test("a root reached through a symbolic link is the bundle at the real directory", () => {
    const link = path.join(storage.root, "stash-link");
    fs.symlinkSync(storage.stashDir, link);
    writeSandboxConfig({
      semanticSearchMode: "off",
      bundles: { work: { path: storage.stashDir, writable: true } },
      defaultBundle: "work",
    });
    resetConfigCache();
    seedPre031({ proposal: link, run: storage.stashDir, ledger: link });

    const db = openStateDatabase(statePath());
    try {
      expect(bundleIds(db)).toEqual({ proposals: ["work"], improve_runs: ["work"], improve_ledger: ["work"] });
    } finally {
      db.close();
    }
  });

  test("a read snapshot of a database not migrated yet reads the current columns and leaves the file alone", () => {
    writeSandboxConfig({
      semanticSearchMode: "off",
      bundles: { work: { path: storage.stashDir, writable: true } },
      defaultBundle: "work",
    });
    resetConfigCache();
    seedPre031({ proposal: storage.stashDir, run: storage.stashDir, ledger: storage.stashDir });

    const snapshot = openStateReadSnapshot(statePath());
    try {
      expect(snapshot?.prepare("SELECT bundle_id FROM proposals").get()).toEqual({ bundle_id: "work" });
      expect(snapshot?.prepare("SELECT bundle_id FROM improve_ledger").get()).toEqual({ bundle_id: "work" });
    } finally {
      snapshot?.close();
    }
    const source = openDatabase(statePath(), { readonly: true, create: false });
    try {
      expect(source.prepare("SELECT stash_dir FROM proposals").get()).toEqual({ stash_dir: storage.stashDir });
    } finally {
      source.close();
    }
  });

  test("the conversion is idempotent: a second open changes nothing", () => {
    writeSandboxConfig({
      semanticSearchMode: "off",
      bundles: { work: { path: storage.stashDir, writable: true } },
      defaultBundle: "work",
    });
    resetConfigCache();
    seedPre031({ proposal: storage.stashDir, run: storage.stashDir, ledger: storage.stashDir });
    openStateDatabase(statePath()).close();
    // A config that no longer has the bundle: converted rows must not be looked up again.
    writeSandboxConfig({ bundles: { renamed: { path: storage.stashDir, writable: true } }, defaultBundle: "renamed" });
    resetConfigCache();
    const db = openStateDatabase(statePath());
    try {
      expect(bundleIds(db)).toEqual({ proposals: ["work"], improve_runs: ["work"], improve_ledger: ["work"] });
    } finally {
      db.close();
    }
  });
});
