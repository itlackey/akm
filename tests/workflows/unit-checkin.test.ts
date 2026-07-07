// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import type { WorkflowRunUnitRow } from "../../src/storage/repositories/workflow-runs-repository";
import { evaluateStaleUnits, UNIT_STALE_MS } from "../../src/workflows/runtime/unit-checkin";

/**
 * Pure unit-level stale evaluator (R3 driver protocol). Deterministic in `now`,
 * so it is unit-testable without timers: a `running` dispatch unit whose last
 * heartbeat (else first claim) is older than the window is surfaced; gate rows
 * and terminal units never are.
 */

function unitRow(over: Partial<WorkflowRunUnitRow>): WorkflowRunUnitRow {
  return {
    run_id: "r",
    unit_id: "n:solo",
    step_id: "s",
    node_id: "n",
    parent_unit_id: null,
    phase: null,
    runner: "sdk",
    model: null,
    status: "running",
    input_hash: null,
    result_json: null,
    tokens: null,
    failure_reason: null,
    session_id: null,
    worktree_path: null,
    started_at: null,
    finished_at: null,
    last_checkin_at: null,
    attempts: 1,
    claim_holder: null,
    claim_expires_at: null,
    ...over,
  };
}

const NOW = Date.parse("2026-07-07T12:00:00.000Z");
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

describe("evaluateStaleUnits", () => {
  test("flags a running unit whose last heartbeat is older than the window", () => {
    const rows = [unitRow({ unit_id: "a", last_checkin_at: iso(UNIT_STALE_MS + 1_000) })];
    const stale = evaluateStaleUnits(rows, NOW);
    expect(stale).toHaveLength(1);
    expect(stale[0].unitId).toBe("a");
    expect(stale[0].idleMs).toBeGreaterThanOrEqual(UNIT_STALE_MS);
  });

  test("a fresh heartbeat inside the window is NOT stale", () => {
    const rows = [unitRow({ unit_id: "a", last_checkin_at: iso(1_000) })];
    expect(evaluateStaleUnits(rows, NOW)).toHaveLength(0);
  });

  test("falls back to started_at when never heartbeated", () => {
    const rows = [unitRow({ unit_id: "a", started_at: iso(UNIT_STALE_MS + 5_000), last_checkin_at: null })];
    const stale = evaluateStaleUnits(rows, NOW);
    expect(stale).toHaveLength(1);
    expect(stale[0].lastSeenAt).toBe(iso(UNIT_STALE_MS + 5_000));
  });

  test("a heartbeat advances the window past an old claim (started_at ignored when a heartbeat exists)", () => {
    const rows = [unitRow({ unit_id: "a", started_at: iso(10 * UNIT_STALE_MS), last_checkin_at: iso(1_000) })];
    expect(evaluateStaleUnits(rows, NOW)).toHaveLength(0);
  });

  test("terminal units are never stale", () => {
    const rows = [
      unitRow({ unit_id: "a", status: "completed", started_at: iso(10 * UNIT_STALE_MS) }),
      unitRow({ unit_id: "b", status: "failed", started_at: iso(10 * UNIT_STALE_MS) }),
    ];
    expect(evaluateStaleUnits(rows, NOW)).toHaveLength(0);
  });

  test("gate-evaluation rows (phase=gate) are excluded", () => {
    const rows = [unitRow({ unit_id: "s.gate:l1", phase: "gate", started_at: iso(10 * UNIT_STALE_MS) })];
    expect(evaluateStaleUnits(rows, NOW)).toHaveLength(0);
  });

  test("a running unit with no timestamp at all is treated as stale", () => {
    const rows = [unitRow({ unit_id: "a", started_at: null, last_checkin_at: null })];
    const stale = evaluateStaleUnits(rows, NOW);
    expect(stale).toHaveLength(1);
    expect(stale[0].idleMs).toBe(Number.POSITIVE_INFINITY);
  });
});
