// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Agent check-in: a no-background-thread "continue" nudge for stalled workflow
 * runs (#506).
 *
 * The design decision (the workflow-agent check-in ADR)
 * reconciles #506 (file/command-loop signal) with #501 (background thread) in
 * favour of the former. There is intentionally NO timer or resident process
 * here. Arming a check-in writes a timestamp (`checkin_armed_at`) on the run
 * row; the next time the agent polls the engine via `workflow next`/`status`,
 * {@link evaluateCheckin} is called to decide — purely from timestamps — whether
 * the run looks stalled and a strong `continue` directive should be surfaced
 * through the normal command output.
 *
 * @module workflows/checkin
 */

/**
 * Default stall window. If a run has been active and untouched for at least
 * this long since the later of its last update and its armed timestamp, the
 * next poll surfaces a check-in directive.
 */
export const CHECKIN_STALL_MS = 90_000;

/** Minimal run shape needed to evaluate a check-in — decoupled from the DB row. */
export interface CheckinRunState {
  status: string;
  /** ISO timestamp of the run's last state change. */
  updatedAt: string;
  /** ISO timestamp the check-in was armed at, or null when never armed. */
  checkinArmedAt: string | null;
  /** Agent harness identifier recorded on the run, when known. */
  agentHarness?: string | null;
  /** Platform session id recorded on the run, when known. */
  agentSessionId?: string | null;
}

/**
 * Structured check-in directive surfaced through the normal workflow command
 * output when a run looks stalled. Absent when the run is healthy.
 */
export interface CheckinDirective {
  signal: "continue";
  /** Strong, unambiguous directive text for the agent. */
  directive: string;
  /** How long (ms) the run had been idle when the directive fired. */
  idleMs: number;
  agentHarness?: string | null;
  agentSessionId?: string | null;
}

function parseIso(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Pure check-in evaluator. Returns a `continue` directive when an *active* run
 * has been idle past the stall window, otherwise `null`. Deterministic in
 * `now`, so it is trivially unit-testable and free of timer flakiness.
 */
export function evaluateCheckin(
  run: CheckinRunState,
  now: number = Date.now(),
  stallMs: number = CHECKIN_STALL_MS,
): CheckinDirective | null {
  if (run.status !== "active") return null;
  const updated = parseIso(run.updatedAt);
  const armed = parseIso(run.checkinArmedAt);
  // Never armed → no check-in (opt-in per run via startWorkflowRun).
  if (armed === null) return null;
  const last = Math.max(updated ?? armed, armed);
  const idleMs = now - last;
  if (idleMs < stallMs) return null;
  return {
    signal: "continue",
    directive:
      "CONTINUE: this workflow run has stalled with no progress. Resume immediately — " +
      "re-read the current step's instructions, finish the outstanding work, then call " +
      "`akm workflow complete` with a summary. Do not stop until the step is complete.",
    idleMs,
    agentHarness: run.agentHarness ?? null,
    agentSessionId: run.agentSessionId ?? null,
  };
}
