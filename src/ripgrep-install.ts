import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { IS_WINDOWS } from "./common";
import { RG_BINARY, resolveRg } from "./ripgrep-resolve";

/**
 * Platform and architecture detection for ripgrep binary downloads.
 */
function getRgPlatformTarget(): { platform: string; arch: string; ext: string } | null {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === "linux" && arch === "x64") {
    return { platform: "x86_64-unknown-linux-musl", arch: "x64", ext: ".tar.gz" };
  }
  if (platform === "linux" && arch === "arm64") {
    return { platform: "aarch64-unknown-linux-gnu", arch: "arm64", ext: ".tar.gz" };
  }
  if (platform === "darwin" && arch === "x64") {
    return { platform: "x86_64-apple-darwin", arch: "x64", ext: ".tar.gz" };
  }
  if (platform === "darwin" && arch === "arm64") {
    return { platform: "aarch64-apple-darwin", arch: "arm64", ext: ".tar.gz" };
  }
  if (platform === "win32" && arch === "x64") {
    return { platform: "x86_64-pc-windows-msvc", arch: "x64", ext: ".zip" };
  }

  return null;
}

const RG_VERSION = "14.1.1";

export interface EnsureRgResult {
  rgPath: string;
  installed: boolean;
  version: string;
}

/**
 * Ensure ripgrep is available. If not found on PATH or in the given binDir,
 * download and install it to binDir.
 *
 * @param binDir - Directory to install ripgrep into (e.g. cache/bin from paths.ts)
 * Returns the path to the ripgrep binary and whether it was newly installed.
 */
export function ensureRg(binDir: string): EnsureRgResult {
  // Already available?
  const existing = resolveRg(binDir);
  if (existing) {
    return { rgPath: existing, installed: false, version: getRgVersion(existing) };
  }

  // Determine platform
  const target = getRgPlatformTarget();
  if (!target) {
    throw new Error(
      `Unsupported platform for ripgrep auto-install: ${process.platform}/${process.arch}. ` +
        `Install ripgrep manually: https://github.com/BurntSushi/ripgrep#installation`,
    );
  }

  if (!fs.existsSync(binDir)) {
    fs.mkdirSync(binDir, { recursive: true });
  }

  const archiveName = `ripgrep-${RG_VERSION}-${target.platform}`;
  const url = `https://github.com/BurntSushi/ripgrep/releases/download/${RG_VERSION}/${archiveName}${target.ext}`;
  const destBinary = path.join(binDir, RG_BINARY);

  if (target.ext === ".tar.gz") {
    downloadAndExtractTarGz(url, archiveName, destBinary);
  } else {
    downloadAndExtractZip(url, archiveName, destBinary);
  }

  // Make executable
  if (!IS_WINDOWS) {
    fs.chmodSync(destBinary, 0o755);
  }

  return { rgPath: destBinary, installed: true, version: RG_VERSION };
}

function downloadAndExtractTarGz(url: string, archiveName: string, destBinary: string): void {
  const destDir = path.dirname(destBinary);
  const tmpTarGz = path.join(destDir, "rg-download.tar.gz");

  try {
    // Download archive to a temporary file without using a shell
    const curlResult = spawnSync("curl", ["-fsSL", "-o", tmpTarGz, url], {
      encoding: "utf8",
      timeout: 60_000,
      env: process.env,
    });

    if (curlResult.status !== 0) {
      const err = curlResult.stderr?.trim() || curlResult.error?.message || "unknown error";
      throw new Error(`Failed to download ripgrep from ${url}: ${err}`);
    }

    // Extract the specific binary from the archive into destDir
    const tarResult = spawnSync("tar", ["xzf", tmpTarGz, "--strip-components=1", "-C", destDir, `${archiveName}/rg`], {
      encoding: "utf8",
      timeout: 60_000,
      env: process.env,
    });

    if (tarResult.status !== 0) {
      const err = tarResult.stderr?.trim() || tarResult.error?.message || "unknown error";
      throw new Error(`Failed to extract ripgrep from ${url}: ${err}`);
    }

    if (!fs.existsSync(destBinary)) {
      throw new Error(`ripgrep binary not found at ${destBinary} after extraction`);
    }
  } finally {
    // Best-effort cleanup of temporary archive
    try {
      if (fs.existsSync(tmpTarGz)) {
        fs.unlinkSync(tmpTarGz);
      }
    } catch {
      // ignore cleanup errors
    }
  }
}

function downloadAndExtractZip(url: string, archiveName: string, destBinary: string): void {
  const destDir = path.dirname(destBinary);
  const tmpZip = path.join(destDir, "rg-download.zip");
  const expandedDir = path.join(destDir, archiveName);
  try {
    // Download
    const dlResult = spawnSync("curl", ["-fsSL", "-o", tmpZip, url], {
      encoding: "utf8",
      timeout: 60_000,
      env: process.env,
    });
    if (dlResult.status !== 0) {
      throw new Error(dlResult.stderr?.trim() || "download failed");
    }

    // Extract the zip archive. Use a single-string -Command with quoted paths to
    // prevent PowerShell from treating subsequent array elements as separate
    // arguments to the interpreter itself (PowerShell -Command arg1 arg2 ... would
    // concatenate them with spaces, causing unexpected evaluation on paths with
    // backticks or semicolons).
    const expandCmd = `Expand-Archive -Path '${tmpZip.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`;
    const expandResult = spawnSync("powershell", ["-NonInteractive", "-NoProfile", "-Command", expandCmd], {
      encoding: "utf8",
      timeout: 60_000,
      env: process.env,
    });
    if (expandResult.status !== 0) {
      throw new Error(expandResult.stderr?.trim() || "extraction failed");
    }

    const srcRgExe = path.join(destDir, archiveName, "rg.exe");
    const moveCmd = `Move-Item -Force -Path '${srcRgExe.replace(/'/g, "''")}' -Destination '${destBinary.replace(/'/g, "''")}'`;
    const moveResult = spawnSync("powershell", ["-NonInteractive", "-NoProfile", "-Command", moveCmd], {
      encoding: "utf8",
      timeout: 60_000,
      env: process.env,
    });
    if (moveResult.status !== 0) {
      throw new Error(moveResult.stderr?.trim() || "move failed");
    }
  } finally {
    if (fs.existsSync(tmpZip)) fs.unlinkSync(tmpZip);
    if (fs.existsSync(expandedDir)) fs.rmSync(expandedDir, { recursive: true, force: true });
  }
}

function getRgVersion(rgPath: string): string {
  const result = spawnSync(rgPath, ["--version"], { encoding: "utf8", timeout: 5_000, env: process.env });
  if (result.status === 0 && result.stdout) {
    const match = result.stdout.match(/ripgrep\s+([\d.]+)/);
    return match ? match[1] : "unknown";
  }
  return "unknown";
}
