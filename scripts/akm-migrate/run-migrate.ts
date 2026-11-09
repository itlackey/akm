// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The whole migration, in order, as one plan: config.json in its current
 * shape, pending state.db migrations, assets' retired `engine:` keys, then refs
 * in content that use the pre-#1432 spelling. A state.db below the 0.9.32
 * floor stops the run before any step. `akm-migrate status` / `apply [--dry-run]` print exactly
 * this; `akm migrate` and `akm upgrade` spawn that executable and re-emit
 * it. Every historical shape lives here or under `./migrate/`, so the CLI
 * proper only ever reads current schemas.
 */

import { resetConfigCache } from "../../src/core/config/config";
import { getConfigPath } from "../../src/core/paths";
import { listPendingStateMigrations, stateDatabaseFloorBlocker, upgradeHistoricalStateDatabase } from "../../src/core/state-db";
import { resolveSecretFromStore } from "../../src/sources/snapshot-fetchers/secret-seam";
import { type ConfigFileNormalization, normalizeConfigFile } from "./config/normalize";
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
  /** Assets whose retired `engine:` key becomes `connection:` or `harness:`. */
  assetEngineKeys?: EngineKeysMigrationStatus["assetEngineKeys"];
  /** Refs in writable bundles' files that still use the pre-#1432 spelling (`knowledge/WORK/x`, now `WORK/x`). */
  assetContentRefs?: ContentRefsMigrationStatus["assetContentRefs"];
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
 * Run every migration step and return the combined plan. `apply: false` is
 * read-only (`status`, `apply --dry-run`); `apply: true` mutates, each step
 * under its own lock and backup.
 */
export async function runMigration(options: { apply: boolean }): Promise<CombinedMigrationPlan> {
  const { apply } = options;
  const configPath = getConfigPath();
  // A state.db below the floor is refused before any step runs, so nothing is half-migrated.
  const floorBlocker = stateDatabaseFloorBlocker();
  if (floorBlocker) return { schemaVersion: 1, status: "blocked", blockers: [floorBlocker] };
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
  // After the config (the names an engine had before its conversion come from that step's result).
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
  // A pending state migration reads as "ready" under status/--dry-run, so the
  // preview says what apply will do; after a real apply it has been applied.
  const stateStatus: MigrationStatus =
    stateMigrations && "pending" in stateMigrations && stateMigrations.pending.length > 0 ? "ready" : "current";
  const configFileStatus: MigrationStatus = configFile?.changed && !configFile.applied ? "ready" : "current";
  const engineKeysStatus: MigrationStatus = assetEngineKeys?.status ?? "current";
  const contentRefsStatus: MigrationStatus = assetContentRefs?.status ?? "current";
  return {
    schemaVersion: 1,
    status: statusWithFailedSteps(
      [stateStatus, configFileStatus, engineKeysStatus, contentRefsStatus].reduce(worstStatus, "current"),
      failedSteps,
    ),
    blockers: failedStepBlockers(failedSteps),
    ...(failedSteps.length > 0 ? { failedSteps } : {}),
    ...(configFile !== undefined ? { configFile } : {}),
    ...(stateMigrations !== undefined ? { stateMigrations } : {}),
    ...(assetEngineKeys !== undefined ? { assetEngineKeys: assetEngineKeys.assetEngineKeys } : {}),
    ...(assetContentRefs !== undefined ? { assetContentRefs: assetContentRefs.assetContentRefs } : {}),
  };
}

function applyStateMigrations(): { applied: string[] } {
  return { applied: upgradeHistoricalStateDatabase().applied };
}
