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

import { AkmError, rethrowIfTestIsolationError } from "../../core/errors";
import { withStateDb } from "../../core/state-db";
import { reserveTaskHistoryAttempt } from "../../storage/repositories/task-history-repository";
import { validateTaskId } from "../task-id";
import { appendHistory } from "./task-history";
import { persistRunLog, resolveTaskLogPath } from "./task-log";
import type { TaskAttemptFailureReason, TaskRunResult } from "./task-result";

export const INVALID_TASK_ATTEMPT_ID = "_invalid-task-id";

interface ReservedTaskAttempt {
  startedAt: Date;
  historyReserved: boolean;
}

/** Reserve a collision-free identity through state.db's existing unique index. */
export function reserveTaskAttempt(taskId: string, requestedStartedAt: Date): ReservedTaskAttempt {
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
          metadata_json: JSON.stringify({ metadataVersion: 2, durationMs: 0, detail: null }),
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
 * Every code here is reachable from the post-reservation dispatch catch: the
 * only caller of `recordTaskAttemptFailure` inside the runner is the
 * post-reservation catch in run-task.ts; task-source parsing happens BEFORE
 * reservation (load-task.ts), so the direct parse path never reaches it.
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
}): void {
  let taskId = input.taskId;
  try {
    validateTaskId(taskId);
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
  appendHistory(result, attempt.historyReserved);
}
