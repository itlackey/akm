// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { openDatabase } from "../storage/database";
import { writeFileAtomic } from "./common";
import { parseConfigText, withConfigLock } from "./config/config-io";
import { CURRENT_CONFIG_VERSION } from "./config/config-schema";
import { ConfigError } from "./errors";
import { createLockPayload, probeLock, reclaimStaleLock, releaseLock, tryAcquireLockSync } from "./file-lock";
import { acquireMaintenanceActivitySync, withMaintenanceStartBarrier } from "./maintenance-barrier";
import {
  getCacheDir,
  getConfigPath,
  getDataDir,
  getIndexWriterLockPath,
  getLockfileLockPath,
  getStateDbPathInDataDir,
  getWorkflowDbPath,
} from "./paths";

export const MIGRATION_BACKUP_VERSION = "0.9.0" as const;

const ARTIFACT_NAMES = ["config.json", "state.db", "workflow.db"] as const;
type ArtifactName = (typeof ARTIFACT_NAMES)[number];

export interface MigrationBackupArtifact {
  sourcePath: string;
  present: boolean;
  byteSize: number;
  sha256: string | null;
  createdAt: string;
}

export interface MigrationBackupManifest {
  version: typeof MIGRATION_BACKUP_VERSION;
  createdAt: string;
  artifacts: Record<ArtifactName, MigrationBackupArtifact>;
}

export interface MigrationBackupResult {
  path: string;
  created: boolean;
  manifest: MigrationBackupManifest;
}

export function getMigrationBackupDir(): string {
  return path.join(getCacheDir(), "migration-backups", MIGRATION_BACKUP_VERSION);
}

function migrationBackupLockPath(): string {
  return path.join(getCacheDir(), "migration-backups", `${MIGRATION_BACKUP_VERSION}.lock`);
}

function expectedSourcePaths(): Record<ArtifactName, string> {
  return {
    "config.json": getConfigPath(),
    "state.db": getStateDbPathInDataDir(),
    "workflow.db": getWorkflowDbPath(),
  };
}

function sha256File(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function ownerOnlyMode(filePath: string, directory: boolean): boolean {
  if (process.platform === "win32") return true;
  const mode = fs.statSync(filePath).mode & 0o777;
  return mode === (directory ? 0o700 : 0o600);
}

function fsyncDirectory(directory: string): void {
  try {
    const fd = fs.openSync(directory, "r");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EISDIR" && code !== "EPERM") throw error;
  }
}

function parseManifest(bundlePath: string): MigrationBackupManifest {
  const manifestPath = path.join(bundlePath, "manifest.json");
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new ConfigError(
      `Migration backup at ${bundlePath} is incomplete or unreadable: ${error instanceof Error ? error.message : String(error)}. Remove it only after preserving any recoverable files, then retry backup creation.`,
      "INVALID_CONFIG_FILE",
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigError(`Migration backup manifest at ${manifestPath} is invalid.`, "INVALID_CONFIG_FILE");
  }
  const manifest = value as Partial<MigrationBackupManifest>;
  if (manifest.version !== MIGRATION_BACKUP_VERSION || typeof manifest.createdAt !== "string") {
    throw new ConfigError(
      `Migration backup manifest at ${manifestPath} has an unsupported version.`,
      "INVALID_CONFIG_FILE",
    );
  }
  const expected = expectedSourcePaths();
  for (const name of ARTIFACT_NAMES) {
    const artifact = manifest.artifacts?.[name];
    if (
      !artifact ||
      artifact.sourcePath !== expected[name] ||
      typeof artifact.present !== "boolean" ||
      !Number.isSafeInteger(artifact.byteSize) ||
      artifact.byteSize < 0 ||
      typeof artifact.createdAt !== "string" ||
      (artifact.present
        ? typeof artifact.sha256 !== "string" || artifact.sha256.length !== 64
        : artifact.sha256 !== null)
    ) {
      throw new ConfigError(`Migration backup manifest has an invalid ${name} entry.`, "INVALID_CONFIG_FILE");
    }
  }
  return manifest as MigrationBackupManifest;
}

/** Verify the complete bundle, including source-path binding, modes, sizes, and hashes. */
export function verifyMigrationBackup(bundlePath = getMigrationBackupDir()): MigrationBackupManifest {
  if (!fs.existsSync(bundlePath) || !fs.statSync(bundlePath).isDirectory()) {
    throw new ConfigError(`Migration backup does not exist at ${bundlePath}.`, "INVALID_CONFIG_FILE");
  }
  if (!ownerOnlyMode(bundlePath, true)) {
    throw new ConfigError(`Migration backup directory ${bundlePath} must have mode 0700.`, "INVALID_CONFIG_FILE");
  }
  const manifest = parseManifest(bundlePath);
  const expectedFiles = new Set(["manifest.json"]);
  for (const name of ARTIFACT_NAMES) {
    const artifact = manifest.artifacts[name];
    const artifactPath = path.join(bundlePath, name);
    if (!artifact.present) {
      if (fs.existsSync(artifactPath)) {
        throw new ConfigError(
          `Migration backup contains ${name}, but its manifest records it absent.`,
          "INVALID_CONFIG_FILE",
        );
      }
      continue;
    }
    expectedFiles.add(name);
    if (!fs.existsSync(artifactPath) || !fs.statSync(artifactPath).isFile()) {
      throw new ConfigError(`Migration backup is missing ${artifactPath}.`, "INVALID_CONFIG_FILE");
    }
    if (!ownerOnlyMode(artifactPath, false)) {
      throw new ConfigError(`Migration backup artifact ${artifactPath} must have mode 0600.`, "INVALID_CONFIG_FILE");
    }
    const stat = fs.statSync(artifactPath);
    if (stat.size !== artifact.byteSize || sha256File(artifactPath) !== artifact.sha256) {
      throw new ConfigError(
        `Migration backup artifact ${artifactPath} failed checksum verification.`,
        "INVALID_CONFIG_FILE",
      );
    }
  }
  if (!ownerOnlyMode(path.join(bundlePath, "manifest.json"), false)) {
    throw new ConfigError(`Migration backup manifest must have mode 0600.`, "INVALID_CONFIG_FILE");
  }
  const extras = fs.readdirSync(bundlePath).filter((name) => !expectedFiles.has(name));
  if (extras.length > 0) {
    throw new ConfigError(`Migration backup contains unexpected files: ${extras.join(", ")}.`, "INVALID_CONFIG_FILE");
  }
  return manifest;
}

function acquireMigrationBackupLock(): () => void {
  const lockPath = migrationBackupLockPath();
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(lockPath), 0o700);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const ownership = tryAcquireLockSync(lockPath, createLockPayload());
    if (ownership) return () => releaseLock(ownership);
    const probe = probeLock(lockPath);
    if (probe.state === "stale" && reclaimStaleLock(lockPath, probe)) {
      continue;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  throw new ConfigError(`Timed out waiting for migration backup lock at ${lockPath}.`, "INVALID_CONFIG_FILE");
}

function assertNotAlreadyCutOver(): void {
  const configPath = getConfigPath();
  let text: string;
  try {
    text = fs.readFileSync(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const raw = parseConfigText(text, configPath);
  if (raw.configVersion === CURRENT_CONFIG_VERSION) {
    throw new ConfigError(
      `Refusing to create a pre-0.9 migration backup from an existing ${CURRENT_CONFIG_VERSION} config at ${configPath}. Restore the original migration bundle or pre-cutover config before retrying.`,
      "INVALID_CONFIG_FILE",
    );
  }
}

function copyRegularArtifact(source: string, destination: string): void {
  const stat = fs.statSync(source);
  if (!stat.isFile()) throw new ConfigError(`Backup source is not a regular file: ${source}`, "INVALID_CONFIG_FILE");
  writeFileAtomic(destination, fs.readFileSync(source), 0o600);
  fs.chmodSync(destination, 0o600);
}

function sqliteQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function backupSqlite(source: string, destination: string): void {
  const stat = fs.statSync(source);
  if (!stat.isFile())
    throw new ConfigError(`SQLite backup source is not a regular file: ${source}`, "INVALID_CONFIG_FILE");
  const resolvedSource = path.resolve(source);
  const activityName =
    resolvedSource === path.resolve(getWorkflowDbPath())
      ? "workflow-db"
      : resolvedSource === path.resolve(getStateDbPathInDataDir())
        ? "state-db"
        : undefined;
  const releaseActivity = activityName ? acquireMaintenanceActivitySync(activityName) : undefined;
  // The source was stat-verified above. Opening without Bun's `create:false`
  // avoids bun:sqlite's SQLITE_MISUSE for that unsupported false option while
  // retaining Node's ordinary existing-file behavior.
  let db: ReturnType<typeof openDatabase> | undefined;
  try {
    db = openDatabase(source);
    db.exec("PRAGMA busy_timeout = 10000");
    db.exec("PRAGMA wal_checkpoint(FULL)");
    db.exec(`VACUUM INTO ${sqliteQuote(destination)}`);
  } finally {
    try {
      db?.close();
    } finally {
      releaseActivity?.();
    }
  }
  fs.chmodSync(destination, 0o600);
  const fd = fs.openSync(destination, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function createMigrationBackupUnlocked(): MigrationBackupResult {
  const bundlePath = getMigrationBackupDir();
  if (fs.existsSync(bundlePath)) {
    return { path: bundlePath, created: false, manifest: verifyMigrationBackup(bundlePath) };
  }
  assertNotAlreadyCutOver();

  const parent = path.dirname(bundlePath);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  fs.chmodSync(parent, 0o700);
  const temporary = path.join(parent, `.0.9.0.tmp.${process.pid}.${crypto.randomBytes(8).toString("hex")}`);
  fs.mkdirSync(temporary, { mode: 0o700 });
  const createdAt = new Date().toISOString();
  const sources = expectedSourcePaths();
  const artifacts = {} as Record<ArtifactName, MigrationBackupArtifact>;
  try {
    for (const name of ARTIFACT_NAMES) {
      const sourcePath = sources[name];
      const destination = path.join(temporary, name);
      let present = true;
      try {
        fs.statSync(sourcePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") present = false;
        else throw error;
      }
      if (present) {
        if (name === "config.json") copyRegularArtifact(sourcePath, destination);
        else backupSqlite(sourcePath, destination);
      }
      const byteSize = present ? fs.statSync(destination).size : 0;
      artifacts[name] = {
        sourcePath,
        present,
        byteSize,
        sha256: present ? sha256File(destination) : null,
        createdAt,
      };
    }
    const manifest: MigrationBackupManifest = { version: MIGRATION_BACKUP_VERSION, createdAt, artifacts };
    writeFileAtomic(path.join(temporary, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, 0o600);
    fs.chmodSync(path.join(temporary, "manifest.json"), 0o600);
    fsyncDirectory(temporary);
    fs.renameSync(temporary, bundlePath);
    fsyncDirectory(parent);
    return { path: bundlePath, created: true, manifest: verifyMigrationBackup(bundlePath) };
  } catch (error) {
    fs.rmSync(temporary, { recursive: true, force: true });
    if (fs.existsSync(bundlePath)) {
      throw new ConfigError(
        `Migration backup creation raced with another writer and left ${bundlePath}. Verify or preserve it before retrying.`,
        "INVALID_CONFIG_FILE",
      );
    }
    throw error;
  }
}

function withMigrationBackupLock<T>(fn: () => T): T {
  const release = acquireMigrationBackupLock();
  try {
    return fn();
  } finally {
    release();
  }
}

/** Create or verify the immutable pre-cutover bundle. Safe for raw legacy config. */
export function createMigrationBackup(): MigrationBackupResult {
  return withConfigLock(() => withMigrationBackupLock(createMigrationBackupUnlocked));
}

/** Used while a config mutation already owns config.json.lck. */
export function ensureMigrationBackupWithConfigLockHeld(): MigrationBackupResult {
  return withMigrationBackupLock(createMigrationBackupUnlocked);
}

/** Used by database migration hooks before applying the first 0.9 migration. */
export function ensureMigrationBackup(): MigrationBackupResult {
  return createMigrationBackup();
}

function activeRestoreLocks(): string[] {
  const lockPaths = [getLockfileLockPath(), getIndexWriterLockPath()];
  const configLock = path.join(path.dirname(getConfigPath()), "config.json.lck");
  const dataDir = getDataDir();
  for (const name of ["improve.lock", "consolidate.lock", "reflect-distill.lock", "triage.lock"]) {
    lockPaths.push(path.join(dataDir, name));
  }
  const stashDirs = new Set<string>();
  for (const configPath of [getConfigPath(), path.join(getMigrationBackupDir(), "config.json")]) {
    try {
      const raw = parseConfigText(fs.readFileSync(configPath, "utf8"), configPath);
      if (typeof raw.stashDir === "string" && raw.stashDir) stashDirs.add(raw.stashDir);
    } catch {
      // Restore still verifies the bundle. A malformed live config must not
      // prevent recovery; it simply cannot contribute an extra stash lock path.
    }
  }
  for (const stashDir of stashDirs) {
    for (const name of ["improve.lock", "consolidate.lock", "reflect-distill.lock", "triage.lock"]) {
      lockPaths.push(path.join(stashDir, ".akm", name));
    }
  }
  for (const baseDir of [dataDir, ...[...stashDirs].map((stashDir) => path.join(stashDir, ".akm"))]) {
    const extractLockDir = path.join(baseDir, "extract-locks");
    try {
      for (const entry of fs.readdirSync(extractLockDir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith(".lock")) lockPaths.push(path.join(extractLockDir, entry.name));
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const activityDir = path.join(path.dirname(getLockfileLockPath()), "maintenance-activities");
  try {
    for (const entry of fs.readdirSync(activityDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".lock")) lockPaths.push(path.join(activityDir, entry.name));
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return [configLock, ...lockPaths].filter((lockPath) => {
    const probe = probeLock(lockPath);
    return probe.state === "held" && (lockPath !== configLock || probe.holderPid !== process.pid);
  });
}

function activeWorkflowClaims(): string[] {
  const workflowPath = getWorkflowDbPath();
  if (!fs.existsSync(workflowPath)) return [];
  // Restore already owns the maintenance barrier for this handle's complete
  // lifetime. Registering a normal workflow-db activity here would re-enter
  // that barrier and deadlock against ourselves.
  const db = openDatabase(workflowPath, { readonly: true });
  try {
    const runsTable = db
      .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'workflow_runs'")
      .get();
    const blockers: string[] = [];
    if (runsTable) {
      const columns = new Set(
        (db.prepare("PRAGMA table_info(workflow_runs)").all() as Array<{ name: string }>).map((row) => row.name),
      );
      if (columns.has("engine_lease_holder") && columns.has("engine_lease_until")) {
        const now = new Date().toISOString();
        blockers.push(
          ...(
            db
              .prepare(
                `SELECT id, engine_lease_holder AS holder, engine_lease_until AS expires
                 FROM workflow_runs
                 WHERE engine_lease_holder IS NOT NULL AND engine_lease_until IS NOT NULL AND engine_lease_until >= ?`,
              )
              .all(now) as Array<{ id: string; holder: string; expires: string }>
          ).map((lease) => `${workflowPath}#run=${lease.id},holder=${lease.holder},expires=${lease.expires}`),
        );
      }
    }
    const unitsTable = db
      .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'workflow_run_units'")
      .get();
    if (!unitsTable) return blockers;
    const unitColumns = new Set(
      (db.prepare("PRAGMA table_info(workflow_run_units)").all() as Array<{ name: string }>).map((row) => row.name),
    );
    if (!unitColumns.has("claim_holder") || !unitColumns.has("claim_expires_at")) return blockers;
    const now = new Date().toISOString();
    blockers.push(
      ...(
        db
          .prepare(
            `SELECT run_id AS runId, unit_id AS unitId, claim_holder AS holder, claim_expires_at AS expires
             FROM workflow_run_units
             WHERE status = 'running' AND claim_holder IS NOT NULL
               AND claim_expires_at IS NOT NULL AND claim_expires_at >= ?`,
          )
          .all(now) as Array<{ runId: string; unitId: string; holder: string; expires: string }>
      ).map(
        (claim) =>
          `${workflowPath}#run=${claim.runId},unit=${claim.unitId},holder=${claim.holder},expires=${claim.expires}`,
      ),
    );
    return blockers;
  } finally {
    db.close();
  }
}

function restoreArtifact(source: string, destination: string): void {
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  writeFileAtomic(destination, fs.readFileSync(source), 0o600);
  fs.chmodSync(destination, 0o600);
}

/** Restore exactly the manifest's original presence/absence state. */
export function restoreMigrationBackup(confirm: boolean): MigrationBackupResult {
  if (!confirm) {
    throw new ConfigError("Migration backup restore requires --confirm.", "INVALID_CONFIG_FILE");
  }
  return withConfigLock(() =>
    withMigrationBackupLock(() => {
      return withMaintenanceStartBarrier(() => {
        const blockers = [...activeRestoreLocks(), ...activeWorkflowClaims()];
        if (blockers.length > 0) {
          throw new ConfigError(
            `Refusing restore while AKM locks or workflow leases are active: ${blockers.join(", ")}.`,
            "INVALID_CONFIG_FILE",
          );
        }
        const bundlePath = getMigrationBackupDir();
        const manifest = verifyMigrationBackup(bundlePath);
        for (const name of ARTIFACT_NAMES) {
          const artifact = manifest.artifacts[name];
          if (artifact.present) restoreArtifact(path.join(bundlePath, name), artifact.sourcePath);
          else fs.rmSync(artifact.sourcePath, { force: true });
          fs.rmSync(`${artifact.sourcePath}-wal`, { force: true });
          fs.rmSync(`${artifact.sourcePath}-shm`, { force: true });
        }
        return { path: bundlePath, created: false, manifest };
      });
    }),
  );
}
