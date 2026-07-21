// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm tasks run <id>` — what cron / launchd / schtasks invoke at the
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
 *        • workflow → `startWorkflowRun(ref, params)`
 *        • prompt   → `executeRunner(engine, prompt, { stdio: "captured" })`
 *   5. Capture stdout / stderr as structured rows in logs.db (task_logs) and,
 *      transitionally, as a flat text tail at `<cacheDir>/tasks/logs/<id>/<ts>.log`
 *      (see docs/technical/logs-audit.md).
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
import { withStateDb } from "../core/state-db";
import { runManagedSubprocess, type SpawnFn } from "../core/subprocess";
import type { AgentRunResult, RunAgentOptions } from "../integrations/agent";
import { resolveEngine, resolveLlmEngineUse } from "../integrations/agent/engine-resolution";
import { resolveModel } from "../integrations/agent/model-aliases";
import type { RunnerSpec } from "../integrations/agent/runner";
import { executeRunner, type RunnerSeams } from "../integrations/agent/runner-dispatch";
import { chatCompletion } from "../llm/client";
import { resolveAssetPath } from "../sources/resolve";
import type { WorkflowRunStatus } from "../sources/types";
import {
  decodeTaskHistoryMetadata,
  finalizeTaskHistoryAttempt,
  getTaskHistory,
  queryTaskHistory,
  reserveTaskHistoryAttempt,
  upsertTaskHistory,
} from "../storage/repositories/task-history-repository";
import type { WorkflowRunDetail } from "../workflows/runtime/runs";
import { startWorkflowRun } from "../workflows/runtime/runs";
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
   * `akm tasks run` command boundary (WI-9.10 CLI-wide sweep) and threaded in —
   * this runner no longer reads the ambient stash-dir resolver.
   */
  stashDir: string;
  /** Override the agent runner (tests). Defaults to {@link runAgent}. */
  runAgentImpl?: RunnerSeams["runAgent"];
  /**
   * Override the workflow runner (tests). Defaults to
   * {@link startWorkflowRun}.
   */
  startWorkflowRunImpl?: typeof startWorkflowRun;
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
  /** Override the command-target kill-ladder timers (tests). Default to the globals. */
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  /** True only for an invocation generated by a scheduler backend. */
  scheduled?: boolean;
}

export async function runTask(id: string, options: RunTaskOptions): Promise<TaskRunResult> {
  const runAgentImpl = options.runAgentImpl;
  const startWorkflowRunImpl = options.startWorkflowRunImpl ?? startWorkflowRun;
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
      const disabledLine = `[akm tasks] task "${id}" is disabled — skipping run.`;
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
        startWorkflowRunImpl,
        historyReserved: attempt.historyReserved,
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

  const header = `[akm tasks] task=${task.id} kind=command cmd=${cmd.join(" ")}`;
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

async function runWorkflowTask(input: {
  task: TaskDocument;
  logPath: string;
  startedAt: Date;
  now: () => Date;
  startWorkflowRunImpl: typeof startWorkflowRun;
  historyReserved: boolean;
}): Promise<TaskRunResult> {
  const { task, logPath, startedAt, now, startWorkflowRunImpl, historyReserved } = input;
  if (task.target.kind !== "workflow") throw new Error("invariant: workflow target");
  const ref = parseRefInput(task.target.ref);
  if (ref.type !== "workflow") {
    throw new NotFoundError(
      `Task "${task.id}" workflow target must be a workflow ref (got "${task.target.ref}").`,
      "WORKFLOW_NOT_FOUND",
    );
  }

  let detail: WorkflowRunDetail | undefined;
  let error: Error | undefined;
  try {
    detail = await startWorkflowRunImpl(task.target.ref, task.target.params);
  } catch (e) {
    if (e instanceof AkmError && e.kind === "config") throw e;
    error = e instanceof Error ? e : new Error(String(e));
  }

  const finishedAt = finishAttempt(startedAt, now());
  const status: TaskRunStatus = error ? "failed" : mapWorkflowStatus(detail?.run.status);
  const log = renderWorkflowLog({ task, detail, error });
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
      runId: detail?.run.id,
      ...(error ? { error: error.message } : {}),
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
 * Workflows can legitimately remain `active` after `startWorkflowRun`
 * returns (multi-step workflows pause for user input); recording them as
 * "completed" would be misleading. We preserve "active" as a first-class
 * task status with exit code 0 — the OS scheduler treats it as success.
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

function renderWorkflowLog(input: { task: TaskDocument; detail?: WorkflowRunDetail; error?: Error }): RunLogContent {
  const dbLines: TaskLogLineInput[] = [
    { line: `[akm tasks] task=${input.task.id} kind=workflow ref=${(input.task.target as { ref: string }).ref}` },
  ];
  if (input.detail) {
    dbLines.push({ line: `run_id=${input.detail.run.id} status=${input.detail.run.status}` });
    dbLines.push({ line: `workflow_title=${input.detail.run.workflowTitle}` });
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

  const config = loadConfig();
  const engineName = promptTarget.engine ?? config.defaults?.engine;
  if (!engineName) throw new NotFoundError(`Task "${task.id}" has no selected engine.`, "ASSET_NOT_FOUND");
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
  const log = renderPromptLog({ task, engineName, result });
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
  const assetPath = await resolveAssetPath(stashDir, ref.type, ref.name);
  return fs.readFileSync(assetPath, "utf8");
}

function renderPromptLog(input: { task: TaskDocument; engineName: string; result: AgentRunResult }): RunLogContent {
  const lines: string[] = [];
  const dbLines: TaskLogLineInput[] = [];
  const header = `[akm tasks] task=${input.task.id} kind=prompt engine=${input.engineName}`;
  const summary = `ok=${input.result.ok} exit_code=${input.result.exitCode ?? "null"} duration_ms=${input.result.durationMs}`;
  lines.push(header, summary);
  dbLines.push({ line: header }, { level: input.result.ok ? "info" : "error", line: summary });
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
 * docs/technical/logs-audit.md).
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
  if (input.logPath) {
    try {
      fs.mkdirSync(path.dirname(input.logPath), { recursive: true });
      fs.writeFileSync(input.logPath, input.fileText);
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
        lines: input.dbLines,
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
  const line = `[akm tasks] status=failed reason=${input.reason} code=${errorCode}`;
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
    let rows: TaskRunResult[];
    if (options.id) {
      const row = getTaskHistory(db, options.id);
      rows = row ? [taskHistoryRowToResult(row)] : [];
    } else {
      rows = queryTaskHistory(db, {}).map(taskHistoryRowToResult);
    }
    rows.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
    if (options.limit !== undefined && options.limit >= 0) {
      return rows.slice(0, options.limit);
    }
    return rows;
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
          ? meta.metadataVersion === 2
            ? { kind: "prompt", engine: meta.engine ?? null }
            : { kind: "prompt", engine: null, ...(meta.legacyProfile ? { legacyProfile: meta.legacyProfile } : {}) }
          : { kind: "unknown" };

  return {
    id: row.task_id,
    status: row.status as TaskRunStatus,
    startedAt: row.started_at,
    finishedAt: row.completed_at ?? row.failed_at ?? row.started_at,
    durationMs: meta.durationMs ?? 0,
    log: row.log_path ?? "",
    target,
    ...(meta.detail !== undefined && meta.detail !== null ? { detail: meta.detail } : {}),
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
