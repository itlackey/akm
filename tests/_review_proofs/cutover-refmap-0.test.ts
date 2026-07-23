// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * PROOF: a durable state.db ref of a RETIRED type (`vault:` / `tool:`) that is
 * NOT in the cutover ref map is misclassified as an INTEGRITY failure and aborts
 * the whole re-key, instead of being quarantined as an expected orphan the way a
 * deleted NON-retired type (`skill:gone`) is.
 *
 * We drive rekeyStateDbCore (invoked unconditionally by runThreeDbCutover at
 * line 783) directly, via rekeyStateDb, against a REAL pre-cutover state.db
 * (built through the sealed migration chain at the pre-cutover ceiling) with an
 * EMPTY ref map (the unmapped condition: index.db absent, asset deleted).
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CutoverIntegrityError, rekeyStateDb } from "../../src/migrate/legacy/three-db-cutover";
import { insertAssetSalienceRow, openStateDbAtCeiling, PRE_CUTOVER_STATE_CEILING } from "../_fixtures/migration/seed-rows";

let workDir: string;

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "cutover-refmap-0-"));
});
afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

function seedSalience(dbPath: string, assetRef: string): void {
  const db = openStateDbAtCeiling(dbPath, PRE_CUTOVER_STATE_CEILING);
  try {
    insertAssetSalienceRow(db, {
      assetRef,
      encodingSalience: 0.5,
      outcomeSalience: 0.5,
      retrievalSalience: 0.5,
      rankScore: 0.5,
      consecutiveNoOps: 0,
      updatedAt: 1_700_000_000,
      homeostaticDemotedAt: null,
      encodingSource: null,
    });
  } finally {
    db.close();
  }
}

test("RETIRED-type unmapped ref (vault:) aborts the whole re-key as an integrity failure", () => {
  const dbPath = path.join(workDir, "vault", "state.db");
  seedSalience(dbPath, "vault:prod");

  // Empty ref map == index.db absent / vault asset deleted: the ref is unmapped.
  let thrown: unknown;
  try {
    rekeyStateDb(dbPath, new Map());
  } catch (err) {
    thrown = err;
  }

  // THE DEFECT: instead of quarantining `vault:prod` as an orphan, the whole
  // cutover re-key is aborted with a CutoverIntegrityError.
  expect(thrown).toBeInstanceOf(CutoverIntegrityError);
  expect((thrown as Error).message).toContain("unparseable stored ref");
  expect((thrown as Error).message).toContain("vault:prod");

  // The abort is deterministic — every re-run throws the identical error, so the
  // migrate-apply fail-closed path restores the backup on every attempt (wedge).
  let thrownAgain: unknown;
  try {
    rekeyStateDb(dbPath, new Map());
  } catch (err) {
    thrownAgain = err;
  }
  expect(thrownAgain).toBeInstanceOf(CutoverIntegrityError);
  expect((thrownAgain as Error).message).toBe((thrown as Error).message);
});

test("tool: is the same misclassification (second retired type)", () => {
  const dbPath = path.join(workDir, "tool", "state.db");
  seedSalience(dbPath, "tool:legacy-runner");
  expect(() => rekeyStateDb(dbPath, new Map())).toThrow(CutoverIntegrityError);
});

test("ASYMMETRY CONTROL: a deleted NON-retired type (skill:) is softly quarantined, not aborted", () => {
  const dbPath = path.join(workDir, "skill", "state.db");
  seedSalience(dbPath, "skill:gone");

  // Same unmapped condition, but a parseable legacy type → EXPECTED orphan.
  const report = rekeyStateDb(dbPath, new Map());
  expect(report.quarantined.asset_salience).toBe(1);

  // The row was archived to legacy_state as an orphan and removed from the table.
  const db = openStateDbAtCeiling(dbPath, PRE_CUTOVER_STATE_CEILING);
  try {
    const remaining = (db.prepare("SELECT COUNT(*) AS n FROM asset_salience").get() as { n: number }).n;
    const quarantined = db
      .prepare("SELECT surface, old_ref, reason FROM legacy_state WHERE old_ref = ?")
      .get("skill:gone") as { surface: string; old_ref: string; reason: string } | undefined;
    expect(remaining).toBe(0);
    expect(quarantined).toBeDefined();
    expect(quarantined?.reason).toBe("orphan");
  } finally {
    db.close();
  }
});
