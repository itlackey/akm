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
 *   6. Append a JSONL row to `<cacheDir>/tasks/history/<id>.jsonl`.
 *
 * Returns a structured result so the CLI handler can shape it for `output()`
 * and so tests can assert against it without scraping stdout.
 */

import fs from "node:fs";
import path from "node:path";
import { parseAssetRef } from "../core/asset-ref";
import { resolveStashDir } from "../core/common";
import { loadConfig } from "../core/config";
import { NotFoundError, UsageError } from "../core/errors";
import { getTaskHistoryDir, getTaskLogDir } from "../core/paths";
import { type AgentRunResult, type RunAgentOptions, requireAgentProfile, runAgent } from "../integrations/agent";
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
  /** Override history dir (tests). */
  historyDir?: string;
  /** Extra args/env to pass through to runAgent (tests). */
  agentOptions?: Partial<RunAgentOptions>;
}

export async function runTask(id: string, options: RunTaskOptions = {}): Promise<TaskRunResult> {
  const stashDir = options.stashDir ?? resolveStashDir();
  const runAgentImpl = options.runAgentImpl ?? runAgent;
  const startWorkflowRunImpl = options.startWorkflowRunImpl ?? startWorkflowRun;
  const now = options.now ?? (() => new Date());
  const logDir = options.logDir ?? getTaskLogDir();
  const historyDir = options.historyDir ?? getTaskHistoryDir();

  const filePath = await resolveAssetPath(stashDir, "task", id);
  const markdown = fs.readFileSync(filePath, "utf8");
  const task = parseTaskDocument({ markdown, filePath, id });

  const startedAt = now();
  const startedIso = startedAt.toISOString();
  const tsSlug = startedIso.replace(/[:.]/g, "-");
  const taskLogDir = path.join(logDir, id);
  fs.mkdirSync(taskLogDir, { recursive: true });
  fs.mkdirSync(historyDir, { recursive: true });
  const logPath = path.join(taskLogDir, `${tsSlug}.log`);

  if (!task.enabled) {
    const finishedAt = now();
    const result: TaskRunResult = {
      id,
      status: "disabled",
      startedAt: startedIso,
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      log: logPath,
      target:
        task.target.kind === "workflow"
          ? { kind: "workflow", ref: task.target.ref }
          : { kind: "prompt", profile: task.target.profile },
    };
    fs.writeFileSync(logPath, `[akm tasks] task "${id}" is disabled — skipping run.\n`);
    appendHistory(historyDir, id, result);
    return result;
  }

  if (task.target.kind === "workflow") {
    return await runWorkflowTask({
      task,
      stashDir,
      logPath,
      historyDir,
      startedAt,
      now,
      startWorkflowRunImpl,
    });
  }
  return await runPromptTask({
    task,
    stashDir,
    logPath,
    historyDir,
    startedAt,
    now,
    runAgentImpl,
    agentOptions: options.agentOptions,
  });
}

// ── workflow target ─────────────────────────────────────────────────────────

async function runWorkflowTask(input: {
  task: TaskDocument;
  stashDir: string;
  logPath: string;
  historyDir: string;
  startedAt: Date;
  now: () => Date;
  startWorkflowRunImpl: typeof startWorkflowRun;
}): Promise<TaskRunResult> {
  const { task, logPath, historyDir, startedAt, now, startWorkflowRunImpl } = input;
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
  appendHistory(historyDir, task.id, result);
  if (error) throw error;
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
  historyDir: string;
  startedAt: Date;
  now: () => Date;
  runAgentImpl: (...args: Parameters<typeof runAgent>) => Promise<AgentRunResult>;
  agentOptions?: Partial<RunAgentOptions>;
}): Promise<TaskRunResult> {
  const { task, stashDir, logPath, historyDir, startedAt, now, runAgentImpl, agentOptions } = input;
  if (task.target.kind !== "prompt") throw new Error("invariant: prompt target");

  const config = loadConfig();
  const profile = requireAgentProfile(config.agent, task.target.profile);
  const promptText = await resolvePromptText(task, stashDir);

  const result = await runAgentImpl(profile, promptText, {
    stdio: "captured",
    timeoutMs: config.agent?.timeoutMs,
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
  appendHistory(historyDir, task.id, out);
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

function appendHistory(historyDir: string, id: string, result: TaskRunResult): void {
  const file = path.join(historyDir, `${id}.jsonl`);
  fs.mkdirSync(historyDir, { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(result)}\n`);
}

/**
 * Read recent history rows for one or all tasks.
 *
 * Returns rows in reverse-chronological order, optionally limited.
 */
export interface ReadHistoryOptions {
  id?: string;
  limit?: number;
  historyDir?: string;
}

export function readTaskHistory(options: ReadHistoryOptions = {}): TaskRunResult[] {
  const dir = options.historyDir ?? getTaskHistoryDir();
  if (!fs.existsSync(dir)) return [];
  const files = options.id
    ? [path.join(dir, `${options.id}.jsonl`)].filter((f) => fs.existsSync(f))
    : fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => path.join(dir, f));
  const rows: TaskRunResult[] = [];
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        rows.push(JSON.parse(line) as TaskRunResult);
      } catch {
        // skip malformed lines
      }
    }
  }
  rows.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  if (options.limit !== undefined && options.limit >= 0) {
    return rows.slice(0, options.limit);
  }
  return rows;
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

// ── Re-export so the CLI can avoid double-imports ───────────────────────────
export { UsageError };
