// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Dispatch mode for `akm doctor scheduler sync`: which mode a host is in, the plan for each mode, and the order a
 * plan is applied in.
 *
 * A host in dispatch mode holds one row, `akm task dispatch` every minute ({@link DISPATCH_BINDING}), instead of a
 * row per schedule entry. The mode is what the installed rows show: this installation's dispatch row is installed or
 * it is not. A per-task row names this installation's working stash (`AKM_BUNDLE_DIR`), which is how its rows are told
 * from another installation's. The dispatch row names no stash: `akm task dispatch` reads the config, and an
 * installation is its config, so the row is told apart by the config directory or file it carries, none for the
 * default one. A host never holds both kinds of row: switching removes one kind before it writes the other, and a
 * write after a failed removal is held.
 */

import { UsageError } from "../core/errors";
import type { SchedulerBackend } from "./backends/types";
import {
  DISPATCH_BINDING,
  type InstalledSchedulerBinding,
  isDispatchRow,
  type SchedulerBinding,
  type SchedulerInstallOptions,
} from "./scheduler-binding";
import { type ScheduledRowEnvironment, scheduledTaskSubject } from "./scheduler-invocation";
import {
  installedRowNativeId,
  installedRowOwner,
  type SchedulerSourceFailure,
  type SchedulerSyncOperation,
  type SchedulerSyncPlan,
} from "./scheduler-sync";

export const ROWS_DEPRECATED_WARNING =
  "Per-task scheduler rows are deprecated and removed in 0.11. `akm doctor scheduler sync --dispatch` switches this host to one row that runs `akm task dispatch` every minute.";

export interface SchedulerMode {
  readonly dispatch: boolean;
  /** This installation's dispatch row, when installed. */
  readonly ownDispatchRow?: InstalledSchedulerBinding;
  /** The installed rows without any dispatch row: what the per-task planner sees. */
  readonly taskRows: InstalledSchedulerBinding[];
}

/** The config a row's installation reads: its `AKM_CONFIG_FILE` or `AKM_CONFIG_DIR`, undefined for the default one. */
function configOf(environment: ScheduledRowEnvironment | undefined): string | undefined {
  return environment?.AKM_CONFIG_FILE ?? environment?.AKM_CONFIG_DIR;
}

/**
 * The environment the dispatch row sets: the sync's own without `AKM_BUNDLE_DIR`, which is Deprecated, unless the
 * syncing process was given it, as the stash it still selects that way.
 */
function dispatchRowEnvironment(
  environment: ScheduledRowEnvironment | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ScheduledRowEnvironment | undefined {
  if (environment === undefined || env.AKM_BUNDLE_DIR?.trim()) return environment;
  const { AKM_BUNDLE_DIR: _derived, ...rest } = environment;
  return Object.keys(rest).length > 0 ? rest : undefined;
}

/** The mode a sync works in: `requested` (`--dispatch` / `--no-dispatch`), else the one the installed rows show. */
export function schedulerModeOf(
  rows: readonly InstalledSchedulerBinding[],
  ownEnvironment: ScheduledRowEnvironment | undefined,
  requested: boolean | undefined,
): SchedulerMode {
  const dispatchRow = rows.find(isDispatchRow);
  const ownDispatchRow =
    dispatchRow !== undefined && configOf(dispatchRow.environment) === configOf(ownEnvironment)
      ? dispatchRow
      : undefined;
  const dispatch = requested ?? ownDispatchRow !== undefined;
  if (dispatch && dispatchRow !== undefined && ownDispatchRow === undefined) {
    const config = configOf(dispatchRow.environment);
    const owner = config === undefined ? "the default config" : JSON.stringify(config);
    throw new UsageError(
      `Scheduler id "dispatch" is already scheduled by the installation that reads ${owner}; one installation per user can use dispatch mode. Run this installation without \`--dispatch\`.`,
      "INVALID_FLAG_VALUE",
    );
  }
  return {
    dispatch,
    ...(ownDispatchRow !== undefined ? { ownDispatchRow } : {}),
    taskRows: rows.filter((row) => !isDispatchRow(row)),
  };
}

export interface ModePlan {
  readonly plan: SchedulerSyncPlan;
  readonly failures: SchedulerSourceFailure[];
  readonly warnings: string[];
}

/** Row mode: the per-task plan, after removing this installation's dispatch row when switching back. */
export function planRowMode(rowPlan: SchedulerSyncPlan, mode: SchedulerMode): ModePlan {
  const warnings = rowPlan.operations.some((operation) => operation.kind !== "remove") ? [ROWS_DEPRECATED_WARNING] : [];
  const own = mode.ownDispatchRow;
  if (own === undefined) return { plan: rowPlan, failures: [], warnings };
  const removal = Object.freeze({ kind: "remove" as const, id: own.id, nativeId: installedRowNativeId(own) });
  const plan = { ...rowPlan, removed: [removal.id, ...rowPlan.removed], operations: [removal, ...rowPlan.operations] };
  return { plan, failures: [], warnings };
}

export interface DispatchModeInput {
  readonly sched: SchedulerBackend;
  readonly mode: SchedulerMode;
  /** The bindings the task files compile to: read for what dispatch cannot start, never installed. */
  readonly desired: readonly SchedulerBinding[];
  readonly enabledRefs: readonly string[];
  readonly ownBundleDir: string | undefined;
  readonly installOptions: SchedulerInstallOptions;
  readonly rebind: boolean;
}

/**
 * Dispatch mode: remove every row this installation wrote, then install or update the dispatch row, which keeps its
 * launcher unless `rebind`, as a task row does. An `@reboot` entry is a failure: dispatch has no minute for it. A
 * row of another installation that runs an enabled task is left, with a warning: dispatch starts that task too.
 */
export function planDispatchMode(input: DispatchModeInput): ModePlan {
  const { mode, ownBundleDir } = input;
  const failures: SchedulerSourceFailure[] = input.desired
    .filter((binding) => binding.cron.trim().toLowerCase() === "@reboot")
    .map((binding) => ({
      path: binding.source,
      ref: binding.logicalSource.ref,
      reason:
        "`@reboot` runs once at startup, which `akm task dispatch` has no minute for: in dispatch mode this entry never starts.",
    }));
  const enabled = new Set(input.enabledRefs);
  const warnings = mode.taskRows
    .filter(
      (row) => row.ownerBundlePath !== ownBundleDir && enabled.has(scheduledTaskSubject(row.invocation)?.subject ?? ""),
    )
    .map(
      (row) =>
        `Row ${JSON.stringify(installedRowNativeId(row))} runs ${scheduledTaskSubject(row.invocation)?.subject} from ${installedRowOwner(row)} and was left; \`akm task dispatch\` starts it too. Remove the row if it is this installation's.`,
    );

  const own = mode.taskRows.filter((row) => row.ownerBundlePath === ownBundleDir);
  const removals: SchedulerSyncOperation[] = own.map((row) =>
    Object.freeze({ kind: "remove" as const, id: row.id, nativeId: installedRowNativeId(row) }),
  );
  const current = mode.ownDispatchRow;
  const environment = dispatchRowEnvironment(input.installOptions.environment);
  const binding = current !== undefined && !input.rebind ? current.binding : input.installOptions.binding;
  const options: SchedulerInstallOptions = {
    ...(binding !== undefined ? { binding: [...binding] } : {}),
    ...(environment !== undefined ? { environment } : {}),
  };
  const expected = input.sched.expectedSignature?.(DISPATCH_BINDING, options);
  const kind =
    current === undefined ? "install" : expected === undefined || current.signature === expected ? undefined : "update";
  const write: SchedulerSyncOperation[] =
    kind === undefined
      ? []
      : [
          Object.freeze({
            kind,
            binding: DISPATCH_BINDING,
            options,
            ...(current?.signature !== undefined && kind === "update" ? { installedSignature: current.signature } : {}),
            ...(expected !== undefined ? { expectedSignature: expected } : {}),
          }),
        ];
  const id = DISPATCH_BINDING.id;
  const plan: SchedulerSyncPlan = {
    desired: [DISPATCH_BINDING],
    installed: kind === "install" ? [id] : [],
    updated: kind === "update" ? [id] : [],
    unchanged: kind === undefined ? [id] : [],
    removed: own.map((row) => row.id),
    operations: [...removals, ...write],
    failures: [],
  };
  return { plan, failures, warnings };
}

export interface AppliedOperations {
  /** Binding ids whose operation failed or was held. */
  readonly failed: ReadonlySet<string>;
  readonly failures: SchedulerSourceFailure[];
}

/**
 * Apply a plan's operations in order. With `guarded` (a plan that touches the dispatch row or is in dispatch mode),
 * every write after a failed removal is held: with both kinds of row installed, tasks would run twice.
 */
export async function applySchedulerOperations(
  sched: SchedulerBackend,
  operations: readonly SchedulerSyncOperation[],
  guarded: boolean,
): Promise<AppliedOperations> {
  const failed = new Set<string>();
  const failures: SchedulerSourceFailure[] = [];
  let removalFailed = false;
  for (const operation of operations) {
    if (operation.kind === "remove") {
      try {
        await sched.uninstall(operation.nativeId);
      } catch (cause) {
        removalFailed = true;
        failed.add(operation.id);
        failures.push({ path: operation.nativeId, reason: errorMessage(cause) });
      }
      continue;
    }
    const { binding } = operation;
    const failure = (reason: string) => {
      failed.add(binding.id);
      failures.push({ path: binding.source, ref: binding.logicalSource.ref, reason });
    };
    if (guarded && removalFailed) {
      failure("Not written: a removal before it failed, and with both rows installed tasks would run twice.");
      continue;
    }
    try {
      await sched.install(binding, operation.options);
    } catch (cause) {
      failure(errorMessage(cause));
    }
  }
  return { failed, failures };
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
