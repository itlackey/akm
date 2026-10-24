// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm task run <id>` — what cron / launchd / schtasks invoke at the
 * scheduled moment.
 *
 * The durable boundary is intentional: id/bundle resolution, source read,
 * strict task source parsing, target resolution, command
 * authorization/lowering, workflow projectability, and frozen script-byte
 * capture (load-task.ts) all finish before an attempt is reserved or a log is
 * created (attempt-lifecycle.ts). Once prepared, the runner dispatches the
 * immutable command, workflow, shell, or script projection to its own arm
 * module (run-command-task.ts, run-workflow-task.ts, run-native-task.ts) and
 * records that actual attempt. Task source v4 has no document-level disabled
 * state to skip at fire time (P4-N6) — a schedule binding that should not
 * fire is never installed with the OS scheduler in the first place
 * (scheduler-sync.ts), so every invocation that reaches `runTask` dispatches.
 *
 * Orchestration only.
 *
 * D5 (spec §1.2/§5.2, "Threading"): resolves `options.provenance` against the
 * default context (run/provenance.ts) ONCE per call, and threads the result
 * into every dispatch arm.
 */

import { runWorkflowSteps } from "../../workflows/exec/run-workflow";
import { recordTaskAttemptFailure, reserveTaskAttempt } from "./attempt-lifecycle";
import { loadPreparedTask } from "./load-task";
import { resolveProvenanceContext } from "./provenance";
import { runPreparedCommandTask } from "./run-command-task";
import { runNativeTask } from "./run-native-task";
import { runWorkflowTask } from "./run-workflow-task";
import { resolveTaskLogPath } from "./task-log";
import type { RunTaskOptions, TaskRunResult } from "./task-result";

export async function runTask(id: string, options: RunTaskOptions): Promise<TaskRunResult> {
  const runWorkflowStepsImpl = options.runWorkflowStepsImpl ?? runWorkflowSteps;
  const now = options.now ?? (() => new Date());
  const requestedStartedAt = now();
  const provenance = resolveProvenanceContext(options.provenance, options.scheduled === true);

  const task = await loadPreparedTask(id, options);

  // All validation, parsing, source resolution, command cascade preparation,
  // and frozen-byte capture above is non-mutating. Only a fully projectable
  // task may reserve durable history or create a log.
  const attempt = reserveTaskAttempt(id, requestedStartedAt);
  const startedAt = attempt.startedAt;
  const startedIso = startedAt.toISOString();
  const logPath = resolveTaskLogPath(options.logDir, id, startedIso);
  try {
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
        agentOptions: options.agentOptions,
        chatCompletionImpl: options.chatCompletionImpl,
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
    });
    throw failure;
  }
}
