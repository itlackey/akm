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
import {
  backupExistingConfig,
  parseConfigText,
  readConfigText,
  withConfigLock,
  writeConfigAtomic,
} from "../core/config/config-io";
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
  type MigrationInspectionPaths,
  type MigrationState,
  recoverInterruptedRestoreWithLocksHeld,
  restoreMigrationBackupWithLocksHeld,
  sameMigrationGeneration,
  verifyMigrationBackup,
} from "../core/migration-backup";
import { getConfigPath, getDbPath, getStateDbPathInDataDir } from "../core/paths";
import { runMigrations as runStateMigrations } from "../core/state/migrations";
import { mergeLockEntriesSync } from "../integrations/lockfile";
import { migrateConfigSourcesToBundles, migratedLockEntries } from "../migrate/legacy/config-source-migration";
import { type ContentMigrationReport, runContentMigration } from "../migrate/legacy/content-migration";
import { getLegacyWorkflowDbPath } from "../migrate/legacy/legacy-paths";
import { importLegacyProposalsIntoState } from "../migrate/legacy/proposal-fs-import";
import { applyTaskTargetRefMigration, planTaskTargetRefMigration } from "../migrate/legacy/task-target-ref-migration";
import {
  buildCutoverRefMap,
  type CutoverStashRoot,
  cutoverMergeCommitted,
  deleteWorkflowDb,
  loadCutoverRefMap,
  migratePilotTreatmentFiles,
  quarantineIndexDb,
  runThreeDbCutover,
} from "../migrate/legacy/three-db-cutover";
import { FROZEN_WORKFLOW_MIGRATIONS } from "../migrate/legacy/workflow-migrations-bodies";
import { requestGc } from "../runtime";
import { type Database, openDatabaseFinalizing } from "../storage/database";
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
  | "state-converting"
  | "state-collapsing"
  | "state-applied"
  | "workflow-applied"
  // Chunk 8, WI-8.2: the three-DB merge data step. Inserted AFTER workflow-applied
  // (the merge needs workflow.db already rolled to 010) and BEFORE config-applied.
  | "cutover-applied"
  | "config-applied"
  | "tasks-prepared"
  | "tasks-applied"
  | "pilot-prepared"
  | "pilot-applied"
  | "rollback-prepared"
  | "committed";

const APPLY_PHASE_ORDER: ApplyPhase[] = [
  "prepared",
  "state-converting",
  "state-collapsing",
  "state-applied",
  "workflow-applied",
  "cutover-applied",
  "config-applied",
  "tasks-prepared",
  "tasks-applied",
  "pilot-prepared",
  "pilot-applied",
  "committed",
];

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

interface ApplyJournalMetadata {
  journal?: ApplyJournal;
  config?: AkmConfig;
  manifest?: MigrationBackupManifest;
  error?: string;
}

interface AdjacentGeneration {
  phase:
    | "state-converting"
    | "state-collapsing"
    | "state-applied"
    | "workflow-applied"
    | "cutover-applied"
    | "config-applied";
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

/**
 * Collapse state.db to a SINGLE FILE (DELETE journal) for the rest of the
 * apply. A WAL-mode state.db carries `-wal`/`-shm` sidecars that the migration
 * generation fingerprint tracks; a later read-only inspect (or a rolled-back
 * cutover transaction) mutates them, which would trip the "state changed
 * outside the journaled transition" rollback guard and REFUSE the fail-closed
 * restore. In single-file mode a rolled-back transaction leaves state.db
 * byte-identical, so the cutover's fail-closed rollback works. The runtime
 * restores WAL on its next openStateDatabase.
 *
 * The resulting journal_mode is AUTHORITATIVE, not best-effort (issue #720):
 * if state.db could not leave WAL mode — another PROCESS holds it open
 * (same-process zombie closes are prevented by openDatabaseFinalizing's
 * finalize-on-close guard) — the later cutover's rolled-back transaction
 * would mutate `-wal` and the restore would be silently refused. Fail EARLY
 * instead: journal.phase is still "state-converting" at the call site, so the
 * outer catch restores config+state+workflow from the backup with a clear
 * retry message.
 */
function collapseStateDbToSingleFile(db: ReturnType<typeof openDatabaseFinalizing>): void {
  const attempt = (): string => {
    try {
      const checkpoint = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy?: number } | undefined;
      if (checkpoint?.busy === 0) crashInMutationGapForTests("state-checkpoint");
      db.exec("PRAGMA journal_mode = DELETE");
    } catch {
      // Already single-file / nothing to checkpoint, or blocked — the
      // read-back below is the authoritative signal either way.
    }
    return String(
      (db.prepare("PRAGMA journal_mode").get() as { journal_mode?: string } | undefined)?.journal_mode ?? "",
    ).toLowerCase();
  };
  let journalMode = attempt();
  if (journalMode === "wal") {
    // A zombie-closed sibling connection ANYWHERE in this process (a close()
    // with unfinalized prepare() statements outside the openDatabaseFinalizing
    // set) also blocks the switch until GC finalizes it. Force a collection
    // and retry once before concluding another PROCESS holds the database.
    requestGc();
    journalMode = attempt();
  }
  if (journalMode === "wal") {
    throw new ConfigError(
      "Cannot convert state.db out of WAL mode for migration — another akm process is holding it open. " +
        "Close other akm processes and re-run `akm migrate apply`.",
      "INVALID_CONFIG_FILE",
    );
  }
}

function hasGenerationMarker(dbPath: string, operationId: string, phase: string): boolean {
  if (!fs.existsSync(dbPath)) return false;
  const db = openDatabaseFinalizing(dbPath, { readonly: true });
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='akm_migration_generation'").get()) {
      return false;
    }
    const rows = db
      .prepare("SELECT operation_id, phase FROM akm_migration_generation WHERE singleton=1 LIMIT 2")
      .all() as Array<{ operation_id: string; phase: string }>;
    return rows.length === 1 && rows[0]?.operation_id === operationId && rows[0]?.phase === phase;
  } finally {
    db.close();
  }
}

function hasGenerationMarkerFromSnapshot(dbPath: string, operationId: string, phase: string): boolean {
  if (!fs.existsSync(dbPath)) return false;
  const snapshot = createSqliteReadSnapshot(dbPath, "akm-migration-marker-");
  try {
    return hasGenerationMarker(snapshot.databasePath, operationId, phase);
  } finally {
    snapshot.cleanup();
  }
}

interface BoundStateGenerationMarker {
  phase: "state-converting" | "state-applied";
  generationSha256: string;
}

interface OpenStateSnapshotSource {
  path: string;
  fd: number;
  dev: bigint;
  ino: bigint;
}

interface StateSnapshotFingerprint {
  bytes: number;
  sha256: string;
}

interface StateSnapshotGeneration {
  main: StateSnapshotFingerprint;
  wal: StateSnapshotFingerprint | null;
}

const STATE_SNAPSHOT_BUFFER_BYTES = 1024 * 1024;

class MigrationSnapshotChangedError extends ConfigError {}

type ApplyPreflightPhase = "state-applied" | "workflow-applied";

interface MigrationSnapshotHookContext {
  sourcePath: string;
  applyPhase?: ApplyPreflightPhase;
}

let migrationSnapshotHookForTests: ((context: MigrationSnapshotHookContext) => void) | undefined;

export function _setMigrationSnapshotHookForTests(hook?: (context: MigrationSnapshotHookContext) => void): void {
  migrationSnapshotHookForTests = hook;
}

function updateCanonicalValue(
  hash: ReturnType<typeof createHash>,
  type: string,
  value: string | Uint8Array | null,
): void {
  hash.update(`${Buffer.byteLength(type)}:`);
  hash.update(type);
  if (value === null) {
    hash.update("-1:");
    return;
  }
  const byteLength = typeof value === "string" ? Buffer.byteLength(value) : value.byteLength;
  hash.update(`${byteLength}:`);
  hash.update(value);
}

export function canonicalStateGenerationSha256(db: Database): string {
  const quoteIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;
  const hash = createHash("sha256");
  for (const [name, query] of [
    ["application_id", "SELECT CAST(application_id AS TEXT) AS value FROM pragma_application_id"],
    ["encoding", "SELECT encoding AS value FROM pragma_encoding"],
    ["user_version", "SELECT CAST(user_version AS TEXT) AS value FROM pragma_user_version"],
  ] as const) {
    const row = db.prepare(query).get() as { value: string } | undefined;
    if (!row) throw new ConfigError(`Cannot fingerprint SQLite PRAGMA ${name}.`, "INVALID_CONFIG_FILE");
    updateCanonicalValue(hash, "pragma-name", name);
    updateCanonicalValue(hash, "pragma-value", row.value);
  }

  const schemaRows = db
    .prepare<{
      type: string;
      name: string;
      tbl_name: string;
      sql: string | null;
    }>(
      "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name <> 'akm_migration_generation' AND tbl_name <> 'akm_migration_generation' ORDER BY type COLLATE BINARY, name COLLATE BINARY, tbl_name COLLATE BINARY, sql COLLATE BINARY",
    )
    .iterate();
  for (const row of schemaRows) {
    updateCanonicalValue(hash, "schema-type", row.type);
    updateCanonicalValue(hash, "schema-name", row.name);
    updateCanonicalValue(hash, "schema-table", row.tbl_name);
    updateCanonicalValue(hash, "schema-sql", row.sql);
  }

  const firstTable = db.prepare<{ name: string }>(
    "SELECT name FROM sqlite_schema WHERE type='table' AND name <> 'akm_migration_generation' AND tbl_name <> 'akm_migration_generation' ORDER BY name COLLATE BINARY LIMIT 1",
  );
  const nextTable = db.prepare<{ name: string }>(
    "SELECT name FROM sqlite_schema WHERE type='table' AND name <> 'akm_migration_generation' AND tbl_name <> 'akm_migration_generation' AND name COLLATE BINARY > ? ORDER BY name COLLATE BINARY LIMIT 1",
  );
  let tableRow = firstTable.get();
  while (tableRow) {
    const table = tableRow.name;
    updateCanonicalValue(hash, "table", table);
    const columns: string[] = [];
    const columnRows = db
      .prepare<{
        cid: string;
        name: string;
        type: string;
        not_null: string;
        dflt_value: string | null;
        pk: string;
        hidden: string;
      }>(
        'SELECT CAST(cid AS TEXT) AS cid, name, type, CAST("notnull" AS TEXT) AS not_null, dflt_value, CAST(pk AS TEXT) AS pk, CAST(hidden AS TEXT) AS hidden FROM pragma_table_xinfo(?) ORDER BY cid',
      )
      .iterate(table);
    for (const column of columnRows) {
      columns.push(column.name);
      updateCanonicalValue(hash, "column-cid", column.cid);
      updateCanonicalValue(hash, "column-name", column.name);
      updateCanonicalValue(hash, "column-type", column.type);
      updateCanonicalValue(hash, "column-notnull", column.not_null);
      updateCanonicalValue(hash, "column-default", column.dflt_value);
      updateCanonicalValue(hash, "column-pk", column.pk);
      updateCanonicalValue(hash, "column-hidden", column.hidden);
    }

    const projections: string[] = [];
    const ordering: string[] = [];
    const tableFlags = db
      .prepare<{ without_rowid: string }>(
        "SELECT CAST(wr AS TEXT) AS without_rowid FROM pragma_table_list WHERE schema='main' AND name=?",
      )
      .get(table);
    if (!tableFlags) {
      throw new ConfigError(
        `Cannot determine whether SQLite table ${JSON.stringify(table)} has a rowid.`,
        "INVALID_CONFIG_FILE",
      );
    }
    const hasImplicitRowid = tableFlags.without_rowid === "0";
    const declaredNames = new Set(columns.map((column) => column.toLowerCase()));
    const rowidAlias = hasImplicitRowid
      ? ["rowid", "_rowid_", "oid"].find((alias) => !declaredNames.has(alias))
      : undefined;
    if (hasImplicitRowid && !rowidAlias) {
      throw new ConfigError(
        `Cannot fingerprint SQLite table ${JSON.stringify(table)} because all implicit rowid aliases are shadowed.`,
        "INVALID_CONFIG_FILE",
      );
    }
    if (rowidAlias) {
      const rowidTypeAlias = quoteIdentifier("__akm_implicit_rowid_type");
      const rowidValueAlias = quoteIdentifier("__akm_implicit_rowid_value");
      projections.push(
        `'integer' AS ${rowidTypeAlias}`,
        `CAST(${quoteIdentifier(rowidAlias)} AS TEXT) AS ${rowidValueAlias}`,
      );
      ordering.push(`${rowidTypeAlias} COLLATE BINARY`, `${rowidValueAlias} COLLATE BINARY`);
    }
    for (const [index, column] of columns.entries()) {
      const quotedColumn = quoteIdentifier(column);
      const typeAlias = quoteIdentifier(`__akm_type_${index}`);
      const valueAlias = quoteIdentifier(`__akm_value_${index}`);
      projections.push(
        `typeof(${quotedColumn}) AS ${typeAlias}`,
        `CASE typeof(${quotedColumn}) WHEN 'integer' THEN CAST(${quotedColumn} AS TEXT) WHEN 'real' THEN printf('%!.17g', ${quotedColumn}) WHEN 'text' THEN CAST(${quotedColumn} AS BLOB) WHEN 'blob' THEN ${quotedColumn} ELSE NULL END AS ${valueAlias}`,
      );
      ordering.push(`${typeAlias} COLLATE BINARY`, `${valueAlias} COLLATE BINARY`);
    }
    const rowStatement = db.prepare<Record<string, string | Uint8Array | null>>(
      `SELECT ${projections.join(", ")} FROM ${quoteIdentifier(table)} ORDER BY ${ordering.join(", ")}`,
    );
    for (const row of rowStatement.iterate()) {
      updateCanonicalValue(hash, "row", "");
      if (rowidAlias) {
        const rowidType = row.__akm_implicit_rowid_type;
        const rowidValue = row.__akm_implicit_rowid_value;
        if (rowidType !== "integer" || typeof rowidValue !== "string") {
          throw new ConfigError("Cannot fingerprint an exact SQLite implicit rowid.", "INVALID_CONFIG_FILE");
        }
        updateCanonicalValue(hash, rowidType, rowidValue);
      }
      for (const [index] of columns.entries()) {
        const type = row[`__akm_type_${index}`];
        const value = row[`__akm_value_${index}`];
        if (
          typeof type !== "string" ||
          (value !== null && typeof value !== "string" && !(value instanceof Uint8Array))
        ) {
          throw new ConfigError("Cannot fingerprint an unsupported SQLite value.", "INVALID_CONFIG_FILE");
        }
        updateCanonicalValue(hash, type, value);
      }
    }
    tableRow = nextTable.get(table);
  }
  return hash.digest("hex");
}

function migrationSnapshotChangedError(): MigrationSnapshotChangedError {
  return new MigrationSnapshotChangedError(
    "A SQLite migration artifact changed while creating a private status snapshot; retry when writes are idle.",
    "INVALID_CONFIG_FILE",
  );
}

function isSnapshotPathRaceError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP" || code === "EISDIR";
}

function sameOpenStateSnapshotStat(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function assertOpenStateSnapshotIdentity(source: OpenStateSnapshotSource): void {
  let stat: fs.BigIntStats;
  try {
    stat = fs.lstatSync(source.path, { bigint: true });
  } catch (error) {
    if (isSnapshotPathRaceError(error)) throw migrationSnapshotChangedError();
    throw error;
  }
  if (!stat.isFile() || stat.dev !== source.dev || stat.ino !== source.ino) throw migrationSnapshotChangedError();
}

function assertStateSnapshotPathAbsent(filePath: string): void {
  try {
    fs.lstatSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw migrationSnapshotChangedError();
}

function openStateSnapshotSource(filePath: string, optional = false): OpenStateSnapshotSource | undefined {
  let pathStat: fs.BigIntStats;
  try {
    pathStat = fs.lstatSync(filePath, { bigint: true });
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (isSnapshotPathRaceError(error)) throw migrationSnapshotChangedError();
    throw error;
  }
  if (!pathStat.isFile()) {
    throw new ConfigError(`Migration snapshot source is not a regular file: ${filePath}`, "INVALID_CONFIG_FILE");
  }
  let fd: number;
  try {
    fd = fs.openSync(filePath, "r");
  } catch (error) {
    if (isSnapshotPathRaceError(error)) throw migrationSnapshotChangedError();
    throw error;
  }
  try {
    const fdStat = fs.fstatSync(fd, { bigint: true });
    if (!fdStat.isFile() || fdStat.dev !== pathStat.dev || fdStat.ino !== pathStat.ino) {
      throw migrationSnapshotChangedError();
    }
    return { path: filePath, fd, dev: fdStat.dev, ino: fdStat.ino };
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

function readStateSnapshotSource(source: OpenStateSnapshotSource, destinationFd?: number): StateSnapshotFingerprint {
  assertOpenStateSnapshotIdentity(source);
  const before = fs.fstatSync(source.fd, { bigint: true });
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(STATE_SNAPSHOT_BUFFER_BYTES);
  let position = 0;
  while (true) {
    const bytesRead = fs.readSync(source.fd, buffer, 0, buffer.length, position);
    if (bytesRead === 0) break;
    hash.update(buffer.subarray(0, bytesRead));
    if (destinationFd !== undefined) {
      let written = 0;
      while (written < bytesRead) {
        written += fs.writeSync(destinationFd, buffer, written, bytesRead - written);
      }
    }
    position += bytesRead;
  }
  const after = fs.fstatSync(source.fd, { bigint: true });
  assertOpenStateSnapshotIdentity(source);
  if (!sameOpenStateSnapshotStat(before, after) || BigInt(position) !== after.size) {
    throw migrationSnapshotChangedError();
  }
  return { bytes: position, sha256: hash.digest("hex") };
}

function fingerprintStateSnapshotSources(
  main: OpenStateSnapshotSource,
  wal: OpenStateSnapshotSource | undefined,
  walPath: string,
): StateSnapshotGeneration {
  const mainFingerprint = readStateSnapshotSource(main);
  const walFingerprint = wal ? readStateSnapshotSource(wal) : null;
  if (!wal) assertStateSnapshotPathAbsent(walPath);
  return { main: mainFingerprint, wal: walFingerprint };
}

function copyStateSnapshotSource(source: OpenStateSnapshotSource, destination: string): StateSnapshotFingerprint {
  const destinationFd = fs.openSync(destination, "wx", 0o600);
  try {
    const fingerprint = readStateSnapshotSource(source, destinationFd);
    fs.fsyncSync(destinationFd);
    return fingerprint;
  } finally {
    fs.closeSync(destinationFd);
  }
}

function copyStateSnapshotSources(
  main: OpenStateSnapshotSource,
  wal: OpenStateSnapshotSource | undefined,
  walPath: string,
  databasePath: string,
): StateSnapshotGeneration {
  const mainFingerprint = copyStateSnapshotSource(main, databasePath);
  const walFingerprint = wal ? copyStateSnapshotSource(wal, `${databasePath}-wal`) : null;
  if (!wal) assertStateSnapshotPathAbsent(walPath);
  return { main: mainFingerprint, wal: walFingerprint };
}

function sameStateSnapshotFingerprint(
  left: StateSnapshotFingerprint | null,
  right: StateSnapshotFingerprint | null,
): boolean {
  return left === null || right === null ? left === right : left.bytes === right.bytes && left.sha256 === right.sha256;
}

function sameStateSnapshotGeneration(left: StateSnapshotGeneration, right: StateSnapshotGeneration): boolean {
  return sameStateSnapshotFingerprint(left.main, right.main) && sameStateSnapshotFingerprint(left.wal, right.wal);
}

function createSqliteReadSnapshot(
  sourcePath: string,
  tempPrefix: string,
  applyPhase?: ApplyPreflightPhase,
): { databasePath: string; cleanup: () => void } {
  const walPath = `${sourcePath}-wal`;
  const main = openStateSnapshotSource(sourcePath);
  if (!main) throw new ConfigError(`SQLite database not found: ${sourcePath}`, "INVALID_CONFIG_FILE");
  let wal: OpenStateSnapshotSource | undefined;
  let snapshotDir: string | undefined;
  let mainOpen = true;
  let walOpen = false;
  try {
    wal = openStateSnapshotSource(walPath, true);
    walOpen = wal !== undefined;
    snapshotDir = fs.mkdtempSync(path.join(os.tmpdir(), tempPrefix));
    fs.chmodSync(snapshotDir, 0o700);
    const databasePath = path.join(snapshotDir, "state.db");
    const before = fingerprintStateSnapshotSources(main, wal, walPath);
    migrationSnapshotHookForTests?.({ sourcePath, ...(applyPhase ? { applyPhase } : {}) });
    const copied = copyStateSnapshotSources(main, wal, walPath, databasePath);
    const after = fingerprintStateSnapshotSources(main, wal, walPath);
    if (!sameStateSnapshotGeneration(before, copied) || !sameStateSnapshotGeneration(before, after)) {
      throw migrationSnapshotChangedError();
    }
    const completedDir = snapshotDir;
    fs.closeSync(main.fd);
    mainOpen = false;
    if (wal) {
      fs.closeSync(wal.fd);
      walOpen = false;
    }
    snapshotDir = undefined;
    return {
      databasePath,
      cleanup: () => fs.rmSync(completedDir, { recursive: true, force: true }),
    };
  } finally {
    if (mainOpen) {
      try {
        fs.closeSync(main.fd);
      } catch {
        // The original snapshot failure remains authoritative.
      }
    }
    if (walOpen && wal) {
      try {
        fs.closeSync(wal.fd);
      } catch {
        // The original snapshot failure remains authoritative.
      }
    }
    if (snapshotDir) fs.rmSync(snapshotDir, { recursive: true, force: true });
  }
}

function bindStateConvertingMarker(db: Database, operationId: string): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS akm_migration_generation (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      operation_id TEXT NOT NULL,
      phase TEXT NOT NULL,
      generation_sha256 TEXT
    )
  `);
  const columns = new Set(
    (db.prepare("PRAGMA table_info(akm_migration_generation)").all() as Array<{ name: string }>).map(
      (column) => column.name,
    ),
  );
  if (!columns.has("generation_sha256")) {
    db.exec("ALTER TABLE akm_migration_generation ADD COLUMN generation_sha256 TEXT");
  }
  const generationSha256 = canonicalStateGenerationSha256(db);
  db.prepare(
    "INSERT INTO akm_migration_generation(singleton, operation_id, phase, generation_sha256) VALUES (1, ?, 'state-converting', ?) ON CONFLICT(singleton) DO UPDATE SET operation_id=excluded.operation_id, phase=excluded.phase, generation_sha256=excluded.generation_sha256",
  ).run(operationId, generationSha256);
}

function readBoundStateGenerationMarker(db: Database, operationId: string): BoundStateGenerationMarker | undefined {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='akm_migration_generation'").get()) {
    return undefined;
  }
  const columns = new Set(
    (db.prepare("PRAGMA table_info(akm_migration_generation)").all() as Array<{ name: string }>).map(
      (column) => column.name,
    ),
  );
  if (!columns.has("generation_sha256")) return undefined;
  const marker = db
    .prepare("SELECT operation_id, phase, generation_sha256 FROM akm_migration_generation WHERE singleton=1")
    .get() as { operation_id: string; phase: string; generation_sha256: string | null } | undefined;
  const generationSha256 = marker?.generation_sha256;
  if (!marker || marker.operation_id !== operationId || !generationSha256 || !/^[a-f0-9]{64}$/.test(generationSha256)) {
    return undefined;
  }
  if (marker.phase !== "state-converting" && marker.phase !== "state-applied") return undefined;
  if (canonicalStateGenerationSha256(db) !== generationSha256) {
    throw new ConfigError(
      "state.db no longer matches the exact logical generation bound to its state-converting marker.",
      "INVALID_CONFIG_FILE",
    );
  }
  return { phase: marker.phase, generationSha256 };
}

function readBoundStateGenerationMarkerAtPath(
  statePath: string,
  operationId: string,
): BoundStateGenerationMarker | undefined {
  if (!fs.existsSync(statePath)) return undefined;
  const db = openDatabaseFinalizing(statePath, { readonly: true, create: false });
  try {
    return readBoundStateGenerationMarker(db, operationId);
  } finally {
    db.close();
  }
}

function readBoundStateGenerationMarkerFromDisk(operationId: string): BoundStateGenerationMarker | undefined {
  const statePath = getStateDbPathInDataDir();
  if (!fs.existsSync(statePath)) return undefined;
  const snapshot = createSqliteReadSnapshot(statePath, "akm-migration-state-");
  try {
    return readBoundStateGenerationMarkerAtPath(snapshot.databasePath, operationId);
  } finally {
    snapshot.cleanup();
  }
}

function cutoverMergeCommittedFromSnapshot(operationId: string): boolean {
  const statePath = getStateDbPathInDataDir();
  if (!fs.existsSync(statePath)) return false;
  const snapshot = createSqliteReadSnapshot(statePath, "akm-migration-state-");
  try {
    return cutoverMergeCommitted(snapshot.databasePath, operationId);
  } finally {
    snapshot.cleanup();
  }
}

function createMigrationInspectionSnapshots(applyPhase?: ApplyPreflightPhase): {
  paths: Required<MigrationInspectionPaths>;
  cleanup: () => void;
} {
  const missingRoot = fs.mkdtempSync(path.join(os.tmpdir(), "akm-migration-inspect-"));
  fs.chmodSync(missingRoot, 0o700);
  const snapshots: Array<{ cleanup: () => void }> = [];
  const capture = (sourcePath: string, prefix: string, name: string): string => {
    if (!fs.existsSync(sourcePath)) return path.join(missingRoot, name);
    const snapshot = createSqliteReadSnapshot(sourcePath, prefix, applyPhase);
    snapshots.push(snapshot);
    return snapshot.databasePath;
  };
  try {
    const paths = {
      stateDbPath: capture(getStateDbPathInDataDir(), "akm-migration-state-", "state.db"),
      workflowDbPath: capture(getLegacyWorkflowDbPath(), "akm-migration-workflow-", "workflow.db"),
      indexDbPath: capture(getDbPath(), "akm-migration-index-", "index.db"),
    };
    return {
      paths,
      cleanup: () => {
        for (const snapshot of snapshots) snapshot.cleanup();
        fs.rmSync(missingRoot, { recursive: true, force: true });
      },
    };
  } catch (error) {
    for (const snapshot of snapshots) snapshot.cleanup();
    fs.rmSync(missingRoot, { recursive: true, force: true });
    throw error;
  }
}

interface MigrationInspectionCapture {
  paths: Required<MigrationInspectionPaths>;
  artifacts: MigrationState;
  generation: MigrationGenerationFingerprint;
  cleanup: () => void;
}

function captureMigrationInspection(applyPhase?: ApplyPreflightPhase): MigrationInspectionCapture {
  const before = fingerprintMigrationGeneration();
  const snapshots = createMigrationInspectionSnapshots(applyPhase);
  try {
    const after = fingerprintMigrationGeneration();
    if (!sameMigrationGeneration(before, after)) throw migrationSnapshotChangedError();
    return {
      paths: snapshots.paths,
      artifacts: inspectMigrationState(snapshots.paths),
      generation: after,
      cleanup: snapshots.cleanup,
    };
  } catch (error) {
    snapshots.cleanup();
    throw error;
  }
}

function inspectMigrationStateFromSnapshots(): MigrationState {
  const capture = captureMigrationInspection();
  try {
    return capture.artifacts;
  } finally {
    capture.cleanup();
  }
}

class MigrationPreflightGenerationError extends ConfigError {}

let applyPreflightHookForTests: ((phase: ApplyPreflightPhase) => void) | undefined;

export function _setApplyPreflightHookForTests(hook?: (phase: ApplyPreflightPhase) => void): void {
  applyPreflightHookForTests = hook;
}

function inspectExactApplyJournalGeneration(journal: ApplyJournal): MigrationState {
  if (journal.phase !== "state-applied" && journal.phase !== "workflow-applied") {
    throw new ConfigError(`Cannot preflight migration journal phase ${journal.phase}.`, "INVALID_CONFIG_FILE");
  }
  applyPreflightHookForTests?.(journal.phase);
  const capture = captureMigrationInspection(journal.phase);
  try {
    if (!sameMigrationGeneration(capture.generation, journal.generation)) {
      throw new MigrationPreflightGenerationError(
        `Migration apply journal phase ${journal.phase} changed before its next mutation; the external generation was preserved.`,
        "INVALID_CONFIG_FILE",
      );
    }
    return capture.artifacts;
  } finally {
    capture.cleanup();
  }
}

function readSingleFileBoundStateMarker(
  journal: ApplyJournal,
  stateSnapshotPath?: string,
): BoundStateGenerationMarker | undefined {
  const statePath = stateSnapshotPath ?? getStateDbPathInDataDir();
  if (!fs.existsSync(statePath) || stateDatabaseHeaderUsesWal(statePath)) return undefined;
  return stateSnapshotPath
    ? readBoundStateGenerationMarkerAtPath(statePath, journal.operationId)
    : readBoundStateGenerationMarkerFromDisk(journal.operationId);
}

function advanceBoundStateMarker(db: Database, operationId: string): void {
  const marker = readBoundStateGenerationMarker(db, operationId);
  if (!marker) {
    throw new ConfigError("state.db lacks its exact marker-bound conversion generation.", "INVALID_CONFIG_FILE");
  }
  db.prepare("UPDATE akm_migration_generation SET phase='state-applied' WHERE singleton=1 AND operation_id=?").run(
    operationId,
  );
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
  live: MigrationState,
  current: MigrationGenerationFingerprint,
  workflowDbPath: string,
): { adjacent?: AdjacentGeneration; rollbackCompleted?: boolean } {
  if (journal.phase === "rollback-prepared") {
    return {
      rollbackCompleted: sameMigrationGeneration(current, generationFromBackup(manifest)),
    };
  }
  const unchanged = (...names: Array<keyof MigrationGenerationFingerprint>): boolean =>
    names.every((name) => sameArtifactFingerprint(journal.generation[name], current[name]));
  if (
    journal.phase === "state-applied" &&
    unchanged("config", "state") &&
    hasGenerationMarker(workflowDbPath, journal.operationId, "workflow-applied")
  ) {
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
      : journal.phase === "state-converting"
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
      if (
        name === "state" &&
        (journal.phase === "state-applied" || journal.phase === "workflow-applied") &&
        readSingleFileBoundStateMarker(journal)?.phase === "state-applied"
      ) {
        // SQLite rollback preserves the logical generation but may rewrite
        // physical pages. The operation-bound canonical digest covers the full
        // schema and every row, so it safely authenticates that rollback.
        continue;
      }
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

function validateApplyPhase(
  journal: ApplyJournal,
  manifest: MigrationBackupManifest,
  inspectionPaths?: MigrationInspectionPaths,
  inspectedState?: MigrationState,
): MigrationState {
  const live = inspectedState ?? inspectMigrationState(inspectionPaths);
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
        : journal.phase === "state-converting" || journal.phase === "state-collapsing"
          ? configOriginal && workflowOriginal && (stateOriginal || stateApplied)
          : journal.phase === "state-applied"
            ? stateApplied && configOriginal && (workflowOriginal || workflowApplied)
            : journal.phase === "workflow-applied"
              ? stateApplied && workflowApplied && (configOriginal || configApplied)
              : journal.phase === "cutover-applied"
                ? stateApplied && workflowFinal && (configOriginal || configApplied)
                : // config-applied / tasks-* / pilot-* / committed
                  stateApplied && workflowFinal && configApplied;
  if (!reachable) {
    throw new ConfigError(
      `Migration apply journal phase ${journal.phase} does not match a reachable config/state/workflow artifact state.`,
      "INVALID_CONFIG_FILE",
    );
  }
  return live;
}

function postCutoverArtifacts(
  journal: ApplyJournal,
  manifest: MigrationBackupManifest,
  current: MigrationGenerationFingerprint,
  paths: Required<MigrationInspectionPaths>,
  artifacts: MigrationState,
): MigrationState {
  assertPostCutoverWorkflowAuthenticated(journal, current);
  if (!cutoverMergeCommitted(paths.stateDbPath, journal.operationId)) {
    throw new ConfigError(
      `Migration apply journal phase ${journal.phase} lacks its operation-bound cutover marker.`,
      "INVALID_CONFIG_FILE",
    );
  }
  return validateApplyPhase(journal, manifest, paths, artifacts);
}

function readApplyJournalMetadata(): ApplyJournalMetadata {
  const journalPath = getMigrationApplyJournalPath();
  if (!fs.existsSync(journalPath)) return {};
  let journal: ApplyJournal;
  try {
    const value = JSON.parse(
      readTextFileWithLimit(journalPath, MAX_LOCAL_METADATA_BYTES, "Migration apply journal"),
    ) as unknown;
    const phases: ApplyPhase[] = [
      "prepared",
      "state-converting",
      "state-collapsing",
      "state-applied",
      "workflow-applied",
      "cutover-applied",
      "config-applied",
      "tasks-prepared",
      "tasks-applied",
      "pilot-prepared",
      "pilot-applied",
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
    return { journal, config, manifest };
  } catch (error) {
    return {
      journal,
      error: `Unreadable migration apply journal at ${journalPath}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function journalArtifactState(
  artifact: MigrationBackupManifest["artifacts"]["state.db"],
  status: MigrationArtifactState["status"] = artifact.status,
): MigrationArtifactState {
  return {
    status,
    ...(artifact.migrationIds ? { migrationIds: artifact.migrationIds } : {}),
    ...(artifact.migrationChecksums ? { migrationChecksums: artifact.migrationChecksums } : {}),
  };
}

function stateBeforeCompatibilityConversion(journal: ApplyJournal, manifest: MigrationBackupManifest): MigrationState {
  const workflowBackup = manifest.artifacts["workflow.db"];
  const indexBackup = manifest.artifacts["index.db"];
  return {
    config: journalArtifactState(manifest.artifacts["config.json"]),
    state: { status: manifest.artifacts["state.db"].present ? "current" : "missing" },
    workflow:
      journal.phase === "workflow-applied" && workflowBackup.present
        ? { status: "current" }
        : journalArtifactState(workflowBackup),
    index: indexBackup ? journalArtifactState(indexBackup) : { status: "missing" },
  };
}

function isPreConversionCompatiblePhase(phase: ApplyPhase): phase is "state-applied" | "workflow-applied" {
  return phase === "state-applied" || phase === "workflow-applied";
}

function isPostCutoverPhase(
  phase: ApplyPhase,
): phase is
  | "cutover-applied"
  | "config-applied"
  | "tasks-prepared"
  | "tasks-applied"
  | "pilot-prepared"
  | "pilot-applied"
  | "committed" {
  return [
    "cutover-applied",
    "config-applied",
    "tasks-prepared",
    "tasks-applied",
    "pilot-prepared",
    "pilot-applied",
    "committed",
  ].includes(phase);
}

function isAuthenticatedWorkflowAdjacent(
  journal: ApplyJournal,
  current: MigrationGenerationFingerprint,
  workflowSnapshotPath?: string,
): boolean {
  if (journal.phase !== "state-applied") return false;
  const markerPresent = workflowSnapshotPath
    ? hasGenerationMarker(workflowSnapshotPath, journal.operationId, "workflow-applied")
    : hasGenerationMarkerFromSnapshot(getLegacyWorkflowDbPath(), journal.operationId, "workflow-applied");
  return (
    sameArtifactFingerprint(journal.generation.config, current.config) &&
    sameArtifactFingerprint(journal.generation.state, current.state) &&
    markerPresent
  );
}

function isAuthenticatedCutoverAdjacent(
  journal: ApplyJournal,
  current: MigrationGenerationFingerprint,
  stateSnapshotPath?: string,
): boolean {
  return (
    journal.phase === "workflow-applied" &&
    sameArtifactFingerprint(journal.generation.config, current.config) &&
    workflowArtifactIsDeletionSubset(journal.generation, current) &&
    (stateSnapshotPath
      ? cutoverMergeCommitted(stateSnapshotPath, journal.operationId)
      : cutoverMergeCommittedFromSnapshot(journal.operationId))
  );
}

function workflowArtifactIsDeletionSubset(
  expected: MigrationGenerationFingerprint,
  current: MigrationGenerationFingerprint,
): boolean {
  return (["main", "wal", "shm"] as const).every((component) => {
    const actual = current.workflow[component];
    return actual === null || JSON.stringify(actual) === JSON.stringify(expected.workflow[component]);
  });
}

function assertPostCutoverWorkflowAuthenticated(journal: ApplyJournal, current: MigrationGenerationFingerprint): void {
  if (workflowArtifactIsDeletionSubset(journal.generation, current)) return;
  throw new ConfigError(
    `Migration apply journal phase ${journal.phase} does not authorize the live workflow.db generation.`,
    "INVALID_CONFIG_FILE",
  );
}

function readApplyJournal(): {
  journal?: ApplyJournal;
  config?: AkmConfig;
  artifacts?: MigrationState;
  requiresStateConversion?: boolean;
  adjacent?: AdjacentGeneration;
  rollbackCompleted?: boolean;
  error?: string;
} {
  const metadata = readApplyJournalMetadata();
  if (metadata.error || !metadata.journal || !metadata.config || !metadata.manifest) return metadata;
  const { journal, config, manifest } = metadata;
  let capture: MigrationInspectionCapture;
  try {
    capture = captureMigrationInspection();
  } catch (error) {
    return {
      journal,
      config,
      error: `Unreadable migration apply journal at ${getMigrationApplyJournalPath()}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const rawGeneration = capture.generation;
  const inspectedArtifacts = capture.artifacts;
  try {
    if (isPostCutoverPhase(journal.phase)) {
      if (isTaskOnlyRepair(manifest)) {
        const artifacts = validateApplyPhase(journal, manifest, capture.paths, inspectedArtifacts);
        if (!sameMigrationGeneration(rawGeneration, journal.generation)) {
          throw new ConfigError(
            `Migration apply journal phase ${journal.phase} does not match the exact live artifact generation.`,
            "INVALID_CONFIG_FILE",
          );
        }
        return { journal, config, artifacts };
      }
      return {
        journal,
        config,
        artifacts: postCutoverArtifacts(journal, manifest, rawGeneration, capture.paths, inspectedArtifacts),
      };
    }
    if (
      !sameMigrationGeneration(rawGeneration, journal.generation) &&
      isAuthenticatedCutoverAdjacent(journal, rawGeneration, capture.paths.stateDbPath)
    ) {
      const artifacts = postCutoverArtifacts(
        { ...journal, phase: "cutover-applied" },
        manifest,
        rawGeneration,
        capture.paths,
        inspectedArtifacts,
      );
      return {
        journal,
        config,
        artifacts,
        adjacent: {
          phase: "cutover-applied",
          complete: true,
          generation: rawGeneration,
        },
      };
    }
    if (isPreConversionCompatiblePhase(journal.phase)) {
      const stateMarker = readSingleFileBoundStateMarker(journal, capture.paths.stateDbPath);
      if (stateMarker?.phase === "state-applied") {
        if (sameMigrationGeneration(rawGeneration, journal.generation)) {
          return { journal, config, artifacts: inspectedArtifacts };
        }
        if (isAuthenticatedWorkflowAdjacent(journal, rawGeneration, capture.paths.workflowDbPath)) {
          return {
            journal,
            config,
            artifacts: inspectedArtifacts,
            adjacent: {
              phase: "workflow-applied",
              complete: true,
              generation: rawGeneration,
            },
          };
        }
        throw new ConfigError(
          `Migration apply journal phase ${journal.phase} does not match the exact live artifact generation.`,
          "INVALID_CONFIG_FILE",
        );
      }
    }
    if (isPreConversionCompatiblePhase(journal.phase)) {
      if (sameMigrationGeneration(rawGeneration, journal.generation)) {
        return {
          journal,
          config,
          artifacts: stateBeforeCompatibilityConversion(journal, manifest),
          requiresStateConversion: true,
        };
      }
      if (isAuthenticatedWorkflowAdjacent(journal, rawGeneration, capture.paths.workflowDbPath)) {
        return {
          journal,
          config,
          artifacts: stateBeforeCompatibilityConversion({ ...journal, phase: "workflow-applied" }, manifest),
          requiresStateConversion: true,
          adjacent: {
            phase: "workflow-applied",
            complete: true,
            generation: rawGeneration,
          },
        };
      }
      throw new ConfigError(
        `Migration apply journal phase ${journal.phase} does not match the exact live artifact generation.`,
        "INVALID_CONFIG_FILE",
      );
    }
    if (journal.phase === "state-converting") {
      if (sameMigrationGeneration(rawGeneration, journal.generation)) {
        return {
          journal,
          config,
          artifacts: stateBeforeCompatibilityConversion(journal, manifest),
          requiresStateConversion: true,
        };
      }
      const marker = readBoundStateGenerationMarkerAtPath(capture.paths.stateDbPath, journal.operationId);
      if (marker?.phase === "state-converting") {
        return {
          journal,
          config,
          artifacts: stateBeforeCompatibilityConversion(journal, manifest),
          requiresStateConversion: true,
          adjacent: {
            phase: "state-collapsing",
            complete: true,
            generation: rawGeneration,
          },
        };
      }
      throw new ConfigError(
        "Migration apply journal phase state-converting does not match its exact marker-bound generation.",
        "INVALID_CONFIG_FILE",
      );
    }
    if (journal.phase === "state-collapsing") {
      if (sameMigrationGeneration(rawGeneration, journal.generation)) {
        return {
          journal,
          config,
          artifacts: stateBeforeCompatibilityConversion(journal, manifest),
          requiresStateConversion: true,
        };
      }
      const marker = readBoundStateGenerationMarkerAtPath(capture.paths.stateDbPath, journal.operationId);
      if (marker) {
        return {
          journal,
          config,
          artifacts: stateBeforeCompatibilityConversion(journal, manifest),
          requiresStateConversion: true,
          adjacent: {
            phase: marker.phase === "state-applied" ? "state-applied" : "state-collapsing",
            complete: marker.phase === "state-applied",
            generation: rawGeneration,
          },
        };
      }
      throw new ConfigError(
        "Migration apply journal phase state-collapsing does not match its exact marker-bound generation.",
        "INVALID_CONFIG_FILE",
      );
    }
    validateApplyPhase(journal, manifest, capture.paths, inspectedArtifacts);
    if (!sameMigrationGeneration(rawGeneration, journal.generation)) {
      const adjacent = detectAdjacentGeneration(
        journal,
        manifest,
        inspectedArtifacts,
        rawGeneration,
        capture.paths.workflowDbPath,
      );
      if (adjacent.adjacent || adjacent.rollbackCompleted) {
        return { journal, config, artifacts: inspectedArtifacts, ...adjacent };
      }
      throw new ConfigError(
        `Migration apply journal phase ${journal.phase} does not match the exact live artifact generation.`,
        "INVALID_CONFIG_FILE",
      );
    }
    return { journal, config, artifacts: inspectedArtifacts };
  } catch (error) {
    return {
      journal,
      config,
      ...(isPreConversionCompatiblePhase(journal.phase) ||
      journal.phase === "state-converting" ||
      journal.phase === "state-collapsing"
        ? {
            artifacts: stateBeforeCompatibilityConversion(journal, manifest),
            requiresStateConversion: true,
          }
        : { artifacts: inspectedArtifacts }),
      error: `Unreadable migration apply journal at ${getMigrationApplyJournalPath()}: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    capture.cleanup();
  }
}

function authenticatePreConversionJournalForApply(): void {
  const metadata = readApplyJournalMetadata();
  if (metadata.error) throw new ConfigError(metadata.error, "INVALID_CONFIG_FILE");
  const journal = metadata.journal;
  if (!journal || !isPreConversionCompatiblePhase(journal.phase)) return;
  const current = fingerprintMigrationGeneration();
  if (isAuthenticatedCutoverAdjacent(journal, current)) return;
  if (readSingleFileBoundStateMarker(journal)?.phase === "state-applied") {
    if (
      sameMigrationGeneration(current, journal.generation) ||
      isAuthenticatedWorkflowAdjacent(journal, current) ||
      isAuthenticatedCutoverAdjacent(journal, current)
    ) {
      return;
    }
    throw new ConfigError(
      `Migration apply journal phase ${journal.phase} does not match the exact live artifact generation.`,
      "INVALID_CONFIG_FILE",
    );
  }
  if (
    !sameMigrationGeneration(current, journal.generation) &&
    !isAuthenticatedWorkflowAdjacent(journal, current) &&
    !isAuthenticatedCutoverAdjacent(journal, current)
  ) {
    throw new ConfigError(
      `Migration apply journal phase ${journal.phase} does not match the exact live artifact generation.`,
      "INVALID_CONFIG_FILE",
    );
  }
}

function preparePreConversionJournalForApply(): void {
  const metadata = readApplyJournalMetadata();
  if (metadata.error) throw new ConfigError(metadata.error, "INVALID_CONFIG_FILE");
  const journal = metadata.journal;
  if (!journal || !isPreConversionCompatiblePhase(journal.phase)) return;

  let current = fingerprintMigrationGeneration();
  if (isAuthenticatedCutoverAdjacent(journal, current)) return;
  if (readSingleFileBoundStateMarker(journal)?.phase === "state-applied") return;
  if (!sameMigrationGeneration(current, journal.generation)) {
    if (!isAuthenticatedWorkflowAdjacent(journal, current)) {
      throw new ConfigError(
        `Migration apply journal phase ${journal.phase} does not match the exact live artifact generation.`,
        "INVALID_CONFIG_FILE",
      );
    }
    current = fingerprintMigrationGeneration();
  }
  journal.phase = "state-converting";
  journal.generation = current;
  writeApplyJournal(journal);
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
  if (APPLY_PHASE_ORDER.indexOf(phase) > APPLY_PHASE_ORDER.indexOf(journal.phase)) journal.phase = phase;
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

function crashAfterForTests(
  phase: "state-converting" | "state-marker" | "state" | "workflow" | "cutover" | "config" | "tasks" | "pilot",
): void {
  if (process.env.AKM_TEST_MIGRATION_CRASH_AFTER === phase) process.kill(process.pid, "SIGKILL");
}

function crashInMutationGapForTests(
  phase:
    | "state-converting"
    | "state-checkpoint"
    | "state-marker"
    | "state"
    | "workflow"
    | "cutover-commit"
    | "cutover"
    | "config"
    | "tasks"
    | "pilot"
    | "rollback",
): void {
  if (process.env.AKM_TEST_MIGRATION_CRASH_GAP === phase) process.kill(process.pid, "SIGKILL");
}

function isForwardRecoveryPhase(phase: ApplyPhase): boolean {
  return [
    "state-collapsing",
    "cutover-applied",
    "config-applied",
    "tasks-prepared",
    "tasks-applied",
    "pilot-prepared",
    "pilot-applied",
    "committed",
  ].includes(phase);
}

/** Publish a preflighted task-target batch inside the journal's forward-only region. */
function runTaskTargetMigrationStep(journal: ApplyJournal, plan: ReturnType<typeof planTaskTargetRefMigration>): void {
  applyTaskTargetRefMigration(plan);
  crashInMutationGapForTests("tasks");
  advanceApplyJournal(journal, "tasks-applied");
  crashAfterForTests("tasks");
}

function isTaskOnlyRepair(manifest: MigrationBackupManifest): boolean {
  return (
    manifest.artifacts["config.json"].status === "current" &&
    ["current", "missing"].includes(manifest.artifacts["state.db"].status) &&
    manifest.artifacts["workflow.db"].status === "missing"
  );
}

function runTaskOnlyRepair(journal: ApplyJournal, plan: ReturnType<typeof planTaskTargetRefMigration>): void {
  advanceApplyJournal(journal, "tasks-prepared");
  if (journal.phase === "tasks-prepared") runTaskTargetMigrationStep(journal, plan);
  advanceApplyJournal(journal, "committed");
  clearApplyJournal();
}

function runStateMigrationStep(journal: ApplyJournal): void {
  if (journal.phase === "prepared") {
    advanceApplyJournal(journal, "state-converting");
    crashAfterForTests("state-converting");
  }
  if (journal.phase === "state-converting") {
    const db = openDatabaseFinalizing(getStateDbPathInDataDir());
    try {
      const marker = readBoundStateGenerationMarker(db, journal.operationId);
      if (marker?.phase === "state-applied") {
        throw new ConfigError("state.db is ahead of its state-converting journal.", "INVALID_CONFIG_FILE");
      }
      if (!marker) {
        db.transaction(() => {
          runStateMigrations(db);
          bindStateConvertingMarker(db, journal.operationId);
        })();
      } else {
        runStateMigrations(db, { applyPending: false });
      }
    } finally {
      db.close();
    }
    crashInMutationGapForTests("state-marker");
    advanceApplyJournal(journal, "state-collapsing");
    crashAfterForTests("state-marker");
  }
  if (journal.phase === "state-collapsing") {
    if (!sameMigrationGeneration(fingerprintMigrationGeneration(), journal.generation)) {
      const marker = readBoundStateGenerationMarkerFromDisk(journal.operationId);
      if (!marker) {
        throw new ConfigError(
          "state.db does not match the exact marker-bound generation recorded before conversion.",
          "INVALID_CONFIG_FILE",
        );
      }
      journal.phase = marker.phase === "state-applied" ? "state-applied" : "state-collapsing";
      journal.generation = fingerprintMigrationGeneration();
      writeApplyJournal(journal);
      if (journal.phase === "state-applied") return;
    }
    const db = openDatabaseFinalizing(getStateDbPathInDataDir());
    try {
      if (!readBoundStateGenerationMarker(db, journal.operationId)) {
        throw new ConfigError("state.db lacks its exact marker-bound conversion generation.", "INVALID_CONFIG_FILE");
      }
      collapseStateDbToSingleFile(db);
      crashInMutationGapForTests("state-converting");
      advanceBoundStateMarker(db, journal.operationId);
    } finally {
      db.close();
    }
    crashInMutationGapForTests("state");
    advanceApplyJournal(journal, "state-applied");
    crashAfterForTests("state");
  }
}

function stateDatabaseHeaderUsesWal(filePath: string): boolean {
  const fd = fs.openSync(filePath, "r");
  try {
    const header = Buffer.alloc(20);
    if (fs.readSync(fd, header, 0, header.byteLength, 0) !== header.byteLength) {
      throw new ConfigError(`Cannot verify the SQLite header for ${filePath}.`, "INVALID_CONFIG_FILE");
    }
    if (!header.subarray(0, 16).equals(Buffer.from("SQLite format 3\0"))) {
      throw new ConfigError(`Cannot verify a non-SQLite state database at ${filePath}.`, "INVALID_CONFIG_FILE");
    }
    return header[18] === 2 || header[19] === 2;
  } finally {
    fs.closeSync(fd);
  }
}

function assertStateReadyForCutover(journal: ApplyJournal): void {
  const statePath = getStateDbPathInDataDir();
  if (!fs.existsSync(statePath)) {
    throw new ConfigError("Cannot run cutover without state.db.", "INVALID_CONFIG_FILE");
  }
  if (stateDatabaseHeaderUsesWal(statePath)) {
    throw new ConfigError(
      "Refusing cutover because state.db still uses WAL; resume through the state-converting phase first.",
      "INVALID_CONFIG_FILE",
    );
  }
  const db = openDatabaseFinalizing(statePath, { readonly: true });
  try {
    const journalMode = String(
      (db.prepare("PRAGMA journal_mode").get() as { journal_mode?: string } | undefined)?.journal_mode ?? "",
    ).toLowerCase();
    const hasMarkerTable = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='akm_migration_generation'")
      .get();
    const marker = hasMarkerTable
      ? (db
          .prepare("SELECT operation_id, phase FROM akm_migration_generation WHERE singleton=1 LIMIT 2")
          .all() as Array<{ operation_id: string; phase: string }>)
      : [];
    if (
      journalMode !== "delete" ||
      marker.length !== 1 ||
      marker[0]?.operation_id !== journal.operationId ||
      marker[0]?.phase !== "state-applied"
    ) {
      throw new ConfigError(
        "Refusing cutover because state.db lacks the operation-bound state-converting/single-file proof.",
        "INVALID_CONFIG_FILE",
      );
    }
  } finally {
    db.close();
  }
}

function assertMigrationArtifactsComplete(): void {
  const completed = inspectMigrationState();
  if (
    completed.config.status !== "current" ||
    ![completed.state.status, completed.workflow.status].every((status) => status === "current" || status === "missing")
  ) {
    throw new ConfigError(
      "Migration verification did not reach one current cross-artifact generation.",
      "INVALID_CONFIG_FILE",
    );
  }
}

/** Expand a leading `~` against the home directory (config stashDir/source paths may use it). */
function expandTilde(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * Stash roots for the cutover ref map's origin aliases, the
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
  const db = openDatabaseFinalizing(workflowPath);
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

  const stashRoots = cutoverStashRootsFromConfig(target);
  if (!cutoverMergeCommitted(statePath, journal.operationId)) {
    const refMap = buildCutoverRefMap({
      oldIndexDbPath: indexPath,
      stashRoots,
      mapOutputPath: cutoverRefMapPath(journal),
    });
    // Fail-closed: an integrity failure (unparseable ref / row-count mismatch)
    // throws a CutoverIntegrityError, which the outer catch converts to a
    // restore-from-backup. The state txn is atomic — a throw rolls it back, so
    // state.db + workflow.db are unchanged going into the rollback.
    runThreeDbCutover({ refMap, operationId: journal.operationId, statePath, workflowPath, oldIndexPath: indexPath });
    crashInMutationGapForTests("cutover-commit");
  } else {
    assertPostCutoverWorkflowAuthenticated(journal, fingerprintMigrationGeneration());
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

function cutoverRefMapPath(journal: ApplyJournal): string {
  return path.join(path.dirname(getMigrationApplyJournalPath()), `cutover-refmap-${journal.operationId}.json`);
}

/** Required forward-only filesystem step after the core config/database cutover verifies. */
function runPilotTreatmentStep(journal: ApplyJournal, target: AkmConfig): void {
  const refMap = loadCutoverRefMap(cutoverRefMapPath(journal));
  migratePilotTreatmentFiles(cutoverStashRootsFromConfig(target), refMap);
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
    // Fold the one-time pre-0.9 filesystem-proposal import into this same
    // additive step (it used to run on every proposal operation via
    // `withProposalsDb`). state.db has been merged + collapsed to single-file
    // DELETE mode by this point, so we open it raw and INSERT OR IGNORE each
    // legacy `proposal.json` on its UUID — idempotent, no ledger needed.
    //
    // rc-window edge: a user who already ran `akm migrate apply` on an EARLIER
    // rc binary (before this fold existed) AND never ran a proposal command
    // afterward would have their pre-0.9 fs proposals un-imported — the old
    // live-path import that once covered that gap is gone. Re-running this
    // idempotent `migrate apply` recovers them (the legacy files are left in
    // place on import, so they are still there to re-walk). Acceptable for an rc.
    report.legacyProposalsImported = importLegacyProposalsIntoState(getStateDbPathInDataDir(), roots);
    persistContentMigrationReport(report);
    if (report.sidecarsFolded > 0 || report.reservedRenames.length > 0 || report.legacyProposalsImported > 0) {
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
  const artifacts = activeApply.artifacts ?? inspectMigrationStateFromSnapshots();
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
  if (activeApply.error && (!activeApply.journal || target.state.status === "current"))
    blockers.push(activeApply.error);
  if (restorePending) blockers.push(`Restore recovery is pending at ${getMigrationRestoreJournalPath()}.`);

  let taskRewrites = 0;
  if (blockers.length === 0 && target.config) {
    try {
      taskRewrites = planTaskTargetRefMigration(target.config).rewrites.length;
    } catch (error) {
      blockers.push(error instanceof Error ? error.message : String(error));
    }
  }

  const needsApply =
    !!activeApply.journal ||
    artifacts.config.status !== "current" ||
    artifacts.state.status === "old" ||
    artifacts.workflow.status === "old" ||
    artifacts.workflow.status === "current" ||
    taskRewrites > 0;
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
      recoverInterruptedRestoreWithLocksHeld();
      authenticatePreConversionJournalForApply();
      assertNoArtifactReplacementBlockers(undefined, {
        skipWorkflowClaims: fs.existsSync(getMigrationApplyJournalPath()),
      });
      preparePreConversionJournalForApply();
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
      const taskOnlyRepair = isTaskOnlyRepair(backup.manifest);
      let forwardRecoveryRequired = isForwardRecoveryPhase(journal.phase);
      try {
        const taskTargetPlan = planTaskTargetRefMigration(target);
        if (taskOnlyRepair) {
          forwardRecoveryRequired = true;
          runTaskOnlyRepair(journal, taskTargetPlan);
          return { plan: inspectMigrationPlan(), backup };
        }

        runStateMigrationStep(journal);
        forwardRecoveryRequired = isForwardRecoveryPhase(journal.phase);
        if (isPostCutoverPhase(journal.phase)) runCutoverStep(journal, target);

        if (journal.phase === "state-applied") {
          // Roll the pre-cutover workflow.db through the frozen migration bodies
          // only while the journal is still before the committed cutover.
          const beforeWorkflow = inspectExactApplyJournalGeneration(journal);
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
        }

        if (journal.phase === "workflow-applied") {
          const migrated = inspectExactApplyJournalGeneration(journal);
          for (const [name, state] of [
            ["state.db", migrated.state],
            ["workflow.db", migrated.workflow],
          ] as const) {
            if (state.status !== "current" && state.status !== "missing") {
              throw new ConfigError(`Migration left ${name} in ${state.status} state.`, "INVALID_CONFIG_FILE");
            }
          }

          assertStateReadyForCutover(journal);
          runCutoverStep(journal, target);
          forwardRecoveryRequired = true;
          crashInMutationGapForTests("cutover");
          advanceApplyJournal(journal, "cutover-applied");
          crashAfterForTests("cutover");
        }

        if (journal.phase === "cutover-applied") {
          // The cutover is committed, so all remaining work is forward-only.
          try {
            const preCutoverText = readConfigText(getConfigPath());
            if (preCutoverText !== undefined) {
              mergeLockEntriesSync(migratedLockEntries(parseConfigText(preCutoverText, getConfigPath())));
            }
          } catch {
            // Advisory lock re-key only; the committed cutover is unaffected.
          }

          backupExistingConfig(getConfigPath());
          writeConfigAtomic(getConfigPath(), sanitizeConfigForWrite(target));
          resetConfigCache();
          crashInMutationGapForTests("config");
          advanceApplyJournal(journal, "config-applied");
          crashAfterForTests("config");
        }

        if (journal.phase === "config-applied") {
          assertMigrationArtifactsComplete();
          advanceApplyJournal(journal, "tasks-prepared");
        }

        if (journal.phase === "tasks-prepared") {
          forwardRecoveryRequired = true;
          runTaskTargetMigrationStep(journal, taskTargetPlan);
        }

        if (journal.phase === "tasks-applied") advanceApplyJournal(journal, "pilot-prepared");
        if (journal.phase === "pilot-prepared") {
          forwardRecoveryRequired = true;
          runPilotTreatmentStep(journal, target);
          crashInMutationGapForTests("pilot");
          advanceApplyJournal(journal, "pilot-applied");
          crashAfterForTests("pilot");
        }

        if (journal.phase === "pilot-applied") advanceApplyJournal(journal, "committed");
        clearApplyJournal();
        const completed = inspectMigrationPlan();
        return { plan: completed, backup };
      } catch (error) {
        if (error instanceof MigrationPreflightGenerationError || error instanceof MigrationSnapshotChangedError) {
          forwardRecoveryRequired = true;
        }
        if (isForwardRecoveryPhase(journal.phase)) forwardRecoveryRequired = true;
        if (!forwardRecoveryRequired && cutoverMergeCommitted(getStateDbPathInDataDir(), journal.operationId)) {
          forwardRecoveryRequired = true;
        }
        if (forwardRecoveryRequired) {
          throw new ConfigError(
            `Migration apply requires forward recovery from ${getMigrationApplyJournalPath()}: ${error instanceof Error ? error.message : String(error)}`,
            "INVALID_CONFIG_FILE",
          );
        }
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
