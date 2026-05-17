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
 *   3. Refuse to run when `enabled === false` (defense-in-depth).
 *   4. Dispatch by target kind:
 *        • workflow → `startWorkflowRun(ref, params)`
 *        • prompt   → `runAgent(profile, prompt, { stdio: "captured" })`
 *   5. Capture stdout / stderr to `<cacheDir>/tasks/logs/<id>/<ts>.log`.
 *   6. Write a history row to state.db task_history table.
 *
 * Returns a structured result so the CLI handler can shape it for `output()`
 * and so tests can assert against it without scraping stdout.
 */

import fs from "node:fs";
import path from "node:path";
import { parseAssetRef } from "../core/asset-ref";
import { resolveStashDir } from "../core/common";
import { loadConfig } from "../core/config";
import { NotFoundError } from "../core/errors";
import { getTaskLogDir } from "../core/paths";
import { getTaskHistory, openStateDatabase, queryTaskHistory, upsertTaskHistory } from "../core/state-db";
import { error } from "../core/warn";
import { type AgentRunResult, type RunAgentOptions, requireAgentProfile, runAgent } from "../integrations/agent";
import { resolveProcessAgentProfile } from "../integrations/agent/config";
import { resolveAssetPath } from "../sources/resolve";
import type { WorkflowRunDetail } from "../workflows/runs";
import { startWorkflowRun } from "../workflows/runs";
import { parseTaskDocument } from "./parser";
import type { TaskDocument } from "./schema";

export type TaskRunStatus = "completed" | "blocked" | "failed" | "disabled" | "active";

export interface TaskRunResult {
  id: string;
  status: TaskRunStatus;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  log: string;
  target: { kind: "workflow"; ref: string } | { kind: "prompt"; profile?: string };
  /** Workflow run id (for workflow targets) or agent reason/error (for prompt targets). */
  detail?: { runId?: string; reason?: string; error?: string; exitCode?: number | null };
}

export interface RunTaskOptions {
  /** Override stash dir resolution (tests). */
  stashDir?: string;
  /** Override the agent runner (tests). Defaults to {@link runAgent}. */
  runAgentImpl?: (...args: Parameters<typeof runAgent>) => Promise<AgentRunResult>;
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
}

export async function runTask(id: string, options: RunTaskOptions = {}): Promise<TaskRunResult> {
  const stashDir = options.stashDir ?? resolveStashDir();
  const runAgentImpl = options.runAgentImpl ?? runAgent;
  const startWorkflowRunImpl = options.startWorkflowRunImpl ?? startWorkflowRun;
  const now = options.now ?? (() => new Date());
  const logDir = options.logDir ?? getTaskLogDir();

  const filePath = await resolveAssetPath(stashDir, "task", id);
  const yaml = fs.readFileSync(filePath, "utf8");
  const task = parseTaskDocument({ yaml, filePath, id });

  const startedAt = now();
  const startedIso = startedAt.toISOString();
  const tsSlug = startedIso.replace(/[:.]/g, "-");
  const taskLogDir = path.join(logDir, id);
  fs.mkdirSync(taskLogDir, { recursive: true });
  const logPath = path.join(taskLogDir, `${tsSlug}.log`);

  if (!task.enabled) {
    const finishedAt = now();
    const disabledTarget: TaskRunResult["target"] =
      task.target.kind === "workflow"
        ? { kind: "workflow", ref: task.target.ref }
        : task.target.kind === "command"
          ? { kind: "prompt", profile: undefined }
          : { kind: "prompt", profile: task.target.profile };
    const result: TaskRunResult = {
      id,
      status: "disabled",
      startedAt: startedIso,
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      log: logPath,
      target: disabledTarget,
    };
    fs.writeFileSync(logPath, `[akm tasks] task "${id}" is disabled — skipping run.\n`);
    appendHistory(result);
    return result;
  }

  if (task.target.kind === "workflow") {
    return await runWorkflowTask({
      task,
      logPath,
      startedAt,
      now,
      startWorkflowRunImpl,
    });
  }

  if (task.target.kind === "command") {
    return await runCommandTask({ task, logPath, startedAt, now });
  }

  // Resolve config once here so runPromptTask does not call loadConfig()
  // on every dispatch in a batch run (Fix C6).
  const config = loadConfig();
  return await runPromptTask({
    task,
    stashDir,
    logPath,
    startedAt,
    now,
    runAgentImpl,
    agentOptions: options.agentOptions,
    agentConfig: config.agent,
    agentTimeoutMs: config.agent?.timeoutMs ?? undefined,
  });
}

// ── command target ──────────────────────────────────────────────────────────

async function runCommandTask(input: {
  task: TaskDocument;
  logPath: string;
  startedAt: Date;
  now: () => Date;
}): Promise<TaskRunResult> {
  const { task, logPath, startedAt, now } = input;
  if (task.target.kind !== "command") throw new Error("invariant: command target");
  const { cmd } = task.target;

  const timeoutMs: number | null = task.timeoutMs !== undefined ? task.timeoutMs : null;

  const logLines: string[] = [`[akm tasks] task=${task.id} kind=command cmd=${cmd.join(" ")}`];

  let stdout = "";
  let stderr = "";
  let exitCode: number | null = null;

  try {
    const proc = Bun.spawn(cmd, {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    if (timeoutMs !== null) {
      timer = setTimeout(() => {
        timedOut = true;
        try {
          proc.kill("SIGTERM");
        } catch {
          /* ignore */
        }
      }, timeoutMs);
    }

    const [stdoutBuf, stderrBuf] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;
    if (timer !== undefined) clearTimeout(timer);

    stdout = stdoutBuf;
    stderr = stderrBuf;
    exitCode = proc.exitCode ?? (timedOut ? 143 : 1);

    if (timedOut) {
      logLines.push(`timed_out=true timeout_ms=${timeoutMs}`);
    }
    logLines.push(`exit_code=${exitCode}`);
    if (stdout) {
      logLines.push("--- stdout ---");
      logLines.push(stdout);
    }
    if (stderr) {
      logLines.push("--- stderr ---");
      logLines.push(stderr);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logLines.push(`spawn_error=${msg}`);
    exitCode = 1;
  }

  fs.writeFileSync(logPath, `${logLines.join("\n")}\n`);
  const finishedAt = now();
  const status: TaskRunStatus = exitCode === 0 ? "completed" : "failed";
  const result: TaskRunResult = {
    id: task.id,
    status,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    log: logPath,
    target: { kind: "prompt", profile: undefined },
    detail: { exitCode },
  };
  appendHistory(result);
  return result;
}

// ── workflow target ─────────────────────────────────────────────────────────

async function runWorkflowTask(input: {
  task: TaskDocument;
  logPath: string;
  startedAt: Date;
  now: () => Date;
  startWorkflowRunImpl: typeof startWorkflowRun;
}): Promise<TaskRunResult> {
  const { task, logPath, startedAt, now, startWorkflowRunImpl } = input;
  if (task.target.kind !== "workflow") throw new Error("invariant: workflow target");
  const ref = parseAssetRef(task.target.ref);
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
    error = e instanceof Error ? e : new Error(String(e));
  }

  const finishedAt = now();
  const status: TaskRunStatus = error ? "failed" : mapWorkflowStatus(detail?.run.status);
  const log = renderWorkflowLog({ task, detail, error });
  fs.writeFileSync(logPath, log);

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
  appendHistory(result);
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
 */
function mapWorkflowStatus(status: string | undefined): TaskRunStatus {
  switch (status) {
    case "completed":
    case "blocked":
    case "failed":
    case "active":
      return status;
    default:
      return "completed";
  }
}

function renderWorkflowLog(input: { task: TaskDocument; detail?: WorkflowRunDetail; error?: Error }): string {
  const lines: string[] = [];
  lines.push(`[akm tasks] task=${input.task.id} kind=workflow ref=${(input.task.target as { ref: string }).ref}`);
  if (input.detail) {
    lines.push(`run_id=${input.detail.run.id} status=${input.detail.run.status}`);
    lines.push(`workflow_title=${input.detail.run.workflowTitle}`);
  }
  if (input.error) {
    lines.push(`error=${input.error.message}`);
  }
  return `${lines.join("\n")}\n`;
}

// ── prompt target ───────────────────────────────────────────────────────────

async function runPromptTask(input: {
  task: TaskDocument;
  stashDir: string;
  logPath: string;
  startedAt: Date;
  now: () => Date;
  runAgentImpl: (...args: Parameters<typeof runAgent>) => Promise<AgentRunResult>;
  agentOptions?: Partial<RunAgentOptions>;
  /** Pre-resolved agent config (avoids re-reading config file per task in batch runs). */
  agentConfig?: ReturnType<typeof loadConfig>["agent"];
  /** Pre-resolved agent timeout (ms) from the calling context. null = no timeout. */
  agentTimeoutMs?: number | null;
}): Promise<TaskRunResult> {
  const { task, stashDir, logPath, startedAt, now, runAgentImpl, agentOptions } = input;
  if (task.target.kind !== "prompt") throw new Error("invariant: prompt target");

  // Use pre-resolved agent config when available to avoid redundant loadConfig()
  // calls in batch task runs (Fix C6). Fall back to loadConfig() for callers
  // that invoke runPromptTask directly without threading config.
  const agentCfg = input.agentConfig !== undefined ? input.agentConfig : loadConfig().agent;

  // Resolve the profile for this task. When the task doc specifies a profile,
  // use it directly. Otherwise fall back to the per-process config for "task"
  // (agent.processes["task"]), which itself falls back to agent.default.
  let profile: ReturnType<typeof requireAgentProfile>;
  let processTimeoutMs: number | undefined;
  if (task.target.profile) {
    // Task doc explicitly names a profile — honour it directly.
    profile = requireAgentProfile(agentCfg, task.target.profile);
  } else {
    // No per-task profile: use process config for "task" as a fallback.
    const resolved = resolveProcessAgentProfile("task", agentCfg);
    profile = resolved.profile;
    processTimeoutMs = resolved.timeoutMs;
  }

  // Task-level timeoutMs (including null = disabled) wins over global config.
  // Resolution: task.timeoutMs → process entry timeoutMs → input.agentTimeoutMs → agentCfg.timeoutMs.
  const agentTimeoutMs =
    task.timeoutMs !== undefined
      ? task.timeoutMs
      : processTimeoutMs !== undefined
        ? processTimeoutMs
        : input.agentTimeoutMs !== undefined
          ? input.agentTimeoutMs
          : agentCfg?.timeoutMs;
  const promptText = await resolvePromptText(task, stashDir);

  const result = await runAgentImpl(profile, promptText, {
    stdio: "captured",
    timeoutMs: agentTimeoutMs,
    cwd: stashDir,
    ...agentOptions,
  });

  const finishedAt = now();
  const log = renderPromptLog({ task, profileName: profile.name, result });
  fs.writeFileSync(logPath, log);

  const status: TaskRunStatus = result.ok ? "completed" : "failed";
  const out: TaskRunResult = {
    id: task.id,
    status,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    log: logPath,
    target: { kind: "prompt", profile: profile.name },
    detail: result.ok
      ? { exitCode: result.exitCode }
      : { reason: result.reason, error: result.error, exitCode: result.exitCode },
  };
  appendHistory(out);
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
  const ref = parseAssetRef(src.ref);
  const assetPath = await resolveAssetPath(stashDir, ref.type, ref.name);
  return fs.readFileSync(assetPath, "utf8");
}

function renderPromptLog(input: { task: TaskDocument; profileName: string; result: AgentRunResult }): string {
  const lines: string[] = [];
  lines.push(`[akm tasks] task=${input.task.id} kind=prompt profile=${input.profileName}`);
  lines.push(
    `ok=${input.result.ok} exit_code=${input.result.exitCode ?? "null"} duration_ms=${input.result.durationMs}`,
  );
  if (!input.result.ok) {
    lines.push(`reason=${input.result.reason ?? ""} error=${input.result.error ?? ""}`);
  }
  if (input.result.stdout) {
    lines.push("--- agent stdout ---");
    lines.push(input.result.stdout);
  }
  if (input.result.stderr) {
    lines.push("--- agent stderr ---");
    lines.push(input.result.stderr);
  }
  return `${lines.join("\n")}\n`;
}

// ── history ─────────────────────────────────────────────────────────────────

function appendHistory(result: TaskRunResult): void {
  try {
    const db = openStateDatabase();
    try {
      upsertTaskHistory(db, {
        task_id: result.id,
        status: result.status,
        started_at: result.startedAt,
        completed_at: result.finishedAt,
        failed_at: result.status === "failed" ? result.finishedAt : null,
        log_path: result.log,
        target_kind: result.target.kind,
        target_ref: result.target.kind === "workflow" ? result.target.ref : null,
        metadata_json: JSON.stringify({
          durationMs: result.durationMs,
          detail: result.detail ?? null,
          profile: result.target.kind === "prompt" ? result.target.profile : undefined,
        }),
      });
    } finally {
      db.close();
    }
  } catch (err) {
    error(`[akm] task history DB write failed: ${String(err)}`);
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
  const db = openStateDatabase();
  try {
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
  } finally {
    db.close();
  }
}

/**
 * Convert a `TaskHistoryRow` from state.db back to a `TaskRunResult` shape
 * that callers of `readTaskHistory()` expect.
 */
function taskHistoryRowToResult(row: import("../core/state-db").TaskHistoryRow): TaskRunResult {
  let meta: { durationMs?: number; detail?: TaskRunResult["detail"]; profile?: string } = {};
  try {
    meta = JSON.parse(row.metadata_json) as typeof meta;
  } catch {
    // ignore corrupt JSON
  }

  const target: TaskRunResult["target"] =
    row.target_kind === "workflow"
      ? { kind: "workflow", ref: row.target_ref ?? "" }
      : { kind: "prompt", profile: meta.profile };

  return {
    id: row.task_id,
    status: row.status as TaskRunStatus,
    startedAt: row.started_at,
    finishedAt: row.completed_at ?? row.failed_at ?? row.started_at,
    durationMs: meta.durationMs ?? 0,
    log: row.log_path ?? "",
    target,
    ...(meta.detail !== undefined ? { detail: meta.detail } : {}),
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
