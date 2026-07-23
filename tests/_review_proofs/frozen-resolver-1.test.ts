// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * PROOF for candidate defect: "On a real 0.8.x index.db (no item_ref column)
 * source (a) is skipped, so installed git/npm-bundle durable refs are silently
 * quarantined+DELETED as orphans even though the asset still exists on disk."
 *
 * Strategy (direct-function, fast):
 *   1. Realism anchor: run the REAL config-shape migration over an old-shape
 *      config with an installed GIT bundle, and confirm the migrated bundle has
 *      NO `.path` (so cutoverStashRootsFromConfig would skip it — source (b)
 *      never walks its on-disk content).
 *   2. Build a realistic pre-v18 index.db whose `entries` table has NO
 *      `item_ref` column (the 0.8.x shape) — source (a) is gated on that column.
 *   3. Call the REAL buildCutoverRefMap with the stash roots a filesystem
 *      primary yields (the git bundle contributes none). Assert the durable ref
 *      `github:acme/skills//skill:deploy` is ABSENT from the map.
 *   4. Seed a pre-cutover state.db (asset_outcome + events + proposals) keyed to
 *      that live ref with real payload, and run the REAL rekey engine with the
 *      map built in step 3.
 *   5. Assert the payload rows are GONE, legacy_state keeps only ref+count (no
 *      payload), while the SKILL.md still exists on disk — live-asset history
 *      deleted, not re-keyed.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { migrateConfigSourcesToBundles } from "../../src/migrate/legacy/config-source-migration";
import {
  buildCutoverRefMap,
  type CutoverStashRoot,
  rekeyStateDb,
} from "../../src/migrate/legacy/three-db-cutover";
import { openStateDbAtCeiling, PRE_CUTOVER_STATE_CEILING, insertAssetOutcomeRow } from "../_fixtures/migration/seed-rows";

const DURABLE_REF = "github:acme/skills//skill:deploy";

let work: string;

beforeEach(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), "frozen-resolver-"));
});

afterEach(() => {
  fs.rmSync(work, { recursive: true, force: true });
});

/** Build a pre-v18 (0.8.x) index.db: entries table WITHOUT the item_ref column. */
function writePreV18IndexDb(dbPath: string): void {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE entries (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      entry_key   TEXT NOT NULL UNIQUE,
      dir_path    TEXT NOT NULL,
      file_path   TEXT NOT NULL,
      stash_dir   TEXT NOT NULL,
      entry_json  TEXT NOT NULL,
      search_text TEXT NOT NULL,
      entry_type  TEXT NOT NULL,
      derived_from TEXT
    );
  `);
  // The install DID index the community skill — but a pre-v18 row has no
  // item_ref column at all, so source (a) cannot use it.
  db.prepare(
    "INSERT INTO entries (entry_key, dir_path, file_path, stash_dir, entry_json, search_text, entry_type) VALUES (?,?,?,?,?,?,?)",
  ).run(DURABLE_REF, "/git/localroot/skills/deploy", "/git/localroot/skills/deploy/SKILL.md", "/git/localroot", "{}", "deploy", "skill");
  db.close();
}

test("REALISM: an installed git bundle migrates to a bundle with NO .path (source (b) will skip it)", () => {
  const raw = {
    stashDir: "/primary/stash",
    installed: [{ id: "acme-skills", source: "git", ref: "github:acme/skills", stashRoot: "/git/localroot" }],
  };
  const migrated = migrateConfigSourcesToBundles(raw as Record<string, unknown>) as {
    bundles: Record<string, { path?: string; git?: string }>;
  };
  const gitBundle = Object.values(migrated.bundles).find((b) => typeof b.git === "string");
  expect(gitBundle).toBeDefined();
  // The core reason source (b) never walks it: no filesystem path in the config.
  expect(gitBundle!.path).toBeUndefined();
});

test("DATA LOSS: live installed-bundle ref is absent from refMap, then DELETED by the rekey engine", () => {
  // ── on-disk state: git-bundle skill materialized (asset present) ──
  const gitRoot = path.join(work, "git-localroot");
  const skillFile = path.join(gitRoot, "skills", "deploy", "SKILL.md");
  fs.mkdirSync(path.dirname(skillFile), { recursive: true });
  fs.writeFileSync(skillFile, "---\nname: deploy\n---\nCommunity deploy skill\n");

  const primaryStash = path.join(work, "primary");
  fs.mkdirSync(path.join(primaryStash, "skills"), { recursive: true });

  // ── pre-v18 index.db (no item_ref column) ──
  const indexDbPath = path.join(work, "index.db");
  writePreV18IndexDb(indexDbPath);

  // ── stash roots a filesystem-primary config yields; the git bundle has no
  //    .path so cutoverStashRootsFromConfig contributes NO root for it. ──
  const stashRoots: CutoverStashRoot[] = [{ path: primaryStash, primary: true }];

  // ── build the REAL ref map ──
  const map = buildCutoverRefMap({
    oldIndexDbPath: indexDbPath,
    stashRoots,
    mapOutputPath: path.join(work, "refmap.json"),
  });

  // The durable installed-bundle ref is NOT resolvable → absent from the map.
  expect(map.get(DURABLE_REF)).toBeUndefined();

  // ── pre-cutover state.db with real curated payload for the live ref ──
  const stateDbPath = path.join(work, "state.db");
  const sdb = openStateDbAtCeiling(stateDbPath, PRE_CUTOVER_STATE_CEILING);
  insertAssetOutcomeRow(sdb, {
    assetRef: DURABLE_REF,
    lastRetrievedAt: 1_700_000_000,
    retrievalCount: 42,
    expectedRetrievalRate: 0.9,
    negativeFeedbackCount: 3,
    acceptedChangeCount: 7,
    outcomeScore: 0.8,
    updatedAt: 1_700_000_100,
  });
  sdb.prepare("INSERT INTO events (event_type, ts, ref, metadata_json) VALUES (?,?,?,?)").run(
    "retrieval",
    "2026-01-01T00:00:00Z",
    DURABLE_REF,
    '{"note":"audit history"}',
  );
  sdb.prepare(
    "INSERT INTO proposals (id, stash_dir, ref, status, source, created_at, updated_at, content, metadata_json) VALUES (?,?,?,?,?,?,?,?,?)",
  ).run(
    "prop-1",
    gitRoot,
    DURABLE_REF,
    "pending",
    "reflect",
    "2026-01-01T00:00:00Z",
    "2026-01-01T00:00:00Z",
    "pending proposal body",
    "{}",
  );
  sdb.close();

  // ── run the REAL rekey engine with the map built above ──
  rekeyStateDb(stateDbPath, map);

  // ── verify: payload rows GONE, legacy_state keeps only ref+count ──
  const v = new Database(stateDbPath);
  const outcomeLeft = (v.prepare("SELECT COUNT(*) AS n FROM asset_outcome WHERE asset_ref = ?").get(DURABLE_REF) as { n: number }).n;
  const eventsLeft = (v.prepare("SELECT COUNT(*) AS n FROM events WHERE ref = ?").get(DURABLE_REF) as { n: number }).n;
  const proposalsLeft = (v.prepare("SELECT COUNT(*) AS n FROM proposals WHERE ref = ?").get(DURABLE_REF) as { n: number }).n;

  expect(outcomeLeft).toBe(0);
  expect(eventsLeft).toBe(0);
  expect(proposalsLeft).toBe(0);

  const legacy = v
    .prepare("SELECT surface, old_ref, row_count, reason FROM legacy_state WHERE old_ref = ? ORDER BY surface")
    .all(DURABLE_REF) as Array<{ surface: string; old_ref: string; row_count: number; reason: string }>;
  const surfaces = legacy.map((r) => r.surface).sort();
  v.close();

  // All three surfaces are quarantined as "orphan" with only the ref + a count —
  // no retrieval_count / outcome_score / event metadata / proposal body survives.
  expect(surfaces).toEqual(["asset_outcome", "events", "proposals"]);
  for (const row of legacy) {
    expect(row.reason).toBe("orphan");
    expect(row.row_count).toBe(1);
  }

  // The asset itself is STILL on disk — its accumulated learning signal was
  // deleted even though the asset exists (and this runs in the committed cutover
  // txn, after which workflow.db is unlinked → unrecoverable by rollback).
  expect(fs.existsSync(skillFile)).toBe(true);
});
