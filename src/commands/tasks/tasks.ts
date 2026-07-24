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
import { type AssetRef, conceptIdFromTypeName, parseRefInput } from "../../core/asset/resolve-ref";
import { isWithin, resolveStashDir } from "../../core/common";
import { loadConfig } from "../../core/config/config";
import { ConfigError, NotFoundError, UsageError } from "../../core/errors";
import { getTaskHistoryDir, getTaskLogDir } from "../../core/paths";
import {
  commitWriteTargetBoundary,
  deleteAssetFromSource,
  type ResolvedWriteTarget,
  resolveWriteTarget,
  writeAssetToSource,
} from "../../core/write-source";
import { resolveAssetPath } from "../../sources/resolve";
import { backendNameForPlatform, type InstalledTaskRef, selectBackend, type TaskBackend } from "../../tasks/backends";
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
import { parseSchedule, SCHEDULE_SUPPORTED_SUBSET_HINT } from "../../tasks/schedule";
import {
  schedulerContextDescriptor,
  validateSchedulerContextDescriptor,
  writeSchedulerContextDescriptor,
} from "../../tasks/scheduler-invocation";
import type { TaskDocument } from "../../tasks/schema";
import { normaliseTaskId } from "../../tasks/task-id";
import { validateTaskDocument } from "../../tasks/validator";
import { resolveImproveStrategy } from "../improve/improve-strategies";

export interface TasksAddInput {
  id: string;
  schedule: string;
  /**
   * Bundle to write the task into and schedule from. Defaults to the primary /
   * default write target. Resolved via {@link resolveWriteTarget}; a non-default
   * bundle is recorded in the scheduled invocation as `--target <bundle>`.
   */
  target?: string;
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
  /** Explicitly permit scheduler creation from an ineligible local invocation. */
  rebind?: boolean;
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
  schedulerRuntime?: () => PreparedSchedulerRuntime;
}

export interface PreparedSchedulerRuntime {
  binding: string[];
  contextPath: string;
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
  // WI-9.10e: the injected backend (tests) carries its own name, so derive it
  // from `deps.backend` when present — retiring the `_setBackendsForTests` seam.
  const backend = deps.backend?.name ?? backendNameForPlatform();
  parseSchedule(input.schedule, backend);

  const bundle = resolveTaskBundle(input.target, { requireWritable: true });
  const writeTarget = bundle.resolved;
  const stashDir = bundle.stashDir;
  const installOpts = bundle.installTarget !== undefined ? { target: bundle.installTarget } : undefined;
  const typeRoot = path.join(stashDir, "tasks");

  const assetPath = assetPathForName("task", typeRoot, id);
  if (!isWithin(assetPath, typeRoot)) {
    throw new UsageError(`Resolved task path escapes the stash: "${id}".`, "PATH_ESCAPE_VIOLATION");
  }
  if (fs.existsSync(assetPath) && !input.force) {
    throw new UsageError(
      `Task "${id}" already exists. Pass --force to overwrite, or delete its file and run \`akm tasks sync\` first.`,
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
  const installedEntries = await sched.list();
  assertNoForeignSchedule(installedEntries, id, bundle.installTarget);
  const wasInstalled = previousYaml !== undefined && installedEntries.some((entry) => entry.id === id);
  const installedEntry = installedEntries.find((entry) => entry.id === id);
  const runtimeOpts = schedulerInstallOptions(
    installOpts,
    installedEntry,
    deps,
    installedEntry ? false : input.rebind === true,
    `create scheduler entry for task "${id}"`,
  );
  let sourceRestoreArmed = false;
  let installSucceeded = false;

  try {
    sourceRestoreArmed = true;
    await writeAsset(writeTarget.source, writeTarget.config, ref, yaml);
    await sched.install(task, runtimeOpts);
    installSucceeded = true;
    commitBoundary(writeTarget, `Update tasks/${id}`);
  } catch (err) {
    const rollbackErrors: unknown[] = [];
    let sourceRestored = false;
    if (sourceRestoreArmed) {
      try {
        if (previousYaml === undefined) {
          if (fs.existsSync(assetPath)) {
            await deleteAsset(writeTarget.source, writeTarget.config, ref);
            sourceRestored = true;
          }
        } else {
          await restoreTaskSourceBytes(
            writeAsset,
            writeTarget.source,
            writeTarget.config,
            ref,
            assetPath,
            previousYaml,
          );
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
        await sched.install(previousTask, runtimeOpts);
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
        commitBoundary(writeTarget, `Restore tasks/${id}`);
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
    ref: conceptIdFromTypeName("task", id),
    path: assetPath,
    stashDir,
    schedule: task.schedule,
    enabled: task.enabled,
    backend,
    target: task.target,
  };
}

/** Minimal per-task summary for internal enumeration (setup + default-task registration). */
export interface StashTaskSummary {
  id: string;
  enabled: boolean;
}

/**
 * List the task ids + enabled-state present in a stash's `tasks/` directory.
 *
 * Internal utility for the setup wizard and default-improve-task registration —
 * NOT a user-facing surface. Cross-bundle task inspection is covered by the
 * generic `akm search` / `akm show <bundle//tasks/id>` commands. Malformed /
 * stale files are skipped silently (those are surfaced by `tasks doctor`).
 */
export function listStashTasks(stashDir: string = resolveStashDir()): { tasks: StashTaskSummary[] } {
  const typeRoot = path.join(stashDir, "tasks");
  if (!fs.existsSync(typeRoot)) return { tasks: [] };
  const tasks: StashTaskSummary[] = [];
  for (const file of fs.readdirSync(typeRoot)) {
    if (!file.endsWith(".yml")) continue;
    const id = file.slice(0, -4);
    const filePath = path.join(typeRoot, file);
    try {
      const task = parseTaskDocument({ yaml: fs.readFileSync(filePath, "utf8"), filePath, id });
      tasks.push({ id: task.id, enabled: task.enabled });
    } catch {
      // Skip malformed / stale-schema files — `tasks doctor` owns reporting them.
    }
  }
  return { tasks };
}

/**
 * Emit a single grouped stderr warning for legacy `.md` task files in the
 * tasks directory. 0.8.0 requires task definitions to be pure `.yml`; any
 * leftover `.md` files from 0.7.x would otherwise be silently skipped, which
 * makes scheduled tasks vanish without operator notice. We do NOT auto-migrate
 * — that is a separate workstream — but operators must see the affected files.
 *
 * `seen` is module-level so the warning is emitted at most once per process,
 * even when several `akm tasks` subcommands (e.g. `sync` and `run`) are
 * invoked in the same akm run.
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

export async function akmTasksSetEnabled(
  id: string,
  enabled: boolean,
  deps: TaskMutationDeps = {},
  bundleTarget?: string,
): Promise<{ id: string; enabled: boolean; backend: string }> {
  const normalised = normaliseTaskId(id);
  const bundle = resolveTaskBundle(bundleTarget, { requireWritable: true });
  const writeTarget = bundle.resolved;
  const stashDir = bundle.stashDir;
  const installOpts = bundle.installTarget !== undefined ? { target: bundle.installTarget } : undefined;
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
  const installedEntries = await sched.list();
  assertNoForeignSchedule(installedEntries, normalised, bundle.installTarget);
  const wasInstalled = installedEntries.some((entry) => entry.id === normalised);
  const installedEntry = installedEntries.find((entry) => entry.id === normalised);
  const bindingInspectionEnabled = !deps.backend || deps.schedulerRuntime !== undefined;
  const preserveNativeToggle =
    bindingInspectionEnabled && installedEntry && (!installedEntry.binding || !installedEntry.contextPath);
  const runtimeOpts = preserveNativeToggle
    ? installOpts
    : schedulerInstallOptions(
        installOpts,
        installedEntry,
        deps,
        false,
        `create scheduler entry for task "${normalised}"`,
      );
  let sourceRestoreArmed = false;
  let installSucceeded = false;
  try {
    sourceRestoreArmed = true;
    await writeAsset(writeTarget.source, writeTarget.config, ref, updated);
    // Reinstall from the (just-updated) definition rather than only toggling
    // the comment. A plain toggle leaves a stale schedule in place if the
    // .yml's `schedule:` changed while the task was disabled — re-enabling
    // would silently keep the old cron line. install() renders the block with
    // both the current schedule and the new enabled state, and is idempotent.
    if (preserveNativeToggle) await sched.setEnabled(normalised, enabled);
    else await sched.install(task, runtimeOpts);
    installSucceeded = true;
    commitBoundary(writeTarget, `Update tasks/${normalised}`);
  } catch (err) {
    const rollbackErrors: unknown[] = [];
    let sourceRestored = false;
    if (sourceRestoreArmed) {
      try {
        await restoreTaskSourceBytes(writeAsset, writeTarget.source, writeTarget.config, ref, filePath, yaml);
        sourceRestored = true;
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (installSucceeded) {
      try {
        if (wasInstalled && preserveNativeToggle) {
          await sched.setEnabled(normalised, previousTask.enabled);
        } else if (wasInstalled) await sched.install(previousTask, runtimeOpts);
        else await sched.uninstall(normalised);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (sourceRestored) {
      try {
        commitBoundary(writeTarget, `Restore tasks/${normalised}`);
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

export async function akmTasksRun(
  id: string,
  options: { scheduled?: boolean; target?: string } = {},
): Promise<TasksRunResultEnvelope> {
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
    // No --target keeps the primary stash (byte-identical to pre-0.9.x runs).
    // With --target, resolve (read-only) the named bundle so the task file and
    // its relative asset refs load from that bundle's path.
    stashDir =
      options.target !== undefined
        ? resolveWriteTarget(loadConfig(), options.target, { requireWritable: false }).source.path
        : resolveStashDir();
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

export async function akmTasksHistory(input: {
  id?: string;
  limit?: number;
  target?: string;
}): Promise<TasksHistoryResult> {
  const limit = input.limit !== undefined && input.limit > 0 ? input.limit : 50;
  const id = input.id ? normaliseTaskId(input.id) : undefined;
  // History rows are keyed by task id in state.db (not per-bundle); --target
  // only scopes which tasks/ directory the legacy-.md advisory inspects.
  const stashDir = resolveTaskInspectDir(input.target);
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
 * Reconcile the on-disk task files of ONE bundle with the OS scheduler.
 *   • install missing tasks (after validating them — invalid files are
 *     skipped with a per-task reason rather than aborting the whole sync)
 *   • reinstall tasks whose schedule or enabled state changed in the .yml
 *     (drift detected by comparing the backend's installed signature against
 *     the signature the current definition would produce)
 *   • remove orphan scheduler entries that no longer have a backing file
 *
 * `--target <bundle>` scopes the reconciliation to that bundle: the file set is
 * the bundle's `tasks/*.yml` and — crucially — the scheduler entries considered
 * are ONLY those attributed to the same bundle (parsed from the installed
 * `--target` token; absent ⇒ primary). This is the security boundary that keeps
 * "registering a bundle never activates code": a plain (primary) sync never
 * installs from, updates, or removes another bundle's entries, and sync never
 * scans all bundles. Activation happens only through explicit `enable` /
 * `add --target`.
 */
export async function akmTasksSync(
  deps: { backend?: TaskBackend; schedulerRuntime?: () => PreparedSchedulerRuntime } = {},
  bundleTarget?: string,
  options: { rebind?: boolean } = {},
): Promise<TasksSyncResult> {
  const stashDir = resolveTaskInspectDir(bundleTarget);
  // Embed --target only for a genuinely non-primary bundle so a default-bundle
  // sync stays byte-identical and keeps managing legacy no-`--target` entries.
  const syncTarget = bundleTarget !== undefined && !isPrimaryStashPath(stashDir) ? bundleTarget : undefined;
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
  const installOpts = syncTarget !== undefined ? { target: syncTarget } : undefined;
  const allEntries = await sched.list();
  // Attribution filter: only entries installed from THIS bundle are reconciled
  // here. Entries carrying a `--target` for a different bundle are invisible to
  // this sync — never removed, never touched.
  const present = new Map(allEntries.filter((t) => sameBundle(t.target, syncTarget)).map((t) => [t.id, t] as const));
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
      // A bare id can only be scheduled from ONE bundle at a time (scheduler ids
      // are never namespaced). If this id is already scheduled from a different
      // bundle, refuse rather than clobber it — surface it as a per-task skip so
      // the rest of the sync still proceeds.
      const foreign = allEntries.find((e) => e.id === id && !sameBundle(e.target, syncTarget));
      if (foreign) throw new UsageError(foreignScheduleMessage(id, foreign.target), "RESOURCE_ALREADY_EXISTS");
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
      try {
        const runtimeOpts = schedulerInstallOptions(
          installOpts,
          undefined,
          deps,
          options.rebind === true,
          `create scheduler entry for task "${id}"`,
        );
        await sched.install(task, runtimeOpts);
        installed.push(id);
      } catch (error) {
        skipped.push({ id, reason: error instanceof Error ? error.message : String(error) });
      }
      continue;
    }
    // Already installed — reconcile against the current definition. Compare the
    // installed signature to what this task would render to; reinstall on drift.
    // When the backend can't produce a signature (no expectedSignature, or it
    // didn't record one), reinstall unconditionally — install() is idempotent,
    // so the cost is one crontab write and correctness is guaranteed.
    const installedEntry = present.get(id)!;
    if (!options.rebind && installedEntry.binding && !installedEntry.contextPath) {
      skipped.push({
        id,
        reason: `Installed scheduler entry is legacy; run \`akm tasks sync --rebind\` to migrate it.`,
      });
      continue;
    }
    if (!options.rebind && !installedEntry.binding && !deps.backend) {
      skipped.push({
        id,
        reason: `Installed scheduler binding could not be read; run \`akm tasks sync --rebind\` to replace it.`,
      });
      continue;
    }
    const runtimeOpts = schedulerInstallOptions(
      installOpts,
      options.rebind ? undefined : installedEntry,
      deps,
      options.rebind === true,
      `rebind scheduler entry for task "${id}"`,
    );
    const installedSig = installedEntry.signature;
    const expectedSig = sched.expectedSignature?.(task, runtimeOpts);
    if (installedSig !== undefined && expectedSig !== undefined && installedSig === expectedSig) {
      unchanged.push(id);
    } else {
      await sched.install(task, runtimeOpts);
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
  akm: { argv: string[]; via: string; kind?: string; eligible?: boolean };
  caller: { argv: string[]; via: string; kind?: string; eligible?: boolean };
  bindings: Array<{
    argv: string[];
    contextPath?: string;
    taskIds: string[];
    status: string[];
  }>;
  remediation: "akm tasks sync --rebind";
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

export async function akmTasksDoctor(
  input: { target?: string } = {},
  deps: { backend?: TaskBackend; resolveInvocation?: typeof resolveAkmInvocation } = {},
): Promise<TasksDoctorResult> {
  const warnings: string[] = [];
  let invocation: { argv: string[]; via: string; kind?: string; eligible?: boolean } = {
    argv: [],
    via: "unresolved",
  };
  try {
    const r = (deps.resolveInvocation ?? resolveAkmInvocation)();
    invocation = { argv: r.argv, via: r.via, kind: r.kind, eligible: r.eligible };
  } catch (err) {
    warnings.push(err instanceof Error ? err.message : String(err));
  }
  // `--target` scopes the tasks/ directory doctor inspects for advisories.
  let inspectDir: string | undefined;
  try {
    inspectDir = resolveTaskInspectDir(input.target);
    const typeRoot = path.join(inspectDir, "tasks");
    if (fs.existsSync(typeRoot)) warnLegacyMdTaskFiles(typeRoot);
  } catch {
    // doctor must never fail on stash-resolution; the warning is best-effort
  }
  const skipNativeInspection = process.env.BUN_TEST === "1" && !deps.backend;
  const sched = deps.backend ?? (skipNativeInspection ? undefined : selectBackend());
  const backend = sched?.name ?? backendNameForPlatform();
  let installed: InstalledTaskRef[] = [];
  if (skipNativeInspection) {
    warnings.push("Native scheduler inspection is skipped inside the bun test harness.");
  } else {
    try {
      installed = await sched!.list();
    } catch (error) {
      warnings.push(
        `Unable to inspect installed ${backend} definitions: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const bindings = groupInstalledBindings(installed);
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
    caller: invocation,
    bindings,
    remediation: "akm tasks sync --rebind",
    logDir: getTaskLogDir(),
    historyDir: getTaskHistoryDir(),
    engine: { defaultEngine, available: engines },
    stale: collectStaleTaskIds(inspectDir),
    staleGeneratedCommands: collectStaleGeneratedCommands(inspectDir),
    scheduleSubset: SCHEDULE_SUPPORTED_SUBSET_HINT,
    warnings,
    ...(improveTriage ? { improveTriage } : {}),
  };
}

// ── helpers ─────────────────────────────────────────────────────────────────

function schedulerInstallOptions(
  base: { target?: string } | undefined,
  installed: InstalledTaskRef | undefined,
  deps: { backend?: TaskBackend; schedulerRuntime?: () => PreparedSchedulerRuntime },
  explicitRebind: boolean,
  operation: string,
): { target?: string; binding?: readonly string[]; contextPath?: string | null } | undefined {
  if (installed?.binding && !explicitRebind) {
    if (!installed.contextPath && !(deps.backend && !deps.schedulerRuntime)) {
      throw new UsageError(
        `Installed scheduler entry for task "${installed.id}" is legacy; refusing to rewrite it implicitly.`,
        "INVALID_FLAG_VALUE",
        "Run `akm tasks sync --rebind` to migrate legacy scheduler entries explicitly.",
      );
    }
    return {
      ...base,
      binding: installed.binding,
      contextPath: installed.contextPath ?? null,
    };
  }
  if (installed && !installed.binding && !(deps.backend && !deps.schedulerRuntime)) {
    throw new UsageError(
      `Installed scheduler binding for task "${installed.id}" could not be read; refusing to replace it.`,
      "INVALID_FLAG_VALUE",
      "Run `akm tasks sync --rebind` to replace unreadable or legacy scheduler bindings explicitly.",
    );
  }
  // Existing injected backends predate runtime binding inspection. Preserve
  // their narrow test seam unless a runtime resolver was explicitly injected.
  if (deps.backend && !deps.schedulerRuntime) return base;
  const runtime = deps.schedulerRuntime?.() ?? prepareSchedulerRuntime(explicitRebind, operation);
  return { ...base, binding: runtime.binding, contextPath: runtime.contextPath };
}

export function prepareSchedulerRuntime(
  explicitRebind: boolean,
  operation: string,
  deps: {
    resolveInvocation?: typeof resolveAkmInvocation;
    writeDescriptor?: typeof writeSchedulerContextDescriptor;
  } = {},
): PreparedSchedulerRuntime {
  const invocation = (deps.resolveInvocation ?? resolveAkmInvocation)();
  if (!invocation.eligible && !explicitRebind) {
    throw new UsageError(
      `Refusing to ${operation} from an ineligible ${invocation.kind ?? "unknown"} invocation (${invocation.argv.join(" ")}).`,
      "INVALID_FLAG_VALUE",
      "npm-global ownership could not be verified. Run `npm install --global akm-cli` and use that launcher, use a standalone installation, or explicitly repeat the operation with --rebind.",
    );
  }
  const contextPath = (deps.writeDescriptor ?? writeSchedulerContextDescriptor)(schedulerContextDescriptor());
  return { binding: invocation.argv, contextPath };
}

function groupInstalledBindings(entries: readonly InstalledTaskRef[]): TasksDoctorResult["bindings"] {
  const groups = new Map<string, TasksDoctorResult["bindings"][number]>();
  for (const entry of entries) {
    const argv = entry.binding ?? [];
    const status = inspectInstalledBinding(entry);
    const key = JSON.stringify([argv, entry.contextPath ?? null, status]);
    const existing = groups.get(key);
    if (existing) {
      existing.taskIds.push(entry.id);
      continue;
    }
    groups.set(key, {
      argv,
      ...(entry.contextPath !== undefined ? { contextPath: entry.contextPath } : {}),
      taskIds: [entry.id],
      status,
    });
  }
  return [...groups.values()].map((group) => ({ ...group, taskIds: group.taskIds.sort() }));
}

function inspectInstalledBinding(entry: InstalledTaskRef): string[] {
  const status: string[] = [];
  if (!entry.binding || entry.binding.length === 0) status.push("missing-binding");
  if (!entry.contextPath) status.push("legacy");
  const binding = entry.binding ?? [];
  if (
    binding.some(
      (part) =>
        /(?:^|[\\/])src[\\/]cli\.ts$|(?:^|[\\/])dist[\\/](?:cli\.js|cli-node\.mjs)$/i.test(part) ||
        (path.isAbsolute(part) && hasGitAncestor(part)),
    )
  ) {
    status.push("checkout");
  }
  if (binding.some((part) => part === "akm" || part === "bun" || part === "node")) status.push("path-selected");
  if (entry.contextPath) {
    try {
      validateSchedulerContextDescriptor(entry.contextPath);
    } catch {
      status.push("invalid-context");
    }
  }
  const absolutePaths = [
    ...binding.filter((part) => path.isAbsolute(part)),
    ...(entry.contextPath ? [entry.contextPath] : []),
  ];
  if (absolutePaths.some((part) => !fs.existsSync(part))) status.push("missing-path");
  if (status.length === 0) status.push("ok");
  return status;
}

function hasGitAncestor(file: string): boolean {
  let current: string;
  try {
    current = path.dirname(fs.realpathSync(file));
  } catch {
    return false;
  }
  for (;;) {
    if (fs.existsSync(path.join(current, ".git"))) return true;
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

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

/**
 * Resolve the bundle a mutating/run task command targets. Returns the resolved
 * write/read target, its stash path, and the `--target <bundle>` token to embed
 * in scheduled invocations — undefined when the bundle is the primary stash (so
 * default-bundle cron lines stay byte-identical to pre-0.9.x installs).
 */
function resolveTaskBundle(
  target: string | undefined,
  opts: { requireWritable: boolean },
): { resolved: ResolvedWriteTarget; stashDir: string; installTarget: string | undefined } {
  const resolved = resolveWriteTarget(loadConfig(), target, { requireWritable: opts.requireWritable });
  const stashDir = resolved.source.path;
  const installTarget = isPrimaryStashPath(stashDir) ? undefined : (resolved.selector ?? resolved.source.name);
  return { resolved, stashDir, installTarget };
}

/**
 * Resolve the tasks/ directory a read/inspect command (run/sync/history/doctor)
 * operates on. No `--target` keeps the primary stash (byte-identical default);
 * `--target X` resolves bundle X read-only.
 */
function resolveTaskInspectDir(target: string | undefined): string {
  if (target === undefined) return resolveStashDir();
  return resolveWriteTarget(loadConfig(), target, { requireWritable: false }).source.path;
}

/** True when `candidate` resolves to the same directory as the primary stash. */
function isPrimaryStashPath(candidate: string): boolean {
  let primary: string | undefined;
  try {
    primary = path.resolve(resolveStashDir());
  } catch {
    return false;
  }
  return path.resolve(candidate) === primary;
}

/** Two bundle attributions match when both are the primary (undefined) or equal names. */
function sameBundle(a: string | undefined, b: string | undefined): boolean {
  return (a ?? undefined) === (b ?? undefined);
}

function foreignScheduleMessage(id: string, existingTarget: string | undefined): string {
  const where = existingTarget === undefined ? "the default bundle" : `bundle "${existingTarget}"`;
  return `Task id "${id}" is already scheduled from ${where}; rename the task or disable the existing one first.`;
}

/**
 * Refuse to schedule an id already installed from a DIFFERENT bundle. Scheduler
 * ids are the bare task id (never namespaced), so a single id can be active from
 * only one bundle at a time — a collision is a hard error, not an auto-rename.
 */
function assertNoForeignSchedule(
  entries: readonly InstalledTaskRef[],
  id: string,
  installTarget: string | undefined,
): void {
  const foreign = entries.find((entry) => entry.id === id && !sameBundle(entry.target, installTarget));
  if (foreign) throw new UsageError(foreignScheduleMessage(id, foreign.target), "RESOURCE_ALREADY_EXISTS");
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

function collectStaleTaskIds(stashDir?: string): string[] {
  const typeRoot = path.join(stashDir ?? resolveStashDir(), "tasks");
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

// Old-spelling match keys for the default-task commands whose retired
// `--auto-accept safe` flag is dropped in the `replacement`. Each id lists BOTH
// deprecated spellings that can survive in a v2 task file: the original
// `--profile X --auto-accept safe` and the intermediate `--strategy X
// --auto-accept safe` (what the 0.8→0.9 migration writes — parser normalization
// only rewrites `--profile`→`--strategy` for legacy v1 files, so a stored v2
// file keeps whichever spelling it was minted with). Without the `--strategy`
// variant, migrated default tasks match no key and warn on every run until 0.10
// (chunk-6 ledger residue).
const STALE_GENERATED_COMMANDS: Record<string, { commands: readonly string[]; replacement: string }> = {
  "akm-improve-frequent": {
    commands: [
      "akm improve --profile frequent --auto-accept safe",
      "akm improve --strategy frequent --auto-accept safe",
    ],
    replacement: "akm improve --strategy frequent",
  },
  "akm-improve-consolidate": {
    commands: [
      "akm improve --profile consolidate --auto-accept safe",
      "akm improve --strategy consolidate --auto-accept safe",
    ],
    replacement: "akm improve --strategy consolidate",
  },
  "akm-improve-nightly": {
    commands: [
      "akm improve --profile thorough --auto-accept safe",
      "akm improve --strategy thorough --auto-accept safe",
    ],
    replacement: "akm improve --strategy thorough",
  },
  "akm-improve-catchup": {
    commands: ["akm improve --profile catchup --auto-accept safe", "akm improve --strategy catchup --auto-accept safe"],
    replacement: "akm improve --strategy catchup",
  },
  "akm-graph-refresh-weekly": {
    commands: [
      "akm improve --profile graph-refresh --auto-accept safe",
      "akm improve --strategy graph-refresh --auto-accept safe",
    ],
    replacement: "akm improve --strategy graph-refresh",
  },
};

function collectStaleGeneratedCommands(stashDir?: string): Array<{ id: string; replacement: string }> {
  const typeRoot = path.join(stashDir ?? resolveStashDir(), "tasks");
  if (!fs.existsSync(typeRoot)) return [];
  const stale: Array<{ id: string; replacement: string }> = [];
  for (const [id, expected] of Object.entries(STALE_GENERATED_COMMANDS)) {
    const filePath = path.join(typeRoot, `${id}.yml`);
    if (!fs.existsSync(filePath)) continue;
    try {
      const task = parseTaskDocument({ yaml: fs.readFileSync(filePath, "utf8"), filePath, id });
      if (task.target.kind === "command" && expected.commands.includes(task.target.cmd.join(" "))) {
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

// Accept a bare task id or the canonical 0.9.0 `[bundle//]tasks/<id>` ref
// (ref-grammar decision D-R3). The pre-0.9.0 `task:<id>` colon grammar is
// retired and rejected loudly — it appears NOWHERE after the flip.
export function parseTaskRef(input: string): { id: string } {
  const trimmed = input.trim();
  // Canonical conceptId form: `[bundle//]tasks/<id>`. A `/` unambiguously marks
  // it — a bare task id can never contain `/` (`validateTaskId` forbids it) — so
  // route it through the shared parser, which strips any bundle prefix and maps
  // the `tasks/` stash-subdir back to the `task` type in one place.
  if (trimmed.includes("/")) {
    try {
      const parsed = parseRefInput(trimmed);
      if (parsed.type === "task") return { id: normaliseTaskId(parsed.name) };
    } catch {
      // fall through to the shared error below
    }
    throw new UsageError(`Expected a task id or tasks/<id> ref, got "${input}".`, "INVALID_FLAG_VALUE");
  }
  // Legacy `task:<id>` grammar is gone in 0.9.0 (D-R3) — reject it with a typed
  // error that names the new form so muscle-memory callers get a clear fix.
  if (trimmed.includes(":")) {
    const legacyName = trimmed.slice(trimmed.indexOf(":") + 1);
    throw new UsageError(
      `The \`task:<id>\` ref grammar was removed in 0.9.0 — use the bare id or \`tasks/${legacyName || "<id>"}\`.`,
      "INVALID_FLAG_VALUE",
    );
  }
  return { id: normaliseTaskId(trimmed) };
}
