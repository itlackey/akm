// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The common command (agent/LLM) dispatch arm: `runPreparedCommandTask`,
 * `renderPromptLog`.
 *
 * `runPreparedCommandTask` passes the resolved provenance into
 * `dispatchPreparedCommandInvocation` via the `eventSource` option, so a
 * command task run stamps `AKM_EVENT_SOURCE` and its nested usage is not
 * recorded as user demand. The dispatched harness's child env carries the stamp
 * too, matching the native arm.
 *
 * The result's `target` is `{kind:"command", engine}`.
 */

import type { CommandDispatchResult, DispatchPreparedCommandOptions } from "../../commands/command/command-execution";
import { dispatchPreparedCommandInvocation } from "../../commands/command/command-execution";
import type { TaskLogLineInput } from "../../core/logs-db";
import type { LoweringNotice } from "../../execution/resolved-request";
import type { RunExecutionOptions } from "../../integrations/agent/runner-dispatch";
import type { ExecutionProvenanceContext } from "../model/invocation";
import type { PreparedTaskV3Command } from "../prepare/prepared-execution";
import { finishAttempt } from "./attempt-lifecycle";
import { DEFAULT_SCHEDULED_TASK_TIMEOUT_MS } from "./run-workflow-task";
import { appendHistory } from "./task-history";
import { persistRunLog, scrubTaskOutput, streamLines } from "./task-log";
import type { TaskRunResult, TaskRunStatus } from "./task-result";

export async function runPreparedCommandTask(input: {
  task: PreparedTaskV3Command;
  logPath: string;
  startedAt: Date;
  now: () => Date;
  runAgentImpl?: RunExecutionOptions["runAgent"];
  historyReserved: boolean;
  provenance: ExecutionProvenanceContext;
}): Promise<TaskRunResult> {
  const { task, logPath, startedAt, now, provenance } = input;
  const dispatchOptions: DispatchPreparedCommandOptions = {
    ...(input.runAgentImpl ? { runAgent: input.runAgentImpl } : {}),
    // Threads the resolved event source into the dispatched harness's child env
    // and the recorded usage events.
    eventSource: provenance.eventSource,
  };
  // Unset anywhere (task `timeout:`, command asset, connection or harness) → the
  // unattended default; an explicit value or `null` (opt-out) was set by one of them.
  const { runner, request, provenance: provenances } = task.invocation;
  const unset = provenances["runtime.timeoutMs"]?.via === "default";
  const invocation = unset
    ? {
        ...task.invocation,
        request: {
          ...request,
          runtime: { ...request.runtime, timeoutMs: DEFAULT_SCHEDULED_TASK_TIMEOUT_MS },
        },
        runner: { ...runner, timeoutMs: DEFAULT_SCHEDULED_TASK_TIMEOUT_MS },
      }
    : task.invocation;
  const result = await dispatchPreparedCommandInvocation(invocation, dispatchOptions);
  const engineName = result.engine;

  const finishedAt = finishAttempt(startedAt, now());
  const log = renderPromptLog({ task, engineName, result, notices: result.notices, warnings: result.warnings });
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

  const status: TaskRunStatus = result.ok ? "completed" : "failed";
  const out: TaskRunResult = {
    id: task.taskId,
    status,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    log: logPath,
    target: { kind: "command", engine: engineName },
    detail: result.ok
      ? { exitCode: result.exitCode }
      : {
          reason: result.reason === undefined ? undefined : scrubTaskOutput(task, result.reason),
          error: result.error === undefined ? undefined : scrubTaskOutput(task, result.error),
          exitCode: result.exitCode,
        },
    ...(result.notices && result.notices.length > 0
      ? {
          notices: result.notices.map((notice) => ({
            ...notice,
            message: scrubTaskOutput(task, notice.message),
          })),
        }
      : {}),
  };
  appendHistory(out, input.historyReserved);
  return out;
}

function renderPromptLog(input: {
  task: PreparedTaskV3Command;
  engineName: string;
  result: CommandDispatchResult;
  warnings?: readonly string[];
  notices?: readonly Readonly<LoweringNotice>[];
}): { fileText: string; dbLines: readonly TaskLogLineInput[] } {
  const lines: string[] = [];
  const dbLines: TaskLogLineInput[] = [];
  const header = `[akm task] task=${input.task.taskId} kind=prompt engine=${input.engineName}`;
  const summary = `ok=${input.result.ok} exit_code=${input.result.exitCode ?? "null"} duration_ms=${input.result.durationMs}`;
  lines.push(header, summary);
  dbLines.push({ line: header }, { level: input.result.ok ? "info" : "error", line: summary });
  for (const warning of input.warnings ?? []) {
    lines.push(warning);
    dbLines.push({ level: "warn", line: warning });
  }
  for (const notice of input.notices ?? []) {
    const line = `lowering_notice=${notice.code} adapter=${notice.adapter} field=${notice.field ?? ""} message=${notice.message}`;
    lines.push(line);
    dbLines.push({ level: notice.severity === "warning" ? "warn" : "info", line });
  }
  if (!input.result.ok) {
    const failure = `reason=${input.result.reason ?? ""} error=${input.result.error ?? ""}`;
    lines.push(failure);
    dbLines.push({ level: "error", line: failure });
  }
  if (input.result.stdout) {
    lines.push("--- agent stdout ---");
    lines.push(input.result.stdout);
    dbLines.push(...streamLines(input.result.stdout, "stdout", "info"));
  }
  if (input.result.stderr) {
    lines.push("--- agent stderr ---");
    lines.push(input.result.stderr);
    dbLines.push(...streamLines(input.result.stderr, "stderr", "error"));
  }
  return { fileText: `${lines.join("\n")}\n`, dbLines };
}
