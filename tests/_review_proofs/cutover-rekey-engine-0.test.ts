// PROOF: a durable state.db row referencing a REMOVED type (`vault:`/`tool:`)
// aborts the whole re-key with CutoverIntegrityError (fail-closed / restore),
// while a since-deleted ref of a STILL-VALID type (`skill:gone`) is quarantined
// and completes — inverting the "unresolvable refs are quarantined, not
// dropped" contract.
//
// Direct-function test on the re-key engine (root cause). The apply flow
// converts CutoverIntegrityError into a pre-commit backup restore, and because
// the offending row is durable it re-throws on every retry -> permanent wedge.

import { test, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openStateDbAtCeiling, PRE_CUTOVER_STATE_CEILING } from "../_fixtures/migration/seed-rows";
import { CutoverIntegrityError, rekeyStateDb } from "../../src/migrate/legacy/three-db-cutover";

function tmpStatePath(slug: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `rekey-vault-${slug}-`));
  return path.join(dir, "state.db");
}

function seedEvent(statePath: string, ref: string): void {
  const db = openStateDbAtCeiling(statePath, PRE_CUTOVER_STATE_CEILING);
  try {
    db.prepare(`INSERT INTO events (event_type, ts, ref, metadata_json) VALUES (?, ?, ?, '{}')`).run(
      "show",
      "2026-01-01T00:00:00Z",
      ref,
    );
  } finally {
    db.close();
  }
}

// The refMap a realistic build produces: it maps the LIVE skill entry, and
// NEVER contains a `vault:` key (no vault type in the frozen resolver / index).
const REF_MAP = new Map<string, string>([["skill:live-one", "primary//skills/live-one"]]);

test("removed-type ref (vault:prod) FATALLY ABORTS the re-key instead of quarantining", () => {
  const statePath = tmpStatePath("removed");
  seedEvent(statePath, "skill:live-one"); // live, in map -> re-keyed
  seedEvent(statePath, "vault:prod"); // removed type, NOT in map

  // Under the intended contract this "no live item" ref should be quarantined
  // (like any orphan) and the re-key should complete. Instead it throws.
  let thrown: unknown;
  try {
    rekeyStateDb(statePath, REF_MAP);
  } catch (err) {
    thrown = err;
  }

  expect(thrown).toBeInstanceOf(CutoverIntegrityError);
  expect(String((thrown as Error).message)).toContain("vault:prod");
});

test("CONTRAST: a since-deleted ref of a STILL-VALID type (skill:gone) is quarantined, not aborted", () => {
  const statePath = tmpStatePath("orphan");
  seedEvent(statePath, "skill:live-one"); // live, in map
  seedEvent(statePath, "skill:gone"); // valid type, deleted asset, NOT in map

  const report = rekeyStateDb(statePath, REF_MAP); // must NOT throw
  expect(report.quarantined.events ?? 0).toBeGreaterThanOrEqual(1);

  // The valid-type orphan is archived in legacy_state; the removed-type one
  // never gets that chance because the whole pass aborts first.
  const db = openStateDbAtCeiling(statePath, PRE_CUTOVER_STATE_CEILING);
  try {
    const archived = db
      .prepare(`SELECT COUNT(*) AS n FROM legacy_state WHERE surface = 'events' AND old_ref = 'skill:gone'`)
      .get() as { n: number };
    expect(archived.n).toBe(1);
  } finally {
    db.close();
  }
});
