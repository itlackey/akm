// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Scheduler reconciliation: compile the desired bindings from a bundle's
 * task sources, then diff them against the rows the native
 * scheduler holds.
 *
 * `compileSchedulerSources` reads each source once. One source that fails
 * to parse or prepare is reported and skipped; every other source still
 * compiles (#867). `planSchedulerSync` is pure: given the desired bindings,
 * the installed rows, and the bundles this sync owns, it decides which rows
 * to install, update, remove, or leave alone. Rows it cannot attribute to
 * one of those bundles are never touched.
 */

import path from "node:path";
import { parseBundleRef } from "../core/asset/asset-ref";
import { taskSourceErrorDetail } from "../core/asset/bounded-task-document";
import { listAssets } from "../core/assets/read";
import { compareCodePoints, toPosix } from "../core/common";
import type { AkmConfig } from "../core/config/config-types";
import { UsageError } from "../core/errors";
import { prepareTaskV3Execution } from "./prepare/prepare";
import type { PrepareTaskV3ExecutionContext } from "./prepare/prepared-execution";
import type { ScheduleBackend } from "./schedule";
import { assertTaskScheduleCronValid, assertTaskScheduleInputsSatisfyContract } from "./schedule-gates";
import {
  compileTaskSchedulerBindings,
  type InstalledSchedulerBinding,
  type SchedulerBinding,
  type SchedulerInstallOptions,
  type SchedulerSourceSchedule,
  type SchedulerStartFlags,
  schedulerBindingNativeId,
  schedulerInputFlags,
  schedulerNativeBindingId,
} from "./scheduler-binding";
import { scheduledTaskSubject } from "./scheduler-invocation";
import { parseTaskSource } from "./source/parse-task-source";
import { projectTaskSourceV4 } from "./source/project-v4";
import type { TaskSourceV4Document } from "./source/task-source-v4";
import {
  isShadowedByYml,
  type TaskBundleSource,
  taskFileOf,
  taskIdOf,
  taskRefIn,
  taskScopeOf,
  ymlHeldIds,
} from "./task-ref";
import { checkTaskV5 } from "./v5/check";
import type { TaskSourceV5Document, TaskSourceV5ScheduleBinding } from "./v5/source";

/** One task source, bundle, or installed row that could not be reconciled. */
export interface SchedulerSourceFailure {
  readonly path: string;
  readonly ref?: string;
  readonly reason: string;
}

// ── Source compilation ──────────────────────────────────────────────────────

export interface CompileSchedulerSourcesInput {
  readonly sourceRoot: string;
  /** The bundle's adapter, when config names it: the facade finds it otherwise. */
  readonly adapterId?: string;
  readonly bundleName: string;
  readonly backend: ScheduleBackend;
  /** Frozen config used while projecting command targets. */
  readonly config?: AkmConfig;
  /** Bundle-aware local asset resolver used while projecting workflow/script targets. */
  readonly resolveAsset?: PrepareTaskV3ExecutionContext["resolveAsset"];
  /** Refs this host schedules (`scheduler.enabled`); every other source is skipped without being read. */
  readonly enabledRefs?: ReadonlySet<string>;
  /**
   * `false` skips the check of each task's target (a v4 projection, the v5 start check): `akm task dispatch` reads
   * the schedules every minute, and a target that cannot start fails its run instead. Default `true`.
   */
  readonly checkTargets?: boolean;
}

export interface CompiledSchedulerSources {
  readonly desired: readonly SchedulerBinding[];
  readonly failures: readonly SchedulerSourceFailure[];
}

const SCHEDULER_PROJECTION_CONFIG: AkmConfig = Object.freeze({
  configVersion: "0.9.0",
  semanticSearchMode: "off",
});

export async function compileSchedulerSources(input: CompileSchedulerSourcesInput): Promise<CompiledSchedulerSources> {
  const sourceRoot = path.resolve(input.sourceRoot);
  const desired: SchedulerBinding[] = [];
  const failures: SchedulerSourceFailure[] = [];
  await compileTaskSources({ ...input, sourceRoot }, desired, failures);
  return Object.freeze({
    desired: Object.freeze(desired),
    failures: Object.freeze(failures.sort((left, right) => compareCodePoints(left.path, right.path))),
  });
}

async function compileTaskSources(
  input: CompileSchedulerSourcesInput,
  desired: SchedulerBinding[],
  failures: SchedulerSourceFailure[],
): Promise<void> {
  // The bundle's task assets, one per ref as its adapter lists them, in the order of the files that hold them. Only
  // an enabled ref is read.
  const source: TaskBundleSource = {
    name: input.bundleName,
    path: input.sourceRoot,
    ...(input.adapterId !== undefined ? { adapterId: input.adapterId } : {}),
  };
  // A tasks folder that cannot be listed is the bundle's failure: its rows are left as they are.
  const everything = listAssets({ ...taskScopeOf(source), type: "task", requireComplete: true });
  const listed = everything.filter((asset) => !input.enabledRefs || input.enabledRefs.has(asset.ref));
  // A task held in a `.yml` file claims its id (compared case-insensitively, as the scheduler compares them).
  const claimed = ymlHeldIds(everything, source);
  const tasks = [...listed].sort((left, right) => compareCodePoints(taskFileOf(left), taskFileOf(right)));
  for (const asset of tasks) {
    const { ref, conceptId } = asset;
    const id = taskIdOf(asset, source);
    // A task held in a file whose extension is in another case is a task source only when no `.yml` claims its id.
    if (isShadowedByYml(asset, id, claimed)) continue;
    const file = taskFileOf(asset);
    try {
      const yaml = asset.entry.content();
      const relative = toPosix(path.relative(input.sourceRoot, file));
      const parsed = parseTaskSource({ yaml, filePath: file });
      // A task with no `schedule:` is run by hand or by a workflow step; it
      // contributes no binding and is not sync's to validate.
      if (parsed.schedule.length === 0) continue;
      const schedules =
        parsed.version === 4
          ? await compileV4Schedules(parsed.v4, { ...input, id, ref, relative })
          : await compileV5Schedules(parsed.v5, { ...input, ref, conceptId, relative });
      desired.push(...compileTaskSchedulerBindings({ id, qualifiedRef: ref, schedules }));
    } catch (cause) {
      const detail = taskSourceErrorDetail(cause);
      failures.push({ path: file, ref, reason: detail === errorMessage(cause) ? `${file}: ${detail}` : detail });
    }
  }
}

interface ScheduleCompileInput extends CompileSchedulerSourcesInput {
  readonly ref: string;
  readonly relative: string;
}

async function compileV4Schedules(
  parsed: TaskSourceV4Document,
  input: ScheduleCompileInput & { readonly id: string },
): Promise<SchedulerSourceSchedule[]> {
  assertTaskScheduleInputsSatisfyContract(parsed, input.ref);
  assertTaskScheduleCronValid(parsed, input.backend);
  // Project so a target that cannot resolve (a missing workflow, an
  // unconfigured engine) is reported here rather than at fire time.
  // Bindings compile from the original document: the projection drops
  // `schedule[i].inputs`, which are delivered through the invocation tail.
  if (input.checkTargets !== false) {
    await prepareTaskV3Execution(projectTaskSourceV4(parsed), {
      taskId: input.id,
      taskRef: input.ref,
      bundleName: input.bundleName,
      bundleRoot: input.sourceRoot,
      config: input.config ?? SCHEDULER_PROJECTION_CONFIG,
      ...(input.resolveAsset ? { resolveAsset: input.resolveAsset } : {}),
    });
  }
  return parsed.schedule.map((schedule) => ({
    cron: schedule.cron,
    ordinal: schedule.ordinal,
    source: `${input.relative}:${schedule.source}`,
    inputs: schedule.inputs,
  }));
}

/**
 * Each entry is checked by `checkTaskV5`, the check a start makes, with the inputs and flags its tail gives the
 * start. An entry that fails fails the task, named by its position: the task's installed rows are left as they are.
 */
async function compileV5Schedules(
  document: TaskSourceV5Document,
  input: ScheduleCompileInput & { readonly conceptId: string },
): Promise<SchedulerSourceSchedule[]> {
  assertTaskScheduleCronValid(document, input.backend);
  const bundle = { name: input.bundleName, dir: input.sourceRoot };
  const schedules: SchedulerSourceSchedule[] = [];
  for (const entry of document.schedule) {
    const start = scheduleStartFlags(entry);
    try {
      if (input.checkTargets !== false) await checkScheduleEntryV5(entry, input.conceptId, bundle);
    } catch (cause) {
      throw new UsageError(`schedule[${entry.ordinal}]: ${errorMessage(cause)}`, "TASK_SOURCE_INVALID");
    }
    schedules.push({
      cron: entry.cron,
      ordinal: entry.ordinal,
      source: `${input.relative}:${entry.source}`,
      inputs: entry.inputs,
      start,
    });
  }
  return schedules;
}

/** The check a start makes (`checkTaskV5`), with the inputs and the `--env`, `--secret` and `--timeout` a schedule entry gives. Sync and `doctor explain` both call it. */
export async function checkScheduleEntryV5(
  entry: TaskSourceV5ScheduleBinding,
  conceptId: string,
  bundle: { name: string; dir: string },
): Promise<void> {
  await checkTaskV5({
    ref: conceptId,
    bundle,
    inputs: schedulerInputFlags(entry.inputs),
    flags: scheduleStartFlags(entry),
  });
}

/** What `--env`, `--secret` and `--timeout` carry for a schedule entry. The reader takes only env asset refs in its `env:`. */
function scheduleStartFlags(entry: TaskSourceV5ScheduleBinding): SchedulerStartFlags {
  const env = (entry.env ?? []) as readonly string[];
  return {
    ...(env.length > 0 ? { env } : {}),
    ...(entry.secret !== undefined && entry.secret.length > 0 ? { secret: entry.secret } : {}),
    ...(entry.timeout !== undefined ? { timeout: entry.timeout } : {}),
  };
}

// ── Planning ────────────────────────────────────────────────────────────────

/** One bundle whose installed rows this sync owns. */
export interface SchedulerBundleScope {
  readonly bundleName: string;
  /**
   * Resolved bundle path. Set for the primary bundle, whose rows must also
   * prove their owning path (#846) through the `AKM_BUNDLE_DIR` they carry —
   * inline, or in the descriptor a row written before 0.9.17-alpha.7 names:
   * a display name derived from a directory basename is not an identity two
   * installations cannot share. A `--bundle <target>` scope matches by
   * config name only.
   */
  readonly bundlePath?: string;
  /** The bundle, to name the task a row written before 0.11 holds by its id. */
  readonly source?: TaskBundleSource;
}

export interface SchedulerSyncPlanInput {
  readonly desired: readonly SchedulerBinding[];
  readonly installed: readonly InstalledSchedulerBinding[];
  readonly scopes: readonly SchedulerBundleScope[];
  readonly expectedSignature?: (binding: SchedulerBinding, options?: SchedulerInstallOptions) => string;
  /** Launcher and environment for rows that are installed fresh (or every row under `rebind`). */
  readonly installOptions?: SchedulerInstallOptions;
  /** Repoint every row to `installOptions.binding`; without it an installed row keeps its own launcher. */
  readonly rebind?: boolean;
  /** Rows to remove regardless of the desired set (a disabled bundle's rows). */
  readonly extraRemovals?: readonly InstalledSchedulerBinding[];
  /** Refs whose source exists but failed to compile: their installed rows are left exactly as they are. */
  readonly keepRefs?: ReadonlySet<string>;
}

export type SchedulerSyncOperation =
  | Readonly<{
      kind: "install" | "update";
      binding: SchedulerBinding;
      options?: SchedulerInstallOptions;
      /** Normalized native definition currently installed. Updates only. */
      installedSignature?: string;
      /** Normalized native definition the operation renders. */
      expectedSignature?: string;
    }>
  | Readonly<{
      kind: "remove";
      id: string;
      nativeId: string;
      /** Resolved bundle path the row was attributed to (#846), when known. */
      ownerBundlePath?: string;
      /** Why `akm task prune` selected this row. Absent for sync's own removals. */
      reason?: "invalid-context" | "dead-bundle-path";
    }>;

export interface SchedulerSyncPlan {
  readonly desired: readonly SchedulerBinding[];
  readonly installed: readonly string[];
  readonly updated: readonly string[];
  readonly removed: readonly string[];
  readonly unchanged: readonly string[];
  /** Removals first, then installs and updates, so a renamed row never deletes its own replacement. */
  readonly operations: readonly SchedulerSyncOperation[];
  readonly failures: readonly SchedulerSourceFailure[];
}

export function installedRowNativeId(row: InstalledSchedulerBinding): string {
  return row.nativeId ?? schedulerNativeBindingId(row.id);
}

/** The bundle an installed row's own invocation names: its task's or workflow's ref, else a legacy row's `--bundle <x>`. */
export function scheduledInvocationBundle(invocation: readonly string[] | undefined): string | undefined {
  if (!invocation) return undefined;
  const bundleIndex = invocation.indexOf("--bundle");
  if (bundleIndex >= 0) return invocation[bundleIndex + 1];
  const subject =
    invocation[0] === "workflow" && invocation[1] === "run" ? invocation[2] : scheduledTaskSubject(invocation)?.subject;
  if (subject) {
    try {
      return parseBundleRef(subject).bundle;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * The scope that owns an installed row, or none. A row written before
 * `--bundle` existed names no bundle and belongs to the primary scope
 * unless the bundle path it carries says otherwise; a row that names a
 * bundle belongs to the scope of that name — for the primary scope only
 * when its `AKM_BUNDLE_DIR` (inline, or in an older row's descriptor) also
 * proves the path.
 */
export function installedRowScope(
  row: InstalledSchedulerBinding,
  scopes: readonly SchedulerBundleScope[],
): SchedulerBundleScope | undefined {
  const bundle = row.target ?? scheduledInvocationBundle(row.invocation);
  for (const scope of scopes) {
    if (scope.bundlePath === undefined) {
      if (bundle === scope.bundleName) return scope;
      continue;
    }
    if (bundle === undefined) {
      if (row.ownerBundlePath === undefined || row.ownerBundlePath === scope.bundlePath) return scope;
      continue;
    }
    if (bundle === scope.bundleName && row.ownerBundlePath === scope.bundlePath) return scope;
  }
  return undefined;
}

export function planSchedulerSync(input: SchedulerSyncPlanInput): SchedulerSyncPlan {
  const failures: SchedulerSourceFailure[] = [];
  const installedByNative = new Map<string, InstalledSchedulerBinding>();
  for (const row of input.installed) installedByNative.set(installedRowNativeId(row), row);

  // Two sources claiming one native row — compared case-insensitively, as
  // Task Scheduler and a default macOS volume compare them: neither is
  // installed and the row, if any, is left exactly as it is.
  const desiredByNative = new Map<string, SchedulerBinding[]>();
  for (const binding of input.desired) {
    const key = schedulerBindingNativeId(binding).toLowerCase();
    desiredByNative.set(key, [...(desiredByNative.get(key) ?? []), binding]);
  }
  const skipped = new Set<string>();
  for (const group of desiredByNative.values()) {
    if (group.length < 2) continue;
    const refs = group.map((binding) => JSON.stringify(binding.logicalSource.ref)).join(" and ");
    for (const binding of group) {
      const nativeId = schedulerBindingNativeId(binding);
      skipped.add(nativeId);
      failures.push({
        path: binding.source,
        ref: binding.logicalSource.ref,
        reason: `Scheduler id ${JSON.stringify(nativeId)} is claimed by ${refs}. Rename one task before enabling both.`,
      });
    }
  }

  const installed: string[] = [];
  const updated: string[] = [];
  const unchanged: string[] = [];
  const writes: SchedulerSyncOperation[] = [];
  for (const binding of input.desired) {
    const nativeId = schedulerBindingNativeId(binding);
    if (skipped.has(nativeId)) continue;
    const current = installedByNative.get(nativeId);
    if (
      current &&
      installedRowScope(current, input.scopes)?.bundleName !== parseBundleRef(binding.logicalSource.ref).bundle
    ) {
      skipped.add(nativeId);
      failures.push({
        path: binding.source,
        ref: binding.logicalSource.ref,
        reason: foreignRowMessage(nativeId, current),
      });
      continue;
    }
    const options = installOptionsFor(input, current);
    const expected = input.expectedSignature?.(binding, options);
    if (!current) {
      installed.push(binding.id);
      writes.push(
        Object.freeze({
          kind: "install" as const,
          binding,
          ...(options ? { options } : {}),
          ...(expected !== undefined ? { expectedSignature: expected } : {}),
        }),
      );
      continue;
    }
    if (expected === undefined || current.signature === expected) {
      unchanged.push(binding.id);
      continue;
    }
    updated.push(binding.id);
    writes.push(
      Object.freeze({
        kind: "update" as const,
        binding,
        ...(options ? { options } : {}),
        ...(current.signature !== undefined ? { installedSignature: current.signature } : {}),
        expectedSignature: expected,
      }),
    );
  }

  const desiredNative = new Set(input.desired.map(schedulerBindingNativeId));
  const removals = new Map<string, InstalledSchedulerBinding>();
  for (const row of input.installed) {
    const nativeId = installedRowNativeId(row);
    if (desiredNative.has(nativeId) || skipped.has(nativeId)) continue;
    const scope = installedRowScope(row, input.scopes);
    if (!scope) continue;
    const ref = installedRowRef(row, scope);
    if (ref === undefined || !input.keepRefs?.has(ref)) removals.set(nativeId, row);
  }
  for (const row of input.extraRemovals ?? []) {
    const nativeId = installedRowNativeId(row);
    if (!desiredNative.has(nativeId) && !removals.has(nativeId)) removals.set(nativeId, row);
  }
  const removeOperations = [...removals.values()]
    .sort((left, right) => compareCodePoints(left.id, right.id))
    .map((row) =>
      Object.freeze({
        kind: "remove" as const,
        id: row.id,
        nativeId: installedRowNativeId(row),
        ...(row.ownerBundlePath !== undefined ? { ownerBundlePath: row.ownerBundlePath } : {}),
      }),
    );

  return Object.freeze({
    desired: input.desired,
    installed: Object.freeze(installed),
    updated: Object.freeze(updated),
    removed: Object.freeze(removeOperations.map((operation) => operation.id)),
    unchanged: Object.freeze(unchanged),
    operations: Object.freeze([...removeOperations, ...writes]),
    failures: Object.freeze(failures),
  });
}

/** An installed row keeps its own launcher unless `rebind`; its environment always follows the current policy. */
function installOptionsFor(
  input: SchedulerSyncPlanInput,
  current: InstalledSchedulerBinding | undefined,
): SchedulerInstallOptions | undefined {
  if (current && !input.rebind) {
    const environment = input.installOptions?.environment ?? current.environment;
    return Object.freeze({
      binding: Object.freeze([...current.binding]),
      ...(environment !== undefined ? { environment } : {}),
    });
  }
  return input.installOptions ? Object.freeze({ ...input.installOptions }) : undefined;
}

/** The source ref an installed row runs, read from its own invocation. */
export function installedRowRef(row: InstalledSchedulerBinding, scope: SchedulerBundleScope): string | undefined {
  const invocation = row.invocation ?? [];
  if (invocation[0] === "workflow" && invocation[1] === "run" && invocation[2]) return invocation[2];
  const subject = scheduledTaskSubject(invocation)?.subject;
  if (!subject) return undefined;
  // A row names its task by ref; one written before 0.11 by its id, in the bundle it names.
  if (subject.includes("//")) return subject;
  return scope.source ? taskRefIn(scope.source, subject) : undefined;
}

/** Where an installed row was scheduled from, for messages. */
export function installedRowOwner(row: InstalledSchedulerBinding): string {
  const bundle = row.target ?? scheduledInvocationBundle(row.invocation);
  const installation = row.ownerBundlePath
    ? `the installation whose working stash is ${JSON.stringify(row.ownerBundlePath)}`
    : undefined;
  if (bundle)
    return installation ? `bundle ${JSON.stringify(bundle)} of ${installation}` : `bundle ${JSON.stringify(bundle)}`;
  return installation ?? "an installation this sync cannot attribute";
}

function foreignRowMessage(nativeId: string, row: InstalledSchedulerBinding): string {
  return `Scheduler id ${JSON.stringify(nativeId)} is already scheduled from ${installedRowOwner(row)}; desired source ids must not collide across bundles. Leaving it out of this sync.`;
}

// ── Preview (`--dry-run`, `prune`) ──────────────────────────────────────────

export interface SchedulerPlanPreviewOperation {
  readonly id: string;
  readonly kind: "install" | "update" | "remove";
  /** Native scheduler artifact id (crontab marker, plist label, schtasks task name). Removals only. */
  readonly nativeId?: string;
  /** Resolved bundle path the installed row was attributed to (#846). Removals only, when known. */
  readonly ownerBundlePath?: string;
  /** Why `akm task prune` selected this row. Absent for `sync`'s own removals. */
  readonly reason?: "invalid-context" | "dead-bundle-path";
  /** Exact native definition currently installed. Updates only. */
  readonly installedFingerprint?: string;
  /** Exact native definition the update would install. Updates only. */
  readonly expectedFingerprint?: string;
}

export interface SchedulerPlanPreview {
  readonly backend: string;
  readonly dryRun: true;
  readonly adds: readonly SchedulerPlanPreviewOperation[];
  readonly updates: readonly SchedulerPlanPreviewOperation[];
  readonly removes: readonly SchedulerPlanPreviewOperation[];
  readonly unchanged: readonly string[];
  /** Drives dry-run's non-zero exit: true whenever the plan would remove any row. */
  readonly hasRemovals: boolean;
  readonly failures: readonly SchedulerSourceFailure[];
}

/** Project a set of operations into a preview report. Pure: no I/O, no backend calls. */
export function renderSchedulerPlanPreview(
  backend: string,
  operations: readonly SchedulerSyncOperation[],
  unchanged: readonly string[] = [],
  failures: readonly SchedulerSourceFailure[] = [],
): SchedulerPlanPreview {
  const adds: SchedulerPlanPreviewOperation[] = [];
  const updates: SchedulerPlanPreviewOperation[] = [];
  const removes: SchedulerPlanPreviewOperation[] = [];
  for (const operation of operations) {
    if (operation.kind === "remove") {
      removes.push({
        id: operation.id,
        kind: "remove",
        nativeId: operation.nativeId,
        ...(operation.ownerBundlePath !== undefined ? { ownerBundlePath: operation.ownerBundlePath } : {}),
        ...(operation.reason !== undefined ? { reason: operation.reason } : {}),
      });
    } else if (operation.kind === "install") {
      adds.push({ id: operation.binding.id, kind: "install" });
    } else {
      updates.push({
        id: operation.binding.id,
        kind: "update",
        ...(operation.installedSignature !== undefined ? { installedFingerprint: operation.installedSignature } : {}),
        ...(operation.expectedSignature !== undefined ? { expectedFingerprint: operation.expectedSignature } : {}),
      });
    }
  }
  return {
    backend,
    dryRun: true,
    adds,
    updates,
    removes,
    unchanged: [...unchanged],
    hasRemovals: removes.length > 0,
    failures: [...failures],
  };
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
