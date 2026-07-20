// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
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
import { backupExistingConfig, parseConfigText, withConfigLock, writeConfigAtomic } from "../core/config/config-io";
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
import { getConfigPath, getDbPath, getStateDbPathInDataDir } from "../core/paths";
import { runMigrations as runStateMigrations } from "../core/state/migrations";
import { migrateConfigSourcesToBundles } from "../migrate/legacy/config-source-migration";
import { type ContentMigrationReport, runContentMigration } from "../migrate/legacy/content-migration";
import { getLegacyWorkflowDbPath } from "../migrate/legacy/legacy-paths";
import {
  buildCutoverRefMap,
  type CutoverStashRoot,
  cutoverMergeCommitted,
  deleteWorkflowDb,
  quarantineIndexDb,
  runThreeDbCutover,
} from "../migrate/legacy/three-db-cutover";
import { FROZEN_WORKFLOW_MIGRATIONS } from "../migrate/legacy/workflow-migrations-bodies";
import { openDatabase } from "../storage/database";
import { runMigrations as runSqliteMigrations } from "../storage/engines/sqlite-migrations";
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
  // Chunk 8, WI-8.2: the three-DB merge data step. Inserted AFTER workflow-applied
  // (the merge needs workflow.db already rolled to 010) and BEFORE config-applied.
  | "cutover-applied"
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
        ? hasGenerationMarker(getLegacyWorkflowDbPath(), journal.operationId, "workflow-applied")
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
  // Chunk 8, WI-8.2: config is written in the phase AFTER the cutover, so a crash
  // in the config mutation gap leaves the journal at `cutover-applied` with the
  // config already on disk. state (merged) + workflow (deleted) are unchanged
  // since the cutover-applied advance — detect the config-applied adjacent.
  if (
    (journal.phase === "workflow-applied" || journal.phase === "cutover-applied") &&
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
        : journal.phase === "workflow-applied" || journal.phase === "cutover-applied"
          ? // config is applied in the phase after the cutover, so a rollback from
            // either only needs state + workflow unchanged (workflow=deleted is
            // recorded in the journal's own generation and compares equal).
            (["state", "workflow"] as const)
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
  // Chunk 8, WI-8.2: at/after the cutover, workflow.db is DELETED (its rows are
  // merged into state.db). A backed-up-present workflow.db that is now missing is
  // the intended post-cutover terminal state, not a failure.
  const workflowDeleted = manifest.artifacts["workflow.db"].present && live.workflow.status === "missing";
  const workflowFinal = workflowApplied || workflowDeleted;
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
            : journal.phase === "cutover-applied"
              ? stateApplied && workflowFinal && (configOriginal || configApplied)
              : // config-applied / committed
                stateApplied && workflowFinal && configApplied;
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
      "cutover-applied",
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
  const order: ApplyPhase[] = [
    "prepared",
    "state-applied",
    "workflow-applied",
    "cutover-applied",
    "config-applied",
    "committed",
  ];
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

function crashAfterForTests(phase: "state" | "workflow" | "cutover" | "config"): void {
  if (process.env.AKM_TEST_MIGRATION_CRASH_AFTER === phase) process.kill(process.pid, "SIGKILL");
}

function crashInMutationGapForTests(phase: "state" | "workflow" | "cutover" | "config" | "rollback"): void {
  if (process.env.AKM_TEST_MIGRATION_CRASH_GAP === phase) process.kill(process.pid, "SIGKILL");
}

/** Expand a leading `~` against the home directory (config stashDir/source paths may use it). */
function expandTilde(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * Best-effort stash roots for the cutover ref map's origin aliases, the
 * source-(b) legacy walk, AND the WI-8.5d content migration's `.stash.json`
 * fold + D-R6 rename walk. Derived from the TARGET config, which by this point in
 * the apply has already been normalized to the 0.9 `bundles` shape by
 * {@link parseMigrationTargetConfig}: each path-bearing bundle is a root, the
 * `defaultBundle` is the primary, and a bundle's `registryId` (or its key)
 * supplies the origin alias. The pre-cutover `stashDir`/`sources` shape is still
 * honored as a fallback for a transitional config that reaches here un-migrated.
 * Source (a) (the index `item_ref` join) is authoritative, so an unresolved root
 * only costs a few origin aliases.
 */
function cutoverStashRootsFromConfig(config: AkmConfig): CutoverStashRoot[] {
  const roots: CutoverStashRoot[] = [];
  try {
    const bundles = config.bundles;
    if (bundles && typeof bundles === "object") {
      for (const [id, entry] of Object.entries(bundles)) {
        const bundlePath = (entry as { path?: string }).path;
        if (typeof bundlePath !== "string" || bundlePath.length === 0) continue; // only filesystem bundles
        const registryId = (entry as { registryId?: string }).registryId ?? id;
        roots.push({
          path: path.resolve(expandTilde(bundlePath)),
          registryId,
          primary: config.defaultBundle === id,
        });
      }
      return roots;
    }
    if (typeof config.stashDir === "string" && config.stashDir.length > 0) {
      roots.push({ path: path.resolve(expandTilde(config.stashDir)), primary: true });
    }
    for (const source of config.sources ?? []) {
      const type = (source as { type?: string }).type;
      const sourcePath = (source as { path?: string }).path;
      const name = (source as { name?: string }).name;
      if ((type === "filesystem" || type === undefined) && typeof sourcePath === "string" && sourcePath.length > 0) {
        roots.push({ path: path.resolve(expandTilde(sourcePath)), registryId: name });
      }
    }
  } catch {
    // Best-effort — see the doc comment.
  }
  return roots;
}

/**
 * Roll a pre-cutover workflow.db forward to its final ledger (010) using the
 * FROZEN migration bodies (`src/migrate/legacy/workflow-migrations-bodies.ts`)
 * through the shared engine — never the live `WORKFLOW_MIGRATIONS` array
 * (`src/workflows/db.ts` is deleted in WI-8.3). The roll materialises every
 * migration-added column + DEFAULT so the subsequent state.db merge carries
 * faithful data.
 *
 * Pre-versioning (0.7-era) workflow.dbs — rows present but NO `schema_migrations`
 * ledger — are OUT of the migrator FROM-state (the rc-train fixtures pin a
 * versioned ledger). We FAIL CLOSED with a clear message rather than
 * bootstrapping (the old `bootstrapPreVersioningDb` back-fill is retired).
 */
function runFrozenWorkflowRoll(operationId: string): void {
  const workflowPath = getLegacyWorkflowDbPath();
  const db = openDatabase(workflowPath);
  try {
    const hasRuns = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='workflow_runs'").get();
    const hasLedger = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get();
    if (hasRuns && !hasLedger) {
      throw new ConfigError(
        `Refusing to migrate a pre-versioning workflow.db at ${workflowPath} (no schema_migrations ledger). ` +
          "Pre-0.8 workflow databases are not a supported migrator source; upgrade through a 0.8.x release first.",
        "INVALID_CONFIG_FILE",
      );
    }
    // Roll the pending frozen migrations ONLY — never the base-schema DDL. Any
    // real pre-cutover workflow.db already carries the base schema (its runtime
    // opener created it); running the baseline CREATE INDEX here would fail on a
    // pre-existing-but-narrower table. Matches the WI-8.2 workflow-applied path
    // (openDatabase + runSqliteMigrations, no pragmas/base-schema), preserving
    // the crash-recovery generation-fingerprint invariants that flow pins.
    runSqliteMigrations(db, FROZEN_WORKFLOW_MIGRATIONS, {
      generationMarker: { operationId, phase: "workflow-applied" },
    });
  } finally {
    db.close();
  }
}

/**
 * The `cutover-applied` phase (Chunk 8, WI-8.2). Builds + persists the
 * old-ref → item_ref map, runs the fail-closed three-DB merge/re-key
 * transaction, then the idempotent index-quarantine / workflow.db-unlink
 * boundary ops. A committed merge marker (from an interrupted-then-resumed
 * apply) short-circuits the merge so it runs exactly once.
 */
function runCutoverStep(journal: ApplyJournal, target: AkmConfig): void {
  const statePath = getStateDbPathInDataDir();
  const workflowPath = getLegacyWorkflowDbPath();
  const indexPath = getDbPath();

  if (!cutoverMergeCommitted(statePath)) {
    const mapPath = path.join(
      path.dirname(getMigrationApplyJournalPath()),
      `cutover-refmap-${journal.operationId}.json`,
    );
    const refMap = buildCutoverRefMap({
      oldIndexDbPath: indexPath,
      stashRoots: cutoverStashRootsFromConfig(target),
      mapOutputPath: mapPath,
    });
    // Fail-closed: an integrity failure (unparseable ref / row-count mismatch)
    // throws a CutoverIntegrityError, which the outer catch converts to a
    // restore-from-backup. The state txn is atomic — a throw rolls it back, so
    // state.db + workflow.db are unchanged going into the rollback.
    runThreeDbCutover({ refMap, operationId: journal.operationId, statePath, workflowPath, oldIndexPath: indexPath });
  }

  // Boundary ops run AFTER the committed state txn, OUTSIDE the fail-closed gate
  // (cutover-design.md §2 step 5/6). Idempotent + best-effort — they log and
  // return, never throw, so a rename/unlink hiccup never rolls back the merge.
  quarantineIndexDb(journal.operationId, indexPath);
  deleteWorkflowDb(workflowPath);

  // WI-8.5d: the content migration (`.stash.json` fold + delete, D-R6 reserved-
  // filename conformance) is an ADDITIVE filesystem step of the same phase. It
  // also runs AFTER the committed state txn, is best-effort (a throw is swallowed
  // + logged, never aborting a committed cutover), and idempotent (a resumed
  // apply finds no sidecars and no mis-named concepts, so it re-runs to a no-op).
  runContentMigrationStep(journal, target);
}

/**
 * Persist location for the content-migration report — next to the ApplyJournal
 * (alongside the cutover ref map). Survives `clearApplyJournal` (which removes
 * only the journal file), so the operator + the WI-8.5d test can read the D-R6
 * rename list after a committed apply.
 */
function contentMigrationReportPath(): string {
  return path.join(path.dirname(getMigrationApplyJournalPath()), "content-migration-report.json");
}

/** Best-effort content migration + report persistence (see {@link runCutoverStep}). */
function runContentMigrationStep(journal: ApplyJournal, target: AkmConfig): void {
  try {
    const roots = cutoverStashRootsFromConfig(target).map((r) => r.path);
    const report = runContentMigration(roots);
    persistContentMigrationReport(report);
    if (report.sidecarsFolded > 0 || report.reservedRenames.length > 0) {
      console.log(
        JSON.stringify({
          event: "content-migration",
          operationId: journal.operationId,
          ...report,
        }),
      );
    }
  } catch (error) {
    console.error(
      `[akm] content migration skipped (${error instanceof Error ? error.message : String(error)}); the committed cutover is unaffected.`,
    );
  }
}

function persistContentMigrationReport(report: ContentMigrationReport): void {
  try {
    const reportPath = contentMigrationReportPath();
    fs.mkdirSync(path.dirname(reportPath), { recursive: true, mode: 0o700 });
    writeFileAtomic(reportPath, `${JSON.stringify(report, null, 2)}\n`, 0o600);
  } catch {
    // The report is auditing-only; a persistence failure never affects the cutover.
  }
}

function unsafeArtifact(name: string, state: MigrationArtifactState): string | undefined {
  if (!["newer", "inconsistent", "corrupt"].includes(state.status)) return undefined;
  return `${name} is ${state.status}${state.detail ? `: ${state.detail}` : ""}`;
}

/**
 * Parse + validate a migration TARGET config, applying the Chunk-8 config-shape
 * migration (`stashDir`/`sources[]`/`installed[]` → `bundles`/`defaultBundle`)
 * as a pre-validation transform. This is why a target still carrying the
 * pre-cutover source shape loads (and reports "current" in `migrate status`)
 * even though the runtime loader now rejects that shape once `bundles` exists:
 * the migrator normalizes it FIRST, then the strict schema gates the result.
 *
 * The transform is idempotent, so an already-migrated prepared config, or the
 * new-shape config re-parsed from the apply journal, passes through untouched.
 */
function parseMigrationTargetConfig(text: string, sourcePath?: string): AkmConfig {
  const raw = parseConfigText(text, sourcePath);
  const migrated = migrateConfigSourcesToBundles(raw);
  // Re-serialize the normalized object through the canonical validator so the
  // version check, schema validation, and defaults merge stay in one place.
  return parseAndValidateConfigText(JSON.stringify(migrated), sourcePath);
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
      config: parseMigrationTargetConfig(text, targetPath),
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
            // Chunk 8, WI-8.2: collapse state.db to a SINGLE FILE (DELETE journal)
            // for the rest of the apply. A WAL-mode state.db carries `-wal`/`-shm`
            // sidecars that the migration generation fingerprint tracks; a later
            // read-only inspect (or a rolled-back cutover transaction) mutates
            // them, which would trip the "state changed outside the journaled
            // transition" rollback guard and REFUSE the fail-closed restore. In
            // single-file mode a rolled-back transaction leaves state.db
            // byte-identical, so the cutover's fail-closed rollback works. The
            // runtime restores WAL on its next openStateDatabase.
            try {
              db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
              db.exec("PRAGMA journal_mode = DELETE");
            } catch {
              // Already single-file / nothing to checkpoint.
            }
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

        // Chunk 8, WI-8.3: the pre-cutover workflow.db is rolled to its final
        // ledger (010) so every migration-added column + default is materialised
        // faithfully BEFORE the merge. The runtime no longer opens workflow.db
        // (src/workflows/db.ts is deleted); the roll runs the FROZEN migration
        // bodies (src/migrate/legacy/) through the shared engine, never the live
        // array. Its generation marker (phase "workflow-applied") authenticates
        // the crash-adjacency detection exactly as before, so all resume paths
        // and their tests are unchanged. Pre-versioning (0.7-era) workflow.dbs
        // are OUT of the migrator FROM-state — runFrozenWorkflowRoll fails closed
        // with a clear message instead of bootstrapping.
        const beforeWorkflow = inspectMigrationState();
        if (beforeWorkflow.workflow.status === "old") {
          runFrozenWorkflowRoll(journal.operationId);
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

        // Chunk 8, WI-8.2: the three-DB merge data step. workflow.db is now at 010
        // and state.db at 020 (its cutover DDL applied by state-applied), so the
        // merge target tables exist and the source is healthy. The fail-closed
        // parts (ref-map build + the ATTACH merge/re-key transaction) run inside
        // this try — an integrity failure rolls back to restore. The idempotent
        // boundary ops (index quarantine, workflow.db unlink) run AFTER the
        // committed state txn and never throw.
        runCutoverStep(journal, target);
        crashInMutationGapForTests("cutover");
        advanceApplyJournal(journal, "cutover-applied");
        crashAfterForTests("cutover");

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
