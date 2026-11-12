// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * What the single-run views say about a run, from records akm already returns. Nothing is derived beyond reading:
 * an outcome is only what the record says, a run with no recorded end is unknown (never succeeded), and a record
 * matched to a run by time is marked as such.
 */

import type { ActivityRun, ActivityTaskRun, WorkflowTrace } from "./activity-types";

/** `terminated` is a run stopped from outside. No record Desktop reads says so yet, so nothing returns it today. */
export type Outcome = "completed" | "failed" | "terminated" | "unknown";
export const OUTCOMES: Outcome[] = ["completed", "failed", "terminated", "unknown"];
export const OUTCOME_LABEL: Record<Outcome, string> = {
  completed: "Completed",
  failed: "Failed",
  terminated: "Terminated",
  unknown: "Unknown",
};

/** One kind of run and how its recorded runs ended, for the summary above the timeline. */
export type OutcomeRow = { label: string; counts: Record<Outcome, number>; failed?: string[]; note?: string };

/** A task or workflow run's recorded status. `blocked` and `active` have no end recorded, so they are unknown. */
export function statusOutcome(status: string): Outcome {
  return status === "completed" ? "completed" : status === "failed" ? "failed" : "unknown";
}
/** An improve run's recorded `ok`: absent means no outcome was recorded. */
export function improveOutcome(run: Pick<ActivityRun, "ok">): Outcome {
  return run.ok === true ? "completed" : run.ok === false ? "failed" : "unknown";
}

/** What akm's health report matches an improve run to: a scheduled task named `improve` or `akm-improve*`, ±5 min. */
export const MATCH_WINDOW_MS = 5 * 60_000;
const launchesImprove = (taskId: string) => taskId === "improve" || taskId.startsWith("akm-improve");

/**
 * The scheduled task runs that started within five minutes of an improve run. No improve record carries a task run
 * id, so this is a match by time and the view says so; more than one match is shown as more than one.
 */
export function tasksAroundImprove(run: Pick<ActivityRun, "startedAt">, taskRuns: ActivityTaskRun[]) {
  const at = Date.parse(run.startedAt);
  return taskRuns.filter(
    (task) => launchesImprove(task.taskId) && Math.abs(Date.parse(task.startedAt) - at) <= MATCH_WINDOW_MS,
  );
}
/** The improve runs a scheduled task run could have started: the same match, from the other side. */
export function improveAroundTask(task: Pick<ActivityTaskRun, "taskId" | "startedAt">, runs: ActivityRun[]) {
  if (!launchesImprove(task.taskId)) return [];
  const at = Date.parse(task.startedAt);
  return runs.filter((run) => Math.abs(Date.parse(run.startedAt) - at) <= MATCH_WINDOW_MS);
}

/** A failed attempt, in the order they happened. `at` is when it ended, or began when no end was recorded. */
export type AttemptFailure = {
  at: string;
  unit: string;
  step: string;
  attempt: number;
  reason: string | null;
  engine: string | null;
};
export type EngineUsage = { engine: string; attempts: number; failed: number; tokens: number; unreported: number };

/**
 * What went wrong in a workflow run and what it used. Tokens are summed from each attempt, and an attempt that
 * reported none is counted as unreported rather than as zero. A run that failed with no failed unit is flagged: it
 * may have been abandoned or stopped, which akm records as `failed` too.
 */
export function workflowFacts(trace: WorkflowTrace) {
  const stepTitle = new Map(trace.steps.map((step) => [step.id, step.title || step.id]));
  const failures: AttemptFailure[] = [];
  const engines = new Map<string, EngineUsage>();
  for (const unit of trace.units) {
    // A unit with no attempts recorded (an older run) stands for its one attempt.
    const attempts = unit.attempts.length
      ? unit.attempts
      : [
          {
            attempt: 1,
            status: unit.status,
            startedAt: unit.startedAt ?? "",
            finishedAt: unit.finishedAt,
            tokens: unit.tokens,
            failureReason: unit.failureReason,
          },
        ];
    const engine = unit.engine ?? "Not recorded";
    const usage = engines.get(engine) ?? { engine, attempts: 0, failed: 0, tokens: 0, unreported: 0 };
    for (const attempt of attempts) {
      usage.attempts++;
      if (attempt.tokens == null) usage.unreported++;
      else usage.tokens += attempt.tokens;
      if (attempt.status === "failed") {
        usage.failed++;
        failures.push({
          at: attempt.finishedAt ?? attempt.startedAt,
          unit: unit.unitId,
          step: stepTitle.get(unit.stepId ?? "") ?? "No step",
          attempt: attempt.attempt,
          reason: attempt.failureReason ?? unit.failureReason,
          engine: unit.engine,
        });
      }
    }
    engines.set(engine, usage);
  }
  failures.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return {
    failures,
    engines: [...engines.values()].sort((a, b) => b.tokens - a.tokens || a.engine.localeCompare(b.engine)),
    failedWithoutFailedUnit: trace.run.status === "failed" && failures.length === 0,
  };
}

/** Counts of each outcome, for the summary above the timeline. */
export function outcomeCounts(outcomes: Outcome[]): Record<Outcome, number> {
  const counts: Record<Outcome, number> = { completed: 0, failed: 0, terminated: 0, unknown: 0 };
  for (const outcome of outcomes) counts[outcome]++;
  return counts;
}
