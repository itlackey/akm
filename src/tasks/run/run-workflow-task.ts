// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The workflow dispatch arm: `runWorkflowTask`, `mapWorkflowStatus`,
 * `renderWorkflowLog`, plus the shared unattended-timeout defaults
 * (`DEFAULT_WORKFLOW_TASK_TIMEOUT_MS`, `DEFAULT_SCHEDULED_TASK_TIMEOUT_MS`)
 * every arm reads.
 *
 * Moved from src/tasks/runner.ts (spec docs/plans/specs/p1b-model-extraction.md
 * §5.1, §9, runner.ts:456-675).
 *
 * F-1 (spec §5.2 point 2): the global `process.env.AKM_EVENT_SOURCE` stamp
 * and its `finally` restore are DELETED outright — `process.env` is never
 * written by this arm any more. The resolved event source is instead passed
 * into `runWorkflowStepsImpl` via a new optional `eventSource` option,
 * `process.env.AKM_EVENT_SOURCE ?? provenance.eventSource` (ambient still
 * wins, matching the native arm's own precedence — D5 clause d). Threading
 * that option to an exec-unit child's env is owned by
 * src/workflows/exec/run-workflow.ts / step-work.ts / exec-unit.ts, not this
 * file.
 */

import { armAbortDeadline } from "../../core/abort-deadline";
import { assertNever } from "../../core/assert";
import { AkmError } from "../../core/errors";
import type { TaskLogLineInput } from "../../core/logs-db";
import type { WorkflowRunStatus, WorkflowRunSummary } from "../../sources/types";
import type { runWorkflowSteps } from "../../workflows/exec/run-workflow";
import type { ExecutionProvenanceContext } from "../model/invocation";
import type { PreparedTaskV3Workflow } from "../prepare/prepared-execution";
import { finishAttempt } from "./attempt-lifecycle";
import { appendHistory } from "./task-history";
import { persistRunLog, scrubTaskOutput } from "./task-log";
import type { TaskRunResult, TaskRunStatus } from "./task-result";

/**
 * Whole-run timeout applied to a workflow-bound task that does not declare its
 * own `timeoutMs` — six hours.
 *
 * `akm workflow run` deliberately has NO default `--timeout`: a human is
 * watching, and Ctrl-C aborts the very same signal the flag's timer would.
 * A scheduled task has nobody watching. Without a default, its only bound is
 * the per-unit timeout — and a frozen plan may set `timeout: null` (unbounded),
 * so one wedged agent unit hangs the run until the machine reboots, holding the
 * run lease and silently skipping every later firing (issue 11).
 *
 * Six hours is deliberately generous rather than tight: the abort is graceful
 * (the engine breaks at the next step boundary and the run stays resumable), so
 * the cost of over-waiting is bounded while the cost of cutting a legitimate
 * long run short is a lost step. It matches the 6h idle window `akm health`
 * already uses to call a run stale (`commands/health/report-view-model.ts`),
 * and it lands well inside a `@daily` cadence, so a wedged run can never still
 * be holding the lease when the next day's firing arrives.
 *
 * An explicit `timeoutMs:` in the task file always wins; `timeoutMs: null` is
 * the explicit opt-out back to unbounded.
 */
export const DEFAULT_WORKFLOW_TASK_TIMEOUT_MS = 6 * 60 * 60 * 1000;

/**
 * The same unattended default for command and prompt tasks.
 *
 * The reasoning above is about SCHEDULED runs, not about workflows: nobody is
 * watching, and one wedged run silently stops the schedule. Command tasks
 * defaulted to `null` (no kill timer) and prompt tasks inherited
 * DEFAULT_AGENT_TIMEOUT_MS, also null — so a hung `curl`, a prompting agent
 * waiting on stdin, or a stuck engine wedged the task forever while the
 * workflow arm was protected. Same value, same opt-out: an explicit
 * `timeoutMs:` wins, and `timeoutMs: null` restores unbounded.
 */
export const DEFAULT_SCHEDULED_TASK_TIMEOUT_MS = DEFAULT_WORKFLOW_TASK_TIMEOUT_MS;

export async function runWorkflowTask(input: {
  task: PreparedTaskV3Workflow;
  logPath: string;
  startedAt: Date;
  now: () => Date;
  runWorkflowStepsImpl: typeof runWorkflowSteps;
  historyReserved: boolean;
  provenance: ExecutionProvenanceContext;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}): Promise<TaskRunResult> {
  const { task, logPath, startedAt, now, runWorkflowStepsImpl, historyReserved, provenance } = input;

  // Unset → the unattended default; `null` → the explicit no-timeout opt-out.
  const timeoutMs = task.timeoutMs === undefined ? DEFAULT_WORKFLOW_TASK_TIMEOUT_MS : task.timeoutMs;
  // The shared deadline `akm workflow run --timeout` also arms
  // ({@link armAbortDeadline}): one AbortController for the run's lifetime,
  // aborted by a timer. The engine reads `options.signal` at every step
  // boundary and breaks GRACEFULLY — in-flight units are cancelled, the journal
  // and the run lease are retained, and the run is left `active`, i.e.
  // resumable with `akm workflow resume`.
  const controller = new AbortController();
  const deadline = armAbortDeadline(controller, {
    timeoutMs,
    reason: `Workflow task "${task.taskId}" timed out after ${timeoutMs}ms.`,
    ...(input.setTimeoutFn ? { setTimeoutFn: input.setTimeoutFn } : {}),
    ...(input.clearTimeoutFn ? { clearTimeoutFn: input.clearTimeoutFn } : {}),
  });

  let detail: WorkflowRunSummary | undefined;
  let gateError: string | undefined;
  let error: Error | undefined;
  // The prompt path logs the engine-fallback announcement; a workflow-backed
  // task must leave the same trace rather than silently using a chosen engine.
  let runWarnings: string[] = [];
  // F-1 (D5, spec §5.2 point 2): thread the resolved event source through
  // explicitly instead of stamping process.env — this arm executes IN-PROCESS,
  // so a global stamp used to be how child akm invocations made by workflow
  // steps inherited it; the explicit eventSource option (threaded to
  // src/workflows/exec/run-workflow.ts -> step-work.ts -> exec-unit.ts's
  // childEnv) now does that job without ever mutating process.env. A more
  // specific ambient stamp already present still wins, matching the native arm.
  const eventSource = process.env.AKM_EVENT_SOURCE ?? provenance.eventSource;
  try {
    const execution = await runWorkflowStepsImpl({
      target: task.ref,
      params: task.params,
      signal: controller.signal,
      eventSource,
      ...(task.maxSteps !== undefined ? { maxSteps: task.maxSteps } : {}),
      ...(task.maxRetries !== undefined ? { maxRetries: task.maxRetries } : {}),
    });
    detail = execution.run;
    runWarnings = execution.warnings ?? [];
    if (execution.gateRejection) {
      gateError = `Verification rejected step "${execution.gateRejection.stepId}": ${execution.gateRejection.feedback}`;
    }
  } catch (e) {
    if (e instanceof AkmError && e.kind === "config") throw e;
    error = e instanceof Error ? e : new Error(String(e));
  } finally {
    deadline.disarm();
  }

  // A timeout is a failed ATTEMPT even though the engine stopped cleanly: the
  // aborted run comes back `active` (resumable), which on its own would map to
  // task status "active" and a 0 exit code, telling the OS scheduler nothing
  // went wrong. Surface it like the command target's `timed_out=true` instead.
  //
  // Unless the run COMPLETED anyway. The abort is observed between steps, so a
  // deadline landing in the run's final bookkeeping can set the flag on a run
  // that then finishes — and reporting that as a failure would tell an operator
  // to resume a run with nothing left to resume.
  const ranToCompletion = detail?.status === "completed";
  const timedOutAfterMs = deadline.timedOut() && timeoutMs !== null && !ranToCompletion ? timeoutMs : undefined;
  const timeoutError =
    timedOutAfterMs === undefined
      ? undefined
      : new Error(
          `Workflow run timed out after ${timedOutAfterMs}ms and was aborted at a step boundary` +
            (detail?.id ? ` — resume it with \`akm workflow resume ${detail.id}\`.` : "."),
        );

  // One failure value for the three sinks below (status, log line, history
  // detail): a thrown error outranks a gate rejection, which outranks the
  // deadline. Re-laddering per sink is how a log line ends up naming a
  // different cause than the history row it was written beside.
  const failure = error ?? (gateError ? new Error(gateError) : timeoutError);

  const finishedAt = finishAttempt(startedAt, now());
  const status: TaskRunStatus = failure ? "failed" : mapWorkflowStatus(detail?.status);
  const log = renderWorkflowLog({
    task,
    detail,
    error: failure,
    warnings: runWarnings,
    ...(timedOutAfterMs !== undefined ? { timedOutAfterMs } : {}),
  });
  persistRunLog({
    taskId: task.taskId,
    startedAtIso: startedAt.toISOString(),
    finishedAtIso: finishedAt.toISOString(),
    logPath,
    fileText: log.fileText,
    dbLines: log.dbLines,
    redactNames: task.redact,
    environment: task.environment,
  });

  const result: TaskRunResult = {
    id: task.taskId,
    status,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    log: logPath,
    target: { kind: "workflow", ref: task.ref },
    detail: {
      runId: detail?.id,
      ...(failure ? { error: scrubTaskOutput(task, failure.message) } : {}),
    },
  };
  appendHistory(result, historyReserved);
  // Don't re-throw on workflow failure: the OS scheduler reads exit codes,
  // not exceptions, and the CLI maps `status: "failed"` to a non-zero exit
  // via exitCodeForStatus(). Throwing here would route through the generic
  // runWithJsonErrors path and lose the structured result/history we just
  // recorded.
  return result;
}

/**
 * Map the workflow runtime's status into the task-runner status space.
 * A workflow normally reaches completed or failed in one orchestration call.
 * Active remains representable for explicit engine stops such as a gate.
 *
 * The parameter is typed as the runtime's `WorkflowRunStatus` union (plus the
 * `undefined` that `detail?.run.status` can produce when no detail is present).
 * Every union member is handled explicitly and the `default` arm calls
 * `assertNever`, so adding a new `WorkflowRunStatus` variant without mapping it
 * here is a *compile* error rather than silently collapsing to "completed".
 * The previous silent `default: "completed"` is preserved only for the
 * `undefined` (no-detail) case, which is handled up front.
 *
 * #943: is `undefined` reachable from a timeout (i.e. can a wedged/killed run
 * produce `status: "completed"`)? No. This function is only ever called as
 * `mapWorkflowStatus(detail?.status)` behind `failure ? "failed" : ...` in
 * {@link runWorkflowTask} — `failure` is `error ?? gateError ?? timeoutError`,
 * and `detail` is left `undefined` only in the `catch` branch that also sets
 * `error` (making `failure` truthy). So whenever this function runs, either
 * `failure` already short-circuited the caller to `"failed"` without
 * consulting it, or the run awaited successfully and `detail` (thus
 * `detail.status`) is guaranteed set by `RunWorkflowResult["run"]`, a
 * required field. `status === undefined` is therefore unreachable today; it
 * stays mapped to `"completed"` defensively rather than thrown on, since a
 * literal `undefined` can only mean "the runtime told us nothing went
 * wrong" — never observed from `runWorkflowStepsImpl`, but if some future
 * caller ever passes it, failing loudly on "no evidence of failure" would be
 * a worse trade than the status quo.
 */
function mapWorkflowStatus(status: WorkflowRunStatus | undefined): TaskRunStatus {
  // No run detail → treat as completed (unchanged from the prior silent default).
  if (status === undefined) return "completed";
  switch (status) {
    case "completed":
    case "blocked":
    case "failed":
    case "active":
      return status;
    default:
      return assertNever(status, "mapWorkflowStatus");
  }
}

function renderWorkflowLog(input: {
  task: PreparedTaskV3Workflow;
  detail?: WorkflowRunSummary;
  error?: Error;
  warnings?: readonly string[];
  /** Set when the whole-run timeout fired; mirrors the command target's line. */
  timedOutAfterMs?: number;
}): { fileText: string; dbLines: readonly TaskLogLineInput[] } {
  const dbLines: TaskLogLineInput[] = [
    { line: `[akm task] task=${input.task.taskId} kind=workflow ref=${input.task.ref}` },
  ];
  for (const warning of input.warnings ?? []) dbLines.push({ level: "warn", line: warning });
  if (input.timedOutAfterMs !== undefined) {
    dbLines.push({ level: "error", line: `timed_out=true timeout_ms=${input.timedOutAfterMs}` });
  }
  if (input.detail) {
    dbLines.push({ line: `run_id=${input.detail.id} status=${input.detail.status}` });
    dbLines.push({ line: `workflow_title=${input.detail.workflowTitle}` });
  }
  if (input.error) {
    dbLines.push({ level: "error", line: `error=${input.error.message}` });
  }
  return { fileText: `${dbLines.map((entry) => entry.line).join("\n")}\n`, dbLines };
}
