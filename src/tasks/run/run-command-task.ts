// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The common command (agent/LLM) dispatch arm: `runPreparedCommandTask`,
 * `renderPromptLog`.
 *
 * Moved from src/tasks/runner.ts (spec docs/plans/specs/p1b-model-extraction.md
 * §5.1, §9, runner.ts:677-778).
 *
 * F-1 (R-07 fix, spec §5.2 point 3): `runPreparedCommandTask` now passes the
 * resolved provenance into `dispatchPreparedCommandInvocation` via a new
 * `eventSource` option — the fix for R-07 (a prompt/command task run
 * previously never stamped `AKM_EVENT_SOURCE` anywhere, so its nested usage
 * was recorded as user demand). The dispatched engine's child env now carries
 * the stamp too, matching the native arm.
 *
 * F-2 (D8, spec §5.3): the result's `target` is now `{kind:"command", engine}`
 * — formerly `{kind:"prompt", engine}`.
 */

import type { CommandDispatchResult, DispatchPreparedCommandOptions } from "../../commands/command/command-execution";
import { dispatchPreparedCommandInvocation } from "../../commands/command/command-execution";
import type { TaskLogLineInput } from "../../core/logs-db";
import type { LoweringNotice } from "../../execution/resolved-request";
import type { RunAgentOptions } from "../../integrations/agent";
import type { RunExecutionOptions } from "../../integrations/agent/runner-dispatch";
import type { chatCompletion } from "../../llm/client";
import type { ExecutionProvenanceContext } from "../model/invocation";
import type { PreparedTaskV3Command } from "../prepare/prepared-execution";
import { finishAttempt } from "./attempt-lifecycle";
import { appendHistory } from "./task-history";
import { persistRunLog, scrubTaskOutput, streamLines } from "./task-log";
import type { TaskRunResult, TaskRunStatus } from "./task-result";

export async function runPreparedCommandTask(input: {
  task: PreparedTaskV3Command;
  logPath: string;
  startedAt: Date;
  now: () => Date;
  runAgentImpl?: RunExecutionOptions["runAgent"];
  chatCompletionImpl?: typeof chatCompletion;
  agentOptions?: Partial<RunAgentOptions>;
  historyReserved: boolean;
  provenance: ExecutionProvenanceContext;
}): Promise<TaskRunResult> {
  const { task, logPath, startedAt, now, agentOptions, provenance } = input;
  const dispatchOptions: DispatchPreparedCommandOptions = {
    ...(input.runAgentImpl ? { runAgent: input.runAgentImpl } : {}),
    ...(input.chatCompletionImpl ? { chat: input.chatCompletionImpl } : {}),
    ...(agentOptions ? { runOptions: agentOptions } : {}),
    // F-1 (R-07 fix, spec §5.2 point 3): threads the resolved event source
    // into the dispatched engine's child env and the recorded usage events.
    eventSource: provenance.eventSource,
  };
  const result = await dispatchPreparedCommandInvocation(task.invocation, dispatchOptions);
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
