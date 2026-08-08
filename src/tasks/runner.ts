// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm task run <id>` — what cron / launchd / schtasks invoke at the
 * scheduled moment.
 *
 * Responsibilities:
 *
 *   1. Resolve the task file via `resolveAssetPath(stashDir, "task", id)`.
 *   2. Parse the task document. (Validation runs at `tasks add` /
 *      `tasks sync` time, not here — at run time we still want to attempt
 *      execution and surface the actual failure rather than re-fail on a
 *      validation error that the user already knows about.)
 *   3. Skip disabled tasks only when the invocation is scheduler-generated;
 *      explicit manual runs are allowed for catch-up and testing.
 *   4. Dispatch by target kind:
 *        • workflow → `runWorkflowSteps({ target: ref, params, signal, … })`
 *                     under a whole-run timeout (issue 11): an unattended run
 *                     gets the same abort path `akm workflow run --timeout`
 *                     gives an interactive one.
 *        • prompt   → `executeRunner(engine, prompt, { stdio: "captured" })`
 *   5. Capture stdout / stderr as structured rows in logs.db (task_logs) and,
 *      transitionally, as a flat text tail at `<cacheDir>/tasks/logs/<id>/<ts>.log`
 *      (per the #579 logs audit).
 *   6. Write a history row to state.db task_history table.
 *
 * Returns a structured result so the CLI handler can shape it for `output()`
 * and so tests can assert against it without scraping stdout.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { shouldSkipUnactivatedTask } from "../core/activation-policy";
import { assertNever } from "../core/assert";
import { placementSpecFor } from "../core/asset/asset-placement";
import { parseRefInput } from "../core/asset/resolve-ref";
import { loadConfig } from "../core/config/config";
import { AkmError, NotFoundError, rethrowIfTestIsolationError } from "../core/errors";
import {
  buildTaskRunId,
  insertTaskLogLines,
  openLogsDatabase,
  type TaskLogLevel,
  type TaskLogLineInput,
  type TaskLogStream,
} from "../core/logs-db";
import { getTaskLogDir } from "../core/paths";
import { redactCredentialPatterns } from "../core/redaction";
import { withStateDb } from "../core/state-db";
import { runManagedSubprocess, type SpawnFn } from "../core/subprocess";
import type { AgentRunResult, RunAgentOptions } from "../integrations/agent";
import {
  fallbackAnnouncement,
  NO_ENGINE_MESSAGE_SUFFIX,
  NO_ENGINE_REMEDY,
  withEngineFallback,
} from "../integrations/agent/engine-fallback";
import { resolveEngine, resolveLlmEngineUse } from "../integrations/agent/engine-resolution";
import { resolveModel } from "../integrations/agent/model-aliases";
import type { RunnerSpec } from "../integrations/agent/runner";
import { executeRunner, type RunnerSeams } from "../integrations/agent/runner-dispatch";
import { chatCompletion } from "../llm/client";
import { resolveAssetPath } from "../sources/resolve";
import type { WorkflowRunStatus, WorkflowRunSummary } from "../sources/types";
import {
  decodeTaskHistoryMetadata,
  finalizeTaskHistoryAttempt,
  getTaskHistory,
  queryTaskHistory,
  reserveTaskHistoryAttempt,
  upsertTaskHistory,
} from "../storage/repositories/task-history-repository";
import { runWorkflowSteps } from "../workflows/exec/run-workflow";
import { findBareAkmExecutableIndex } from "./command-executable";
import { parseTaskDocument } from "./parser";
import { resolveAkmInvocation } from "./resolve-akm-bin";
import type { TaskDocument } from "./schema";
import { validateTaskId } from "./task-id";

export type TaskRunStatus = "completed" | "blocked" | "failed" | "disabled" | "active";

export const INVALID_TASK_ATTEMPT_ID = "_invalid-task-id";

export type TaskAttemptFailureReason =
  | "invalid_task_id"
  | "task_load_failed"
  | "task_parse_failed"
  | "task_dispatch_failed";

export interface TaskRunResult {
  id: string;
  status: TaskRunStatus;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  log: string;
  target:
    | { kind: "workflow"; ref: string }
    | { kind: "prompt"; engine: string | null; legacyProfile?: string }
    | { kind: "command"; cmd?: string[] }
    | { kind: "unknown" };
  /** Workflow run id (for workflow targets) or agent reason/error (for prompt targets). */
  detail?: { runId?: string; reason?: string; error?: string; exitCode?: number | null };
}

export interface RunTaskOptions {
  /**
   * The stash directory the task asset resolves against. Resolved once at the
   * `akm task run` command boundary (WI-9.10 CLI-wide sweep) and threaded in —
   * this runner no longer reads the ambient stash-dir resolver.
   */
  stashDir: string;
  /** Override the agent runner (tests). Defaults to {@link runAgent}. */
  runAgentImpl?: RunnerSeams["runAgent"];
  /**
   * Override the workflow orchestrator (tests). Defaults to
   * {@link runWorkflowSteps}.
   */
  runWorkflowStepsImpl?: typeof runWorkflowSteps;
  /** Override clock (tests). */
  now?: () => Date;
  /** Override log dir (tests). */
  logDir?: string;
  /** Extra args/env to pass through to runAgent (tests). */
  agentOptions?: Partial<RunAgentOptions>;
  /** Override plain LLM prompt dispatch (tests). */
  chatCompletionImpl?: typeof chatCompletion;
  /** Override the command-target spawn (tests). Defaults to the runtime spawn. */
  spawnFn?: SpawnFn;
  /**
   * Override the timeout timers (tests). Default to the globals. Used by both
   * the command-target kill ladder and the workflow-target whole-run timeout.
   */
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  /** True only for an invocation generated by a scheduler backend. */
  scheduled?: boolean;
}

export async function runTask(id: string, options: RunTaskOptions): Promise<TaskRunResult> {
  const runAgentImpl = options.runAgentImpl;
  const runWorkflowStepsImpl = options.runWorkflowStepsImpl ?? runWorkflowSteps;
  const now = options.now ?? (() => new Date());
  const requestedStartedAt = now();

  try {
    validateTaskId(id);
  } catch (failure) {
    const attempt = reserveTaskAttempt(INVALID_TASK_ATTEMPT_ID, requestedStartedAt);
    recordTaskAttemptFailure({
      taskId: INVALID_TASK_ATTEMPT_ID,
      reason: "invalid_task_id",
      failure,
      startedAt: attempt.startedAt,
      finishedAt: now(),
      logDir: options.logDir,
      historyReserved: attempt.historyReserved,
    });
    throw failure;
  }

  const attempt = reserveTaskAttempt(id, requestedStartedAt);
  const startedAt = attempt.startedAt;
  let failureReason: TaskAttemptFailureReason = "task_load_failed";

  try {
    const stashDir = options.stashDir;
    const filePath = await resolveAssetPath(stashDir, "task", id);
    const yaml = fs.readFileSync(filePath, "utf8");

    failureReason = "task_parse_failed";
    const task = parseTaskDocument({ yaml, filePath, id });

    failureReason = "task_dispatch_failed";
    const startedIso = startedAt.toISOString();
    const logPath = resolveTaskLogPath(options.logDir, id, startedIso);

    if (shouldSkipUnactivatedTask({ enabled: task.enabled, scheduled: options.scheduled === true })) {
      const finishedAt = finishAttempt(startedAt, now());
      const disabledTarget: TaskRunResult["target"] =
        task.target.kind === "workflow"
          ? { kind: "workflow", ref: task.target.ref }
          : task.target.kind === "command"
            ? { kind: "command", cmd: task.target.cmd }
            : { kind: "prompt", engine: task.target.engine ?? null };
      const result: TaskRunResult = {
        id,
        status: "disabled",
        startedAt: startedIso,
        finishedAt: finishedAt.toISOString(),
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        log: logPath,
        target: disabledTarget,
      };
      const disabledLine = `[akm task] task "${id}" is disabled — skipping run.`;
      persistRunLog({
        taskId: id,
        startedAtIso: startedIso,
        finishedAtIso: result.finishedAt,
        logPath,
        fileText: `${disabledLine}\n`,
        dbLines: [{ line: disabledLine }],
      });
      appendHistory(result, attempt.historyReserved);
      return result;
    }

    if (task.target.kind === "workflow") {
      return await runWorkflowTask({
        task,
        logPath,
        startedAt,
        now,
        runWorkflowStepsImpl,
        historyReserved: attempt.historyReserved,
        ...(options.setTimeoutFn ? { setTimeoutFn: options.setTimeoutFn } : {}),
        ...(options.clearTimeoutFn ? { clearTimeoutFn: options.clearTimeoutFn } : {}),
      });
    }

    if (task.target.kind === "command") {
      return await runCommandTask({
        task,
        logPath,
        startedAt,
        now,
        historyReserved: attempt.historyReserved,
        ...(options.spawnFn ? { spawnFn: options.spawnFn } : {}),
        ...(options.setTimeoutFn ? { setTimeoutFn: options.setTimeoutFn } : {}),
        ...(options.clearTimeoutFn ? { clearTimeoutFn: options.clearTimeoutFn } : {}),
      });
    }

    return await runPromptTask({
      task,
      stashDir,
      logPath,
      startedAt,
      now,
      runAgentImpl,
      agentOptions: options.agentOptions,
      chatCompletionImpl: options.chatCompletionImpl ?? chatCompletion,
      historyReserved: attempt.historyReserved,
    });
  } catch (failure) {
    recordTaskAttemptFailure({
      taskId: id,
      reason: failureReason,
      failure,
      startedAt,
      finishedAt: now(),
      logDir: options.logDir,
      historyReserved: attempt.historyReserved,
    });
    throw failure;
  }
}

// ── command target ──────────────────────────────────────────────────────────

async function runCommandTask(input: {
  task: TaskDocument;
  logPath: string;
  startedAt: Date;
  now: () => Date;
  historyReserved: boolean;
  spawnFn?: SpawnFn;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}): Promise<TaskRunResult> {
  const { task, logPath, startedAt, now, historyReserved } = input;
  if (task.target.kind !== "command") throw new Error("invariant: command target");
  const { cmd } = task.target;
  const spawnCmd = resolveNestedAkmCommand(cmd);

  const timeoutMs: number | null = task.timeoutMs !== undefined ? task.timeoutMs : null;

  const header = `[akm task] task=${task.id} kind=command cmd=${cmd.join(" ")}`;
  const logLines: string[] = [header];
  const dbLines: TaskLogLineInput[] = [{ line: header }];

  let exitCode: number | null = null;

  try {
    // Managed spawn (src/core/subprocess.ts): process-GROUP kill so a timeout
    // reaps the whole command tree (no orphans), and a SIGTERM→SIGKILL ladder
    // so a child that ignores SIGTERM can't wedge the run forever.
    const result = await runManagedSubprocess(spawnCmd, {
      capture: true,
      cwd: process.env.HOME ?? os.tmpdir(),
      // Stamp task-runner provenance so any akm invocation in the command tree
      // records usage events as machine traffic, not user demand (DRIFT-6).
      // A more specific stamp already in the environment (e.g. improve's
      // AKM_EVENT_SOURCE=improve on its child spawns) still wins in children.
      env: { ...process.env, AKM_EVENT_SOURCE: process.env.AKM_EVENT_SOURCE ?? "task" },
      timeoutMs,
      ...(input.spawnFn ? { spawnFn: input.spawnFn } : {}),
      ...(input.setTimeoutFn ? { setTimeoutFn: input.setTimeoutFn } : {}),
      ...(input.clearTimeoutFn ? { clearTimeoutFn: input.clearTimeoutFn } : {}),
    });
    // A synchronous spawn throw / exit rejection surfaces as spawn_error below.
    if (result.spawnError) throw result.spawnError;

    const { stdout, stderr, timedOut } = result;
    exitCode = result.exitCode ?? (timedOut ? 143 : 1);

    if (timedOut) {
      logLines.push(`timed_out=true timeout_ms=${timeoutMs}`);
      dbLines.push({ level: "error", line: `timed_out=true timeout_ms=${timeoutMs}` });
    }
    logLines.push(`exit_code=${exitCode}`);
    dbLines.push({ level: exitCode === 0 ? "info" : "error", line: `exit_code=${exitCode}` });
    if (stdout) {
      logLines.push("--- stdout ---");
      logLines.push(stdout);
      dbLines.push(...streamLines(stdout, "stdout", "info"));
    }
    if (stderr) {
      logLines.push("--- stderr ---");
      logLines.push(stderr);
      dbLines.push(...streamLines(stderr, "stderr", "error"));
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logLines.push(`spawn_error=${msg}`);
    dbLines.push({ level: "error", line: `spawn_error=${msg}` });
    exitCode = 1;
  }

  const finishedAt = finishAttempt(startedAt, now());
  persistRunLog({
    taskId: task.id,
    startedAtIso: startedAt.toISOString(),
    finishedAtIso: finishedAt.toISOString(),
    logPath,
    fileText: `${logLines.join("\n")}\n`,
    dbLines,
  });
  const status: TaskRunStatus = exitCode === 0 ? "completed" : "failed";
  const result: TaskRunResult = {
    id: task.id,
    status,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    log: logPath,
    target: { kind: "command", cmd },
    detail: { exitCode },
  };
  appendHistory(result, historyReserved);
  return result;
}

/** Avoid a second PATH lookup when a task invokes the same AKM installation. */
function resolveNestedAkmCommand(cmd: string[]): string[] {
  const akmIndex = findBareAkmExecutableIndex(cmd);
  if (akmIndex === undefined) return cmd;
  return [...cmd.slice(0, akmIndex), ...resolveAkmInvocation().argv, ...cmd.slice(akmIndex + 1)];
}

// ── workflow target ─────────────────────────────────────────────────────────

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

async function runWorkflowTask(input: {
  task: TaskDocument;
  logPath: string;
  startedAt: Date;
  now: () => Date;
  runWorkflowStepsImpl: typeof runWorkflowSteps;
  historyReserved: boolean;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}): Promise<TaskRunResult> {
  const { task, logPath, startedAt, now, runWorkflowStepsImpl, historyReserved } = input;
  if (task.target.kind !== "workflow") throw new Error("invariant: workflow target");
  const workflowTarget = task.target;
  const ref = parseRefInput(workflowTarget.ref);
  if (ref.type !== "workflow") {
    throw new NotFoundError(
      `Task "${task.id}" workflow target must be a workflow ref (got "${workflowTarget.ref}").`,
      "WORKFLOW_NOT_FOUND",
    );
  }

  // Unset → the unattended default; `null` → the explicit no-timeout opt-out.
  const timeoutMs =
    workflowTarget.timeoutMs === undefined ? DEFAULT_WORKFLOW_TASK_TIMEOUT_MS : workflowTarget.timeoutMs;
  const setTimeoutImpl = input.setTimeoutFn ?? setTimeout;
  const clearTimeoutImpl = input.clearTimeoutFn ?? clearTimeout;
  // Same wiring `akm workflow run --timeout` uses (commands/workflow-cli.ts):
  // one AbortController for the run's lifetime, aborted by a timer. The engine
  // reads `options.signal` at every step boundary and breaks GRACEFULLY —
  // in-flight units are cancelled, the journal and the run lease are retained,
  // and the run is left `active`, i.e. resumable with `akm workflow resume`.
  const controller = new AbortController();
  let timedOut = false;
  const timer =
    timeoutMs === null
      ? undefined
      : setTimeoutImpl(() => {
          timedOut = true;
          controller.abort(new Error(`Workflow task "${task.id}" timed out after ${timeoutMs}ms.`));
        }, timeoutMs);
  (timer as unknown as { unref?: () => void } | undefined)?.unref?.();

  let detail: WorkflowRunSummary | undefined;
  let gateError: string | undefined;
  let error: Error | undefined;
  // The prompt path logs the engine-fallback announcement; a workflow-backed
  // task must leave the same trace rather than silently using a chosen engine.
  let runWarnings: string[] = [];
  try {
    const execution = await runWorkflowStepsImpl({
      target: workflowTarget.ref,
      params: workflowTarget.params,
      signal: controller.signal,
      ...(workflowTarget.maxSteps !== undefined ? { maxSteps: workflowTarget.maxSteps } : {}),
      ...(workflowTarget.maxRetries !== undefined ? { maxRetries: workflowTarget.maxRetries } : {}),
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
    if (timer !== undefined) clearTimeoutImpl(timer);
  }

  // A timeout is a failed ATTEMPT even though the engine stopped cleanly: the
  // aborted run comes back `active` (resumable), which on its own would map to
  // task status "active" and a 0 exit code, telling the OS scheduler nothing
  // went wrong. Surface it like the command target's `timed_out=true` instead.
  const timedOutAfterMs = timedOut && timeoutMs !== null ? timeoutMs : undefined;
  const timeoutError =
    timedOutAfterMs === undefined
      ? undefined
      : new Error(
          `Workflow run timed out after ${timedOutAfterMs}ms and was aborted at a step boundary` +
            (detail?.id ? ` — resume it with \`akm workflow resume ${detail.id}\`.` : "."),
        );

  const finishedAt = finishAttempt(startedAt, now());
  const status: TaskRunStatus = error || gateError || timeoutError ? "failed" : mapWorkflowStatus(detail?.status);
  const log = renderWorkflowLog({
    task,
    detail,
    error: error ?? (gateError ? new Error(gateError) : timeoutError),
    warnings: runWarnings,
    ...(timedOutAfterMs !== undefined ? { timedOutAfterMs } : {}),
  });
  persistRunLog({
    taskId: task.id,
    startedAtIso: startedAt.toISOString(),
    finishedAtIso: finishedAt.toISOString(),
    logPath,
    fileText: log.fileText,
    dbLines: log.dbLines,
  });

  const result: TaskRunResult = {
    id: task.id,
    status,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    log: logPath,
    target: { kind: "workflow", ref: task.target.ref },
    detail: {
      runId: detail?.id,
      ...(error
        ? { error: error.message }
        : gateError
          ? { error: gateError }
          : timeoutError
            ? { error: timeoutError.message }
            : {}),
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
  task: TaskDocument;
  detail?: WorkflowRunSummary;
  error?: Error;
  warnings?: readonly string[];
  /** Set when the whole-run timeout fired; mirrors the command target's line. */
  timedOutAfterMs?: number;
}): RunLogContent {
  const dbLines: TaskLogLineInput[] = [
    { line: `[akm task] task=${input.task.id} kind=workflow ref=${(input.task.target as { ref: string }).ref}` },
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

// ── prompt target ───────────────────────────────────────────────────────────

async function runPromptTask(input: {
  task: TaskDocument;
  stashDir: string;
  logPath: string;
  startedAt: Date;
  now: () => Date;
  runAgentImpl?: RunnerSeams["runAgent"];
  chatCompletionImpl: typeof chatCompletion;
  agentOptions?: Partial<RunAgentOptions>;
  historyReserved: boolean;
}): Promise<TaskRunResult> {
  const { task, stashDir, logPath, startedAt, now, agentOptions } = input;
  if (task.target.kind !== "prompt") throw new Error("invariant: prompt target");
  const promptTarget = task.target;

  // Same implicit opencode-sdk fallback the workflow freeze boundary applies,
  // so a scheduled prompt task on an engine-less install behaves identically.
  const { config, fallbackEngineName } = withEngineFallback(loadConfig());
  const engineName = promptTarget.engine ?? config.defaults?.engine;
  // `promptTarget.engine` outranks `defaults.engine`, so the fallback is only
  // reportable when it is the engine actually selected.
  const engineAnnouncement = fallbackAnnouncement(fallbackEngineName, engineName);
  if (!engineName)
    throw new NotFoundError(`Task "${task.id}" ${NO_ENGINE_MESSAGE_SUFFIX} ${NO_ENGINE_REMEDY}`, "ASSET_NOT_FOUND");
  let runner: RunnerSpec = resolveEngine(engineName, config);
  if (runner.kind === "llm") {
    const resolved = resolveLlmEngineUse(config, [
      {
        engine: engineName,
        ...(promptTarget.model !== undefined ? { model: promptTarget.model } : {}),
        ...(promptTarget.timeoutMs !== undefined ? { timeoutMs: promptTarget.timeoutMs } : {}),
        ...(promptTarget.llm !== undefined ? { llm: promptTarget.llm } : {}),
      },
    ]);
    runner = {
      kind: "llm",
      engine: resolved.engine,
      connection: resolved.connection,
      ...(resolved.credential ? { credential: resolved.credential } : {}),
      timeoutMs: resolved.timeoutMs,
    };
  } else {
    if (promptTarget.llm !== undefined) {
      throw new NotFoundError(
        `Task "${task.id}" uses llm overrides with non-LLM engine "${engineName}".`,
        "ASSET_NOT_FOUND",
      );
    }
    const requestedModel = promptTarget.model;
    const platform = runner.profile.platform;
    if (!platform) throw new Error(`Engine "${engineName}" resolved without a platform.`);
    const model = requestedModel
      ? resolveModel(requestedModel, platform, runner.profile.modelAliases, runner.profile.globalModelAliases)
      : runner.profile.model;
    runner = {
      ...runner,
      profile: { ...runner.profile, ...(model ? { model, modelIsExact: true } : {}) },
      ...(promptTarget.timeoutMs !== undefined ? { timeoutMs: promptTarget.timeoutMs } : {}),
    };
  }
  const promptText = await resolvePromptText(task, stashDir);

  const result = await executeRunner(
    runner,
    promptText,
    {
      stdio: "captured",
      cwd: stashDir,
      ...agentOptions,
      // Stamp task-runner provenance for any akm invocation the agent makes
      // (DRIFT-6: agent-task traffic must not be recorded as user demand).
      // Caller-supplied env still wins on conflicts.
      env: { AKM_EVENT_SOURCE: "task", ...agentOptions?.env },
    },
    {
      ...(input.runAgentImpl ? { runAgent: input.runAgentImpl } : {}),
      llm: async (spec, prompt, options) => {
        const started = Date.now();
        const stdout = await input.chatCompletionImpl(spec.connection, [{ role: "user", content: prompt }], {
          ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        });
        return { ok: true, exitCode: 0, stdout, stderr: "", durationMs: Date.now() - started };
      },
    },
  );

  const finishedAt = finishAttempt(startedAt, now());
  const log = renderPromptLog({ task, engineName, result, engineAnnouncement });
  persistRunLog({
    taskId: task.id,
    startedAtIso: startedAt.toISOString(),
    finishedAtIso: finishedAt.toISOString(),
    logPath,
    fileText: log.fileText,
    dbLines: log.dbLines,
  });

  const status: TaskRunStatus = result.ok ? "completed" : "failed";
  const out: TaskRunResult = {
    id: task.id,
    status,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    log: logPath,
    target: { kind: "prompt", engine: engineName },
    detail: result.ok
      ? { exitCode: result.exitCode }
      : { reason: result.reason, error: result.error, exitCode: result.exitCode },
  };
  appendHistory(out, input.historyReserved);
  return out;
}

async function resolvePromptText(task: TaskDocument, stashDir: string): Promise<string> {
  if (task.target.kind !== "prompt") throw new Error("invariant: prompt target");
  const src = task.target.source;
  if (src.kind === "inline") return src.text;
  if (src.kind === "file") {
    const taskDir = path.dirname(task.source.path);
    const filePath = path.isAbsolute(src.path) ? src.path : path.resolve(taskDir, src.path);
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      throw new NotFoundError(`Prompt file not found: ${filePath}`, "FILE_NOT_FOUND");
    }
    return fs.readFileSync(filePath, "utf8");
  }
  // asset
  const ref = parseRefInput(src.ref);
  // D11 — see the matching guard in validator.ts: `resolveAssetPath`
  // (src/sources/resolve.ts) is placement-dir-only and cannot route an
  // opaque adapter conceptId, which `parseRefInput` now otherwise accepts.
  if (placementSpecFor(ref.type) === undefined) {
    throw new NotFoundError(
      `Task "${task.id}" prompt asset ref "${src.ref}" is not an AKM-placed asset — adapter-owned (opaque) prompt sources are not resolvable as task inputs yet.`,
      "ASSET_NOT_FOUND",
    );
  }
  const assetPath = await resolveAssetPath(stashDir, ref.type, ref.name);
  return fs.readFileSync(assetPath, "utf8");
}

function renderPromptLog(input: {
  task: TaskDocument;
  engineName: string;
  result: AgentRunResult;
  engineAnnouncement?: string;
}): RunLogContent {
  const lines: string[] = [];
  const dbLines: TaskLogLineInput[] = [];
  const header = `[akm task] task=${input.task.id} kind=prompt engine=${input.engineName}`;
  const summary = `ok=${input.result.ok} exit_code=${input.result.exitCode ?? "null"} duration_ms=${input.result.durationMs}`;
  lines.push(header, summary);
  dbLines.push({ line: header }, { level: input.result.ok ? "info" : "error", line: summary });
  if (input.engineAnnouncement) {
    lines.push(input.engineAnnouncement);
    dbLines.push({ level: "warn", line: input.engineAnnouncement });
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

// ── run logs ────────────────────────────────────────────────────────────────

/**
 * A finished run's log in both shapes: the flat text written to the per-run
 * log file (transitional human tail) and the structured per-line rows written
 * to logs.db (the queryable record — see src/core/logs-db.ts and
 * the #579 logs audit).
 */
interface RunLogContent {
  fileText: string;
  dbLines: readonly TaskLogLineInput[];
}

function taskLogPath(logDir: string, taskId: string, startedAtIso: string): string {
  const tsSlug = startedAtIso.replace(/[:.]/g, "-");
  return path.join(logDir, taskId, `${tsSlug}.log`);
}

function resolveTaskLogPath(logDir: string | undefined, taskId: string, startedAtIso: string): string {
  try {
    return taskLogPath(logDir ?? getTaskLogDir(), taskId, startedAtIso);
  } catch (error) {
    rethrowIfTestIsolationError(error);
    return "";
  }
}

/** Split captured pipe output into per-line logs.db rows (blank lines dropped). */
function streamLines(text: string, stream: TaskLogStream, level: TaskLogLevel): TaskLogLineInput[] {
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => ({ stream, level, line }));
}

/**
 * Persist a finished run's log: the flat text file (so `log_path` in
 * task_history keeps resolving for humans and older consumers) plus
 * structured rows in logs.db keyed by `buildTaskRunId(taskId, startedAt)`.
 *
 * Both sinks are pattern-redacted (`redactCredentialPatterns`) before being
 * written — task output is raw command/agent/LLM text that can echo a
 * credential-bearing URL (e.g. a Discord webhook) nothing upstream expects to
 * scrub.
 *
 * The DB write is best-effort, mirroring {@link appendHistory}: an unwritable
 * logs.db must never fail a task run.
 */
function persistRunLog(input: {
  taskId: string;
  startedAtIso: string;
  finishedAtIso: string;
  logPath: string;
  fileText: string;
  dbLines: readonly TaskLogLineInput[];
}): void {
  const fileText = redactCredentialPatterns(input.fileText);
  const dbLines = input.dbLines.map((entry) => ({ ...entry, line: redactCredentialPatterns(entry.line) }));
  if (input.logPath) {
    try {
      fs.mkdirSync(path.dirname(input.logPath), { recursive: true });
      fs.writeFileSync(input.logPath, fileText);
    } catch (error) {
      rethrowIfTestIsolationError(error);
      // Transitional file logging is fully best-effort.
    }
  }
  try {
    const db = openLogsDatabase();
    try {
      insertTaskLogLines(db, {
        taskId: input.taskId,
        runId: buildTaskRunId(input.taskId, input.startedAtIso),
        ts: input.finishedAtIso,
        lines: dbLines,
      });
    } finally {
      db.close();
    }
  } catch (error) {
    rethrowIfTestIsolationError(error);
    // Structured logging is fully best-effort and must not alter CLI output.
  }
}

interface ReservedTaskAttempt {
  startedAt: Date;
  historyReserved: boolean;
}

/** Reserve a collision-free identity through state.db's existing unique index. */
function reserveTaskAttempt(taskId: string, requestedStartedAt: Date): ReservedTaskAttempt {
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

function finishAttempt(startedAt: Date, observedFinishedAt: Date): Date {
  return observedFinishedAt.getTime() < startedAt.getTime() ? new Date(startedAt) : observedFinishedAt;
}

const SAFE_TASK_ATTEMPT_ERROR_CODES = new Set([
  "CONFIG_DIR_UNRESOLVABLE",
  "STASH_DIR_NOT_FOUND",
  "STASH_DIR_NOT_A_DIRECTORY",
  "STASH_DIR_UNREADABLE",
  "LLM_NOT_CONFIGURED",
  "INVALID_CONFIG_FILE",
  "UNSUPPORTED_CONFIG_VERSION",
  "TEST_ISOLATION_MISSING",
  "INVALID_FLAG_VALUE",
  "MISSING_REQUIRED_ARGUMENT",
  "PATH_ESCAPE_VIOLATION",
  "TASK_SCHEMA_VERSION_UNSUPPORTED",
  "ASSET_NOT_FOUND",
  "WORKFLOW_NOT_FOUND",
  "FILE_NOT_FOUND",
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

// ── history ─────────────────────────────────────────────────────────────────

function appendHistory(result: TaskRunResult, historyReserved = false): void {
  const row = {
    task_id: result.id,
    status: result.status,
    started_at: result.startedAt,
    completed_at: result.finishedAt,
    failed_at: result.status === "failed" ? result.finishedAt : null,
    log_path: result.log || null,
    target_kind: result.target.kind === "unknown" ? null : result.target.kind,
    target_ref: result.target.kind === "workflow" ? result.target.ref : null,
    metadata_json: JSON.stringify({
      metadataVersion: 2,
      durationMs: result.durationMs,
      detail: result.detail ?? null,
      ...(result.target.kind === "prompt" ? { engine: result.target.engine } : {}),
    }),
  };
  try {
    withStateDb((db) => {
      if (historyReserved && finalizeTaskHistoryAttempt(db, row)) return;
      upsertTaskHistory(db, row);
    });
  } catch (error) {
    rethrowIfTestIsolationError(error);
    // History recording is fully best-effort and must not alter CLI output.
  }
}

/**
 * Read recent history rows for one or all tasks.
 *
 * Returns rows in reverse-chronological order, optionally limited.
 */
export interface ReadHistoryOptions {
  id?: string;
  limit?: number;
}

export function readTaskHistory(options: ReadHistoryOptions = {}): TaskRunResult[] {
  return withStateDb((db) => {
    if (options.limit === 0) return [];
    if (options.id) {
      const row = getTaskHistory(db, options.id);
      return row ? [taskHistoryRowToResult(row)] : [];
    }
    return queryTaskHistory(db, options.limit !== undefined && options.limit > 0 ? { limit: options.limit } : {}).map(
      taskHistoryRowToResult,
    );
  });
}

/**
 * Convert a `TaskHistoryRow` from state.db back to a `TaskRunResult` shape
 * that callers of `readTaskHistory()` expect.
 */
function taskHistoryRowToResult(
  row: import("../storage/repositories/task-history-repository").TaskHistoryRow,
): TaskRunResult {
  const meta = decodeTaskHistoryMetadata(row.metadata_json);

  const target: TaskRunResult["target"] =
    row.target_kind === "workflow"
      ? { kind: "workflow", ref: row.target_ref ?? "" }
      : row.target_kind === "command"
        ? { kind: "command" }
        : row.target_kind === "prompt"
          ? meta.metadataVersion === 1
            ? {
                kind: "prompt",
                engine: null,
                ...(meta.legacyProfile !== undefined ? { legacyProfile: meta.legacyProfile } : {}),
              }
            : { kind: "prompt", engine: meta.engine ?? null }
          : { kind: "unknown" };

  return {
    id: row.task_id,
    status: row.status as TaskRunStatus,
    startedAt: row.started_at,
    finishedAt: row.completed_at ?? row.failed_at ?? row.started_at,
    durationMs: meta.durationMs,
    log: row.log_path ?? "",
    target,
    ...(meta.detail ? { detail: meta.detail } : {}),
  };
}

/**
 * The exit code surfaced to the OS scheduler. Mapped from {@link TaskRunStatus}
 * so cron / launchd / schtasks see a useful return value.
 */
export function exitCodeForStatus(status: TaskRunStatus): number {
  switch (status) {
    case "completed":
      return 0;
    case "active":
      return 0;
    case "blocked":
      return 1;
    case "failed":
      return 1;
    case "disabled":
      return 0;
  }
}
