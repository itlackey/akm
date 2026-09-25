// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * R0: `akm health` never looked at state.db's own SQLite-level
 * integrity — the pre-existing `state-db-round-trip` check only proves one
 * row can be appended and read back, which stays true on a database that
 * fails `PRAGMA quick_check` elsewhere (out-of-order rowids, bad index entry
 * counts). `state-db-integrity` closes that gap and also reports the
 * freelist ratio (fraction of pages VACUUM could reclaim).
 *
 * The check is a pure projection of ctx.stateDbIntegrity / ctx.stateDbFreelist
 * (see health-active-runs-check.test.ts for the established pattern), so it
 * is driven directly with synthetic pragma results — no real database.
 */

import { describe, expect, test } from "bun:test";
import { HEALTH_CHECKS, type HealthCheckContext } from "../src/commands/health/checks";
import type { StateDbFreelistInfo, StateDbQuickCheckResult } from "../src/storage/state-db-integrity";

const check = HEALTH_CHECKS.find((c) => c.name === "state-db-integrity");

function run(stateDbIntegrity: StateDbQuickCheckResult, stateDbFreelist: StateDbFreelistInfo) {
  if (!check) throw new Error("state-db-integrity check not registered");
  return check.run({
    stateDbPath: "/tmp/state.db",
    stateDbIntegrity,
    stateDbFreelist,
  } as unknown as HealthCheckContext);
}

describe("state-db-integrity check (R0)", () => {
  test("is registered as a hard check", () => {
    expect(check).toBeDefined();
    expect(check?.channel).toBe("hard");
  });

  test("passes when quick_check reports ok and the freelist ratio is low", () => {
    const r = run({ ok: true, lines: ["ok"] }, { freelistCount: 10, pageCount: 1000, ratio: 0.01 });
    expect(r.status).toBe("pass");
    expect(r.message).toBe("state.db passed PRAGMA quick_check.");
    expect(r.evidence?.freelistRatio).toBe(0.01);
  });

  test("fails and names the repair when quick_check reports corruption", () => {
    const r = run(
      { ok: false, lines: ["rowid 42 out of order in table events", "wrong # of entries in index idx_events_ts"] },
      { freelistCount: 0, pageCount: 1000, ratio: 0 },
    );
    expect(r.status).toBe("fail");
    expect(r.message).toContain("rowid 42 out of order in table events");
    expect(r.message).toContain("wrong # of entries in index idx_events_ts");
    expect(r.message).toContain('sqlite3 state.db ".dump" | sqlite3 state.new.db');
    expect(r.evidence?.lines).toEqual([
      "rowid 42 out of order in table events",
      "wrong # of entries in index idx_events_ts",
    ]);
  });

  test("fails with the probe's own error when quick_check could not run at all", () => {
    const r = run(
      { ok: false, lines: [], error: "unable to open database file" },
      { freelistCount: 0, pageCount: 0, ratio: 0 },
    );
    expect(r.status).toBe("fail");
    expect(r.message).toContain("unable to open database file");
  });

  test("warns (not fails) when the freelist ratio exceeds 50%, even though quick_check is ok", () => {
    const r = run({ ok: true, lines: ["ok"] }, { freelistCount: 700, pageCount: 1000, ratio: 0.7 });
    expect(r.status).toBe("warn");
    expect(r.message).toContain("70.0%");
    expect(r.message).toContain("reclaimable by VACUUM");
    expect(r.evidence?.freelistCount).toBe(700);
    expect(r.evidence?.pageCount).toBe(1000);
  });

  test("passes exactly at the 50% boundary (warn is strictly above threshold)", () => {
    const r = run({ ok: true, lines: ["ok"] }, { freelistCount: 500, pageCount: 1000, ratio: 0.5 });
    expect(r.status).toBe("pass");
  });

  // A3: getStateDbFreelistInfo can fail independently of quick_check (e.g. the
  // read-only handle it opens itself hits an error the quick_check probe did
  // not). That must render as a failed check, not a thrown exception.
  test("fails with the freelist probe's own error when quick_check passed but the freelist read could not run", () => {
    const r = run(
      { ok: true, lines: ["ok"] },
      { freelistCount: 0, pageCount: 0, ratio: 0, error: "unable to open database file" },
    );
    expect(r.status).toBe("fail");
    expect(r.message).toContain("unable to open database file");
  });
});
