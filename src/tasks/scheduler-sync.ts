// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Scheduler reconciliation: compile the desired bindings from a bundle's
 * task and workflow sources, then diff them against the rows the native
 * scheduler holds.
 *
 * `compileSchedulerSources` reads each source once. One source that fails
 * to parse or prepare is reported and skipped; every other source still
 * compiles (#867). `planSchedulerSync` is pure: given the desired bindings,
 * the installed rows, and the bundles this sync owns, it decides which rows
 * to install, update, remove, or leave alone. Rows it cannot attribute to
 * one of those bundles are never touched.
 */

import fs from "node:fs";
import path from "node:path";
import { makeBundleRef, parseBundleRef } from "../core/asset/asset-ref";
import { compareCodePoints, toPosix } from "../core/common";
import type { AkmConfig } from "../core/config/config-types";
import { UsageError } from "../core/errors";
import { canonicalizeWorkflowName, WORKFLOW_EXTENSIONS } from "../core/recognition-util";
import { applyInputDefaults, validateInputs } from "../execution/input-contract";
import { checkWorkflowPlan, compileWorkflowSource } from "../workflows/compile";
import {
  WorkflowSourceCollisionError,
  WorkflowSourceNameError,
  workflowNameForSourcePath,
} from "../workflows/source-files";
import { prepareTaskV3Execution } from "./prepare/prepare";
import type { PrepareTaskV3ExecutionContext } from "./prepare/prepared-execution";
import { parseSchedule, type ScheduleBackend } from "./schedule";
import {
  compileTaskSchedulerBindings,
  compileWorkflowSchedulerBindings,
  type InstalledSchedulerBinding,
  type SchedulerBinding,
  type SchedulerInstallOptions,
  schedulerBindingNativeId,
  schedulerNativeBindingId,
} from "./scheduler-binding";
import { type ParsedTaskSource, parseTaskSource } from "./source/parse-task-source";
import { projectTaskSourceV4 } from "./source/project-v4";
import { taskSourceErrorDetail } from "./source-v3";

/** One task/workflow source, bundle, or installed row that could not be reconciled. */
export interface SchedulerSourceFailure {
  readonly path: string;
  readonly ref?: string;
  readonly reason: string;
}

// ── Source compilation ──────────────────────────────────────────────────────

export interface CompileSchedulerSourcesInput {
  readonly sourceRoot: string;
  readonly adapterId: string;
  readonly bundleName: string;
  readonly backend: ScheduleBackend;
  /** Frozen config used while projecting command targets. */
  readonly config?: AkmConfig;
  /** Bundle-aware local asset resolver used while projecting workflow/script targets. */
  readonly resolveAsset?: PrepareTaskV3ExecutionContext["resolveAsset"];
  /** Refs this host schedules (`scheduler.enabled`); every other source is skipped without being read. */
  readonly enabledRefs?: ReadonlySet<string>;
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
  compileWorkflowSources({ ...input, sourceRoot }, desired, failures);
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
  for (const file of taskSourceFiles(input.sourceRoot, input.adapterId)) {
    const relative = toPosix(path.relative(input.sourceRoot, file));
    const conceptId = relative.slice(0, -".yml".length);
    const id = input.adapterId === "akm-task" ? conceptId : path.basename(file, ".yml");
    const ref = sourceRef(input.bundleName, conceptId);
    if (ref === undefined || (input.enabledRefs && !input.enabledRefs.has(ref))) continue;
    try {
      const parsed = parseTaskSource({
        yaml: fs.readFileSync(file, "utf8"),
        filePath: file,
        workspaceRoot: input.sourceRoot,
      });
      // A task with no `schedule:` is run by hand or by a workflow step; it
      // contributes no binding and is not sync's to validate.
      if (parsed.v4.schedule.length === 0) continue;
      assertTaskScheduleInputsSatisfyContract(parsed.v4, ref);
      assertTaskScheduleCronValid(parsed.v4, input.backend);
      // Project so a target that cannot resolve (a missing workflow, an
      // unconfigured engine) is reported here rather than at fire time.
      // Bindings compile from the original document: the projection drops
      // `schedule[i].inputs`, which are delivered through the invocation tail.
      await prepareTaskV3Execution(projectTaskSourceV4(parsed.v4), {
        taskId: id,
        taskRef: ref,
        bundleName: input.bundleName,
        bundleRoot: input.sourceRoot,
        config: input.config ?? SCHEDULER_PROJECTION_CONFIG,
        ...(input.resolveAsset ? { resolveAsset: input.resolveAsset } : {}),
      });
      desired.push(
        ...compileTaskSchedulerBindings({
          id,
          qualifiedRef: ref,
          schedules: parsed.v4.schedule.map((schedule) => ({
            cron: schedule.cron,
            ordinal: schedule.ordinal,
            source: `${relative}:${schedule.source}`,
            inputs: schedule.inputs,
          })),
        }),
      );
    } catch (cause) {
      const detail = taskSourceErrorDetail(cause);
      failures.push({ path: file, ref, reason: detail === errorMessage(cause) ? `${file}: ${detail}` : detail });
    }
  }
}

/** Task candidates: `tasks/*.yml` for the akm adapter, every `.yml` in the tree for `akm-task`. */
function taskSourceFiles(sourceRoot: string, adapterId: string): string[] {
  if (adapterId === "akm") {
    const dir = path.join(sourceRoot, "tasks");
    const names = listDirectory(dir);
    return names
      .filter((name) => name.endsWith(".yml"))
      .map((name) => path.join(dir, name))
      .filter((file) => statOrUndefined(file)?.isFile() === true)
      .sort(compareCodePoints);
  }
  if (adapterId === "akm-task") return walkFiles(sourceRoot).filter((file) => file.endsWith(".yml"));
  return [];
}

function compileWorkflowSources(
  input: CompileSchedulerSourcesInput,
  desired: SchedulerBinding[],
  failures: SchedulerSourceFailure[],
): void {
  if (input.adapterId !== "akm" && input.adapterId !== "akm-workflow") return;
  const root = input.adapterId === "akm" ? path.join(input.sourceRoot, "workflows") : input.sourceRoot;
  const byName = new Map<string, string[]>();
  for (const file of walkFiles(root)) {
    if (path.basename(file).toLowerCase() === "readme.md") continue;
    const authoredName = workflowNameForSourcePath(input.sourceRoot, input.adapterId, file);
    if (authoredName === undefined) continue;
    const extension = path.posix.extname(authoredName).toLowerCase();
    const stem = authoredName.slice(0, -extension.length).toLowerCase();
    const nestedSuffix = (WORKFLOW_EXTENSIONS as readonly string[]).find((suffix) => stem.endsWith(suffix));
    if (nestedSuffix) {
      const relative = toPosix(path.relative(input.sourceRoot, file));
      failures.push({ path: file, reason: new WorkflowSourceNameError(relative, nestedSuffix).message });
      continue;
    }
    const canonicalName = canonicalizeWorkflowName(authoredName);
    byName.set(canonicalName, [...(byName.get(canonicalName) ?? []), file]);
  }
  for (const [canonicalName, sources] of [...byName].sort(([left], [right]) => compareCodePoints(left, right))) {
    const conceptId = input.adapterId === "akm" ? `workflows/${canonicalName}` : canonicalName;
    const ref = sourceRef(input.bundleName, conceptId);
    if (ref === undefined || (input.enabledRefs && !input.enabledRefs.has(ref))) continue;
    const file = sources[0]!;
    try {
      if (sources.length > 1) {
        throw new WorkflowSourceCollisionError(
          conceptId,
          sources.map((source) => toPosix(path.relative(input.sourceRoot, source))),
        );
      }
      const relative = toPosix(path.relative(input.sourceRoot, file));
      const compiled = compileWorkflowSource(fs.readFileSync(file, "utf8"), {
        path: relative,
        workspaceRoot: input.sourceRoot,
      });
      if (!compiled.ok) {
        throw new UsageError(
          compiled.errors
            .map((error) => `${error.path}:${error.line ?? 1} [${error.code}] ${error.message}`)
            .join("; "),
          "WORKFLOW_SOURCE_INVALID",
        );
      }
      const planDraft = checkWorkflowPlan(compiled.plan);
      if (!planDraft.ok) {
        throw new UsageError(
          planDraft.errors.map((error) => `${relative}:${error.line} ${error.message}`).join("; "),
          "WORKFLOW_SOURCE_INVALID",
        );
      }
      const schedules = (compiled.plan.schedules ?? []).map((schedule) => ({
        cron: schedule.cron,
        source: `${relative}:${schedule.line}`,
        ordinal: schedule.ordinal,
      }));
      for (const binding of compileWorkflowSchedulerBindings({ qualifiedRef: ref, schedules })) {
        parseSchedule(binding.cron, input.backend);
        desired.push(binding);
      }
    } catch (cause) {
      failures.push({ path: file, ref, reason: errorMessage(cause) });
    }
  }
}

/** A file whose name cannot form a ref (a `#` in it) cannot be enabled, so it is not this sync's. */
function sourceRef(bundleName: string, conceptId: string): string | undefined {
  try {
    return makeBundleRef(bundleName, conceptId);
  } catch {
    return undefined;
  }
}

/** Directory entries, or none when the directory does not exist. Any other read error is the bundle's own failure. */
function listDirectory(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/** Every regular file under `dir` (symlinks followed), sorted. */
function walkFiles(dir: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const name of listDirectory(directory)) {
      const candidate = path.join(directory, name);
      const stat = statOrUndefined(candidate);
      if (stat?.isDirectory()) visit(candidate);
      else if (stat?.isFile()) files.push(candidate);
    }
  };
  visit(dir);
  return files.sort(compareCodePoints);
}

/** A dangling or looping symlink is not a source file; it is skipped, never fatal. */
function statOrUndefined(file: string): fs.Stats | undefined {
  try {
    return fs.statSync(file);
  } catch {
    return undefined;
  }
}

/**
 * Validate every v4 `schedule:` entry's `inputs` against the task's own
 * declared contract with defaults applied — the exact set of values a
 * compiled invocation delivers — so a violation is reported at sync rather
 * than when the scheduler fires. Shared with `akm task validate`.
 */
export function assertTaskScheduleInputsSatisfyContract(
  v4: Pick<ParsedTaskSource["v4"], "inputs" | "schedule">,
  refLabel: string,
): void {
  const contract = v4.inputs ?? {};
  for (const scheduleEntry of v4.schedule) {
    const defaultedInputs = applyInputDefaults(contract, { ...scheduleEntry.inputs });
    const errors = validateInputs(contract, defaultedInputs);
    if (errors.length > 0) {
      throw new UsageError(
        `Task ${JSON.stringify(refLabel)} schedule[${scheduleEntry.ordinal}].inputs does not satisfy ` +
          `its declared inputs once defaults are applied: ${errors.join("; ")}`,
        "TASK_SOURCE_INVALID",
      );
    }
  }
}

/**
 * Validate every v4 `schedule:` entry's `cron` against the active backend's
 * dialect: cron is the most permissive of the three, so a task authored on
 * Linux can carry an expression launchd/schtasks cannot translate. Shared
 * with `akm task validate`.
 */
export function assertTaskScheduleCronValid(
  v4: Pick<ParsedTaskSource["v4"], "schedule">,
  backend: ScheduleBackend,
): void {
  for (const scheduleEntry of v4.schedule) parseSchedule(scheduleEntry.cron, backend);
}

// ── Planning ────────────────────────────────────────────────────────────────

/** One bundle whose installed rows this sync owns. */
export interface SchedulerBundleScope {
  readonly bundleName: string;
  /**
   * Resolved bundle path. Set for the primary bundle, whose rows must also
   * prove their owning path through their descriptor (#846): a display name
   * derived from a directory basename is not an identity two installations
   * cannot share. A `--bundle <target>` scope matches by config name only.
   */
  readonly bundlePath?: string;
  /** The bundle's adapter; `akm-task` names a task row's ref by its bare concept id. */
  readonly adapterId?: string;
}

export interface SchedulerSyncPlanInput {
  readonly desired: readonly SchedulerBinding[];
  readonly installed: readonly InstalledSchedulerBinding[];
  readonly scopes: readonly SchedulerBundleScope[];
  readonly expectedSignature?: (binding: SchedulerBinding, options?: SchedulerInstallOptions) => string;
  /** Launcher and descriptor for rows that are installed fresh (or every row under `rebind`). */
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

/** The bundle an installed row's own invocation names: `--bundle <x>`, or a workflow ref's bundle. */
export function scheduledInvocationBundle(invocation: readonly string[] | undefined): string | undefined {
  if (!invocation) return undefined;
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

/**
 * The scope that owns an installed row, or none. A row written before
 * `--bundle` existed names no bundle and belongs to the primary scope
 * unless its descriptor says otherwise; a row that names a bundle belongs
 * to the scope of that name — for the primary scope only when its
 * descriptor also proves the path.
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

/** An installed row keeps its own launcher unless `rebind`; the descriptor always follows the current policy. */
function installOptionsFor(
  input: SchedulerSyncPlanInput,
  current: InstalledSchedulerBinding | undefined,
): SchedulerInstallOptions | undefined {
  if (current && !input.rebind) {
    return Object.freeze({
      binding: Object.freeze([...current.binding]),
      contextPath: input.installOptions?.contextPath ?? current.contextPath,
    });
  }
  return input.installOptions ? Object.freeze({ ...input.installOptions }) : undefined;
}

/** The source ref an installed row runs, read from its own invocation. */
function installedRowRef(row: InstalledSchedulerBinding, scope: SchedulerBundleScope): string | undefined {
  const [verb, action, subject] = row.invocation ?? [];
  if (action !== "run" || !subject) return undefined;
  if (verb === "workflow") return subject;
  if (verb !== "task") return undefined;
  return `${scope.bundleName}//${scope.adapterId === "akm-task" ? subject : `tasks/${subject}`}`;
}

/** Where an installed row was scheduled from, for messages. */
export function installedRowOwner(row: InstalledSchedulerBinding): string {
  const bundle = row.target ?? scheduledInvocationBundle(row.invocation);
  if (row.ownerBundlePath) return `the bundle at ${JSON.stringify(row.ownerBundlePath)}`;
  return bundle ? `bundle ${JSON.stringify(bundle)}` : "an installation this sync cannot attribute";
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
