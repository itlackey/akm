// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * PROOF: a durable `vault:`/`tool:` ref left in a re-keyed state.db table makes
 * `runThreeDbCutover` throw CutoverIntegrityError and roll back on EVERY attempt,
 * so a legitimate 0.8.x install that ever used the (first-class, since-0.5.0)
 * `vault` asset type can never complete `migrate apply`.
 *
 * Mechanism (verified by reading the source):
 *   rekeyScalarTable / rekeyEventTable -> classifyCutoverRef -> parseStoredRef
 *   -> parseAssetRef, which THROWS a deliberate redirect for `vault:` and a
 *   DEPRECATED_REJECTED_TYPES rejection for `tool:`. The catch turns that into
 *   {kind:"integrity"}, which is rethrown as CutoverIntegrityError. The whole
 *   cutover txn rolls back, so the identical vault row is re-scanned next run.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { getStateDbPathInDataDir } from "../../src/core/paths";
import {
  buildCutoverRefMap,
  CutoverIntegrityError,
  runThreeDbCutover,
} from "../../src/migrate/legacy/three-db-cutover";
import { insertAssetSalienceRow, openStateDbAtCeiling, PRE_CUTOVER_STATE_CEILING } from "../_fixtures/migration/seed-rows";
import {
  type Cleanup,
  sandboxHome,
  sandboxXdgCacheHome,
  sandboxXdgConfigHome,
  sandboxXdgDataHome,
} from "../_helpers/sandbox";

let cleanup: Cleanup | undefined;

beforeEach(() => {
  const home = sandboxHome();
  const config = sandboxXdgConfigHome(home.cleanup);
  const cache = sandboxXdgCacheHome(config.cleanup);
  cleanup = sandboxXdgDataHome(cache.cleanup).cleanup;
});

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

function salienceRow(ref: string) {
  return {
    assetRef: ref,
    encodingSalience: 0.5,
    outcomeSalience: 0.5,
    retrievalSalience: 0.5,
    rankScore: 0.5,
    consecutiveNoOps: 0,
    updatedAt: 1_700_000_000,
    homeostaticDemotedAt: null,
    encodingSource: null,
  };
}

/** Build a pre-cutover state.db seeded with `refs` in asset_salience, return its path. */
function seedStateDb(refs: string[]): string {
  const statePath = getStateDbPathInDataDir();
  const db = openStateDbAtCeiling(statePath, PRE_CUTOVER_STATE_CEILING);
  try {
    for (const ref of refs) insertAssetSalienceRow(db, salienceRow(ref));
  } finally {
    db.close();
  }
  return statePath;
}

function runCutover(statePath: string, refMap: Map<string, string>, operationId: string) {
  return runThreeDbCutover({
    refMap,
    operationId,
    statePath,
    workflowPath: path.join(path.dirname(statePath), "does-not-exist-workflow.db"),
    oldIndexPath: path.join(path.dirname(statePath), "does-not-exist-index.db"),
  });
}

describe("vault:/tool: durable ref wedges migrate apply", () => {
  test("a `vault:` asset_salience row throws CutoverIntegrityError, rolls back, and re-throws every attempt", () => {
    const statePath = seedStateDb(["vault:production"]);

    // Map does NOT cover the vault ref (a real install's map never does — see the
    // realism test below). This is the exact input the cutover re-key receives.
    const refMap = new Map<string, string>();

    // Attempt 1.
    let thrown1: unknown;
    try {
      runCutover(statePath, refMap, "op-attempt-1");
    } catch (e) {
      thrown1 = e;
    }
    expect(thrown1).toBeInstanceOf(CutoverIntegrityError);
    expect((thrown1 as Error).message).toContain('unparseable stored ref "vault:production"');

    // The txn rolled back cleanly: the vault row survives (no data lost)...
    const db = new Database(statePath);
    try {
      const row = db
        .prepare("SELECT asset_ref FROM asset_salience WHERE asset_ref = ?")
        .get("vault:production") as { asset_ref: string } | undefined;
      expect(row?.asset_ref).toBe("vault:production");

      // ...and NO committed cutover marker exists, so the install is not advanced.
      const ledgerExists = !!db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='akm_cutover_ledger'")
        .get();
      const markerCount = ledgerExists
        ? (db.prepare("SELECT COUNT(*) AS n FROM akm_cutover_ledger").get() as { n: number }).n
        : 0;
      expect(markerCount).toBe(0);
    } finally {
      db.close();
    }

    // Attempt 2 (a fresh `migrate apply`): identical vault row -> identical abort.
    let thrown2: unknown;
    try {
      runCutover(statePath, refMap, "op-attempt-2");
    } catch (e) {
      thrown2 = e;
    }
    expect(thrown2).toBeInstanceOf(CutoverIntegrityError);
    expect((thrown2 as Error).message).toContain('unparseable stored ref "vault:production"');
  });

  test("the retired `tool:` type wedges identically (DEPRECATED_REJECTED_TYPES)", () => {
    const statePath = seedStateDb(["tool:linter"]);
    let thrown: unknown;
    try {
      runCutover(statePath, new Map(), "op-tool");
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(CutoverIntegrityError);
    expect((thrown as Error).message).toContain('unparseable stored ref "tool:linter"');
  });

  test("CONTRAST: an equivalent orphaned but *parseable* ref (`skill:ghost`) is gracefully quarantined, not a hard failure", () => {
    const statePath = seedStateDb(["skill:ghost"]);
    // Same empty map, same "no live item" situation — but skill: parses, so the
    // cutover treats it as an EXPECTED orphan, quarantines it, and COMMITS.
    const result = runCutover(statePath, new Map(), "op-orphan");
    expect(result.merged).toBe(true);

    const db = new Database(statePath);
    try {
      const marker = db.prepare("SELECT operation_id FROM akm_cutover_ledger WHERE singleton = 1").get() as
        | { operation_id: string }
        | undefined;
      expect(marker?.operation_id).toBe("op-orphan"); // cutover completed
      const quarantined = db
        .prepare("SELECT row_count FROM legacy_state WHERE surface = 'asset_salience' AND old_ref = ?")
        .get("skill:ghost") as { row_count: number } | undefined;
      expect(quarantined?.row_count).toBe(1); // handled gracefully
    } finally {
      db.close();
    }
  });

  test("REALISM: buildCutoverRefMap never produces a `vault:` mapping, even with vaults/ on disk", () => {
    const stashRoot = path.join(path.dirname(getStateDbPathInDataDir()), "stash");
    // A real skill the map SHOULD cover (frozen source-(b) walk finds it)...
    fs.mkdirSync(path.join(stashRoot, "skills", "deploy"), { recursive: true });
    fs.writeFileSync(path.join(stashRoot, "skills", "deploy", "SKILL.md"), "# deploy\n");
    // ...and a vault asset on disk that the frozen resolver has NO type for.
    fs.mkdirSync(path.join(stashRoot, "vaults"), { recursive: true });
    fs.writeFileSync(path.join(stashRoot, "vaults", "production.env"), "TOKEN=x\n");

    const map = buildCutoverRefMap({
      oldIndexDbPath: path.join(path.dirname(getStateDbPathInDataDir()), "no-such-index.db"),
      stashRoots: [{ path: stashRoot, primary: true }],
      mapOutputPath: path.join(path.dirname(getStateDbPathInDataDir()), "refmap.json"),
    });

    // The builder works for a real type...
    expect(map.get("skill:deploy")).toBeDefined();
    // ...but has no mapping for the durable vault ref: the re-key is guaranteed to
    // hit the integrity path for `vault:production`.
    expect(map.get("vault:production")).toBeUndefined();
    expect([...map.keys()].some((k) => k.includes("vault:"))).toBe(false);
  });
});
