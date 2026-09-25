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
import {
  bundleContentRoots,
  bundleKeyForContentRoot,
  type ConfigFileNormalization,
  loadConfig,
  normalizeConfigFile,
  resetConfigCache,
} from "../../src/core/config/config";
import { ConfigError } from "../../src/core/errors";
import { getConfigPath } from "../../src/core/paths";
import { listPendingStateMigrations, upgradeHistoricalStateDatabase } from "../../src/core/state-db";
import { type DeadResidueEntry, type DeadResidueRemoval, findDeadResidueEntries, removeDeadResidue } from "./migrate/dead-residue";
import {
  applyWriterRelocation,
  findWriterRelocationEntries,
  type WriterRelocationApplyResult,
  type WriterRelocationPlan,
} from "./migrate/writer-relocation";
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
  taskV3Migration?: MigrationPlan["taskV3Migration"];
  taskV4Migration?: TaskV4MigrationStatus["taskV4Migration"];
  backupPath?: string;
  applied?: number;
  taskV4BackupPath?: string;
  taskV4Applied?: number;
  deadResidue?: { pending: DeadResidueEntry[] } | { removed: DeadResidueRemoval[] };
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
 * one that failed (e.g. reading config the lift above couldn't finish
 * rewriting, or the stash dir itself) throws too, on its own turn, and is
 * caught here exactly the same way — no separate dependency bookkeeping
 * needed. One helper covers sync and async actions alike, since every
 * caller already runs inside the async `runMigration`.
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
 * `apply`'s writer-relocation pass, one filesystem bundle target at a time:
 * one bundle's relocation throwing must not cost every OTHER bundle its
 * relocation too, so each target runs under its own {@link migrationStep}
 * rather than one `.map()` that aborts on the first throw. A failed target
 * is simply absent from the returned record; `failedSteps` (keyed
 * `writerRelocation:<id>`) is its only report.
 */
async function relocateWriters(
  failedSteps: FailedMigrationStep[],
  targets: readonly { id: string; dir: string }[],
): Promise<Record<string, WriterRelocationApplyResult>> {
  const relocated: Record<string, WriterRelocationApplyResult> = {};
  for (const { id, dir } of targets) {
    const result = await migrationStep(failedSteps, `writerRelocation:${id}`, () => applyWriterRelocation(dir));
    if (result !== undefined) relocated[id] = result;
  }
  return relocated;
}

/** {@link relocateWriters}, for the read-only preview. */
async function findWriterRelocations(
  failedSteps: FailedMigrationStep[],
  targets: readonly { id: string; dir: string }[],
): Promise<Record<string, WriterRelocationPlan>> {
  const pending: Record<string, WriterRelocationPlan> = {};
  for (const { id, dir } of targets) {
    const result = await migrationStep(failedSteps, `writerRelocation:${id}`, () => findWriterRelocationEntries(dir));
    if (result !== undefined) pending[id] = result;
  }
  return pending;
}

/**
 * Run every migration step and return the combined plan. `apply: false` is
 * read-only (`status`, `apply --dry-run`); `apply: true` mutates, each step
 * under its own lock and backup.
 */
export async function runMigration(options: { apply: boolean }): Promise<CombinedMigrationPlan> {
  const { apply } = options;
  const configPath = getConfigPath();
  const failedSteps: FailedMigrationStep[] = [];

  // config.json: read through the same pipeline every load runs, written
  // back in its current shape. Never blocks the other steps.
  const configFile = await migrationStep(
    failedSteps,
    "configFile",
    () => normalizeConfigFile(configPath, { apply }),
    apply ? () => normalizeConfigFile(configPath, { apply: false }) : undefined,
  );
  if (apply && configFile?.applied) resetConfigCache();
  const stateMigrations = await migrationStep(
    failedSteps,
    "stateMigrations",
    () => (apply ? applyStateMigrations() : { pending: listPendingStateMigrations() }),
    apply ? () => ({ pending: listPendingStateMigrations() }) : undefined,
  );

  // Capture activation from the host's proven native scheduler state before
  // task source migration removes the retired bundle-authored enabled flags.

  // Resolving the stash dir runs as its own step: a config that fails to
  // load here is this step's own failure, not an uncaught throw out of
  // `runMigration`.
  const stashDir = await migrationStep(failedSteps, "stashDir", () => stashDirIfConfigured());
  const taskV3 = await migrationStep(
    failedSteps,
    "taskV3Migration",
    () => (apply ? applyTaskV3Migration() : inspectMigrationPlan()),
    apply ? () => inspectMigrationPlan() : undefined,
  );
  const taskV4 = await migrationStep(
    failedSteps,
    "taskV4Migration",
    () => (apply ? applyTaskV4Migration() : inspectTaskV4MigrationStatus()),
    apply ? () => inspectTaskV4MigrationStatus() : undefined,
  );
  const stashSections: Pick<CombinedMigrationPlan, "deadResidue" | "writerRelocation"> = {};
  const deadResidue = await migrationStep(
    failedSteps,
    "deadResidue",
    () => (apply ? { removed: removeDeadResidue(stashDir) } : { pending: findDeadResidueEntries(stashDir) }),
    apply ? () => ({ pending: findDeadResidueEntries(stashDir) }) : undefined,
  );
  if (deadResidue !== undefined) stashSections.deadResidue = deadResidue;
  // `writerRelocationTargets` calls `loadConfig()`, which throws for a
  // config the schema rejects (e.g. a non-string bundle `path`) — its own
  // step, so that throw is this step's failure rather than ending the run
  // before the sections above are returned.
  const relocationTargets =
    (await migrationStep(failedSteps, "writerRelocationTargets", () => writerRelocationTargets(stashDir))) ?? [];
  if (relocationTargets.length > 0) {
    stashSections.writerRelocation = apply
      ? { relocated: await relocateWriters(failedSteps, relocationTargets) }
      : { pending: await findWriterRelocations(failedSteps, relocationTargets) };
  }

  // A pending state migration reads as "ready" under status/--dry-run, so the
  // preview says what apply will do; after a real apply it has been applied.
  const stateStatus: MigrationStatus =
    stateMigrations && "pending" in stateMigrations && stateMigrations.pending.length > 0 ? "ready" : "current";
  const configFileStatus: MigrationStatus = configFile?.changed && !configFile.applied ? "ready" : "current";
  return {
    schemaVersion: 1,
    status: statusWithFailedSteps(
      worstStatus(
        worstStatus(worstStatus(taskV3?.status ?? "blocked", taskV4?.status ?? "blocked"), stateStatus),
        configFileStatus,
      ),
      failedSteps,
    ),
    blockers: [...(taskV3?.blockers ?? []), ...(taskV4?.blockers ?? []), ...failedStepBlockers(failedSteps)],
    ...(failedSteps.length > 0 ? { failedSteps } : {}),
    ...(configFile !== undefined ? { configFile } : {}),
    ...(stateMigrations !== undefined ? { stateMigrations } : {}),
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
