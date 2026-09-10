// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import * as childProcess from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  fetchWithRetry,
  IS_WINDOWS,
  ResponseTooLargeError,
  readBodyWithByteCap,
  readChunkWithDeadline,
} from "../../core/common";
import { ConfigError } from "../../core/errors";
import { warn } from "../../core/warn";
import { githubHeaders } from "../../integrations/github";
import { getDirname, mainPath, semverOrder } from "../../runtime";
import type { UpgradeCheckResponse, UpgradeResponse } from "../../sources/types";
import { resolveNpmGlobalRoot } from "../../tasks/resolve-akm-bin";
import { runMigrationTool } from "../migration-tool";

const REPO = "itlackey/akm";
const DEFAULT_PACKAGE_NAME = "akm-cli";
const NODE_MODULES_SEGMENT = "/node_modules/";
const BUN_GLOBAL_INSTALL_PATTERN = /(^|\/)\.bun\/(?:[^/]+\/)+node_modules\//;
const PNPM_GLOBAL_INSTALL_PATTERN = /(^|\/)(?:pnpm\/global|\.pnpm-global)(?:\/\d+)?\/node_modules\//;
const MAX_BINARY_DOWNLOAD_BYTES = 256 * 1024 * 1024;
const MAX_CHECKSUM_METADATA_BYTES = 1024 * 1024;

export type InstallMethod = UpgradeCheckResponse["installMethod"];

export interface SelfUpdateDependencies {
  execPath: string;
  runMigrationTool: typeof runMigrationTool;
}

/**
 * Bounds on the binary body read. `fetchWithTimeout`'s timer only covers
 * time-to-HEADERS — it is cleared the moment `fetch` resolves — so without
 * these a compromised or misconfigured endpoint could dribble bytes forever
 * and hang `akm upgrade` with no output and no way out but Ctrl-C. Two
 * bounds, because either alone is evadable: a per-chunk STALL deadline (a
 * connection making no progress dies quickly, while a slow-but-progressing
 * one is left alone) and an OVERALL deadline (a trickle that sends one byte
 * per stall-window can't stretch the download indefinitely).
 */
const BINARY_STALL_TIMEOUT_MS = 60_000;
const BINARY_TOTAL_TIMEOUT_MS = 30 * 60_000;

export async function streamResponseToFile(
  response: Response,
  destination: string,
  maxBytes: number,
  limits?: { stallTimeoutMs?: number; totalTimeoutMs?: number },
): Promise<{ byteSize: number; sha256: string }> {
  const declaredText = response.headers.get("content-length");
  if (declaredText) {
    const declared = Number(declaredText);
    if (Number.isFinite(declared) && declared > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new ResponseTooLargeError(response.url || "binary download", maxBytes, declared);
    }
  }
  if (!response.body) throw new Error("Binary download response did not provide a streaming body.");

  const url = response.url || "binary download";
  const stallTimeoutMs = limits?.stallTimeoutMs ?? BINARY_STALL_TIMEOUT_MS;
  const totalTimeoutMs = limits?.totalTimeoutMs ?? BINARY_TOTAL_TIMEOUT_MS;
  const overallDeadlineAt = Date.now() + totalTimeoutMs;

  const fd = fs.openSync(destination, "w", 0o600);
  const reader = response.body.getReader();
  const hash = createHash("sha256");
  let byteSize = 0;
  try {
    while (true) {
      // Whichever bound bites first wins, and the error reports THAT bound —
      // "no data for 60s" and "download exceeded 30m" are different diagnoses.
      const stallDeadlineAt = Date.now() + stallTimeoutMs;
      const deadlineAt = Math.min(stallDeadlineAt, overallDeadlineAt);
      const reportedTimeoutMs = deadlineAt === overallDeadlineAt ? totalTimeoutMs : stallTimeoutMs;
      const { done, value } = await readChunkWithDeadline(reader, deadlineAt, undefined, url, reportedTimeoutMs);
      if (done) break;
      if (!value) continue;
      byteSize += value.byteLength;
      // The catch block cancels the reader for every throw path, this included.
      if (byteSize > maxBytes) throw new ResponseTooLargeError(url, maxBytes, byteSize);
      hash.update(value);
      let written = 0;
      while (written < value.byteLength) written += fs.writeSync(fd, value, written, value.byteLength - written);
    }
    fs.fdatasyncSync(fd);
    return { byteSize, sha256: hash.digest("hex") };
  } catch (error) {
    // Cancel so a timed-out (still-open) connection releases its socket rather
    // than lingering until process exit. Already-cancelled readers no-op.
    await reader.cancel().catch(() => undefined);
    removeFileBestEffort(destination);
    throw error;
  } finally {
    reader.releaseLock();
    fs.closeSync(fd);
  }
}

/** Signals used by detectInstallMethod; extracted for testability. */
export interface InstallSignals {
  bunMain: string | undefined;
  importMetaDir: string | undefined;
  hasAkmVersion: boolean;
  /** The npm global root for the Node this install runs under, when provable. */
  npmGlobalRoot?: string;
}

/** Read live runtime signals. */
export function getInstallSignals(): InstallSignals {
  return {
    bunMain: mainPath,
    importMetaDir: getDirname(import.meta.url),
    hasAkmVersion: typeof AKM_VERSION !== "undefined",
    npmGlobalRoot: resolveNpmGlobalRootForThisProcess(),
  };
}

function resolveNpmGlobalRootForThisProcess(): string | undefined {
  const nodePath = process.env.AKM_LAUNCHER_NODE?.trim() || (process.versions.bun ? undefined : process.execPath);
  if (!nodePath) return undefined;
  try {
    return resolveNpmGlobalRoot(nodePath, process.env);
  } catch {
    return undefined;
  }
}

function isUnderDirectory(dir: string, root: string): boolean {
  const real = (value: string): string => {
    try {
      return fs.realpathSync(value);
    } catch {
      return path.resolve(value);
    }
  };
  const relative = path.relative(real(root), real(dir));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** The package that depends on this akm: the directory holding the `node_modules` it lives in. */
function packageLocalRoot(importMetaDir: string): string {
  const index = normalizePathSeparators(importMetaDir).lastIndexOf(NODE_MODULES_SEGMENT);
  return index < 0 ? importMetaDir : importMetaDir.slice(0, index);
}

// AKM_VERSION ambient type is declared in globals.d.ts

export function detectInstallMethod(signals?: InstallSignals): InstallMethod {
  const s = signals ?? getInstallSignals();
  const normalizedImportMetaDir = normalizePathSeparators(s.importMetaDir);

  if (normalizedImportMetaDir.includes(NODE_MODULES_SEGMENT)) {
    if (BUN_GLOBAL_INSTALL_PATTERN.test(normalizedImportMetaDir)) {
      return "bun";
    }
    if (PNPM_GLOBAL_INSTALL_PATTERN.test(normalizedImportMetaDir)) {
      return "pnpm";
    }
    // A node_modules install outside the npm global root is a DEPENDENCY of
    // some other package (an image's tools dir, a plugin's node_modules):
    // it moves when that package does, and an `npm install -g` here would
    // "succeed" while the parent kept executing its own copy. Only a proven
    // global root can make that call; without one this stays "npm".
    if (s.npmGlobalRoot && s.importMetaDir && !isUnderDirectory(s.importMetaDir, s.npmGlobalRoot)) {
      return "package-local";
    }
    return "npm";
  }

  // Bun-compiled binaries: mainPath points to a virtual /$bunfs/
  // path, NOT process.execPath. The old check (mainPath === process.execPath) was
  // always false for compiled binaries, causing "unknown" for every binary user.
  if (s.bunMain !== undefined) {
    // Primary check: compiled binaries embed sources under /$bunfs/
    if (s.bunMain.startsWith("/$bunfs/")) {
      return "binary";
    }
    // Secondary check: AKM_VERSION is defined only in compiled builds (via --define)
    if (s.hasAkmVersion) {
      return "binary";
    }
  }

  return "unknown";
}

export function getAkmBinaryName(): string {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === "linux" && arch === "x64") return "akm-linux-x64";
  if (platform === "linux" && arch === "arm64") return "akm-linux-arm64";
  if (platform === "darwin" && arch === "x64") return "akm-darwin-x64";
  if (platform === "darwin" && arch === "arm64") return "akm-darwin-arm64";
  if (platform === "win32" && arch === "x64") return "akm-windows-x64.exe";

  throw new ConfigError(`Unsupported platform for binary upgrade: ${platform}/${arch}`, "UNSUPPORTED_PLATFORM");
}

export async function checkForUpdate(
  currentVersion: string,
  fetchOptions?: { timeout?: number; retries?: number },
): Promise<UpgradeCheckResponse> {
  const installMethod = detectInstallMethod();
  const url = `https://api.github.com/repos/${REPO}/releases/latest`;
  const response = await fetchWithRetry(url, { headers: githubHeaders() }, fetchOptions);

  if (!response.ok) {
    throw new Error(`Failed to check for updates: ${response.status} ${response.statusText}`);
  }

  const release = JSON.parse(await readBodyWithByteCap(response, MAX_CHECKSUM_METADATA_BYTES)) as {
    tag_name?: string;
  };
  const latestTag = release.tag_name ?? "";
  const latestVersion = latestTag.replace(/^v/, "");

  return {
    currentVersion,
    latestVersion,
    updateAvailable: latestVersion !== "" && semverOrder(currentVersion, latestVersion) < 0,
    installMethod,
  };
}

/**
 * Whether the operator has asked to bypass upgrade checksum verification.
 *
 * Deliberately NOT a CLI flag (C6): STABILITY.md states checksum verification
 * is not optional, so the recovery hatch for a genuinely broken `checksums.txt`
 * is this internal, undocumented-on-purpose env var — not something
 * discoverable in `--help` or offered by tab completion.
 *
 * Extracted rather than read inline so `performUpgrade` stays under the
 * function-size bar (`scripts/lint-src-fn-size.ts`), whose baseline only
 * shrinks.
 */
function checksumBypassRequested(): boolean {
  return process.env.AKM_UPGRADE_SKIP_CHECKSUM === "1";
}

export async function performUpgrade(
  check: UpgradeCheckResponse,
  opts?: { force?: boolean; skipPostUpgrade?: boolean },
  dependencies?: Partial<SelfUpdateDependencies>,
): Promise<UpgradeResponse> {
  const { currentVersion, latestVersion, installMethod } = check;
  const force = opts?.force === true;
  const skipPostUpgrade = opts?.skipPostUpgrade === true;
  const runTool = dependencies?.runMigrationTool ?? runMigrationTool;

  // Every `akm upgrade` ends by running `akm-migrate apply`, install or no
  // install: the migrator on disk after the install step is the one whose
  // migrations the installed akm needs, and an image that ships akm has
  // nothing to install and nobody to run a migration by hand (#895). The two
  // no-install cases return here.
  if (installMethod === "package-local") {
    const parent = packageLocalRoot(getInstallSignals().importMetaDir ?? "");
    return {
      currentVersion,
      newVersion: latestVersion,
      upgraded: false,
      installMethod,
      message: `akm runs as a dependency of the package at ${parent}; upgrade that package to move akm.`,
      migration: await runMigrationStep(runTool),
    };
  }
  if (!check.updateAvailable && !force) {
    return {
      currentVersion,
      newVersion: latestVersion,
      upgraded: false,
      installMethod,
      message: `akm v${currentVersion} is already the latest version`,
      migration: await runMigrationStep(runTool),
    };
  }

  const packageManagerCommand = getPackageManagerUpgradeCommand(installMethod);
  if (packageManagerCommand) {
    return runPackageManagerUpgrade({
      packageManagerCommand,
      currentVersion,
      latestVersion,
      installMethod,
      skipPostUpgrade,
      runTool,
    });
  }

  if (installMethod === "unknown") {
    return {
      currentVersion,
      newVersion: latestVersion,
      upgraded: false,
      installMethod,
      message: `Unable to detect install method. Upgrade manually from https://github.com/${REPO}/releases`,
      migration: await runMigrationStep(runTool),
    };
  }

  // Binary install
  if (!latestVersion) {
    throw new Error(
      "Unable to determine latest version from GitHub releases. Check https://github.com/itlackey/akm/releases",
    );
  }

  const tag = `v${latestVersion}`;
  const binaryName = getAkmBinaryName();
  const binaryUrl = `https://github.com/${REPO}/releases/download/${tag}/${binaryName}`;
  const checksumsUrl = `https://github.com/${REPO}/releases/download/${tag}/checksums.txt`;
  const execPath = dependencies?.execPath ?? process.execPath;
  const execDir = path.dirname(execPath);
  const execName = path.basename(execPath);
  const stagedPath = IS_WINDOWS
    ? path.join(execDir, `.${execName}.new.${process.pid}`)
    : path.join(execDir, `.${execName}.tmp.${process.pid}`);
  const backupPath = `${execPath}${IS_WINDOWS ? ".old" : ".bak"}`;

  // Download binary
  const binaryResponse = await fetchWithRetry(binaryUrl);
  if (!binaryResponse.ok) {
    throw new Error(`Failed to download binary: ${binaryResponse.status} ${binaryResponse.statusText}`);
  }
  let downloaded: { byteSize: number; sha256: string };
  try {
    downloaded = await streamResponseToFile(binaryResponse, stagedPath, MAX_BINARY_DOWNLOAD_BYTES);
    if (!IS_WINDOWS) fs.chmodSync(stagedPath, 0o755);
  } catch (err) {
    removeFileBestEffort(stagedPath);
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") {
      throw new ConfigError(
        `Permission denied writing to ${execDir}.\n` +
          `${IS_WINDOWS ? "Try running as Administrator." : "Run: sudo akm upgrade"}\n` +
          `Or re-run the install script: curl -fsSL https://raw.githubusercontent.com/${REPO}/main/install.sh | bash`,
        "UPGRADE_BLOCKED",
      );
    }
    throw err;
  }

  // Download and verify checksum (mandatory — upgrade is blocked if checksums cannot be fetched).
  let checksumVerified = false;
  const skipChecksum = checksumBypassRequested();
  try {
    const checksumsResponse = await fetchWithRetry(checksumsUrl);
    if (!checksumsResponse.ok) {
      if (skipChecksum) {
        warn(
          `WARNING: checksums.txt fetch failed (HTTP ${checksumsResponse.status}). Proceeding without verification because AKM_UPGRADE_SKIP_CHECKSUM=1 was set.`,
        );
      } else {
        throw new Error(
          `Checksum verification failed: could not fetch ${checksumsUrl} (HTTP ${checksumsResponse.status}). ` +
            `Set AKM_UPGRADE_SKIP_CHECKSUM=1 to bypass (not recommended).`,
        );
      }
    } else {
      const checksumsText = await readBodyWithByteCap(checksumsResponse, MAX_CHECKSUM_METADATA_BYTES);
      const expectedHash = parseChecksumForFile(checksumsText, binaryName);
      if (expectedHash) {
        const actualHash = downloaded.sha256;
        if (actualHash !== expectedHash) {
          throw new Error(
            `Checksum mismatch for ${binaryName}.\n` + `Expected: ${expectedHash}\n` + `Got:      ${actualHash}`,
          );
        }
        checksumVerified = true;
      } else {
        if (skipChecksum) {
          warn(
            `WARNING: ${binaryName} not found in checksums.txt. Proceeding without verification because AKM_UPGRADE_SKIP_CHECKSUM=1 was set.`,
          );
        } else {
          throw new Error(
            `Checksum verification failed: ${binaryName} not listed in checksums.txt. ` +
              `Set AKM_UPGRADE_SKIP_CHECKSUM=1 to bypass (not recommended).`,
          );
        }
      }
    }
  } catch (err) {
    if (
      err instanceof Error &&
      (err.message.includes("Checksum mismatch") || err.message.includes("Checksum verification failed"))
    ) {
      removeFileBestEffort(stagedPath);
      throw err;
    }
    // Network or parse failure
    if (skipChecksum) {
      warn(
        `WARNING: Could not fetch or parse checksums: ${err instanceof Error ? err.message : String(err)}. Proceeding because AKM_UPGRADE_SKIP_CHECKSUM=1 was set.`,
      );
    } else {
      removeFileBestEffort(stagedPath);
      throw new Error(
        `Checksum verification failed: ${err instanceof Error ? err.message : String(err)}. ` +
          `Set AKM_UPGRADE_SKIP_CHECKSUM=1 to bypass (not recommended).`,
      );
    }
  }

  if (fs.existsSync(backupPath)) {
    warn(`A previous upgrade left a stale backup at ${backupPath}; overwriting it.`);
    removeFileBestEffort(backupPath);
  }

  try {
    if (IS_WINDOWS) fs.renameSync(execPath, backupPath);
    else fs.copyFileSync(execPath, backupPath);
    fs.renameSync(stagedPath, execPath);
  } catch (err) {
    removeFileBestEffort(stagedPath);
    if (!fs.existsSync(execPath) && fs.existsSync(backupPath)) {
      fs.renameSync(backupPath, execPath);
    }
    throw err;
  }

  // The replacement completed; the temporary rollback copy is no longer needed.
  removeFileBestEffort(backupPath);

  // The new binary is at execPath now, so this re-execs the NEW migrator.
  const migration = await runMigrationStep(runTool);
  return {
    currentVersion,
    newVersion: latestVersion,
    upgraded: true,
    installMethod,
    binaryPath: execPath,
    checksumVerified,
    migration,
    postUpgrade: runPostUpgradeTasks(execPath, { skip: skipPostUpgrade }),
  };
}

/**
 * `akm-migrate apply`, spawned so it is whichever migrator is on disk NOW:
 * after a successful install, the new one. Its JSON plan becomes the
 * response's `migration`. A migrator that could not run or print a plan
 * reports `failed` with its error text instead of throwing, so the install
 * outcome the caller is about to report is never lost behind it.
 */
async function runMigrationStep(runTool: typeof runMigrationTool): Promise<NonNullable<UpgradeResponse["migration"]>> {
  let result: Awaited<ReturnType<typeof runMigrationTool>>;
  try {
    result = await runTool(["apply"]);
  } catch (error) {
    return { status: "failed", error: error instanceof Error ? error.message : String(error) };
  }
  const line = result.stdout.trim();
  try {
    const plan = JSON.parse(line) as { status?: unknown } & Record<string, unknown>;
    if (plan.status === "current" || plan.status === "ready" || plan.status === "blocked") {
      return plan as NonNullable<UpgradeResponse["migration"]>;
    }
  } catch {
    // Not a plan; reported below with whatever the migrator did say.
  }
  return { status: "failed", error: result.stderr.trim() || line || `akm-migrate exited ${result.status}` };
}

/**
 * Rebuild the derived index after a successful upgrade.
 */
function runPostUpgradeTasks(akmBin: string, opts: { skip: boolean }): NonNullable<UpgradeResponse["postUpgrade"]> {
  if (opts.skip) {
    return {
      ok: true,
      skipped: true,
      message: "Upgrade completed. Skipped the index rebuild. Run `akm index` manually to rebuild the index.",
    };
  }
  try {
    const result = childProcess.spawnSync(akmBin, ["index"], {
      encoding: "utf8",
      env: process.env,
      stdio: "pipe",
    });
    if (result.error) {
      return {
        ok: false,
        skipped: false,
        message: `Upgrade completed. The index rebuild could not start: ${result.error.message}. Run \`akm index\` manually.`,
      };
    }
    if (result.status !== 0) {
      const detail = (result.stderr ?? "").trim() || (result.stdout ?? "").trim() || `exit code ${result.status}`;
      return {
        ok: false,
        skipped: false,
        exitCode: result.status,
        message: `Upgrade completed. Post-upgrade \`akm index\` failed (${detail}). Run \`akm index\` manually.`,
      };
    }
    return {
      ok: true,
      skipped: false,
      exitCode: 0,
      message: "Upgrade completed and the index was rebuilt against the new binary.",
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      skipped: false,
      message: `Upgrade completed. The index rebuild failed: ${detail}. Run \`akm index\` manually.`,
    };
  }
}

/**
 * The package-manager arm of {@link performUpgrade}: install → post-install
 * version verification → post-upgrade tasks.
 * Extracted whole so performUpgrade stays under its fn-size baseline.
 */
async function runPackageManagerUpgrade(input: {
  packageManagerCommand: NonNullable<ReturnType<typeof getPackageManagerUpgradeCommand>>;
  currentVersion: string;
  latestVersion: string | undefined;
  installMethod: InstallMethod;
  skipPostUpgrade: boolean;
  runTool: typeof runMigrationTool;
}): Promise<UpgradeResponse> {
  const { packageManagerCommand, currentVersion, latestVersion, installMethod, skipPostUpgrade, runTool } = input;
  if (!latestVersion) {
    throw new Error(
      "Unable to determine latest version from GitHub releases. Check https://github.com/itlackey/akm/releases",
    );
  }

  const result = childProcess.spawnSync(packageManagerCommand.command, packageManagerCommand.args, {
    encoding: "utf8",
    env: process.env,
    stdio: "pipe",
  });

  if (result.error) {
    throw new Error(`Failed to run '${packageManagerCommand.displayCommand}': ${result.error.message}`);
  }

  if (result.status !== 0) {
    const details = (result.stderr ?? "").trim() || (result.stdout ?? "").trim() || `exit code ${result.status}`;
    // The install could not change what runs, so the migrator on disk is
    // still the right one: run it, then say so, or an operator reading the
    // EACCES will assume the migration is stuck behind it (#895).
    const migration = await runMigrationStep(runTool);
    throw new Error(
      `Failed to upgrade akm via ${installMethod}: ${details}\nRun manually: ${packageManagerCommand.displayCommand}\n` +
        `Pending migrations ran anyway (status: ${migration.status}).`,
    );
  }

  // The package manager exiting 0 does not prove it delivered
  // `latestVersion`: a lagging `@latest` dist-tag (partial publish,
  // registry mirror lag) "succeeds" while leaving the old version on PATH.
  // Re-read the version the shim actually reports before claiming an
  // upgrade, so stop before claiming success.
  const installedVersion = readInstalledCliVersion("akm");
  if (installedVersion !== undefined && installedVersion !== latestVersion) {
    return {
      currentVersion,
      newVersion: latestVersion,
      upgraded: false,
      installMethod,
      message:
        `\`${packageManagerCommand.displayCommand}\` succeeded, but \`akm --version\` still reports ` +
        `v${installedVersion} (expected v${latestVersion}). The ${installMethod} registry's @latest tag ` +
        `may be lagging the GitHub release — try again shortly, or install the exact version: ` +
        `${packageManagerCommand.displayCommand.replace(/@latest\b/, `@${latestVersion}`)}`,
      migration: await runMigrationStep(runTool),
    };
  }

  return {
    currentVersion,
    newVersion: latestVersion,
    upgraded: true,
    installMethod,
    message:
      installedVersion === latestVersion
        ? `akm upgraded via ${installMethod} (verified: akm --version reports v${installedVersion})`
        : `akm upgraded via ${installMethod} (installed version could not be verified)`,
    migration: await runMigrationStep(runTool),
    postUpgrade: runPostUpgradeTasks("akm", { skip: skipPostUpgrade }),
  };
}

/**
 * Read the version the on-PATH `akm` actually reports, or `undefined` when
 * that cannot be determined (no shim on PATH in a sandbox, unparseable
 * output). Verification is fail-open on its own infrastructure — only a
 * CONFIRMED mismatch downgrades an upgrade result (§24.2 Package/release
 * gate).
 */
function readInstalledCliVersion(akmBin: string): string | undefined {
  const result = childProcess.spawnSync(akmBin, ["--version"], {
    encoding: "utf8",
    env: process.env,
    stdio: "pipe",
  });
  if (result.error || result.status !== 0) return undefined;
  const match = (result.stdout ?? "").match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/);
  return match?.[0];
}

function removeFileBestEffort(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch {
    // Cleanup is best-effort; the primary operation determines success.
  }
}

function parseChecksumForFile(checksumsText: string, filename: string): string | undefined {
  for (const line of checksumsText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Format: <hash>  <filename>
    const match = trimmed.match(/^([0-9a-f]{64})\s+(.+)$/);
    if (match && match[2] === filename) {
      return match[1];
    }
  }
  return undefined;
}

function normalizePathSeparators(value: string | undefined): string {
  return (value ?? "").replaceAll("\\", "/");
}

function getInstalledPackageName(): string {
  try {
    const pkgPath = path.resolve(getDirname(import.meta.url), "../../../package.json");
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as { name?: unknown };
      if (typeof pkg.name === "string" && pkg.name.trim()) {
        return pkg.name.trim();
      }
    }
  } catch {
    // Swallow and fall back to default package name.
  }
  return DEFAULT_PACKAGE_NAME;
}

function resolveNodePackageManagerCommand(name: "npm" | "pnpm"): string {
  const extension = IS_WINDOWS ? ".cmd" : "";
  const adjacent = path.join(path.dirname(process.execPath), `${name}${extension}`);
  return fs.existsSync(adjacent) ? adjacent : name;
}

export function getPackageManagerUpgradeCommand(
  installMethod: InstallMethod,
  packageName = getInstalledPackageName(),
): { command: string; args: string[]; displayCommand: string } | undefined {
  const pkgRef = `${packageName}@latest`;

  if (installMethod === "bun") {
    return {
      command: "bun",
      args: ["install", "-g", pkgRef],
      displayCommand: `bun install -g ${pkgRef}`,
    };
  }

  if (installMethod === "pnpm") {
    return {
      command: resolveNodePackageManagerCommand("pnpm"),
      args: ["add", "-g", pkgRef],
      displayCommand: `pnpm add -g ${pkgRef}`,
    };
  }

  if (installMethod === "npm") {
    return {
      command: resolveNodePackageManagerCommand("npm"),
      args: ["install", "-g", pkgRef],
      displayCommand: `npm install -g ${pkgRef}`,
    };
  }

  return undefined;
}
