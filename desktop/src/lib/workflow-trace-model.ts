// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** One workflow run as rows on a clock: a band per step, then a row per unit with a bar per attempt. */

import type { WorkflowTrace } from "./activity-types";

type Unit = WorkflowTrace["units"][number];
export type TraceBar = { from: number; to: number; cls: "ok" | "fail" | "running" | "gate" | "other"; title: string };
export type TraceRow =
  | { kind: "step"; label: string }
  | { kind: "unit"; label: string; status: string; unit: Unit; attempts: TraceBar[] };

/**
 * The rows of a trace, and the clock they share. A step's span and status come from its units: akm records no start
 * time for a step. An attempt still running ends at `now`.
 */
export function traceRows(trace: WorkflowTrace, now = Date.now()) {
  const time = (value: string | null | undefined) => (value ? Date.parse(value) : Number.NaN);
  const starts: number[] = [];
  const ends: number[] = [];
  const rows: TraceRow[] = [];
  const order = [...trace.steps].sort((a, b) => (a.sequenceIndex ?? 0) - (b.sequenceIndex ?? 0));
  const known = new Set(order.map((step) => step.id));
  const steps = order.map((step) => {
    const units = trace.units.filter((unit) => unit.stepId === step.id);
    return { step, units };
  });
  const loose = trace.units.filter((unit) => !unit.stepId || !known.has(unit.stepId));
  if (loose.length)
    steps.push({
      step: { id: "", title: "Other units", status: "", sequenceIndex: null, completedAt: null },
      units: loose,
    });
  let tokens = 0;
  let done = 0;
  const summary = steps.map(({ step, units }) => {
    rows.push({ kind: "step", label: step.title || step.id });
    let first = Number.POSITIVE_INFINITY;
    let last = Number.NEGATIVE_INFINITY;
    for (const unit of units) {
      tokens += unit.tokens ?? 0;
      if (unit.status === "completed" || unit.status === "failed") done++;
      const attempts: TraceBar[] = (
        unit.attempts.length
          ? unit.attempts
          : [
              {
                attempt: 1,
                phase: unit.phase ?? "unit",
                status: unit.status,
                startedAt: unit.startedAt ?? "",
                finishedAt: unit.finishedAt,
                tokens: unit.tokens,
                failureReason: unit.failureReason,
              },
            ]
      ).flatMap((attempt) => {
        const from = time(attempt.startedAt);
        if (!Number.isFinite(from)) return [];
        const finished = time(attempt.finishedAt);
        const to = Number.isFinite(finished) ? finished : now;
        first = Math.min(first, from);
        last = Math.max(last, to);
        starts.push(from);
        ends.push(to);
        const cls =
          attempt.status === "failed"
            ? "fail"
            : attempt.status === "running"
              ? "running"
              : attempt.status === "completed"
                ? attempt.phase === "gate"
                  ? "gate"
                  : "ok"
                : "other";
        return [
          {
            from,
            to,
            cls,
            title: `${unit.unitId} · attempt ${attempt.attempt} · ${attempt.status}${attempt.failureReason ? ` · ${attempt.failureReason}` : ""}`,
          } as TraceBar,
        ];
      });
      rows.push({
        kind: "unit",
        label: unit.phase === "gate" ? `${unit.unitId} · gate` : unit.unitId,
        status: unit.status,
        unit,
        attempts,
      });
    }
    return {
      title: step.title || step.id,
      status: step.status || (units.some((u) => u.status === "running") ? "running" : "completed"),
      units: units.length,
      failed: units.filter((unit) => unit.status === "failed").length,
      span: Number.isFinite(first) && Number.isFinite(last) ? last - first : null,
    };
  });
  const start = starts.length ? Math.min(...starts) : time(trace.run.createdAt) || now;
  const end = Math.max(start + 1000, ends.length ? Math.max(...ends) : now);
  return { rows, steps: summary, start, end, tokens, done, units: trace.units.length };
}
