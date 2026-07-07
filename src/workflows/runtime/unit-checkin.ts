// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Unit-level check-in: a no-background-thread staleness evaluator for units a
 * driver claimed via `akm workflow report --status running` (redesign addendum
 * R3, harness-neutral driver protocol).
 *
 * Mirrors the run-level {@link ../runtime/checkin} design exactly: there is NO
 * timer or resident process. A driver executing a unit stamps `last_checkin_at`
 * (heartbeat) on the unit row; `workflow brief`/`status` then call the pure
 * {@link evaluateStaleUnits} to decide — from timestamps alone — which claimed
 * units have gone silent past a window, so a stalled driver surfaces without any
 * monitoring daemon. Deterministic in `now`, so it is trivially unit-testable.
 *
 * @module workflows/unit-checkin
 */

import type { WorkflowRunUnitRow } from "../../storage/repositories/workflow-runs-repository";
import { GATE_EVALUATION_PHASE } from "../exec/step-work";

/**
 * Default staleness window. A unit claimed `running` whose last heartbeat (or,
 * absent any heartbeat, its first claim) is older than this is surfaced as
 * stale. Matches the run-level {@link ../runtime/checkin.CHECKIN_STALL_MS}.
 */
export const UNIT_STALE_MS = 90_000;

/** A claimed unit that has gone silent past the staleness window. */
export interface StaleUnit {
  unitId: string;
  stepId: string | null;
  /** How long (ms) since the last heartbeat / first claim when evaluated. */
  idleMs: number;
  /** The heartbeat timestamp used (falls back to `started_at` when never heartbeated). */
  lastSeenAt: string | null;
}

function parseIso(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Pure stale-unit evaluator. Returns every `running` DISPATCH unit whose last
 * heartbeat (`last_checkin_at`, else the first-claim `started_at`) is older than
 * `staleMs`. Gate-evaluation rows (`phase = "gate"`) are excluded — they are
 * synchronous engine judge calls, never driver-claimed work. A running row with
 * no usable timestamp at all is treated as stale (a claim we can no longer age).
 * Deterministic in `now` — free of timer flakiness.
 */
export function evaluateStaleUnits(
  rows: WorkflowRunUnitRow[],
  now: number = Date.now(),
  staleMs: number = UNIT_STALE_MS,
): StaleUnit[] {
  const stale: StaleUnit[] = [];
  for (const row of rows) {
    if (row.status !== "running") continue;
    if (row.phase === GATE_EVALUATION_PHASE) continue;
    const lastSeenAt = row.last_checkin_at ?? row.started_at;
    const lastSeen = parseIso(lastSeenAt);
    const idleMs = lastSeen === null ? Number.POSITIVE_INFINITY : now - lastSeen;
    if (idleMs < staleMs) continue;
    stale.push({
      unitId: row.unit_id,
      stepId: row.step_id,
      idleMs,
      lastSeenAt: lastSeenAt ?? null,
    });
  }
  return stale;
}
