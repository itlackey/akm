/**
 * `akm tasks` — register, inspect, run, and remove scheduled task assets.
 *
 * Each handler exported here is a pure function that performs the real work;
 * `src/cli.ts` wraps these in citty `defineCommand`s and shapes their return
 * values via `output()`.
 */

import fs from "node:fs";
import path from "node:path";
import { parseAssetRef } from "../core/asset-ref";
import { resolveAssetPathFromName } from "../core/asset-spec";
import { isWithin, resolveStashDir } from "../core/common";
import { loadConfig } from "../core/config";
import { ConfigError, NotFoundError, UsageError } from "../core/errors";
import { getTaskHistoryDir, getTaskLogDir } from "../core/paths";
import { listAgentProfileNames } from "../integrations/agent";
import { resolveAssetPath } from "../sources/resolve";
import { backendNameForPlatform, selectBackend } from "../tasks/backends";
import { parseTaskDocument } from "../tasks/parser";
import { resolveAkmInvocation } from "../tasks/resolveAkmBin";
import { exitCodeForStatus, readTaskHistory, runTask, type TaskRunResult } from "../tasks/runner";
import { parseSchedule, SCHEDULE_SUPPORTED_SUBSET_HINT, translateToCron } from "../tasks/schedule";
import type { TaskDocument } from "../tasks/schema";
import { validateTaskDocument } from "../tasks/validator";

export interface TasksAddInput {
  id: string;
  schedule: string;
  workflow?: string;
  prompt?: string;
  profile?: string;
  params?: string;
  description?: string;
  tags?: string[];
  disabled?: boolean;
  force?: boolean;
}

export interface TasksAddResult {
  id: string;
  ref: string;
  path: string;
  stashDir: string;
  schedule: string;
  enabled: boolean;
  backend: string;
  target: TaskDocument["target"];
}

export async function akmTasksAdd(input: TasksAddInput): Promise<TasksAddResult> {
  const id = normaliseTaskId(input.id);
  if ((input.workflow && input.prompt) || (!input.workflow && !input.prompt)) {
    throw new UsageError(
      "Pass exactly one of --workflow <ref> or --prompt <inline|asset-ref|./file.md>.",
      "INVALID_FLAG_VALUE",
    );
  }

  // Validate the schedule for the active backend before writing anything.
  const backend = backendNameForPlatform();
  parseSchedule(input.schedule, backend);

  const stashDir = resolveStashDir();
  const typeRoot = path.join(stashDir, "tasks");
  fs.mkdirSync(typeRoot, { recursive: true });

  const assetPath = resolveAssetPathFromName("task", typeRoot, id);
  if (!isWithin(assetPath, typeRoot)) {
    throw new UsageError(`Resolved task path escapes the stash: "${id}".`, "PATH_ESCAPE_VIOLATION");
  }
  if (fs.existsSync(assetPath) && !input.force) {
    throw new UsageError(
      `Task "${id}" already exists. Pass --force to overwrite, or use \`akm tasks remove ${id}\` first.`,
      "RESOURCE_ALREADY_EXISTS",
    );
  }

  const markdown = renderTaskMarkdown({
    id,
    schedule: input.schedule,
    workflow: input.workflow,
    prompt: input.prompt,
    profile: input.profile,
    params: input.params,
    description: input.description,
    tags: input.tags,
    enabled: input.disabled !== true,
  });

  const task = parseTaskDocument({ markdown, filePath: assetPath, id });
  await validateTaskDocument(task, { backend, stashDir });

  fs.writeFileSync(assetPath, markdown.endsWith("\n") ? markdown : `${markdown}\n`, "utf8");

  // Install in the OS scheduler. If install fails after the file was written,
  // delete the file so the on-disk state never claims a task is registered
  // when it isn't.
  try {
    const sched = selectBackend();
    await sched.install(task);
  } catch (err) {
    try {
      fs.rmSync(assetPath, { force: true });
    } catch {
      /* ignore */
    }
    throw err;
  }

  return {
    id,
    ref: `task:${id}`,
    path: assetPath,
    stashDir,
    schedule: task.schedule,
    enabled: task.enabled,
    backend,
    target: task.target,
  };
}

export interface TasksListResult {
  tasks: Array<{
    id: string;
    ref: string;
    path: string;
    schedule: string;
    enabled: boolean;
    target: TaskDocument["target"];
    description?: string;
    tags?: string[];
  }>;
}

export async function akmTasksList(): Promise<TasksListResult> {
  const stashDir = resolveStashDir();
  const typeRoot = path.join(stashDir, "tasks");
  if (!fs.existsSync(typeRoot)) return { tasks: [] };
  const files = fs.readdirSync(typeRoot).filter((f) => f.endsWith(".md"));
  const tasks: TasksListResult["tasks"] = [];
  for (const file of files) {
    const id = file.slice(0, -3);
    const filePath = path.join(typeRoot, file);
    let task: TaskDocument;
    try {
      task = parseTaskDocument({ markdown: fs.readFileSync(filePath, "utf8"), filePath, id });
    } catch {
      continue; // skip malformed files; `akm tasks show <id>` will surface the error
    }
    tasks.push({
      id: task.id,
      ref: `task:${task.id}`,
      path: filePath,
      schedule: task.schedule,
      enabled: task.enabled,
      target: task.target,
      description: task.description,
      tags: task.tags,
    });
  }
  return { tasks };
}

export async function akmTasksShow(id: string): Promise<{
  id: string;
  ref: string;
  path: string;
  schedule: string;
  cron: string;
  enabled: boolean;
  target: TaskDocument["target"];
  description?: string;
  tags?: string[];
}> {
  const normalised = normaliseTaskId(id);
  const stashDir = resolveStashDir();
  const filePath = await resolveAssetPath(stashDir, "task", normalised);
  const task = parseTaskDocument({
    markdown: fs.readFileSync(filePath, "utf8"),
    filePath,
    id: normalised,
  });
  const spec = parseSchedule(task.schedule, backendNameForPlatform());
  return {
    id: task.id,
    ref: `task:${task.id}`,
    path: filePath,
    schedule: task.schedule,
    cron: translateToCron(spec),
    enabled: task.enabled,
    target: task.target,
    description: task.description,
    tags: task.tags,
  };
}

export async function akmTasksRemove(id: string): Promise<{ id: string; removed: true; backend: string }> {
  const normalised = normaliseTaskId(id);
  const stashDir = resolveStashDir();
  const filePath = await resolveAssetPath(stashDir, "task", normalised);
  const sched = selectBackend();
  try {
    await sched.uninstall(normalised);
  } finally {
    fs.rmSync(filePath, { force: true });
  }
  return { id: normalised, removed: true, backend: sched.name };
}

export async function akmTasksSetEnabled(
  id: string,
  enabled: boolean,
): Promise<{ id: string; enabled: boolean; backend: string }> {
  const normalised = normaliseTaskId(id);
  const stashDir = resolveStashDir();
  const filePath = await resolveAssetPath(stashDir, "task", normalised);
  const markdown = fs.readFileSync(filePath, "utf8");
  const updated = setEnabledInMarkdown(markdown, enabled);
  fs.writeFileSync(filePath, updated, "utf8");
  const sched = selectBackend();
  await sched.setEnabled(normalised, enabled);
  return { id: normalised, enabled, backend: sched.name };
}

export interface TasksRunResultEnvelope {
  ok: boolean;
  result: TaskRunResult;
  exitCode: number;
}

export async function akmTasksRun(id: string): Promise<TasksRunResultEnvelope> {
  const normalised = normaliseTaskId(id);
  const result = await runTask(normalised);
  return {
    ok: result.status === "completed" || result.status === "disabled",
    result,
    exitCode: exitCodeForStatus(result.status),
  };
}

export interface TasksHistoryResult {
  rows: TaskRunResult[];
}

export async function akmTasksHistory(input: { id?: string; limit?: number }): Promise<TasksHistoryResult> {
  const limit = input.limit !== undefined && input.limit > 0 ? input.limit : 50;
  const id = input.id ? normaliseTaskId(input.id) : undefined;
  return { rows: readTaskHistory({ id, limit }) };
}

export interface TasksSyncResult {
  installed: string[];
  removed: string[];
  unchanged: string[];
  skipped: { id: string; reason: string }[];
  backend: string;
}

/**
 * Reconcile the on-disk task files with the OS scheduler.
 *   • install missing tasks (after validating them — invalid files are
 *     skipped with a per-task reason rather than aborting the whole sync)
 *   • remove orphan scheduler entries that no longer have a backing file
 */
export async function akmTasksSync(): Promise<TasksSyncResult> {
  const stashDir = resolveStashDir();
  const typeRoot = path.join(stashDir, "tasks");
  const fileIds = fs.existsSync(typeRoot)
    ? fs
        .readdirSync(typeRoot)
        .filter((f) => f.endsWith(".md"))
        .map((f) => f.slice(0, -3))
    : [];
  const sched = selectBackend();
  const backend = backendNameForPlatform();
  const present = new Set((await sched.list()).map((t) => t.id));
  const installed: string[] = [];
  const unchanged: string[] = [];
  const skipped: { id: string; reason: string }[] = [];

  for (const id of fileIds) {
    const filePath = path.join(typeRoot, `${id}.md`);
    let task: TaskDocument;
    try {
      task = parseTaskDocument({ markdown: fs.readFileSync(filePath, "utf8"), filePath, id });
    } catch (err) {
      skipped.push({ id, reason: err instanceof Error ? err.message : String(err) });
      continue;
    }
    try {
      await validateTaskDocument(task, { backend, stashDir });
    } catch (err) {
      skipped.push({ id, reason: err instanceof Error ? err.message : String(err) });
      continue;
    }
    if (present.has(id)) {
      unchanged.push(id);
    } else {
      await sched.install(task);
      installed.push(id);
    }
  }

  const removed: string[] = [];
  for (const installedId of present) {
    if (!fileIds.includes(installedId)) {
      await sched.uninstall(installedId);
      removed.push(installedId);
    }
  }
  return { installed, removed, unchanged, skipped, backend: sched.name };
}

export interface TasksDoctorResult {
  backend: string;
  akm: { argv: string[]; via: string };
  logDir: string;
  historyDir: string;
  agent: { defaultProfile?: string; available: string[] };
  scheduleSubset: string;
  warnings: string[];
}

export async function akmTasksDoctor(): Promise<TasksDoctorResult> {
  const warnings: string[] = [];
  let invocation: { argv: string[]; via: string } = { argv: [], via: "unresolved" };
  try {
    const r = resolveAkmInvocation();
    invocation = { argv: r.argv, via: r.via };
  } catch (err) {
    warnings.push(err instanceof Error ? err.message : String(err));
  }
  const backend = backendNameForPlatform();
  const config = loadConfig();
  const defaultProfile = config.agent?.default;
  const profiles = listAgentProfileNames(config.agent);

  return {
    backend,
    akm: invocation,
    logDir: getTaskLogDir(),
    historyDir: getTaskHistoryDir(),
    agent: { defaultProfile, available: profiles },
    scheduleSubset: SCHEDULE_SUPPORTED_SUBSET_HINT,
    warnings,
  };
}

// ── helpers ─────────────────────────────────────────────────────────────────

const VALID_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function normaliseTaskId(raw: string): string {
  const id = raw.trim().replace(/\.md$/, "");
  if (!id) {
    throw new UsageError("Task id must be non-empty.", "MISSING_REQUIRED_ARGUMENT");
  }
  if (!VALID_ID_RE.test(id)) {
    throw new UsageError(
      `Task id "${id}" is invalid. Use letters, digits, dots, underscores, and dashes only.`,
      "INVALID_FLAG_VALUE",
    );
  }
  return id;
}

interface RenderInput {
  id: string;
  schedule: string;
  workflow?: string;
  prompt?: string;
  profile?: string;
  params?: string;
  description?: string;
  tags?: string[];
  enabled: boolean;
}

function renderTaskMarkdown(input: RenderInput): string {
  const lines: string[] = ["---"];
  lines.push(`schedule: ${yamlQuote(input.schedule)}`);
  if (input.workflow) {
    lines.push(`workflow: ${yamlQuote(input.workflow)}`);
    if (input.params) {
      const parsed = parseJsonObjectArg(input.params);
      lines.push("params:");
      for (const [k, v] of Object.entries(parsed)) {
        lines.push(`  ${k}: ${yamlScalarValue(v)}`);
      }
    }
  } else if (input.prompt) {
    if (looksLikeAssetRef(input.prompt) || isFilePath(input.prompt) || input.prompt === "inline") {
      lines.push(`prompt: ${yamlQuote(input.prompt)}`);
    } else {
      lines.push(`prompt: inline`);
    }
    if (input.profile) lines.push(`profile: ${yamlQuote(input.profile)}`);
  }
  lines.push(`enabled: ${input.enabled}`);
  if (input.description) lines.push(`description: ${yamlQuote(input.description)}`);
  if (input.tags && input.tags.length > 0) {
    lines.push(`tags: [${input.tags.map((t) => yamlQuote(t)).join(", ")}]`);
  }
  lines.push("---", "");

  if (input.workflow) {
    lines.push(`# Task: ${humanise(input.id)}`, "");
  } else if (input.prompt) {
    if (looksLikeAssetRef(input.prompt) || isFilePath(input.prompt) || input.prompt === "inline") {
      lines.push(`# Task: ${humanise(input.id)}`, "");
    } else {
      // Raw inline prompt — use the body itself.
      lines.push(input.prompt.trim(), "");
    }
  }
  return lines.join("\n");
}

function yamlQuote(value: string): string {
  if (/^[A-Za-z_][A-Za-z0-9_.\-/:]*$/.test(value)) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function yamlScalarValue(v: unknown): string {
  if (typeof v === "string") return yamlQuote(v);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v === null) return "null";
  return JSON.stringify(v);
}

function parseJsonObjectArg(raw: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new UsageError("--params must be valid JSON.", "INVALID_JSON_ARGUMENT");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new UsageError("--params must be a JSON object.", "INVALID_JSON_ARGUMENT");
  }
  return parsed as Record<string, unknown>;
}

function looksLikeAssetRef(s: string): boolean {
  return /^[a-z][a-z0-9_-]*:[^\s]/i.test(s) && !s.startsWith("./") && !s.startsWith("/");
}

function isFilePath(s: string): boolean {
  return s.startsWith("./") || s.startsWith("../") || path.isAbsolute(s);
}

function humanise(id: string): string {
  return id.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Toggle the `enabled:` value in a task markdown's frontmatter without doing
 * a round-trip through the parser+renderer (which would lose comments and
 * formatting choices). Inserts the key right before the closing `---` if
 * absent.
 */
export function setEnabledInMarkdown(markdown: string, enabled: boolean): string {
  const m = markdown.match(/^(---\r?\n)([\s\S]*?)(\r?\n---(?:\r\n|\r|\n|$))([\s\S]*)$/);
  if (!m) {
    throw new UsageError("Task markdown is missing frontmatter; cannot toggle enabled.", "INVALID_FLAG_VALUE");
  }
  const [, openFence, fmBody, closeFence, body] = m;
  const replaced = fmBody.match(/(^|\r?\n)enabled:\s*[^\r\n]*/i)
    ? fmBody.replace(/(^|\r?\n)enabled:\s*[^\r\n]*/i, `$1enabled: ${enabled}`)
    : `${fmBody}\nenabled: ${enabled}`;
  return `${openFence}${replaced}${closeFence}${body}`;
}

// Re-exported so tests can verify the validator path directly.
// Re-export error classes consumed by callers that want to instanceof-check.
// Re-export this so the CLI can decide what process exit code to use after
// `akm tasks run` completes.
export { ConfigError, exitCodeForStatus, NotFoundError, parseTaskDocument, UsageError };

// Helper: ensure the asset-spec resolver agrees with our id rules. If the
// user passes a ref, we accept the bare name part too.
export function parseTaskRef(input: string): { id: string } {
  if (input.includes(":")) {
    const ref = parseAssetRef(input);
    if (ref.type !== "task") {
      throw new UsageError(`Expected a task id or task:<id> ref, got "${input}".`, "INVALID_FLAG_VALUE");
    }
    return { id: normaliseTaskId(ref.name) };
  }
  return { id: normaliseTaskId(input) };
}
