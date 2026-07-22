// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { migrateConfigSourcesToBundles } from "../migrate/legacy/config-source-migration";
import { getLegacyWorkflowDbPath } from "../migrate/legacy/legacy-paths";
import { WORKFLOW_MIGRATIONS_CHECKSUMS } from "../migrate/legacy/workflow-migrations-frozen";
import { type Database, openDatabaseFinalizing } from "../storage/database";
import {
  inspectMigrationLedger,
  inspectSealedMigrationLedger,
  type Migration,
  type MigrationLedgerState,
  type SealedMigration,
} from "../storage/engines/sqlite-migrations";
import { MAX_CONFIG_FILE_BYTES, MAX_LOCAL_METADATA_BYTES, readTextFileWithLimit, writeFileAtomic } from "./common";
import { parseConfigText, withConfigLock } from "./config/config-io";
import { CURRENT_CONFIG_VERSION, validateConfigShape } from "./config/config-schema";
import { compareConfigVersion } from "./config/config-version";
import { ConfigError } from "./errors";
import { createLockPayload, probeLock, reclaimStaleLock, releaseLock, tryAcquireLockSync } from "./file-lock";
import { acquireMaintenanceActivitySync, withMaintenanceStartBarrier } from "./maintenance-barrier";
import {
  getMigrationApplyJournalPath,
  getMigrationOperationRoot,
  getMigrationRestoreJournalPath,
} from "./migration-operation";
import {
  getConfigPath,
  getDataDir,
  getDbPath,
  getIndexWriterLockPath,
  getLockfileLockPath,
  getStateDbPathInDataDir,
} from "./paths";
import { STATE_MIGRATIONS } from "./state/migrations";

export const MIGRATION_BACKUP_VERSION = "0.9.0" as const;
const MANIFEST_FORMAT_VERSION = 3 as const;
/** Pre-cutover manifests (three artifacts, no index.db) stay readable and restorable (plan §3.3 item 1). */
const LEGACY_MANIFEST_FORMAT_VERSION = 2 as const;
const RESTORE_JOURNAL_FORMAT_VERSION = 2 as const;
const CORE_ARTIFACT_NAMES = ["config.json", "state.db", "workflow.db"] as const;
// index.db joined the backup set at manifest v3 (chunk-8 WI-8.1): it is a
// regenerable cache backed up ONLY as the pre-rescue home of usage_events,
// which the three-DB cutover moves into state.db (plan §3.2/§3.3).
const ARTIFACT_NAMES = [...CORE_ARTIFACT_NAMES, "index.db"] as const;
const MAX_BLOCKER_DIRECTORY_SAMPLES = 100;
const MAX_WORKFLOW_BLOCKER_SAMPLES = 100;
const MAX_BLOCKER_FIELD_BYTES = 256;
const MAX_BLOCKER_ITEM_BYTES = 512;
const MAX_BLOCKER_DIAGNOSTIC_BYTES = 16 * 1024;
type CoreArtifactName = (typeof CORE_ARTIFACT_NAMES)[number];
type ArtifactName = (typeof ARTIFACT_NAMES)[number];
type ManifestFormatVersion = typeof MANIFEST_FORMAT_VERSION | typeof LEGACY_MANIFEST_FORMAT_VERSION;

/** The artifact set a manifest of the given format version records (v2 = pre-cutover three-artifact shape). */
function artifactNamesFor(formatVersion: ManifestFormatVersion): readonly ArtifactName[] {
  return formatVersion === LEGACY_MANIFEST_FORMAT_VERSION ? CORE_ARTIFACT_NAMES : ARTIFACT_NAMES;
}
export type MigrationArtifactStatus = "old" | "current" | "newer" | "inconsistent" | "missing" | "corrupt";

export interface MigrationArtifactState {
  status: MigrationArtifactStatus;
  migrationIds?: string[];
  migrationChecksums?: Array<string | null>;
  detail?: string;
}

export interface MigrationState {
  config: MigrationArtifactState;
  state: MigrationArtifactState;
  workflow: MigrationArtifactState;
  /** index.db recoverability ("current" | "missing" | "corrupt") — never blocks backup eligibility. */
  index: MigrationArtifactState;
}

export interface MigrationBackupArtifact extends MigrationArtifactState {
  sourcePath: string;
  present: boolean;
  byteSize: number;
  sha256: string | null;
  createdAt: string;
}

export interface MigrationBackupManifest {
  formatVersion: ManifestFormatVersion;
  version: typeof MIGRATION_BACKUP_VERSION;
  targetVersion: typeof MIGRATION_BACKUP_VERSION;
  installationId: string;
  runId: string;
  createdAt: string;
  complete: true;
  /** v2 manifests carry only the three core artifacts; index.db exists from v3 on. */
  artifacts: Record<CoreArtifactName, MigrationBackupArtifact> & { "index.db"?: MigrationBackupArtifact };
}

/** Artifact lookup that enforces the per-version presence parseManifest guarantees. */
function manifestArtifact(manifest: MigrationBackupManifest, name: ArtifactName): MigrationBackupArtifact {
  const artifact = manifest.artifacts[name];
  if (!artifact) {
    throw new ConfigError(`Migration backup manifest is missing its ${name} entry.`, "INVALID_CONFIG_FILE");
  }
  return artifact;
}

export interface MigrationBackupResult {
  path: string;
  created: boolean;
  manifest: MigrationBackupManifest;
  rescuePath?: string;
}

export function getMigrationBackupRoot(): string {
  return getMigrationOperationRoot();
}

export { getMigrationApplyJournalPath, getMigrationRestoreJournalPath } from "./migration-operation";

export function getMigrationBackupDir(runId?: string): string {
  if (!runId) return getMigrationBackupRoot();
  if (!/^[A-Za-z0-9._-]+$/.test(runId)) {
    throw new ConfigError(`Invalid migration backup run ID ${JSON.stringify(runId)}.`, "INVALID_CONFIG_FILE");
  }
  return path.join(getMigrationBackupRoot(), runId);
}

function migrationBackupLockPath(): string {
  return path.join(getMigrationBackupRoot(), ".lock");
}

function restoreJournalPath(): string {
  return getMigrationRestoreJournalPath();
}

function expectedSourcePaths(): Record<ArtifactName, string> {
  return {
    "config.json": getConfigPath(),
    "state.db": getStateDbPathInDataDir(),
    "workflow.db": getLegacyWorkflowDbPath(),
    "index.db": getDbPath(),
  };
}

function sha256File(filePath: string): string {
  const hash = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const fd = fs.openSync(filePath, "r");
  try {
    while (true) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

function fsyncFile(filePath: string): void {
  const fd = fs.openSync(filePath, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
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

function copyFileDurable(source: string, destination: string): void {
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(destination, 0o600);
  fsyncFile(destination);
}

function ownerOnlyMode(filePath: string, directory: boolean): boolean {
  if (process.platform === "win32") return true;
  const mode = fs.statSync(filePath).mode & 0o777;
  return mode === (directory ? 0o700 : 0o600);
}

function mapLedgerState(state: MigrationLedgerState): MigrationArtifactState {
  return {
    status: state.status,
    migrationIds: state.migrationIds,
    migrationChecksums: state.checksums,
    ...(state.detail ? { detail: state.detail } : {}),
  };
}

/**
 * True when a raw config carries a WELL-FORMED pre-cutover source shape
 * (a non-empty `stashDir` string, or a `sources`/`installed` array) and has NOT
 * yet grown the 0.9.0 `bundles` map. Such a config is the version-current-but-
 * OLD-SHAPE case that the config-shape migration (WI-8.4) rewrites; the
 * post-cutover strict schema hard-rejects those keys, so {@link inspectConfig}
 * must probe them through the migrator-normalizing validator (NOT raw
 * `validateConfigShape`) to keep classifying it "old" (migration-eligible)
 * rather than "corrupt".
 *
 * Well-formedness matters: a MALFORMED old key (e.g. `sources: "not-an-array"`)
 * is NOT a valid old shape, so it falls through to `validateConfigShape` and is
 * correctly reported "corrupt". A config carrying BOTH `bundles` and an old key
 * is half-migrated — also not this shape — and `validateConfigShape` rejects it.
 */
function isPreCutoverSourceShape(raw: Record<string, unknown>): boolean {
  if (raw.bundles !== undefined) return false;
  return (
    (typeof raw.stashDir === "string" && raw.stashDir.length > 0) ||
    Array.isArray(raw.sources) ||
    Array.isArray(raw.installed)
  );
}

function inspectConfig(configPath: string): MigrationArtifactState {
  if (!fs.existsSync(configPath)) return { status: "missing" };
  try {
    const raw = parseConfigText(readTextFileWithLimit(configPath, MAX_CONFIG_FILE_BYTES, "Config file"), configPath);
    const comparison = compareConfigVersion(raw.configVersion as string | number | undefined, CURRENT_CONFIG_VERSION);
    if (comparison === undefined) return { status: "inconsistent", detail: "configVersion is missing or invalid" };
    if (comparison < 0) return { status: "old" };
    if (comparison > 0) return { status: "newer" };
    // 0.9.0 config-shape cutover: a well-formed pre-cutover config (no `bundles`)
    // is migration-eligible → "old". The strict schema hard-rejects the retired
    // keys, so normalize old→bundles via the migrator FIRST, then validate the
    // RESULT: a valid normalization is "old"; an old shape that stays invalid
    // after normalization (or a malformed/half-migrated config) is "corrupt".
    if (isPreCutoverSourceShape(raw)) {
      const validatedMigrated = validateConfigShape(migrateConfigSourcesToBundles(raw));
      if (validatedMigrated.ok) return { status: "old" };
      return {
        status: "corrupt",
        detail: validatedMigrated.errors.map((issue) => `${issue.path}: ${issue.message}`).join("; "),
      };
    }
    const validated = validateConfigShape(raw);
    if (!validated.ok) {
      // Malformed at 0.9.0 — including a half-migrated config carrying `bundles`
      // alongside a retired source key, or a malformed old key (rejected by superRefine).
      return {
        status: "corrupt",
        detail: validated.errors.map((issue) => `${issue.path}: ${issue.message}`).join("; "),
      };
    }
    return { status: "current" };
  } catch (error) {
    return { status: "corrupt", detail: error instanceof Error ? error.message : String(error) };
  }
}

function quickCheck(db: ReturnType<typeof openDatabaseFinalizing>, filePath: string): void {
  const rows = db.prepare("PRAGMA quick_check").all() as Array<Record<string, unknown>>;
  if (rows.length !== 1 || Object.values(rows[0]!)[0] !== "ok") {
    throw new ConfigError(`SQLite quick_check failed for ${filePath}.`, "INVALID_CONFIG_FILE");
  }
}

function inspectSqlite(filePath: string, migrations: readonly Migration[]): MigrationArtifactState {
  if (!fs.existsSync(filePath)) return { status: "missing" };
  let db: ReturnType<typeof openDatabaseFinalizing> | undefined;
  try {
    db = openDatabaseFinalizing(filePath, { readonly: true });
    quickCheck(db, filePath);
    return mapLedgerState(inspectMigrationLedger(db, migrations));
  } catch (error) {
    return { status: "corrupt", detail: error instanceof Error ? error.message : String(error) };
  } finally {
    db?.close();
  }
}

/**
 * Ledger inspection against a FROZEN `{ id, checksum }` copy. Used for
 * workflow.db, whose live `WORKFLOW_MIGRATIONS` array is deleted at the
 * three-DB cutover (WI-8.3) but whose pre-cutover backups must stay verifiable
 * (plan §3.3 item 1). Behaviourally identical to {@link inspectSqlite}.
 */
function inspectSqliteSealed(filePath: string, sealed: readonly SealedMigration[]): MigrationArtifactState {
  if (!fs.existsSync(filePath)) return { status: "missing" };
  let db: ReturnType<typeof openDatabaseFinalizing> | undefined;
  try {
    db = openDatabaseFinalizing(filePath, { readonly: true });
    quickCheck(db, filePath);
    return mapLedgerState(inspectSealedMigrationLedger(db, sealed));
  } catch (error) {
    return { status: "corrupt", detail: error instanceof Error ? error.message : String(error) };
  } finally {
    db?.close();
  }
}

/**
 * index.db is NOT ledger-migrated (it uses the index-schema.ts DB_VERSION
 * scheme, rebuilt rather than migrated), so its recoverability inspection is
 * presence + SQLite quick_check only: "current" means readable and
 * integrity-clean. It is backed up solely as the pre-rescue usage_events home.
 */
function inspectIndexDbArtifact(filePath: string): MigrationArtifactState {
  if (!fs.existsSync(filePath)) return { status: "missing" };
  let db: ReturnType<typeof openDatabaseFinalizing> | undefined;
  try {
    db = openDatabaseFinalizing(filePath, { readonly: true });
    quickCheck(db, filePath);
    return { status: "current" };
  } catch (error) {
    return { status: "corrupt", detail: error instanceof Error ? error.message : String(error) };
  } finally {
    db?.close();
  }
}

/** Recoverability inspection per artifact (state.db live ledger; workflow.db frozen copy; index.db quick_check). */
function inspectLedgerArtifact(name: Exclude<ArtifactName, "config.json">, filePath: string): MigrationArtifactState {
  if (name === "state.db") return inspectSqlite(filePath, STATE_MIGRATIONS);
  if (name === "workflow.db") return inspectSqliteSealed(filePath, WORKFLOW_MIGRATIONS_CHECKSUMS);
  return inspectIndexDbArtifact(filePath);
}

export function inspectMigrationState(): MigrationState {
  return {
    config: inspectConfig(getConfigPath()),
    state: inspectSqlite(getStateDbPathInDataDir(), STATE_MIGRATIONS),
    workflow: inspectSqliteSealed(getLegacyWorkflowDbPath(), WORKFLOW_MIGRATIONS_CHECKSUMS),
    index: inspectIndexDbArtifact(getDbPath()),
  };
}

function assertBackupEligible(state: MigrationState): void {
  // index.db is deliberately absent here: an unreadable index.db is excluded
  // from the backup (regenerable cache; the cutover's usage_events rescue
  // reports an empty result) rather than blocking migration entirely.
  const entries: Array<[string, MigrationArtifactState]> = [
    ["config.json", state.config],
    ["state.db", state.state],
    ["workflow.db", state.workflow],
  ];
  const unsafe = entries.filter(([, artifact]) => ["newer", "inconsistent", "corrupt"].includes(artifact.status));
  if (unsafe.length > 0) {
    throw new ConfigError(
      `Refusing migration backup because artifact state is unsafe: ${unsafe
        .map(([name, artifact]) => `${name}=${artifact.status}${artifact.detail ? ` (${artifact.detail})` : ""}`)
        .join(", ")}.`,
      "INVALID_CONFIG_FILE",
    );
  }
}

function parseManifest(bundlePath: string): MigrationBackupManifest {
  const manifestPath = path.join(bundlePath, "manifest.json");
  let value: unknown;
  try {
    value = JSON.parse(readTextFileWithLimit(manifestPath, MAX_LOCAL_METADATA_BYTES, "Migration manifest"));
  } catch (error) {
    throw new ConfigError(
      `Migration backup at ${bundlePath} is incomplete or unreadable: ${error instanceof Error ? error.message : String(error)}.`,
      "INVALID_CONFIG_FILE",
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigError(`Migration backup manifest at ${manifestPath} is invalid.`, "INVALID_CONFIG_FILE");
  }
  const manifest = value as Partial<MigrationBackupManifest>;
  if (
    (manifest.formatVersion !== MANIFEST_FORMAT_VERSION && manifest.formatVersion !== LEGACY_MANIFEST_FORMAT_VERSION) ||
    manifest.version !== MIGRATION_BACKUP_VERSION ||
    manifest.targetVersion !== MIGRATION_BACKUP_VERSION ||
    manifest.installationId !== path.basename(getMigrationOperationRoot()) ||
    typeof manifest.runId !== "string" ||
    path.basename(bundlePath) !== manifest.runId ||
    typeof manifest.createdAt !== "string" ||
    manifest.complete !== true
  ) {
    throw new ConfigError(
      `Migration backup manifest at ${manifestPath} is foreign or unsupported.`,
      "INVALID_CONFIG_FILE",
    );
  }
  const expected = expectedSourcePaths();
  for (const name of artifactNamesFor(manifest.formatVersion as ManifestFormatVersion)) {
    const artifact = manifest.artifacts?.[name];
    // index.db is never ledger-classified: "current" (readable) or "missing" only.
    const allowedStatuses = name === "index.db" ? ["current", "missing"] : ["old", "current", "missing"];
    if (
      !artifact ||
      artifact.sourcePath !== expected[name] ||
      typeof artifact.present !== "boolean" ||
      !Number.isSafeInteger(artifact.byteSize) ||
      artifact.byteSize < 0 ||
      typeof artifact.createdAt !== "string" ||
      !allowedStatuses.includes(artifact.status) ||
      (artifact.present
        ? typeof artifact.sha256 !== "string" || artifact.sha256.length !== 64
        : artifact.sha256 !== null || artifact.status !== "missing")
    ) {
      throw new ConfigError(`Migration backup manifest has an invalid ${name} entry.`, "INVALID_CONFIG_FILE");
    }
  }
  return manifest as MigrationBackupManifest;
}

function sameState(actual: MigrationArtifactState, expected: MigrationBackupArtifact): boolean {
  return (
    actual.status === expected.status &&
    JSON.stringify(actual.migrationIds ?? []) === JSON.stringify(expected.migrationIds ?? []) &&
    JSON.stringify(actual.migrationChecksums ?? []) === JSON.stringify(expected.migrationChecksums ?? [])
  );
}

function verifyArtifactAgainstManifest(
  filePath: string,
  name: ArtifactName,
  artifact: MigrationBackupArtifact,
  context: string,
): void {
  if (!artifact.present) {
    if (fs.existsSync(filePath)) {
      throw new ConfigError(
        `${context} ${name} should be absent according to the selected backup.`,
        "INVALID_CONFIG_FILE",
      );
    }
    return;
  }
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new ConfigError(`${context} ${name} is missing or is not a regular file.`, "INVALID_CONFIG_FILE");
  }
  const stat = fs.statSync(filePath);
  if (stat.size !== artifact.byteSize || sha256File(filePath) !== artifact.sha256) {
    throw new ConfigError(`${context} ${name} failed size/checksum authentication.`, "INVALID_CONFIG_FILE");
  }
  const inspected = inspectArtifactAt(name, filePath);
  if (!sameState(inspected, artifact)) {
    throw new ConfigError(
      `${context} ${name} failed SQLite/config recoverability verification: expected ${artifact.status}, got ${inspected.status}${inspected.detail ? ` (${inspected.detail})` : ""}.`,
      "INVALID_CONFIG_FILE",
    );
  }
}

export function verifyMigrationBackup(bundlePath = resolveBackupRun()): MigrationBackupManifest {
  if (!fs.existsSync(bundlePath) || !fs.statSync(bundlePath).isDirectory()) {
    throw new ConfigError(`Migration backup does not exist at ${bundlePath}.`, "INVALID_CONFIG_FILE");
  }
  if (!ownerOnlyMode(bundlePath, true)) {
    throw new ConfigError(`Migration backup directory ${bundlePath} must have mode 0700.`, "INVALID_CONFIG_FILE");
  }
  const manifest = parseManifest(bundlePath);
  const expectedFiles = new Set(["manifest.json"]);
  for (const name of artifactNamesFor(manifest.formatVersion)) {
    const artifact = manifestArtifact(manifest, name);
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
    if (!fs.existsSync(artifactPath) || !fs.statSync(artifactPath).isFile() || !ownerOnlyMode(artifactPath, false)) {
      throw new ConfigError(
        `Migration backup artifact ${artifactPath} is missing or has unsafe permissions.`,
        "INVALID_CONFIG_FILE",
      );
    }
    const stat = fs.statSync(artifactPath);
    if (stat.size !== artifact.byteSize || sha256File(artifactPath) !== artifact.sha256) {
      throw new ConfigError(
        `Migration backup artifact ${artifactPath} failed checksum verification.`,
        "INVALID_CONFIG_FILE",
      );
    }
    const inspected = inspectArtifactAt(name, artifactPath);
    if (!sameState(inspected, artifact)) {
      throw new ConfigError(
        `Migration backup artifact ${artifactPath} failed SQLite/config recoverability verification: expected ${artifact.status}, got ${inspected.status}${inspected.detail ? ` (${inspected.detail})` : ""}.`,
        "INVALID_CONFIG_FILE",
      );
    }
  }
  if (!ownerOnlyMode(path.join(bundlePath, "manifest.json"), false)) {
    throw new ConfigError("Migration backup manifest must have mode 0600.", "INVALID_CONFIG_FILE");
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
    if (probe.state === "stale" && reclaimStaleLock(lockPath, probe)) continue;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  throw new ConfigError(`Timed out waiting for migration backup lock at ${lockPath}.`, "INVALID_CONFIG_FILE");
}

function sqliteQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function backupSqlite(source: string, destination: string): void {
  if (!fs.statSync(source).isFile()) {
    throw new ConfigError(`SQLite backup source is not a regular file: ${source}`, "INVALID_CONFIG_FILE");
  }
  const resolvedSource = path.resolve(source);
  const activityName =
    resolvedSource === path.resolve(getLegacyWorkflowDbPath())
      ? "workflow-db"
      : resolvedSource === path.resolve(getStateDbPathInDataDir())
        ? "state-db"
        : undefined;
  const releaseActivity = activityName ? acquireMaintenanceActivitySync(activityName) : undefined;
  let db: ReturnType<typeof openDatabaseFinalizing> | undefined;
  try {
    db = openDatabaseFinalizing(source);
    db.exec("PRAGMA busy_timeout = 10000");
    db.exec(`VACUUM INTO ${sqliteQuote(destination)}`);
  } finally {
    try {
      db?.close();
    } finally {
      releaseActivity?.();
    }
  }
  fs.chmodSync(destination, 0o600);
  fsyncFile(destination);
}

function newRunId(): string {
  return `${new Date().toISOString().replace(/[-:.TZ]/g, "")}-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
}

function stateForName(state: MigrationState, name: ArtifactName): MigrationArtifactState {
  if (name === "config.json") return state.config;
  if (name === "state.db") return state.state;
  if (name === "workflow.db") return state.workflow;
  return state.index;
}

function createMigrationBackupUnlocked(): MigrationBackupResult {
  const state = inspectMigrationState();
  assertBackupEligible(state);
  const root = getMigrationBackupRoot();
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  fs.chmodSync(root, 0o700);
  const runId = newRunId();
  const bundlePath = path.join(root, runId);
  const temporary = path.join(root, `.${runId}.tmp`);
  fs.mkdirSync(temporary, { mode: 0o700 });
  const createdAt = new Date().toISOString();
  const sources = expectedSourcePaths();
  const artifacts = {} as Record<ArtifactName, MigrationBackupArtifact>;
  try {
    for (const name of ARTIFACT_NAMES) {
      const sourcePath = sources[name];
      const sourceState = stateForName(state, name);
      // index.db never blocks a backup: anything short of a clean read
      // (corrupt cache) is recorded as absent — it is regenerable, and the
      // cutover's usage_events rescue reports the empty result.
      const effectiveState =
        name === "index.db" && sourceState.status !== "current" ? { status: "missing" as const } : sourceState;
      const destination = path.join(temporary, name);
      const present = effectiveState.status !== "missing";
      if (present) {
        if (name === "config.json") copyFileDurable(sourcePath, destination);
        else backupSqlite(sourcePath, destination);
      }
      const inspected = present ? inspectArtifactAt(name, destination) : { status: "missing" as const };
      const expectedArtifact = { ...effectiveState, sourcePath, present, byteSize: 0, sha256: null, createdAt };
      if (!sameState(inspected, expectedArtifact)) {
        throw new ConfigError(`Snapshot ${name} does not match its source migration state.`, "INVALID_CONFIG_FILE");
      }
      artifacts[name] = {
        ...effectiveState,
        sourcePath,
        present,
        byteSize: present ? fs.statSync(destination).size : 0,
        sha256: present ? sha256File(destination) : null,
        createdAt,
      };
    }
    const manifest: MigrationBackupManifest = {
      formatVersion: MANIFEST_FORMAT_VERSION,
      version: MIGRATION_BACKUP_VERSION,
      targetVersion: MIGRATION_BACKUP_VERSION,
      installationId: path.basename(getMigrationOperationRoot()),
      runId,
      createdAt,
      complete: true,
      artifacts,
    };
    writeFileAtomic(path.join(temporary, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, 0o600);
    fs.chmodSync(path.join(temporary, "manifest.json"), 0o600);
    fsyncDirectory(temporary);
    fs.renameSync(temporary, bundlePath);
    fsyncDirectory(root);
    return { path: bundlePath, created: true, manifest: verifyMigrationBackup(bundlePath) };
  } catch (error) {
    fs.rmSync(temporary, { recursive: true, force: true });
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

export function createMigrationBackup(): MigrationBackupResult {
  return withConfigLock(() =>
    withMigrationBackupLock(() => withMaintenanceStartBarrier(createMigrationBackupUnlocked)),
  );
}

export function ensureMigrationBackupWithConfigLockHeld(): MigrationBackupResult {
  return withMigrationBackupLock(() => withMaintenanceStartBarrier(createMigrationBackupUnlocked));
}

export function ensureMigrationBackup(): MigrationBackupResult {
  return createMigrationBackup();
}

function sanitizeDiagnosticField(value: unknown, maxBytes = MAX_BLOCKER_FIELD_BYTES): string {
  const source = String(value);
  let output = "";
  let bytes = 0;
  let truncated = false;
  const contentLimit = Math.max(0, maxBytes - 3);
  for (const character of source) {
    const codePoint = character.codePointAt(0) ?? 0;
    const safe = codePoint < 0x20 || codePoint === 0x7f ? "?" : character;
    const width = Buffer.byteLength(safe, "utf8");
    if (bytes + width > contentLimit) {
      truncated = true;
      break;
    }
    output += safe;
    bytes += width;
  }
  if (!truncated && bytes < Buffer.byteLength(source, "utf8")) truncated = true;
  return truncated ? `${output}...` : output;
}

function sampleLockDirectory(directory: string): { paths: string[]; overflow: boolean } {
  let handle: fs.Dir;
  try {
    handle = fs.opendirSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { paths: [], overflow: false };
    throw error;
  }
  const paths: string[] = [];
  let inspected = 0;
  let overflow = false;
  try {
    while (true) {
      const entry = handle.readSync();
      if (!entry) break;
      inspected += 1;
      if (inspected > MAX_BLOCKER_DIRECTORY_SAMPLES) {
        overflow = true;
        break;
      }
      if (entry.isFile() && entry.name.endsWith(".lock")) paths.push(path.join(directory, entry.name));
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { paths: [], overflow: false };
    throw error;
  } finally {
    try {
      handle.closeSync();
    } catch {
      // A concurrently removed directory may already have invalidated the handle.
    }
  }
  return { paths, overflow };
}

function activeRestoreLocks(bundlePath?: string): string[] {
  const lockPaths = [getLockfileLockPath(), getIndexWriterLockPath()];
  const overflowBlockers: string[] = [];
  const configLock = path.join(path.dirname(getConfigPath()), "config.json.lck");
  const dataDir = getDataDir();
  for (const name of ["improve.lock", "consolidate.lock", "reflect-distill.lock", "triage.lock"]) {
    lockPaths.push(path.join(dataDir, name));
  }
  const stashDirs = new Set<string>();
  const configPaths = [getConfigPath(), ...(bundlePath ? [path.join(bundlePath, "config.json")] : [])];
  for (const configPath of configPaths) {
    try {
      const raw = parseConfigText(readTextFileWithLimit(configPath, MAX_CONFIG_FILE_BYTES, "Config file"), configPath);
      if (typeof raw.stashDir === "string" && raw.stashDir) stashDirs.add(raw.stashDir);
    } catch {
      // A malformed or absent config contributes no stash-scoped lock paths.
    }
  }
  for (const stashDir of stashDirs) {
    for (const name of ["improve.lock", "consolidate.lock", "reflect-distill.lock", "triage.lock"]) {
      lockPaths.push(path.join(stashDir, ".akm", name));
    }
  }
  for (const baseDir of [dataDir, ...[...stashDirs].map((stashDir) => path.join(stashDir, ".akm"))]) {
    const extractLockDir = path.join(baseDir, "extract-locks");
    const sample = sampleLockDirectory(extractLockDir);
    lockPaths.push(...sample.paths);
    if (sample.overflow) {
      overflowBlockers.push(`lock directory sample capped: ${sanitizeDiagnosticField(extractLockDir)}`);
    }
  }
  const activityDir = path.join(path.dirname(getLockfileLockPath()), "maintenance-activities");
  const activitySample = sampleLockDirectory(activityDir);
  lockPaths.push(...activitySample.paths);
  if (activitySample.overflow) {
    overflowBlockers.push(`lock directory sample capped: ${sanitizeDiagnosticField(activityDir)}`);
  }
  const active = [configLock, ...lockPaths]
    .filter((lockPath) => {
      const probe = probeLock(lockPath);
      return probe.state === "held" && (lockPath !== configLock || probe.holderPid !== process.pid);
    })
    .map((lockPath) => sanitizeDiagnosticField(lockPath, MAX_BLOCKER_ITEM_BYTES));
  return [...active, ...overflowBlockers];
}

/**
 * Scan ONE open workflow-table home (state.db post-cutover, or a pre-cutover
 * workflow.db) for active engine leases + unit claims, tagging each blocker with
 * `dbPath` so the operator can tell which artifact holds the lock. Same blocker
 * semantics for both sources — the tables/columns are byte-identical between the
 * pre-cutover workflow.db and the merged state.db (state migration 020 folds the
 * final shape).
 */
function scanWorkflowClaimsFrom(db: Database, dbPath: string, maxSamples: number): string[] {
  const blockers: string[] = [];
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='workflow_runs'").get()) {
    const columns = new Set(
      (db.prepare("PRAGMA table_info(workflow_runs)").all() as Array<{ name: string }>).map((row) => row.name),
    );
    if (columns.has("engine_lease_holder") && columns.has("engine_lease_until")) {
      const leases = db
        .prepare(
          `SELECT substr(CAST(id AS TEXT), 1, 257) AS id, substr(CAST(engine_lease_holder AS TEXT), 1, 257) AS holder, substr(CAST(engine_lease_until AS TEXT), 1, 129) AS expires FROM workflow_runs WHERE engine_lease_holder IS NOT NULL AND engine_lease_until >= ? LIMIT ${maxSamples + 1}`,
        )
        .all(new Date().toISOString()) as Array<{ id: string; holder: string; expires: string }>;
      blockers.push(
        ...leases
          .slice(0, maxSamples)
          .map(
            (lease) =>
              `${sanitizeDiagnosticField(dbPath)}#run=${sanitizeDiagnosticField(lease.id)},holder=${sanitizeDiagnosticField(lease.holder)},expires=${sanitizeDiagnosticField(lease.expires, 128)}`,
          ),
      );
      if (leases.length > maxSamples) {
        blockers.push(`${dbPath}#additional-active-workflow-blockers`);
        return blockers;
      }
    }
  }
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='workflow_run_units'").get())
    return blockers;
  const columns = new Set(
    (db.prepare("PRAGMA table_info(workflow_run_units)").all() as Array<{ name: string }>).map((row) => row.name),
  );
  if (!columns.has("claim_holder") || !columns.has("claim_expires_at")) return blockers;
  const remaining = maxSamples - blockers.length;
  if (remaining <= 0) return blockers;
  const claims = db
    .prepare(
      `SELECT substr(CAST(run_id AS TEXT), 1, 257) AS runId, substr(CAST(unit_id AS TEXT), 1, 257) AS unitId, substr(CAST(claim_holder AS TEXT), 1, 257) AS holder, substr(CAST(claim_expires_at AS TEXT), 1, 129) AS expires FROM workflow_run_units WHERE status='running' AND claim_holder IS NOT NULL AND claim_expires_at >= ? LIMIT ${remaining + 1}`,
    )
    .all(new Date().toISOString()) as Array<{ runId: string; unitId: string; holder: string; expires: string }>;
  blockers.push(
    ...claims
      .slice(0, remaining)
      .map(
        (claim) =>
          `${sanitizeDiagnosticField(dbPath)}#run=${sanitizeDiagnosticField(claim.runId)},unit=${sanitizeDiagnosticField(claim.unitId)},holder=${sanitizeDiagnosticField(claim.holder)},expires=${sanitizeDiagnosticField(claim.expires, 128)}`,
      ),
  );
  if (claims.length > remaining) blockers.push(`${dbPath}#additional-active-workflow-blockers`);
  return blockers;
}

/**
 * Active engine leases / unit claims that must block artifact replacement.
 *
 * Chunk-8 dual source: the durable home of the workflow tables is now state.db
 * (the three-DB cutover merged workflow.db into it via state migration 020), so
 * the primary probe reads state.db. But a PRE-CUTOVER generation still has a
 * physical workflow.db (not yet merged/deleted), so the read-only workflow.db
 * file probe is RETAINED — if that file is present it is scanned too. Both use
 * the same frozen-copy inspection and the same blocker semantics. A read-only
 * open of each avoids ledger assertions / maintenance-activity acquisition
 * during the blocker check.
 */
function activeWorkflowClaims(): string[] {
  const maxSamples = MAX_WORKFLOW_BLOCKER_SAMPLES;
  const blockers: string[] = [];
  for (const dbPath of [getStateDbPathInDataDir(), getLegacyWorkflowDbPath()]) {
    if (!fs.existsSync(dbPath)) continue;
    const db = openDatabaseFinalizing(dbPath, { readonly: true });
    try {
      blockers.push(...scanWorkflowClaimsFrom(db, dbPath, maxSamples));
    } finally {
      db.close();
    }
  }
  return blockers;
}

/** Caller must hold the maintenance start barrier while checking and replacing artifacts. */
export function assertNoArtifactReplacementBlockers(bundlePath?: string): void {
  const blockers = [...activeRestoreLocks(bundlePath), ...activeWorkflowClaims()];
  if (blockers.length > 0) {
    const prefix = "Refusing artifact replacement while AKM locks, activities, or workflow leases are active: ";
    const omission = " ... additional blockers omitted.";
    const punctuation = ".";
    const contentLimit = MAX_BLOCKER_DIAGNOSTIC_BYTES - Buffer.byteLength(omission, "utf8");
    let message = prefix;
    let included = 0;
    for (const blocker of blockers) {
      const item = sanitizeDiagnosticField(blocker, MAX_BLOCKER_ITEM_BYTES);
      const segment = `${included === 0 ? "" : ", "}${item}`;
      if (Buffer.byteLength(message, "utf8") + Buffer.byteLength(segment, "utf8") + 1 > contentLimit) break;
      message += segment;
      included += 1;
    }
    message += included < blockers.length ? omission : punctuation;
    throw new ConfigError(message, "INVALID_CONFIG_FILE");
  }
}

interface RestoreJournalEntry {
  destination: string;
  stage?: string;
  originalPresent: boolean;
  originalFingerprint: FileFingerprint | null;
  quarantine: string;
  sidecars: Array<{
    destination: string;
    originalPresent: boolean;
    originalFingerprint: FileFingerprint | null;
    quarantine: string;
  }>;
}

export interface FileFingerprint {
  byteSize: number;
  sha256: string;
}

export interface MigrationGenerationFingerprint {
  config: { main: FileFingerprint | null; wal: null; shm: null };
  state: { main: FileFingerprint | null; wal: FileFingerprint | null; shm: FileFingerprint | null };
  workflow: { main: FileFingerprint | null; wal: FileFingerprint | null; shm: FileFingerprint | null };
}

function fingerprintFile(filePath: string): FileFingerprint | null {
  if (!fs.existsSync(filePath)) return null;
  const stat = fs.statSync(filePath);
  if (!stat.isFile())
    throw new ConfigError(`Fingerprint source is not a regular file: ${filePath}.`, "INVALID_CONFIG_FILE");
  return { byteSize: stat.size, sha256: sha256File(filePath) };
}

function matchesFingerprint(filePath: string, fingerprint: FileFingerprint | null): boolean {
  if (fingerprint === null) return !fs.existsSync(filePath);
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return false;
  return fs.statSync(filePath).size === fingerprint.byteSize && sha256File(filePath) === fingerprint.sha256;
}

export function fingerprintMigrationGeneration(): MigrationGenerationFingerprint {
  const statePath = getStateDbPathInDataDir();
  const workflowPath = getLegacyWorkflowDbPath();
  return {
    config: { main: fingerprintFile(getConfigPath()), wal: null, shm: null },
    state: {
      main: fingerprintFile(statePath),
      wal: fingerprintFile(`${statePath}-wal`),
      shm: fingerprintFile(`${statePath}-shm`),
    },
    workflow: {
      main: fingerprintFile(workflowPath),
      wal: fingerprintFile(`${workflowPath}-wal`),
      shm: fingerprintFile(`${workflowPath}-shm`),
    },
  };
}

export function sameMigrationGeneration(
  left: MigrationGenerationFingerprint,
  right: MigrationGenerationFingerprint,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

let restoreRollbackBoundaryHook: ((boundary: string) => void) | undefined;

/** TEST-ONLY: inject a crash at a named prepared-restore rollback boundary. */
export function _setRestoreRollbackBoundaryHookForTests(hook?: (boundary: string) => void): void {
  restoreRollbackBoundaryHook = hook;
}

function rollbackBoundary(boundary: string): void {
  restoreRollbackBoundaryHook?.(boundary);
}

interface RestoreJournal {
  formatVersion: typeof RESTORE_JOURNAL_FORMAT_VERSION;
  version: typeof MIGRATION_BACKUP_VERSION;
  operationId: string;
  sourceRunId: string;
  rescueRunId: string;
  phase: "prepared" | "committed";
  entries: RestoreJournalEntry[];
}

function writeRestoreJournal(journal: RestoreJournal): void {
  writeFileAtomic(restoreJournalPath(), `${JSON.stringify(journal, null, 2)}\n`, 0o600);
}

function invalidRestoreJournal(journalPath: string, detail: string): never {
  throw new ConfigError(`Invalid restore journal ${journalPath}: ${detail}.`, "INVALID_CONFIG_FILE");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  const keys = Object.keys(value);
  return (
    required.every((key) => keys.includes(key)) && keys.every((key) => required.includes(key) || optional.includes(key))
  );
}

function parseFileFingerprint(value: unknown, present: boolean, journalPath: string): FileFingerprint | null {
  if (!present) {
    if (value !== null) invalidRestoreJournal(journalPath, "absent original has a non-null fingerprint");
    return null;
  }
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["byteSize", "sha256"]) ||
    !Number.isSafeInteger(value.byteSize) ||
    (value.byteSize as number) < 0 ||
    typeof value.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.sha256)
  ) {
    invalidRestoreJournal(journalPath, "original fingerprint is malformed");
  }
  return { byteSize: value.byteSize as number, sha256: value.sha256 };
}

function isOperationBoundPath(
  candidate: string,
  destination: string,
  kind: "restore-stage" | "restore-quarantine",
  operationId: string,
): boolean {
  const expected = `${destination}.${kind}.${operationId}`;
  return candidate === expected && path.dirname(path.resolve(candidate)) === path.dirname(path.resolve(destination));
}

function validateRestoreJournal(raw: unknown, journalPath: string): RestoreJournal {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, ["formatVersion", "version", "operationId", "sourceRunId", "rescueRunId", "phase", "entries"])
  ) {
    invalidRestoreJournal(journalPath, "expected the complete versioned journal shape");
  }
  if (raw.formatVersion !== RESTORE_JOURNAL_FORMAT_VERSION) {
    invalidRestoreJournal(journalPath, `unsupported formatVersion ${JSON.stringify(raw.formatVersion)}`);
  }
  if (raw.version !== MIGRATION_BACKUP_VERSION) {
    invalidRestoreJournal(journalPath, `unsupported migration version ${JSON.stringify(raw.version)}`);
  }
  if (raw.phase !== "prepared" && raw.phase !== "committed") {
    invalidRestoreJournal(journalPath, `unsupported phase ${JSON.stringify(raw.phase)}`);
  }
  for (const field of ["operationId", "sourceRunId", "rescueRunId"] as const) {
    if (typeof raw[field] !== "string" || !/^[A-Za-z0-9._-]+$/.test(raw[field])) {
      invalidRestoreJournal(journalPath, `${field} is not a safe operation identifier`);
    }
  }
  // The exact entry count depends on the SOURCE manifest's format version
  // (v2 = three artifacts, v3 adds index.db); the precise check happens after
  // the source backup is verified below. Here: bound the shape.
  if (
    !Array.isArray(raw.entries) ||
    (raw.entries.length !== ARTIFACT_NAMES.length && raw.entries.length !== CORE_ARTIFACT_NAMES.length)
  ) {
    invalidRestoreJournal(
      journalPath,
      `expected ${CORE_ARTIFACT_NAMES.length} or ${ARTIFACT_NAMES.length} artifact entries`,
    );
  }

  const operationId = raw.operationId as string;
  const expectedPaths = expectedSourcePaths();
  const byDestination = parseRestoreJournalEntries(raw.entries, operationId, expectedPaths, journalPath);

  const sourceRunId = raw.sourceRunId as string;
  let sourceManifest: MigrationBackupManifest;
  try {
    sourceManifest = verifyMigrationBackup(getMigrationBackupDir(sourceRunId));
  } catch (error) {
    invalidRestoreJournal(
      journalPath,
      `source backup ${sourceRunId} is unavailable or invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const journalNames = artifactNamesFor(sourceManifest.formatVersion);
  if (raw.entries.length !== journalNames.length) {
    invalidRestoreJournal(
      journalPath,
      `expected exactly ${journalNames.length} artifact entries for source backup format ${sourceManifest.formatVersion}`,
    );
  }
  const entries = journalNames.map((name) => byDestination.get(expectedPaths[name]) as RestoreJournalEntry);
  for (const [index, name] of journalNames.entries()) {
    const entry = entries[index];
    if (!entry) {
      invalidRestoreJournal(journalPath, `journal has no entry for ${name}`);
    }
    const artifact = manifestArtifact(sourceManifest, name);
    const expectedStage = artifact.present ? `${entry.destination}.restore-stage.${operationId}` : undefined;
    if (entry.stage !== expectedStage) {
      invalidRestoreJournal(journalPath, `${name} stage presence does not match source backup ${sourceRunId}`);
    }

    if (raw.phase === "committed") {
      if (fs.existsSync(entry.destination) !== artifact.present || (entry.stage && fs.existsSync(entry.stage))) {
        invalidRestoreJournal(journalPath, `committed ${name} publication state is stale`);
      }
      if (fs.existsSync(entry.quarantine) && !matchesFingerprint(entry.quarantine, entry.originalFingerprint)) {
        invalidRestoreJournal(journalPath, `committed ${name} quarantine does not match the original generation`);
      }
      if (entry.sidecars.some((sidecar) => fs.existsSync(sidecar.destination))) {
        invalidRestoreJournal(journalPath, `committed ${name} still has a live sidecar`);
      }
      for (const sidecar of entry.sidecars) {
        if (fs.existsSync(sidecar.quarantine) && !matchesFingerprint(sidecar.quarantine, sidecar.originalFingerprint)) {
          invalidRestoreJournal(journalPath, `committed ${name} sidecar quarantine is not the original generation`);
        }
      }
      verifyArtifactAgainstManifest(entry.destination, name, artifact, "Committed restore publication");
      continue;
    }

    const destinationPresent = fs.existsSync(entry.destination);
    const quarantinePresent = fs.existsSync(entry.quarantine);
    if (entry.originalPresent ? !destinationPresent && !quarantinePresent : quarantinePresent) {
      invalidRestoreJournal(journalPath, `prepared ${name} original state is stale`);
    }
    if (quarantinePresent && !matchesFingerprint(entry.quarantine, entry.originalFingerprint)) {
      invalidRestoreJournal(journalPath, `prepared ${name} quarantine does not match the original generation`);
    }
    if (entry.stage) {
      const stagePresent = fs.existsSync(entry.stage);
      const rolledBack =
        !quarantinePresent && !stagePresent && matchesFingerprint(entry.destination, entry.originalFingerprint);
      const validPublicationState =
        rolledBack ||
        (entry.originalPresent
          ? quarantinePresent
            ? destinationPresent !== stagePresent
            : destinationPresent && stagePresent && matchesFingerprint(entry.destination, entry.originalFingerprint)
          : destinationPresent !== stagePresent);
      if (!validPublicationState) {
        invalidRestoreJournal(journalPath, `prepared ${name} publication state is stale`);
      }
    } else {
      const rolledBack = !quarantinePresent && matchesFingerprint(entry.destination, entry.originalFingerprint);
      const forwardState = entry.originalPresent
        ? quarantinePresent
          ? !destinationPresent
          : destinationPresent && matchesFingerprint(entry.destination, entry.originalFingerprint)
        : !destinationPresent;
      if (!rolledBack && !forwardState) {
        invalidRestoreJournal(journalPath, `prepared absent ${name} has an impossible publication state`);
      }
    }
    for (const sidecar of entry.sidecars) {
      const live = fs.existsSync(sidecar.destination);
      const quarantined = fs.existsSync(sidecar.quarantine);
      const authenticated = quarantined
        ? matchesFingerprint(sidecar.quarantine, sidecar.originalFingerprint)
        : matchesFingerprint(sidecar.destination, sidecar.originalFingerprint);
      if ((sidecar.originalPresent ? live === quarantined : live || quarantined) || !authenticated) {
        invalidRestoreJournal(journalPath, `prepared ${name} sidecar state is stale`);
      }
    }
  }

  return {
    formatVersion: RESTORE_JOURNAL_FORMAT_VERSION,
    version: MIGRATION_BACKUP_VERSION,
    operationId,
    sourceRunId,
    rescueRunId: raw.rescueRunId as string,
    phase: raw.phase,
    entries,
  };
}

/**
 * Parse + validate the journal's per-artifact entries (shape, operation-bound
 * stage/quarantine paths, sidecar sets, global path uniqueness). Returns the
 * entries keyed by destination; the caller checks the set against the SOURCE
 * manifest's per-version artifact list.
 */
function parseRestoreJournalEntries(
  rawEntries: unknown[],
  operationId: string,
  expectedPaths: Record<ArtifactName, string>,
  journalPath: string,
): Map<string, RestoreJournalEntry> {
  const byDestination = new Map<string, RestoreJournalEntry>();
  const allPaths = new Set<string>();
  const registerPath = (candidate: string, label: string): void => {
    const resolved = path.resolve(candidate);
    if (allPaths.has(resolved)) invalidRestoreJournal(journalPath, `${label} path is duplicated: ${candidate}`);
    allPaths.add(resolved);
  };

  for (const value of rawEntries) {
    if (
      !isRecord(value) ||
      !hasExactKeys(
        value,
        ["destination", "originalPresent", "originalFingerprint", "quarantine", "sidecars"],
        ["stage"],
      ) ||
      typeof value.destination !== "string" ||
      typeof value.originalPresent !== "boolean" ||
      typeof value.quarantine !== "string" ||
      !Array.isArray(value.sidecars)
    ) {
      invalidRestoreJournal(journalPath, "artifact entry has an invalid shape");
    }
    const originalFingerprint = parseFileFingerprint(value.originalFingerprint, value.originalPresent, journalPath);
    const artifactName = ARTIFACT_NAMES.find((name) => expectedPaths[name] === value.destination);
    if (!artifactName || byDestination.has(value.destination)) {
      invalidRestoreJournal(journalPath, `artifact destinations are not the exact unique canonical set`);
    }
    if (!isOperationBoundPath(value.quarantine, value.destination, "restore-quarantine", operationId)) {
      invalidRestoreJournal(journalPath, `quarantine path is not bound to operation ${operationId}`);
    }
    if (
      value.stage !== undefined &&
      (typeof value.stage !== "string" ||
        !isOperationBoundPath(value.stage, value.destination, "restore-stage", operationId))
    ) {
      invalidRestoreJournal(journalPath, `stage path is not bound to operation ${operationId}`);
    }

    const expectedSidecarDestinations =
      artifactName === "config.json" ? [] : [`${value.destination}-wal`, `${value.destination}-shm`];
    if (value.sidecars.length !== expectedSidecarDestinations.length) {
      invalidRestoreJournal(journalPath, `${artifactName} has an incomplete sidecar set`);
    }
    const sidecars: RestoreJournalEntry["sidecars"] = [];
    for (const sidecarValue of value.sidecars) {
      if (
        !isRecord(sidecarValue) ||
        !hasExactKeys(sidecarValue, ["destination", "originalPresent", "originalFingerprint", "quarantine"]) ||
        typeof sidecarValue.destination !== "string" ||
        typeof sidecarValue.originalPresent !== "boolean" ||
        typeof sidecarValue.quarantine !== "string" ||
        !expectedSidecarDestinations.includes(sidecarValue.destination)
      ) {
        invalidRestoreJournal(journalPath, `${artifactName} has an invalid sidecar entry`);
      }
      const sidecarFingerprint = parseFileFingerprint(
        sidecarValue.originalFingerprint,
        sidecarValue.originalPresent,
        journalPath,
      );
      if (sidecars.some((sidecar) => sidecar.destination === sidecarValue.destination)) {
        invalidRestoreJournal(journalPath, `${artifactName} has a duplicate sidecar destination`);
      }
      if (!isOperationBoundPath(sidecarValue.quarantine, sidecarValue.destination, "restore-quarantine", operationId)) {
        invalidRestoreJournal(journalPath, `sidecar quarantine path is not bound to operation ${operationId}`);
      }
      sidecars.push({
        destination: sidecarValue.destination,
        originalPresent: sidecarValue.originalPresent,
        originalFingerprint: sidecarFingerprint,
        quarantine: sidecarValue.quarantine,
      });
    }

    registerPath(value.destination, "destination");
    registerPath(value.quarantine, "quarantine");
    if (typeof value.stage === "string") registerPath(value.stage, "stage");
    for (const sidecar of sidecars) {
      registerPath(sidecar.destination, "sidecar destination");
      registerPath(sidecar.quarantine, "sidecar quarantine");
    }
    byDestination.set(value.destination, {
      destination: value.destination,
      ...(typeof value.stage === "string" ? { stage: value.stage } : {}),
      originalPresent: value.originalPresent,
      originalFingerprint,
      quarantine: value.quarantine,
      sidecars,
    });
  }
  return byDestination;
}

function rollbackRestoreJournal(journal: RestoreJournal): void {
  for (const [index, entry] of journal.entries.entries()) {
    if (fs.existsSync(entry.quarantine)) {
      fs.rmSync(entry.destination, { force: true });
      fs.renameSync(entry.quarantine, entry.destination);
    } else if (!entry.originalPresent) {
      fs.rmSync(entry.destination, { force: true });
    }
    rollbackBoundary(`${index}:destination`);
    if (entry.stage) fs.rmSync(entry.stage, { force: true });
    rollbackBoundary(`${index}:stage`);
    for (const [sidecarIndex, sidecar] of entry.sidecars.entries()) {
      if (fs.existsSync(sidecar.quarantine)) {
        fs.rmSync(sidecar.destination, { force: true });
        fs.renameSync(sidecar.quarantine, sidecar.destination);
      } else if (!sidecar.originalPresent) {
        fs.rmSync(sidecar.destination, { force: true });
      }
      rollbackBoundary(`${index}:sidecar:${sidecarIndex}`);
    }
  }
  for (const directory of new Set(journal.entries.map((entry) => path.dirname(entry.destination)))) {
    fsyncDirectory(directory);
  }
  rollbackBoundary("before-journal-delete");
  fs.rmSync(restoreJournalPath(), { force: true });
  fsyncDirectory(path.dirname(restoreJournalPath()));
}

function cleanupCommittedRestore(journal: RestoreJournal): void {
  const directories = new Set<string>();
  for (const entry of journal.entries) {
    directories.add(path.dirname(entry.destination));
    fs.rmSync(entry.quarantine, { force: true });
    if (entry.stage) fs.rmSync(entry.stage, { force: true });
    for (const sidecar of entry.sidecars) fs.rmSync(sidecar.quarantine, { force: true });
  }
  for (const directory of directories) fsyncDirectory(directory);
  fs.rmSync(restoreJournalPath(), { force: true });
  fsyncDirectory(path.dirname(restoreJournalPath()));
}

function recoverInterruptedRestore(): void {
  const journalPath = restoreJournalPath();
  if (!fs.existsSync(journalPath)) return;
  let raw: unknown;
  try {
    raw = JSON.parse(readTextFileWithLimit(journalPath, MAX_LOCAL_METADATA_BYTES, "Restore journal"));
  } catch (error) {
    invalidRestoreJournal(journalPath, error instanceof Error ? error.message : String(error));
  }
  const journal = validateRestoreJournal(raw, journalPath);
  if (journal.phase === "committed") cleanupCommittedRestore(journal);
  else rollbackRestoreJournal(journal);
}

/** Caller must hold the config lock and maintenance barrier. */
export function recoverInterruptedRestoreWithLocksHeld(): void {
  assertNoArtifactReplacementBlockers();
  recoverInterruptedRestore();
}

function resolveBackupRun(runId?: string): string {
  if (runId) return getMigrationBackupDir(runId);
  const root = getMigrationBackupRoot();
  const candidates = fs.existsSync(root)
    ? fs
        .readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
        .map((entry) => ({ name: entry.name, mtime: fs.statSync(path.join(root, entry.name)).mtimeMs }))
        .sort((left, right) => left.mtime - right.mtime || left.name.localeCompare(right.name))
    : [];
  const latest = candidates.at(-1)?.name;
  if (!latest) throw new ConfigError(`No migration backup runs exist under ${root}.`, "INVALID_CONFIG_FILE");
  return getMigrationBackupDir(latest);
}

function inspectArtifactAt(name: ArtifactName, filePath: string): MigrationArtifactState {
  return name === "config.json" ? inspectConfig(filePath) : inspectLedgerArtifact(name, filePath);
}

// backupSqlite note: index.db takes no maintenance-activity lease (only
// state.db/workflow.db have activity names) — VACUUM INTO under the 10s
// busy_timeout suffices for the regenerable cache snapshot.

function replaceArtifactsFromBundle(bundlePath: string, manifest: MigrationBackupManifest, rescueRunId: string): void {
  const operationId = `${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  const entries: RestoreJournalEntry[] = [];
  let journal: RestoreJournal | undefined;
  let committed = false;
  const restoreNames = artifactNamesFor(manifest.formatVersion);
  try {
    for (const name of restoreNames) {
      const artifact = manifestArtifact(manifest, name);
      const destination = artifact.sourcePath;
      const stage = artifact.present ? `${destination}.restore-stage.${operationId}` : undefined;
      if (stage) {
        fs.rmSync(stage, { force: true });
        copyFileDurable(path.join(bundlePath, name), stage);
        if (sha256File(stage) !== artifact.sha256 || !sameState(inspectArtifactAt(name, stage), artifact)) {
          throw new ConfigError(`Staged restore artifact ${name} failed verification.`, "INVALID_CONFIG_FILE");
        }
      }
      entries.push({
        destination,
        stage,
        originalPresent: fs.existsSync(destination),
        originalFingerprint: fingerprintFile(destination),
        quarantine: `${destination}.restore-quarantine.${operationId}`,
        sidecars:
          name === "config.json"
            ? []
            : ["-wal", "-shm"].map((suffix) => ({
                destination: `${destination}${suffix}`,
                originalPresent: fs.existsSync(`${destination}${suffix}`),
                originalFingerprint: fingerprintFile(`${destination}${suffix}`),
                quarantine: `${destination}${suffix}.restore-quarantine.${operationId}`,
              })),
      });
    }
    journal = {
      formatVersion: RESTORE_JOURNAL_FORMAT_VERSION,
      version: MIGRATION_BACKUP_VERSION,
      operationId,
      sourceRunId: manifest.runId,
      rescueRunId,
      phase: "prepared",
      entries,
    };
    writeRestoreJournal(journal);

    for (const entry of entries) {
      fs.mkdirSync(path.dirname(entry.destination), { recursive: true, mode: 0o700 });
      if (entry.originalPresent) fs.renameSync(entry.destination, entry.quarantine);
      for (const sidecar of entry.sidecars) {
        if (sidecar.originalPresent) fs.renameSync(sidecar.destination, sidecar.quarantine);
      }
    }
    for (const entry of entries) {
      if (entry.stage) {
        fs.renameSync(entry.stage, entry.destination);
        fs.chmodSync(entry.destination, 0o600);
        fsyncDirectory(path.dirname(entry.destination));
      }
    }
    for (const name of restoreNames) {
      const artifact = manifestArtifact(manifest, name);
      const actual = artifact.present ? inspectArtifactAt(name, artifact.sourcePath) : { status: "missing" as const };
      if (!sameState(actual, artifact)) {
        throw new ConfigError(`Published restore artifact ${name} failed final verification.`, "INVALID_CONFIG_FILE");
      }
    }
    journal.phase = "committed";
    writeRestoreJournal(journal);
    committed = true;
    cleanupCommittedRestore(journal);
  } catch (error) {
    if (!committed) {
      rollbackRestoreJournal(
        journal ?? {
          operationId,
          formatVersion: RESTORE_JOURNAL_FORMAT_VERSION,
          version: MIGRATION_BACKUP_VERSION,
          sourceRunId: manifest.runId,
          rescueRunId,
          phase: "prepared",
          entries,
        },
      );
    }
    throw error;
  }
}

/** Caller must hold the config lock and maintenance barrier. */
export function restoreMigrationBackupWithLocksHeld(bundlePath: string): void {
  assertNoArtifactReplacementBlockers(bundlePath);
  recoverInterruptedRestore();
  const manifest = verifyMigrationBackup(bundlePath);
  replaceArtifactsFromBundle(bundlePath, manifest, "migration-apply-rollback");
}

export function restoreMigrationBackup(confirm: boolean, runId?: string): MigrationBackupResult {
  if (!confirm) throw new ConfigError("Migration backup restore requires --confirm.", "INVALID_CONFIG_FILE");
  const bundlePath = resolveBackupRun(runId);
  return withConfigLock(() =>
    withMigrationBackupLock(() =>
      withMaintenanceStartBarrier(() => {
        if (fs.existsSync(getMigrationApplyJournalPath())) {
          throw new ConfigError(
            `Migration apply recovery is pending at ${getMigrationApplyJournalPath()}; run \`akm migrate apply\` before restore.`,
            "INVALID_CONFIG_FILE",
          );
        }
        assertNoArtifactReplacementBlockers(bundlePath);
        recoverInterruptedRestore();
        const manifest = verifyMigrationBackup(bundlePath);

        const rescue = createMigrationBackupUnlocked();
        replaceArtifactsFromBundle(bundlePath, manifest, rescue.manifest.runId);
        return { path: bundlePath, created: false, manifest, rescuePath: rescue.path };
      }),
    ),
  );
}
