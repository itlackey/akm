#!/usr/bin/env bun
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseSemver } from "semver";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const PACKAGE_NAME = "akm-cli";
const PUBLISHED_BINS = ["akm", "akm-migrate-storage"] as const;

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd: string;
  env?: Record<string, string | undefined>;
}

export type CommandRunner = (command: readonly string[], options: RunOptions) => Promise<CommandResult>;

interface PackageMetadata {
  name: string;
  version: string;
  bin?: string | Record<string, string>;
}

interface PackedPackage {
  filename: string;
}

export interface LocalPackageCandidate {
  canonicalTarball: string;
  localTarball: string;
  localVersion: string;
  payloadHash: string;
  stagedPackageDir: string;
}

export interface VerifiedInstall {
  launcher: string;
  launchers: Record<(typeof PUBLISHED_BINS)[number], string>;
  packageDir: string;
  version: string;
}

export interface ExpectedPackage {
  name: string;
  version: string;
}

export interface GlobalInstallFlow {
  candidateTarball: string;
  expected: ExpectedPackage;
  realPrefix: string;
  rollbackDir: string;
  temporaryPrefix: string;
}

export interface GlobalInstallFlowDeps {
  install: (tarball: string, prefix: string) => Promise<void>;
  pack: (sourceDir: string, destination: string) => Promise<string>;
  uninstall: (packageName: string, prefix: string) => Promise<void>;
  verify: (prefix: string, expected: ExpectedPackage, allowLinkedPackage?: boolean) => Promise<VerifiedInstall>;
}

interface LauncherSnapshot {
  path: string;
  content?: Buffer;
  linkTarget?: string;
  mode?: number;
}

interface PriorGlobalPackage {
  expected: ExpectedPackage;
  kind: "link" | "regular";
  launcherSnapshots: LauncherSnapshot[];
  linkTarget?: string;
  packageDir: string;
}

function npmExecutable(): string {
  const executable = Bun.which("npm");
  if (!executable) throw new Error("npm is required for package installation checks");
  return executable;
}

function commandProcessor(env: Record<string, string | undefined>): string {
  return Object.entries(env).find(([key, value]) => key.toLowerCase() === "comspec" && value)?.[1] ?? "cmd.exe";
}

export function launcherExecutionCommand(
  launcher: string,
  args: readonly string[],
  platform = process.platform,
  env: Record<string, string | undefined> = process.env,
): string[] {
  return platform === "win32" ? [commandProcessor(env), "/d", "/s", "/c", launcher, ...args] : [launcher, ...args];
}

function npmCommand(args: readonly string[]): string[] {
  const executable = npmExecutable();
  return process.platform === "win32" && /\.(?:cmd|bat)$/i.test(executable)
    ? launcherExecutionCommand(executable, args)
    : [executable, ...args];
}

function commandText(command: readonly string[]): string {
  return command.map((part) => JSON.stringify(part)).join(" ");
}

export const runCommand: CommandRunner = async (command, options) => {
  const child = Bun.spawn([...command], {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(
      [`Command failed (${exitCode}): ${commandText(command)}`, stdout.trim(), stderr.trim()]
        .filter(Boolean)
        .join("\n"),
    );
  }
  return { stdout, stderr };
};

function readPackageMetadata(packageFile: string): PackageMetadata {
  const value = JSON.parse(fs.readFileSync(packageFile, "utf8")) as Partial<PackageMetadata>;
  if (typeof value.name !== "string" || typeof value.version !== "string") {
    throw new Error(`Invalid package metadata at ${packageFile}`);
  }
  return value as PackageMetadata;
}

export function parsePackedTarball(stdout: string, destination: string): string {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`npm pack did not return valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(value) || value.length !== 1) {
    throw new Error(
      `Expected npm pack to report one tarball, got ${Array.isArray(value) ? value.length : "non-array JSON"}`,
    );
  }
  const result = value[0] as Partial<PackedPackage>;
  if (typeof result.filename !== "string" || path.basename(result.filename) !== result.filename) {
    throw new Error("npm pack returned an invalid tarball filename");
  }
  const tarball = path.resolve(destination, result.filename);
  if (!fs.statSync(tarball).isFile()) throw new Error(`npm pack did not create ${tarball}`);
  return tarball;
}

export async function packPackage(
  sourceDir: string,
  destination: string,
  runner: CommandRunner = runCommand,
): Promise<string> {
  fs.mkdirSync(destination, { recursive: true });
  const result = await runner(npmCommand(["pack", "--ignore-scripts", "--json", "--pack-destination", destination]), {
    cwd: sourceDir,
  });
  return parsePackedTarball(result.stdout, destination);
}

export function formatUtcTimestamp(date: Date): string {
  if (!Number.isFinite(date.getTime())) throw new Error("Cannot derive a local package version from an invalid date");
  return date.toISOString().replaceAll(/[-:.]/g, "");
}

export function deriveLocalVersion(sourceVersion: string, date: Date, payloadHash: string): string {
  const parsed = parseSemver(sourceVersion);
  if (!parsed) throw new Error(`Cannot derive a local package version from invalid semver ${sourceVersion}`);
  if (!/^[a-f0-9]{8,}$/i.test(payloadHash)) throw new Error("Payload hash must be hexadecimal");
  const prerelease = parsed.prerelease.join(".");
  const patch = prerelease ? parsed.patch : parsed.patch + 1;
  const base = `${parsed.major}.${parsed.minor}.${patch}`;
  const localPrerelease = [
    prerelease || "0",
    "local",
    formatUtcTimestamp(date),
    `p${payloadHash.slice(0, 12).toLowerCase()}`,
  ].join(".");
  return `${base}-${localPrerelease}`;
}

export function hashFile(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

export async function stageCanonicalPayload(tarball: string, stageRoot: string): Promise<string> {
  const archive = new Bun.Archive(await Bun.file(tarball).bytes());
  await archive.extract(stageRoot);
  const packageDir = path.join(stageRoot, "package");
  const packageStat = fs.lstatSync(packageDir);
  if (!packageStat.isDirectory() || packageStat.isSymbolicLink()) {
    throw new Error(`npm package payload did not contain a regular package directory: ${packageDir}`);
  }
  readPackageMetadata(path.join(packageDir, "package.json"));
  return packageDir;
}

export function setStagedPackageVersion(packageDir: string, version: string): PackageMetadata {
  if (!parseSemver(version)) throw new Error(`Invalid staged package version ${version}`);
  const packageFile = path.join(packageDir, "package.json");
  const metadata = readPackageMetadata(packageFile);
  metadata.version = version;
  fs.writeFileSync(packageFile, `${JSON.stringify(metadata, null, 2)}\n`);
  return metadata;
}

export async function createLocalPackageCandidate(
  sourceDir: string,
  workDir: string,
  date = new Date(),
  runner: CommandRunner = runCommand,
): Promise<LocalPackageCandidate> {
  const canonicalTarball = await packPackage(sourceDir, path.join(workDir, "canonical"), runner);
  const payloadHash = hashFile(canonicalTarball);
  const stagedPackageDir = await stageCanonicalPayload(canonicalTarball, path.join(workDir, "stage"));
  const sourceMetadata = readPackageMetadata(path.join(stagedPackageDir, "package.json"));
  const localVersion = deriveLocalVersion(sourceMetadata.version, date, payloadHash);
  setStagedPackageVersion(stagedPackageDir, localVersion);
  const localTarball = await packPackage(stagedPackageDir, path.join(workDir, "local"), runner);
  return { canonicalTarball, localTarball, localVersion, payloadHash, stagedPackageDir };
}

export function npmGlobalInstallCommand(tarball: string, prefix?: string): string[] {
  const exactTarball = path.resolve(tarball);
  if (path.extname(exactTarball) !== ".tgz" || !fs.statSync(exactTarball).isFile()) {
    throw new Error(`npm global installs must use an exact .tgz package tarball: ${exactTarball}`);
  }
  const args = ["install", "--global", "--no-audit", "--no-fund"];
  if (prefix) args.push("--prefix", prefix);
  args.push(exactTarball);
  return npmCommand(args);
}

export async function installGlobalTarball(
  tarball: string,
  cwd: string,
  prefix?: string,
  runner: CommandRunner = runCommand,
): Promise<void> {
  await runner(npmGlobalInstallCommand(tarball, prefix), { cwd });
}

export async function uninstallGlobalPackage(
  packageName: string,
  cwd: string,
  prefix: string,
  runner: CommandRunner = runCommand,
): Promise<void> {
  await runner(npmCommand(["uninstall", "--global", "--no-audit", "--no-fund", "--prefix", prefix, packageName]), {
    cwd,
  });
}

export function globalPackageDir(prefix: string, packageName: string, platform = process.platform): string {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const modulesDir =
    platform === "win32" ? pathApi.join(prefix, "node_modules") : pathApi.join(prefix, "lib", "node_modules");
  return pathApi.join(modulesDir, packageName);
}

export function globalLauncherPath(prefix: string, binName: string, platform = process.platform): string {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  return platform === "win32" ? pathApi.join(prefix, `${binName}.cmd`) : pathApi.join(prefix, "bin", binName);
}

export function pathLauncherWarning(
  pathLauncher: string | null | undefined,
  verifiedLauncher: string,
  platform = process.platform,
): string | undefined {
  if (!pathLauncher) return undefined;
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const normalize = (value: string) => {
    const resolved = pathApi.resolve(value);
    return platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  if (normalize(pathLauncher) === normalize(verifiedLauncher)) return undefined;
  return `Warning: PATH resolves akm to ${pathLauncher}, not the verified npm-global launcher ${verifiedLauncher}.`;
}

function packageBinTarget(metadata: PackageMetadata, binName: string): string {
  const target = typeof metadata.bin === "string" ? metadata.bin : metadata.bin?.[binName];
  if (!target) throw new Error(`Installed package does not define the ${binName} launcher`);
  return target;
}

function lstatIfExists(file: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function installedBinTarget(metadata: PackageMetadata, packageDir: string, binName: string): string {
  const binTarget = packageBinTarget(metadata, binName);
  const expectedTarget = path.resolve(packageDir, binTarget);
  const relativeTarget = path.relative(packageDir, expectedTarget);
  if (relativeTarget.startsWith("..") || path.isAbsolute(relativeTarget)) {
    throw new Error(`Installed ${binName} target resolves outside the package: ${binTarget}`);
  }
  if (!fs.lstatSync(expectedTarget).isFile())
    throw new Error(`Installed ${binName} target is not a file: ${expectedTarget}`);
  return expectedTarget;
}

export function windowsShimOwnsTarget(shim: string, prefix: string, expectedTarget: string): boolean {
  const relativeTarget = path.win32.relative(prefix, expectedTarget);
  if (!relativeTarget || relativeTarget.startsWith("..") || path.win32.isAbsolute(relativeTarget)) return false;
  return shim.replaceAll("/", "\\").toLowerCase().includes(relativeTarget.toLowerCase());
}

function assertLauncherOwned(
  launcher: string,
  expectedTarget: string,
  prefix: string,
  binName: string,
  launcherStat: fs.Stats,
): void {
  if (process.platform === "win32") {
    if (!launcherStat.isFile() || !windowsShimOwnsTarget(fs.readFileSync(launcher, "utf8"), prefix, expectedTarget)) {
      throw new Error(`Existing ${launcher} is not owned by the installed ${PACKAGE_NAME} ${binName} target.`);
    }
    return;
  }
  if (!launcherStat.isSymbolicLink() || fs.realpathSync(launcher) !== fs.realpathSync(expectedTarget)) {
    throw new Error(`Existing ${launcher} is not owned by the installed ${PACKAGE_NAME} ${binName} target.`);
  }
}

function inspectPriorGlobalPackage(prefix: string, packageName: string): PriorGlobalPackage | undefined {
  const packageDir = globalPackageDir(prefix, packageName);
  const packageStat = lstatIfExists(packageDir);
  const launcherPaths = PUBLISHED_BINS.map((binName) => ({ binName, path: globalLauncherPath(prefix, binName) }));
  if (!packageStat) {
    const stray = launcherPaths.find(({ path: launcher }) => lstatIfExists(launcher));
    if (stray) throw new Error(`Refusing to install: ${stray.path} exists but no ${packageName} package is installed.`);
    return undefined;
  }
  if (!packageStat.isDirectory() && !packageStat.isSymbolicLink()) {
    throw new Error(`Refusing to replace non-package entry at ${packageDir}`);
  }

  const metadata = readPackageMetadata(path.join(packageDir, "package.json"));
  if (metadata.name !== packageName) {
    throw new Error(`Refusing to replace unexpected package ${metadata.name} at ${packageDir}`);
  }
  const launcherSnapshots = launcherPaths.map(({ binName, path: launcher }): LauncherSnapshot => {
    const launcherStat = lstatIfExists(launcher);
    if (!launcherStat) return { path: launcher };
    const expectedTarget = installedBinTarget(metadata, packageDir, binName);
    assertLauncherOwned(launcher, expectedTarget, prefix, binName, launcherStat);
    return launcherStat.isSymbolicLink()
      ? { path: launcher, linkTarget: fs.readlinkSync(launcher) }
      : { path: launcher, content: fs.readFileSync(launcher), mode: launcherStat.mode };
  });
  const linked = packageStat.isSymbolicLink();
  return {
    expected: { name: metadata.name, version: metadata.version },
    kind: linked ? "link" : "regular",
    launcherSnapshots,
    linkTarget: linked ? fs.readlinkSync(packageDir) : undefined,
    packageDir,
  };
}

function removeEntry(file: string): void {
  const stat = lstatIfExists(file);
  if (!stat) return;
  if (stat.isDirectory() && !stat.isSymbolicLink()) fs.rmSync(file, { recursive: true, force: true });
  else fs.unlinkSync(file);
}

function restoreLinkedPackage(prior: PriorGlobalPackage): void {
  if (prior.kind !== "link" || !prior.linkTarget) throw new Error("Linked rollback snapshot is incomplete");
  removeEntry(prior.packageDir);
  fs.mkdirSync(path.dirname(prior.packageDir), { recursive: true });
  fs.symlinkSync(prior.linkTarget, prior.packageDir, process.platform === "win32" ? "junction" : undefined);
  for (const snapshot of prior.launcherSnapshots) {
    removeEntry(snapshot.path);
    if (snapshot.linkTarget !== undefined) {
      fs.mkdirSync(path.dirname(snapshot.path), { recursive: true });
      fs.symlinkSync(snapshot.linkTarget, snapshot.path);
    } else if (snapshot.content) {
      fs.mkdirSync(path.dirname(snapshot.path), { recursive: true });
      fs.writeFileSync(snapshot.path, snapshot.content, { mode: snapshot.mode });
    }
  }
}

export async function verifyGlobalInstall(
  prefix: string,
  expected: ExpectedPackage,
  runner: CommandRunner = runCommand,
  allowLinkedPackage = false,
): Promise<VerifiedInstall> {
  const packageDir = globalPackageDir(prefix, expected.name);
  const packageStat = fs.lstatSync(packageDir);
  const validPackageRoot = packageStat.isDirectory() || (allowLinkedPackage && packageStat.isSymbolicLink());
  if (!validPackageRoot || (!allowLinkedPackage && packageStat.isSymbolicLink())) {
    throw new Error(
      `Installed package is not ${allowLinkedPackage ? "a directory or restored link" : "a regular npm global package directory"}: ${packageDir}`,
    );
  }
  const metadata = readPackageMetadata(path.join(packageDir, "package.json"));
  if (metadata.name !== expected.name || metadata.version !== expected.version) {
    throw new Error(
      `Installed ${metadata.name}@${metadata.version}; expected exact package ${expected.name}@${expected.version}`,
    );
  }

  const launchers = {} as VerifiedInstall["launchers"];
  for (const binName of PUBLISHED_BINS) {
    const expectedTarget = installedBinTarget(metadata, packageDir, binName);

    const launcher = globalLauncherPath(prefix, binName);
    if (!fs.existsSync(launcher)) throw new Error(`npm did not generate the expected global launcher: ${launcher}`);
    if (process.platform === "win32") {
      if (!windowsShimOwnsTarget(fs.readFileSync(launcher, "utf8"), prefix, expectedTarget)) {
        throw new Error(`npm's generated ${binName} launcher does not reference installed target ${expectedTarget}`);
      }
    } else if (fs.realpathSync(launcher) !== fs.realpathSync(expectedTarget)) {
      throw new Error(`npm's generated ${binName} launcher does not resolve to ${expectedTarget}`);
    }
    launchers[binName] = launcher;
  }

  // migrate-storage has no inert --help path; invoking it can enter migration logic.
  const launcher = launchers.akm;
  const execution = await runner(launcherExecutionCommand(launcher, ["--version"]), { cwd: prefix });
  if (execution.stdout.trim() !== expected.version) {
    throw new Error(
      `Installed launcher reported ${JSON.stringify(execution.stdout.trim())}, expected ${expected.version}`,
    );
  }
  return { launcher, launchers, packageDir, version: metadata.version };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function replaceGlobalPackage(
  flow: GlobalInstallFlow,
  deps: GlobalInstallFlowDeps,
): Promise<VerifiedInstall> {
  await deps.install(flow.candidateTarball, flow.temporaryPrefix);
  await deps.verify(flow.temporaryPrefix, flow.expected);

  const previous = inspectPriorGlobalPackage(flow.realPrefix, flow.expected.name);
  let rollbackTarball: string | undefined;
  if (previous?.kind === "regular") {
    rollbackTarball = await deps.pack(previous.packageDir, flow.rollbackDir);
  }

  try {
    await deps.install(flow.candidateTarball, flow.realPrefix);
    return await deps.verify(flow.realPrefix, flow.expected);
  } catch (installError) {
    const original = `Global install failed: ${errorText(installError)}`;
    if (!previous) {
      try {
        await deps.uninstall(flow.expected.name, flow.realPrefix);
      } catch (cleanupError) {
        throw new Error(`${original}\nCleanup of the partial install also failed: ${errorText(cleanupError)}`, {
          cause: installError,
        });
      }
      throw new Error(`${original}\nRemoved the partial ${flow.expected.name} install; no previous package existed.`, {
        cause: installError,
      });
    }
    try {
      if (previous.kind === "link") restoreLinkedPackage(previous);
      else {
        if (!rollbackTarball) throw new Error("Regular package rollback tarball is missing");
        await deps.install(rollbackTarball, flow.realPrefix);
      }
      await deps.verify(flow.realPrefix, previous.expected, previous.kind === "link");
    } catch (rollbackError) {
      throw new Error(`${original}\nRollback also failed: ${errorText(rollbackError)}`, { cause: installError });
    }
    const restored =
      previous.kind === "link"
        ? `Restored previous linked ${previous.expected.name}@${previous.expected.version} -> ${previous.linkTarget}.`
        : `Restored previous ${previous.expected.name}@${previous.expected.version} from its rollback tarball.`;
    throw new Error(`${original}\n${restored}`, { cause: installError });
  }
}

async function buildCurrentCheckout(): Promise<void> {
  console.log("Building current checkout...");
  const result = await runCommand([process.execPath, "run", "build"], { cwd: REPO_ROOT });
  if (result.stdout.trim()) console.log(result.stdout.trim());
  if (result.stderr.trim()) console.error(result.stderr.trim());
}

async function configuredGlobalPrefix(): Promise<string> {
  const result = await runCommand(npmCommand(["prefix", "--global"]), { cwd: REPO_ROOT });
  const prefix = result.stdout.trim();
  if (!prefix) throw new Error("npm returned an empty global prefix");
  return path.resolve(prefix);
}

async function installCurrentCheckoutGlobally(): Promise<void> {
  await buildCurrentCheckout();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-build-install-"));
  try {
    const candidate = await createLocalPackageCandidate(REPO_ROOT, workDir);
    const realPrefix = await configuredGlobalPrefix();
    console.log(
      `Preflighting and installing exact package tarball ${path.basename(candidate.localTarball)} globally...`,
    );
    const verified = await replaceGlobalPackage(
      {
        candidateTarball: candidate.localTarball,
        expected: { name: PACKAGE_NAME, version: candidate.localVersion },
        realPrefix,
        rollbackDir: path.join(workDir, "rollback"),
        temporaryPrefix: path.join(workDir, "preflight-prefix"),
      },
      {
        install: (tarball, prefix) => installGlobalTarball(tarball, REPO_ROOT, prefix),
        pack: (sourceDir, destination) => packPackage(sourceDir, destination),
        uninstall: (packageName, prefix) => uninstallGlobalPackage(packageName, REPO_ROOT, prefix),
        verify: (prefix, expected, allowLinkedPackage) =>
          verifyGlobalInstall(prefix, expected, runCommand, allowLinkedPackage),
      },
    );
    console.log(`Installed and verified ${PACKAGE_NAME}@${verified.version} via ${verified.launcher}`);
    const warning = pathLauncherWarning(Bun.which("akm"), verified.launcher);
    if (warning) console.warn(warning);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

async function testPackageAcceptance(skipBuild = false): Promise<void> {
  if (!skipBuild) await buildCurrentCheckout();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-package-acceptance-"));
  try {
    const metadata = readPackageMetadata(path.join(REPO_ROOT, "package.json"));
    const tarball = await packPackage(REPO_ROOT, path.join(workDir, "packed"));
    const prefix = path.join(workDir, "npm-prefix");
    await installGlobalTarball(tarball, REPO_ROOT, prefix);
    const verified = await verifyGlobalInstall(prefix, {
      name: metadata.name,
      version: metadata.version,
    });
    console.log(`Package acceptance passed for ${metadata.name}@${verified.version} via ${verified.launcher}`);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const action = Bun.argv[2];
  if (action === "install-global") {
    await installCurrentCheckoutGlobally();
    return;
  }
  if (action === "test-package") {
    await testPackageAcceptance(Bun.argv.includes("--skip-build"));
    return;
  }
  throw new Error("Usage: bun scripts/package-install.ts <install-global|test-package>");
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
