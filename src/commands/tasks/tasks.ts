// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm task` — register, inspect, run, and remove scheduled task assets.
 *
 * Each handler exported here is a pure function that performs the real work;
 * `src/cli.ts` wraps these in citty `defineCommand`s and shapes their return
 * values via `output()`.
 *
 * Every command that writes the native scheduler (`add`, `enable`,
 * `disable`, `sync`, `prune --yes`) runs under the one scheduler lock
 * (`withSchedulerLock`): read the installed rows once, plan against the
 * sources, then install, update, or remove row by row. One row that fails is
 * reported and the rest still apply.
 */

import fs from "node:fs";
import path from "node:path";
import { stringify as yamlStringify } from "yaml";
import { detectAdapterId } from "../../core/adapter/detect-adapter";
import { assetPathForName } from "../../core/asset/asset-placement";
import { makeBundleRef, parseBundleRef } from "../../core/asset/asset-ref";
import { type AssetRef, conceptIdFromTypeName, isFullRefInput } from "../../core/asset/resolve-ref";
import { isWithin, resolveStashDir } from "../../core/common";
import { loadConfig, mutateConfig, resetConfigCache } from "../../core/config/config";
import {
  bundleKeyForContentRoot,
  resolveActiveConfiguredSources,
  resolveConfiguredSources,
} from "../../core/config/config-sources";
import type { AkmConfig } from "../../core/config/config-types";
import { IMPROVE_AUTONOMY_CONFIG_KEY, isImproveAutonomyEnabled } from "../../core/config/experimental";
import { ConfigError, NotFoundError, UsageError } from "../../core/errors";
import { getTaskHistoryDir, getTaskLogDir } from "../../core/paths";
import { warn } from "../../core/warn";
import {
  commitWriteTargetBoundary,
  isWriteCapableSourceKind,
  prepareWriteTargetForMutation,
  type ResolvedWriteTarget,
  resolveWorkingStashTarget,
  resolveWriteTarget,
  writeAssetToSource,
} from "../../core/write-source";
import type { InputFlag } from "../../execution/input-contract";
import { withEngineFallback } from "../../integrations/agent/engine-fallback";
import { resolveAssetPath } from "../../sources/resolve";
import { enabledRefsFromInstalled, schedulerEnabledRefs, setSchedulerRefEnabled } from "../../tasks/activation-config";
import { backendNameForPlatform, selectBackend } from "../../tasks/backends";
import type { InstalledSchedulerBinding, SchedulerBackend, SchedulerInstallOptions } from "../../tasks/backends/types";
import { prepareTaskV3Execution } from "../../tasks/prepare/prepare";
import type { PrepareTaskV3ExecutionContext } from "../../tasks/prepare/prepared-execution";
import { isCheckoutInvocation, type ResolvedAkmInvocation, resolveAkmInvocation } from "../../tasks/resolve-akm-bin";
import { createExecutionProvenanceContext } from "../../tasks/run/provenance";
import { runTask } from "../../tasks/run/run-task";
import { readTaskHistory } from "../../tasks/run/task-history";
import { exitCodeForStatus, type RunTaskOptions, type TaskRunResult } from "../../tasks/run/task-result";
import { parseSchedule, SCHEDULE_SUPPORTED_SUBSET_HINT } from "../../tasks/schedule";
import {
  compileTaskSchedulerBindings,
  type SchedulerBinding,
  schedulerBindingNativeId,
} from "../../tasks/scheduler-binding";
import {
  schedulerContextDescriptor,
  schedulerContextPath,
  validateSchedulerContextDescriptor,
  writeSchedulerContextDescriptor,
} from "../../tasks/scheduler-invocation";
import { withSchedulerLock } from "../../tasks/scheduler-lock";
import {
  compileSchedulerSources,
  installedRowNativeId,
  installedRowOwner,
  installedRowScope,
  planSchedulerSync,
  renderSchedulerPlanPreview,
  type SchedulerBundleScope,
  type SchedulerPlanPreview,
  type SchedulerSourceFailure,
  type SchedulerSyncOperation,
  type SchedulerSyncPlan,
  scheduledInvocationBundle,
} from "../../tasks/scheduler-sync";
import { parseTaskSource } from "../../tasks/source/parse-task-source";
import { projectTaskSourceV4 } from "../../tasks/source/project-v4";
import type { TaskV3SourceDocument } from "../../tasks/source-v3";
import { normaliseTaskConceptId, normaliseTaskId } from "../../tasks/task-id";
import { applyAutonomyGate, configuredDirectAutonomyLanes, describeGatedLanes } from "../improve/autonomy-gate";
import { resolveImproveStrategy } from "../improve/improve-strategies";

export interface TasksAddInput {
  id: string;
  schedule: string;
  /**
   * Bundle to write the task into and schedule from. Defaults to the primary /
   * default write target. Resolved via {@link resolveWriteTarget}.
   */
  target?: string;
  workflow?: string;
  prompt?: string;
  /**
   * Exact shell command string to run on the schedule. Arrays are rejected so
   * authoring cannot silently change shell semantics. Mutually exclusive with
   * `workflow` and `prompt`.
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
  /** Also point the bundle's installed rows at this akm invocation, as `task sync --rebind` does. */
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
  target: TaskV3SourceDocument["target"];
}

export interface TaskMutationDeps {
  backend?: SchedulerBackend;
  writeAsset?: typeof writeAssetToSource;
  commitBoundary?: typeof commitWriteTargetBoundary;
  schedulerRuntime?: () => PreparedSchedulerRuntime;
}

/** The launcher and descriptor path rows are written with. Tests inject one. */
export interface PreparedSchedulerRuntime {
  binding: string[];
  contextPath: string;
  via?: ResolvedAkmInvocation["via"];
}

type SchedulerDeps = Pick<TaskMutationDeps, "backend" | "schedulerRuntime">;

export async function akmTasksAdd(input: TasksAddInput, deps: TaskMutationDeps = {}): Promise<TasksAddResult> {
  const id = normaliseTaskId(input.id);
  assertTaskAddTargetShape(input);

  // Validate the schedule for the active backend before writing anything. An
  // injected backend (tests) carries its own name.
  const backend = deps.backend?.name ?? backendNameForPlatform();
  parseSchedule(input.schedule, backend);

  const bundle = resolveTaskBundle(input.target);
  const stashDir = bundle.stashDir;
  const typeRoot = path.join(stashDir, "tasks");
  const assetPath = assetPathForName("task", typeRoot, id);
  if (!isWithin(assetPath, typeRoot)) {
    throw new UsageError(`Resolved task path escapes the stash: "${id}".`, "PATH_ESCAPE_VIOLATION");
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
  });

  const parsedTask = parseTaskSource({ yaml, filePath: assetPath, workspaceRoot: stashDir });
  const task = projectTaskSourceV4(parsedTask.v4);
  const qualifiedRef = makeBundleRef(bundle.bundleName, `tasks/${id}`);
  await prepareTaskV3Execution(task, {
    taskId: id,
    taskRef: qualifiedRef,
    bundleName: bundle.bundleName,
    bundleRoot: stashDir,
    config: bundle.config,
    resolveAsset: taskProjectionAssetResolver(bundle.config, bundle.bundleName, stashDir),
  });
  const bindings = compileTaskSchedulerBindings({
    id,
    qualifiedRef,
    schedules: parsedTask.v4.schedule.map((schedule) => ({
      cron: schedule.cron,
      ordinal: schedule.ordinal,
      source: schedule.source,
      inputs: schedule.inputs,
    })),
  });
  const first = bindings[0];
  if (!first) throw new UsageError(`Task "${id}" has no schedulable trigger.`, "INVALID_FLAG_VALUE");

  const sched = deps.backend ?? selectBackend();
  return withSchedulerLock(async () => {
    if (fs.existsSync(assetPath) && !input.force) {
      throw new UsageError(
        `Task "${id}" already exists. Pass --force to overwrite, or delete its file and run \`akm task sync\` first.`,
        "RESOURCE_ALREADY_EXISTS",
      );
    }
    // Native ids are shared by every bundle and installation: refuse before
    // writing anything when another one already schedules this id.
    const scope = bundleScope(bundle.bundleName, stashDir);
    const installed = await listInstalledRows(sched);
    for (const binding of bindings) {
      const row = installed.find((candidate) => installedRowNativeId(candidate) === schedulerBindingNativeId(binding));
      if (row && !installedRowScope(row, [scope])) {
        throw new UsageError(
          `Task id "${id}" is already scheduled from ${installedRowOwner(row)}; rename the task or disable the existing one first.`,
          "RESOURCE_ALREADY_EXISTS",
        );
      }
    }
    await ensureSchedulerChoice({ backend: sched });
    if (input.disabled) setSchedulerRefEnabled(qualifiedRef, false);
    await (deps.writeAsset ?? writeAssetToSource)(
      bundle.resolved.source,
      bundle.resolved.config,
      taskAssetRef(id),
      yaml,
    );
    (deps.commitBoundary ?? commitWriteTargetBoundary)(bundle.resolved, `Update tasks/${id}`);
    if (!input.disabled) setSchedulerRefEnabled(qualifiedRef, true);
    const sync = await akmTasksSync(deps, bundle.bundleName, { rebind: input.rebind === true });
    for (const warning of sync.warnings ?? []) warn(warning);
    const failure = sync.failures.find((candidate) => candidate.ref === qualifiedRef);
    if (failure) {
      throw new ConfigError(
        `Task "${id}" was written to ${assetPath}${input.disabled ? "" : " and enabled"}, but it could not be scheduled: ${failure.reason}`,
        "INVALID_CONFIG_FILE",
        "Fix the cause and run `akm task sync`.",
      );
    }
    return {
      id,
      ref: conceptIdFromTypeName("task", id),
      path: assetPath,
      bundleDir: stashDir,
      schedule: first.cron,
      enabled: input.disabled !== true,
      backend,
      target: task.target,
    };
  });
}

function assertTaskAddTargetShape(input: TasksAddInput): void {
  const hasCommand =
    input.command !== undefined &&
    input.command !== null &&
    !(typeof input.command === "string" && input.command.trim() === "") &&
    !(Array.isArray(input.command) && input.command.length === 0);
  const targetCount = [Boolean(input.workflow), Boolean(input.prompt), hasCommand].filter(Boolean).length;
  if (targetCount !== 1) {
    throw new UsageError(
      "Pass exactly one of --workflow <ref>, --prompt <inline-text>, or --command <shell-command>.",
      "INVALID_FLAG_VALUE",
    );
  }
  // `--timeout-ms` is the workflow's whole-run bound. Engine and model stay
  // prompt-only because workflow engines come from the frozen plan.
  if (input.workflow && (input.engine !== undefined || input.model !== undefined)) {
    throw new UsageError(
      "Workflow tasks accept --params and --timeout-ms; engine and model are prompt-task fields.",
      "INVALID_FLAG_VALUE",
    );
  }
  if (hasCommand && (input.engine !== undefined || input.model !== undefined)) {
    throw new UsageError("Command tasks accept --timeout-ms but not --engine or --model.", "INVALID_FLAG_VALUE");
  }
  if (input.prompt !== undefined) assertInlineTaskPrompt(input.prompt);
}

export interface TasksRunResultEnvelope {
  ok: boolean;
  result: TaskRunResult;
  exitCode: number;
}

export async function akmTasksRun(
  id: string,
  options: { scheduled?: boolean; target?: string; inputFlags?: readonly InputFlag[] } = {},
): Promise<TasksRunResultEnvelope> {
  const parsed = parseTaskRef(id);
  const bundle = resolveTaskReadBundle(parsed.bundle, options.target);
  const adapterId = bundle.source.adapterId ?? detectAdapterId(bundle.source.path);
  const resolvedId = taskIdForAdapter(parsed.id, adapterId);
  const scheduled = options.scheduled === true;
  // D5 "Construction" (spec docs/plans/specs/p1b-model-extraction.md §1.2/
  // §5.2): built ONCE at this invocation boundary. eventSource is "task"
  // whether or not --scheduled was passed (§1.6 D5-N1) — scheduled stays a
  // separate field carrying its own pre-existing meaning (activation policy,
  // scheduler env), never selecting the event source.
  const provenance = createExecutionProvenanceContext(scheduled);
  // F-3 (spec §5.4): RunTaskOptions.stashDir renamed to bundleDir — VALUE-
  // preserving, no CLI flag change.
  //
  // P2a Lane C (spec docs/plans/specs/p2a-task-source-v4.md §5.1): the raw,
  // exact-name input flags `tasks-cli.ts`'s Stage 1 captures ride through
  // unchanged to `runTask` -> `loadPreparedTask`'s Stage 2 materializer,
  // which owns declaring `inputFlags` on `RunTaskOptions` and attaching the
  // materialized literals to the constructed `TaskInvocation`. This is only
  // the pass-through surface: a valid flag set stays byte-identical to the
  // same run without flags (§0), and P2a delivers nothing to the target.
  //
  // No `as` cast (test-review finding, spec §6 F-5): `RunTaskOptions` (this
  // literal's inferred type is checked directly against it, below) declares
  // every one of these fields, so the compiler — not a suppressed excess-
  // property check — enforces this seam. A future rename or removal on
  // either side now fails `tsc`, not silently at the `runTask` boundary.
  const runOptions: RunTaskOptions = {
    bundleDir: bundle.source.path,
    bundleName: bundle.source.name,
    adapterId,
    scheduled,
    provenance,
    inputFlags: options.inputFlags,
  };
  // The runner owns the prepare-before-reserve boundary. Invalid source,
  // projectability, and resolver failures therefore create no history row.
  const result = await runTask(resolvedId, runOptions);
  // C-7 (spec §5.6): after D8's result-vocabulary re-code, "command" means
  // the agent/LLM arm — the native shell/script arm now reports "shell" /
  // "script". Rewired in the SAME commit as the vocabulary re-code so a
  // shell/script task's process exit 78 still passes through as CLI exit 78
  // (documented behavior, src/assets/hints/cli-hints-short.md:95).
  const exitCode =
    result.status === "failed" &&
    (result.target.kind === "shell" || result.target.kind === "script") &&
    result.detail?.exitCode === 78
      ? 78
      : exitCodeForStatus(result.status);
  return {
    ok: result.status === "completed",
    result,
    exitCode,
  };
}

export interface TasksActivationResult {
  readonly ref: string;
  readonly enabled: boolean;
  readonly changed: boolean;
  readonly sync: TasksSyncResult;
}

function resolveTaskActivation(
  ref: string,
  target: string | undefined,
  requireSchedulable: boolean,
): {
  qualifiedRef: string;
  sourcePath: string;
  bundleName: string;
} {
  const parsed = parseTaskRef(ref);
  const bundle = resolveTaskReadBundle(parsed.bundle, target);
  const adapterId = bundle.source.adapterId ?? detectAdapterId(bundle.source.path);
  const id = taskIdForAdapter(parsed.id, adapterId);
  const conceptId = adapterId === "akm" ? `tasks/${id}` : id;
  const sourcePath =
    adapterId === "akm"
      ? path.join(bundle.source.path, "tasks", `${id}.yml`)
      : path.join(bundle.source.path, `${id}.yml`);
  if (requireSchedulable && !fs.existsSync(sourcePath)) {
    throw new NotFoundError(`Task ${JSON.stringify(makeBundleRef(bundle.source.name, conceptId))} was not found.`);
  }
  if (requireSchedulable) {
    const parsedSource = parseTaskSource({
      yaml: fs.readFileSync(sourcePath, "utf8"),
      filePath: sourcePath,
      workspaceRoot: bundle.source.path,
    });
    if (parsedSource.v4.schedule.length === 0) {
      throw new UsageError(`Task ${JSON.stringify(ref)} has no schedule to enable.`, "INVALID_FLAG_VALUE");
    }
  }
  return { qualifiedRef: makeBundleRef(bundle.source.name, conceptId), sourcePath, bundleName: bundle.source.name };
}

/**
 * A config that predates `scheduler.enabled` means "keep what is installed":
 * write that as the host's explicit list before one ref is added or removed,
 * so enabling or disabling a single task never silently drops the others.
 */
async function ensureSchedulerChoice(deps: { backend?: SchedulerBackend }): Promise<void> {
  const config = loadConfig();
  if (schedulerEnabledRefs(config) !== undefined) return;
  initializeSchedulerChoice(await (deps.backend ?? selectBackend()).list(), config, { write: true });
}

function initializeSchedulerChoice(
  installed: readonly InstalledSchedulerBinding[],
  config: AkmConfig,
  options: { write: boolean },
): readonly string[] {
  const refs = enabledRefsFromInstalled(installed, config);
  if (options.write) {
    mutateConfig((current) => ({ ...current, scheduler: { ...current.scheduler, enabled: [...refs] } }));
    resetConfigCache();
  }
  warn(
    `This host had no scheduler.enabled list; ${options.write ? "it was" : "it would be"} initialized from the ` +
      `${refs.length} installed akm scheduler ${refs.length === 1 ? "binding" : "bindings"}` +
      `${refs.length > 0 ? `: ${refs.join(", ")}` : ""}. Use \`akm task enable\`/\`akm task disable <ref>\` to change it.`,
  );
  return refs;
}

export async function akmTasksEnable(
  ref: string,
  options: { target?: string } = {},
  deps: SchedulerDeps = {},
): Promise<TasksActivationResult> {
  return setTaskActivation(resolveTaskActivation(ref, options.target, true), true, deps);
}

export async function akmTasksDisable(
  ref: string,
  options: { target?: string } = {},
  deps: SchedulerDeps = {},
): Promise<TasksActivationResult> {
  return setTaskActivation(resolveTaskActivation(ref, options.target, false), false, deps);
}

async function setTaskActivation(
  resolved: { qualifiedRef: string; bundleName: string },
  enabled: boolean,
  deps: SchedulerDeps,
): Promise<TasksActivationResult> {
  return withSchedulerLock(async () => {
    await ensureSchedulerChoice(deps);
    const activation = setSchedulerRefEnabled(resolved.qualifiedRef, enabled);
    const sync = await akmTasksSync(deps, resolved.bundleName);
    return { ref: resolved.qualifiedRef, enabled, changed: activation.changed, sync };
  });
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
  const parsed = input.id ? parseTaskRef(input.id) : undefined;
  const bundle = resolveTaskReadBundle(parsed?.bundle, input.target);
  const adapterId = bundle.source.adapterId ?? detectAdapterId(bundle.source.path);
  const id = parsed ? taskIdForAdapter(parsed.id, adapterId) : undefined;
  // History rows are keyed by task id in state.db, not per bundle.
  return { rows: readTaskHistory({ id, limit }) };
}

export interface TasksSyncResult {
  installed: string[];
  /** Rows whose installed definition differed from the one the source renders and were rewritten. */
  updated: string[];
  removed: string[];
  unchanged: string[];
  skipped: { id: string; reason: string }[];
  backend: string;
  /**
   * Sources, bundles, and rows that could not be reconciled (#867) — excluded
   * from install/update/remove/unchanged above, never silently dropped. Every
   * OTHER task/workflow still reconciles; the CLI exits non-zero whenever
   * this is non-empty. Named `failures` to match the `--dry-run` preview
   * shape (#906).
   */
  failures: { path: string; ref?: string; reason: string }[];
  /** Present only when this sync wrote a source-checkout launcher into a row. */
  warnings?: string[];
}

/**
 * Reconcile host-local scheduler activation with authored tasks/workflows.
 *
 *   • without a bundle, every enabled configured filesystem/git bundle; with
 *     one, only that bundle
 *   • only refs listed in `scheduler.enabled` are read and scheduled
 *   • a row is installed when missing, rewritten when its rendered definition
 *     differs, and removed when its source is gone or no longer enabled
 *   • rows another bundle or installation owns are never touched, and a row
 *     whose source fails to compile is left as it is
 *   • a disabled bundle's rows are removed by an unscoped sync
 */
export async function akmTasksSync(
  deps: SchedulerDeps = {},
  bundleTarget?: string,
  options: { rebind?: boolean } = {},
): Promise<TasksSyncResult> {
  return withSchedulerLock(async () => {
    const { sched, plan, publish, warnings } = await buildSchedulerSyncPlan(deps, bundleTarget, options);
    if (publish && plan.operations.some((operation) => operation.kind !== "remove")) publish();
    const failed = new Set<string>();
    const failures = [...plan.failures];
    for (const operation of plan.operations) {
      try {
        if (operation.kind === "remove") await sched.uninstall(operation.nativeId);
        else await sched.install(operation.binding, operation.options);
      } catch (cause) {
        if (operation.kind === "remove") {
          failed.add(operation.id);
          failures.push({ path: operation.nativeId, reason: errorMessage(cause) });
        } else {
          failed.add(operation.binding.id);
          failures.push({
            path: operation.binding.source,
            ref: operation.binding.logicalSource.ref,
            reason: errorMessage(cause),
          });
        }
      }
    }
    const applied = (ids: readonly string[]) => ids.filter((id) => !failed.has(id));
    return {
      installed: applied(plan.installed),
      updated: applied(plan.updated),
      removed: applied(plan.removed),
      unchanged: [...plan.unchanged],
      skipped: [],
      backend: sched.name,
      failures: failures.map((failure) => ({ ...failure })),
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  });
}

/**
 * `akm task sync --dry-run` (#849): the exact plan `akmTasksSync` would
 * apply, previewed. It writes nothing: no config, no descriptor, no row.
 */
export async function akmTasksSyncPlan(
  deps: SchedulerDeps = {},
  bundleTarget?: string,
  options: { rebind?: boolean } = {},
): Promise<SchedulerPlanPreview> {
  const { sched, plan } = await buildSchedulerSyncPlan(deps, bundleTarget, { ...options, dryRun: true });
  return renderSchedulerPlanPreview(sched.name, plan.operations, plan.unchanged, plan.failures);
}

async function buildSchedulerSyncPlan(
  deps: SchedulerDeps,
  bundleTarget: string | undefined,
  options: { rebind?: boolean; dryRun?: boolean },
): Promise<{ sched: SchedulerBackend; plan: SchedulerSyncPlan; publish?: () => void; warnings: string[] }> {
  let config = loadConfig();
  const sched = deps.backend ?? selectBackend();
  const installed = await listInstalledRows(sched);

  // A config that predates `scheduler.enabled` means "keep what is
  // installed": the akm-written rows become the host's choice (written
  // unless this is a dry run) before the desired set, which would otherwise
  // remove them, is computed.
  let enabledRefs = schedulerEnabledRefs(config);
  if (enabledRefs === undefined) {
    enabledRefs = initializeSchedulerChoice(installed, config, { write: options.dryRun !== true });
    if (options.dryRun !== true) config = loadConfig();
  }

  const activeSources = resolveActiveConfiguredSources(config);
  if (bundleTarget) {
    // Only filesystem and git bundles can carry scheduler state.
    const targetSource = activeSources.find((source) => source.name === bundleTarget);
    if (targetSource && !isWriteCapableSourceKind(targetSource.type)) {
      throw new UsageError(
        `Bundle "${bundleTarget}" has kind "${targetSource.type}"; task scheduling is only supported for filesystem and git bundles.`,
        "INVALID_FLAG_VALUE",
      );
    }
  }
  const configuredSources = resolveConfiguredSources(config);
  const schedulable = activeSources
    .filter((source) => isWriteCapableSourceKind(source.type))
    .map((source) => source.name);
  // No configured bundle at all: the working stash (e.g. `AKM_BUNDLE_DIR`).
  const selected: Array<string | undefined> = bundleTarget
    ? [bundleTarget]
    : schedulable.length > 0 || configuredSources.length > 0
      ? schedulable
      : [undefined];

  const enabledRefSet = new Set(enabledRefs);
  const desired: SchedulerBinding[] = [];
  const failures: SchedulerSourceFailure[] = [];
  const keepRefs = new Set<string>();
  const scopes: SchedulerBundleScope[] = [];
  // Each bundle is its own item: one that cannot be read is reported and
  // left untouched while the others reconcile. A scoped sync has only that
  // bundle, so its failure is the whole operation's.
  for (const name of selected) {
    try {
      const resolved = resolveTaskReadBundle(undefined, name);
      const stashDir = resolved.source.path;
      const adapterId = resolved.source.adapterId ?? detectAdapterId(stashDir);
      const compiled = await compileSchedulerSources({
        sourceRoot: stashDir,
        adapterId,
        bundleName: resolved.source.name,
        backend: sched.name,
        config,
        resolveAsset: taskProjectionAssetResolver(config, resolved.source.name, stashDir),
        enabledRefs: enabledRefSet,
      });
      desired.push(...compiled.desired);
      failures.push(...compiled.failures);
      for (const failure of compiled.failures) if (failure.ref) keepRefs.add(failure.ref);
      scopes.push({ ...bundleScope(resolved.source.name, stashDir), adapterId });
    } catch (cause) {
      if (bundleTarget) throw cause;
      failures.push({ path: name ?? "(default bundle)", reason: errorMessage(cause) });
    }
  }

  // An enabled ref of a synced bundle that produced nothing names a source
  // that is gone or has no schedule; its row, if any, is removed below.
  const represented = new Set([...desired.map((binding) => binding.logicalSource.ref), ...keepRefs]);
  const synced = new Set(scopes.map((scope) => scope.bundleName));
  for (const ref of enabledRefs) {
    const bundle = parseBundleRef(ref).bundle;
    if (bundle !== undefined && synced.has(bundle) && !represented.has(ref)) {
      failures.push({ path: ref, ref, reason: `Enabled ref ${JSON.stringify(ref)} was not found or has no schedule.` });
    }
  }

  // A disabled bundle's rows go on an unscoped sync, without reading its content.
  const inactive = new Set(configuredSources.filter((source) => source.enabled === false).map((source) => source.name));
  const extraRemovals = bundleTarget
    ? []
    : installed.filter((row) => {
        const bundle = installedSchedulerBundle(config, row);
        return bundle !== undefined && inactive.has(bundle);
      });

  const runtime = prepareSchedulerRuntime(deps);
  const plan = planSchedulerSync({
    desired,
    installed,
    scopes,
    ...(sched.expectedSignature ? { expectedSignature: sched.expectedSignature.bind(sched) } : {}),
    ...(runtime.options ? { installOptions: runtime.options } : {}),
    rebind: options.rebind === true,
    extraRemovals,
    keepRefs,
  });
  const warnings: string[] = [];
  const writesLauncher =
    options.rebind === true
      ? plan.operations.some((operation) => operation.kind !== "remove")
      : plan.installed.length > 0;
  if (runtime.via === "checkout" && writesLauncher) {
    warnings.push(
      `Scheduled tasks now run akm from a source checkout (${runtime.options?.binding?.join(" ")}); they run whatever the checkout holds when they fire. Install akm with \`npm install --global akm-cli\` or a standalone release, then run \`akm task sync --rebind\`.`,
    );
  }
  return {
    sched,
    plan: { ...plan, failures: [...failures, ...plan.failures] },
    ...(runtime.publish ? { publish: runtime.publish } : {}),
    warnings,
  };
}

/**
 * The launcher and descriptor rows are written with. The descriptor follows
 * the current policy on every sync; a row that is already installed keeps its
 * launcher unless `--rebind` (see `installOptionsFor`). An injected backend
 * (tests) renders with its own defaults.
 */
function prepareSchedulerRuntime(deps: SchedulerDeps): {
  options?: SchedulerInstallOptions;
  publish?: () => void;
  via?: ResolvedAkmInvocation["via"];
} {
  if (deps.schedulerRuntime) {
    const runtime = deps.schedulerRuntime();
    return {
      options: { binding: runtime.binding, contextPath: runtime.contextPath },
      ...(runtime.via ? { via: runtime.via } : {}),
    };
  }
  if (deps.backend) return {};
  const descriptor = schedulerContextDescriptor();
  const invocation = resolveAkmInvocation();
  return {
    options: { binding: invocation.argv, contextPath: schedulerContextPath(descriptor) },
    // The content-addressed descriptor is written once, before the first row that references it.
    publish: () => {
      writeSchedulerContextDescriptor(descriptor);
    },
    via: invocation.via,
  };
}

/** One read of the akm-owned rows, each attributed to the bundle path its own descriptor names (#846). */
async function listInstalledRows(sched: SchedulerBackend): Promise<InstalledSchedulerBinding[]> {
  return (await sched.list()).map((row) => {
    const ownerBundlePath = row.contextPath ? resolveInstalledOwnerPath(row.contextPath) : undefined;
    return ownerBundlePath !== undefined ? { ...row, ownerBundlePath } : row;
  });
}

/** Best-effort recovery of an installed binding's owning bundle path (#846). */
function resolveInstalledOwnerPath(contextPath: string): string | undefined {
  try {
    return validateSchedulerContextDescriptor(contextPath).environment.AKM_BUNDLE_DIR;
  } catch {
    return undefined;
  }
}

/** The primary bundle proves its rows by path (#846); any other bundle by its config name. */
function bundleScope(bundleName: string, stashDir: string): SchedulerBundleScope {
  return isPrimaryStashPath(stashDir) ? { bundleName, bundlePath: path.resolve(stashDir) } : { bundleName };
}

function installedSchedulerBundle(config: AkmConfig, row: InstalledSchedulerBinding): string | undefined {
  const direct = row.target ?? scheduledInvocationBundle(row.invocation);
  if (direct !== undefined) return direct;
  if (row.ownerBundlePath === undefined) return undefined;
  return bundleKeyForContentRoot(config, row.ownerBundlePath);
}

export type TasksPruneReason = "invalid-context" | "dead-bundle-path";

export interface TasksPruneResult {
  readonly backend: string;
  readonly dryRun: boolean;
  readonly preview: SchedulerPlanPreview;
  readonly removed: readonly string[];
}

/**
 * Why `akm task prune` (#851) would remove an installed row: its own
 * descriptor does not load (`invalid-context`) or names a bundle directory
 * that is gone (`dead-bundle-path`). A row that still resolves to a live
 * bundle is never a candidate.
 */
function classifyPruneCandidate(entry: InstalledSchedulerBinding): TasksPruneReason | undefined {
  let ownerBundlePath: string | undefined;
  try {
    ownerBundlePath = validateSchedulerContextDescriptor(entry.contextPath).environment.AKM_BUNDLE_DIR;
  } catch {
    return "invalid-context";
  }
  if (ownerBundlePath !== undefined && !fs.existsSync(ownerBundlePath)) return "dead-bundle-path";
  return undefined;
}

/**
 * `akm task prune` (#851): remove installed rows `sync` can never reclaim
 * because their descriptor no longer resolves to a live bundle. It scans
 * every installed row, not one bundle's. Without `--yes` it only previews and
 * writes nothing; `--id` narrows it to named candidates.
 */
export async function akmTasksPrune(
  deps: { backend?: SchedulerBackend } = {},
  options: { yes?: boolean; id?: readonly string[] } = {},
): Promise<TasksPruneResult> {
  const prune = async (): Promise<TasksPruneResult> => {
    const sched = deps.backend ?? selectBackend();
    const operations = pruneOperations(await sched.list(), options.id ?? []);
    const preview = renderSchedulerPlanPreview(sched.name, operations);
    if (!options.yes) return { backend: sched.name, dryRun: true, preview, removed: [] };
    for (const operation of operations) await sched.uninstall(operation.nativeId);
    return { backend: sched.name, dryRun: false, preview, removed: operations.map((operation) => operation.id) };
  };
  return options.yes ? withSchedulerLock(prune) : prune();
}

function pruneOperations(
  installed: readonly InstalledSchedulerBinding[],
  requestedIds: readonly string[],
): Extract<SchedulerSyncOperation, { kind: "remove" }>[] {
  const candidates = installed.flatMap((row) => {
    const reason = classifyPruneCandidate(row);
    return reason ? [{ row, reason }] : [];
  });
  const ids = requestedIds.filter((id) => id.length > 0);
  for (const id of ids) {
    if (!candidates.some(({ row }) => row.id === id)) {
      throw new UsageError(
        `Scheduler binding ${JSON.stringify(id)} is not an orphaned prune candidate ` +
          "(either not installed, or it still resolves to a live bundle) — refusing to prune it.",
        "INVALID_FLAG_VALUE",
      );
    }
  }
  return candidates
    .filter(({ row }) => ids.length === 0 || ids.includes(row.id))
    .map(({ row, reason }) => ({ kind: "remove" as const, id: row.id, nativeId: installedRowNativeId(row), reason }));
}

export interface TasksDoctorResult {
  backend: string;
  akm: { argv: string[]; via: string };
  caller: { argv: string[]; via: string };
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
  };
}

export async function akmTasksDoctor(
  deps: { backend?: SchedulerBackend; resolveInvocation?: typeof resolveAkmInvocation } = {},
): Promise<TasksDoctorResult> {
  const warnings: string[] = [];
  let invocation: TasksDoctorResult["akm"] = { argv: [], via: "unresolved" };
  try {
    const r = (deps.resolveInvocation ?? resolveAkmInvocation)();
    invocation = { argv: r.argv, via: r.via };
  } catch (err) {
    warnings.push(err instanceof Error ? err.message : String(err));
  }
  const skipNativeInspection = process.env.BUN_TEST === "1" && !deps.backend;
  const sched = deps.backend ?? (skipNativeInspection ? undefined : selectBackend());
  const backend = sched?.name ?? backendNameForPlatform();
  let installed: InstalledSchedulerBinding[] = [];
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

function groupInstalledBindings(entries: readonly InstalledSchedulerBinding[]): TasksDoctorResult["bindings"] {
  const groups = new Map<string, TasksDoctorResult["bindings"][number]>();
  for (const entry of entries) {
    const argv = [...entry.binding];
    const status = inspectInstalledBinding(entry);
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

function inspectInstalledBinding(entry: InstalledSchedulerBinding): string[] {
  const status: string[] = [];
  const binding = entry.binding;
  if (isCheckoutInvocation(binding)) status.push("checkout");
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

function taskAssetRef(id: string): AssetRef {
  return { type: "task", name: id };
}

/** The bundle `task add` writes into: its write target, config, stash path, and name. */
function resolveTaskBundle(target: string | undefined) {
  const config = loadConfig();
  const resolved = prepareWriteTargetForMutation(resolveWriteTarget(config, target, { requireWritable: true }));
  return { resolved, config, stashDir: resolved.source.path, bundleName: resolved.source.name };
}

function taskProjectionAssetResolver(
  config: AkmConfig,
  bundleName: string,
  bundleRoot: string,
): NonNullable<PrepareTaskV3ExecutionContext["resolveAsset"]> {
  return async ({ bundle, type, name }) => {
    if (bundle === bundleName) {
      return { file: await resolveAssetPath(bundleRoot, type, name), bundleRoot };
    }
    const target = resolveWriteTarget(config, bundle, { requireWritable: false });
    return {
      file: await resolveAssetPath(target.source.path, type, name),
      bundleRoot: target.source.path,
    };
  };
}

/**
 * Exported for `src/commands/tasks/explain.ts` (P2b Lane B, spec
 * docs/plans/specs/p2b-input-bindings.md §4.5, B-N4): `akm task explain`
 * resolves its `--bundle` axis identically to every other read-only task
 * verb here (`akm task history`, `akm task run`) — the SAME resolver, not a
 * second one.
 */
export function resolveTaskReadBundle(
  refBundle: string | undefined,
  flagBundle: string | undefined,
): ResolvedWriteTarget {
  if (refBundle && flagBundle && refBundle !== flagBundle) {
    throw new UsageError(
      `Task ref selects bundle ${JSON.stringify(refBundle)}, but --bundle selects ${JSON.stringify(flagBundle)}.`,
      "INVALID_FLAG_VALUE",
    );
  }
  const selector = flagBundle ?? refBundle;
  const config = loadConfig();
  let resolved: ResolvedWriteTarget;
  if (!selector) {
    resolved = resolveWorkingStashTarget(config, { requireWritable: false });
  } else {
    const configured = resolveActiveConfiguredSources(config).some((source) => source.name === selector);
    const implicit = configured ? undefined : resolveImplicitScheduledBundleTarget(config, selector);
    resolved = implicit ?? resolveWriteTarget(config, selector, { requireWritable: false });
  }
  if (refBundle && resolved.source.name !== refBundle) {
    throw new UsageError(
      `Task ref bundle ${JSON.stringify(refBundle)} does not match the resolved source.`,
      "INVALID_FLAG_VALUE",
    );
  }
  return resolved;
}

/**
 * New scheduler bindings always carry a canonical `--bundle <owner>` token,
 * including an env-selected working stash. That stash need not be persisted in
 * config (CI, one-shot tools, and fresh installs commonly use only
 * AKM_BUNDLE_DIR), so its scheduled child must accept precisely its derived
 * owner name after the scheduler context restores the environment.
 *
 * This is intentionally narrower than an unknown-bundle fallback: a configured
 * source always wins, and an unconfigured selector is accepted only when it is
 * exactly the current env-selected working stash identity.
 */
function resolveImplicitScheduledBundleTarget(config: AkmConfig, selector: string): ResolvedWriteTarget | undefined {
  if (!process.env.AKM_BUNDLE_DIR?.trim()) return undefined;
  try {
    const working = resolveWorkingStashTarget(config, { requireWritable: false });
    return working.source.name === selector ? working : undefined;
  } catch {
    return undefined;
  }
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

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
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
}

/**
 * Infer a JSON-Schema-subset `type` keyword from one `--params` value's
 * runtime shape (spec docs/plans/specs/p4-deletions-closeout.md §3.2.6, row
 * B-20). `null` is not one of the five runtime types the spec enumerates
 * (string/number/boolean/object/array) but is a value JSON.parse can still
 * produce for a param; `src/core/json-schema.ts`'s subset validator accepts
 * `"null"` as a `type`, so it is handled rather than mis-typed.
 */
function jsonSchemaTypeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/**
 * Render `--params` as typed `inputs:` declarations, one per key, each
 * carrying a `default:` equal to the authored value and a `type:` inferred
 * from its own JSON runtime shape (row B-20). Never emitted as `with:` —
 * task source v4 accepts `with:` only on `uses: akm/command` (§3.2.6's
 * `parseTarget`/`checkTopLevelKeys`), and a workflow target's declared
 * inputs are what `load-task.ts`'s existing v4 delivery override binds into
 * the child run's params.
 */
function renderInputsFromParams(params: Record<string, unknown>): Record<string, unknown> {
  const inputs: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(params)) {
    inputs[name] = { type: jsonSchemaTypeOf(value), default: value };
  }
  return inputs;
}

function renderTaskYaml(input: RenderInput): string {
  const obj: Record<string, unknown> = { version: 4 };
  if (input.workflow) {
    obj.uses = input.workflow;
    if (input.params) obj.inputs = renderInputsFromParams(parseJsonObjectArg(input.params));
  } else if (input.prompt) {
    obj.uses = "akm/command";
    obj.with = { content: input.prompt };
  } else if (input.command !== undefined) {
    if (Array.isArray(input.command)) {
      throw new UsageError(
        "--command accepts one shell string; argv arrays require manual migration.",
        "INVALID_FLAG_VALUE",
      );
    }
    obj.run = input.command;
  }
  if (input.name) obj.name = input.name;
  if (input.description !== undefined) obj.description = input.description;
  if (input.when_to_use !== undefined) obj.when_to_use = input.when_to_use;
  if (input.tags && input.tags.length > 0) obj.tags = input.tags;
  if (input.engine !== undefined) obj.engine = input.engine;
  if (input.model !== undefined) obj.model = input.model;
  if (input.timeoutMs !== undefined) obj.timeout = input.timeoutMs;
  if (input.schedule.length > 0) obj.schedule = input.schedule;
  return yamlStringify(obj);
}

function assertInlineTaskPrompt(input: string): void {
  const value = input.trim();
  const pathShaped =
    /^(?:\.{1,2}[\\/]|~[\\/]|[\\/]|[A-Za-z]:[\\/])/.test(value) ||
    (!/\s/.test(value) && /[\\/]/.test(value) && path.extname(value) !== "");
  if (!isFullRefInput(value) && !pathShaped) return;
  warn(
    `--prompt "${input}" looks like an asset ref or file path; --prompt sends it as literal text, not a reference. Did you mean --workflow?`,
  );
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

// Re-exported so tests can verify the validator path directly.
// Re-export error classes consumed by callers that want to instanceof-check.
// Re-export this so the CLI can decide what process exit code to use after
// `akm task run` completes.
export { ConfigError, exitCodeForStatus, NotFoundError, UsageError };

// Parse only the bundle/ref syntax here. Whether a concept is a task is an
// adapter-specific decision made after resolving the selected bundle.
export function parseTaskRef(input: string): { id: string; bundle?: string } {
  const trimmed = input.trim();
  if (trimmed.includes("/")) {
    try {
      const parsed = parseBundleRef(trimmed);
      if (parsed.fragment !== undefined) throw new Error("task refs do not accept fragments");
      return {
        id: normaliseTaskConceptId(parsed.conceptId),
        ...(parsed.bundle ? { bundle: parsed.bundle } : {}),
      };
    } catch {
      // fall through to the shared error below
    }
    throw new UsageError(`Expected a syntactically valid task concept id, got "${input}".`, "INVALID_FLAG_VALUE");
  }
  return { id: normaliseTaskId(trimmed) };
}

/** Exported for `src/commands/tasks/explain.ts` — see {@link resolveTaskReadBundle}'s header. */
export function taskIdForAdapter(parsedId: string, adapterId: string): string {
  if (adapterId === "akm-task") return normaliseTaskConceptId(parsedId);
  if (adapterId === "akm") {
    if (!parsedId.includes("/")) return normaliseTaskId(parsedId);
    if (parsedId.startsWith("tasks/") && !parsedId.slice("tasks/".length).includes("/")) {
      return normaliseTaskId(parsedId.slice("tasks/".length));
    }
    throw new UsageError(
      `The native akm adapter accepts only a bare task id or tasks/<id>, got "${parsedId}".`,
      "INVALID_FLAG_VALUE",
    );
  }
  throw new UsageError(`Bundle adapter "${adapterId}" does not define task runtime identity.`, "INVALID_FLAG_VALUE");
}
