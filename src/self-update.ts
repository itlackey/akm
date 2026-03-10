import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { IS_WINDOWS, fetchWithRetry } from "./common"
import { githubHeaders } from "./github"
import type { UpgradeCheckResponse, UpgradeResponse } from "./stash-types"

const REPO = "itlackey/agentikit"

export function detectInstallMethod(): "binary" | "npm" | "unknown" {
  // Bun-compiled binaries: Bun.main equals process.execPath
  if (typeof Bun !== "undefined" && Bun.main === process.execPath) {
    return "binary"
  }
  // npm/bun global install: import.meta.dir contains node_modules
  if (import.meta.dir?.includes("node_modules")) {
    return "npm"
  }
  return "unknown"
}

export function getAkmBinaryName(): string {
  const platform = process.platform
  const arch = process.arch

  if (platform === "linux" && arch === "x64") return "akm-linux-x64"
  if (platform === "linux" && arch === "arm64") return "akm-linux-arm64"
  if (platform === "darwin" && arch === "x64") return "akm-darwin-x64"
  if (platform === "darwin" && arch === "arm64") return "akm-darwin-arm64"
  if (platform === "win32" && arch === "x64") return "akm-windows-x64.exe"

  throw new Error(`Unsupported platform for binary upgrade: ${platform}/${arch}`)
}

export async function checkForUpdate(currentVersion: string): Promise<UpgradeCheckResponse> {
  const installMethod = detectInstallMethod()
  const url = `https://api.github.com/repos/${REPO}/releases/latest`
  const response = await fetchWithRetry(url, { headers: githubHeaders() })

  if (!response.ok) {
    throw new Error(`Failed to check for updates: ${response.status} ${response.statusText}`)
  }

  const release = (await response.json()) as { tag_name?: string }
  const latestTag = release.tag_name ?? ""
  const latestVersion = latestTag.replace(/^v/, "")

  return {
    currentVersion,
    latestVersion,
    updateAvailable: latestVersion !== "" && Bun.semver.order(currentVersion, latestVersion) < 0,
    installMethod,
  }
}

export async function performUpgrade(
  check: UpgradeCheckResponse,
  opts?: { force?: boolean },
): Promise<UpgradeResponse> {
  const { currentVersion, latestVersion, installMethod } = check
  const force = opts?.force === true

  if (installMethod === "npm") {
    return {
      currentVersion,
      newVersion: latestVersion,
      upgraded: false,
      installMethod,
      message: `akm installed via npm. Run: bun install -g agentikit@latest`,
    }
  }

  if (installMethod === "unknown") {
    return {
      currentVersion,
      newVersion: latestVersion,
      upgraded: false,
      installMethod,
      message: `Unable to detect install method. Upgrade manually from https://github.com/${REPO}/releases`,
    }
  }

  // Binary install
  if (!check.updateAvailable && !force) {
    return {
      currentVersion,
      newVersion: latestVersion,
      upgraded: false,
      installMethod,
      message: `akm v${currentVersion} is already the latest version`,
    }
  }

  if (!latestVersion) {
    throw new Error("Unable to determine latest version from GitHub releases. Check https://github.com/itlackey/agentikit/releases")
  }

  const tag = `v${latestVersion}`
  const binaryName = getAkmBinaryName()
  const binaryUrl = `https://github.com/${REPO}/releases/download/${tag}/${binaryName}`
  const checksumsUrl = `https://github.com/${REPO}/releases/download/${tag}/checksums.txt`

  // Download binary
  const binaryResponse = await fetchWithRetry(binaryUrl)
  if (!binaryResponse.ok) {
    throw new Error(`Failed to download binary: ${binaryResponse.status} ${binaryResponse.statusText}`)
  }
  const binaryData = new Uint8Array(await binaryResponse.arrayBuffer())

  // Download and verify checksum
  let checksumVerified = false
  try {
    const checksumsResponse = await fetchWithRetry(checksumsUrl)
    if (checksumsResponse.ok) {
      const checksumsText = await checksumsResponse.text()
      const expectedHash = parseChecksumForFile(checksumsText, binaryName)
      if (expectedHash) {
        const actualHash = createHash("sha256").update(binaryData).digest("hex")
        if (actualHash !== expectedHash) {
          throw new Error(
            `Checksum mismatch for ${binaryName}.\n` +
            `Expected: ${expectedHash}\n` +
            `Got:      ${actualHash}`,
          )
        }
        checksumVerified = true
      }
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes("Checksum mismatch")) {
      throw err
    }
    // Non-fatal: checksum file missing or unparseable
  }

  const execPath = process.execPath
  const execDir = path.dirname(execPath)
  const execName = path.basename(execPath)

  if (IS_WINDOWS) {
    // Windows: rename running exe, write new one, clean up old on success
    const oldPath = execPath + ".old"
    try {
      fs.renameSync(execPath, oldPath)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === "EPERM" || code === "EACCES") {
        throw new Error(
          `Permission denied. Cannot rename ${execPath}.\n` +
          `Try running as Administrator, or re-download from https://github.com/${REPO}/releases`,
        )
      }
      const detail = err instanceof Error ? err.message : String(err)
      throw new Error(`Failed to rename ${execPath}: ${detail}`)
    }
    try {
      fs.writeFileSync(execPath, binaryData)
    } catch (err) {
      // Restore from old
      fs.renameSync(oldPath, execPath)
      throw err
    }
    // Best-effort cleanup of .old
    try {
      fs.unlinkSync(oldPath)
    } catch {
      // Windows may lock the old exe — it will be cleaned up on next startup or manually
    }
  } else {
    // Unix: write to temp file, chmod +x, atomic rename
    const tmpPath = path.join(execDir, `.${execName}.tmp.${process.pid}`)
    const bakPath = execPath + ".bak"
    try {
      fs.writeFileSync(tmpPath, binaryData)
      fs.chmodSync(tmpPath, 0o755)
    } catch (err) {
      // Clean up temp file on failure
      try { fs.unlinkSync(tmpPath) } catch { /* ignore */ }

      const code = (err as NodeJS.ErrnoException).code
      if (code === "EACCES" || code === "EPERM") {
        throw new Error(
          `Permission denied writing to ${execDir}.\n` +
          `Run: sudo akm upgrade\n` +
          `Or re-run the install script: curl -fsSL https://raw.githubusercontent.com/${REPO}/main/install.sh | bash`,
        )
      }
      throw err
    }

    // Backup current, then atomic rename
    try {
      fs.copyFileSync(execPath, bakPath)
      fs.renameSync(tmpPath, execPath)
    } catch (err) {
      // Restore from backup if rename failed
      try { fs.unlinkSync(tmpPath) } catch { /* ignore */ }
      try {
        if (fs.existsSync(bakPath) && !fs.existsSync(execPath)) {
          fs.renameSync(bakPath, execPath)
        }
      } catch { /* ignore */ }
      throw err
    }

    // Cleanup backup
    try { fs.unlinkSync(bakPath) } catch { /* ignore */ }
  }

  return {
    currentVersion,
    newVersion: latestVersion,
    upgraded: true,
    installMethod,
    binaryPath: execPath,
    checksumVerified,
  }
}

function parseChecksumForFile(checksumsText: string, filename: string): string | undefined {
  for (const line of checksumsText.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    // Format: <hash>  <filename>
    const match = trimmed.match(/^([0-9a-f]{64})\s+(.+)$/)
    if (match && match[2] === filename) {
      return match[1]
    }
  }
  return undefined
}
