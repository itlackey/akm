/**
 * Workflow-compliance runner — verifies command-trace event patterns.
 *
 * Reads events from state.db via `StateDbSources.readEvents`. Each declared
 * expectation block contributes one unit to the score; the default pass
 * threshold is 0.8.
 *
 * Inputs:  { windowSince?: string; windowUntil?: string; refs?: string[] }
 * Expected:
 *   - requiredEventTypes  — every type must occur ≥1 time
 *   - minEventsOfType     — type → minimum count
 *   - maxEventsOfType     — type → maximum count
 *   - requiredOrder       — first occurrence of type[i+1] must be strictly
 *                            after first occurrence of type[i]
 *   - forbiddenEventTypes — none of these may occur
 *
 * Skips cleanly when no events match the window (the events table is
 * empty or the window has zero hits) — this is the common case on a fresh
 * sandbox stash and is not a failure.
 */

import { makeStateDbSources, type EventRow } from "../sources/state-db";
import type { EvalCase, EvalCaseResult, EvalContext } from "../types";

interface WorkflowExpected {
  requiredEventTypes?: string[];
  minEventsOfType?: Record<string, number>;
  maxEventsOfType?: Record<string, number>;
  requiredOrder?: string[];
  forbiddenEventTypes?: string[];
}

export async function runWorkflowComplianceCase(c: EvalCase, ctx: EvalContext): Promise<EvalCaseResult> {
  const start = Date.now();
  const since = c.input.windowSince as string | undefined;
  const until = c.input.windowUntil as string | undefined;
  const refs = Array.isArray(c.input.refs) ? (c.input.refs as string[]) : undefined;
  const expected = c.expected as WorkflowExpected;

  const stateDb = makeStateDbSources({ dbPath: `${ctx.dataDir}/state.db`, record: ctx.recording });
  if (!stateDb.available()) {
    return {
      caseId: c.id,
      type: "workflow-compliance",
      score: 1,
      passed: true,
      skipped: true,
      skipReason: "state.db not available",
      metrics: {},
      evidence: { dataDir: ctx.dataDir },
      durationMs: Date.now() - start,
    };
  }

  let events: EventRow[];
  try {
    events = stateDb.readEvents({ since, until, refs });
  } catch (err) {
    stateDb.close();
    return errorResult(c, err instanceof Error ? err.message : String(err), start);
  } finally {
    stateDb.close();
  }

  if (events.length === 0) {
    return {
      caseId: c.id,
      type: "workflow-compliance",
      score: 1,
      passed: true,
      skipped: true,
      skipReason: "no events in window",
      metrics: { eventCount: 0 },
      evidence: { windowSince: since, windowUntil: until, refs },
      durationMs: Date.now() - start,
    };
  }

  const counts: Record<string, number> = {};
  const firstSeen: Record<string, number> = {};
  for (const e of events) {
    counts[e.eventType] = (counts[e.eventType] ?? 0) + 1;
    if (firstSeen[e.eventType] === undefined) firstSeen[e.eventType] = e.id;
  }

  const checks: Array<{ name: string; ok: boolean; detail: unknown }> = [];

  if (expected.requiredEventTypes && expected.requiredEventTypes.length > 0) {
    const missing = expected.requiredEventTypes.filter((t) => (counts[t] ?? 0) === 0);
    checks.push({ name: "requiredEventTypes", ok: missing.length === 0, detail: { missing } });
  }
  if (expected.minEventsOfType && Object.keys(expected.minEventsOfType).length > 0) {
    const violations = Object.entries(expected.minEventsOfType)
      .filter(([t, n]) => (counts[t] ?? 0) < n)
      .map(([t, n]) => ({ type: t, required: n, observed: counts[t] ?? 0 }));
    checks.push({ name: "minEventsOfType", ok: violations.length === 0, detail: violations });
  }
  if (expected.maxEventsOfType && Object.keys(expected.maxEventsOfType).length > 0) {
    const violations = Object.entries(expected.maxEventsOfType)
      .filter(([t, n]) => (counts[t] ?? 0) > n)
      .map(([t, n]) => ({ type: t, max: n, observed: counts[t] ?? 0 }));
    checks.push({ name: "maxEventsOfType", ok: violations.length === 0, detail: violations });
  }
  if (expected.requiredOrder && expected.requiredOrder.length > 1) {
    const violations: Array<{ before: string; after: string; reason: string }> = [];
    for (let i = 0; i < expected.requiredOrder.length - 1; i++) {
      const a = expected.requiredOrder[i];
      const b = expected.requiredOrder[i + 1];
      const seenA = firstSeen[a];
      const seenB = firstSeen[b];
      if (seenA === undefined) violations.push({ before: a, after: b, reason: `${a} never occurred` });
      else if (seenB === undefined) violations.push({ before: a, after: b, reason: `${b} never occurred` });
      else if (seenB <= seenA) violations.push({ before: a, after: b, reason: `${b} (#${seenB}) not strictly after ${a} (#${seenA})` });
    }
    checks.push({ name: "requiredOrder", ok: violations.length === 0, detail: violations });
  }
  if (expected.forbiddenEventTypes && expected.forbiddenEventTypes.length > 0) {
    const present = expected.forbiddenEventTypes.filter((t) => (counts[t] ?? 0) > 0);
    checks.push({ name: "forbiddenEventTypes", ok: present.length === 0, detail: { present } });
  }

  const passThreshold = c.scoring?.passThreshold ?? 0.8;
  const score = checks.length === 0 ? 1 : checks.filter((c) => c.ok).length / checks.length;

  return {
    caseId: c.id,
    type: "workflow-compliance",
    score,
    passed: score >= passThreshold,
    metrics: { eventCount: events.length, counts, checks: checks.map((c) => ({ name: c.name, ok: c.ok })) },
    evidence: { windowSince: since, windowUntil: until, refs, checks },
    durationMs: Date.now() - start,
  };
}

function errorResult(c: EvalCase, message: string, start: number): EvalCaseResult {
  return {
    caseId: c.id,
    type: "workflow-compliance",
    score: 0,
    passed: false,
    metrics: {},
    evidence: {},
    errors: [message],
    durationMs: Date.now() - start,
  };
}
