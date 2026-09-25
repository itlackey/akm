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

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { stringify as yamlStringify } from "yaml";
import { detectAdapterId } from "../../core/adapter/detect-adapter";
import { assetPathForName } from "../../core/asset/asset-placement";
import { makeBundleRef, parseBundleRef } from "../../core/asset/asset-ref";
import { type AssetRef, conceptIdFromTypeName, isFullRefInput } from "../../core/asset/resolve-ref";
import { isWithin, resolveStashDir } from "../../core/common";
import { loadConfig, resetConfigCache } from "../../core/config/config";
import {
  bundleComponentConfig,
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
  deleteAssetFromSource,
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
import {
  activeSchedulerActivations,
  isSchedulerRefEnabled,
  setSchedulerRefEnabled,
} from "../../tasks/activation-config";
import { backendNameForPlatform, selectBackend } from "../../tasks/backends";
import type { InstalledSchedulerBinding, RebindSchedulerBinding, SchedulerBackend } from "../../tasks/backends/types";
import { prepareTaskV3Execution } from "../../tasks/prepare/prepare";
import type { PrepareTaskV3ExecutionContext } from "../../tasks/prepare/prepared-execution";
import { type ResolvedAkmInvocation, resolveAkmInvocation } from "../../tasks/resolve-akm-bin";
import { createExecutionProvenanceContext } from "../../tasks/run/provenance";
import { runTask } from "../../tasks/run/run-task";
import { readTaskHistory } from "../../tasks/run/task-history";
import { exitCodeForStatus, type RunTaskOptions, type TaskRunResult } from "../../tasks/run/task-result";
import { parseSchedule, SCHEDULE_SUPPORTED_SUBSET_HINT } from "../../tasks/schedule";
import {
  assertSchedulerMutationArtifact,
  assertSchedulerNativeArtifactCardinality,
  compileTaskSchedulerBindings,
  type SchedulerBinding,
  type SchedulerInstallOptions,
  type SchedulerMutationExpectation,
  type SchedulerRollbackExpectation,
  type SchedulerRollbackState,
  type SchedulerTransactionSnapshot,
  schedulerBindingNativeId,
  schedulerBindingOrdinal,
  schedulerNativeArtifactKey,
  schedulerNativeBindingId,
} from "../../tasks/scheduler-binding";
import {
  carryForwardSchedulerGrants,
  pendingGrantsFromInstalled,
  staleGrantsFromInstalled,
  staleSchedulerGrantWarning,
} from "../../tasks/scheduler-grant-carry-forward";
import {
  schedulerContextDescriptor,
  schedulerContextPath,
  validateSchedulerContextDescriptor,
  writeSchedulerContextDescriptor,
} from "../../tasks/scheduler-invocation";
import {
  assertSchedulerBackendInspection,
  assertSchedulerNativeArtifactOwnership,
  assertSchedulerSourceSnapshot,
  buildSchedulerRemoveOperation,
  finalizeSchedulerSyncPlan,
  prepareSchedulerSyncSourceSet,
  type SchedulerSourceFailure,
  type SchedulerSyncOperation,
  type SchedulerSyncPlan,
} from "../../tasks/scheduler-sync";
import {
  renderSchedulerPlanPreview,
  renderSchedulerSyncPlanPreview,
  type SchedulerPlanPreview,
} from "../../tasks/scheduler-sync-preview";
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
   * default write target. Resolved via {@link resolveWriteTarget}; a non-default
   * bundle is recorded in the scheduled invocation as `--bundle <bundle>`.
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
  target: TaskV3SourceDocument["target"];
}

export interface TaskMutationDeps {
  backend?: SchedulerBackend;
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
  assertTaskAddTargetShape(input);

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
      `Task "${id}" already exists. Pass --force to overwrite, or delete its file and run \`akm task sync\` first.`,
      "RESOURCE_ALREADY_EXISTS",
    );
  }
  const sourceExpectation = captureTaskSourceExpectation(assetPath, stashDir);
  if (sourceExpectation.state === "present" && !input.force) {
    throw new UsageError(
      `Task "${id}" appeared while add was preparing. Pass --force only after reviewing the current owner.`,
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
  // Bindings are compiled from the original parsed document so each
  // schedule entry's inputs reach the generated invocation.
  const taskBindings = compileTaskSchedulerBindings({
    id,
    qualifiedRef,
    ...(bundle.installTarget ? { bundleTarget: bundle.installTarget } : {}),
    schedules: parsedTask.v4.schedule.map((schedule) => ({
      cron: schedule.cron,
      ordinal: schedule.ordinal,
      source: schedule.source,
      inputs: schedule.inputs,
    })),
  });
  const taskBinding = taskBindings[0];
  if (!taskBinding) throw new UsageError(`Task "${id}" has no schedulable trigger.`, "INVALID_FLAG_VALUE");

  const ref = taskAssetRef(id);
  const sched = deps.backend ?? selectBackend();
  const writeAsset = deps.writeAsset ?? writeAssetToSource;
  const deleteAsset = deps.deleteAsset ?? deleteAssetFromSource;
  const commitBoundary = deps.commitBoundary ?? commitWriteTargetBoundary;
  if (input.disabled) {
    // Revoke before publishing replacement bytes. If a write/commit/sync
    // fails, the safe partial state is an inert task, never an activated new
    // source (or a stale native binding that can still dispatch it).
    setSchedulerRefEnabled("task", qualifiedRef, false);
    await writeAsset(writeTarget.source, writeTarget.config, ref, yaml);
    commitBoundary(writeTarget, `Update tasks/${id}`);
    await akmTasksSync(deps, bundle.bundleName);
    return {
      id,
      ref: conceptIdFromTypeName("task", id),
      path: assetPath,
      bundleDir: stashDir,
      schedule: taskBinding.cron,
      enabled: false,
      backend,
      target: task.target,
    };
  }
  const transaction = await prepareTaskAddSchedulerTransaction({
    id,
    installTarget: bundle.installTarget,
    ownerTarget: bundle.bundleName,
    installOpts,
    taskBindings,
    sched,
    deps,
    rebind: input.rebind === true,
  });
  let sourceMutationReceipt: Extract<TaskSourceExpectation, { state: "present" }> | undefined;
  let sourcePublished = false;
  let sourcePublicationAttempted = false;
  const publishSource = async () => {
    assertTaskSourceExpectation(sourceExpectation);
    sourcePublicationAttempted = true;
    await writeAsset(writeTarget.source, writeTarget.config, ref, yaml);
    const publishedSource = captureTaskSourceExpectation(assetPath, stashDir);
    if (publishedSource.state !== "present" || publishedSource.sha256 !== hashTaskSource(yaml)) {
      throw new UsageError(
        `Task source ${JSON.stringify(assetPath)} changed during publication.`,
        "RESOURCE_ALREADY_EXISTS",
      );
    }
    sourceMutationReceipt = publishedSource;
    sourcePublished = true;
    transaction.publishRuntime?.();
  };

  await applySchedulerTransaction(sched, transaction.operations, {
    initialExpectations: transaction.initialExpectations,
    assertReadSet: () => {
      if (sourcePublished) {
        if (!sourceMutationReceipt) {
          throw new ConfigError("Published task source lost its transaction receipt.", "INVALID_CONFIG_FILE");
        }
        assertTaskSourceExpectation(sourceMutationReceipt);
      } else {
        assertTaskSourceExpectation(sourceExpectation);
      }
    },
    beforeOperation: async (_operation, index) => {
      if (index === transaction.publishOperationIndex && !sourcePublished) await publishSource();
    },
    afterOperations: () => commitBoundary(writeTarget, `Update tasks/${id}`),
    rollbackExternal: async () => {
      if (!sourcePublicationAttempted) return;
      if (!sourceMutationReceipt) {
        const current = captureTaskSourceExpectation(assetPath, stashDir);
        if (sameTaskSourceExpectation(current, sourceExpectation)) return;
        if (current.state !== "present" || current.sha256 !== hashTaskSource(yaml)) {
          throw new UsageError(
            `Task source ${JSON.stringify(assetPath)} has an unowned publication state; refusing rollback over a possible concurrent owner.`,
            "RESOURCE_ALREADY_EXISTS",
          );
        }
        sourceMutationReceipt = current;
      }
      assertTaskSourceExpectation(sourceMutationReceipt);
      try {
        if (sourceExpectation.state === "absent") {
          await deleteAsset(writeTarget.source, writeTarget.config, ref);
        } else {
          await writeAsset(writeTarget.source, writeTarget.config, ref, sourceExpectation.content);
          const providerRestored = captureTaskSourceExpectation(assetPath, stashDir);
          if (providerRestored.state !== "present" || providerRestored.sha256 !== sourceExpectation.sha256) {
            // Provider writers conventionally normalize a trailing newline.
            // Rollback is byte-exact, so finish the already-owned restore with
            // the frozen bytes before checking the physical source state.
            fs.writeFileSync(assetPath, Buffer.from(sourceExpectation.bytesBase64, "base64"));
          }
        }
        assertTaskSourceRestored(sourceExpectation);
        commitBoundary(writeTarget, `Restore tasks/${id}`);
      } catch (cause) {
        // A write/commit seam may report failure after it has already restored
        // the exact source bytes. Prove that state before allowing native
        // rollback; otherwise preserve the possible concurrent source owner.
        try {
          assertTaskSourceRestored(sourceExpectation);
        } catch {
          throw cause;
        }
        throw new TaskSourceRestoredBoundaryError(cause);
      }
    },
    suppressNativeRollbackWhenExternalFails: true,
    allowNativeRollbackAfterExternalFailure: (error) => error instanceof TaskSourceRestoredBoundaryError,
  });
  // Publish the host-local grant only after source and native state commit.
  // A failure before this point therefore leaves any new binding inert at
  // its scheduled-fire gate instead of authorizing partially committed code.
  setSchedulerRefEnabled("task", qualifiedRef, true);

  return {
    id,
    ref: conceptIdFromTypeName("task", id),
    path: assetPath,
    bundleDir: stashDir,
    schedule: taskBinding.cron,
    enabled: true,
    backend,
    target: task.target,
  };
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
  const conceptId = adapterId === "akm" ? `tasks/${resolvedId}` : resolvedId;
  const qualifiedRef = makeBundleRef(bundle.source.name, conceptId);
  if (scheduled && !isSchedulerRefEnabled(loadConfig(), "task", qualifiedRef)) {
    throw new UsageError(
      `Scheduled task ${JSON.stringify(qualifiedRef)} is not enabled in local scheduler config; run \`akm task enable ${qualifiedRef}\`.`,
      "INVALID_FLAG_VALUE",
    );
  }
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

export async function akmTasksEnable(
  ref: string,
  options: { target?: string } = {},
  deps: { backend?: SchedulerBackend; schedulerRuntime?: () => PreparedSchedulerRuntime } = {},
): Promise<TasksActivationResult> {
  const resolved = resolveTaskActivation(ref, options.target, true);
  const activation = setSchedulerRefEnabled("task", resolved.qualifiedRef, true);
  const sync = await akmTasksSync(deps, resolved.bundleName);
  return { ref: resolved.qualifiedRef, enabled: true, changed: activation.changed, sync };
}

export async function akmTasksDisable(
  ref: string,
  options: { target?: string } = {},
  deps: { backend?: SchedulerBackend; schedulerRuntime?: () => PreparedSchedulerRuntime } = {},
): Promise<TasksActivationResult> {
  const resolved = resolveTaskActivation(ref, options.target, false);
  const activation = setSchedulerRefEnabled("task", resolved.qualifiedRef, false);
  // The grant just revoked above is still an installed, backed native
  // binding — exactly what carry-forward exists to rescue elsewhere. This
  // internal reconciling sync never opts in to carry-forward, so disabling
  // a ref is not immediately undone by the same call that is supposed to
  // remove it.
  const sync = await akmTasksSync(deps, resolved.bundleName);
  return { ref: resolved.qualifiedRef, enabled: false, changed: activation.changed, sync };
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
  /** Bindings whose installed schedule/runtime state drifted from the enabled source and were reinstalled. */
  updated: string[];
  removed: string[];
  unchanged: string[];
  skipped: { id: string; reason: string }[];
  backend: string;
  /**
   * Sources that failed to parse/prepare (#867) — excluded from
   * install/update/remove/unchanged above, never silently dropped. Every
   * OTHER task/workflow still reconciles; the CLI exits non-zero whenever
   * this is non-empty so the failure stays visible. Named `failures` to
   * match the `--dry-run` preview shape (#906) — both report the same
   * concept under the same key.
   */
  failures: { path: string; ref?: string; reason: string }[];
  /** Present only when a rebind bound an ineligible (e.g. mutable checkout) runtime. */
  warnings?: string[];
}

/**
 * Reconcile host-local scheduler activation with authored tasks/workflows.
 *   • without --bundle, scan every enabled configured bundle in one transaction
 *   • with --bundle, reconcile only that bundle
 *   • only refs present in scheduler.enabled enter the desired set
 *   • install missing bindings only after that whole-set preflight succeeds
 *   • reinstall bindings whose authored schedule or runtime state changed
 *     (drift detected by comparing the backend's installed signature against
 *     the signature the current definition would produce)
 *   • remove orphan scheduler entries that no longer have a backing file
 */
/**
 * Compute (but never apply) a scheduler sync plan: everything through
 * `finalizeSchedulerSyncPlan`'s final call, stopping strictly before
 * `applySchedulerSyncPlan`. Shared by `akmTasksSync` (applies the plan) and
 * `akmTasksSyncPlan` (#849 `--dry-run`, never applies it) so the two paths
 * can never drift on what "the plan" means. `prepared?.publish`, the one
 * deferred write-producing closure in this pipeline, is returned but never
 * invoked here — only `applySchedulerSyncPlan` may call it.
 */
async function buildSchedulerSyncPlan(
  deps: { backend?: SchedulerBackend; schedulerRuntime?: () => PreparedSchedulerRuntime },
  bundleTarget: string | undefined,
  options: { rebind?: boolean; dryRun?: boolean; carryForward?: boolean },
): Promise<{
  sched: SchedulerBackend;
  plan: SchedulerSyncPlan;
  sourceSnapshots: readonly SchedulerSyncPlan["sourceSnapshot"][];
  prepared: ReturnType<typeof prepareSchedulerSyncRuntime> | undefined;
  warnings: string[];
}> {
  let config = loadConfig();
  const sched = deps.backend ?? selectBackend();
  if (!sched.inspectBindings) {
    throw new ConfigError(
      `Scheduler backend "${sched.name}" cannot provide one coherent inspection for transactional sync.`,
      "INVALID_CONFIG_FILE",
    );
  }
  const inspection = await sched.inspectBindings({ rebind: options.rebind === true });

  // Carry a host-local scheduler grant forward for any installed native
  // binding that is the operator's own prior `akm task sync` but has no
  // grant yet — before `desired` is computed below, which would otherwise
  // remove it as ungranted. `--dry-run` only reports what would be carried
  // forward; it never mutates config. Opt-in only: the CLI's `akm task
  // sync` (and its `--dry-run` preview) is the only caller that passes
  // `carryForward: true`. The internal reconciling
  // syncs inside `akmTasksAdd`/`akmTasksEnable`/`akmTasksDisable` never
  // carry forward — a caller that just revoked a grant and syncs must not
  // have that revoke silently undone by the same call.
  const pendingGrants = options.carryForward ? pendingGrantsFromInstalled(inspection.installed, config) : [];
  const carriedForward = pendingGrants.map((activation) => activation.ref);
  if (carriedForward.length > 0 && options.dryRun !== true) {
    await carryForwardSchedulerGrants(inspection);
    resetConfigCache();
    config = loadConfig();
  }
  if (carriedForward.length > 0) {
    warn(
      `${options.dryRun === true ? "Would carry forward" : "Carried forward"} ${carriedForward.length} ` +
        `scheduler ${carriedForward.length === 1 ? "grant" : "grants"} from ${carriedForward.length === 1 ? "an installed scheduled binding that has" : "installed scheduled bindings that have"} no grant yet: ` +
        `${carriedForward.join(", ")}. Run \`akm task disable <ref>\` to drop one.`,
    );
  }

  const rawEntries: Array<InstalledSchedulerBinding | RebindSchedulerBinding> = [...inspection.installed];
  const allEntries: InstalledSchedulerBinding[] = rawEntries.map((entry) => {
    const contextPath = "contextPath" in entry ? entry.contextPath : "";
    // #846: recover the resolved bundle path this entry was installed
    // under from its own scheduler-context descriptor. Any failure (no
    // descriptor, unreadable, corrupt, owned by another user) leaves
    // ownerBundlePath unset — belongsToBundle must never treat that as
    // "mine".
    const ownerBundlePath = contextPath ? resolveInstalledOwnerPath(contextPath) : undefined;
    return {
      ...entry,
      ...(entry.nativeId !== undefined ? { nativeId: entry.nativeId } : {}),
      ...(entry.invocation !== undefined ? { invocation: Object.freeze([...entry.invocation]) } : {}),
      binding: "binding" in entry ? [...entry.binding] : [],
      contextPath,
      ...(ownerBundlePath !== undefined ? { ownerBundlePath } : {}),
    };
  });
  const nativeArtifacts = inspection.artifacts;
  const configuredSources = resolveConfiguredSources(config);
  const activeSources = resolveActiveConfiguredSources(config);
  if (bundleTarget) {
    // adaptConfiguredSource (src/core/write-source.ts) rejects any kind
    // other than filesystem/git outright, so a website/npm bundle can never
    // carry scheduler state (akm task enable already fails the same way).
    // Surface that as a clear usage error here instead of letting the
    // write-target resolution below raise a generic ConfigError.
    const targetSource = activeSources.find((source) => source.name === bundleTarget);
    if (targetSource && !isWriteCapableSourceKind(targetSource.type)) {
      throw new UsageError(
        `Bundle "${bundleTarget}" has kind "${targetSource.type}"; task scheduling is only supported for filesystem and git bundles.`,
        "INVALID_FLAG_VALUE",
      );
    }
  }
  // Unscoped sync only installs/removes bindings for bundles that can carry
  // them (filesystem/git). A website/npm bundle contributes no installs and
  // must not crash the loop; inactiveOperations below still sees it via
  // configuredSources for removal/revocation.
  const sourceNames = bundleTarget
    ? [bundleTarget]
    : activeSources.filter((source) => isWriteCapableSourceKind(source.type)).map((source) => source.name);
  const inactiveOperations = bundleTarget
    ? []
    : inactiveBundleRemovalOperations(config, configuredSources, allEntries, nativeArtifacts);
  if (!bundleTarget && sourceNames.length === 0 && configuredSources.length > 0) {
    assertSchedulerBackendInspection({ installed: allEntries, artifacts: nativeArtifacts });
    const plan = emptySchedulerSyncPlan(inactiveOperations, carriedForward);
    return { sched, plan, sourceSnapshots: Object.freeze([]), prepared: undefined, warnings: [] };
  }
  const selectedNames = sourceNames.length > 0 ? sourceNames : [undefined];
  // A dry-run never mutates config, so `activeSchedulerActivations` above
  // does not yet include `pendingGrants` (the applied path reloads config
  // after `carryForwardSchedulerGrants` instead). Add them here so the
  // preview plans the sync that would actually run after the carry-forward,
  // instead of showing a `remove` for a ref it just reported as carried
  // forward.
  const enabled =
    options.dryRun === true
      ? [...activeSchedulerActivations(config), ...pendingGrants]
      : activeSchedulerActivations(config);
  const enabledActivations = new Set(enabled.map((activation) => `${activation.kind}\0${activation.ref}`));
  const preparedSets: Array<{
    common: Parameters<typeof finalizeSchedulerSyncPlan>[0];
    preparedSources: Awaited<ReturnType<typeof prepareSchedulerSyncSourceSet>>;
    syncTarget?: string;
  }> = [];
  // C3: one bundle's source collection failing (a symbolic tasks/workflows
  // root, a TOCTOU read-set change, …) must not cost every OTHER selected
  // bundle its sync — each bundle is its own item here, caught and reported
  // rather than aborting the whole (possibly multi-bundle) `selectedNames`
  // loop.
  const bundleFailures: SchedulerSourceFailure[] = [];
  for (const sourceName of selectedNames) {
    try {
      const resolved = resolveTaskReadBundle(undefined, sourceName);
      const stashDir = resolved.source.path;
      const syncTarget = sourceName !== undefined && !isPrimaryStashPath(stashDir) ? sourceName : undefined;
      const common = {
        sourceRoot: stashDir,
        adapterId: resolved.source.adapterId ?? detectAdapterId(stashDir),
        bundleName: resolved.source.name,
        ...(syncTarget === undefined ? { bundlePath: path.resolve(stashDir) } : {}),
        ...(syncTarget ? { bundleTarget: syncTarget } : {}),
        backend: sched.name,
        installed: allEntries,
        nativeArtifacts,
        inspection: Object.freeze({ installed: allEntries, artifacts: nativeArtifacts }),
        enabledActivations,
        rebind: options.rebind === true,
        config,
        resolveAsset: taskProjectionAssetResolver(config, resolved.source.name, stashDir),
      } as const;
      preparedSets.push({
        common,
        preparedSources: await prepareSchedulerSyncSourceSet(common),
        ...(syncTarget ? { syncTarget } : {}),
      });
    } catch (cause) {
      bundleFailures.push({ path: sourceName ?? "(default bundle)", reason: errorMessage(cause) });
    }
  }

  // Pass one validates every selected bundle and computes whether any desired
  // activation needs a new runtime descriptor before native mutation begins.
  // Same per-bundle isolation as the loop above: a bundle whose finalize
  // throws (a genuine whole-bundle precondition — see
  // `finalizeSchedulerSyncPlan`'s own C3 classification) is reported and
  // excluded from `survivingSets`, and every OTHER bundle still finalizes.
  const survivingSets: typeof preparedSets = [];
  const preflights: SchedulerSyncPlan[] = [];
  for (const set of preparedSets) {
    try {
      preflights.push(finalizeSchedulerSyncPlan(set.common, set.preparedSources));
      survivingSets.push(set);
    } catch (cause) {
      bundleFailures.push({ path: set.common.bundleName, reason: errorMessage(cause) });
    }
  }
  const warnings: string[] = [];
  const expectedSignature = sched.expectedSignature?.bind(sched);
  const needsRuntime = preflights.some((preflight) =>
    preflight.operations.some((operation) => operation.kind !== "remove" && operation.options?.binding === undefined),
  );
  const prepared = needsRuntime
    ? prepareSchedulerSyncRuntime(
        undefined,
        deps,
        warnings,
        allEntries.map((entry) => entry.binding),
      )
    : undefined;
  // A grant bound to a stale sourceId is never carried forward (see the
  // carriedForward block above) and `desired` below excludes it too, so
  // sync would otherwise remove its row with no explanation.
  for (const grant of staleGrantsFromInstalled(inspection.installed, config)) {
    warnings.push(staleSchedulerGrantWarning(grant));
  }
  const plans = survivingSets.map(({ common, preparedSources, syncTarget }) =>
    finalizeSchedulerSyncPlan(
      {
        ...common,
        ...(prepared?.options
          ? { installOptions: { ...prepared.options, ...(syncTarget ? { target: syncTarget } : {}) } }
          : syncTarget
            ? { installOptions: { target: syncTarget } }
            : {}),
        ...(expectedSignature
          ? {
              expectedSignature: (binding: SchedulerBinding, install?: SchedulerInstallOptions) =>
                expectedSignature(binding, install),
            }
          : {}),
      },
      preparedSources,
    ),
  );
  assertNoCrossBundleSchedulerCollisions(plans);
  const representedRefs = new Set(
    plans.flatMap((candidate) => [
      ...candidate.desired.map((binding) => binding.logicalSource.ref),
      ...candidate.failures.flatMap((failure) => (failure.ref ? [failure.ref] : [])),
    ]),
  );
  // Only bundles that actually produced a plan — a bundle already reported
  // in `bundleFailures` would otherwise also flag every one of its enabled
  // activations as "missing", which is redundant noise on top of the one
  // bundle-level failure that already explains it.
  const selectedBundleNames = new Set(survivingSets.map(({ common }) => common.bundleName));
  const missingActivationFailures = enabled
    .filter((activation) => {
      const bundle = parseBundleRef(activation.ref).bundle;
      return bundle !== undefined && selectedBundleNames.has(bundle) && !representedRefs.has(activation.ref);
    })
    .map((activation) => ({
      path: activation.ref,
      ref: activation.ref,
      reason: `Enabled ${activation.kind} ${JSON.stringify(activation.ref)} was not found or has no schedule.`,
    }));
  const first = plans[0];
  if (!first) {
    // Every selected bundle failed (or none was configured) — there is no
    // surviving bundle to source a `sourceSnapshot` from, so unlike a
    // single failed bundle (reported in `failures`, everything else still
    // syncs) this is a genuine whole-operation precondition.
    throw new ConfigError(
      bundleFailures.length > 0
        ? `No selected bundle produced a scheduler sync plan: ${bundleFailures.map((failure) => `${failure.path}: ${failure.reason}`).join("; ")}`
        : "No configured bundle is available for scheduler sync.",
      "INVALID_CONFIG_FILE",
    );
  }
  const plan: SchedulerSyncPlan = Object.freeze({
    desired: Object.freeze(plans.flatMap((candidate) => candidate.desired)),
    installed: Object.freeze(plans.flatMap((candidate) => candidate.installed)),
    updated: Object.freeze(plans.flatMap((candidate) => candidate.updated)),
    removed: Object.freeze([
      ...plans.flatMap((candidate) => candidate.removed),
      ...inactiveOperations.map((operation) => operation.id),
    ]),
    unchanged: Object.freeze(plans.flatMap((candidate) => candidate.unchanged)),
    operations: Object.freeze([...plans.flatMap((candidate) => candidate.operations), ...inactiveOperations]),
    sourceSnapshot: first.sourceSnapshot,
    failures: Object.freeze([
      ...plans.flatMap((candidate) => candidate.failures),
      ...missingActivationFailures,
      ...bundleFailures,
    ]),
    ...(carriedForward.length > 0 ? { carriedForward: Object.freeze([...carriedForward]) } : {}),
  });

  return { sched, plan, sourceSnapshots: plans.map((candidate) => candidate.sourceSnapshot), prepared, warnings };
}

function inactiveBundleRemovalOperations(
  config: AkmConfig,
  configuredSources: ReturnType<typeof resolveConfiguredSources>,
  installed: readonly InstalledSchedulerBinding[],
  artifacts: Parameters<typeof buildSchedulerRemoveOperation>[2],
): Extract<SchedulerSyncOperation, { kind: "remove" }>[] {
  const inactive = new Set(configuredSources.filter((source) => source.enabled === false).map((source) => source.name));
  if (inactive.size === 0) return [];
  return installed
    .map((entry) => ({ entry, bundleName: installedSchedulerBundle(config, entry) }))
    .filter(
      (candidate): candidate is { entry: InstalledSchedulerBinding; bundleName: string } =>
        candidate.bundleName !== undefined && inactive.has(candidate.bundleName),
    )
    .sort((left, right) => left.entry.id.localeCompare(right.entry.id))
    .map(({ entry, bundleName }) => {
      const adapterId = bundleComponentConfig(config.bundles?.[bundleName])?.adapter ?? "akm";
      return buildSchedulerRemoveOperation(entry.id, entry, artifacts, { adapterId, bundleName });
    });
}

function installedSchedulerBundle(config: AkmConfig, entry: InstalledSchedulerBinding): string | undefined {
  const direct = entry.target ?? (entry.invocation ? scheduledInvocationBundle(entry.invocation) : undefined);
  if (direct !== undefined) return direct;
  if (entry.ownerBundlePath === undefined) return undefined;
  return bundleKeyForContentRoot(config, entry.ownerBundlePath);
}

function emptySchedulerSyncPlan(
  operations: readonly Extract<SchedulerSyncOperation, { kind: "remove" }>[],
  carriedForward: readonly string[] = [],
): SchedulerSyncPlan {
  const sourceSnapshot: SchedulerSyncPlan["sourceSnapshot"] = Object.freeze({
    adapterId: "akm",
    sourceRoot: "",
    sourceRealPath: "",
    sourcePhysicalIdentity: "inactive",
    sourceDirectoryVersion: "inactive",
    files: Object.freeze([]),
    directoryManifests: Object.freeze([]),
  });
  return Object.freeze({
    desired: Object.freeze([]),
    installed: Object.freeze([]),
    updated: Object.freeze([]),
    removed: Object.freeze(operations.map((operation) => operation.id)),
    unchanged: Object.freeze([]),
    operations: Object.freeze([...operations]),
    sourceSnapshot,
    failures: Object.freeze([]),
    ...(carriedForward.length > 0 ? { carriedForward: Object.freeze([...carriedForward]) } : {}),
  });
}

function scheduledInvocationBundle(invocation: readonly string[]): string | undefined {
  const bundleIndex = invocation.indexOf("--bundle");
  if (bundleIndex >= 0) return invocation[bundleIndex + 1];
  if (invocation[0] === "workflow" && invocation[1] === "run" && invocation[2]) {
    try {
      return parseBundleRef(invocation[2]).bundle;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function assertNoCrossBundleSchedulerCollisions(plans: readonly SchedulerSyncPlan[]): void {
  const owners = new Map<string, SchedulerBinding>();
  for (const binding of plans.flatMap((plan) => plan.desired)) {
    const key = schedulerNativeArtifactKey(schedulerBindingNativeId(binding));
    const existing = owners.get(key);
    if (existing && existing.logicalSource.ref !== binding.logicalSource.ref) {
      throw new UsageError(
        `Scheduler native id ${JSON.stringify(schedulerBindingNativeId(binding))} is claimed by both ` +
          `${JSON.stringify(existing.logicalSource.ref)} and ${JSON.stringify(binding.logicalSource.ref)}. ` +
          "Rename one task before enabling both.",
        "RESOURCE_ALREADY_EXISTS",
      );
    }
    owners.set(key, binding);
  }
}

export async function akmTasksSync(
  deps: { backend?: SchedulerBackend; schedulerRuntime?: () => PreparedSchedulerRuntime } = {},
  bundleTarget?: string,
  /**
   * `carryForward` is opt-in: only the `akm task sync` CLI command passes
   * `true`. Internal reconciling syncs (`akmTasksAdd`,
   * `akmTasksEnable`, `akmTasksDisable`) never do, so they cannot silently
   * re-grant a binding they, or the caller, just revoked.
   */
  options: { rebind?: boolean; carryForward?: boolean } = {},
): Promise<TasksSyncResult> {
  const { sched, plan, sourceSnapshots, prepared, warnings } = await buildSchedulerSyncPlan(
    deps,
    bundleTarget,
    options,
  );
  await applySchedulerSyncPlan(
    sched,
    plan,
    prepared?.publish && plan.operations.some((operation) => operation.kind !== "remove")
      ? prepared.publish
      : undefined,
    sourceSnapshots,
  );
  return {
    installed: [...plan.installed],
    updated: [...plan.updated],
    removed: [...plan.removed],
    unchanged: [...plan.unchanged],
    skipped: [],
    backend: sched.name,
    failures: plan.failures.map((failure) => ({ ...failure })),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

/**
 * `akm task sync --dry-run` (#849): compute the exact same plan
 * `akmTasksSync` would apply, then return a non-mutating preview instead of
 * calling `applySchedulerSyncPlan`. `buildSchedulerSyncPlan` is shared with
 * the real sync path specifically so this can never see a different plan
 * than the one a real sync would apply — and specifically so this function
 * never even holds a reference to a callable `publish` closure past this
 * point: `prepared.publish`, if any, is dropped on the floor here, never
 * invoked. Zero durable writes, mirroring `akm workflow plan`.
 */
export async function akmTasksSyncPlan(
  deps: { backend?: SchedulerBackend; schedulerRuntime?: () => PreparedSchedulerRuntime } = {},
  bundleTarget?: string,
  options: { rebind?: boolean; carryForward?: boolean } = {},
): Promise<SchedulerPlanPreview> {
  const { sched, plan } = await buildSchedulerSyncPlan(deps, bundleTarget, { ...options, dryRun: true });
  return renderSchedulerSyncPlanPreview(sched.name, plan);
}

export type TasksPruneReason = "invalid-context" | "dead-bundle-path";

export interface TasksPruneResult {
  readonly backend: string;
  readonly dryRun: boolean;
  readonly preview: SchedulerPlanPreview;
  readonly removed: readonly string[];
}

/**
 * Classify one installed scheduler binding as a prune candidate (#851), using
 * the same two signals `doctor`'s `inspectInstalledBinding` already computes
 * — deliberately narrower than that function's full `status` set. Only an
 * entry whose ownership can NEVER be resolved (`invalid-context`) or whose
 * resolved owner no longer exists on disk (`dead-bundle-path`) is a
 * candidate; `missing-path` (e.g. the akm binary itself moved) is a
 * different failure mode and is intentionally NOT folded in here, per the
 * scoping in #851 — an entry that still resolves to a live bundle is never a
 * candidate, full stop.
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
 * Compute (never apply) the exact set of remove operations `akm task prune`
 * would perform: scan every installed scheduler binding across ALL bundles
 * (orphans by definition don't resolve to a current bundle, so this is
 * deliberately not scoped the way `sync` is), keep only entries
 * `classifyPruneCandidate` flags, and build each removal through the same
 * exact-fingerprint/ordinal-attribution machinery `sync`'s own removal path
 * uses (`buildSchedulerRemoveOperation`). `belongsToBundle` and
 * `finalizeSchedulerSyncPlan` are never touched — this is a parallel,
 * narrower path so #846's guard stays exactly as conservative as it was.
 */
type SchedulerRemoveOperation = Extract<SchedulerSyncOperation, { kind: "remove" }>;

async function buildTaskPrunePlan(
  deps: { backend?: SchedulerBackend } = {},
  options: { id?: readonly string[] } = {},
): Promise<{ sched: SchedulerBackend; operations: readonly SchedulerRemoveOperation[] }> {
  const sched = deps.backend ?? selectBackend();
  if (!sched.inspectBindings) {
    throw new ConfigError(
      `Scheduler backend "${sched.name}" cannot provide one coherent inspection for prune.`,
      "INVALID_CONFIG_FILE",
    );
  }
  const inspection = await sched.inspectBindings({});
  const candidates = new Map<string, TasksPruneReason>();
  for (const entry of inspection.installed) {
    const reason = classifyPruneCandidate(entry);
    if (reason) candidates.set(entry.id, reason);
  }
  const requestedIds = options.id?.filter((id) => id.length > 0) ?? [];
  for (const id of requestedIds) {
    if (!candidates.has(id)) {
      throw new UsageError(
        `Scheduler binding ${JSON.stringify(id)} is not an orphaned prune candidate ` +
          "(either not installed, or it still resolves to a live bundle) — refusing to prune it.",
        "INVALID_FLAG_VALUE",
      );
    }
  }
  const idFilter = requestedIds.length > 0 ? new Set(requestedIds) : undefined;
  const resolved = resolveTaskReadBundle(undefined, undefined);
  const bundleContext = {
    adapterId: resolved.source.adapterId ?? detectAdapterId(resolved.source.path),
    bundleName: resolved.source.name,
  };
  const operations: SchedulerRemoveOperation[] = [];
  for (const entry of inspection.installed) {
    const reason = candidates.get(entry.id);
    if (!reason) continue;
    if (idFilter && !idFilter.has(entry.id)) continue;
    const operation = buildSchedulerRemoveOperation(entry.id, entry, inspection.artifacts, bundleContext);
    operations.push(Object.freeze({ ...operation, reason }));
  }
  return { sched, operations: Object.freeze(operations) };
}

/**
 * `akm task prune` (#851): remove installed scheduler bindings `sync` can
 * never reclaim because their own `--scheduler-context` descriptor doesn't
 * resolve to a live bundle. Defaults to dry-run — no `--yes` and no `--id`
 * means zero backend calls that could mutate anything, matching
 * `akmTasksSyncPlan`'s zero-write guarantee. `--id` (one or more) narrows
 * execution to exactly those bindings; `--yes` alone executes every
 * currently-computed candidate. Both still return the full preview so the
 * plan is never silent about what it did.
 */
export async function akmTasksPrune(
  deps: { backend?: SchedulerBackend } = {},
  options: { yes?: boolean; id?: readonly string[] } = {},
): Promise<TasksPruneResult> {
  const { sched, operations } = await buildTaskPrunePlan(deps, options);
  const preview = renderSchedulerPlanPreview(sched.name, operations);
  if (!options.yes) {
    return { backend: sched.name, dryRun: true, preview, removed: [] };
  }
  await applySchedulerTransaction(sched, operations, {
    initialExpectations: operations.map((operation) => operation.expected as SchedulerMutationExpectation),
  });
  return {
    backend: sched.name,
    dryRun: false,
    preview,
    removed: operations.map((operation) => operation.id),
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
  deps: { backend?: SchedulerBackend; resolveInvocation?: typeof resolveAkmInvocation } = {},
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

async function applySchedulerSyncPlan(
  backend: SchedulerBackend,
  plan: SchedulerSyncPlan,
  publish?: () => void,
  sourceSnapshots: readonly SchedulerSyncPlan["sourceSnapshot"][] = [plan.sourceSnapshot],
): Promise<void> {
  await applySchedulerTransaction(backend, plan.operations, {
    initialExpectations: plan.operations.map((operation) => operation.expected as SchedulerMutationExpectation),
    assertReadSet: () => {
      for (const snapshot of sourceSnapshots) assertSchedulerSourceSnapshot(snapshot);
    },
    beforeOperation: (_operation, index) => {
      if (index === 0) publish?.();
    },
  });
}

async function applySchedulerTransaction(
  backend: SchedulerBackend,
  operations: SchedulerSyncPlan["operations"],
  hooks: {
    initialExpectations: readonly SchedulerMutationExpectation[];
    assertReadSet?: () => void;
    beforeOperation?: (operation: SchedulerSyncPlan["operations"][number], index: number) => void | Promise<void>;
    afterOperations?: () => void | Promise<void>;
    rollbackExternal?: () => void | Promise<void>;
    suppressNativeRollbackWhenExternalFails?: boolean;
    allowNativeRollbackAfterExternalFailure?: (error: unknown) => boolean;
  },
): Promise<void> {
  if (operations.length === 0) {
    hooks.assertReadSet?.();
    await hooks.afterOperations?.();
    hooks.assertReadSet?.();
    return;
  }
  hooks.assertReadSet?.();
  if (!backend.snapshotBindings || !backend.restoreBindings) {
    throw new ConfigError(
      `Scheduler backend "${backend.name}" cannot snapshot and restore a whole-set transaction.`,
      "INVALID_CONFIG_FILE",
    );
  }
  const nativeIds = [
    ...new Set(
      operations.map((operation) =>
        operation.kind === "remove" ? operation.nativeId : schedulerBindingNativeId(operation.binding),
      ),
    ),
  ];
  const snapshot = await backend.snapshotBindings(nativeIds);
  assertSchedulerTransactionSnapshot(snapshot, nativeIds, hooks.initialExpectations);
  const rollbackExpected = schedulerRollbackExpectations(snapshot, operations);
  hooks.assertReadSet?.();
  try {
    for (const [index, operation] of operations.entries()) {
      hooks.assertReadSet?.();
      await hooks.beforeOperation?.(operation, index);
      hooks.assertReadSet?.();
      if (operation.kind === "remove") await backend.uninstall(operation.nativeId, operation.expected);
      else await backend.install(operation.binding, operation.options, operation.expected);
      hooks.assertReadSet?.();
    }
    hooks.assertReadSet?.();
    await hooks.afterOperations?.();
    hooks.assertReadSet?.();
  } catch (primaryError) {
    let externalRollbackError: unknown;
    try {
      await hooks.rollbackExternal?.();
    } catch (error) {
      externalRollbackError = error;
    }
    let nativeRollbackError: unknown;
    const externalStateAllowsNativeRollback =
      externalRollbackError !== undefined &&
      hooks.allowNativeRollbackAfterExternalFailure?.(externalRollbackError) === true;
    if (
      !(externalRollbackError && hooks.suppressNativeRollbackWhenExternalFails && !externalStateAllowsNativeRollback)
    ) {
      try {
        await backend.restoreBindings(snapshot, rollbackExpected);
      } catch (error) {
        nativeRollbackError = error;
      }
    }
    const rollbackErrors = [externalRollbackError, nativeRollbackError].filter(
      (error): error is NonNullable<typeof error> => error !== undefined,
    );
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [primaryError, ...rollbackErrors],
        `Scheduler transaction failed and rollback was incomplete: ${errorMessage(primaryError)}`,
      );
    }
    throw primaryError;
  }
}

function schedulerRollbackExpectations(
  snapshot: SchedulerTransactionSnapshot,
  operations: SchedulerSyncPlan["operations"],
): readonly SchedulerRollbackExpectation[] {
  return Object.freeze(
    snapshot.nativeIds.map((nativeId) => {
      const prior = snapshot.artifacts.find(
        (artifact) => schedulerNativeArtifactKey(artifact.nativeId) === schedulerNativeArtifactKey(nativeId),
      );
      const allowed: SchedulerRollbackState[] = [];
      if (prior) {
        if (prior.fingerprint === undefined) {
          throw new ConfigError(
            `Scheduler backend snapshot for ${JSON.stringify(nativeId)} has no exact fingerprint.`,
            "INVALID_CONFIG_FILE",
          );
        }
        allowed.push(
          Object.freeze({
            state: "present" as const,
            ...(prior.bindingId !== undefined ? { bindingId: prior.bindingId } : {}),
            ...(prior.invocation !== undefined ? { invocation: Object.freeze([...prior.invocation]) } : {}),
            fingerprint: prior.fingerprint,
          }),
        );
      } else {
        allowed.push(Object.freeze({ state: "absent" as const }));
      }
      const matchingOperations = operations.filter((candidate) => {
        const operationNativeId =
          candidate.kind === "remove" ? candidate.nativeId : schedulerBindingNativeId(candidate.binding);
        return schedulerNativeArtifactKey(operationNativeId) === schedulerNativeArtifactKey(nativeId);
      });
      for (const operation of matchingOperations) {
        if (operation.kind === "remove") {
          if (!allowed.some((state) => state.state === "absent")) {
            allowed.push(Object.freeze({ state: "absent" as const }));
          }
          continue;
        }
        if (operation.resultFingerprint === undefined) {
          throw new ConfigError(
            `Scheduler backend cannot freeze the post-mutation fingerprint for ${JSON.stringify(nativeId)}.`,
            "INVALID_CONFIG_FILE",
          );
        }
        allowed.push(
          Object.freeze({
            state: "present" as const,
            bindingId: operation.binding.id,
            invocation: Object.freeze([...operation.binding.invocation]),
            fingerprint: operation.resultFingerprint,
          }),
        );
      }
      return Object.freeze({ nativeId, allowed: Object.freeze(allowed) });
    }),
  );
}

function assertSchedulerTransactionSnapshot(
  snapshot: SchedulerTransactionSnapshot,
  nativeIds: readonly string[],
  initialExpectations: readonly SchedulerMutationExpectation[],
): void {
  if (
    !snapshot ||
    !Array.isArray(snapshot.nativeIds) ||
    !Array.isArray(snapshot.artifacts) ||
    nativeIds.some((nativeId) => !snapshot.nativeIds.includes(nativeId))
  ) {
    throw new ConfigError("Scheduler backend returned an incomplete transaction snapshot.", "INVALID_CONFIG_FILE");
  }
  const snapshotKeys = snapshot.nativeIds.map(schedulerNativeArtifactKey);
  const requestedKeys = nativeIds.map(schedulerNativeArtifactKey);
  if (
    snapshotKeys.length !== requestedKeys.length ||
    new Set(snapshotKeys).size !== snapshotKeys.length ||
    snapshotKeys.some((key) => !requestedKeys.includes(key))
  ) {
    throw new ConfigError(
      "Scheduler backend returned an inexact normalized transaction snapshot set.",
      "INVALID_CONFIG_FILE",
    );
  }
  for (const expected of initialExpectations) {
    const artifact = assertSchedulerNativeArtifactCardinality(
      snapshot.artifacts,
      expected.nativeId,
      expected.state === "absent" ? 0 : 1,
    );
    assertSchedulerMutationArtifact(artifact, expected);
  }
}

async function prepareTaskAddSchedulerTransaction(input: {
  id: string;
  installTarget: string | undefined;
  ownerTarget: string;
  installOpts: { target?: string } | undefined;
  taskBindings: readonly SchedulerBinding[];
  sched: SchedulerBackend;
  deps: TaskMutationDeps;
  rebind: boolean;
}): Promise<{
  runtimeOpts: SchedulerInstallOptions | undefined;
  publishRuntime?: () => void;
  operations: SchedulerSyncPlan["operations"];
  initialExpectations: readonly SchedulerMutationExpectation[];
  publishOperationIndex: number;
}> {
  if (!input.sched.inspectBindings) {
    throw new ConfigError(
      `Scheduler backend "${input.sched.name}" cannot provide one coherent inspection for transactional add.`,
      "INVALID_CONFIG_FILE",
    );
  }
  if (!input.sched.snapshotBindings || !input.sched.restoreBindings || !input.sched.expectedSignature) {
    throw new ConfigError(
      `Scheduler backend "${input.sched.name}" cannot provide exact snapshot, restore, and signature contracts for transactional add.`,
      "INVALID_CONFIG_FILE",
    );
  }
  const inspection = await input.sched.inspectBindings({ rebind: input.rebind });
  const installedEntries = [...inspection.installed];
  const nativeArtifacts = [...inspection.artifacts];
  const seenNativeKeys = new Set<string>();
  for (const artifact of nativeArtifacts) {
    const key = schedulerNativeArtifactKey(artifact.nativeId);
    if (seenNativeKeys.has(key)) {
      throw new UsageError(
        `Scheduler inspection has duplicate normalized native artifact ${JSON.stringify(artifact.nativeId)}.`,
        "RESOURCE_ALREADY_EXISTS",
      );
    }
    seenNativeKeys.add(key);
  }
  for (const binding of input.taskBindings) {
    assertNoForeignSchedule(installedEntries, binding.id, input.ownerTarget);
  }
  const taskEntries = installedEntries.filter((entry) => installedEntryRunsTask(entry, input.id));
  const foreignTaskEntry = taskEntries.find((entry) => !sameBundle(entry.target, input.ownerTarget));
  if (foreignTaskEntry) {
    throw new UsageError(foreignScheduleMessage(input.id, foreignTaskEntry.target), "RESOURCE_ALREADY_EXISTS");
  }
  assertSchedulerNativeArtifactOwnership(input.taskBindings, nativeArtifacts);
  const primary = input.taskBindings[0];
  if (!primary) throw new Error("invariant: scheduler transaction has no desired binding");
  const installedEntry = installedEntries.find((entry) => entry.id === primary.id) ?? taskEntries[0];
  const preparedRuntime =
    installedEntry && !input.rebind
      ? {
          options: {
            ...input.installOpts,
            binding: Object.freeze([...installedEntry.binding]),
            contextPath: installedEntry.contextPath,
          },
        }
      : prepareSchedulerSyncRuntime(input.installOpts, input.deps, []);
  const runtimeOpts = preparedRuntime.options;
  const removals: SchedulerSyncPlan["operations"][number][] = taskEntries.map((entry) => {
    const invocation = entry.invocation;
    const nativeId = entry.nativeId ?? schedulerNativeBindingId(entry.id);
    const artifact = assertSchedulerNativeArtifactCardinality(nativeArtifacts, nativeId, 1);
    if (!artifact?.fingerprint || artifact.bindingId !== entry.id) {
      throw new UsageError(
        `Installed scheduler binding ${JSON.stringify(entry.id)} has no exact coherent fingerprint.`,
        "RESOURCE_ALREADY_EXISTS",
      );
    }
    const logicalSource = primary.logicalSource;
    const ordinal = invocation ? schedulerBindingOrdinal(entry.id, logicalSource, invocation) : undefined;
    if (!invocation || ordinal === undefined) {
      warn(
        `Installed scheduler binding ${JSON.stringify(entry.id)} (native id ${JSON.stringify(nativeId)}) could not be exactly parsed — likely a hand-edited entry; replacing it without a compare-and-swap guard.`,
      );
      return Object.freeze({
        kind: "remove" as const,
        id: entry.id,
        nativeId,
      }) as SchedulerSyncPlan["operations"][number];
    }
    return Object.freeze({
      kind: "remove" as const,
      id: entry.id,
      nativeId,
      expected: Object.freeze({
        bindingId: entry.id,
        nativeId,
        logicalSource,
        ordinal,
        invocation: Object.freeze([...invocation]),
        fingerprint: artifact.fingerprint,
      }),
    });
  });
  const installs: SchedulerSyncPlan["operations"][number][] = input.taskBindings.map((binding) => {
    const nativeId = schedulerBindingNativeId(binding);
    const resultFingerprint = input.sched.expectedSignature!(binding, runtimeOpts);
    if (!resultFingerprint) {
      throw new ConfigError(
        `Scheduler backend "${input.sched.name}" cannot freeze the post-install fingerprint for ${JSON.stringify(binding.id)}.`,
        "INVALID_CONFIG_FILE",
      );
    }
    return Object.freeze({
      kind: "install" as const,
      binding,
      expected: Object.freeze({
        state: "absent" as const,
        bindingId: binding.id,
        nativeId,
        logicalSource: binding.logicalSource,
        ordinal: binding.ordinal,
        invocation: binding.invocation,
      }),
      resultFingerprint,
      ...(runtimeOpts ? { options: runtimeOpts } : {}),
    });
  });
  const initialByKey = new Map<string, SchedulerMutationExpectation>();
  for (const removal of removals) {
    if (removal.kind !== "remove") continue;
    if (!removal.expected) continue;
    initialByKey.set(
      schedulerNativeArtifactKey(removal.nativeId),
      Object.freeze({ ...removal.expected, state: "present" as const }),
    );
  }
  for (const install of installs) {
    if (install.kind === "remove") continue;
    const key = schedulerNativeArtifactKey(schedulerBindingNativeId(install.binding));
    if (!initialByKey.has(key)) initialByKey.set(key, install.expected);
  }
  return Object.freeze({
    runtimeOpts,
    ...(preparedRuntime.publish ? { publishRuntime: preparedRuntime.publish } : {}),
    operations: Object.freeze([...removals, ...installs]),
    initialExpectations: Object.freeze([...initialByKey.values()]),
    publishOperationIndex: removals.length,
  });
}

function prepareSchedulerSyncRuntime(
  base: { target?: string } | undefined,
  deps: { backend?: SchedulerBackend; schedulerRuntime?: () => PreparedSchedulerRuntime },
  warnings: string[],
  installedBindings: readonly (readonly string[])[] = [],
): { options?: SchedulerInstallOptions; publish?: () => void } {
  if (deps.backend && !deps.schedulerRuntime) return base ? { options: base } : {};
  if (deps.schedulerRuntime) {
    const runtime = deps.schedulerRuntime();
    warnIneligibleRebind(runtime, warnings, installedBindings);
    return { options: { ...base, binding: runtime.binding, contextPath: runtime.contextPath } };
  }

  const invocation = resolveAndValidateSchedulerInvocation();
  warnIneligibleRebind(invocation, warnings, installedBindings);
  const descriptor = schedulerContextDescriptor();
  const contextPath = schedulerContextPath(descriptor);
  return {
    options: { ...base, binding: invocation.binding, contextPath },
    publish: () => {
      const written = writeSchedulerContextDescriptor(descriptor);
      if (written !== contextPath) {
        throw new ConfigError("Scheduler context descriptor path changed after preflight.", "INVALID_CONFIG_FILE");
      }
    },
  };
}

function resolveAndValidateSchedulerInvocation(): PreparedSchedulerRuntime {
  const invocation = resolveAkmInvocation();
  return { binding: invocation.argv, contextPath: "", eligible: invocation.eligible, kind: invocation.kind };
}

function warnIneligibleRebind(
  runtime: PreparedSchedulerRuntime,
  warnings: string[],
  installedBindings: readonly (readonly string[])[],
): void {
  if (runtime.eligible !== false || warnings.length > 0) return;
  // #868 residue: binding every currently-installed entry to the SAME
  // invocation it already carries changes nothing — this is the steady
  // state of an image-baked install re-running `task sync` on a timer.
  // Only warn when the bind actually moves an entry to a different
  // invocation.
  if (installedBindings.length > 0 && installedBindings.every((bound) => sameArgv(bound, runtime.binding))) return;
  warnings.push(
    `Scheduled tasks are bound to an ineligible ${runtime.kind ?? "unknown"} invocation (${runtime.binding.join(" ")}); scheduled runs will invoke a mutable, unproven binary. Install akm via \`npm install --global akm-cli\` or a standalone release, then re-run \`akm task sync --rebind\`.`,
  );
}

function groupInstalledBindings(
  entries: readonly InstalledSchedulerBinding[],
  invocation: TasksDoctorResult["akm"],
): TasksDoctorResult["bindings"] {
  const groups = new Map<string, TasksDoctorResult["bindings"][number]>();
  for (const entry of entries) {
    const argv = [...entry.binding];
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

/** Best-effort recovery of an installed binding's owning bundle path (#846). */
function resolveInstalledOwnerPath(contextPath: string): string | undefined {
  try {
    return validateSchedulerContextDescriptor(contextPath).environment.AKM_BUNDLE_DIR;
  } catch {
    return undefined;
  }
}

function inspectInstalledBinding(entry: InstalledSchedulerBinding, invocation: TasksDoctorResult["akm"]): string[] {
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

type TaskSourceExpectation =
  | Readonly<{
      state: "absent";
      filePath: string;
      rootRealPath: string;
    }>
  | Readonly<{
      state: "present";
      filePath: string;
      rootRealPath: string;
      realPath: string;
      size: number;
      sha256: string;
      bytesBase64: string;
      content: string;
    }>;

function captureTaskSourceExpectation(filePathInput: string, rootInput: string): TaskSourceExpectation {
  const filePath = path.resolve(filePathInput);
  const root = path.resolve(rootInput);
  const lexicalRelative = path.relative(root, filePath);
  if (lexicalRelative === "" || lexicalRelative.startsWith("..") || path.isAbsolute(lexicalRelative)) {
    throw new UsageError(`${filePathInput} resolves outside the task source root.`, "PATH_ESCAPE_VIOLATION");
  }
  const rootRealPath = fs.realpathSync(root);
  const rootStat = fs.statSync(rootRealPath, { bigint: true });
  if (!rootStat.isDirectory()) {
    throw new UsageError(`${root} is not a task source directory.`, "INVALID_FLAG_VALUE");
  }
  const common = { filePath, rootRealPath };
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY);
    let before = fs.fstatSync(descriptor, { bigint: true });
    if (!before.isFile()) {
      throw new UsageError(`${filePath} is not a regular task source.`, "INVALID_FLAG_VALUE");
    }
    let bytes = fs.readFileSync(descriptor);
    const torn =
      !sameTaskSourceStat(before, fs.fstatSync(descriptor, { bigint: true })) ||
      BigInt(bytes.byteLength) !== before.size;
    if (torn) {
      fs.closeSync(descriptor);
      descriptor = fs.openSync(filePath, fs.constants.O_RDONLY);
      before = fs.fstatSync(descriptor, { bigint: true });
      bytes = fs.readFileSync(descriptor);
      warn(
        `${filePath} changed while its guarded bytes were read; retried once and proceeding with the latest read (its SHA-256 is re-verified before anything is published).`,
      );
    }
    const realPath = fs.realpathSync(filePath);
    const physicalRelative = path.relative(rootRealPath, realPath);
    if (physicalRelative === "" || physicalRelative.startsWith("..") || path.isAbsolute(physicalRelative)) {
      throw new UsageError(`${filePath} resolves outside the task source root.`, "PATH_ESCAPE_VIOLATION");
    }
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      throw new UsageError(`${filePath} contains invalid UTF-8 bytes.`, "INVALID_FLAG_VALUE");
    }
    return Object.freeze({
      state: "present" as const,
      ...common,
      realPath,
      size: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytesBase64: bytes.toString("base64"),
      content,
    });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      return Object.freeze({ state: "absent" as const, ...common });
    }
    if (cause instanceof UsageError) throw cause;
    throw new UsageError(
      `${filePath} could not be guarded as a contained regular task source: ${errorMessage(cause)}`,
      "PATH_ESCAPE_VIOLATION",
    );
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

// TOCTOU note: this compares CONTENT (state + sha256), not filesystem
// identity (inode/mtime/ctime/directory timestamps) — the same split already
// applied to the task migrator in 0.9.5. An unrelated touch to the file or
// its containing directory must not trip a "changed after planning" refusal;
// only a real content change should.
function assertTaskSourceExpectation(expected: TaskSourceExpectation): void {
  const actual = captureTaskSourceExpectation(expected.filePath, expected.rootRealPath);
  if (!sameTaskSourceExpectation(actual, expected)) {
    throw new UsageError(
      `Task source ${JSON.stringify(expected.filePath)} changed after transaction planning.`,
      "RESOURCE_ALREADY_EXISTS",
    );
  }
}

function sameTaskSourceExpectation(left: TaskSourceExpectation, right: TaskSourceExpectation): boolean {
  if (left.state !== right.state || left.filePath !== right.filePath || left.rootRealPath !== right.rootRealPath) {
    return false;
  }
  if (left.state === "absent") return true;
  return left.sha256 === (right as Extract<TaskSourceExpectation, { state: "present" }>).sha256;
}

function assertTaskSourceRestored(expected: TaskSourceExpectation): void {
  const actual = captureTaskSourceExpectation(expected.filePath, expected.rootRealPath);
  const restored =
    actual.state === expected.state &&
    (actual.state === "absent" ||
      (expected.state === "present" && actual.sha256 === expected.sha256 && actual.content === expected.content));
  if (!restored) {
    throw new UsageError(
      `Task source ${JSON.stringify(expected.filePath)} could not be restored without replacing a concurrent owner.`,
      "RESOURCE_ALREADY_EXISTS",
    );
  }
}

class TaskSourceRestoredBoundaryError extends Error {
  readonly cause: unknown;

  constructor(cause: unknown) {
    super(errorMessage(cause));
    this.name = "TaskSourceRestoredBoundaryError";
    this.cause = cause;
  }
}

function sameTaskSourceStat(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function hashTaskSource(source: string): string {
  return createHash("sha256").update(Buffer.from(source, "utf8")).digest("hex");
}

/**
 * Resolve the bundle a mutating/run task command targets. Returns the resolved
 * write/read target, its stash path, and the `--bundle <bundle>` token to embed
 * in scheduled invocations. The primary bundle uses the target-less form.
 */
function resolveTaskBundle(
  target: string | undefined,
  opts: { requireWritable: boolean },
): {
  resolved: ResolvedWriteTarget;
  config: AkmConfig;
  stashDir: string;
  bundleName: string;
  installTarget: string | undefined;
} {
  const config = loadConfig();
  const selected = resolveWriteTarget(config, target, { requireWritable: opts.requireWritable });
  const resolved = opts.requireWritable ? prepareWriteTargetForMutation(selected) : selected;
  const stashDir = resolved.source.path;
  const installTarget = isPrimaryStashPath(stashDir) ? undefined : (resolved.selector ?? resolved.source.name);
  return { resolved, config, stashDir, bundleName: resolved.source.name, installTarget };
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

/** Two bundle attributions match when both are the primary (undefined) or equal names. */
function sameBundle(a: string | undefined, b: string | undefined): boolean {
  return (a ?? undefined) === (b ?? undefined);
}

function installedEntryRunsTask(entry: InstalledSchedulerBinding, id: string): boolean {
  const invocation = entry.invocation;
  return invocation?.[0] === "task" && invocation[1] === "run" && invocation[2] === id;
}

function foreignScheduleMessage(id: string, existingTarget: string | undefined): string {
  const where = existingTarget === undefined ? "the default bundle" : `bundle "${existingTarget}"`;
  return `Task id "${id}" is already scheduled from ${where}; rename the task or disable the existing one first.`;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Refuse to schedule an id already installed from a DIFFERENT bundle. Scheduler
 * ids are the bare task id (never namespaced), so a single id can be active from
 * only one bundle at a time — a collision is a hard error, not an auto-rename.
 */
function assertNoForeignSchedule(
  entries: readonly InstalledSchedulerBinding[],
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
