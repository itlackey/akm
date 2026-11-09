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
 * The OS scheduler holds one entry that runs `akm task dispatch` every minute
 * (`src/tasks/dispatch.ts`); `sync` writes it. `add`, `enable` and
 * `disable` edit task files and `scheduler.enabled` (dispatch reads both on the
 * next minute) and then run `sync`, so the first enabled task installs the entry
 * and the last disabled one removes it.
 */

import fs from "node:fs";
import path from "node:path";
import { stringify as yamlStringify } from "yaml";
import { detectAdapterId } from "../../core/adapter/detect-adapter";
import { assetPathForName } from "../../core/asset/asset-placement";
import { makeBundleRef, parseBundleRef } from "../../core/asset/asset-ref";
import { type AssetRef, conceptIdFromTypeName, isFullRefInput } from "../../core/asset/resolve-ref";
import { isWithin, resolveStashDir } from "../../core/common";
import { loadConfig } from "../../core/config/config";
import type { AkmConfig } from "../../core/config/config-types";
import { ConfigError, NotFoundError, UsageError } from "../../core/errors";
import { getTaskLogDir } from "../../core/paths";
import { warn } from "../../core/warn";
import type { InputFlag } from "../../execution/input-contract";
import { resolveSourcesForOrigin } from "../../registry/origin-resolve";
import { resolveAssetPath } from "../../sources/resolve";
import {
  assertBundleNotDisabled,
  commitWriteTargetBoundary,
  prepareWriteTargetForMutation,
  type ResolvedWriteTarget,
  resolveWorkingStashTarget,
  resolveWriteTarget,
  writeAssetToSource,
} from "../../sources/write-source";
import { schedulerEnabledRefs, setSchedulerRefEnabled } from "../../tasks/activation-config";
import { selectBackend } from "../../tasks/backends";
import type { DispatchEntry, EntryChange, LegacyRow, SchedulerBackend } from "../../tasks/backends/types";
import { unrunnableTasks } from "../../tasks/dispatch";
import { movedLocations } from "../../tasks/installation";
import { prepareTaskExecution } from "../../tasks/prepare/prepare";
import type { PrepareTaskExecutionContext } from "../../tasks/prepare/prepared-execution";
import { isCheckoutInvocation, resolveAkmInvocation } from "../../tasks/resolve-akm-bin";
import { activeTaskSources, resolveBundleAsset } from "../../tasks/run/load-task";
import { createExecutionProvenanceContext } from "../../tasks/run/provenance";
import { runTask } from "../../tasks/run/run-task";
import { readTaskHistory } from "../../tasks/run/task-history";
import { exitCodeForStatus, type RunTaskOptions, type TaskRunResult } from "../../tasks/run/task-result";
import { parseSchedule, SCHEDULE_SUPPORTED_SUBSET_HINT } from "../../tasks/schedule";
import { parseTaskSource } from "../../tasks/source/parse-task-source";
import { projectTaskSourceV4 } from "../../tasks/source/project-v4";
import { normaliseTaskConceptId, normaliseTaskId } from "../../tasks/task-id";
import type { PreparableTaskDocument } from "../../tasks/task-source";

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
  /** Where a prompt target runs and on which model (`--connection`, `--harness`, `--model`), written into the task. */
  connection?: string;
  harness?: string;
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
  bundleDir: string;
  schedule: string;
  enabled: boolean;
  target: PreparableTaskDocument["target"];
  /** What the sync that followed did to the OS scheduler entry; absent when the scheduler was unavailable (see `warnings`). */
  sync?: TasksSyncResult;
  warnings?: string[];
}

export interface TaskMutationDeps {
  writeAsset?: typeof writeAssetToSource;
  commitBoundary?: typeof commitWriteTargetBoundary;
  sync?: TaskSyncDeps;
}

export async function akmTasksAdd(input: TasksAddInput, deps: TaskMutationDeps = {}): Promise<TasksAddResult> {
  const id = normaliseTaskId(input.id);
  assertTaskAddTargetShape(input);
  parseSchedule(input.schedule);

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
    connection: input.connection,
    harness: input.harness,
    model: input.model,
    timeoutMs: input.timeoutMs,
    params: input.params,
    name: input.name,
    description: input.description,
    when_to_use: input.when_to_use,
    tags: input.tags,
  });

  const parsedTask = parseTaskSource({ yaml, filePath: assetPath });
  const task = projectTaskSourceV4(parsedTask.v4);
  const qualifiedRef = makeBundleRef(bundle.bundleName, `tasks/${id}`);
  await prepareTaskExecution(task, {
    taskId: id,
    taskRef: qualifiedRef,
    bundleName: bundle.bundleName,
    bundleRoot: stashDir,
    config: bundle.config,
    resolveAsset: taskProjectionAssetResolver(bundle.config, bundle.bundleName, stashDir),
  });
  const first = parsedTask.v4.schedule[0];
  if (!first) throw new UsageError(`Task "${id}" has no schedulable trigger.`, "INVALID_FLAG_VALUE");

  if (fs.existsSync(assetPath) && !input.force) {
    throw new UsageError(
      `Task "${id}" already exists. Pass --force to overwrite, or delete its file first.`,
      "RESOURCE_ALREADY_EXISTS",
    );
  }
  if (input.disabled) setSchedulerRefEnabled(qualifiedRef, false);
  await (deps.writeAsset ?? writeAssetToSource)(bundle.resolved.source, bundle.resolved.config, taskAssetRef(id), yaml);
  (deps.commitBoundary ?? commitWriteTargetBoundary)(bundle.resolved, `Update tasks/${id}`);
  if (!input.disabled) setSchedulerRefEnabled(qualifiedRef, true);
  const synced = await syncAfterSave(deps.sync);
  return {
    id,
    ref: conceptIdFromTypeName("task", id),
    path: assetPath,
    bundleDir: stashDir,
    schedule: first.cron,
    enabled: input.disabled !== true,
    target: task.target,
    ...synced,
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
  // `--timeout-ms` is the workflow's whole-run bound. Connection, harness and
  // model stay prompt-only because a workflow's connections and harnesses come from the frozen plan.
  const selects = input.connection !== undefined || input.harness !== undefined || input.model !== undefined;
  if (input.workflow && selects) {
    throw new UsageError(
      "Workflow tasks accept --params and --timeout-ms; connection, harness and model are prompt-task fields.",
      "INVALID_FLAG_VALUE",
    );
  }
  if (hasCommand && selects) {
    throw new UsageError(
      "Command tasks accept --timeout-ms but not --connection, --harness or --model.",
      "INVALID_FLAG_VALUE",
    );
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
  // Built ONCE at this invocation boundary. eventSource is "task" whether or
  // not --scheduled was passed — scheduled stays a separate field carrying its
  // own meaning (activation policy, scheduler env), never selecting the event
  // source.
  const provenance = createExecutionProvenanceContext(scheduled);
  // The raw, exact-name input flags `tasks-cli.ts`'s Stage 1 captures ride
  // through unchanged to `runTask` -> `loadPreparedTask`'s Stage 2 materializer,
  // which owns declaring `inputFlags` on `RunTaskOptions` and attaching the
  // materialized literals to the constructed `TaskInvocation`. This is only
  // the pass-through surface.
  //
  // No `as` cast: `RunTaskOptions` (this
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
  // "command" means the agent/LLM arm — the native shell/script arm reports
  // "shell" / "script". A shell/script task's process exit 78 passes through
  // as CLI exit 78 (documented behavior, src/assets/hints/cli-hints-short.md).
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
  /** What the sync that followed did to the OS scheduler entry; absent when the scheduler was unavailable (see `warnings`). */
  readonly sync?: TasksSyncResult;
  readonly warnings?: string[];
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
    });
    if (parsedSource.v4.schedule.length === 0) {
      throw new UsageError(`Task ${JSON.stringify(ref)} has no schedule to enable.`, "INVALID_FLAG_VALUE");
    }
    // Dispatch would fail on a schedule it cannot parse every minute, where only a log records it.
    for (const entry of parsedSource.v4.schedule) parseSchedule(entry.cron);
  }
  return { qualifiedRef: makeBundleRef(bundle.source.name, conceptId), sourcePath, bundleName: bundle.source.name };
}

/** Add the task to `scheduler.enabled`, then sync the OS entry (installed with the first enabled task). */
export async function akmTasksEnable(
  ref: string,
  options: { target?: string; sync?: TaskSyncDeps } = {},
): Promise<TasksActivationResult> {
  return setTaskActivation(resolveTaskActivation(ref, options.target, true), true, options.sync);
}

/** Remove the task from `scheduler.enabled`, then sync the OS entry (removed with the last enabled task). */
export async function akmTasksDisable(
  ref: string,
  options: { target?: string; sync?: TaskSyncDeps } = {},
): Promise<TasksActivationResult> {
  return setTaskActivation(resolveTaskActivation(ref, options.target, false), false, options.sync);
}

async function setTaskActivation(
  resolved: { qualifiedRef: string },
  enabled: boolean,
  syncDeps: TaskSyncDeps | undefined,
): Promise<TasksActivationResult> {
  const activation = setSchedulerRefEnabled(resolved.qualifiedRef, enabled);
  return { ref: resolved.qualifiedRef, enabled, changed: activation.changed, ...(await syncAfterSave(syncDeps)) };
}

/**
 * Sync the OS entry after a task change is saved. A host with no usable scheduler (no `crontab`, a refusal) warns:
 * the change stays saved, and an explicit `akm task sync` still fails loudly.
 */
async function syncAfterSave(
  deps: TaskSyncDeps | undefined,
): Promise<{ sync: TasksSyncResult } | { warnings: string[] }> {
  try {
    return { sync: await akmTasksSync(deps) };
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    const reason = err.message.replace(/\.$/, "");
    return {
      warnings: [`Task saved, but the OS scheduler was not updated: ${reason}. Fix that, then run \`akm task sync\`.`],
    };
  }
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

/** What `akm task sync` did to the one dispatch entry. `unmanaged`: this installation does not own the OS scheduler. */
export type TaskSyncEntryOutcome = "installed" | "updated" | "unchanged" | "removed" | "absent" | "unmanaged";

export interface TasksSyncResult {
  backend: string;
  entry: TaskSyncEntryOutcome;
  /** Per-task rows of akm 0.9 removed in the same operation. */
  removedLegacy: string[];
  /** Per-task rows of akm 0.9 that name another installation, left alone. */
  keptLegacy: { id: string; reason: string }[];
  /** Present when this sync wrote a source-checkout launcher into the entry, or the installation is unmanaged. */
  warnings?: string[];
}

export interface TaskSyncDeps {
  backend?: SchedulerBackend;
  /** The launcher the entry is written with; resolved from this process when absent. */
  launcher?: () => { argv: readonly string[]; via?: string };
  /** The environment the installation is judged by, and whose PATH the entry captures. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Reconcile the OS scheduler with `scheduler.enabled`: exactly one entry, which
 * runs `akm task dispatch` every minute, present when any task is enabled and
 * absent when none is. An entry that is installed keeps its launcher and PATH
 * unless `rebind`. In the same write, the per-task rows of akm 0.9 are removed
 * (`# akm:task` blocks and the `# akm:env` block on cron, `com.akm.task.*`
 * plists, `\akm\<id>` tasks), except those that name another installation.
 *
 * An installation that moves any location (a config file other than the default,
 * or an XDG variable) never writes the OS scheduler: its supervisor runs
 * `akm task dispatch` itself.
 */
export async function akmTasksSync(
  deps: TaskSyncDeps = {},
  options: { rebind?: boolean } = {},
): Promise<TasksSyncResult> {
  const plan = await planSync(deps, options);
  if (plan.change) await plan.sched.apply(plan.change);
  return plan.result;
}

/** What `akmTasksSync` would do, written nowhere. `akm migrate status` reports it; there is no CLI flag for it. */
export async function akmTasksSyncPlan(
  deps: TaskSyncDeps = {},
  options: { rebind?: boolean } = {},
): Promise<TasksSyncResult & { hasRemovals: boolean; failures: never[] }> {
  const { result } = await planSync(deps, options);
  return {
    ...result,
    hasRemovals: result.removedLegacy.length > 0 || result.entry === "removed",
    failures: [],
  };
}

function legacyRowKeepReason(row: LegacyRow, workingStash: string | undefined): string | undefined {
  const named = row.environment;
  if (
    named.AKM_BUNDLE_DIR !== undefined &&
    (workingStash === undefined || path.resolve(named.AKM_BUNDLE_DIR) !== workingStash)
  ) {
    return `it names another installation's bundle directory (${named.AKM_BUNDLE_DIR})`;
  }
  const moved = ["AKM_CONFIG_DIR", "AKM_DATA_DIR", "AKM_CACHE_DIR", "AKM_STATE_DIR"].find(
    (name) => named[name] !== undefined,
  );
  // akm no longer reads these: the row fails when it fires, with the retired-variable error in its log.
  return moved === undefined
    ? undefined
    : `it sets ${moved}, so another installation wrote it, and akm no longer reads ${moved}: the row fails when it fires. ` +
        "Run `akm migrate apply` with that installation's environment, then run `akm task dispatch` from its supervisor with AKM_CONFIG_FILE set instead";
}

function workingStashPath(env: NodeJS.ProcessEnv): string | undefined {
  try {
    return path.resolve(resolveStashDir(env));
  } catch {
    return undefined;
  }
}

async function planSync(
  deps: TaskSyncDeps,
  options: { rebind?: boolean },
): Promise<{ sched: SchedulerBackend; result: TasksSyncResult; change?: EntryChange }> {
  const env = deps.env ?? process.env;
  const sched = deps.backend ?? selectBackend();
  const moved = movedLocations(env);
  if (moved.length > 0) {
    return {
      sched,
      result: {
        backend: sched.name,
        entry: "unmanaged",
        removedLegacy: [],
        keptLegacy: [],
        warnings: [
          `This installation moves its ${moved.join(", ")} location${moved.length === 1 ? "" : "s"} away from the defaults, so akm does not write the OS scheduler for it. ` +
            "Run `akm task dispatch` every minute from your own supervisor (cron, supercronic, a systemd timer), with this installation's environment.",
        ],
      },
    };
  }

  const inspection = await sched.inspect();
  const enabled = (schedulerEnabledRefs(loadConfig()) ?? []).length > 0;
  const workingStash = workingStashPath(env);
  const removeLegacy: string[] = [];
  const keptLegacy: TasksSyncResult["keptLegacy"] = [];
  for (const row of inspection.legacy) {
    const reason = legacyRowKeepReason(row, workingStash);
    if (reason === undefined) removeLegacy.push(row.id);
    else keptLegacy.push({ id: row.id, reason });
  }

  const warnings: string[] = [];
  let entry: DispatchEntry | null | undefined;
  let outcome: TaskSyncEntryOutcome;
  if (!enabled) {
    outcome = inspection.entry ? "removed" : "absent";
    if (inspection.entry) entry = null;
  } else {
    const launcher = deps.launcher?.() ?? resolveAkmInvocation();
    const wanted: DispatchEntry = { launcher: launcher.argv, ...(env.PATH ? { path: env.PATH } : {}) };
    const installed = inspection.entry;
    if (launcher.via === "package-local" && (!installed || options.rebind === true)) {
      // A copy carried inside a plugin or an app moves when its host updates: the entry must not name it.
      return {
        sched,
        result: {
          backend: sched.name,
          entry: "unmanaged",
          removedLegacy: [],
          keptLegacy: [],
          warnings: [
            `This akm is carried inside another package or app (${launcher.argv.join(" ")}), which moves or changes when it updates, so akm did not write the scheduler entry from it. ` +
              "If you run a separate akm, run `akm task sync` from it; otherwise run `akm task dispatch` every minute from your own supervisor (cron, supercronic, a systemd timer).",
          ],
        },
      };
    }
    if (!installed) {
      outcome = "installed";
      entry = wanted;
    } else if (options.rebind === true && !sameEntry(installed, wanted)) {
      outcome = "updated";
      entry = wanted;
    } else {
      outcome = "unchanged";
    }
    if (entry && launcher.via === "checkout") {
      warnings.push(
        `The scheduler entry now runs akm from a source checkout (${launcher.argv.join(" ")}); it runs whatever the checkout holds when it fires. Install akm with \`npm install --global akm-cli\` or a standalone release, then run \`akm task sync --rebind\`.`,
      );
    }
  }
  for (const kept of keptLegacy) {
    warnings.push(
      `Left the akm 0.9 scheduler row "${kept.id}": ${kept.reason}. Remove it from the OS scheduler yourself if its bundle is gone.`,
    );
  }

  const change: EntryChange | undefined =
    entry !== undefined || removeLegacy.length > 0
      ? { ...(entry !== undefined ? { entry } : {}), removeLegacy }
      : undefined;
  return {
    sched,
    result: {
      backend: sched.name,
      entry: outcome,
      removedLegacy: removeLegacy,
      keptLegacy,
      ...(warnings.length > 0 ? { warnings } : {}),
    },
    ...(change ? { change } : {}),
  };
}

function sameEntry(left: DispatchEntry, right: DispatchEntry): boolean {
  return JSON.stringify([left.launcher, left.path ?? null]) === JSON.stringify([right.launcher, right.path ?? null]);
}

export interface TasksDoctorResult {
  backend: string;
  akm: { argv: string[]; via: string };
  caller: { argv: string[]; via: string };
  /** The dispatch entry (`taskIds`: the enabled tasks it fires), then any akm 0.9 per-task rows (`status: legacy`). */
  bindings: Array<{
    argv: string[];
    taskIds: string[];
    status: string[];
  }>;
  remediation?: "akm task sync" | "akm task sync --rebind";
  logDir: string;
  scheduleSubset: string;
  warnings: string[];
}

export async function akmTasksDoctor(
  deps: { backend?: SchedulerBackend; resolveInvocation?: typeof resolveAkmInvocation; env?: NodeJS.ProcessEnv } = {},
): Promise<TasksDoctorResult> {
  const warnings: string[] = [];
  let invocation: TasksDoctorResult["akm"] = { argv: [], via: "unresolved" };
  try {
    const r = (deps.resolveInvocation ?? resolveAkmInvocation)();
    invocation = { argv: r.argv, via: r.via };
  } catch (err) {
    warnings.push(err instanceof Error ? err.message : String(err));
  }
  const sched = deps.backend ?? selectBackend();
  const backend = sched.name;
  const config = loadConfig();
  const enabledIds = (schedulerEnabledRefs(config) ?? []).map((ref) =>
    parseBundleRef(ref).conceptId.replace(/^tasks\//, ""),
  );
  const bindings: TasksDoctorResult["bindings"] = [];
  const moved = movedLocations(deps.env ?? process.env);
  if (moved.length > 0) {
    // Nothing of this installation's is in the OS scheduler; its own supervisor runs `akm task dispatch`.
    warnings.push(
      `This installation moves its ${moved.join(", ")} location${moved.length === 1 ? "" : "s"} away from the defaults: akm does not write the OS scheduler for it. Run \`akm task dispatch\` every minute from your own supervisor.`,
    );
  } else {
    try {
      const inspection = await sched.inspect();
      if (inspection.entry) {
        bindings.push({
          argv: [...inspection.entry.launcher],
          taskIds: [...enabledIds].sort(),
          status: inspectLauncher(inspection.entry.launcher),
        });
      } else if (enabledIds.length > 0) {
        warnings.push("Tasks are enabled but the scheduler entry is not installed: run `akm task sync`.");
      }
      if (inspection.legacy.length > 0) {
        bindings.push({ argv: [], taskIds: inspection.legacy.map((row) => row.id).sort(), status: ["legacy"] });
      }
    } catch (error) {
      warnings.push(
        `Unable to inspect the installed ${backend} entry: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  for (const failure of unrunnableTasks(config)) {
    warnings.push(`Enabled task ${failure.ref} cannot run: ${failure.reason}`);
  }
  const legacyOnly = bindings.some((binding) => binding.status.includes("legacy"));
  const unhealthy = bindings.some((binding) => !binding.status.includes("ok") && !binding.status.includes("legacy"));
  return {
    backend,
    akm: invocation,
    caller: invocation,
    bindings,
    ...(unhealthy
      ? { remediation: "akm task sync --rebind" as const }
      : legacyOnly
        ? { remediation: "akm task sync" as const }
        : {}),
    logDir: getTaskLogDir(),
    scheduleSubset: SCHEDULE_SUPPORTED_SUBSET_HINT,
    warnings,
  };
}

// ── helpers ─────────────────────────────────────────────────────────────────

function inspectLauncher(launcher: readonly string[]): string[] {
  const status: string[] = [];
  if (isCheckoutInvocation(launcher)) status.push("checkout");
  if (launcher.some((part) => part === "akm" || part === "bun" || part === "node")) status.push("path-selected");
  if (launcher.filter((part) => path.isAbsolute(part)).some((part) => !fs.existsSync(part)))
    status.push("missing-path");
  if (status.length === 0) status.push("ok");
  return status;
}

function taskAssetRef(id: string): AssetRef {
  return { type: "task", name: id };
}

/** The bundle `task add` writes into: its write target, config, stash path, and name. */
function resolveTaskBundle(target: string | undefined) {
  const config = loadConfig();
  const resolved = prepareWriteTargetForMutation(
    resolveWriteTarget(config, target, { requireWritable: true, flag: "--bundle" }),
  );
  return { resolved, config, stashDir: resolved.source.path, bundleName: resolved.source.name };
}

function taskProjectionAssetResolver(
  config: AkmConfig,
  bundleName: string,
  bundleRoot: string,
): NonNullable<PrepareTaskExecutionContext["resolveAsset"]> {
  return async ({ bundle, type, name }) => {
    if (bundle === bundleName) {
      return { file: await resolveAssetPath(bundleRoot, type, name), bundleRoot };
    }
    return resolveBundleAsset(config, { bundle, type, name });
  };
}

/**
 * Exported for `src/commands/tasks/explain.ts`: `akm task explain`
 * resolves its `--bundle` axis identically to every other read-only task
 * verb here (`akm task history`, `akm task run`) — the SAME resolver, not a
 * second one.
 */
export function resolveTaskReadBundle(
  refBundle: string | undefined,
  flagBundle: string | undefined,
): Pick<ResolvedWriteTarget, "source"> {
  if (refBundle && flagBundle && refBundle !== flagBundle) {
    throw new UsageError(
      `Task ref selects bundle ${JSON.stringify(refBundle)}, but --bundle selects ${JSON.stringify(flagBundle)}.`,
      "INVALID_FLAG_VALUE",
    );
  }
  const selector = flagBundle ?? refBundle;
  const config = loadConfig();
  let resolved: Pick<ResolvedWriteTarget, "source">;
  if (!selector) {
    resolved = resolveWorkingStashTarget(config, { requireWritable: false });
  } else {
    // Reading needs no write target: any bundle of the active set resolves.
    const sources = activeTaskSources(config);
    const source = resolveSourcesForOrigin(selector, sources)[0];
    if (!source) {
      assertBundleNotDisabled(config, selector);
      throw new UsageError(
        `${flagBundle !== undefined ? "--bundle" : "The task ref's bundle"} must reference a source name from your config. No source named "${selector}" is configured. Run \`akm bundle list\` to see available sources.`,
        "INVALID_FLAG_VALUE",
      );
    }
    resolved = {
      source: {
        kind: source.type ?? "filesystem",
        name: selector,
        path: source.path,
        adapterId: source.adapterId ?? detectAdapterId(source.path),
      },
    };
  }
  if (refBundle && resolved.source.name !== refBundle) {
    throw new UsageError(
      `Task ref bundle ${JSON.stringify(refBundle)} does not match the resolved source.`,
      "INVALID_FLAG_VALUE",
    );
  }
  return resolved;
}

/** True when `candidate` resolves to the same directory as the primary stash. */
function _isPrimaryStashPath(candidate: string): boolean {
  let primary: string | undefined;
  try {
    primary = path.resolve(resolveStashDir());
  } catch {
    return false;
  }
  return path.resolve(candidate) === primary;
}

function _errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

interface RenderInput {
  id: string;
  schedule: string;
  workflow?: string;
  prompt?: string;
  command?: string | string[];
  connection?: string;
  harness?: string;
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
 * runtime shape. `null` is not one of the five usual runtime types
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
 * from its own JSON runtime shape. Never emitted as `with:` —
 * task source v4 accepts `with:` only on `uses: akm/command`
 * (`parseTarget`/`checkTopLevelKeys`), and a workflow target's declared
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
  if (input.connection !== undefined) obj.connection = input.connection;
  if (input.harness !== undefined) obj.harness = input.harness;
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
