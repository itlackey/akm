import * as childProcess from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fetchWithRetry, IS_WINDOWS } from "./common";
import { githubHeaders } from "./github";
import type { UpgradeCheckResponse, UpgradeResponse } from "./stash-types";

const REPO = "itlackey/akm";
const DEFAULT_PACKAGE_NAME = "akm-cli";
const NODE_MODULES_SEGMENT = "/node_modules/";

export type InstallMethod = UpgradeCheckResponse["installMethod"];

/** Signals used by detectInstallMethod; extracted for testability. */
export interface InstallSignals {
  bunMain: string | undefined;
  importMetaDir: string | undefined;
  hasAkmVersion: boolean;
}

/** Read live runtime signals. */
export function getInstallSignals(): InstallSignals {
  return {
    bunMain: typeof Bun !== "undefined" ? Bun.main : undefined,
    importMetaDir: import.meta.dir ?? undefined,
    hasAkmVersion: typeof AKM_VERSION !== "undefined",
  };
}

// AKM_VERSION ambient type is declared in globals.d.ts

export function detectInstallMethod(signals?: InstallSignals): InstallMethod {
  const s = signals ?? getInstallSignals();
  const normalizedImportMetaDir = normalizeInstallPath(s.importMetaDir);

  if (normalizedImportMetaDir.includes(NODE_MODULES_SEGMENT)) {
    if (normalizedImportMetaDir.includes("/.bun/install/global/node_modules/")) {
      return "bun";
    }
    if (
      normalizedImportMetaDir.includes("/pnpm/") ||
      normalizedImportMetaDir.includes("/.pnpm/") ||
      normalizedImportMetaDir.includes("/.pnpm-global/") ||
      normalizedImportMetaDir.includes("/pnpm-global/")
    ) {
      return "pnpm";
    }
    return "npm";
  }

  // Bun-compiled binaries: Bun.main points to a virtual /$bunfs/ path,
  // NOT process.execPath. The old check (Bun.main === process.execPath) was
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

  throw new Error(`Unsupported platform for binary upgrade: ${platform}/${arch}`);
}

export async function checkForUpdate(currentVersion: string): Promise<UpgradeCheckResponse> {
  const installMethod = detectInstallMethod();
  const url = `https://api.github.com/repos/${REPO}/releases/latest`;
  const response = await fetchWithRetry(url, { headers: githubHeaders() });

  if (!response.ok) {
    throw new Error(`Failed to check for updates: ${response.status} ${response.statusText}`);
  }

  const release = (await response.json()) as { tag_name?: string };
  const latestTag = release.tag_name ?? "";
  const latestVersion = latestTag.replace(/^v/, "");

  return {
    currentVersion,
    latestVersion,
    updateAvailable: latestVersion !== "" && Bun.semver.order(currentVersion, latestVersion) < 0,
    installMethod,
  };
}

export async function performUpgrade(
  check: UpgradeCheckResponse,
  opts?: { force?: boolean; skipChecksum?: boolean },
): Promise<UpgradeResponse> {
  const { currentVersion, latestVersion, installMethod } = check;
  const force = opts?.force === true;

  if (!check.updateAvailable && !force) {
    return {
      currentVersion,
      newVersion: latestVersion,
      upgraded: false,
      installMethod,
      message: `akm v${currentVersion} is already the latest version`,
    };
  }

  const packageManagerCommand = getPackageManagerUpgradeCommand(installMethod);
  if (packageManagerCommand) {
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
      throw new Error(
        `Failed to upgrade akm via ${installMethod}: ${details}\nRun manually: ${packageManagerCommand.displayCommand}`,
      );
    }

    return {
      currentVersion,
      newVersion: latestVersion || currentVersion,
      upgraded: true,
      installMethod,
      message: `akm upgraded via ${installMethod}`,
    };
  }

  if (installMethod === "unknown") {
    return {
      currentVersion,
      newVersion: latestVersion,
      upgraded: false,
      installMethod,
      message: `Unable to detect install method. Upgrade manually from https://github.com/${REPO}/releases`,
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

  // Download binary
  const binaryResponse = await fetchWithRetry(binaryUrl);
  if (!binaryResponse.ok) {
    throw new Error(`Failed to download binary: ${binaryResponse.status} ${binaryResponse.statusText}`);
  }
  const binaryData = new Uint8Array(await binaryResponse.arrayBuffer());

  // Download and verify checksum (mandatory — upgrade is blocked if checksums cannot be fetched)
  let checksumVerified = false;
  const skipChecksum = opts?.skipChecksum === true;
  try {
    const checksumsResponse = await fetchWithRetry(checksumsUrl);
    if (!checksumsResponse.ok) {
      if (skipChecksum) {
        console.warn(
          `WARNING: checksums.txt fetch failed (HTTP ${checksumsResponse.status}). Proceeding without verification because --skip-checksum was provided.`,
        );
      } else {
        throw new Error(
          `Checksum verification failed: could not fetch ${checksumsUrl} (HTTP ${checksumsResponse.status}). ` +
            `Use --skip-checksum to bypass (not recommended).`,
        );
      }
    } else {
      const checksumsText = await checksumsResponse.text();
      const expectedHash = parseChecksumForFile(checksumsText, binaryName);
      if (expectedHash) {
        const actualHash = createHash("sha256").update(binaryData).digest("hex");
        if (actualHash !== expectedHash) {
          throw new Error(
            `Checksum mismatch for ${binaryName}.\n` + `Expected: ${expectedHash}\n` + `Got:      ${actualHash}`,
          );
        }
        checksumVerified = true;
      } else {
        if (skipChecksum) {
          console.warn(
            `WARNING: ${binaryName} not found in checksums.txt. Proceeding without verification because --skip-checksum was provided.`,
          );
        } else {
          throw new Error(
            `Checksum verification failed: ${binaryName} not listed in checksums.txt. ` +
              `Use --skip-checksum to bypass (not recommended).`,
          );
        }
      }
    }
  } catch (err) {
    if (
      err instanceof Error &&
      (err.message.includes("Checksum mismatch") || err.message.includes("Checksum verification failed"))
    ) {
      throw err;
    }
    // Network or parse failure
    if (skipChecksum) {
      console.warn(
        `WARNING: Could not fetch or parse checksums: ${err instanceof Error ? err.message : String(err)}. Proceeding because --skip-checksum was provided.`,
      );
    } else {
      throw new Error(
        `Checksum verification failed: ${err instanceof Error ? err.message : String(err)}. ` +
          `Use --skip-checksum to bypass (not recommended).`,
      );
    }
  }

  const execPath = process.execPath;
  const execDir = path.dirname(execPath);
  const execName = path.basename(execPath);

  if (IS_WINDOWS) {
    // Windows: rename running exe, write new one, clean up old on success
    const oldPath = `${execPath}.old`;
    try {
      fs.renameSync(execPath, oldPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES") {
        throw new Error(
          `Permission denied. Cannot rename ${execPath}.\n` +
            `Try running as Administrator, or re-download from https://github.com/${REPO}/releases`,
        );
      }
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to rename ${execPath}: ${detail}`);
    }
    try {
      fs.writeFileSync(execPath, binaryData);
    } catch (err) {
      // Restore from old
      fs.renameSync(oldPath, execPath);
      throw err;
    }
    // Best-effort cleanup of .old
    try {
      fs.unlinkSync(oldPath);
    } catch {
      // Windows may lock the old exe — it will be cleaned up on next startup or manually
    }
  } else {
    // Unix: write to temp file, chmod +x, atomic rename
    const tmpPath = path.join(execDir, `.${execName}.tmp.${process.pid}`);
    const bakPath = `${execPath}.bak`;
    try {
      fs.writeFileSync(tmpPath, binaryData);
      fs.chmodSync(tmpPath, 0o755);
    } catch (err) {
      // Clean up temp file on failure
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        /* ignore */
      }

      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EACCES" || code === "EPERM") {
        throw new Error(
          `Permission denied writing to ${execDir}.\n` +
            `Run: sudo akm upgrade\n` +
            `Or re-run the install script: curl -fsSL https://raw.githubusercontent.com/${REPO}/main/install.sh | bash`,
        );
      }
      throw err;
    }

    // Backup current, then atomic rename
    try {
      fs.copyFileSync(execPath, bakPath);
      fs.renameSync(tmpPath, execPath);
    } catch (err) {
      // Restore from backup if rename failed
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        /* ignore */
      }
      try {
        if (fs.existsSync(bakPath) && !fs.existsSync(execPath)) {
          fs.renameSync(bakPath, execPath);
        }
      } catch {
        /* ignore */
      }
      throw err;
    }

    // Cleanup backup
    try {
      fs.unlinkSync(bakPath);
    } catch {
      /* ignore */
    }
  }

  return {
    currentVersion,
    newVersion: latestVersion,
    upgraded: true,
    installMethod,
    binaryPath: execPath,
    checksumVerified,
  };
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

function normalizeInstallPath(value: string | undefined): string {
  return (value ?? "").replaceAll("\\", "/").toLowerCase();
}

function getInstalledPackageName(): string {
  try {
    const pkgPath = path.resolve(import.meta.dir ?? __dirname, "../package.json");
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
    const command = path.basename(process.execPath).toLowerCase().startsWith("bun") ? process.execPath : "bun";
    return {
      command,
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
