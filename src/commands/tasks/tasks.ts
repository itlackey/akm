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
import { assetPathForName } from "../../core/asset/asset-placement";
import type { AssetRef } from "../../core/asset/resolve-ref";
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
import { resolveAssetPath } from "../../sources/resolve";
import { backendNameForPlatform, selectBackend, type TaskBackend } from "../../tasks/backends";
import { findBareAkmExecutableIndex } from "../../tasks/command-executable";
import { parseTaskDocument } from "../../tasks/parser";
import { resolveAkmInvocation } from "../../tasks/resolve-akm-bin";
import {
  exitCodeForStatus,
  INVALID_TASK_ATTEMPT_ID,
  readTaskHistory,
  recordTaskAttemptFailure,
  runTask,
  type TaskRunResult,
} from "../../tasks/runner";
import { parseSchedule, SCHEDULE_SUPPORTED_SUBSET_HINT, translateToCron } from "../../tasks/schedule";
import type { TaskDocument } from "../../tasks/schema";
import { normaliseTaskId } from "../../tasks/task-id";
import { validateTaskDocument } from "../../tasks/validator";
import { resolveImproveStrategy } from "../improve/improve-strategies";

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
  engine?: string;
  model?: string;
  timeoutMs?: number;
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

export interface TaskMutationDeps {
  backend?: TaskBackend;
  writeAsset?: typeof writeAssetToSource;
  deleteAsset?: typeof deleteAssetFromSource;
  commitBoundary?: typeof commitWriteTargetBoundary;
}

export async function akmTasksAdd(input: TasksAddInput, deps: TaskMutationDeps = {}): Promise<TasksAddResult> {
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
  if (input.workflow && (input.engine !== undefined || input.model !== undefined || input.timeoutMs !== undefined)) {
    throw new UsageError(
      "Workflow tasks accept only --params; engine, model, and timeout are prompt-task fields.",
      "INVALID_FLAG_VALUE",
    );
  }
  if (hasCommand && (input.engine !== undefined || input.model !== undefined)) {
    throw new UsageError("Command tasks accept --timeout-ms but not --engine or --model.", "INVALID_FLAG_VALUE");
  }

  // Validate the schedule for the active backend before writing anything.
  const backend = backendNameForPlatform();
  parseSchedule(input.schedule, backend);

  const target = resolveTaskWriteTarget();
  const stashDir = target.source.path;
  const typeRoot = path.join(stashDir, "tasks");

  const assetPath = assetPathForName("task", typeRoot, id);
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
    engine: input.engine,
    model: input.model,
    timeoutMs: input.timeoutMs,
    params: input.params,
    name: input.name,
    description: input.description,
    when_to_use: input.when_to_use,
    tags: input.tags,
    enabled: input.disabled !== true,
  });

  const task = parseTaskDocument({ yaml, filePath: assetPath, id });
  await validateTaskDocument(task, { backend, stashDir });
  const obsoleteReason = obsoleteBackupTaskReason(task);
  if (obsoleteReason) throw new UsageError(obsoleteReason, "INVALID_FLAG_VALUE");

  const ref = taskAssetRef(id);
  const previousYaml = fs.existsSync(assetPath) ? fs.readFileSync(assetPath, "utf8") : undefined;
  let previousTask: TaskDocument | undefined;
  let previousTaskError: unknown;
  if (previousYaml !== undefined) {
    try {
      previousTask = parseTaskDocument({ yaml: previousYaml, filePath: assetPath, id });
    } catch (err) {
      previousTaskError = err;
    }
  }
  const sched = deps.backend ?? selectBackend();
  const writeAsset = deps.writeAsset ?? writeAssetToSource;
  const deleteAsset = deps.deleteAsset ?? deleteAssetFromSource;
  const commitBoundary = deps.commitBoundary ?? commitWriteTargetBoundary;
  const wasInstalled = previousYaml !== undefined && (await sched.list()).some((entry) => entry.id === id);
  let sourceRestoreArmed = false;
  let installSucceeded = false;

  try {
    sourceRestoreArmed = true;
    await writeAsset(target.source, target.config, ref, yaml);
    await sched.install(task);
    installSucceeded = true;
    commitBoundary(target, `Update task:${id}`);
  } catch (err) {
    const rollbackErrors: unknown[] = [];
    let sourceRestored = false;
    if (sourceRestoreArmed) {
      try {
        if (previousYaml === undefined) {
          if (fs.existsSync(assetPath)) {
            await deleteAsset(target.source, target.config, ref);
            sourceRestored = true;
          }
        } else {
          await restoreTaskSourceBytes(writeAsset, target.source, target.config, ref, assetPath, previousYaml);
          sourceRestored = true;
        }
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }

    if (installSucceeded && !wasInstalled) {
      try {
        await sched.uninstall(id);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    } else if (installSucceeded && previousTask) {
      try {
        await sched.install(previousTask);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
        try {
          if (typeof sched.setEnabled !== "function") {
            throw new Error(`Scheduler backend "${sched.name}" cannot disable task "${id}".`);
          }
          await sched.setEnabled(id, false);
        } catch (disableError) {
          rollbackErrors.push(disableError);
          try {
            await sched.uninstall(id);
          } catch (uninstallError) {
            rollbackErrors.push(uninstallError);
          }
        }
      }
    } else if (installSucceeded && wasInstalled) {
      rollbackErrors.push(previousTaskError ?? new Error(`Prior task "${id}" could not be restored.`));
    }

    if (sourceRestored) {
      try {
        commitBoundary(target, `Restore task:${id}`);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }

    if (rollbackErrors.length > 0) {
      const message = err instanceof Error ? err.message : String(err);
      throw new AggregateError([err, ...rollbackErrors], `${message}; rollback for task "${id}" was incomplete.`);
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
    name?: string;
    description?: string;
    when_to_use?: string;
    tags?: string[];
  }>;
  /** Task IDs using an unsupported task schema version. */
  stale: string[];
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
  if (!fs.existsSync(typeRoot)) return { tasks: [], stale: [] };
  const entries = fs.readdirSync(typeRoot);
  warnLegacyMdTaskFiles(typeRoot);
  const files = entries.filter((f) => f.endsWith(".yml"));
  const tasks: TasksListResult["tasks"] = [];
  const stale: string[] = [];
  for (const file of files) {
    const id = file.slice(0, -4);
    const filePath = path.join(typeRoot, file);
    let task: TaskDocument;
    try {
      task = parseTaskDocument({ yaml: fs.readFileSync(filePath, "utf8"), filePath, id });
    } catch (err) {
      if (isStaleTaskError(err)) stale.push(id);
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
  if (stale.length > 0) warnStaleTaskFiles(stale);
  return { tasks, stale };
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

export async function akmTasksRemove(
  id: string,
  deps: TaskMutationDeps = {},
): Promise<{ id: string; removed: true; backend: string }> {
  const normalised = normaliseTaskId(id);
  const target = resolveTaskWriteTarget();
  const stashDir = target.source.path;
  const typeRoot = path.join(stashDir, "tasks");
  if (fs.existsSync(typeRoot)) warnLegacyMdTaskFiles(typeRoot);
  const filePath = await resolveAssetPath(stashDir, "task", normalised);
  const yaml = fs.readFileSync(filePath, "utf8");
  const ref = taskAssetRef(normalised);
  const sched = deps.backend ?? selectBackend();
  const writeAsset = deps.writeAsset ?? writeAssetToSource;
  const deleteAsset = deps.deleteAsset ?? deleteAssetFromSource;
  const commitBoundary = deps.commitBoundary ?? commitWriteTargetBoundary;
  const wasInstalled = (await sched.list()).some((entry) => entry.id === normalised);
  const previousTask = wasInstalled ? parseTaskDocument({ yaml, filePath, id: normalised }) : undefined;
  let uninstallAttempted = false;
  let deleteAttempted = false;

  try {
    uninstallAttempted = true;
    await sched.uninstall(normalised);
    deleteAttempted = true;
    await deleteAsset(target.source, target.config, ref);
    commitBoundary(target, `Remove task:${normalised}`);
  } catch (err) {
    const rollbackErrors: unknown[] = [];
    let sourceRestored = false;
    if (deleteAttempted) {
      try {
        await restoreTaskSourceBytes(writeAsset, target.source, target.config, ref, filePath, yaml);
        sourceRestored = true;
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (uninstallAttempted && previousTask) {
      try {
        await sched.install(previousTask);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (sourceRestored) {
      try {
        commitBoundary(target, `Restore task:${normalised}`);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length > 0) {
      const message = err instanceof Error ? err.message : String(err);
      throw new AggregateError(
        [err, ...rollbackErrors],
        `${message}; rollback for task "${normalised}" was incomplete.`,
      );
    }
    throw err;
  }
  return { id: normalised, removed: true, backend: sched.name };
}

export async function akmTasksSetEnabled(
  id: string,
  enabled: boolean,
  deps: TaskMutationDeps = {},
): Promise<{ id: string; enabled: boolean; backend: string }> {
  const normalised = normaliseTaskId(id);
  const target = resolveTaskWriteTarget();
  const stashDir = target.source.path;
  const typeRoot = path.join(stashDir, "tasks");
  if (fs.existsSync(typeRoot)) warnLegacyMdTaskFiles(typeRoot);
  const filePath = await resolveAssetPath(stashDir, "task", normalised);
  const yaml = fs.readFileSync(filePath, "utf8");
  // Parse before writing so unsupported tasks are diagnosed without changing
  // the source file or its installed scheduler entry.
  const previousTask = parseTaskDocument({ yaml, filePath, id: normalised });
  const updated = setEnabledInYaml(yaml, enabled);
  const task = parseTaskDocument({ yaml: updated, filePath, id: normalised });
  const obsoleteReason = obsoleteBackupTaskReason(task);
  if (obsoleteReason) throw new UsageError(obsoleteReason, "INVALID_FLAG_VALUE");
  const ref = taskAssetRef(normalised);
  const sched = deps.backend ?? selectBackend();
  const writeAsset = deps.writeAsset ?? writeAssetToSource;
  const commitBoundary = deps.commitBoundary ?? commitWriteTargetBoundary;
  const wasInstalled = (await sched.list()).some((entry) => entry.id === normalised);
  let sourceRestoreArmed = false;
  let installSucceeded = false;
  try {
    sourceRestoreArmed = true;
    await writeAsset(target.source, target.config, ref, updated);
    // Reinstall from the (just-updated) definition rather than only toggling
    // the comment. A plain toggle leaves a stale schedule in place if the
    // .yml's `schedule:` changed while the task was disabled — re-enabling
    // would silently keep the old cron line. install() renders the block with
    // both the current schedule and the new enabled state, and is idempotent.
    await sched.install(task);
    installSucceeded = true;
    commitBoundary(target, `Update task:${normalised}`);
  } catch (err) {
    const rollbackErrors: unknown[] = [];
    let sourceRestored = false;
    if (sourceRestoreArmed) {
      try {
        await restoreTaskSourceBytes(writeAsset, target.source, target.config, ref, filePath, yaml);
        sourceRestored = true;
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (installSucceeded) {
      try {
        if (wasInstalled) await sched.install(previousTask);
        else await sched.uninstall(normalised);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (sourceRestored) {
      try {
        commitBoundary(target, `Restore task:${normalised}`);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length > 0) {
      const message = err instanceof Error ? err.message : String(err);
      throw new AggregateError(
        [err, ...rollbackErrors],
        `${message}; rollback for task "${normalised}" was incomplete.`,
      );
    }
    throw err;
  }
  return { id: normalised, enabled, backend: sched.name };
}

export interface TasksRunResultEnvelope {
  ok: boolean;
  result: TaskRunResult;
  exitCode: number;
}

export async function akmTasksRun(id: string, options: { scheduled?: boolean } = {}): Promise<TasksRunResultEnvelope> {
  const startedAt = new Date();
  let normalised: string;
  try {
    normalised = parseTaskRef(id).id;
  } catch (failure) {
    recordTaskAttemptFailure({
      taskId: INVALID_TASK_ATTEMPT_ID,
      reason: "invalid_task_id",
      failure,
      startedAt,
    });
    throw failure;
  }

  let stashDir: string;
  try {
    stashDir = resolveStashDir();
  } catch (failure) {
    recordTaskAttemptFailure({
      taskId: normalised,
      reason: "task_load_failed",
      failure,
      startedAt,
    });
    throw failure;
  }
  const typeRoot = path.join(stashDir, "tasks");
  if (fs.existsSync(typeRoot)) warnLegacyMdTaskFiles(typeRoot);
  const result = await runTask(normalised, { stashDir, scheduled: options.scheduled === true });
  const exitCode =
    result.status === "failed" && result.target.kind === "command" && result.detail?.exitCode === 78
      ? 78
      : exitCodeForStatus(result.status);
  return {
    ok: result.status === "completed" || result.status === "disabled",
    result,
    exitCode,
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
  const backend = sched.name;
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
      await validateTaskDocument(task, { backend, stashDir });
      const obsoleteReason = obsoleteBackupTaskReason(task);
      if (obsoleteReason) throw new UsageError(obsoleteReason, "INVALID_FLAG_VALUE");
    } catch (err) {
      skipped.push({ id, reason: err instanceof Error ? err.message : String(err) });
      if (present.has(id)) {
        try {
          await sched.setEnabled(id, false);
        } catch (disableError) {
          try {
            await sched.uninstall(id);
          } catch (uninstallError) {
            throw new AggregateError(
              [err, disableError, uninstallError],
              `Task "${id}" is invalid and its installed scheduler entry could not be disabled or removed.`,
            );
          }
        }
      }
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

function obsoleteBackupTaskReason(task: TaskDocument): string | undefined {
  if (!task.enabled || task.target.kind !== "command") return undefined;
  const executableIndex = findBareAkmExecutableIndex(task.target.cmd);
  if (executableIndex === undefined) return undefined;
  const args = task.target.cmd.slice(executableIndex + 1);
  if (args.length !== 2 || args[0] !== "db" || args[1] !== "backups") return undefined;
  return (
    `Task "${task.id}" invokes obsolete \`akm db backups\`, which only listed legacy backups and is not a 0.9 backup command. ` +
    "AKM will not install or enable it; sync will keep any existing scheduler entry disabled, and the task file is unchanged. " +
    "Use `akm backup create --for 0.9.0` for an explicit migration recovery snapshot."
  );
}

export interface TasksDoctorResult {
  backend: string;
  akm: { argv: string[]; via: string };
  logDir: string;
  historyDir: string;
  engine: { defaultEngine?: string; available: string[] };
  stale: string[];
  staleGeneratedCommands: Array<{ id: string; replacement: string }>;
  scheduleSubset: string;
  warnings: string[];
  /**
   * Effective proposal-queue triage settings for the default improve strategy.
   * Absent when the resolved strategy has no `triage` process block.
   */
  improveTriage?: {
    defaultStrategy: string;
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
  const defaultEngine = config.defaults?.engine;
  const engines = Object.keys(config.engines ?? {});

  // §6.1: surface the effective triage settings for the default improve
  // strategy. The struct is a fixed shape, so this is a deliberate addition.
  const improveStrategyName =
    typeof config.defaults?.improveStrategy === "string" ? config.defaults.improveStrategy : "default";
  const triage = resolveImproveStrategy(config.defaults?.improveStrategy, config).config.processes?.triage;
  const improveTriage = triage
    ? {
        defaultStrategy: improveStrategyName,
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
    engine: { defaultEngine, available: engines },
    stale: collectStaleTaskIds(),
    staleGeneratedCommands: collectStaleGeneratedCommands(),
    scheduleSubset: SCHEDULE_SUPPORTED_SUBSET_HINT,
    warnings,
    ...(improveTriage ? { improveTriage } : {}),
  };
}

// ── helpers ─────────────────────────────────────────────────────────────────

function taskAssetRef(id: string): AssetRef {
  return { type: "task", name: id };
}

async function restoreTaskSourceBytes(
  writeAsset: typeof writeAssetToSource,
  source: Parameters<typeof writeAssetToSource>[0],
  config: Parameters<typeof writeAssetToSource>[1],
  ref: AssetRef,
  filePath: string,
  yaml: string,
): Promise<void> {
  await writeAsset(source, config, ref, yaml);
  // The normal write path adds a trailing newline; rollback restores the raw snapshot exactly.
  fs.writeFileSync(filePath, yaml, "utf8");
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
  engine?: string;
  model?: string;
  timeoutMs?: number;
  params?: string;
  name?: string;
  description?: string;
  when_to_use?: string;
  tags?: string[];
  enabled: boolean;
}

function renderTaskYaml(input: RenderInput): string {
  const obj: Record<string, unknown> = { version: 2, schedule: input.schedule, enabled: input.enabled };
  if (input.workflow) {
    obj.workflow = input.workflow;
    if (input.params) {
      obj.params = parseJsonObjectArg(input.params);
    }
  } else if (input.prompt) {
    obj.prompt = input.prompt;
    if (input.engine) obj.engine = input.engine;
    if (input.model) obj.model = input.model;
    if (input.timeoutMs !== undefined) obj.timeoutMs = input.timeoutMs;
  } else if (input.command !== undefined) {
    // Emit a string when given a string, an array when given an array. The
    // parser accepts both forms; preserving the caller's shape keeps the YAML
    // ergonomic for humans editing the file later.
    obj.command = input.command;
    if (input.timeoutMs !== undefined) obj.timeoutMs = input.timeoutMs;
  }
  if (input.name) obj.name = input.name;
  if (input.description) obj.description = input.description;
  if (input.when_to_use) obj.when_to_use = input.when_to_use;
  if (input.tags && input.tags.length > 0) obj.tags = input.tags;
  return yamlStringify(obj);
}

function isStaleTaskError(err: unknown): err is UsageError {
  return err instanceof UsageError && err.code === "TASK_SCHEMA_VERSION_UNSUPPORTED";
}

function warnStaleTaskFiles(ids: readonly string[]): void {
  process.stderr.write(
    `WARNING: ${ids.length} task file(s) use an unsupported task schema version and were not loaded.\n` +
      `         Use version: 2. See docs/migration/v0.8-to-v0.9.md#engine-and-task-assets.\n` +
      `         Affected: ${ids.map((id) => `tasks/${id}.yml`).join(", ")}\n`,
  );
}

function collectStaleTaskIds(): string[] {
  const typeRoot = path.join(resolveStashDir(), "tasks");
  if (!fs.existsSync(typeRoot)) return [];
  const stale: string[] = [];
  for (const file of fs.readdirSync(typeRoot)) {
    if (!file.endsWith(".yml")) continue;
    const id = file.slice(0, -4);
    try {
      parseTaskDocument({
        yaml: fs.readFileSync(path.join(typeRoot, file), "utf8"),
        filePath: path.join(typeRoot, file),
        id,
      });
    } catch (err) {
      if (isStaleTaskError(err)) stale.push(id);
    }
  }
  return stale;
}

const STALE_GENERATED_COMMANDS: Record<string, { command: string; replacement: string }> = {
  "akm-improve-frequent": {
    command: "akm improve --profile frequent --auto-accept safe",
    replacement: "akm improve --strategy frequent",
  },
  "akm-improve-consolidate": {
    command: "akm improve --profile consolidate --auto-accept safe",
    replacement: "akm improve --strategy consolidate",
  },
  "akm-improve-nightly": {
    command: "akm improve --profile thorough --auto-accept safe",
    replacement: "akm improve --strategy thorough",
  },
  "akm-improve-catchup": {
    command: "akm improve --profile catchup --auto-accept safe",
    replacement: "akm improve --strategy catchup",
  },
  "akm-graph-refresh-weekly": {
    command: "akm improve --profile graph-refresh --auto-accept safe",
    replacement: "akm improve --strategy graph-refresh",
  },
};

function collectStaleGeneratedCommands(): Array<{ id: string; replacement: string }> {
  const typeRoot = path.join(resolveStashDir(), "tasks");
  if (!fs.existsSync(typeRoot)) return [];
  const stale: Array<{ id: string; replacement: string }> = [];
  for (const [id, expected] of Object.entries(STALE_GENERATED_COMMANDS)) {
    const filePath = path.join(typeRoot, `${id}.yml`);
    if (!fs.existsSync(filePath)) continue;
    try {
      const task = parseTaskDocument({ yaml: fs.readFileSync(filePath, "utf8"), filePath, id });
      if (task.target.kind === "command" && task.target.cmd.join(" ") === expected.command) {
        stale.push({ id, replacement: expected.replacement });
      }
    } catch {
      // Stale-schema reporting owns files that cannot be parsed.
    }
  }
  return stale;
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
