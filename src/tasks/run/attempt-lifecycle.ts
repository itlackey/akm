// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The task-attempt reservation/finalization lifecycle: `reserveTaskAttempt`
 * (called before any dispatch), `finishAttempt` (the monotonic finish-time
 * clamp every arm's result uses), and `recordTaskAttemptFailure` (the
 * catch-all for a dispatch that threw after an attempt was reserved).
 *
 * Moved from src/tasks/runner.ts (spec docs/plans/specs/p1b-model-extraction.md
 * §5.1, §9, runner.ts:970-1069). `reserveTaskAttempt` and `finishAttempt`
 * were module-private at head; both are exported here because run-task.ts and
 * every dispatch arm (run-native-task.ts, run-workflow-task.ts,
 * run-command-task.ts), now separate files, call them.
 *
 * F-4 (P1a advisory, spec §5.5): `SAFE_TASK_ATTEMPT_ERROR_CODES` gains
 * `TASK_SOURCE_INVALID` and `COMPOSITION_INVALID` — see the comment on the
 * set for the verified reachability path. `SAFE_TASK_ATTEMPT_ERROR_CODES` and
 * `safeTaskAttemptErrorCode` stay unexported: their membership is observed
 * the same way production code observes it, through
 * `recordTaskAttemptFailure`'s one externally-visible effect (the stored
 * `detail.error` code).
 *
 * P4 (docs/plans/specs/p4-deletions-closeout.md §4.1, row B-55): the set
 * additionally gains `TARGET_REF_INVALID`, `WORKFLOW_SOURCE_INVALID`,
 * `INPUT_BINDING_INVALID`, and `TASK_TARGET_UNSUPPORTED` — every code P4's
 * `INVALID_FLAG_VALUE` re-coding sweep (spec §5.2) makes reachable from the
 * same post-reservation dispatch catch. `TARGET_REF_INVALID`
 * (`execution/target-ref.ts`) and `INPUT_BINDING_INVALID`
 * (`workflows/freeze/task-bindings.ts`) already reach it today through the
 * same WORKFLOW arm as `COMPOSITION_INVALID` above — freezing a composed
 * child (a `tasks/<ref>` or `workflows/<ref>` step) during dispatch can
 * classify a malformed `uses:` or an invalid `with:` binding after the
 * attempt is reserved. `WORKFLOW_SOURCE_INVALID` and `TASK_TARGET_UNSUPPORTED`
 * get their first live throw sites in this same phase (the freeze wrapper's
 * P4-N2 mapping, and `prepare/script-capture.ts`'s interpreter rejections,
 * respectively) — added here ahead of / alongside that wiring rather than
 * split across two commits, since an unreachable member of an allowlist Set
 * is inert, not a defect.
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
 * F-4 (P1a advisory, spec §5.5): `TASK_SOURCE_INVALID` and
 * `COMPOSITION_INVALID` join the allowlist. Verified reachability: the only
 * caller of `recordTaskAttemptFailure` inside the runner is the
 * post-reservation catch in run-task.ts; task-source parsing happens BEFORE
 * reservation (load-task.ts), so the direct parse path never reaches it.
 * Both codes reach it through the WORKFLOW arm instead: a workflow task whose
 * plan freezes a `tasks/<ref>` step raises `TASK_SOURCE_INVALID` (via
 * `taskDispatch`'s `parseTaskSource`/`parseTaskSourceV4Document` —
 * `src/workflows/freeze/targets/task.ts`; `parseTaskV3Yaml` no longer exists
 * in `src`, P4 deleted task v3 acceptance, spec
 * docs/plans/specs/p4-deletions-closeout.md §3.2) or `COMPOSITION_INVALID`
 * (the P1a with-rejection guard) DURING dispatch, after the attempt was
 * already reserved. Before this widening, both were recorded as
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
