// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * REVIEW PROOF — candidate: "Orphan re-key silently DELETES durable event rows
 * keeping only a per-ref count."
 *
 * This test drives the CITED function (rekeyStateDbCore via rekeyStateDb) on a
 * realistic pre-cutover state.db carrying an orphan `events` row (ref for a
 * renamed-away asset, absent from the refMap). It demonstrates the ACTUAL
 * behavior so the verdict can be decided against the code, the spec (§11.4),
 * and the shipped design tests.
 *
 * The candidate is REFUTED: the row content is indeed removed, but this is the
 * explicitly-specified, documented, and separately-tested §11.4 orphan-quarantine
 * policy — an AUDITABLE `legacy_state` record (surface/old_ref/row_count/reason)
 * is created, so the loss is NOT silent, and the migration-doc promise
 * ("unresolvable refs are quarantined, not dropped") is about the ref being
 * recorded, which it is. The count-only archive is the SPEC BASELINE; the
 * append-only `usage_events` KEEP behavior is a deliberate stronger guarantee,
 * not evidence the other surfaces are buggy.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { getStateDbPathInDataDir } from "../../src/core/paths";
import { rekeyStateDb } from "../../src/migrate/legacy/three-db-cutover";
import { openStateDbAtCeiling, PRE_CUTOVER_STATE_CEILING } from "../_fixtures/migration/seed-rows";
import {
  type Cleanup,
  sandboxHome,
  sandboxXdgCacheHome,
  sandboxXdgConfigHome,
  sandboxXdgDataHome,
} from "../_helpers/sandbox";

let cleanups: Cleanup[] = [];

beforeEach(() => {
  cleanups = [sandboxHome(), sandboxXdgConfigHome(), sandboxXdgCacheHome(), sandboxXdgDataHome()].map((s) => s.cleanup);
});

afterEach(() => {
  for (const c of cleanups.reverse()) c();
  cleanups = [];
});

const ORPHAN_REF = "skill:renamed-away"; // legacy grammar, parseable, NOT in refMap → expected orphan
const LIVE_OLD_REF = "skill:live";
const LIVE_ITEM_REF = "main//skill.live";
const ORPHAN_METADATA = '{"from":"skill:renamed-away","note":"load-bearing audit payload"}';

test("rekey orphan events: row CONTENT is deleted but an auditable legacy_state record survives (§11.4 policy)", () => {
  const statePath = getStateDbPathInDataDir();

  // ── Build a realistic pre-cutover state.db and seed one orphan + one live event.
  const seed = openStateDbAtCeiling(statePath, PRE_CUTOVER_STATE_CEILING);
  try {
    const ins = seed.prepare("INSERT INTO events (event_type, ts, ref, metadata_json) VALUES (?, ?, ?, ?)");
    ins.run("mv", "2026-01-01T00:00:00Z", ORPHAN_REF, ORPHAN_METADATA); // orphan (renamed-away asset)
    ins.run("show", "2026-01-02T00:00:00Z", LIVE_OLD_REF, "{}"); // resolvable → re-keyed
  } finally {
    seed.close();
  }

  // ── Run the cited re-key engine (opens, wraps a txn, runs rekeyStateDbCore).
  const refMap = new Map<string, string>([[LIVE_OLD_REF, LIVE_ITEM_REF]]);
  const report = rekeyStateDb(statePath, refMap);

  // ── Inspect the result.
  const db = new Database(statePath);
  try {
    const orphanRows = (
      db.query("SELECT COUNT(*) AS n FROM events WHERE ref = ?").get(ORPHAN_REF) as { n: number }
    ).n;
    const rekeyedRows = (
      db.query("SELECT COUNT(*) AS n FROM events WHERE ref = ?").get(LIVE_ITEM_REF) as { n: number }
    ).n;
    const audit = db
      .query("SELECT surface, old_ref, row_count, reason FROM legacy_state WHERE surface = 'events' AND old_ref = ?")
      .get(ORPHAN_REF) as { surface: string; old_ref: string; row_count: number; reason: string } | undefined;

    // (1) The candidate's mechanism is REAL: the orphan event ROW CONTENT is gone.
    expect(orphanRows).toBe(0);
    // The resolvable ref was re-keyed as expected (sanity: engine works).
    expect(rekeyedRows).toBe(1);

    // (2) THE GUARD that refutes "silently dropped": an auditable record exists.
    expect(audit).toBeDefined();
    expect(audit?.row_count).toBe(1);
    expect(audit?.reason).toBe("orphan");
    expect(report.quarantined.events).toBe(1);

    // (3) legacy_state is a COUNT archive BY DESIGN — its schema has no column
    // that could ever have held event_type/ts/metadata_json. Confirm the spec's
    // "with counts reported" shape (surface, old_ref, row_count, reason,
    // quarantined_at) — so keeping only a count is the intended contract, not an
    // accidental omission.
    const cols = (db.query("PRAGMA table_info(legacy_state)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols.sort()).toEqual(["old_ref", "quarantined_at", "reason", "row_count", "surface"]);
    expect(cols).not.toContain("metadata_json");

    // Sanity that the payload really is unrecoverable from the LIVE db (only the
    // pre-cutover backup still holds it — which is exactly the §11.4 design).
    const anyPayload = db
      .query("SELECT COUNT(*) AS n FROM events WHERE metadata_json = ?")
      .get(ORPHAN_METADATA) as { n: number };
    expect(anyPayload.n).toBe(0);
  } finally {
    db.close();
  }
});
