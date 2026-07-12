// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  MAX_CONFIG_FILE_BYTES,
  MAX_LOCAL_METADATA_BYTES,
  readTextFileWithLimit,
  writeFileAtomic,
} from "../core/common";
import {
  type AkmConfig,
  parseAndValidateConfigText,
  resetConfigCache,
  sanitizeConfigForWrite,
} from "../core/config/config";
import { backupExistingConfig, withConfigLock, writeConfigAtomic } from "../core/config/config-io";
import { ConfigError } from "../core/errors";
import { withMaintenanceStartBarrier } from "../core/maintenance-barrier";
import {
  assertNoArtifactReplacementBlockers,
  ensureMigrationBackupWithConfigLockHeld,
  fingerprintMigrationGeneration,
  getMigrationApplyJournalPath,
  getMigrationBackupDir,
  getMigrationBackupRoot,
  getMigrationRestoreJournalPath,
  inspectMigrationState,
  MIGRATION_BACKUP_VERSION,
  type MigrationArtifactState,
  type MigrationBackupManifest,
  type MigrationGenerationFingerprint,
  type MigrationState,
  recoverInterruptedRestoreWithLocksHeld,
  restoreMigrationBackupWithLocksHeld,
  sameMigrationGeneration,
  verifyMigrationBackup,
} from "../core/migration-backup";
import { getConfigPath, getStateDbPathInDataDir, getWorkflowDbPath } from "../core/paths";
import { runMigrations as runStateMigrations } from "../core/state/migrations";
import { openDatabase } from "../storage/database";
import { runMigrations as runWorkflowMigrations } from "../workflows/db";
import { EXIT_CODES } from "./shared";

const MANUAL_GUIDANCE =
  "Provide a complete operator-prepared 0.9 config with --config. AKM does not guess profile-to-engine mappings.";

export interface MigrationCommandOptions {
  preparedConfigPath?: string;
  dryRun?: boolean;
}

export interface MigrationTargetState {
  status: "current" | "missing" | "corrupt";
  source: "active" | "prepared" | "none";
  path?: string;
  detail?: string;
}

export interface MigrationPlan {
  status: "current" | "ready" | "blocked";
  artifacts: MigrationState;
  targetConfig: MigrationTargetState;
  blockers: string[];
  activeOperation?: { kind: "apply" | "restore"; phase: string; journalPath: string };
}

type ApplyPhase =
  | "prepared"
  | "state-applied"
  | "workflow-applied"
  | "config-applied"
  | "rollback-prepared"
  | "committed";

interface ApplyJournal {
  formatVersion: 2;
  version: typeof MIGRATION_BACKUP_VERSION;
  operationId: string;
  installationId: string;
  backupRunId: string;
  phase: ApplyPhase;
  backupPath: string;
  targetConfig: Record<string, unknown>;
  generation: MigrationGenerationFingerprint;
}

interface AdjacentGeneration {
  phase: "state-applied" | "workflow-applied" | "config-applied";
  complete: boolean;
  generation: MigrationGenerationFingerprint;
}

function isFileFingerprint(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    Object.keys(candidate).sort().join(",") === "byteSize,sha256" &&
    Number.isSafeInteger(candidate.byteSize) &&
    (candidate.byteSize as number) >= 0 &&
    typeof candidate.sha256 === "string" &&
    /^[a-f0-9]{64}$/.test(candidate.sha256)
  );
}

function isGenerationFingerprint(value: unknown): value is MigrationGenerationFingerprint {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const generation = value as Record<string, unknown>;
  if (Object.keys(generation).sort().join(",") !== "config,state,workflow") return false;
  for (const [name, expectedNullSidecars] of [
    ["config", true],
    ["state", false],
    ["workflow", false],
  ] as const) {
    const artifact = generation[name];
    if (typeof artifact !== "object" || artifact === null || Array.isArray(artifact)) return false;
    const files = artifact as Record<string, unknown>;
    if (Object.keys(files).sort().join(",") !== "main,shm,wal") return false;
    if (!isFileFingerprint(files.main) || !isFileFingerprint(files.wal) || !isFileFingerprint(files.shm)) return false;
    if (expectedNullSidecars && (files.wal !== null || files.shm !== null)) return false;
  }
  return true;
}

function sameArtifactFingerprint(
  left: MigrationGenerationFingerprint[keyof MigrationGenerationFingerprint],
  right: MigrationGenerationFingerprint[keyof MigrationGenerationFingerprint],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function hasGenerationMarker(dbPath: string, operationId: string, phase: string): boolean {
  if (!fs.existsSync(dbPath)) return false;
  const db = openDatabase(dbPath, { readonly: true });
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='akm_migration_generation'").get()) {
      return false;
    }
    const rows = db
      .prepare("SELECT operation_id, phase FROM akm_migration_generation WHERE singleton=1 LIMIT 2")
      .all() as Array<{ operation_id: string; phase: string }>;
    return rows.length === 1 && rows[0].operation_id === operationId && rows[0].phase === phase;
  } finally {
    db.close();
  }
}

function generationFromBackup(manifest: MigrationBackupManifest): MigrationGenerationFingerprint {
  const fingerprint = (name: "config.json" | "state.db" | "workflow.db") => {
    const artifact = manifest.artifacts[name];
    return artifact.present ? { byteSize: artifact.byteSize, sha256: artifact.sha256 as string } : null;
  };
  return {
    config: { main: fingerprint("config.json"), wal: null, shm: null },
    state: { main: fingerprint("state.db"), wal: null, shm: null },
    workflow: { main: fingerprint("workflow.db"), wal: null, shm: null },
  };
}

function detectAdjacentGeneration(
  journal: ApplyJournal,
  manifest: MigrationBackupManifest,
): { adjacent?: AdjacentGeneration; rollbackCompleted?: boolean } {
  if (journal.phase === "rollback-prepared") {
    return {
      rollbackCompleted: sameMigrationGeneration(fingerprintMigrationGeneration(), generationFromBackup(manifest)),
    };
  }
  const live = inspectMigrationState();
  const markerPresent =
    journal.phase === "prepared"
      ? hasGenerationMarker(getStateDbPathInDataDir(), journal.operationId, "state-applied")
      : journal.phase === "state-applied"
        ? hasGenerationMarker(getWorkflowDbPath(), journal.operationId, "workflow-applied")
        : false;
  const current = fingerprintMigrationGeneration();
  const unchanged = (...names: Array<keyof MigrationGenerationFingerprint>): boolean =>
    names.every((name) => sameArtifactFingerprint(journal.generation[name], current[name]));
  if (journal.phase === "prepared" && unchanged("config", "workflow") && markerPresent) {
    return {
      adjacent: {
        phase: "state-applied",
        complete: live.state.status === "current" || live.state.status === "missing",
        generation: current,
      },
    };
  }
  if (journal.phase === "state-applied" && unchanged("config", "state") && markerPresent) {
    return {
      adjacent: {
        phase: "workflow-applied",
        complete: live.workflow.status === "current" || live.workflow.status === "missing",
        generation: current,
      },
    };
  }
  const expectedTarget = `${JSON.stringify(journal.targetConfig, null, 2)}\n`;
  if (
    journal.phase === "workflow-applied" &&
    unchanged("state", "workflow") &&
    fs.existsSync(getConfigPath()) &&
    readTextFileWithLimit(getConfigPath(), MAX_CONFIG_FILE_BYTES, "Config file") === expectedTarget
  ) {
    return {
      adjacent: { phase: "config-applied", complete: true, generation: current },
    };
  }
  return {};
}

function assertRollbackTransitionAllowed(journal: ApplyJournal, current: MigrationGenerationFingerprint): void {
  const unchanged =
    journal.phase === "prepared"
      ? (["config", "workflow"] as const)
      : journal.phase === "state-applied"
        ? (["config", "state"] as const)
        : journal.phase === "workflow-applied"
          ? (["state", "workflow"] as const)
          : (["config", "state", "workflow"] as const);
  for (const name of unchanged) {
    if (!sameArtifactFingerprint(journal.generation[name], current[name])) {
      throw new ConfigError(
        `Refusing migration rollback because ${name} changed outside the journaled ${journal.phase} transition.`,
        "INVALID_CONFIG_FILE",
      );
    }
  }
}

function sameArtifactState(actual: MigrationArtifactState, expected: MigrationArtifactState): boolean {
  return (
    actual.status === expected.status &&
    JSON.stringify(actual.migrationIds ?? []) === JSON.stringify(expected.migrationIds ?? []) &&
    JSON.stringify(actual.migrationChecksums ?? []) === JSON.stringify(expected.migrationChecksums ?? [])
  );
}

function configMatchesBytes(expectedSize: number, expectedHash: string | null): boolean {
  const configPath = getConfigPath();
  if (!fs.existsSync(configPath) || expectedHash === null) return false;
  const text = readTextFileWithLimit(configPath, MAX_CONFIG_FILE_BYTES, "Config file");
  return (
    fs.statSync(configPath).size === expectedSize &&
    createHash("sha256").update(Buffer.from(text)).digest("hex") === expectedHash
  );
}

function validateApplyPhase(journal: ApplyJournal, manifest: MigrationBackupManifest): void {
  const live = inspectMigrationState();
  const stateOriginal = sameArtifactState(live.state, manifest.artifacts["state.db"]);
  const workflowOriginal = sameArtifactState(live.workflow, manifest.artifacts["workflow.db"]);
  const configOriginal = manifest.artifacts["config.json"].present
    ? configMatchesBytes(manifest.artifacts["config.json"].byteSize, manifest.artifacts["config.json"].sha256)
    : live.config.status === "missing";
  const stateApplied = manifest.artifacts["state.db"].present
    ? live.state.status === "current"
    : live.state.status === "missing";
  const workflowApplied = manifest.artifacts["workflow.db"].present
    ? live.workflow.status === "current"
    : live.workflow.status === "missing";
  const expectedTarget = `${JSON.stringify(journal.targetConfig, null, 2)}\n`;
  const configApplied =
    live.config.status === "current" &&
    fs.existsSync(getConfigPath()) &&
    readTextFileWithLimit(getConfigPath(), MAX_CONFIG_FILE_BYTES, "Config file") === expectedTarget;

  const reachable =
    journal.phase === "rollback-prepared"
      ? true
      : journal.phase === "prepared"
        ? configOriginal && workflowOriginal && (stateOriginal || stateApplied)
        : journal.phase === "state-applied"
          ? stateApplied && configOriginal && (workflowOriginal || workflowApplied)
          : journal.phase === "workflow-applied"
            ? stateApplied && workflowApplied && (configOriginal || configApplied)
            : stateApplied && workflowApplied && configApplied;
  if (!reachable) {
    throw new ConfigError(
      `Migration apply journal phase ${journal.phase} does not match a reachable config/state/workflow artifact state.`,
      "INVALID_CONFIG_FILE",
    );
  }
}

function readApplyJournal(): {
  journal?: ApplyJournal;
  config?: AkmConfig;
  adjacent?: AdjacentGeneration;
  rollbackCompleted?: boolean;
  error?: string;
} {
  const journalPath = getMigrationApplyJournalPath();
  if (!fs.existsSync(journalPath)) return {};
  let journal: ApplyJournal;
  try {
    const value = JSON.parse(
      readTextFileWithLimit(journalPath, MAX_LOCAL_METADATA_BYTES, "Migration apply journal"),
    ) as unknown;
    const phases: ApplyPhase[] = [
      "prepared",
      "state-applied",
      "workflow-applied",
      "config-applied",
      "rollback-prepared",
      "committed",
    ];
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      Object.keys(value).sort().join(",") !==
        [
          "backupPath",
          "backupRunId",
          "formatVersion",
          "generation",
          "installationId",
          "operationId",
          "phase",
          "targetConfig",
          "version",
        ]
          .sort()
          .join(",")
    ) {
      return { error: `Invalid migration apply journal at ${journalPath}.` };
    }
    const candidate = value as Partial<ApplyJournal>;
    if (
      candidate.formatVersion !== 2 ||
      candidate.version !== MIGRATION_BACKUP_VERSION ||
      typeof candidate.operationId !== "string" ||
      !/^[A-Za-z0-9._-]+$/.test(candidate.operationId) ||
      candidate.installationId !== path.basename(getMigrationBackupRoot()) ||
      !isGenerationFingerprint(candidate.generation) ||
      typeof candidate.backupRunId !== "string" ||
      !/^[A-Za-z0-9._-]+$/.test(candidate.backupRunId) ||
      candidate.backupPath !== getMigrationBackupDir(candidate.backupRunId) ||
      !candidate.targetConfig ||
      typeof candidate.targetConfig !== "object" ||
      Array.isArray(candidate.targetConfig) ||
      !phases.includes(candidate.phase as ApplyPhase)
    ) {
      return { error: `Invalid or foreign migration apply journal at ${journalPath}.` };
    }
    journal = candidate as ApplyJournal;
  } catch (error) {
    return {
      error: `Unreadable migration apply journal at ${journalPath}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  try {
    const backupStat = fs.lstatSync(journal.backupPath);
    if (
      backupStat.isSymbolicLink() ||
      !backupStat.isDirectory() ||
      fs.realpathSync(path.dirname(journal.backupPath)) !== fs.realpathSync(getMigrationBackupRoot())
    ) {
      throw new ConfigError(
        `Migration apply journal backup is not a canonical installation run directory.`,
        "INVALID_CONFIG_FILE",
      );
    }
    const config = parseAndValidateConfigText(JSON.stringify(journal.targetConfig), journalPath);
    const manifest = verifyMigrationBackup(journal.backupPath);
    if (manifest.runId !== journal.backupRunId || manifest.installationId !== journal.installationId) {
      throw new ConfigError(
        `Migration apply journal backup provenance does not match its manifest.`,
        "INVALID_CONFIG_FILE",
      );
    }
    validateApplyPhase(journal, manifest);
    if (!sameMigrationGeneration(fingerprintMigrationGeneration(), journal.generation)) {
      const adjacent = detectAdjacentGeneration(journal, manifest);
      if (adjacent.adjacent || adjacent.rollbackCompleted) return { journal, config, ...adjacent };
      throw new ConfigError(
        `Migration apply journal phase ${journal.phase} does not match the exact live artifact generation.`,
        "INVALID_CONFIG_FILE",
      );
    }
    return { journal, config };
  } catch (error) {
    return {
      journal,
      error: `Unreadable migration apply journal at ${journalPath}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function writeApplyJournal(journal: ApplyJournal): void {
  fs.mkdirSync(path.dirname(getMigrationApplyJournalPath()), { recursive: true, mode: 0o700 });
  const serialized = `${JSON.stringify(journal, null, 2)}\n`;
  const byteLength = Buffer.byteLength(serialized, "utf8");
  if (byteLength > MAX_LOCAL_METADATA_BYTES) {
    throw new ConfigError(
      `Migration apply journal would exceed the ${MAX_LOCAL_METADATA_BYTES}-byte metadata limit (${byteLength} bytes).`,
      "INVALID_CONFIG_FILE",
    );
  }
  writeFileAtomic(getMigrationApplyJournalPath(), serialized, 0o600);
}

function advanceApplyJournal(journal: ApplyJournal, phase: ApplyPhase): void {
  const order: ApplyPhase[] = ["prepared", "state-applied", "workflow-applied", "config-applied", "committed"];
  if (order.indexOf(phase) > order.indexOf(journal.phase)) journal.phase = phase;
  journal.generation = fingerprintMigrationGeneration();
  writeApplyJournal(journal);
}

function clearApplyJournal(): void {
  fs.rmSync(getMigrationApplyJournalPath(), { force: true });
  try {
    const fd = fs.openSync(path.dirname(getMigrationApplyJournalPath()), "r");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // Directory fsync is not available on every supported filesystem.
  }
}

function crashAfterForTests(phase: "state" | "workflow" | "config"): void {
  if (process.env.AKM_TEST_MIGRATION_CRASH_AFTER === phase) process.kill(process.pid, "SIGKILL");
}

function crashInMutationGapForTests(phase: "state" | "workflow" | "config" | "rollback"): void {
  if (process.env.AKM_TEST_MIGRATION_CRASH_GAP === phase) process.kill(process.pid, "SIGKILL");
}

function unsafeArtifact(name: string, state: MigrationArtifactState): string | undefined {
  if (!["newer", "inconsistent", "corrupt"].includes(state.status)) return undefined;
  return `${name} is ${state.status}${state.detail ? `: ${state.detail}` : ""}`;
}

function loadTargetConfig(
  preparedConfigPath: string | undefined,
  artifacts: MigrationState,
): {
  state: MigrationTargetState;
  config?: AkmConfig;
} {
  const targetPath = preparedConfigPath ?? (artifacts.config.status === "current" ? getConfigPath() : undefined);
  if (!targetPath) {
    return {
      state: { status: "missing", source: "none", detail: MANUAL_GUIDANCE },
    };
  }
  let text: string;
  try {
    text = readTextFileWithLimit(targetPath, MAX_CONFIG_FILE_BYTES, "Prepared migration config");
  } catch (error) {
    return {
      state: {
        status: "corrupt",
        source: preparedConfigPath ? "prepared" : "active",
        path: targetPath,
        detail: error instanceof Error ? error.message : String(error),
      },
    };
  }
  try {
    return {
      state: {
        status: "current",
        source: preparedConfigPath ? "prepared" : "active",
        path: targetPath,
      },
      config: parseAndValidateConfigText(text, targetPath),
    };
  } catch (error) {
    return {
      state: {
        status: "corrupt",
        source: preparedConfigPath ? "prepared" : "active",
        path: targetPath,
        detail: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

type ApplyJournalRead = ReturnType<typeof readApplyJournal>;

function buildMigrationPlan(preparedConfigPath: string | undefined, activeApply: ApplyJournalRead): MigrationPlan {
  const artifacts = inspectMigrationState();
  const restorePending = fs.existsSync(getMigrationRestoreJournalPath());
  const target = activeApply.journal
    ? {
        state: {
          status: activeApply.config ? ("current" as const) : ("corrupt" as const),
          source: "prepared" as const,
          path: getMigrationApplyJournalPath(),
          ...(!activeApply.config && activeApply.error ? { detail: activeApply.error } : {}),
        },
        config: activeApply.config,
      }
    : loadTargetConfig(preparedConfigPath, artifacts);
  const blockers = [
    unsafeArtifact("config.json", artifacts.config),
    unsafeArtifact("state.db", artifacts.state),
    unsafeArtifact("workflow.db", artifacts.workflow),
  ].filter((blocker): blocker is string => blocker !== undefined);
  if (target.state.status !== "current") blockers.push(target.state.detail ?? "A current target config is required.");
  if (activeApply.error && !activeApply.journal) blockers.push(activeApply.error);
  if (restorePending) blockers.push(`Restore recovery is pending at ${getMigrationRestoreJournalPath()}.`);

  const needsApply =
    !!activeApply.journal ||
    artifacts.config.status !== "current" ||
    artifacts.state.status === "old" ||
    artifacts.workflow.status === "old";
  return {
    status: blockers.length > 0 ? "blocked" : needsApply ? "ready" : "current",
    artifacts,
    targetConfig: target.state,
    blockers,
    ...(restorePending
      ? {
          activeOperation: {
            kind: "restore" as const,
            phase: "pending",
            journalPath: getMigrationRestoreJournalPath(),
          },
        }
      : activeApply.journal
        ? {
            activeOperation: {
              kind: "apply" as const,
              phase: activeApply.journal.phase,
              journalPath: getMigrationApplyJournalPath(),
            },
          }
        : {}),
  };
}

export function inspectMigrationPlan(preparedConfigPath?: string): MigrationPlan {
  return buildMigrationPlan(preparedConfigPath, readApplyJournal());
}

function printPlan(plan: MigrationPlan): void {
  console.log(JSON.stringify(plan));
  if (plan.status === "blocked") process.exitCode = EXIT_CODES.GENERAL;
}

export async function runMigrationStatus(options: MigrationCommandOptions = {}): Promise<void> {
  printPlan(inspectMigrationPlan(options.preparedConfigPath));
}

function requireEligiblePlan(
  preparedConfigPath?: string,
  active: ApplyJournalRead = readApplyJournal(),
): { plan: MigrationPlan; target: AkmConfig } {
  const plan = buildMigrationPlan(preparedConfigPath, active);
  const loaded = active.journal ? { config: active.config } : loadTargetConfig(preparedConfigPath, plan.artifacts);
  if (plan.status === "blocked" || !loaded.config) {
    throw new ConfigError(`Migration is blocked: ${plan.blockers.join("; ")}`, "INVALID_CONFIG_FILE");
  }
  return { plan, target: loaded.config };
}

export async function runMigrationApply(options: MigrationCommandOptions = {}): Promise<void> {
  if (options.dryRun) {
    printPlan(inspectMigrationPlan(options.preparedConfigPath));
    return;
  }

  const result = withConfigLock(() =>
    withMaintenanceStartBarrier(() => {
      assertNoArtifactReplacementBlockers();
      recoverInterruptedRestoreWithLocksHeld();
      const active = readApplyJournal();
      if (active.error) throw new ConfigError(active.error, "INVALID_CONFIG_FILE");
      if (active.rollbackCompleted && active.journal) {
        clearApplyJournal();
        resetConfigCache();
        throw new ConfigError(
          "Interrupted migration rollback was already committed; cleaned its apply journal. Rerun migrate apply with the prepared config.",
          "INVALID_CONFIG_FILE",
        );
      }
      if (active.journal?.phase === "rollback-prepared") {
        restoreMigrationBackupWithLocksHeld(active.journal.backupPath);
        crashInMutationGapForTests("rollback");
        clearApplyJournal();
        resetConfigCache();
        throw new ConfigError(
          "Interrupted migration rollback completed from its exact journaled generation; rerun migrate apply with the prepared config.",
          "INVALID_CONFIG_FILE",
        );
      }
      if (active.adjacent && active.journal) {
        active.journal.generation = active.adjacent.generation;
        if (active.adjacent.complete) active.journal.phase = active.adjacent.phase;
        writeApplyJournal(active.journal);
      }
      const { plan, target } = requireEligiblePlan(options.preparedConfigPath, active);
      if (plan.status === "current") return { plan };
      const backup = active.journal
        ? { path: active.journal.backupPath, manifest: verifyMigrationBackup(active.journal.backupPath) }
        : ensureMigrationBackupWithConfigLockHeld();
      const journal: ApplyJournal = active.journal ?? {
        formatVersion: 2,
        version: MIGRATION_BACKUP_VERSION,
        operationId: `${process.pid}-${randomUUID()}`,
        installationId: backup.manifest.installationId,
        backupRunId: backup.manifest.runId,
        phase: "prepared",
        backupPath: backup.path,
        targetConfig: sanitizeConfigForWrite(target),
        generation: fingerprintMigrationGeneration(),
      };
      if (!active.journal) writeApplyJournal(journal);
      try {
        const beforeState = inspectMigrationState();
        if (beforeState.state.status === "old") {
          const db = openDatabase(getStateDbPathInDataDir());
          try {
            runStateMigrations(db, {
              generationMarker: { operationId: journal.operationId, phase: "state-applied" },
            });
          } finally {
            db.close();
          }
        } else if (beforeState.state.status !== "current" && beforeState.state.status !== "missing") {
          throw new ConfigError(
            `Cannot resume state.db from ${beforeState.state.status} state.`,
            "INVALID_CONFIG_FILE",
          );
        }
        crashInMutationGapForTests("state");
        advanceApplyJournal(journal, "state-applied");
        crashAfterForTests("state");

        const beforeWorkflow = inspectMigrationState();
        if (beforeWorkflow.workflow.status === "old") {
          const db = openDatabase(getWorkflowDbPath());
          try {
            runWorkflowMigrations(db, {
              generationMarker: { operationId: journal.operationId, phase: "workflow-applied" },
            });
          } finally {
            db.close();
          }
        } else if (beforeWorkflow.workflow.status !== "current" && beforeWorkflow.workflow.status !== "missing") {
          throw new ConfigError(
            `Cannot resume workflow.db from ${beforeWorkflow.workflow.status} state.`,
            "INVALID_CONFIG_FILE",
          );
        }
        crashInMutationGapForTests("workflow");
        advanceApplyJournal(journal, "workflow-applied");
        crashAfterForTests("workflow");

        const migrated = inspectMigrationState();
        for (const [name, state] of [
          ["state.db", migrated.state],
          ["workflow.db", migrated.workflow],
        ] as const) {
          if (state.status !== "current" && state.status !== "missing") {
            throw new ConfigError(`Migration left ${name} in ${state.status} state.`, "INVALID_CONFIG_FILE");
          }
        }
        backupExistingConfig(getConfigPath());
        writeConfigAtomic(getConfigPath(), sanitizeConfigForWrite(target));
        resetConfigCache();
        crashInMutationGapForTests("config");
        advanceApplyJournal(journal, "config-applied");
        crashAfterForTests("config");

        const completedArtifacts = inspectMigrationState();
        if (
          completedArtifacts.config.status !== "current" ||
          ![completedArtifacts.state.status, completedArtifacts.workflow.status].every(
            (status) => status === "current" || status === "missing",
          )
        ) {
          throw new ConfigError(
            "Migration verification did not reach one current cross-artifact generation.",
            "INVALID_CONFIG_FILE",
          );
        }
        advanceApplyJournal(journal, "committed");
        clearApplyJournal();
        const completed = inspectMigrationPlan();
        return { plan: completed, backup };
      } catch (error) {
        try {
          const rollbackGeneration = fingerprintMigrationGeneration();
          assertRollbackTransitionAllowed(journal, rollbackGeneration);
          journal.phase = "rollback-prepared";
          journal.generation = rollbackGeneration;
          writeApplyJournal(journal);
          if (!sameMigrationGeneration(fingerprintMigrationGeneration(), journal.generation)) {
            throw new ConfigError(
              `Refusing migration rollback because live artifacts no longer match journal phase ${journal.phase}.`,
              "INVALID_CONFIG_FILE",
            );
          }
          restoreMigrationBackupWithLocksHeld(backup.path);
          crashInMutationGapForTests("rollback");
          clearApplyJournal();
          resetConfigCache();
        } catch (rollbackError) {
          throw new ConfigError(
            `Migration apply failed and rollback could not complete. Keep the current binary and recover from ${backup.path}. Apply error: ${error instanceof Error ? error.message : String(error)}. Rollback error: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
            "INVALID_CONFIG_FILE",
          );
        }
        throw new ConfigError(
          `Migration apply failed; config and databases were restored from ${backup.path}: ${error instanceof Error ? error.message : String(error)}`,
          "INVALID_CONFIG_FILE",
        );
      }
    }),
  );

  console.log(
    JSON.stringify({
      ...result.plan,
      status: result.plan.status === "blocked" ? "blocked" : "current",
      ...(result.backup ? { backupPath: result.backup.path, backupRunId: result.backup.manifest.runId } : {}),
    }),
  );
}

/** Backward-compatible config subcommand routed through the canonical coordinator. */
export async function runConfigMigrate(options: MigrationCommandOptions = {}): Promise<void> {
  if (options.dryRun || !options.preparedConfigPath) return runMigrationStatus(options);
  return runMigrationApply(options);
}
