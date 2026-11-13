// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm task run <id>` — what cron / launchd / schtasks invoke at the
 * scheduled moment.
 *
 * The durable boundary is intentional: id/bundle resolution, source read,
 * strict task source parsing, target resolution, command lowering, workflow
 * projectability, and frozen script-byte
 * capture (load-task.ts) all finish before an attempt is reserved or a log is
 * created (attempt-lifecycle.ts). Once prepared, the runner dispatches the
 * immutable command, workflow, shell, or script projection to its own arm
 * module (run-command-task.ts, run-workflow-task.ts, run-native-task.ts) and
 * records that actual attempt. Task source v4 has no document-level disabled
 * state to skip at fire time — a schedule binding that should not
 * fire is never installed with the OS scheduler in the first place
 * (scheduler-sync.ts), so every invocation that reaches `runTask` dispatches.
 *
 * Orchestration only.
 *
 * Resolves `options.provenance` against the default context (run/provenance.ts)
 * ONCE per call, and threads the result into every dispatch arm.
 */

import path from "node:path";
import { TransientError } from "../../core/errors";
import { releaseLock } from "../../core/file-lock";
import { getStateDir } from "../../core/paths";
import { formatLockHolderPid, tryAcquireRunLock } from "../../core/run-lock";
import { warn } from "../../core/warn";
import { runWorkflowSteps } from "../../workflows/exec/run-workflow";
import { nameStepError } from "../prepare/prepare-steps";
import { recordTaskAttemptFailure, reserveTaskAttempt } from "./attempt-lifecycle";
import { loadPreparedTask } from "./load-task";
import { resolveProvenanceContext } from "./provenance";
import { runPreparedCommandTask } from "./run-command-task";
import { runNativeTask } from "./run-native-task";
import { resolveResume, runStepsTask } from "./run-steps-task";
import { runWorkflowTask } from "./run-workflow-task";
import { resolveTaskLogPath } from "./task-log";
import type { RunTaskOptions, TaskRunResult } from "./task-result";

export async function runTask(id: string, options: RunTaskOptions): Promise<TaskRunResult> {
  const runWorkflowStepsImpl = options.runWorkflowStepsImpl ?? runWorkflowSteps;
  const now = options.now ?? (() => new Date());
  const requestedStartedAt = now();
  const provenance = resolveProvenanceContext(options.provenance, options.scheduled === true);

  const task = await loadPreparedTask(id, options);

  // Experimental steps task: a run does not start while the previous one is alive, and `task:`
  // steps and `--resume` are settled before any attempt is reserved.
  let resume: ReturnType<typeof resolveResume> | undefined;
  let lock: (ReturnType<typeof tryAcquireRunLock> & { state: "acquired" }) | undefined;
  if (task.kind === "steps") {
    const acquired = tryAcquireRunLock(taskRunLockPath(id), { label: "task" });
    if (acquired.state === "held") {
      const message = `Task ${id} is still running (PID ${formatLockHolderPid(acquired.holder)}, started ${acquired.holder.startedAt}); not starting another run.`;
      if (!options.scheduled) throw new TransientError(message, "RUN_LEASE_HELD");
      warn(message);
      return skippedActiveRun(id, requestedStartedAt);
    }
    lock = acquired;
    try {
      for (const step of task.steps) {
        if (step.kind !== "task") continue;
        try {
          await options.taskStepRunner?.check(step.ref);
        } catch (error) {
          throw nameStepError(step.name, error);
        }
      }
      if (task.resume) resume = resolveResume(task);
    } catch (error) {
      releaseLock(lock.ownership);
      throw error;
    }
  }

  // All validation, parsing, source resolution, command cascade preparation,
  // and frozen-byte capture above is non-mutating. Only a fully projectable
  // task may reserve durable history or create a log.
  let attempt: ReturnType<typeof reserveTaskAttempt>;
  try {
    attempt = reserveTaskAttempt(id, requestedStartedAt);
  } catch (error) {
    if (lock) releaseLock(lock.ownership);
    throw error;
  }
  const startedAt = attempt.startedAt;
  const startedIso = startedAt.toISOString();
  const logPath = resolveTaskLogPath(options.logDir, id, startedIso);
  try {
    if (task.kind === "steps") {
      return await runStepsTask({
        task,
        logPath,
        startedAt,
        now,
        historyReserved: attempt.historyReserved,
        provenance,
        options,
        ...(resume ? { resume } : {}),
      });
    }
    if (task.kind === "workflow") {
      return await runWorkflowTask({
        task,
        logPath,
        startedAt,
        now,
        runWorkflowStepsImpl,
        historyReserved: attempt.historyReserved,
        provenance,
        ...(options.setTimeoutFn ? { setTimeoutFn: options.setTimeoutFn } : {}),
        ...(options.clearTimeoutFn ? { clearTimeoutFn: options.clearTimeoutFn } : {}),
      });
    }
    if (task.kind === "command") {
      return await runPreparedCommandTask({
        task,
        logPath,
        startedAt,
        now,
        historyReserved: attempt.historyReserved,
        provenance,
        runAgentImpl: options.runAgentImpl,
      });
    }
    options.beforeNativeDispatch?.(task);
    return await runNativeTask({
      task,
      logPath,
      startedAt,
      now,
      historyReserved: attempt.historyReserved,
      provenance,
      ...(options.spawnFn ? { spawnFn: options.spawnFn } : {}),
      ...(options.setTimeoutFn ? { setTimeoutFn: options.setTimeoutFn } : {}),
      ...(options.clearTimeoutFn ? { clearTimeoutFn: options.clearTimeoutFn } : {}),
    });
  } catch (failure) {
    recordTaskAttemptFailure({
      taskId: id,
      reason: "task_dispatch_failed",
      failure,
      startedAt,
      finishedAt: now(),
      logDir: options.logDir,
      historyReserved: attempt.historyReserved,
      scheduled: provenance.scheduled,
    });
    throw failure;
  } finally {
    if (lock) releaseLock(lock.ownership);
  }
}

function taskRunLockPath(id: string): string {
  return path.join(getStateDir(), "locks", `task-${encodeURIComponent(id)}.lock`);
}

/** A scheduled run that found the previous one alive: "active" maps to exit 0 and writes no history row. */
function skippedActiveRun(id: string, at: Date): TaskRunResult {
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
