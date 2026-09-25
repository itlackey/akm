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
import type { QuarantinedTxn } from "../../src/core/fs-txn";
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
  configLegacySourceShape: ConfigLegacySourceShapeResult | { pending: ConfigLegacySourceShapePlan };
  configExtraParams: ConfigExtraParamsLiftResult | { pending: ConfigExtraParamsLiftPlan };
  configSchedulerSourceIds?: ConfigSchedulerSourceIdResult | { pending: ConfigSchedulerSourceIdPlan };
  configRetiredKeys: ConfigRetiredKeysResult | { pending: ConfigRetiredKeysPlan };
  stateMigrations: { pending: string[] } | { applied: string[]; safetyCopyPath?: string };
  schedulerActivation?: SchedulerActivationMigrationPlan | SchedulerActivationMigrationResult;
  taskV3Migration?: MigrationPlan["taskV3Migration"];
  taskV4Migration?: TaskV4MigrationStatus["taskV4Migration"];
  backupPath?: string;
  applied?: number;
  taskV4BackupPath?: string;
  taskV4Applied?: number;
  deadResidue?: { pending: DeadResidueEntry[] } | { removed: DeadResidueRemoval[] };
  staleTxns?: { pending: StaleTxnEntry[] } | { recovered: StaleTxnEntry[]; quarantined: QuarantinedTxn[] };
  // Keyed by bundle id (the default stash first, then every other
  // filesystem-backed bundle) — one filesystem bundle can trail live writer
  // residue as easily as another (itlackey/akm#890).
  writerRelocation?: { pending: Record<string, WriterRelocationPlan> } | { relocated: Record<string, WriterRelocationApplyResult> };
}

function worstStatus(left: MigrationStatus, right: MigrationStatus): MigrationStatus {
  if (left === "blocked" || right === "blocked") return "blocked";
  if (left === "ready" || right === "ready") return "ready";
  return "current";
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
 * Run every migration step and return the combined plan. `apply: false` is
 * read-only (`status`, `apply --dry-run`); `apply: true` mutates, each step
 * under its own lock and backup.
 */
export async function runMigration(options: { apply: boolean; hostLocal?: boolean }): Promise<CombinedMigrationPlan> {
  const { apply, hostLocal = false } = options;
  const mode: Pick<CombinedMigrationPlan, "mode"> = hostLocal ? { mode: "host-local" } : {};
  const configPath = getConfigPath();

  // The legacy stashDir/sources[]/installed conversion runs first, before
  // anything that loads config, mirroring where `migrateLegacySourceShape`
  // sits in the in-memory pipeline (src/core/config/config.ts,
  // `runConfigFilePipeline`) — ahead of the extraParams lift and the
  // retired-keys strip. It never blocks: the read shim already tolerates
  // this shape in memory, so this is cleanup, not a precondition.
  const configLegacySourceShape = apply
    ? applyConfigLegacySourceShape(configPath)
    : { pending: findConfigLegacySourceShape(configPath) };
  if (apply && (configLegacySourceShape as ConfigLegacySourceShapeResult).applied) resetConfigCache();

  // The config lift runs BEFORE anything that loads config. A config still
  // carrying legacy extraParams keys fails `loadConfig` closed, and that
  // error names `akm migrate apply` as the remedy -- every later step loads
  // config, so applying the lift first is what makes the advice true.
  // Read-only modes cannot rewrite the file, so a pending lift is reported
  // as the blocker instead of letting the operator hit the same error again.
  const configExtraParams = apply
    ? applyConfigExtraParamsLift(configPath)
    : { pending: findConfigExtraParamsLift(configPath) };
  if (apply && (configExtraParams as ConfigExtraParamsLiftResult).applied) resetConfigCache();
  const pendingLift = apply ? undefined : (configExtraParams as { pending: ConfigExtraParamsLiftPlan }).pending;

  // Retired config keys never block anything — the read shim already
  // tolerates them (src/core/config/retired-config-keys-shim.ts), so this
  // is cleanup, not a precondition later steps depend on. Computed once
  // here (it reads and writes only the raw file under its own lock and
  // never calls loadConfig) so both early "blocked" returns below and the
  // full plan can share the same value.
  const configRetiredKeys = apply ? applyConfigRetiredKeys(configPath) : { pending: findConfigRetiredKeys(configPath) };
  if (apply && (configRetiredKeys as ConfigRetiredKeysResult).applied) resetConfigCache();

  if (pendingLift && pendingLift.lifted.length > 0) {
    return {
      schemaVersion: 1,
      ...mode,
      status: "blocked",
      blockers: pendingLift.lifted,
      configLegacySourceShape,
      configExtraParams,
      configRetiredKeys,
      stateMigrations: { pending: listPendingStateMigrations() },
    };
  }

  const configSchedulerSourceIds = apply
    ? applyConfigSchedulerSourceIdMigration(configPath)
    : { pending: findConfigSchedulerSourceIdMigration(configPath) };
  if (apply && (configSchedulerSourceIds as ConfigSchedulerSourceIdResult).applied) resetConfigCache();
  const pendingSchedulerBindings = apply
    ? undefined
    : (configSchedulerSourceIds as { pending: ConfigSchedulerSourceIdPlan }).pending;
  if (pendingSchedulerBindings && pendingSchedulerBindings.changes.length > 0) {
    return {
      schemaVersion: 1,
      ...mode,
      status: "blocked",
      blockers: pendingSchedulerBindings.changes.map(
        (change) =>
          `${change.kind === "bind" ? "bind" : "drop"} scheduler activation ${change.ref}` +
          (change.reason ? `: ${change.reason}` : ""),
      ),
      configLegacySourceShape,
      configExtraParams,
      configSchedulerSourceIds,
      configRetiredKeys,
      stateMigrations: { pending: listPendingStateMigrations() },
    };
  }

  // State next, and before the task migrators: they open state.db themselves,
  // and an ordinary open refuses a historical-destructive migration by design.
  // This and `akm upgrade` (which runs this) are the only routes that admit
  // one, always with the verified safety copy.
  const stateMigrations = apply ? applyStateMigrations() : { pending: listPendingStateMigrations() };

  // Capture activation from the host's proven native scheduler state before
  // task source migration removes the retired bundle-authored enabled flags.
  const schedulerActivation = apply
    ? await applySchedulerActivationMigration()
    : await inspectSchedulerActivationMigration();

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
        ? apply
          ? await recoverStaleTxns(stashDir)
          : { pending: findStaleTxnEntries(stashDir) }
        : undefined;

    const stateStatus: MigrationStatus =
      "pending" in stateMigrations && stateMigrations.pending.length > 0 ? "ready" : "current";
    const schedulerStatus: MigrationStatus =
      "pending" in schedulerActivation && schedulerActivation.pending.length > 0 ? "ready" : "current";
    const retiredKeysStatus: MigrationStatus =
      "pending" in configRetiredKeys && configRetiredKeys.pending.removed.length > 0 ? "ready" : "current";
    const legacySourceShapeStatus: MigrationStatus =
      "pending" in configLegacySourceShape && configLegacySourceShape.pending.converted.length > 0
        ? "ready"
        : "current";
    return {
      schemaVersion: 1,
      mode: "host-local",
      status: worstStatus(
        worstStatus(stateStatus, schedulerStatus),
        worstStatus(retiredKeysStatus, legacySourceShapeStatus),
      ),
      blockers: [],
      configLegacySourceShape,
      configExtraParams,
      configSchedulerSourceIds,
      configRetiredKeys,
      stateMigrations,
      schedulerActivation,
      ...(staleTxns !== undefined ? { staleTxns } : {}),
    };
  }

  const stashDir = stashDirIfConfigured();
  const taskV3 = apply ? applyTaskV3Migration() : inspectMigrationPlan();
  const taskV4 = apply ? applyTaskV4Migration() : inspectTaskV4MigrationStatus();
  const stashSections: Pick<CombinedMigrationPlan, "deadResidue" | "staleTxns" | "writerRelocation"> = {};
  if (stashDir !== undefined) {
    stashSections.deadResidue = apply
      ? { removed: removeDeadResidue(stashDir) }
      : { pending: findDeadResidueEntries(stashDir) };
    stashSections.staleTxns = apply
      ? await recoverStaleTxns(stashDir)
      : { pending: findStaleTxnEntries(stashDir) };
  }
  const relocationTargets = writerRelocationTargets(stashDir);
  if (relocationTargets.length > 0) {
    stashSections.writerRelocation = apply
      ? { relocated: Object.fromEntries(relocationTargets.map(({ id, dir }) => [id, applyWriterRelocation(dir)])) }
      : { pending: Object.fromEntries(relocationTargets.map(({ id, dir }) => [id, findWriterRelocationEntries(dir)])) };
  }

  // A pending state migration reads as "ready" under status/--dry-run, so the
  // preview says what apply will do; after a real apply it has been applied.
  const stateStatus: MigrationStatus = "pending" in stateMigrations && stateMigrations.pending.length > 0 ? "ready" : "current";
  const schedulerStatus: MigrationStatus =
    "pending" in schedulerActivation && schedulerActivation.pending.length > 0 ? "ready" : "current";
  const retiredKeysStatus: MigrationStatus =
    "pending" in configRetiredKeys && configRetiredKeys.pending.removed.length > 0 ? "ready" : "current";
  const legacySourceShapeStatus: MigrationStatus =
    "pending" in configLegacySourceShape && configLegacySourceShape.pending.converted.length > 0 ? "ready" : "current";
  return {
    schemaVersion: 1,
    status: worstStatus(
      worstStatus(
        worstStatus(worstStatus(worstStatus(taskV3.status, taskV4.status), stateStatus), schedulerStatus),
        retiredKeysStatus,
      ),
      legacySourceShapeStatus,
    ),
    blockers: [...taskV3.blockers, ...taskV4.blockers],
    configLegacySourceShape,
    configExtraParams,
    configSchedulerSourceIds,
    configRetiredKeys,
    stateMigrations,
    schedulerActivation,
    taskV3Migration: taskV3.taskV3Migration,
    taskV4Migration: taskV4.taskV4Migration,
    ...(taskV3.backupPath !== undefined ? { backupPath: taskV3.backupPath } : {}),
    ...(taskV3.applied !== undefined ? { applied: taskV3.applied } : {}),
    ...(taskV4.backupPath !== undefined ? { taskV4BackupPath: taskV4.backupPath } : {}),
    ...(taskV4.applied !== undefined ? { taskV4Applied: taskV4.applied } : {}),
    ...stashSections,
  };
}

function applyStateMigrations(): { applied: string[]; safetyCopyPath?: string } {
  const result = upgradeHistoricalStateDatabase();
  return result.safetyCopyPath
    ? { applied: result.applied, safetyCopyPath: result.safetyCopyPath }
    : { applied: result.applied };
}
