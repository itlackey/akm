// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm tasks` — register, inspect, run, and remove scheduled task assets.
 *
 * Each handler exported here is a pure function that performs the real work;
 * `src/cli.ts` wraps these in citty `defineCommand`s and shapes their return
 * values via `output()`.
 */

import fs from "node:fs";
import path from "node:path";
import { stringify as yamlStringify } from "yaml";
import type { AssetRef } from "../../core/asset/asset-ref";
import { resolveAssetPathFromName } from "../../core/asset/asset-spec";
import { isWithin, resolveStashDir } from "../../core/common";
import { loadConfig } from "../../core/config/config";
import { ConfigError, NotFoundError, UsageError } from "../../core/errors";
import { getTaskHistoryDir, getTaskLogDir } from "../../core/paths";
import {
  commitWriteTargetBoundary,
  deleteAssetFromSource,
  resolveWriteTarget,
  writeAssetToSource,
} from "../../core/write-source";
import { listAgentProfileNames } from "../../integrations/agent";
import { resolveAssetPath } from "../../sources/resolve";
import { backendNameForPlatform, selectBackend, type TaskBackend } from "../../tasks/backends";
import { parseTaskDocument } from "../../tasks/parser";
import { resolveAkmInvocation } from "../../tasks/resolve-akm-bin";
import { exitCodeForStatus, readTaskHistory, runTask, type TaskRunResult } from "../../tasks/runner";
import { parseSchedule, SCHEDULE_SUPPORTED_SUBSET_HINT, translateToCron } from "../../tasks/schedule";
import type { TaskDocument } from "../../tasks/schema";
import { validateTaskDocument } from "../../tasks/validator";
import { resolveImproveProfile } from "../improve/improve-profiles";

export interface TasksAddInput {
  id: string;
  schedule: string;
  workflow?: string;
  prompt?: string;
  /**
   * Shell command to run on the schedule. Accepts either a pre-split argv
   * array (`["echo", "hi"]`) or a single string that the parser splits on
   * whitespace (`"echo hi"`). Mutually exclusive with `workflow` and `prompt`.
   */
  command?: string | string[];
  profile?: string;
  params?: string;
  name?: string;
  description?: string;
  when_to_use?: string;
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
  const hasCommand =
    input.command !== undefined &&
    input.command !== null &&
    !(typeof input.command === "string" && input.command.trim() === "") &&
    !(Array.isArray(input.command) && input.command.length === 0);
  const targetCount = [Boolean(input.workflow), Boolean(input.prompt), hasCommand].filter(Boolean).length;
  if (targetCount !== 1) {
    throw new UsageError(
      "Pass exactly one of --workflow <ref>, --prompt <asset-ref|./file.md|text>, or --command <shell-command>.",
      "INVALID_FLAG_VALUE",
    );
  }

  // Validate the schedule for the active backend before writing anything.
  const backend = backendNameForPlatform();
  parseSchedule(input.schedule, backend);

  const target = resolveTaskWriteTarget();
  const stashDir = target.source.path;
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

  const yaml = renderTaskYaml({
    id,
    schedule: input.schedule,
    workflow: input.workflow,
    prompt: input.prompt,
    command: input.command,
    profile: input.profile,
    params: input.params,
    name: input.name,
    description: input.description,
    when_to_use: input.when_to_use,
    tags: input.tags,
    enabled: input.disabled !== true,
  });

  const task = parseTaskDocument({ yaml, filePath: assetPath, id });
  await validateTaskDocument(task, { backend, stashDir });

  const ref = taskAssetRef(id);
  await writeAssetToSource(target.source, target.config, ref, yaml);

  // Install in the OS scheduler. If install fails after the file was written,
  // delete the file so the on-disk state never claims a task is registered
  // when it isn't.
  try {
    const sched = selectBackend();
    await sched.install(task);
  } catch (err) {
    try {
      await deleteAssetFromSource(target.source, target.config, ref);
    } catch {
      /* ignore */
    }
    throw err;
  }
  commitWriteTargetBoundary(target, `Update task:${id}`);

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
    name?: string;
    description?: string;
    when_to_use?: string;
    tags?: string[];
  }>;
}

/**
 * Emit a single grouped stderr warning for legacy `.md` task files in the
 * tasks directory. 0.8.0 requires task definitions to be pure `.yml`; any
 * leftover `.md` files from 0.7.x would otherwise be silently skipped, which
 * makes scheduled tasks vanish without operator notice. We do NOT auto-migrate
 * — that is a separate workstream — but operators must see the affected files.
 *
 * `seen` is module-level so the warning is emitted at most once per process,
 * even when both `akm tasks list` and `akm tasks sync` are invoked in the same
 * akm run.
 */
const warnedLegacyMdDirs = new Set<string>();

function warnLegacyMdTaskFiles(typeRoot: string): void {
  if (warnedLegacyMdDirs.has(typeRoot)) return;
  let mdFiles: string[];
  try {
    mdFiles = fs.readdirSync(typeRoot).filter((f) => f.endsWith(".md"));
  } catch {
    return;
  }
  if (mdFiles.length === 0) return;
  warnedLegacyMdDirs.add(typeRoot);
  const affected = mdFiles.map((f) => `tasks/${f}`).join(", ");
  process.stderr.write(
    `WARNING: ${mdFiles.length} task file(s) use the legacy .md format and were ignored.\n` +
      `         AKM 0.8.0 requires tasks as pure .yml. See docs/migration/v0.7-to-v0.8.md#task-definition-files-mdfrontmatter--yml.\n` +
      `         Affected: ${affected}\n`,
  );
}

/**
 * Reset the legacy `.md` task warning de-duplication state. Test-only escape
 * hatch — production code should never call this.
 */
export function _resetLegacyMdTaskWarningStateForTests(): void {
  warnedLegacyMdDirs.clear();
}

export async function akmTasksList(): Promise<TasksListResult> {
  const stashDir = resolveStashDir();
  const typeRoot = path.join(stashDir, "tasks");
  if (!fs.existsSync(typeRoot)) return { tasks: [] };
  const entries = fs.readdirSync(typeRoot);
  warnLegacyMdTaskFiles(typeRoot);
  const files = entries.filter((f) => f.endsWith(".yml"));
  const tasks: TasksListResult["tasks"] = [];
  for (const file of files) {
    const id = file.slice(0, -4);
    const filePath = path.join(typeRoot, file);
    let task: TaskDocument;
    try {
      task = parseTaskDocument({ yaml: fs.readFileSync(filePath, "utf8"), filePath, id });
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
      name: task.name,
      description: task.description,
      when_to_use: task.when_to_use,
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
  name?: string;
  description?: string;
  when_to_use?: string;
  tags?: string[];
}> {
  const normalised = normaliseTaskId(id);
  const stashDir = resolveStashDir();
  const typeRoot = path.join(stashDir, "tasks");
  if (fs.existsSync(typeRoot)) warnLegacyMdTaskFiles(typeRoot);
  const filePath = await resolveAssetPath(stashDir, "task", normalised);
  const task = parseTaskDocument({
    yaml: fs.readFileSync(filePath, "utf8"),
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
    name: task.name,
    description: task.description,
    when_to_use: task.when_to_use,
    tags: task.tags,
  };
}

export async function akmTasksRemove(id: string): Promise<{ id: string; removed: true; backend: string }> {
  const normalised = normaliseTaskId(id);
  const target = resolveTaskWriteTarget();
  const stashDir = target.source.path;
  const typeRoot = path.join(stashDir, "tasks");
  if (fs.existsSync(typeRoot)) warnLegacyMdTaskFiles(typeRoot);
  await resolveAssetPath(stashDir, "task", normalised);
  const ref = taskAssetRef(normalised);
  const sched = selectBackend();
  let uninstallError: unknown;
  let deleteError: unknown;
  try {
    await sched.uninstall(normalised);
  } catch (err) {
    uninstallError = err;
  }
  try {
    await deleteAssetFromSource(target.source, target.config, ref);
  } catch (err) {
    deleteError = err;
  }
  if (uninstallError !== undefined) throw uninstallError;
  if (deleteError !== undefined) throw deleteError;
  commitWriteTargetBoundary(target, `Remove task:${normalised}`);
  return { id: normalised, removed: true, backend: sched.name };
}

export async function akmTasksSetEnabled(
  id: string,
  enabled: boolean,
): Promise<{ id: string; enabled: boolean; backend: string }> {
  const normalised = normaliseTaskId(id);
  const target = resolveTaskWriteTarget();
  const stashDir = target.source.path;
  const typeRoot = path.join(stashDir, "tasks");
  if (fs.existsSync(typeRoot)) warnLegacyMdTaskFiles(typeRoot);
  const filePath = await resolveAssetPath(stashDir, "task", normalised);
  const yaml = fs.readFileSync(filePath, "utf8");
  const updated = setEnabledInYaml(yaml, enabled);
  const ref = taskAssetRef(normalised);
  await writeAssetToSource(target.source, target.config, ref, updated);
  const sched = selectBackend();
  try {
    // Reinstall from the (just-updated) definition rather than only toggling
    // the comment. A plain toggle leaves a stale schedule in place if the
    // .yml's `schedule:` changed while the task was disabled — re-enabling
    // would silently keep the old cron line. install() renders the block with
    // both the current schedule and the new enabled state, and is idempotent.
    const task = parseTaskDocument({ yaml: updated, filePath, id: normalised });
    await sched.install(task);
  } catch (err) {
    // Roll the file back so the YAML source-of-truth and the OS
    // scheduler don't diverge silently when the backend call fails.
    await writeAssetToSource(target.source, target.config, ref, yaml);
    throw err;
  }
  commitWriteTargetBoundary(target, `Update task:${normalised}`);
  return { id: normalised, enabled, backend: sched.name };
}

export interface TasksRunResultEnvelope {
  ok: boolean;
  result: TaskRunResult;
  exitCode: number;
}

export async function akmTasksRun(id: string): Promise<TasksRunResultEnvelope> {
  const normalised = normaliseTaskId(id);
  const stashDir = resolveStashDir();
  const typeRoot = path.join(stashDir, "tasks");
  if (fs.existsSync(typeRoot)) warnLegacyMdTaskFiles(typeRoot);
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
  const stashDir = resolveStashDir();
  const typeRoot = path.join(stashDir, "tasks");
  if (fs.existsSync(typeRoot)) warnLegacyMdTaskFiles(typeRoot);
  return { rows: readTaskHistory({ id, limit }) };
}

export interface TasksSyncResult {
  installed: string[];
  /** Tasks whose installed schedule/enabled state drifted from the .yml and were reinstalled. */
  updated: string[];
  removed: string[];
  unchanged: string[];
  skipped: { id: string; reason: string }[];
  backend: string;
}

/**
 * Reconcile the on-disk task files with the OS scheduler.
 *   • install missing tasks (after validating them — invalid files are
 *     skipped with a per-task reason rather than aborting the whole sync)
 *   • reinstall tasks whose schedule or enabled state changed in the .yml
 *     (drift detected by comparing the backend's installed signature against
 *     the signature the current definition would produce)
 *   • remove orphan scheduler entries that no longer have a backing file
 */
export async function akmTasksSync(deps: { backend?: TaskBackend } = {}): Promise<TasksSyncResult> {
  const stashDir = resolveStashDir();
  const typeRoot = path.join(stashDir, "tasks");
  if (fs.existsSync(typeRoot)) warnLegacyMdTaskFiles(typeRoot);
  const fileIds = fs.existsSync(typeRoot)
    ? fs
        .readdirSync(typeRoot)
        .filter((f) => f.endsWith(".yml"))
        .map((f) => f.slice(0, -4))
    : [];
  const sched = deps.backend ?? selectBackend();
  const backend = backendNameForPlatform();
  // Map id → installed signature so sync can detect schedule/enabled drift on
  // tasks that already exist in the scheduler, not just presence/absence.
  const present = new Map((await sched.list()).map((t) => [t.id, t.signature] as const));
  const installed: string[] = [];
  const updated: string[] = [];
  const unchanged: string[] = [];
  const skipped: { id: string; reason: string }[] = [];

  for (const id of fileIds) {
    const filePath = path.join(typeRoot, `${id}.yml`);
    let task: TaskDocument;
    try {
      task = parseTaskDocument({ yaml: fs.readFileSync(filePath, "utf8"), filePath, id });
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
    if (!present.has(id)) {
      await sched.install(task);
      installed.push(id);
      continue;
    }
    // Already installed — reconcile against the current definition. Compare the
    // installed signature to what this task would render to; reinstall on drift.
    // When the backend can't produce a signature (no expectedSignature, or it
    // didn't record one), reinstall unconditionally — install() is idempotent,
    // so the cost is one crontab write and correctness is guaranteed.
    const installedSig = present.get(id);
    const expectedSig = sched.expectedSignature?.(task);
    if (installedSig !== undefined && expectedSig !== undefined && installedSig === expectedSig) {
      unchanged.push(id);
    } else {
      await sched.install(task);
      updated.push(id);
    }
  }

  const removed: string[] = [];
  for (const installedId of present.keys()) {
    if (!fileIds.includes(installedId)) {
      await sched.uninstall(installedId);
      removed.push(installedId);
    }
  }
  return { installed, updated, removed, unchanged, skipped, backend: sched.name };
}

export interface TasksDoctorResult {
  backend: string;
  akm: { argv: string[]; via: string };
  logDir: string;
  historyDir: string;
  agent: { defaultProfile?: string; available: string[] };
  scheduleSubset: string;
  warnings: string[];
  /**
   * Effective proposal-queue triage settings for the default improve profile.
   * Absent when the resolved profile has no `triage` process block.
   */
  improveTriage?: {
    defaultProfile: string;
    enabled: boolean;
    applyMode: string;
    policy: string;
  };
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
  try {
    const stashDir = resolveStashDir();
    const typeRoot = path.join(stashDir, "tasks");
    if (fs.existsSync(typeRoot)) warnLegacyMdTaskFiles(typeRoot);
  } catch {
    // doctor must never fail on stash-resolution; the warning is best-effort
  }
  const backend = backendNameForPlatform();
  const config = loadConfig();
  // v2: prefer profiles.agent / defaults.agent; fall back to legacy agent.default
  const defaultProfile = config.defaults?.agent;
  const profiles = config.profiles?.agent ? Object.keys(config.profiles.agent) : listAgentProfileNames(config);

  // §6.1: surface the effective triage settings for the default improve
  // profile. The struct is a fixed shape, so this is a deliberate addition.
  const improveProfileName = typeof config.defaults?.improve === "string" ? config.defaults.improve : "default";
  const triage = resolveImproveProfile(config.defaults?.improve as string | undefined, config).processes?.triage;
  const improveTriage = triage
    ? {
        defaultProfile: improveProfileName,
        enabled: triage.enabled === true,
        applyMode: triage.applyMode ?? "queue",
        policy: triage.policy ?? "personal-stash",
      }
    : undefined;

  return {
    backend,
    akm: invocation,
    logDir: getTaskLogDir(),
    historyDir: getTaskHistoryDir(),
    agent: { defaultProfile, available: profiles },
    scheduleSubset: SCHEDULE_SUPPORTED_SUBSET_HINT,
    warnings,
    ...(improveTriage ? { improveTriage } : {}),
  };
}

// ── helpers ─────────────────────────────────────────────────────────────────

const VALID_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function normaliseTaskId(raw: string): string {
  // Accept both .yml and .md suffixes from users so muscle memory from the
  // pre-0.8.0 markdown task format doesn't produce a confusing "task not found".
  const id = raw.trim().replace(/\.(yml|md)$/, "");
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

function taskAssetRef(id: string): AssetRef {
  return { type: "task", name: id };
}

function resolveTaskWriteTarget() {
  return resolveWriteTarget(loadConfig());
}

interface RenderInput {
  id: string;
  schedule: string;
  workflow?: string;
  prompt?: string;
  command?: string | string[];
  profile?: string;
  params?: string;
  name?: string;
  description?: string;
  when_to_use?: string;
  tags?: string[];
  enabled: boolean;
}

function renderTaskYaml(input: RenderInput): string {
  const obj: Record<string, unknown> = { schedule: input.schedule };
  if (input.workflow) {
    obj.workflow = input.workflow;
    if (input.params) {
      obj.params = parseJsonObjectArg(input.params);
    }
  } else if (input.prompt) {
    obj.prompt = input.prompt;
    if (input.profile) obj.profile = input.profile;
  } else if (input.command !== undefined) {
    // Emit a string when given a string, an array when given an array. The
    // parser accepts both forms; preserving the caller's shape keeps the YAML
    // ergonomic for humans editing the file later.
    obj.command = input.command;
  }
  obj.enabled = input.enabled;
  if (input.name) obj.name = input.name;
  if (input.description) obj.description = input.description;
  if (input.when_to_use) obj.when_to_use = input.when_to_use;
  if (input.tags && input.tags.length > 0) obj.tags = input.tags;
  return yamlStringify(obj);
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

/**
 * Toggle the `enabled:` value in a task YAML file in-place without a full
 * parse/render round-trip (which would reformat the file). Appends the key
 * if absent.
 *
 * Preserves inline comments (e.g. `enabled: true # important`) and uses
 * case-sensitive matching (YAML keys are case-sensitive).
 */
export function setEnabledInYaml(yaml: string, enabled: boolean): string {
  // Match: key prefix (group 1), value (group 2), optional trailing comment (group 3)
  const pattern = /^(enabled:\s*)([^\s#\r\n][^\r\n]*?)(\s*(?:#[^\r\n]*))?$/m;
  if (pattern.test(yaml)) {
    return yaml.replace(pattern, `$1${enabled}$3`);
  }
  // Handle the case where enabled: has no value yet (bare key)
  const simplePattern = /^(enabled:)\s*$/m;
  if (simplePattern.test(yaml)) {
    return yaml.replace(simplePattern, `$1 ${enabled}`);
  }
  return `${yaml.trimEnd()}\nenabled: ${enabled}\n`;
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
    const [typePart, ...rest] = input.split(":");
    if (typePart !== "task" || rest.length === 0) {
      throw new UsageError(`Expected a task id or task:<id> ref, got "${input}".`, "INVALID_FLAG_VALUE");
    }
    return { id: normaliseTaskId(rest.join(":")) };
  }
  return { id: normaliseTaskId(input) };
}
