// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The task-attempt reservation/finalization lifecycle: `reserveTaskAttempt`
 * (called before any dispatch), `finishAttempt` (the monotonic finish-time
 * clamp every arm's result uses), and `recordTaskAttemptFailure` (the
 * catch-all for a dispatch that threw after an attempt was reserved).
 *
 * `reserveTaskAttempt` and `finishAttempt` are exported because run-task.ts and
 * every dispatch arm (run-native-task.ts, run-workflow-task.ts,
 * run-command-task.ts) call them.
 *
 * `SAFE_TASK_ATTEMPT_ERROR_CODES` and
 * `safeTaskAttemptErrorCode` stay unexported: their membership is observed
 * the same way production code observes it, through
 * `recordTaskAttemptFailure`'s one externally-visible effect (the stored
 * `detail.error` code). The comment on the set says why each code is reachable.
 */

import os from "node:os";
import path from "node:path";
import { AkmError, rethrowIfTestIsolationError, TransientError } from "../../core/errors";
import { type LockOwnership, processIdentity } from "../../core/file-lock";
import { getStateDir } from "../../core/paths";
import { formatLockHolderPid, tryAcquireRunLock } from "../../core/run-lock";
import { withStateDb } from "../../core/state-db";
import { warn } from "../../core/warn";
import { reserveTaskHistoryAttempt, type TaskHistoryRun } from "../../storage/repositories/task-history-repository";
import { validateTaskConceptId } from "../task-id";
import { appendHistory } from "./task-history";
import { persistRunLog, resolveTaskLogPath } from "./task-log";
import type { TaskAttemptFailureReason, TaskRunResult } from "./task-result";

export const INVALID_TASK_ATTEMPT_ID = "_invalid-task-id";

interface ReservedTaskAttempt {
  startedAt: Date;
  historyReserved: boolean;
}

/** The lock file of a task that runs one at a time, by its qualified ref (`bundle//tasks/<name>`). */
export function taskRunLockPath(ref: string): string {
  return path.join(getStateDir(), "locks", `task-${encodeURIComponent(ref)}.lock`);
}

/**
 * Take the lock of a task that runs one at a time. A start that finds it held throws `RUN_LEASE_HELD`, or, when `skip`
 * says so, warns and returns the skipped start.
 */
export function acquireTaskRunLock(
  id: string,
  ref: string,
  options: { skip: boolean; at: Date },
): { ownership: LockOwnership } | { skipped: TaskRunResult } {
  const acquired = tryAcquireRunLock(taskRunLockPath(ref), { label: "task" });
  if (acquired.state === "acquired") return { ownership: acquired.ownership };
  const message = `Task ${id} is still running (PID ${formatLockHolderPid(acquired.holder)}, started ${acquired.holder.startedAt}); not starting another run.`;
  if (!options.skip) throw new TransientError(message, "RUN_LEASE_HELD");
  warn(message);
  return { skipped: skippedActiveRun(id, options.at) };
}

/** An abort controller that akm's own SIGTERM or SIGINT aborts, which stops the running step's whole process group. */
export function abortOnTermination(): { abort: AbortController; stop: () => void } {
  const abort = new AbortController();
  const onSignal = (signal: NodeJS.Signals) => abort.abort(new Error(`task runner received ${signal}`));
  const onSigterm = () => onSignal("SIGTERM");
  const onSigint = () => onSignal("SIGINT");
  process.once("SIGTERM", onSigterm);
  process.once("SIGINT", onSigint);
  return {
    abort,
    stop: () => {
      process.off("SIGTERM", onSigterm);
      process.off("SIGINT", onSigint);
    },
  };
}

/** A scheduled run that found the previous one alive: "active" maps to exit 0 and writes no history row. */
export function skippedActiveRun(id: string, at: Date): TaskRunResult {
  return {
    id,
    status: "active",
    startedAt: at.toISOString(),
    finishedAt: at.toISOString(),
    durationMs: 0,
    log: "",
    target: { kind: "steps" },
    detail: { reason: "previous_run_active" },
  };
}

/** Reserve a collision-free identity through state.db's existing unique index. `run` is the version 5 run the attempt belongs to. */
export function reserveTaskAttempt(
  taskId: string,
  requestedStartedAt: Date,
  run?: TaskHistoryRun,
): ReservedTaskAttempt {
  try {
    return withStateDb((db) => {
      for (let offsetMs = 0; ; offsetMs++) {
        const startedAt = new Date(requestedStartedAt.getTime() + offsetMs);
        const reserved = reserveTaskHistoryAttempt(db, {
          task_id: taskId,
          status: "active",
          started_at: startedAt.toISOString(),
          completed_at: null,
          failed_at: null,
          log_path: null,
          target_kind: null,
          target_ref: null,
          metadata_json: JSON.stringify({
            metadataVersion: 2,
            durationMs: 0,
            detail: null,
            ...(run ? { run } : {}),
            owner: { pid: process.pid, host: os.hostname(), ...processIdentity(process.pid) },
          }),
        });
        if (reserved) return { startedAt, historyReserved: true };
      }
    });
  } catch (error) {
    rethrowIfTestIsolationError(error);
    // Attempt recording cannot prevent or replace task execution.
    return { startedAt: requestedStartedAt, historyReserved: false };
  }
}

/** Clamp a finish observation to never precede its own start (a mocked clock can otherwise report a negative duration). */
export function finishAttempt(startedAt: Date, observedFinishedAt: Date): Date {
  return observedFinishedAt.getTime() < startedAt.getTime() ? new Date(startedAt) : observedFinishedAt;
}

/**
 * Error codes safe to surface verbatim in a task-history `detail.error`
 * (rather than the generic `"INTERNAL"`) — user-actionable configuration and
 * usage failures, never an unclassified internal error that might leak
 * implementation detail.
 *
 * Scheduled activations record preparation failures as well as dispatch failures.
 * Interactive preparation stays non-mutating.
 * `TASK_SOURCE_INVALID`, `COMPOSITION_INVALID`, `TARGET_REF_INVALID` and
 * `INPUT_BINDING_INVALID` reach it through the WORKFLOW arm: a workflow task
 * whose plan freezes a `tasks/<ref>` step raises `TASK_SOURCE_INVALID` (via
 * `taskDispatch`'s `parseTaskSource`/`parseTaskSourceV4Document` —
 * `src/workflows/freeze/targets/task.ts`), and freezing a composed child can
 * classify a malformed `uses:` (`TARGET_REF_INVALID`,
 * `execution/target-ref.ts`), an invalid `with:` binding
 * (`INPUT_BINDING_INVALID`, `workflows/freeze/task-bindings.ts`) or a `with:`
 * rejection (`COMPOSITION_INVALID`) DURING dispatch, after the attempt was
 * already reserved. `WORKFLOW_SOURCE_INVALID` and `TASK_TARGET_UNSUPPORTED`
 * are thrown by the freeze wrapper and by `prepare/script-capture.ts`'s
 * interpreter rejections, respectively. Without them each would be recorded as
 * `"INTERNAL"`.
 */
const SAFE_TASK_ATTEMPT_ERROR_CODES = new Set([
  "CONFIG_DIR_UNRESOLVABLE",
  "STASH_DIR_NOT_FOUND",
  "STASH_DIR_NOT_A_DIRECTORY",
  "STASH_DIR_UNREADABLE",
  "LLM_NOT_CONFIGURED",
  "AGENT_NOT_CONFIGURED",
  "SELECTION_NOT_CONFIGURED",
  "SECRET_REFERENCE_UNRESOLVED",
  "RESOURCE_ALREADY_EXISTS",
  "UNKNOWN_FLAG",
  "INVALID_CONFIG_FILE",
  "TEST_ISOLATION_MISSING",
  "INVALID_FLAG_VALUE",
  "MISSING_REQUIRED_ARGUMENT",
  "PATH_ESCAPE_VIOLATION",
  "TASK_SCHEMA_VERSION_UNSUPPORTED",
  "ASSET_NOT_FOUND",
  "WORKFLOW_NOT_FOUND",
  "FILE_NOT_FOUND",
  "TASK_SOURCE_INVALID",
  "COMPOSITION_INVALID",
  "TARGET_REF_INVALID",
  "WORKFLOW_SOURCE_INVALID",
  "INPUT_BINDING_INVALID",
  "TASK_TARGET_UNSUPPORTED",
]);

function safeTaskAttemptErrorCode(failure: unknown): string {
  if (failure instanceof AkmError && SAFE_TASK_ATTEMPT_ERROR_CODES.has(failure.code)) return failure.code;
  return "INTERNAL";
}

export function recordTaskAttemptFailure(input: {
  taskId: string;
  reason: TaskAttemptFailureReason;
  failure: unknown;
  startedAt: Date;
  finishedAt?: Date;
  logDir?: string;
  /** Internal: runTask already reserved this identity. */
  historyReserved?: boolean;
  /** Whether the OS scheduler started the run; stored as the row's `trigger`. */
  scheduled?: boolean;
  /** The bundle the task was to be read from. */
  bundle?: string;
}): void {
  let taskId = input.taskId;
  try {
    validateTaskConceptId(taskId);
  } catch {
    taskId = INVALID_TASK_ATTEMPT_ID;
  }
  const attempt =
    input.historyReserved === undefined
      ? reserveTaskAttempt(taskId, input.startedAt)
      : { startedAt: input.startedAt, historyReserved: input.historyReserved };
  const finishedAt = finishAttempt(attempt.startedAt, input.finishedAt ?? new Date());
  const startedAtIso = attempt.startedAt.toISOString();
  const finishedAtIso = finishedAt.toISOString();
  const errorCode = safeTaskAttemptErrorCode(input.failure);
  const logPath = resolveTaskLogPath(input.logDir, taskId, startedAtIso);
  const line = `[akm task] status=failed reason=${input.reason} code=${errorCode}`;
  const result: TaskRunResult = {
    id: taskId,
    status: "failed",
    startedAt: startedAtIso,
    finishedAt: finishedAtIso,
    durationMs: Math.max(0, finishedAt.getTime() - attempt.startedAt.getTime()),
    log: logPath,
    target: { kind: "unknown" },
    ...(input.bundle ? { bundle: input.bundle } : {}),
    detail: { reason: input.reason, error: errorCode },
  };

  persistRunLog({
    taskId,
    startedAtIso,
    finishedAtIso,
    logPath,
    fileText: `${line}\n`,
    dbLines: [{ level: "error", line }],
  });
  appendHistory(result, attempt.historyReserved, input.scheduled);
}
