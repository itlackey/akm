// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The whole migration, in order, as one plan: config.json in its current
 * shape, pending state.db migrations, task files to task source v4, assets'
 * retired `engine:` keys, refs in content that use the pre-#1432 spelling, stale bundle policy (`lint_skip`, the track-secrets marker), then the residue sweep. `akm-migrate status` / `apply [--dry-run]` print exactly
 * this; `akm migrate` and `akm upgrade` spawn that executable and re-emit
 * it. Every historical shape lives here or under `./migrate/`, so the CLI
 * proper only ever reads current schemas.
 */

import { resolveStashDir } from "../../src/core/common";
import {
  bundleKeyForContentRoot,
  type ConfigFileNormalization,
  isBundleEnabled,
  loadConfig,
  normalizeConfigFile,
  resetConfigCache,
} from "../../src/core/config/config";
import { ConfigError } from "../../src/core/errors";
import { describeRemainingWorkflowFiles, type WorkflowFilesOfBundle } from "../../src/commands/health/workflow-files";
import { getConfigPath } from "../../src/core/paths";
import { listPendingStateMigrations, upgradeHistoricalStateDatabase } from "../../src/core/state-db";
import { resolveSecretFromStore } from "../../src/sources/snapshot-fetchers/secret-seam";
import {
  type DeadResidueEntry,
  type DeadResidueRemoval,
  findDeadResidueEntries,
  removeDeadResidue,
} from "./migrate/dead-residue";
import {
  applyEngineKeysMigration,
  type EngineKeysMigrationStatus,
  inspectEngineKeysMigration,
} from "./engine-key-migrate";
import {
  applyContentRefsMigration,
  type ContentRefsMigrationStatus,
  inspectContentRefsMigration,
} from "./content-ref-migrate";
import {
  applyBundlePolicyMigration,
  type BundlePolicyMigrationStatus,
  inspectBundlePolicyMigration,
} from "./bundle-policy-migrate";
import {
  applyTaskFilesMigration,
  applyTaskFilesV5Migration,
  inspectTaskFilesMigration,
  inspectTaskFilesV5Migration,
  remainingWorkflowFiles,
  type TaskFilesMigrationStatus,
  type TaskFilesV5MigrationStatus,
} from "./task-migrate";

export type MigrationStatus = "current" | "ready" | "blocked";

/**
 * One migration step whose own action (or, for `apply`, its read-only
 * fallback too) threw. Recorded instead of letting `runMigration` itself
 * throw, so one poisoned step never costs the operator every other step's
 * result.
 */
export interface FailedMigrationStep {
  readonly step: string;
  readonly error: string;
}

export interface CombinedMigrationPlan {
  schemaVersion: 1;
  status: MigrationStatus;
  blockers: string[];
  /**
   * Steps whose own action (and, for `apply`, its read-only fallback too)
   * threw — absent when every step ran cleanly. Any entry here also
   * forces `status: "blocked"` and adds a matching line to `blockers`, so
   * `akm migrate status|apply` never exits INTERNAL(70) for a step's own
   * anomaly; it reports the plan with the step named and exits GENERAL(1)
   * like any other blocked plan. The section for a failed step is absent
   * from this plan rather than fabricated.
   */
  failedSteps?: readonly FailedMigrationStep[];
  /** Absent only when the step itself failed (`failedSteps` names it) — see {@link FailedMigrationStep}. */
  configFile?: ConfigFileNormalization;
  stateMigrations?: { pending: string[] } | { applied: string[]; safetyCopyPath?: string };
  taskFiles?: TaskFilesMigrationStatus["taskFiles"];
  /** Assets whose retired `engine:` key becomes `connection:` or `harness:`. */
  assetEngineKeys?: EngineKeysMigrationStatus["assetEngineKeys"];
  /** Refs in writable bundles' files that still use the pre-#1432 spelling (`knowledge/WORK/x`, now `WORK/x`). */
  assetContentRefs?: ContentRefsMigrationStatus["assetContentRefs"];
  /** Writable bundles' stale `lint_skip` frontmatter and track-secrets marker, with the config skip that replaces the marker. */
  bundlePolicy?: BundlePolicyMigrationStatus["bundlePolicy"];
  /** Present when task files were named for conversion to version 5: each file's outcome, and what to change by hand. */
  taskFilesV5?: TaskFilesV5MigrationStatus["files"];
  taskFilesV5BackupPath?: string;
  /** Present when workflow files remain in writable bundles: they are removed in 0.11 and convert only when named. */
  workflowFiles?: { bundles: WorkflowFilesOfBundle[]; message: string };
  /** Present after a real apply that rewrote at least one task file: the run's backup directory. */
  backupPath?: string;
  applied?: number;
  deadResidue?: { pending: DeadResidueEntry[] } | { removed: DeadResidueRemoval[] };
}

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
 * Run one migration step under its own catch: a step's own throw is
 * recorded in `failedSteps` instead of ending `runMigration` for every
 * OTHER step too. `apply` mode's mutation falling back to `probe` (the same
 * read-only inspector `status`/`--dry-run` already uses for this step) means
 * a step that fails to WRITE can usually still report what it would have
 * done; if even that throws, the section is simply absent and `failedSteps`
 * is the only record of it. A later step that genuinely needs an earlier
 * one that failed (e.g. reading config the rewrite above couldn't finish,
 * or the stash dir itself) throws too, on its own turn, and is caught here
 * exactly the same way — no separate dependency bookkeeping needed. One
 * helper covers sync and async actions alike, since every caller already
 * runs inside the async `runMigration`.
 */
// Exported (only) so tests/migrate/run-migrate-poisoned-step.test.ts can pin
// the isolation guarantee directly, against synthetic steps, instead of only
// through `runMigration`'s own real steps.
export async function migrationStep<T>(
  failedSteps: FailedMigrationStep[],
  step: string,
  action: () => T | Promise<T>,
  probe?: () => T | Promise<T>,
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

/**
 * The stash the residue sweep runs under. No configured bundle is an empty domain, not an error: migrate works
 * before `akm bundle create`. A stash a disabled bundle owns is left as written, as the task and asset steps leave it.
 */
function stashDirIfConfigured(): string | undefined {
  try {
    const stashDir = resolveStashDir();
    const config = loadConfig();
    const owner = bundleKeyForContentRoot(config, stashDir);
    return owner !== undefined && !isBundleEnabled(config, owner) ? undefined : stashDir;
  } catch (error) {
    if (error instanceof ConfigError && error.code === "STASH_DIR_NOT_FOUND") return undefined;
    throw error;
  }
}

/**
 * Run every migration step and return the combined plan. `apply: false` is
 * read-only (`status`, `apply --dry-run`); `apply: true` mutates, each step
 * under its own lock and backup.
 */
export async function runMigration(options: {
  apply: boolean;
  /** Task files to convert to task source v5; no other file is converted. */
  taskFiles?: readonly string[];
}): Promise<CombinedMigrationPlan> {
  const { apply } = options;
  const named = options.taskFiles ?? [];
  const configPath = getConfigPath();
  const failedSteps: FailedMigrationStep[] = [];

  // config.json: read through the same pipeline every load runs, written
  // back in its current shape. Never blocks the other steps.
  const configFile = await migrationStep(
    failedSteps,
    "configFile",
    () => normalizeConfigFile(configPath, { apply, resolveFromStore: resolveSecretFromStore }),
    apply
      ? () => normalizeConfigFile(configPath, { apply: false, resolveFromStore: resolveSecretFromStore })
      : undefined,
  );
  if (apply && configFile?.applied) resetConfigCache();
  const stateMigrations = await migrationStep(
    failedSteps,
    "stateMigrations",
    () => (apply ? applyStateMigrations() : { pending: listPendingStateMigrations() }),
    apply ? () => ({ pending: listPendingStateMigrations() }) : undefined,
  );
  const taskFiles = await migrationStep(
    failedSteps,
    "taskFiles",
    () => (apply ? applyTaskFilesMigration() : inspectTaskFilesMigration()),
    apply ? () => inspectTaskFilesMigration() : undefined,
  );
  // After the version 4 step, so a named version 2 or 3 file is converted from the file that step leaves.
  const taskFilesV5 =
    named.length === 0
      ? undefined
      : await migrationStep(
          failedSteps,
          "taskFilesV5",
          () => (apply ? applyTaskFilesV5Migration(named) : inspectTaskFilesV5Migration(named)),
          apply ? () => inspectTaskFilesV5Migration(named) : undefined,
        );
  // After the task files (a v2/v3 task file may still carry `engine:` until it is rewritten) and the
  // config (the names an engine had before its conversion come from that step's result).
  // A config the step could not read or write leaves the names unsettled, so the assets wait for a run that can.
  const configFailed = failedSteps.some((failure) => failure.step.startsWith("configFile"));
  const engineTargets = configFile?.engineTargets;
  const assetEngineKeys = configFailed
    ? undefined
    : await migrationStep(
        failedSteps,
        "assetEngineKeys",
        () => (apply ? applyEngineKeysMigration(engineTargets) : inspectEngineKeysMigration(engineTargets)),
        apply ? () => inspectEngineKeysMigration(engineTargets) : undefined,
      );
  // After the engine keys, so a file is read once in its final shape; the map of old spellings needs no state.
  const assetContentRefs = await migrationStep(
    failedSteps,
    "assetContentRefs",
    () => (apply ? applyContentRefsMigration() : inspectContentRefsMigration()),
    apply ? () => inspectContentRefsMigration() : undefined,
  );
  const bundlePolicy = await migrationStep(
    failedSteps,
    "bundlePolicy",
    () => (apply ? applyBundlePolicyMigration() : inspectBundlePolicyMigration()),
    apply ? () => inspectBundlePolicyMigration() : undefined,
  );
  // Resolving the stash dir runs as its own step: a config that fails to
  // load here is this step's own failure, not an uncaught throw out of
  // `runMigration`.
  const stashDir = await migrationStep(failedSteps, "stashDir", () => stashDirIfConfigured());
  const deadResidue = await migrationStep(
    failedSteps,
    "deadResidue",
    () => (apply ? { removed: removeDeadResidue(stashDir) } : { pending: findDeadResidueEntries(stashDir) }),
    apply ? () => ({ pending: findDeadResidueEntries(stashDir) }) : undefined,
  );

  // After the named conversions, so a workflow file removed since is not counted. Not a migration step of its own:
  // apply converts a workflow only when it is named, so what remains is reported, never changed.
  const workflowFiles = await migrationStep(failedSteps, "workflowFiles", () => {
    const bundles = remainingWorkflowFiles();
    return bundles.length > 0 ? { bundles, message: describeRemainingWorkflowFiles(bundles) } : undefined;
  });

  // A pending state migration reads as "ready" under status/--dry-run, so the
  // preview says what apply will do; after a real apply it has been applied.
  const stateStatus: MigrationStatus =
    stateMigrations && "pending" in stateMigrations && stateMigrations.pending.length > 0 ? "ready" : "current";
  const configFileStatus: MigrationStatus = configFile?.changed && !configFile.applied ? "ready" : "current";
  const engineKeysStatus: MigrationStatus = assetEngineKeys?.status ?? "current";
  const contentRefsStatus: MigrationStatus = assetContentRefs?.status ?? "current";
  const bundlePolicyStatus: MigrationStatus = bundlePolicy?.status ?? "current";
  return {
    schemaVersion: 1,
    status: statusWithFailedSteps(
      [stateStatus, configFileStatus, engineKeysStatus, contentRefsStatus, bundlePolicyStatus, taskFilesV5?.status ?? "current"].reduce(
        worstStatus,
        taskFiles?.status ?? "blocked",
      ),
      failedSteps,
    ),
    blockers: [...(taskFiles?.blockers ?? []), ...(taskFilesV5?.blockers ?? []), ...failedStepBlockers(failedSteps)],
    ...(failedSteps.length > 0 ? { failedSteps } : {}),
    ...(configFile !== undefined ? { configFile } : {}),
    ...(stateMigrations !== undefined ? { stateMigrations } : {}),
    ...(taskFiles !== undefined ? { taskFiles: taskFiles.taskFiles } : {}),
    ...(taskFilesV5 !== undefined ? { taskFilesV5: taskFilesV5.files } : {}),
    ...(taskFilesV5?.backupPath !== undefined ? { taskFilesV5BackupPath: taskFilesV5.backupPath } : {}),
    ...(workflowFiles !== undefined ? { workflowFiles } : {}),
    ...(taskFiles?.backupPath !== undefined ? { backupPath: taskFiles.backupPath } : {}),
    ...(taskFiles?.applied !== undefined ? { applied: taskFiles.applied } : {}),
    ...(assetEngineKeys !== undefined ? { assetEngineKeys: assetEngineKeys.assetEngineKeys } : {}),
    ...(assetContentRefs !== undefined ? { assetContentRefs: assetContentRefs.assetContentRefs } : {}),
    ...(bundlePolicy !== undefined ? { bundlePolicy: bundlePolicy.bundlePolicy } : {}),
    ...(deadResidue !== undefined ? { deadResidue } : {}),
  };
}

function applyStateMigrations(): { applied: string[]; safetyCopyPath?: string } {
  const result = upgradeHistoricalStateDatabase();
  return result.safetyCopyPath
    ? { applied: result.applied, safetyCopyPath: result.safetyCopyPath }
    : { applied: result.applied };
}
