// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The whole migration, in order, as one plan: legacy config lift, pending
 * state.db migrations, native scheduler activation capture, task v2 -> v3,
 * task v3 -> task source v4, then the stash-scoped residue sweeps.
 * `akm-migrate status` / `apply [--dry-run]`
 * print exactly this; `akm migrate` and `akm upgrade` spawn that executable
 * and re-emit it. Every historical shape lives here or under `./migrate/`,
 * so the CLI proper only ever reads current schemas.
 */

import { resolveStashDir } from "../../src/core/common";
import { bundleContentRoots, bundleKeyForContentRoot, loadConfig, resetConfigCache } from "../../src/core/config/config";
import { ConfigError } from "../../src/core/errors";
import type { DeferredTxn, QuarantinedTxn } from "../../src/core/fs-txn";
import { getConfigPath } from "../../src/core/paths";
import { listPendingStateMigrations, upgradeHistoricalStateDatabase } from "../../src/core/state-db";
import {
  applyConfigExtraParamsLift,
  type ConfigExtraParamsLiftPlan,
  type ConfigExtraParamsLiftResult,
  findConfigExtraParamsLift,
} from "./migrate/config-extra-params";
import {
  applyConfigLegacySourceShape,
  type ConfigLegacySourceShapePlan,
  type ConfigLegacySourceShapeResult,
  findConfigLegacySourceShape,
} from "./migrate/config-legacy-source-shape";
import {
  applyConfigRetiredKeys,
  type ConfigRetiredKeysPlan,
  type ConfigRetiredKeysResult,
  findConfigRetiredKeys,
} from "./migrate/config-retired-keys";
import {
  applyConfigSchedulerSourceIdMigration,
  type ConfigSchedulerSourceIdPlan,
  type ConfigSchedulerSourceIdResult,
  findConfigSchedulerSourceIdMigration,
} from "./migrate/config-scheduler-source-ids";
import { type DeadResidueEntry, type DeadResidueRemoval, findDeadResidueEntries, removeDeadResidue } from "./migrate/dead-residue";
import { findStaleTxnEntries, recoverStaleTxns, type StaleTxnEntry } from "./migrate/stale-txn";
import {
  applyWriterRelocation,
  findWriterRelocationEntries,
  type WriterRelocationApplyResult,
  type WriterRelocationPlan,
} from "./migrate/writer-relocation";
import {
  applySchedulerActivationMigration,
  inspectSchedulerActivationMigration,
  type SchedulerActivationMigrationPlan,
  type SchedulerActivationMigrationResult,
} from "./migrate/scheduler-activation";
import {
  applyTaskV3Migration,
  applyTaskV4Migration,
  inspectMigrationPlan,
  inspectTaskV4MigrationStatus,
  type MigrationPlan,
  type TaskV4MigrationStatus,
} from "./task-migrate";

export type MigrationStatus = "current" | "ready" | "blocked";

/**
 * One migration step whose own action (or, for `apply`, its read-only
 * fallback too) threw (C3). Recorded instead of letting `runMigration`
 * itself throw, so one poisoned step never costs the operator every other
 * step's result.
 */
export interface FailedMigrationStep {
  readonly step: string;
  readonly error: string;
}

export interface CombinedMigrationPlan {
  schemaVersion: 1;
  /**
   * Present and `"host-local"` for `apply --host-local`/`status --host-local`
   * (host-local reconciliation: `config.json`, `state.db`, scheduler grants,
   * `$DATA/txn` — never bundle content). Absent for the full plan, which
   * covers every migration step.
   */
  mode?: "host-local";
  status: MigrationStatus;
  blockers: string[];
  /**
   * Steps whose own action (and, for `apply`, its read-only fallback too)
   * threw (C3) — absent when every step ran cleanly. Any entry here also
   * forces `status: "blocked"` and adds a matching line to `blockers`, so
   * `akm migrate status|apply` never exits INTERNAL(70) for a step's own
   * anomaly; it reports the plan with the step named and exits GENERAL(1)
   * like any other blocked plan. The section for a failed step is absent
   * from this plan rather than fabricated.
   */
  failedSteps?: readonly FailedMigrationStep[];
  /** Absent only when the step itself failed (`failedSteps` names it) — see {@link FailedMigrationStep}. */
  configLegacySourceShape?: ConfigLegacySourceShapeResult | { pending: ConfigLegacySourceShapePlan };
  /** Absent only when the step itself failed (`failedSteps` names it) — see {@link FailedMigrationStep}. */
  configExtraParams?: ConfigExtraParamsLiftResult | { pending: ConfigExtraParamsLiftPlan };
  configSchedulerSourceIds?: ConfigSchedulerSourceIdResult | { pending: ConfigSchedulerSourceIdPlan };
  /** Absent only when the step itself failed (`failedSteps` names it) — see {@link FailedMigrationStep}. */
  configRetiredKeys?: ConfigRetiredKeysResult | { pending: ConfigRetiredKeysPlan };
  /** Absent only when the step itself failed (`failedSteps` names it) — see {@link FailedMigrationStep}. */
  stateMigrations?: { pending: string[] } | { applied: string[]; safetyCopyPath?: string };
  schedulerActivation?: SchedulerActivationMigrationPlan | SchedulerActivationMigrationResult;
  taskV3Migration?: MigrationPlan["taskV3Migration"];
  taskV4Migration?: TaskV4MigrationStatus["taskV4Migration"];
  backupPath?: string;
  applied?: number;
  taskV4BackupPath?: string;
  taskV4Applied?: number;
  deadResidue?: { pending: DeadResidueEntry[] } | { removed: DeadResidueRemoval[] };
  staleTxns?:
    | { pending: StaleTxnEntry[] }
    | { recovered: StaleTxnEntry[]; quarantined: QuarantinedTxn[]; deferred: DeferredTxn[] };
  // Keyed by bundle id (the default stash first, then every other
  // filesystem-backed bundle) — one filesystem bundle can trail live writer
  // residue as easily as another (itlackey/akm#890).
  writerRelocation?: { pending: Record<string, WriterRelocationPlan> } | { relocated: Record<string, WriterRelocationApplyResult> };
}

/** Shared by both `staleTxns` call sites so `migrationStepAsync`'s two branches infer one common type. */
type StaleTxnsStepResult =
  | { pending: StaleTxnEntry[] }
  | { recovered: StaleTxnEntry[]; quarantined: QuarantinedTxn[]; deferred: DeferredTxn[] };

function worstStatus(left: MigrationStatus, right: MigrationStatus): MigrationStatus {
  if (left === "blocked" || right === "blocked") return "blocked";
  if (left === "ready" || right === "ready") return "ready";
  return "current";
}

function migrationStepError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** One line per failed step, for folding into `blockers`. */
function failedStepBlockers(failedSteps: readonly FailedMigrationStep[]): string[] {
  return failedSteps.map((entry) => `migration step ${JSON.stringify(entry.step)} failed: ${entry.error}`);
}

/** `worstStatus`, but any recorded step failure always forces `"blocked"` too. */
function statusWithFailedSteps(status: MigrationStatus, failedSteps: readonly FailedMigrationStep[]): MigrationStatus {
  return failedSteps.length > 0 ? worstStatus(status, "blocked") : status;
}

/**
 * Run one migration step under its own catch (C3): a step's own throw is
 * recorded in `failedSteps` instead of ending `runMigration` for every
 * OTHER step too. `apply` mode's mutation falling back to `probe` (the same
 * read-only inspector `status`/`--dry-run` already uses for this step) means
 * a step that fails to WRITE can usually still report what it would have
 * done; if even that throws, the section is simply absent and `failedSteps`
 * is the only record of it. A later step that genuinely needs an earlier
 * one that failed (e.g. reading config the lift above couldn't finish
 * rewriting) throws too, on its own turn, and is caught here exactly the
 * same way — no separate dependency bookkeeping needed.
 */
// Exported (only) so tests/migrate/run-migrate-poisoned-step.test.ts can pin
// the isolation guarantee directly, against synthetic steps, instead of only
// through `runMigration`'s own real steps.
export function migrationStep<T>(
  failedSteps: FailedMigrationStep[],
  step: string,
  action: () => T,
  probe?: () => T,
): T | undefined {
  try {
    return action();
  } catch (cause) {
    failedSteps.push({ step, error: migrationStepError(cause) });
    if (!probe) return undefined;
    try {
      return probe();
    } catch (probeCause) {
      failedSteps.push({ step: `${step} (read-only fallback)`, error: migrationStepError(probeCause) });
      return undefined;
    }
  }
}

/** {@link migrationStep}, for an async step. */
export async function migrationStepAsync<T>(
  failedSteps: FailedMigrationStep[],
  step: string,
  action: () => Promise<T>,
  probe?: () => Promise<T>,
): Promise<T | undefined> {
  try {
    return await action();
  } catch (cause) {
    failedSteps.push({ step, error: migrationStepError(cause) });
    if (!probe) return undefined;
    try {
      return await probe();
    } catch (probeCause) {
      failedSteps.push({ step: `${step} (read-only fallback)`, error: migrationStepError(probeCause) });
      return undefined;
    }
  }
}

/** No configured bundle is an empty domain, not an error: migrate works before `akm bundle create`. */
function stashDirIfConfigured(): string | undefined {
  try {
    return resolveStashDir();
  } catch (error) {
    if (error instanceof ConfigError && error.code === "STASH_DIR_NOT_FOUND") return undefined;
    throw error;
  }
}

/**
 * Every LOCAL bundle directory the writer-relocation step must cover: the
 * default stash first (if one is configured or the platform default exists),
 * then every other bundle in the `bundles` map backed by a plain filesystem
 * `path` — each exactly once, even when two bundle entries resolve to the
 * same directory (itlackey/akm#890).
 *
 * A `git`/`website`/`npm` bundle source is a REMOTE fetched into `$CACHE`,
 * not a directory the user (or an old akm) could have written `.akm/*`
 * residue into directly — `bundleContentRoots` already only returns entries
 * carrying a `path`, so those bundles are skipped here with no network call
 * and no `ensureSourceCaches` (which would make one to materialize them).
 */
function writerRelocationTargets(defaultStashDir: string | undefined): { id: string; dir: string }[] {
  const config = loadConfig();
  const seen = new Set<string>();
  const targets: { id: string; dir: string }[] = [];
  if (defaultStashDir !== undefined) {
    targets.push({ id: bundleKeyForContentRoot(config, defaultStashDir) ?? "default", dir: defaultStashDir });
    seen.add(defaultStashDir);
  }
  for (const { id, contentRoot } of bundleContentRoots(config)) {
    if (seen.has(contentRoot)) continue;
    seen.add(contentRoot);
    targets.push({ id, dir: contentRoot });
  }
  return targets;
}

/**
 * `apply`'s writer-relocation pass, one filesystem bundle target at a time
 * (C3): one bundle's relocation throwing must not cost every OTHER bundle
 * its relocation too, so each target runs under its own
 * {@link migrationStep} rather than one `.map()` that aborts on the first
 * throw. A failed target is simply absent from the returned record;
 * `failedSteps` (keyed `writerRelocation:<id>`) is its only report.
 */
function relocateWriters(
  failedSteps: FailedMigrationStep[],
  targets: readonly { id: string; dir: string }[],
): Record<string, WriterRelocationApplyResult> {
  const relocated: Record<string, WriterRelocationApplyResult> = {};
  for (const { id, dir } of targets) {
    const result = migrationStep(failedSteps, `writerRelocation:${id}`, () => applyWriterRelocation(dir));
    if (result !== undefined) relocated[id] = result;
  }
  return relocated;
}

/** {@link relocateWriters}, for the read-only preview. */
function findWriterRelocations(
  failedSteps: FailedMigrationStep[],
  targets: readonly { id: string; dir: string }[],
): Record<string, WriterRelocationPlan> {
  const pending: Record<string, WriterRelocationPlan> = {};
  for (const { id, dir } of targets) {
    const result = migrationStep(failedSteps, `writerRelocation:${id}`, () => findWriterRelocationEntries(dir));
    if (result !== undefined) pending[id] = result;
  }
  return pending;
}

/**
 * Run every migration step and return the combined plan. `apply: false` is
 * read-only (`status`, `apply --dry-run`); `apply: true` mutates, each step
 * under its own lock and backup.
 */
export async function runMigration(options: { apply: boolean; hostLocal?: boolean }): Promise<CombinedMigrationPlan> {
  const { apply, hostLocal = false } = options;
  const mode: Pick<CombinedMigrationPlan, "mode"> = hostLocal ? { mode: "host-local" } : {};
  const configPath = getConfigPath();
  const failedSteps: FailedMigrationStep[] = [];

  // The legacy stashDir/sources[]/installed conversion runs first, before
  // anything that loads config, mirroring where `migrateLegacySourceShape`
  // sits in the in-memory pipeline (src/core/config/config.ts,
  // `runConfigFilePipeline`) — ahead of the extraParams lift and the
  // retired-keys strip. It never blocks: the read shim already tolerates
  // this shape in memory, so this is cleanup, not a precondition.
  const configLegacySourceShape = migrationStep(
    failedSteps,
    "configLegacySourceShape",
    () => (apply ? applyConfigLegacySourceShape(configPath) : { pending: findConfigLegacySourceShape(configPath) }),
    apply ? () => ({ pending: findConfigLegacySourceShape(configPath) }) : undefined,
  );
  if (apply && (configLegacySourceShape as ConfigLegacySourceShapeResult | undefined)?.applied) resetConfigCache();

  // The config lift runs BEFORE anything that loads config. A config still
  // carrying legacy extraParams keys fails `loadConfig` closed, and that
  // error names `akm migrate apply` as the remedy -- every later step loads
  // config, so applying the lift first is what makes the advice true.
  // Read-only modes cannot rewrite the file, so a pending lift is reported
  // as the blocker instead of letting the operator hit the same error again.
  const configExtraParams = migrationStep(
    failedSteps,
    "configExtraParams",
    () => (apply ? applyConfigExtraParamsLift(configPath) : { pending: findConfigExtraParamsLift(configPath) }),
    apply ? () => ({ pending: findConfigExtraParamsLift(configPath) }) : undefined,
  );
  if (apply && (configExtraParams as ConfigExtraParamsLiftResult | undefined)?.applied) resetConfigCache();
  const pendingLift = apply
    ? undefined
    : (configExtraParams as { pending: ConfigExtraParamsLiftPlan } | undefined)?.pending;

  // Retired config keys never block anything — the read shim already
  // tolerates them (src/core/config/retired-config-keys-shim.ts), so this
  // is cleanup, not a precondition later steps depend on. Computed once
  // here (it reads and writes only the raw file under its own lock and
  // never calls loadConfig) so both early "blocked" returns below and the
  // full plan can share the same value.
  const configRetiredKeys = migrationStep(
    failedSteps,
    "configRetiredKeys",
    () => (apply ? applyConfigRetiredKeys(configPath) : { pending: findConfigRetiredKeys(configPath) }),
    apply ? () => ({ pending: findConfigRetiredKeys(configPath) }) : undefined,
  );
  if (apply && (configRetiredKeys as ConfigRetiredKeysResult | undefined)?.applied) resetConfigCache();

  if (pendingLift && pendingLift.lifted.length > 0) {
    const stateMigrations = migrationStep(failedSteps, "stateMigrations", () => ({
      pending: listPendingStateMigrations(),
    }));
    return {
      schemaVersion: 1,
      ...mode,
      status: statusWithFailedSteps("blocked", failedSteps),
      blockers: [...pendingLift.lifted, ...failedStepBlockers(failedSteps)],
      ...(failedSteps.length > 0 ? { failedSteps } : {}),
      configLegacySourceShape,
      configExtraParams,
      configRetiredKeys,
      ...(stateMigrations !== undefined ? { stateMigrations } : {}),
    };
  }

  const configSchedulerSourceIds = migrationStep(
    failedSteps,
    "configSchedulerSourceIds",
    () =>
      apply
        ? applyConfigSchedulerSourceIdMigration(configPath)
        : { pending: findConfigSchedulerSourceIdMigration(configPath) },
    apply ? () => ({ pending: findConfigSchedulerSourceIdMigration(configPath) }) : undefined,
  );
  if (apply && (configSchedulerSourceIds as ConfigSchedulerSourceIdResult | undefined)?.applied) resetConfigCache();
  const pendingSchedulerBindings = apply
    ? undefined
    : (configSchedulerSourceIds as { pending: ConfigSchedulerSourceIdPlan } | undefined)?.pending;
  if (pendingSchedulerBindings && pendingSchedulerBindings.changes.length > 0) {
    const stateMigrations = migrationStep(failedSteps, "stateMigrations", () => ({
      pending: listPendingStateMigrations(),
    }));
    return {
      schemaVersion: 1,
      ...mode,
      status: statusWithFailedSteps("blocked", failedSteps),
      blockers: [
        ...pendingSchedulerBindings.changes.map(
          (change) =>
            `${change.kind === "bind" ? "bind" : "drop"} scheduler activation ${change.ref}` +
            (change.reason ? `: ${change.reason}` : ""),
        ),
        ...failedStepBlockers(failedSteps),
      ],
      ...(failedSteps.length > 0 ? { failedSteps } : {}),
      configLegacySourceShape,
      configExtraParams,
      configSchedulerSourceIds,
      configRetiredKeys,
      ...(stateMigrations !== undefined ? { stateMigrations } : {}),
    };
  }

  // State next, and before the task migrators: they open state.db themselves,
  // and an ordinary open refuses a historical-destructive migration by design.
  // This and `akm upgrade` (which runs this) are the only routes that admit
  // one, always with the verified safety copy.
  const stateMigrations = migrationStep(
    failedSteps,
    "stateMigrations",
    () => (apply ? applyStateMigrations() : { pending: listPendingStateMigrations() }),
    apply ? () => ({ pending: listPendingStateMigrations() }) : undefined,
  );

  // Capture activation from the host's proven native scheduler state before
  // task source migration removes the retired bundle-authored enabled flags.
  const schedulerActivation = await migrationStepAsync<SchedulerActivationMigrationPlan | SchedulerActivationMigrationResult>(
    failedSteps,
    "schedulerActivation",
    () => (apply ? applySchedulerActivationMigration() : inspectSchedulerActivationMigration()),
    apply ? () => inspectSchedulerActivationMigration() : undefined,
  );

  if (hostLocal) {
    // Host-local reconciliation touches config.json, state.db, scheduler
    // grants, and $DATA/txn only (policy: never bundle content) — no task
    // v2/v3/v4 rewrite, no dead-residue sweep, no writer relocation. Stale
    // transactions are still in scope: recovery only touches
    // $DATA/txn/<rootNs>, never reads or writes the bundle itself (see
    // ./migrate/stale-txn.ts).
    const stashDir = stashDirIfConfigured();
    const staleTxns =
      stashDir !== undefined
        ? await migrationStepAsync<StaleTxnsStepResult>(
            failedSteps,
            "staleTxns",
            () => (apply ? recoverStaleTxns(stashDir) : Promise.resolve({ pending: findStaleTxnEntries(stashDir) })),
            apply ? () => Promise.resolve({ pending: findStaleTxnEntries(stashDir) }) : undefined,
          )
        : undefined;

    const stateStatus: MigrationStatus =
      stateMigrations && "pending" in stateMigrations && stateMigrations.pending.length > 0 ? "ready" : "current";
    const schedulerStatus: MigrationStatus =
      schedulerActivation && "pending" in schedulerActivation && schedulerActivation.pending.length > 0
        ? "ready"
        : "current";
    const retiredKeysStatus: MigrationStatus =
      configRetiredKeys && "pending" in configRetiredKeys && configRetiredKeys.pending.removed.length > 0
        ? "ready"
        : "current";
    const legacySourceShapeStatus: MigrationStatus =
      configLegacySourceShape &&
      "pending" in configLegacySourceShape &&
      configLegacySourceShape.pending.converted.length > 0
        ? "ready"
        : "current";
    return {
      schemaVersion: 1,
      mode: "host-local",
      status: statusWithFailedSteps(
        worstStatus(worstStatus(stateStatus, schedulerStatus), worstStatus(retiredKeysStatus, legacySourceShapeStatus)),
        failedSteps,
      ),
      blockers: [...failedStepBlockers(failedSteps)],
      ...(failedSteps.length > 0 ? { failedSteps } : {}),
      configLegacySourceShape,
      configExtraParams,
      configSchedulerSourceIds,
      configRetiredKeys,
      ...(stateMigrations !== undefined ? { stateMigrations } : {}),
      ...(schedulerActivation !== undefined ? { schedulerActivation } : {}),
      ...(staleTxns !== undefined ? { staleTxns } : {}),
    };
  }

  const stashDir = stashDirIfConfigured();
  const taskV3 = migrationStep(
    failedSteps,
    "taskV3Migration",
    () => (apply ? applyTaskV3Migration() : inspectMigrationPlan()),
    apply ? () => inspectMigrationPlan() : undefined,
  );
  const taskV4 = migrationStep(
    failedSteps,
    "taskV4Migration",
    () => (apply ? applyTaskV4Migration() : inspectTaskV4MigrationStatus()),
    apply ? () => inspectTaskV4MigrationStatus() : undefined,
  );
  const stashSections: Pick<CombinedMigrationPlan, "deadResidue" | "staleTxns" | "writerRelocation"> = {};
  if (stashDir !== undefined) {
    const deadResidue = migrationStep(
      failedSteps,
      "deadResidue",
      () => (apply ? { removed: removeDeadResidue(stashDir) } : { pending: findDeadResidueEntries(stashDir) }),
      apply ? () => ({ pending: findDeadResidueEntries(stashDir) }) : undefined,
    );
    if (deadResidue !== undefined) stashSections.deadResidue = deadResidue;
    const staleTxns = await migrationStepAsync<StaleTxnsStepResult>(
      failedSteps,
      "staleTxns",
      () => (apply ? recoverStaleTxns(stashDir) : Promise.resolve({ pending: findStaleTxnEntries(stashDir) })),
      apply ? () => Promise.resolve({ pending: findStaleTxnEntries(stashDir) }) : undefined,
    );
    if (staleTxns !== undefined) stashSections.staleTxns = staleTxns;
  }
  const relocationTargets = writerRelocationTargets(stashDir);
  if (relocationTargets.length > 0) {
    stashSections.writerRelocation = apply
      ? { relocated: relocateWriters(failedSteps, relocationTargets) }
      : { pending: findWriterRelocations(failedSteps, relocationTargets) };
  }

  // A pending state migration reads as "ready" under status/--dry-run, so the
  // preview says what apply will do; after a real apply it has been applied.
  const stateStatus: MigrationStatus =
    stateMigrations && "pending" in stateMigrations && stateMigrations.pending.length > 0 ? "ready" : "current";
  const schedulerStatus: MigrationStatus =
    schedulerActivation && "pending" in schedulerActivation && schedulerActivation.pending.length > 0
      ? "ready"
      : "current";
  const retiredKeysStatus: MigrationStatus =
    configRetiredKeys && "pending" in configRetiredKeys && configRetiredKeys.pending.removed.length > 0
      ? "ready"
      : "current";
  const legacySourceShapeStatus: MigrationStatus =
    configLegacySourceShape &&
    "pending" in configLegacySourceShape &&
    configLegacySourceShape.pending.converted.length > 0
      ? "ready"
      : "current";
  return {
    schemaVersion: 1,
    status: statusWithFailedSteps(
      worstStatus(
        worstStatus(
          worstStatus(worstStatus(taskV3?.status ?? "blocked", taskV4?.status ?? "blocked"), stateStatus),
          schedulerStatus,
        ),
        worstStatus(retiredKeysStatus, legacySourceShapeStatus),
      ),
      failedSteps,
    ),
    blockers: [...(taskV3?.blockers ?? []), ...(taskV4?.blockers ?? []), ...failedStepBlockers(failedSteps)],
    ...(failedSteps.length > 0 ? { failedSteps } : {}),
    configLegacySourceShape,
    configExtraParams,
    configSchedulerSourceIds,
    configRetiredKeys,
    ...(stateMigrations !== undefined ? { stateMigrations } : {}),
    ...(schedulerActivation !== undefined ? { schedulerActivation } : {}),
    taskV3Migration: taskV3?.taskV3Migration,
    taskV4Migration: taskV4?.taskV4Migration,
    ...(taskV3?.backupPath !== undefined ? { backupPath: taskV3.backupPath } : {}),
    ...(taskV3?.applied !== undefined ? { applied: taskV3.applied } : {}),
    ...(taskV4?.backupPath !== undefined ? { taskV4BackupPath: taskV4.backupPath } : {}),
    ...(taskV4?.applied !== undefined ? { taskV4Applied: taskV4.applied } : {}),
    ...stashSections,
  };
}

function applyStateMigrations(): { applied: string[]; safetyCopyPath?: string } {
  const result = upgradeHistoricalStateDatabase();
  return result.safetyCopyPath
    ? { applied: result.applied, safetyCopyPath: result.safetyCopyPath }
    : { applied: result.applied };
}
