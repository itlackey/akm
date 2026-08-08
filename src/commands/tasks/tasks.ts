// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm task` — register, inspect, run, and remove scheduled task assets.
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
import { IMPROVE_AUTONOMY_CONFIG_KEY, isImproveAutonomyEnabled } from "../../core/config/experimental";
import { ConfigError, NotFoundError, UsageError } from "../../core/errors";
import { getTaskHistoryDir, getTaskLogDir } from "../../core/paths";
import {
  commitWriteTargetBoundary,
  deleteAssetFromSource,
  prepareWriteTargetForMutation,
  type ResolvedWriteTarget,
  resolveWriteTarget,
  writeAssetToSource,
} from "../../core/write-source";
import { withEngineFallback } from "../../integrations/agent/engine-fallback";
import { backendNameForPlatform, selectBackend } from "../../tasks/backends";
import type { InstalledTaskRef, RebindTaskRef, TaskBackend } from "../../tasks/backends/types";
import { parseTaskDocument } from "../../tasks/parser";
import { type ResolvedAkmInvocation, resolveAkmInvocation } from "../../tasks/resolve-akm-bin";
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
import { applyAutonomyGate, configuredDirectAutonomyLanes, describeGatedLanes } from "../improve/autonomy-gate";
import { resolveImproveStrategy } from "../improve/improve-strategies";

export interface TasksAddInput {
  id: string;
  schedule: string;
  /**
   * Bundle to write the task into and schedule from. Defaults to the primary /
   * default write target. Resolved via {@link resolveWriteTarget}; a non-default
   * bundle is recorded in the scheduled invocation as `--bundle <bundle>`.
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
  bundleDir: string;
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
  /** Eligibility of the resolved invocation; absent when the caller supplied its own runtime. */
  eligible?: boolean;
  kind?: ResolvedAkmInvocation["kind"];
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
  // `--timeout-ms` IS valid on a workflow task: it is the whole-run bound the
  // task runner turns into an abort signal (issue 11), the same one
  // `akm workflow run --timeout` applies interactively. Engine and model stay
  // prompt-only — a workflow's engines come from its frozen plan.
  if (input.workflow && (input.engine !== undefined || input.model !== undefined)) {
    throw new UsageError(
      "Workflow tasks accept --params and --timeout-ms; engine and model are prompt-task fields.",
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
  // Pre-0.8.0 tasks were markdown; the 0.8.0 cutover moved them to pure YAML
  // (see the tasks dir rule in src/indexer/walk/matchers.ts). A leftover
  // `<id>.md` still names the same task, so creating `<id>.yml` beside it
  // must collide loudly rather than silently minting a duplicate.
  const legacyAssetPath = path.join(typeRoot, `${id}.md`);
  if ((fs.existsSync(assetPath) || fs.existsSync(legacyAssetPath)) && !input.force) {
    throw new UsageError(
      `Task "${id}" already exists. Pass --force to overwrite, or delete its file and run \`akm task sync\` first.`,
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
    bundleDir: stashDir,
    schedule: task.schedule,
    enabled: task.enabled,
    backend,
    target: task.target,
  };
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
    // No --bundle uses the primary stash. With --bundle, resolve (read-only)
    // the named bundle so the task file and
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
  // History rows are keyed by task id in state.db, not per bundle.
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
  /** Present only when a rebind bound an ineligible (e.g. mutable checkout) runtime. */
  warnings?: string[];
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
 * `--bundle <bundle>` scopes the reconciliation to that bundle: the file set is
 * the bundle's `tasks/*.yml` and — crucially — the scheduler entries considered
 * are ONLY those attributed to the same bundle (parsed from the installed
 * `--bundle` token; absent ⇒ primary). This is the security boundary that keeps
 * "registering a bundle never activates code": a plain (primary) sync never
 * installs from, updates, or removes another bundle's entries, and sync never
 * scans all bundles. Activation happens only through explicit `add --bundle`
 * (or `sync --bundle` on a bundle whose task files are already present).
 */
export async function akmTasksSync(
  deps: { backend?: TaskBackend; schedulerRuntime?: () => PreparedSchedulerRuntime } = {},
  bundleTarget?: string,
  options: { rebind?: boolean } = {},
): Promise<TasksSyncResult> {
  const stashDir = resolveTaskInspectDir(bundleTarget);
  // Primary-bundle scheduler entries omit --bundle; other bundles carry it.
  const syncTarget = bundleTarget !== undefined && !isPrimaryStashPath(stashDir) ? bundleTarget : undefined;
  const typeRoot = path.join(stashDir, "tasks");
  const fileIds = fs.existsSync(typeRoot)
    ? fs
        .readdirSync(typeRoot)
        .filter((f) => f.endsWith(".yml"))
        .map((f) => f.slice(0, -4))
    : [];
  const sched = deps.backend ?? selectBackend();
  const backend = sched.name;
  const installOpts = syncTarget !== undefined ? { target: syncTarget } : undefined;
  const allEntries: Array<InstalledTaskRef | RebindTaskRef> =
    options.rebind && sched.listForRebind ? await sched.listForRebind() : await sched.list();
  // Attribution filter: only entries installed from THIS bundle are reconciled
  // here. Entries carrying a `--bundle` for a different bundle are invisible to
  // this sync — never removed, never touched.
  const present = new Map(allEntries.filter((t) => sameBundle(t.target, syncTarget)).map((t) => [t.id, t] as const));
  const installed: string[] = [];
  const updated: string[] = [];
  const unchanged: string[] = [];
  const skipped: { id: string; reason: string }[] = [];
  const warnings: string[] = [];

  for (const id of fileIds) {
    const filePath = path.join(typeRoot, `${id}.yml`);
    let task: TaskDocument;
    try {
      task = parseTaskDocument({ yaml: fs.readFileSync(filePath, "utf8"), filePath, id });
      await validateTaskDocument(task, { backend, stashDir });
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
          warnings,
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
    const runtimeOpts = schedulerInstallOptions(
      installOpts,
      options.rebind ? undefined : (installedEntry as InstalledTaskRef),
      deps,
      options.rebind === true,
      `rebind scheduler entry for task "${id}"`,
      warnings,
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
  return {
    installed,
    updated,
    removed,
    unchanged,
    skipped,
    backend: sched.name,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

export interface TasksDoctorResult {
  backend: string;
  akm: { argv: string[]; via: string; kind?: string; eligible?: boolean };
  caller: { argv: string[]; via: string; kind?: string; eligible?: boolean };
  bindings: Array<{
    argv: string[];
    contextPath: string;
    taskIds: string[];
    status: string[];
  }>;
  remediation?: "akm task sync --rebind";
  logDir: string;
  historyDir: string;
  engine: { defaultEngine?: string; available: string[] };
  scheduleSubset: string;
  warnings: string[];
  /**
   * Effective proposal-queue triage settings for the default improve strategy.
   * Absent when the resolved strategy has no `triage` process block.
   */
  /**
   * D8 — the autonomy gate's effect on the default improve strategy. A scheduled
   * run that quietly stopped consolidating is the silent no-op the gate exists
   * to prevent, and this is where an operator looks for the explanation.
   */
  improveAutonomy?: {
    enabled: boolean;
    configKey: string;
    gatedLanes: { lane: string; reason: string }[];
  };
  improveTriage?: {
    defaultStrategy: string;
    enabled: boolean;
    applyMode: string;
    policy: string;
  };
}

export async function akmTasksDoctor(
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
  const bindings = groupInstalledBindings(installed, invocation);
  // Report the EFFECTIVE engine view — the same one the runner resolves —
  // so doctor never says "no engine" on an install where tasks actually run.
  const { config } = withEngineFallback(loadConfig());
  const defaultEngine = config.defaults?.engine;
  const engines = Object.keys(config.engines ?? {});

  // §6.1: surface the effective triage settings for the default improve
  // strategy. The struct is a fixed shape, so this is a deliberate addition.
  const improveStrategyName =
    typeof config.defaults?.improveStrategy === "string" ? config.defaults.improveStrategy : "default";
  // D8 — report the EFFECTIVE strategy, not the raw one. Resolving the raw
  // strategy here would report `applyMode: "promote"` for a promote strategy
  // under a review-first config, while the run actually uses "queue" — a doctor
  // command lying about the thing it exists to diagnose.
  const rawStrategy = resolveImproveStrategy(config.defaults?.improveStrategy, config).config;
  const { config: effectiveStrategy, gated } = applyAutonomyGate(rawStrategy, config);
  const autonomyEnabled = isImproveAutonomyEnabled(config);
  // Memory cleanup has no strategy flag to downgrade, so add that direct lane
  // to the strategy-derived gate report.
  const allGated = autonomyEnabled ? [] : [...gated, ...describeGatedLanes(configuredDirectAutonomyLanes())];
  const improveAutonomy = {
    enabled: autonomyEnabled,
    configKey: IMPROVE_AUTONOMY_CONFIG_KEY,
    gatedLanes: allGated.map((entry) => ({ lane: entry.lane as string, reason: entry.reason })),
  };
  const triage = effectiveStrategy.processes?.triage;
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
    ...(bindings.some((binding) => !binding.status.includes("ok"))
      ? { remediation: "akm task sync --rebind" as const }
      : {}),
    logDir: getTaskLogDir(),
    historyDir: getTaskHistoryDir(),
    engine: { defaultEngine, available: engines },
    scheduleSubset: SCHEDULE_SUPPORTED_SUBSET_HINT,
    warnings,
    improveAutonomy,
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
  warnings: string[] = [],
): { target?: string; binding?: readonly string[]; contextPath?: string } | undefined {
  if (installed && !explicitRebind) {
    return {
      ...base,
      binding: installed.binding,
      contextPath: installed.contextPath,
    };
  }
  // Injected backends can own their default runtime unless a resolver is supplied.
  if (deps.backend && !deps.schedulerRuntime) return base;
  const runtime = deps.schedulerRuntime?.() ?? prepareSchedulerRuntime(explicitRebind, operation);
  // --rebind bypasses the eligibility refusal in prepareSchedulerRuntime; warn once
  // per sync run rather than silently writing a mutable/unproven binary into cron.
  if (explicitRebind && runtime.eligible === false && warnings.length === 0) {
    warnings.push(
      `--rebind bound scheduled tasks to an ineligible ${runtime.kind ?? "unknown"} invocation (${runtime.binding.join(" ")}); scheduled runs will invoke a mutable, unproven binary. Install akm via \`npm install --global akm-cli\` or a standalone release, then re-run \`akm task sync --rebind\`.`,
    );
  }
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
  return { binding: invocation.argv, contextPath, eligible: invocation.eligible, kind: invocation.kind };
}

function groupInstalledBindings(
  entries: readonly InstalledTaskRef[],
  invocation: TasksDoctorResult["akm"],
): TasksDoctorResult["bindings"] {
  const groups = new Map<string, TasksDoctorResult["bindings"][number]>();
  for (const entry of entries) {
    const argv = entry.binding;
    const status = inspectInstalledBinding(entry, invocation);
    const key = JSON.stringify([argv, entry.contextPath, status]);
    const existing = groups.get(key);
    if (existing) {
      existing.taskIds.push(entry.id);
      continue;
    }
    groups.set(key, {
      argv,
      contextPath: entry.contextPath,
      taskIds: [entry.id],
      status,
    });
  }
  return [...groups.values()].map((group) => ({ ...group, taskIds: group.taskIds.sort() }));
}

function inspectInstalledBinding(entry: InstalledTaskRef, invocation: TasksDoctorResult["akm"]): string[] {
  const status: string[] = [];
  const binding = entry.binding;
  if (
    !(invocation.eligible === true && sameArgv(binding, invocation.argv)) &&
    binding.some(
      (part) =>
        /(?:^|[\\/])src[\\/]cli\.ts$|(?:^|[\\/])dist[\\/](?:cli\.js|cli-node\.mjs)$/i.test(part) ||
        (path.isAbsolute(part) && hasGitAncestor(part)),
    )
  ) {
    status.push("checkout");
  }
  if (binding.some((part) => part === "akm" || part === "bun" || part === "node")) status.push("path-selected");
  try {
    validateSchedulerContextDescriptor(entry.contextPath);
  } catch {
    status.push("invalid-context");
  }
  const absolutePaths = [...binding.filter((part) => path.isAbsolute(part)), entry.contextPath];
  if (absolutePaths.some((part) => !fs.existsSync(part))) status.push("missing-path");
  if (status.length === 0) status.push("ok");
  return status;
}

function sameArgv(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
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
 * write/read target, its stash path, and the `--bundle <bundle>` token to embed
 * in scheduled invocations. The primary bundle uses the target-less form.
 */
function resolveTaskBundle(
  target: string | undefined,
  opts: { requireWritable: boolean },
): { resolved: ResolvedWriteTarget; stashDir: string; installTarget: string | undefined } {
  const selected = resolveWriteTarget(loadConfig(), target, { requireWritable: opts.requireWritable });
  const resolved = opts.requireWritable ? prepareWriteTargetForMutation(selected) : selected;
  const stashDir = resolved.source.path;
  const installTarget = isPrimaryStashPath(stashDir) ? undefined : (resolved.selector ?? resolved.source.name);
  return { resolved, stashDir, installTarget };
}

/**
 * Resolve the tasks/ directory a read/inspect command operates on. No
 * `--bundle` uses the primary stash; `--bundle X` resolves bundle X read-only.
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
    if (input.timeoutMs !== undefined) obj.timeoutMs = input.timeoutMs;
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
// `akm task run` completes.
export { ConfigError, exitCodeForStatus, NotFoundError, parseTaskDocument, UsageError };

// Accept a bare task id or the canonical `[bundle//]tasks/<id>` ref.
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
  return { id: normaliseTaskId(trimmed) };
}
