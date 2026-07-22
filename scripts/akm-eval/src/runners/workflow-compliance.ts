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
 *   - proposalQueueRespect — every in-scope `promoted` event must belong to a
 *                            current-stash proposal lifecycle that entered the
 *                            queue before promotion; unrelated first global
 *                            events are ignored.
 *   - forbiddenEventTypes — none of these may occur
 *
 * Skips cleanly when no events match the window (the events table is
 * empty or the window has zero hits) — this is the common case on a fresh
 * sandbox stash and is not a failure.
 */

import { makeStateDbSources, type EventRow, type ProposalRow } from "../sources/state-db";
import type { EvalCase, EvalCaseResult, EvalContext } from "../types";

const DEFAULT_QUEUE_EVENT_TYPES = ["reflect_completed", "propose_invoked"];

interface WorkflowExpected {
  requiredEventTypes?: string[];
  minEventsOfType?: Record<string, number>;
  maxEventsOfType?: Record<string, number>;
  requiredOrder?: string[];
  forbiddenEventTypes?: string[];
  proposalQueueRespect?: boolean | { queueEventTypes?: string[]; promotedEventType?: string };
}

interface CheckResult {
  name: string;
  ok: boolean;
  detail: unknown;
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
  let proposals: ProposalRow[] = [];
  try {
    events = stateDb.readEvents({ since, until, refs });
    if (expected.proposalQueueRespect) {
      proposals = stateDb.readProposals({ stashDir: ctx.stashRoot, since });
    }
  } catch (err) {
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

  const checks: CheckResult[] = [];
  let skipReason: string | undefined;

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
      const a = expected.requiredOrder[i]!;
      const b = expected.requiredOrder[i + 1]!;
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
  if (expected.proposalQueueRespect) {
    const result = checkProposalQueueRespect({
      events,
      proposals,
      refs,
      until,
      spec: expected.proposalQueueRespect,
    });
    checks.push(result.check);
    skipReason = result.skipReason;
  }

  const passThreshold = c.scoring?.passThreshold ?? 0.8;
  const score = checks.length === 0 ? 1 : checks.filter((c) => c.ok).length / checks.length;

  return {
    caseId: c.id,
    type: "workflow-compliance",
    score,
    passed: score >= passThreshold,
    ...(skipReason && checks.length === 1 ? { skipped: true, skipReason } : {}),
    metrics: { eventCount: events.length, counts, checks: checks.map((c) => ({ name: c.name, ok: c.ok })) },
    evidence: { windowSince: since, windowUntil: until, refs, checks },
    durationMs: Date.now() - start,
  };
}

function checkProposalQueueRespect(opts: {
  events: EventRow[];
  proposals: ProposalRow[];
  refs?: string[];
  until?: string;
  spec: WorkflowExpected["proposalQueueRespect"];
}): { check: CheckResult; skipReason?: string } {
  const refSet = opts.refs && opts.refs.length > 0 ? new Set(opts.refs) : undefined;
  const scopedProposals = opts.proposals.filter((p) => {
    if (opts.until && p.createdAt > opts.until) return false;
    if (refSet && !refSet.has(p.ref)) return false;
    return true;
  });
  const proposalsById = new Map(scopedProposals.map((p) => [p.id, p]));
  const promotedEventType = typeof opts.spec === "object" ? (opts.spec.promotedEventType ?? "promoted") : "promoted";
  const queueEventTypes = new Set(
    typeof opts.spec === "object" ? (opts.spec.queueEventTypes ?? DEFAULT_QUEUE_EVENT_TYPES) : DEFAULT_QUEUE_EVENT_TYPES,
  );

  const promotedEvents = opts.events.filter((e) => e.eventType === promotedEventType);
  const ignoredPromotions: Array<{ eventId: number; proposalId?: string; ref?: string; reason: string }> = [];
  const violations: Array<{ eventId: number; proposalId: string; ref: string; reason: string }> = [];
  let scopedPromotionCount = 0;

  for (const promoted of promotedEvents) {
    const proposalId = metadataString(promoted, "proposalId");
    if (!proposalId) {
      ignoredPromotions.push({
        eventId: promoted.id,
        ref: promoted.ref,
        reason: "promoted event has no proposalId metadata",
      });
      continue;
    }

    const proposal = proposalsById.get(proposalId);
    if (!proposal) {
      ignoredPromotions.push({
        eventId: promoted.id,
        proposalId,
        ref: promoted.ref,
        reason: "proposal is outside the current stash/window/ref scope",
      });
      continue;
    }

    scopedPromotionCount += 1;
    if (proposal.createdAt <= promoted.ts || hasQueueEventBeforePromotion(opts.events, promoted, proposal, queueEventTypes)) {
      continue;
    }

    violations.push({
      eventId: promoted.id,
      proposalId,
      ref: proposal.ref,
      reason: `promotion at ${promoted.ts} precedes proposal queue entry at ${proposal.createdAt}`,
    });
  }

  const detail = {
    scopedProposalCount: scopedProposals.length,
    scopedPromotionCount,
    ignoredPromotionCount: ignoredPromotions.length,
    sampleIgnoredPromotions: ignoredPromotions.slice(0, 5),
    violations,
  };
  const skipReason = scopedProposals.length === 0 ? "no current-stash proposal lifecycle in window" : undefined;
  return {
    check: { name: "proposalQueueRespect", ok: violations.length === 0, detail },
    skipReason,
  };
}

function hasQueueEventBeforePromotion(
  events: EventRow[],
  promoted: EventRow,
  proposal: ProposalRow,
  queueEventTypes: Set<string>,
): boolean {
  return events.some((event) => {
    if (!queueEventTypes.has(event.eventType) || event.id >= promoted.id) return false;
    const eventProposalId = metadataString(event, "proposalId");
    if (eventProposalId) return eventProposalId === proposal.id;
    if (event.eventType === "propose_invoked") return event.ref === proposal.ref && proposal.source === "propose";
    return false;
  });
}

function metadataString(event: EventRow, key: string): string | undefined {
  const value = event.metadata[key];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
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
