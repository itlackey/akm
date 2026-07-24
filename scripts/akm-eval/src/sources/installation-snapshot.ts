import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  parseAndValidateConfigText,
  type AkmConfig,
  type BundleConfigEntry,
} from "../../../../src/core/config/config";
import { bundleEntryToSourceEntry } from "../../../../src/core/config/config-sources";
import {
  createLockPayload,
  probeLock,
  reclaimStaleLock,
  releaseLock,
  tryAcquireLockSync,
} from "../../../../src/core/file-lock";
import { resolveWritable } from "../../../../src/core/write-source";
import { type Database, openDatabaseFinalizing } from "../../../../src/storage/database";
import {
  assertSafeRelativePath,
  assertSha256,
  type InstallationSnapshotEntry,
  type InstallationSnapshotManifest,
  type MaterializedInstallation,
  type ProducerIdentity,
  type SafeRelativePath,
  type Sha256,
} from "../twin-types";

export interface CaptureInstallationSnapshotOptions {
  destinationDir: string;
  bundleRoots: Readonly<Record<string, string>>;
  defaultBundle: string;
  configPath: string;
  dataDir: string;
  producer: ProducerIdentity;
}

const MANIFEST_PATH = "manifest.json";
const CONFIG_PATH = "config/config.json";
const DATA_DIR = "data";
const DATABASE_NAMES = ["index.db", "state.db"] as const;
const SQLITE_SIDECAR_SUFFIXES = ["-wal", "-shm", "-journal"] as const;
const STABLE_SQLITE_SIDECAR_SUFFIXES = ["-wal", "-journal"] as const;
const ALLOWED_DATA_FILES = new Set<string>(DATABASE_NAMES);
const COPY_BUFFER_BYTES = 64 * 1024;
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIRECTORY_MODE = 0o700;
const MANIFEST_KEYS = [
  "schemaVersion",
  "snapshotFingerprint",
  "producer",
  "configFingerprint",
  "defaultBundle",
  "bundleRoots",
  "configPath",
  "dataDir",
  "entries",
] as const;
const MANIFEST_ENTRY_KEYS = ["kind", "path", "byteSize", "sha256"] as const;
const PRODUCER_KEYS = ["version", "commit"] as const;
const SECRET_KEY_HINT =
  /(?:secret|token|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key|credential|bearer|auth[_-]?token|client[_-]?secret|authorization|cookie)/i;
const SECRET_VALUE_PREFIX =
  /^(?:sk-|rk-|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|xox[baprs]-|AKIA|ASIA|AIza|ya29\.|-----BEGIN)/;

interface FileFingerprint {
  byteSize: number;
  sha256: Sha256;
}

interface NamedRoot {
  id: string;
  root: string;
}

type BigIntStats = fs.BigIntStats;

export function captureInstallationSnapshot(
  options: CaptureInstallationSnapshotOptions,
): InstallationSnapshotManifest {
  assertPrivatePermissionsSupported();
  validateProducer(options.producer);
  if (!Object.hasOwn(options.bundleRoots, options.defaultBundle)) {
    throw new Error(`default bundle is not present in bundleRoots: ${options.defaultBundle}`);
  }

  const configPath = requireRegularPath(options.configPath, "config file");
  const dataDir = requireDirectory(options.dataDir, "data source root");
  const sourceBundleRoots = Object.entries(options.bundleRoots)
    .map(([id, root]): NamedRoot => {
      if (!id) throw new Error("bundle IDs must not be empty");
      return { id, root: requireDirectory(root, `bundle source root ${id}`) };
    })
    .sort((left, right) => compareStrings(left.id, right.id));
  if (sourceBundleRoots.length === 0) throw new Error("at least one bundle root is required");
  assertNonOverlappingSources(configPath, dataDir, sourceBundleRoots);
  assertTrustedCaptureSources(configPath, dataDir, sourceBundleRoots);

  const destinationDir = canonicalPathWithMissingTail(options.destinationDir);
  assertNonOverlappingDestination(destinationDir, [
    configPath,
    dataDir,
    ...sourceBundleRoots.map(({ root }) => root),
  ]);

  const stagingDir = createStagingDirectory(destinationDir);
  let committed = false;
  try {
    const manifest = withSnapshotQuiescence(dataDir, configPath, sourceBundleRoots, () =>
      captureInstallationSnapshotUnlocked(options, stagingDir, configPath, dataDir, sourceBundleRoots),
    );
    commitStagingDirectory(stagingDir, destinationDir);
    committed = true;
    verifyInstallationSnapshot(destinationDir);
    return manifest;
  } catch (error) {
    fs.rmSync(stagingDir, { recursive: true, force: true });
    if (committed) fs.rmSync(destinationDir, { recursive: true, force: true });
    throw error;
  }
}

export function verifyInstallationSnapshot(snapshotDir: string): InstallationSnapshotManifest {
  assertPrivatePermissionsSupported();
  const root = requireDirectory(snapshotDir, "snapshot directory");
  assertMode(root, PRIVATE_DIRECTORY_MODE, "snapshot directory");
  const manifestPath = path.join(root, MANIFEST_PATH);
  requireRegularFile(manifestPath, "snapshot manifest");
  assertMode(manifestPath, PRIVATE_FILE_MODE, "snapshot manifest");
  const manifestText = readStableFile(manifestPath).toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestText);
  } catch (error) {
    throw new Error(`invalid snapshot manifest JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (manifestText !== canonicalJson(parsed)) throw new Error("snapshot manifest is not canonical JSON");
  const manifest = validateManifest(parsed);
  const { snapshotFingerprint: _, ...unsignedManifest } = parsed as InstallationSnapshotManifest;
  if (manifest.snapshotFingerprint !== hashBytes(canonicalJson(unsignedManifest))) {
    throw new Error("snapshot manifest fingerprint mismatch");
  }

  const expectedFiles = new Set<string>([MANIFEST_PATH]);
  let configEntry: InstallationSnapshotEntry | undefined;
  for (const entry of manifest.entries) {
    if (expectedFiles.has(entry.path)) throw new Error(`duplicate snapshot entry path: ${entry.path}`);
    expectedFiles.add(entry.path);
    const filePath = resolveInside(root, entry.path);
    assertMode(filePath, PRIVATE_FILE_MODE, `snapshot entry ${entry.path}`);
    const fingerprint = fingerprintRegularFile(filePath);
    if (fingerprint.byteSize !== entry.byteSize || fingerprint.sha256 !== entry.sha256) {
      throw new Error(`snapshot entry fingerprint mismatch: ${entry.path}`);
    }
    if (entry.path === manifest.configPath) configEntry = entry;
  }
  if (!configEntry || configEntry.kind !== "config") throw new Error("snapshot config entry is missing");
  if (configEntry.sha256 !== manifest.configFingerprint) throw new Error("snapshot config fingerprint mismatch");

  const config = parseConfig(readStableFile(resolveInside(root, manifest.configPath)).toString("utf8"), manifestPath);
  validateConfigBundles(config, Object.keys(manifest.bundleRoots), manifest.defaultBundle);
  validateSnapshotBundleDescriptors(config, manifest.bundleRoots);
  assertCapturedConfigIsPortable(config, []);
  validateSnapshotWorkspaces(config, manifest.bundleRoots);
  for (const databaseName of DATABASE_NAMES) {
    const relativePath = `${manifest.dataDir}/${databaseName}`;
    if (!expectedFiles.has(relativePath)) throw new Error(`snapshot data is missing ${databaseName}`);
    verifySqliteDatabase(resolveInside(root, relativePath));
  }
  for (const relativeRoot of Object.values(manifest.bundleRoots)) {
    requireDirectory(resolveInside(root, relativeRoot), `bundle root ${relativeRoot}`);
  }
  requireDirectory(resolveInside(root, manifest.dataDir), "snapshot data directory");

  const actualFiles = collectTreeFiles(root, false, PRIVATE_DIRECTORY_MODE);
  if (actualFiles.length !== expectedFiles.size || actualFiles.some((relativePath) => !expectedFiles.has(relativePath))) {
    throw new Error("snapshot contains files not declared by the manifest");
  }
  return manifest;
}

export function materializeInstallationSnapshot(
  snapshotDir: string,
  destinationRoot: string,
): MaterializedInstallation {
  assertPrivatePermissionsSupported();
  const manifest = verifyInstallationSnapshot(snapshotDir);
  const sourceRoot = requireDirectory(snapshotDir, "snapshot directory");
  const root = canonicalPathWithMissingTail(destinationRoot);
  assertNonOverlappingDestination(root, [sourceRoot]);
  const stagingRoot = createStagingDirectory(root);
  let committed = false;
  try {
    const installation = materializeInstallationSnapshotUnlocked(sourceRoot, stagingRoot, root, manifest);
    commitStagingDirectory(stagingRoot, root);
    committed = true;
    return installation;
  } catch (error) {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
    if (committed) fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function materializeInstallationSnapshotUnlocked(
  sourceRoot: string,
  physicalRoot: string,
  root: string,
  manifest: InstallationSnapshotManifest,
): MaterializedInstallation {
  const physicalBundleRoots = Object.fromEntries(
    Object.entries(manifest.bundleRoots).map(([id, relativeRoot]) => [id, resolveInside(physicalRoot, relativeRoot)]),
  );

  const bundleRoots = Object.fromEntries(
    Object.entries(manifest.bundleRoots).map(([id, relativeRoot]) => [id, resolveInside(root, relativeRoot)]),
  );
  for (const bundleRoot of Object.values(physicalBundleRoots)) makePrivateDirectory(bundleRoot);
  const dataDir = resolveInside(root, manifest.dataDir);
  const configPath = resolveInside(root, manifest.configPath);
  const physicalDataDir = resolveInside(physicalRoot, manifest.dataDir);
  const physicalConfigPath = resolveInside(physicalRoot, manifest.configPath);
  makePrivateDirectory(physicalDataDir);
  makePrivateDirectory(path.dirname(physicalConfigPath));

  for (const entry of manifest.entries) {
    const copied = copyRegularFile(resolveInside(sourceRoot, entry.path), resolveInside(physicalRoot, entry.path));
    if (copied.byteSize !== entry.byteSize || copied.sha256 !== entry.sha256) {
      throw new Error(`snapshot changed during materialization: ${entry.path}`);
    }
  }

  const config = parseConfig(readStableFile(physicalConfigPath).toString("utf8"), physicalConfigPath);
  const bundles = requireConfigBundles(config);
  for (const [id, materializedRoot] of Object.entries(bundleRoots)) {
    const configuredBundle = bundles[id];
    if (!configuredBundle) throw new Error(`snapshot config is missing bundle: ${id}`);
    const sourceEntry = bundleEntryToSourceEntry(id, configuredBundle, id === manifest.defaultBundle);
    if (!sourceEntry) throw new Error(`snapshot config bundle has no source descriptor: ${id}`);
    const writable = resolveWritable(sourceEntry);
    delete configuredBundle.git;
    delete configuredBundle.website;
    delete configuredBundle.npm;
    configuredBundle.path = materializedRoot;
    configuredBundle.writable = writable;
  }
  remapMaterializedWorkspaces(config, manifest.bundleRoots, bundleRoots, physicalBundleRoots);
  const materializedConfig = parseConfig(`${JSON.stringify(config)}\n`, physicalConfigPath);
  writeExistingPrivateFile(physicalConfigPath, Buffer.from(prettyCanonicalJson(materializedConfig), "utf8"));

  const runtimeRoot = path.join(root, "runtime");
  const physicalRuntimeRoot = path.join(physicalRoot, "runtime");
  const env: Record<string, string> = {
    HOME: path.join(runtimeRoot, "home"),
    XDG_CONFIG_HOME: path.join(runtimeRoot, "xdg-config"),
    XDG_DATA_HOME: path.join(runtimeRoot, "xdg-data"),
    XDG_CACHE_HOME: path.join(runtimeRoot, "xdg-cache"),
    XDG_STATE_HOME: path.join(runtimeRoot, "xdg-state"),
    AKM_STASH_DIR: bundleRoots[manifest.defaultBundle] ?? "",
    AKM_CONFIG_DIR: path.dirname(configPath),
    AKM_DATA_DIR: dataDir,
    AKM_CACHE_DIR: path.join(runtimeRoot, "cache"),
    AKM_STATE_DIR: path.join(runtimeRoot, "state"),
  };
  if (!env.AKM_STASH_DIR) throw new Error("snapshot default bundle root is missing");
  const physicalEnvDirectories = [
    path.join(physicalRuntimeRoot, "home"),
    path.join(physicalRuntimeRoot, "xdg-config"),
    path.join(physicalRuntimeRoot, "xdg-data"),
    path.join(physicalRuntimeRoot, "xdg-cache"),
    path.join(physicalRuntimeRoot, "xdg-state"),
    physicalBundleRoots[manifest.defaultBundle] ?? "",
    path.dirname(physicalConfigPath),
    physicalDataDir,
    path.join(physicalRuntimeRoot, "cache"),
    path.join(physicalRuntimeRoot, "state"),
  ];
  if (physicalEnvDirectories.some((directory) => !directory)) {
    throw new Error("snapshot default bundle root is missing");
  }
  for (const directory of new Set(physicalEnvDirectories)) makePrivateDirectory(directory);

  return { root, defaultBundle: manifest.defaultBundle, bundleRoots, configPath, dataDir, env };
}

function captureInstallationSnapshotUnlocked(
  options: CaptureInstallationSnapshotOptions,
  destinationDir: string,
  configPath: string,
  dataDir: string,
  sourceBundleRoots: NamedRoot[],
): InstallationSnapshotManifest {
  const bundleRoots = createSnapshotBundleRoots(sourceBundleRoots);
  makePrivateDirectory(path.join(destinationDir, "bundles"));
  makePrivateDirectory(path.join(destinationDir, "config"));
  makePrivateDirectory(path.join(destinationDir, DATA_DIR));

  const sourceConfigBytes = readStableFile(configPath);
  const config = parseConfig(sourceConfigBytes.toString("utf8"), configPath);
  validateConfigBundles(
    config,
    sourceBundleRoots.map(({ id }) => id),
    options.defaultBundle,
  );
  rewriteCapturedBundles(config, bundleRoots, options.defaultBundle);
  rewriteCapturedWorkspaces(config, sourceBundleRoots, bundleRoots);
  assertCapturedConfigIsPortable(config, sourceBundleRoots);
  const configBytes = Buffer.from(prettyCanonicalJson(config), "utf8");

  const entries: InstallationSnapshotEntry[] = [];
  for (const { id, root: sourceRoot } of sourceBundleRoots) {
    const relativeRoot = bundleRoots[id];
    if (!relativeRoot) throw new Error(`missing snapshot root for bundle: ${id}`);
    const destinationRoot = resolveInside(destinationDir, relativeRoot);
    makePrivateDirectory(destinationRoot);
    copyBundleTree(sourceRoot, destinationRoot, relativeRoot, entries);
  }

  const configRelativePath = asSafeRelativePath(CONFIG_PATH);
  const configFingerprint = writePrivateFile(resolveInside(destinationDir, configRelativePath), configBytes);
  entries.push({ kind: "config", path: configRelativePath, ...configFingerprint });

  validateSqliteSourcePaths(dataDir);
  const sourceDatabaseFingerprints = fingerprintSqliteSourceArtifacts(dataDir);
  for (const databaseName of DATABASE_NAMES) {
    const relativePath = asSafeRelativePath(`${DATA_DIR}/${databaseName}`);
    const fingerprint = snapshotDatabase(path.join(dataDir, databaseName), resolveInside(destinationDir, relativePath));
    entries.push({ kind: "data", path: relativePath, ...fingerprint });
  }
  assertSqliteSourceArtifactsUnchanged(dataDir, sourceDatabaseFingerprints);
  assertSourceConfigUnchanged(configPath, sourceConfigBytes);
  for (const { id, root: sourceRoot } of sourceBundleRoots) {
    const manifestRoot = bundleRoots[id];
    if (!manifestRoot) throw new Error(`missing snapshot root for bundle: ${id}`);
    assertBundleTreeMatchesSnapshot(sourceRoot, manifestRoot, entries);
  }

  entries.sort((left, right) => compareStrings(left.path, right.path));
  const unsignedManifest = {
    schemaVersion: 1 as const,
    producer: { ...options.producer },
    configFingerprint: configFingerprint.sha256,
    defaultBundle: options.defaultBundle,
    bundleRoots,
    configPath: configRelativePath,
    dataDir: asSafeRelativePath(DATA_DIR),
    entries,
  };
  const manifest: InstallationSnapshotManifest = {
    ...unsignedManifest,
    snapshotFingerprint: hashBytes(canonicalJson(unsignedManifest)),
  };
  writePrivateFile(path.join(destinationDir, MANIFEST_PATH), Buffer.from(canonicalJson(manifest), "utf8"));
  return verifyInstallationSnapshot(destinationDir);
}

function createSnapshotBundleRoots(sourceBundleRoots: NamedRoot[]): Record<string, SafeRelativePath> {
  const usedSafeIds = new Set<string>();
  return Object.fromEntries(
    sourceBundleRoots.map(({ id }) => {
      const safeId = safeBundleId(id);
      if (usedSafeIds.has(safeId)) throw new Error(`bundle IDs map to the same snapshot path: ${id}`);
      usedSafeIds.add(safeId);
      return [id, asSafeRelativePath(`bundles/${safeId}`)];
    }),
  );
}

function copyBundleTree(
  sourceRoot: string,
  destinationRoot: string,
  manifestRoot: SafeRelativePath,
  entries: InstallationSnapshotEntry[],
): void {
  const before = collectTreeFiles(sourceRoot, true);
  for (const relativePath of before) {
    const manifestPath = asSafeRelativePath(`${manifestRoot}/${relativePath}`);
    const fingerprint = copyRegularFile(resolveInside(sourceRoot, relativePath), resolveInside(destinationRoot, relativePath));
    entries.push({ kind: "bundle", path: manifestPath, ...fingerprint });
  }
  const after = collectTreeFiles(sourceRoot, true);
  if (before.length !== after.length || before.some((relativePath, index) => relativePath !== after[index])) {
    throw new Error("bundle source tree changed while it was being captured");
  }
  assertBundleTreeMatchesSnapshot(sourceRoot, manifestRoot, entries);
}

function assertBundleTreeMatchesSnapshot(
  sourceRoot: string,
  manifestRoot: SafeRelativePath,
  entries: InstallationSnapshotEntry[],
): void {
  const expectedEntries = entries
    .filter((entry) => entry.kind === "bundle" && entry.path.startsWith(`${manifestRoot}/`))
    .map((entry) => ({ entry, relativePath: entry.path.slice(manifestRoot.length + 1) }))
    .sort((left, right) => compareStrings(left.relativePath, right.relativePath));
  const actualPaths = collectTreeFiles(sourceRoot, true);
  if (
    actualPaths.length !== expectedEntries.length ||
    actualPaths.some((relativePath, index) => relativePath !== expectedEntries[index]?.relativePath)
  ) {
    throw new Error("bundle source tree changed while it was being captured");
  }
  for (const { entry, relativePath } of expectedEntries) {
    const fingerprint = fingerprintRegularFile(resolveInside(sourceRoot, relativePath));
    if (fingerprint.byteSize !== entry.byteSize || fingerprint.sha256 !== entry.sha256) {
      throw new Error(`bundle source file changed after it was copied: ${relativePath}`);
    }
  }
}

function fingerprintSqliteSourceArtifacts(dataDir: string): Record<string, FileFingerprint> {
  const fingerprints: Record<string, FileFingerprint> = {};
  for (const databaseName of DATABASE_NAMES) {
    for (const suffix of ["", ...STABLE_SQLITE_SIDECAR_SUFFIXES]) {
      const name = `${databaseName}${suffix}`;
      const filePath = path.join(dataDir, name);
      if (!lstatIfExists(filePath)) continue;
      fingerprints[name] = fingerprintRegularFile(filePath);
    }
  }
  return fingerprints;
}

function assertSqliteSourceArtifactsUnchanged(
  dataDir: string,
  expected: Readonly<Record<string, FileFingerprint>>,
): void {
  const actual = fingerprintSqliteSourceArtifacts(dataDir);
  const expectedNames = Object.keys(expected).sort(compareStrings);
  const actualNames = Object.keys(actual).sort(compareStrings);
  if (
    expectedNames.length !== actualNames.length ||
    expectedNames.some((name, index) => name !== actualNames[index])
  ) {
    throw new Error("SQLite source artifacts changed while the installation snapshot was captured");
  }
  for (const name of expectedNames) {
    const before = expected[name];
    const after = actual[name];
    if (!before || !after || before.byteSize !== after.byteSize || before.sha256 !== after.sha256) {
      throw new Error(`SQLite source artifact changed while the installation snapshot was captured: ${name}`);
    }
  }
}

function assertSourceConfigUnchanged(configPath: string, expected: Buffer): void {
  const actual = readStableFile(configPath);
  if (actual.byteLength !== expected.byteLength || !crypto.timingSafeEqual(actual, expected)) {
    throw new Error("source config changed while the installation snapshot was captured");
  }
}

/** Matches the repository's verified migration-backup mechanism: SQLite VACUUM INTO, never a raw WAL copy. */
function snapshotDatabase(sourcePath: string, destinationPath: string): FileFingerprint {
  const before = requireRegularFile(sourcePath, "SQLite database");
  assertTrustedSourceRegularFile(sourcePath, before, "SQLite database");
  let database: Database | undefined;
  try {
    database = openDatabaseFinalizing(sourcePath, { readonly: true, create: false });
    database.exec("PRAGMA busy_timeout = 10000");
    assertQuickCheck(database, sourcePath);
    makePrivateDirectory(path.dirname(destinationPath));
    database.exec(`VACUUM INTO ${sqliteQuote(destinationPath)}`);
  } catch (error) {
    throw new Error(
      `SQLite quick_check or backup failed for ${sourcePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    database?.close();
  }
  const after = requireRegularFile(sourcePath, "SQLite database");
  if (!sameStableFile(before, after)) throw new Error(`SQLite database changed during capture: ${sourcePath}`);
  fs.chmodSync(destinationPath, PRIVATE_FILE_MODE);
  verifySqliteDatabase(destinationPath);
  for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
    if (lstatIfExists(`${destinationPath}${suffix}`)) {
      throw new Error(`SQLite snapshot left an unexpected sidecar: ${destinationPath}${suffix}`);
    }
  }
  return fingerprintRegularFile(destinationPath);
}

function verifySqliteDatabase(filePath: string): void {
  let database: Database | undefined;
  try {
    database = openDatabaseFinalizing(filePath, { readonly: true, create: false });
    assertQuickCheck(database, filePath);
  } catch (error) {
    throw new Error(`SQLite quick_check failed for ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    database?.close();
  }
}

function assertQuickCheck(database: Database, filePath: string): void {
  const rows = database.prepare<Record<string, unknown>>("PRAGMA quick_check").all();
  if (rows.length !== 1 || Object.values(rows[0] ?? {})[0] !== "ok") {
    throw new Error(`SQLite quick_check failed for ${filePath}`);
  }
}

function sqliteQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function validateSqliteSourcePaths(dataDir: string): void {
  for (const databaseName of DATABASE_NAMES) {
    const databasePath = path.join(dataDir, databaseName);
    const databaseStat = requireRegularFile(databasePath, "SQLite database");
    assertTrustedSourceRegularFile(databasePath, databaseStat, "SQLite database");
    for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
      const sidecarPath = path.join(dataDir, `${databaseName}${suffix}`);
      const stat = lstatIfExists(sidecarPath);
      if (stat && (stat.isSymbolicLink() || !stat.isFile())) {
        throw new Error(`SQLite sidecars must be regular files: ${sidecarPath}`);
      }
      if (stat) assertTrustedSourceStat(sidecarPath, stat, "SQLite sidecar");
      if (stat && stat.nlink !== 1) throw new Error(`hard links are not allowed in snapshot sources: ${sidecarPath}`);
    }
  }
}

function copyRegularFile(sourcePath: string, destinationPath: string): FileFingerprint {
  const pathStat = requireRegularFile(sourcePath, "snapshot source file");
  assertTrustedSourceRegularFile(sourcePath, pathStat, "snapshot source file");
  const sourceFd = fs.openSync(sourcePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  let destinationFd: number | undefined;
  try {
    const before = fs.fstatSync(sourceFd, { bigint: true });
    if (!before.isFile() || !sameFileIdentity(pathStat, before)) throw new Error(`source file changed: ${sourcePath}`);
    makePrivateDirectory(path.dirname(destinationPath));
    destinationFd = fs.openSync(destinationPath, "wx", PRIVATE_FILE_MODE);
    const fingerprint = copyAndHash(sourceFd, destinationFd);
    fs.fsyncSync(destinationFd);
    const after = fs.fstatSync(sourceFd, { bigint: true });
    const finalPathStat = requireRegularFile(sourcePath, "snapshot source file");
    if (!sameStableFile(before, after) || !sameFileIdentity(after, finalPathStat) || BigInt(fingerprint.byteSize) !== after.size) {
      throw new Error(`source file changed while it was being copied: ${sourcePath}`);
    }
    fs.chmodSync(destinationPath, PRIVATE_FILE_MODE);
    return fingerprint;
  } finally {
    if (destinationFd !== undefined) fs.closeSync(destinationFd);
    fs.closeSync(sourceFd);
  }
}

function fingerprintRegularFile(filePath: string): FileFingerprint {
  const pathStat = requireRegularFile(filePath, "snapshot file");
  assertTrustedSourceRegularFile(filePath, pathStat, "snapshot file");
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile() || !sameFileIdentity(pathStat, before)) throw new Error(`snapshot file changed: ${filePath}`);
    const fingerprint = copyAndHash(fd);
    const after = fs.fstatSync(fd, { bigint: true });
    const finalPathStat = requireRegularFile(filePath, "snapshot file");
    if (!sameStableFile(before, after) || !sameFileIdentity(after, finalPathStat) || BigInt(fingerprint.byteSize) !== after.size) {
      throw new Error(`snapshot file changed while it was being verified: ${filePath}`);
    }
    return fingerprint;
  } finally {
    fs.closeSync(fd);
  }
}

function copyAndHash(sourceFd: number, destinationFd?: number): FileFingerprint {
  const hash = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
  let byteSize = 0;
  while (true) {
    const bytesRead = fs.readSync(sourceFd, buffer, 0, buffer.length, null);
    if (bytesRead === 0) break;
    hash.update(buffer.subarray(0, bytesRead));
    if (destinationFd !== undefined) {
      let written = 0;
      while (written < bytesRead) written += fs.writeSync(destinationFd, buffer, written, bytesRead - written);
    }
    byteSize += bytesRead;
  }
  return { byteSize, sha256: hash.digest("hex") as Sha256 };
}

function readStableFile(filePath: string): Buffer {
  const pathStat = requireRegularFile(filePath, "file");
  assertTrustedSourceRegularFile(filePath, pathStat, "file");
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile() || !sameFileIdentity(pathStat, before)) throw new Error(`file changed: ${filePath}`);
    const contents = fs.readFileSync(fd);
    const after = fs.fstatSync(fd, { bigint: true });
    const finalPathStat = requireRegularFile(filePath, "file");
    if (!sameStableFile(before, after) || !sameFileIdentity(after, finalPathStat) || BigInt(contents.byteLength) !== after.size) {
      throw new Error(`file changed while it was being read: ${filePath}`);
    }
    return contents;
  } finally {
    fs.closeSync(fd);
  }
}

function writePrivateFile(filePath: string, contents: Buffer): FileFingerprint {
  makePrivateDirectory(path.dirname(filePath));
  const fd = fs.openSync(filePath, "wx", PRIVATE_FILE_MODE);
  try {
    let written = 0;
    while (written < contents.byteLength) written += fs.writeSync(fd, contents, written, contents.byteLength - written);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(filePath, PRIVATE_FILE_MODE);
  return { byteSize: contents.byteLength, sha256: hashBytes(contents) };
}

function writeExistingPrivateFile(filePath: string, contents: Buffer): void {
  const fd = fs.openSync(filePath, "w", PRIVATE_FILE_MODE);
  try {
    let written = 0;
    while (written < contents.byteLength) written += fs.writeSync(fd, contents, written, contents.byteLength - written);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(filePath, PRIVATE_FILE_MODE);
}

function collectTreeFiles(root: string, excludeSecrets: boolean, expectedDirectoryMode?: number): string[] {
  const files: string[] = [];
  const visit = (directory: string, parts: string[]): void => {
    if (expectedDirectoryMode !== undefined) assertMode(directory, expectedDirectoryMode, "snapshot directory");
    if (excludeSecrets) assertTrustedSourceDirectory(directory, "bundle source directory");
    const entries = fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => compareStrings(left.name, right.name));
    if (excludeSecrets && entries.length === 0 && parts.length > 0) {
      throw new Error(`empty bundle directories are not supported by installation snapshots: ${directory}`);
    }
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      const stat = fs.lstatSync(fullPath);
      if (stat.isSymbolicLink()) throw new Error(`symbolic links are not allowed in snapshots: ${fullPath}`);
      if (excludeSecrets) assertTrustedSourceStat(fullPath, stat, "bundle source node");
      const nextParts = [...parts, entry.name];
      if (excludeSecrets && isSecretBearingBundlePath(nextParts)) {
        assertSecretBearingPathHasNoMaterial(fullPath, stat);
        continue;
      }
      if (stat.isDirectory()) visit(fullPath, nextParts);
      else if (stat.isFile()) {
        if (stat.nlink !== 1) throw new Error(`hard links are not allowed in snapshot trees: ${fullPath}`);
        files.push(nextParts.join("/"));
      }
      else throw new Error(`snapshot sources must contain only regular files and directories: ${fullPath}`);
    }
  };
  visit(requireDirectory(root, "snapshot tree"), []);
  return files.sort(compareStrings);
}

function isSecretBearingBundlePath(parts: readonly string[]): boolean {
  const lowerParts = parts.map((part) => part.toLowerCase());
  if (lowerParts.some((part) => part === "env" || part === "secrets")) return true;
  const basename = lowerParts.at(-1) ?? "";
  return basename === ".env" || basename.startsWith(".env.");
}

function assertSecretBearingPathHasNoMaterial(filePath: string, stat: fs.Stats): void {
  if (!stat.isDirectory()) {
    throw new Error(`secret-bearing bundle material cannot be proven absent from data artifacts: ${filePath}`);
  }
  for (const entry of fs.readdirSync(filePath, { withFileTypes: true })) {
    const childPath = path.join(filePath, entry.name);
    const childStat = fs.lstatSync(childPath);
    if (childStat.isSymbolicLink()) throw new Error(`symbolic links are not allowed in snapshots: ${childPath}`);
    assertTrustedSourceStat(childPath, childStat, "secret-bearing bundle node");
    if (childStat.isDirectory()) assertSecretBearingPathHasNoMaterial(childPath, childStat);
    else if (childStat.isFile()) {
      throw new Error(`secret-bearing bundle material cannot be proven absent from data artifacts: ${childPath}`);
    } else {
      throw new Error(`snapshot sources must contain only regular files and directories: ${childPath}`);
    }
  }
}

function parseConfig(text: string, sourcePath: string): AkmConfig {
  const config = parseAndValidateConfigText(text, sourcePath);
  assertNoLiteralSecrets(config);
  return config;
}

function assertNoLiteralSecrets(config: AkmConfig): void {
  const walk = (value: unknown, keyPath: string, key?: string): void => {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (isEnvReference(trimmed)) return;
      if ((key && SECRET_KEY_HINT.test(key) && trimmed) || SECRET_VALUE_PREFIX.test(trimmed) || urlContainsCredentials(trimmed)) {
        throw new Error(`snapshot config contains an obvious literal secret at ${keyPath}`);
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((child, index) => walk(child, `${keyPath}[${index}]`));
      return;
    }
    if (isRecord(value)) {
      for (const [childKey, child] of Object.entries(value)) {
        walk(child, keyPath ? `${keyPath}.${childKey}` : childKey, childKey);
      }
    }
  };
  walk(config, "");
}

function isEnvReference(value: string): boolean {
  return /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$|^\$[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

function urlContainsCredentials(value: string): boolean {
  if (!/^https?:\/\//i.test(value)) return false;
  try {
    const parsed = new URL(value);
    return parsed.username.length > 0 || parsed.password.length > 0;
  } catch {
    return false;
  }
}

function validateConfigBundles(config: AkmConfig, expectedIds: readonly string[], defaultBundle: string): void {
  if (config.defaultBundle !== defaultBundle) throw new Error("snapshot config defaultBundle does not match capture options");
  const bundles = requireConfigBundles(config);
  const configuredIds = Object.keys(bundles).sort();
  const sortedExpectedIds = [...expectedIds].sort();
  if (
    configuredIds.length !== sortedExpectedIds.length ||
    configuredIds.some((id, index) => id !== sortedExpectedIds[index])
  ) {
    throw new Error("snapshot config bundles do not match captured bundle roots");
  }
}

function validateSnapshotBundleDescriptors(
  config: AkmConfig,
  snapshotBundleRoots: Record<string, SafeRelativePath>,
): void {
  const bundles = requireConfigBundles(config);
  for (const [id, configuredBundle] of Object.entries(bundles)) {
    assertExactKeys(
      configuredBundle,
      ["path", "writable", "components"],
      `snapshot config bundle ${id}`,
      ["path", "writable"],
    );
    if (configuredBundle.path !== snapshotBundleRoots[id] || typeof configuredBundle.writable !== "boolean") {
      throw new Error(`snapshot config bundle is not a portable filesystem descriptor: ${id}`);
    }
    for (const [componentId, component] of Object.entries(configuredBundle.components ?? {})) {
      assertExactKeys(component, ["root", "adapter", "writable"], `snapshot config component ${id}/${componentId}`, []);
      if (component.root !== undefined && !isSafeComponentRoot(component.root)) {
        throw new Error(`snapshot bundle component root must be relative: ${id}/${componentId}`);
      }
    }
  }
}

function requireConfigBundles(config: AkmConfig): Record<string, BundleConfigEntry> {
  if (!config.bundles) throw new Error("snapshot config must contain a bundles object");
  return config.bundles;
}

function rewriteCapturedBundles(
  config: AkmConfig,
  snapshotBundleRoots: Record<string, SafeRelativePath>,
  defaultBundle: string,
): void {
  const bundles = requireConfigBundles(config);
  for (const [id, configuredBundle] of Object.entries(bundles)) {
    const sourceEntry = bundleEntryToSourceEntry(id, configuredBundle, id === defaultBundle);
    if (!sourceEntry) throw new Error(`snapshot config bundle has no source descriptor: ${id}`);
    const pathInSnapshot = snapshotBundleRoots[id];
    if (!pathInSnapshot) throw new Error(`missing snapshot root for bundle: ${id}`);
    const sanitized: BundleConfigEntry = {
      path: pathInSnapshot,
      writable: resolveWritable(sourceEntry),
    };
    if (configuredBundle.components) {
      sanitized.components = Object.fromEntries(
        Object.entries(configuredBundle.components).map(([componentId, component]) => {
          const root = component.root;
          if (root !== undefined && !isSafeComponentRoot(root)) {
            throw new Error(`snapshot bundle component root must be relative: ${id}/${componentId}`);
          }
          return [
            componentId,
            {
              ...(root === undefined ? {} : { root }),
              ...(component.adapter === undefined ? {} : { adapter: component.adapter }),
              ...(component.writable === undefined ? {} : { writable: component.writable }),
            },
          ];
        }),
      );
    }
    bundles[id] = sanitized;
  }
}

function isSafeComponentRoot(value: string): boolean {
  if (value === ".") return true;
  if (value.includes("\\") || value.includes("\0") || value.startsWith("/") || /^[A-Za-z]:/.test(value)) return false;
  return value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function assertCapturedConfigIsPortable(config: AkmConfig, sourceBundleRoots: NamedRoot[]): void {
  const sourcePaths = sourceBundleRoots.map(({ root }) => root);
  const walk = (value: unknown, keyPath: string): void => {
    if (typeof value === "string") {
      if (path.isAbsolute(value)) throw new Error(`snapshot config retains an absolute path at ${keyPath}`);
      if (sourcePaths.some((sourcePath) => value.includes(sourcePath))) {
        throw new Error(`snapshot config retains a live source path at ${keyPath}`);
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((child, index) => walk(child, `${keyPath}[${index}]`));
      return;
    }
    if (isRecord(value)) {
      for (const [childKey, child] of Object.entries(value)) {
        walk(child, keyPath ? `${keyPath}.${childKey}` : childKey);
      }
    }
  };
  walk(config, "");
}

function rewriteCapturedWorkspaces(
  config: AkmConfig,
  sourceBundleRoots: NamedRoot[],
  snapshotBundleRoots: Record<string, SafeRelativePath>,
): void {
  for (const [name, engine] of Object.entries(config.engines ?? {})) {
    if (engine.kind !== "agent" || !engine.workspace) continue;
    const workspace = requireDirectory(engine.workspace, `engine workspace ${name}`);
    const match = [...sourceBundleRoots]
      .sort((left, right) => right.root.length - left.root.length)
      .find(({ root }) => isSameOrInside(workspace, root));
    if (!match) throw new Error(`engine workspace is outside captured bundle roots: ${engine.workspace}`);
    const relative = path.relative(match.root, workspace).split(path.sep).filter(Boolean);
    if (isSecretBearingBundlePath(relative)) {
      throw new Error(`engine workspace is inside an excluded secret-bearing bundle path: ${engine.workspace}`);
    }
    const snapshotRoot = snapshotBundleRoots[match.id];
    if (!snapshotRoot) throw new Error(`missing snapshot bundle root for workspace: ${match.id}`);
    engine.workspace = relative.length > 0 ? `${snapshotRoot}/${relative.join("/")}` : snapshotRoot;
  }
}

function validateSnapshotWorkspaces(config: AkmConfig, snapshotBundleRoots: Record<string, SafeRelativePath>): void {
  for (const [name, engine] of Object.entries(config.engines ?? {})) {
    if (engine.kind !== "agent" || !engine.workspace) continue;
    const location = snapshotWorkspaceLocation(engine.workspace, snapshotBundleRoots);
    if (!location) throw new Error(`snapshot engine workspace is outside captured bundle roots: ${name}`);
  }
}

function remapMaterializedWorkspaces(
  config: AkmConfig,
  snapshotBundleRoots: Record<string, SafeRelativePath>,
  materializedBundleRoots: Record<string, string>,
  physicalBundleRoots: Record<string, string>,
): void {
  for (const [name, engine] of Object.entries(config.engines ?? {})) {
    if (engine.kind !== "agent" || !engine.workspace) continue;
    const location = snapshotWorkspaceLocation(engine.workspace, snapshotBundleRoots);
    if (!location) throw new Error(`snapshot engine workspace is outside captured bundle roots: ${name}`);
    const materializedRoot = materializedBundleRoots[location.id];
    if (!materializedRoot) throw new Error(`materialized bundle root is missing for engine workspace: ${name}`);
    const physicalRoot = physicalBundleRoots[location.id];
    if (!physicalRoot) throw new Error(`physical bundle root is missing for engine workspace: ${name}`);
    engine.workspace = path.join(materializedRoot, ...location.relativeParts);
    makePrivateDirectory(path.join(physicalRoot, ...location.relativeParts));
  }
}

function snapshotWorkspaceLocation(
  workspace: string,
  bundleRoots: Record<string, SafeRelativePath>,
): { id: string; relativeParts: string[] } | undefined {
  assertSafeRelativePath(workspace);
  return Object.entries(bundleRoots)
    .sort((left, right) => right[1].length - left[1].length)
    .map(([id, root]) => {
      if (workspace !== root && !workspace.startsWith(`${root}/`)) return undefined;
      return { id, relativeParts: workspace === root ? [] : workspace.slice(root.length + 1).split("/") };
    })
    .find((location) => location !== undefined);
}

function withSnapshotQuiescence<T>(dataDir: string, configPath: string, bundleRoots: NamedRoot[], run: () => T): T {
  const barrierPath = path.join(dataDir, "maintenance.barrier.lock");
  fs.mkdirSync(path.dirname(barrierPath), { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const existingBarrier = lstatIfExists(barrierPath);
  if (existingBarrier && (existingBarrier.isSymbolicLink() || !existingBarrier.isFile())) {
    throw new Error(`maintenance barrier path is unsafe: ${barrierPath}`);
  }
  let ownership = tryAcquireLockSync(barrierPath, createLockPayload({ purpose: "installation-snapshot" }));
  if (!ownership) {
    const probe = probeLock(barrierPath);
    if (probe.state === "stale" && reclaimStaleLock(barrierPath, probe)) {
      ownership = tryAcquireLockSync(barrierPath, createLockPayload({ purpose: "installation-snapshot" }));
    }
  }
  if (!ownership) throw new Error(`AKM maintenance barrier is held: ${barrierPath}`);
  try {
    assertNoActiveProcessLocks(dataDir, configPath, bundleRoots);
    return run();
  } finally {
    releaseLock(ownership);
  }
}

function assertNoActiveProcessLocks(dataDir: string, configPath: string, bundleRoots: NamedRoot[]): void {
  const lockPaths = [
    `${configPath}.lck`,
    path.join(dataDir, "index.db.write.lock"),
    path.join(dataDir, "akm.lock.lck"),
    ...["improve.lock", "consolidate.lock", "reflect-distill.lock", "triage.lock"].map((name) =>
      path.join(dataDir, name),
    ),
  ];
  for (const directory of [
    path.join(dataDir, "maintenance-activities"),
    path.join(dataDir, "extract-locks"),
    ...bundleRoots.flatMap(({ root }) => [path.join(root, ".akm", "extract-locks"), path.join(root, ".akm")]),
  ]) {
    const stat = lstatIfExists(directory);
    if (!stat) continue;
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`process lock directory is unsafe: ${directory}`);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.name.endsWith(".lock")) continue;
      const lockPath = path.join(directory, entry.name);
      const lockStat = fs.lstatSync(lockPath);
      if (lockStat.isSymbolicLink() || !lockStat.isFile()) throw new Error(`process lock path is unsafe: ${lockPath}`);
      lockPaths.push(lockPath);
    }
  }
  for (const lockPath of new Set(lockPaths)) {
    const lockStat = lstatIfExists(lockPath);
    if (lockStat && (lockStat.isSymbolicLink() || !lockStat.isFile())) {
      throw new Error(`process lock path is unsafe: ${lockPath}`);
    }
    const probe = probeLock(lockPath);
    if (probe.state === "absent") continue;
    if (probe.state === "stale" && reclaimStaleLock(lockPath, probe)) continue;
    throw new Error(`active AKM process lock prevents snapshot capture: ${lockPath}`);
  }
}

function validateManifest(value: unknown): InstallationSnapshotManifest {
  if (!isRecord(value) || value.schemaVersion !== 1) throw new Error("unsupported snapshot manifest schemaVersion");
  assertExactKeys(value, MANIFEST_KEYS, "snapshot manifest");
  assertSha256(value.snapshotFingerprint);
  assertSha256(value.configFingerprint);
  validateProducer(value.producer);
  if (typeof value.defaultBundle !== "string" || !value.defaultBundle) throw new Error("invalid snapshot defaultBundle");
  if (!isRecord(value.bundleRoots)) throw new Error("invalid snapshot bundleRoots");
  const bundleRoots = Object.fromEntries(
    Object.entries(value.bundleRoots).map(([id, relativeRoot]) => {
      if (!id || typeof relativeRoot !== "string") throw new Error("invalid snapshot bundle root");
      assertSafeRelativePath(relativeRoot);
      if (!/^bundles\/[^/]+$/.test(relativeRoot)) throw new Error(`invalid snapshot bundle root: ${relativeRoot}`);
      return [id, relativeRoot];
    }),
  );
  if (!Object.hasOwn(bundleRoots, value.defaultBundle)) throw new Error("snapshot default bundle root is missing");
  if (new Set(Object.values(bundleRoots)).size !== Object.keys(bundleRoots).length) {
    throw new Error("snapshot bundle roots must be unique");
  }
  if (value.configPath !== CONFIG_PATH || value.dataDir !== DATA_DIR) throw new Error("invalid snapshot layout paths");
  assertSafeRelativePath(value.configPath);
  assertSafeRelativePath(value.dataDir);
  if (!Array.isArray(value.entries)) throw new Error("invalid snapshot entries");

  const entries = value.entries.map((entry): InstallationSnapshotEntry => {
    if (!isRecord(entry)) throw new Error("invalid snapshot entry");
    assertExactKeys(entry, MANIFEST_ENTRY_KEYS, "snapshot manifest entry");
    if (entry.kind !== "bundle" && entry.kind !== "config" && entry.kind !== "data") {
      throw new Error("invalid snapshot entry kind");
    }
    assertSafeRelativePath(entry.path);
    const entryPath = entry.path;
    if (!Number.isSafeInteger(entry.byteSize) || (entry.byteSize as number) < 0) {
      throw new Error(`invalid snapshot entry byteSize: ${entryPath}`);
    }
    assertSha256(entry.sha256);
    const dataName = entryPath.startsWith(`${DATA_DIR}/`) ? entryPath.slice(DATA_DIR.length + 1) : undefined;
    const bundleRoot = Object.values(bundleRoots).find((root) => entryPath.startsWith(`${root}/`));
    const expectedKind =
      entryPath === value.configPath
        ? "config"
        : dataName && ALLOWED_DATA_FILES.has(dataName)
          ? "data"
          : bundleRoot
            ? "bundle"
            : undefined;
    if (entry.kind !== expectedKind) throw new Error(`snapshot entry is outside its declared root: ${entryPath}`);
    if (bundleRoot) {
      const relativeParts = entryPath.slice(bundleRoot.length + 1).split("/");
      if (isSecretBearingBundlePath(relativeParts)) {
        throw new Error(`snapshot manifest includes a secret-bearing bundle path: ${entryPath}`);
      }
    }
    return { kind: entry.kind, path: entryPath, byteSize: entry.byteSize as number, sha256: entry.sha256 };
  });
  for (let index = 1; index < entries.length; index += 1) {
    if (compareStrings(entries[index - 1]?.path ?? "", entries[index]?.path ?? "") >= 0) {
      throw new Error("snapshot entries are not in canonical path order");
    }
  }
  return {
    schemaVersion: 1,
    snapshotFingerprint: value.snapshotFingerprint,
    producer: value.producer,
    configFingerprint: value.configFingerprint,
    defaultBundle: value.defaultBundle,
    bundleRoots,
    configPath: value.configPath,
    dataDir: value.dataDir,
    entries,
  };
}

function validateProducer(value: unknown): asserts value is ProducerIdentity {
  if (
    !isRecord(value) ||
    typeof value.version !== "string" ||
    !value.version ||
    (value.commit !== null && typeof value.commit !== "string")
  ) {
    throw new Error("invalid snapshot producer identity");
  }
  assertExactKeys(value, PRODUCER_KEYS, "snapshot producer identity");
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
  required: readonly string[] = allowed,
): void {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(value).filter((key) => !allowedSet.has(key));
  const missing = required.filter((key) => !Object.hasOwn(value, key));
  if (unexpected.length > 0 || missing.length > 0) {
    throw new Error(
      `${label} has invalid keys` +
        (unexpected.length > 0 ? `; unexpected: ${unexpected.sort(compareStrings).join(", ")}` : "") +
        (missing.length > 0 ? `; missing: ${missing.join(", ")}` : ""),
    );
  }
}

function assertPrivatePermissionsSupported(): void {
  if (process.platform === "win32") {
    throw new Error("installation snapshots require POSIX private file modes; Windows ACL enforcement is unavailable");
  }
}

function createStagingDirectory(destination: string): string {
  if (lstatIfExists(destination)) throw new Error(`destination must not already exist: ${destination}`);
  const parent = path.dirname(destination);
  fs.mkdirSync(parent, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const canonicalParent = requireDirectory(parent, "destination parent");
  assertTrustedSourceDirectory(canonicalParent, "destination parent");
  const staging = fs.mkdtempSync(path.join(canonicalParent, `.${path.basename(destination)}.staging-`));
  try {
    fs.chmodSync(staging, PRIVATE_DIRECTORY_MODE);
    return staging;
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

function commitStagingDirectory(staging: string, destination: string): void {
  if (lstatIfExists(destination)) throw new Error(`destination appeared during snapshot creation: ${destination}`);
  fs.renameSync(staging, destination);
}

function makePrivateDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  fs.chmodSync(directory, PRIVATE_DIRECTORY_MODE);
}

function requireDirectory(directory: string, label: string): string {
  const resolved = path.resolve(directory);
  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${label} must be a non-symlink directory: ${directory}`);
  return fs.realpathSync(resolved);
}

function requireRegularPath(filePath: string, label: string): string {
  requireRegularFile(filePath, label);
  return fs.realpathSync(path.resolve(filePath));
}

function requireRegularFile(filePath: string, label: string): BigIntStats {
  const stat = fs.lstatSync(filePath, { bigint: true });
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${label} must be a non-symlink regular file: ${filePath}`);
  if (stat.nlink !== 1n) throw new Error(`hard links are not allowed in snapshots: ${filePath}`);
  return stat;
}

function lstatIfExists(filePath: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * Path-based no-follow checks cannot defeat another process running as this UID.
 * Require every source node to be owner-controlled and rely on the maintenance
 * barrier plus final content fingerprints for same-owner mutation detection.
 */
function assertTrustedCaptureSources(configPath: string, dataDir: string, bundleRoots: NamedRoot[]): void {
  assertTrustedSourceDirectory(path.dirname(configPath), "config parent directory");
  const configStat = requireRegularFile(configPath, "config file");
  assertTrustedSourceRegularFile(configPath, configStat, "config file");
  assertTrustedSourceDirectory(dataDir, "data source root");
  for (const { id, root } of bundleRoots) assertTrustedSourceDirectory(root, `bundle source root ${id}`);
}

function assertTrustedSourceDirectory(directory: string, label: string): void {
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${label} must be a non-symlink directory: ${directory}`);
  }
  assertTrustedSourceStat(directory, stat, label);
}

function assertTrustedSourceRegularFile(filePath: string, stat: BigIntStats, label: string): void {
  assertTrustedSourceStat(filePath, stat, label);
  if ((Number(stat.mode) & 0o111) !== 0) {
    throw new Error(`executable files are not supported by installation snapshots: ${filePath}`);
  }
}

function assertTrustedSourceStat(filePath: string, stat: fs.Stats | BigIntStats, label: string): void {
  const currentUid = process.getuid?.();
  if (currentUid !== undefined && Number(stat.uid) !== currentUid) {
    throw new Error(`${label} must be owned by the current user: ${filePath}`);
  }
  if ((Number(stat.mode) & 0o022) !== 0) {
    throw new Error(`${label} must not be group- or world-writable: ${filePath}`);
  }
}

function assertMode(filePath: string, expected: number, label: string): void {
  if (process.platform === "win32") return;
  const actual = fs.lstatSync(filePath).mode & 0o777;
  if (actual !== expected) throw new Error(`${label} must have mode ${expected.toString(8)}: ${filePath}`);
}

function resolveInside(root: string, relativePath: string): string {
  assertSafeRelativePath(relativePath);
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, ...relativePath.split("/"));
  if (!isSameOrInside(resolved, resolvedRoot)) throw new Error(`path escapes snapshot root: ${relativePath}`);
  return resolved;
}

function assertNonOverlappingDestination(destination: string, sources: readonly string[]): void {
  const canonicalDestination = canonicalPathWithMissingTail(destination);
  for (const source of sources) {
    const canonicalSource = canonicalPathWithMissingTail(source);
    if (isSameOrInside(canonicalDestination, canonicalSource) || isSameOrInside(canonicalSource, canonicalDestination)) {
      throw new Error(`destination overlaps a snapshot source: ${source}`);
    }
  }
}

function assertNonOverlappingSources(configPath: string, dataDir: string, bundleRoots: NamedRoot[]): void {
  const sources = [
    { label: "config file", path: configPath },
    { label: "data source root", path: dataDir },
    ...bundleRoots.map(({ id, root }) => ({ label: `bundle source root ${id}`, path: root })),
  ];
  for (let leftIndex = 0; leftIndex < sources.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < sources.length; rightIndex += 1) {
      const left = sources[leftIndex]!;
      const right = sources[rightIndex]!;
      if (isSameOrInside(left.path, right.path) || isSameOrInside(right.path, left.path)) {
        throw new Error(`snapshot sources overlap: ${left.label} and ${right.label}`);
      }
    }
  }
}

function canonicalPathWithMissingTail(target: string): string {
  let existing = path.resolve(target);
  const tail: string[] = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    tail.unshift(path.basename(existing));
    existing = parent;
  }
  return path.resolve(fs.realpathSync(existing), ...tail);
}

function isSameOrInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function safeBundleId(id: string): string {
  return /^[A-Za-z0-9_-]+$/.test(id) ? id : `bundle-${hashBytes(id).slice(0, 16)}`;
}

function asSafeRelativePath(value: string): SafeRelativePath {
  assertSafeRelativePath(value);
  return value;
}

function sameFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameStableFile(left: BigIntStats, right: BigIntStats): boolean {
  return (
    sameFileIdentity(left, right) &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function hashBytes(value: string | NodeJS.ArrayBufferView): Sha256 {
  return crypto.createHash("sha256").update(value).digest("hex") as Sha256;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function prettyCanonicalJson(value: unknown): string {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, canonicalize(value[key])]),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
