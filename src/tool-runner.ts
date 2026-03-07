/**
 * Tool execution utilities.
 *
 * Handles building run commands and executing tool scripts for all supported
 * kinds (bash, bun, powershell, cmd).
 */

import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { IS_WINDOWS } from "./common"

// ── Types ───────────────────────────────────────────────────────────────────

/** The supported tool execution kinds. */
export type ToolKind = "bash" | "bun" | "powershell" | "cmd"

export interface ToolExecution {
  command: string
  args: string[]
  cwd?: string
}

export interface ToolInfo {
  runCmd: string
  kind: ToolKind
  install?: ToolExecution
  execute: ToolExecution
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Build execution metadata for a tool file based on its extension.
 *
 * For `.ts` / `.js` files, looks up the nearest `package.json` so that
 * `bun install` can be run in the correct working directory when the
 * `AGENTIKIT_BUN_INSTALL` env flag is set.
 */
export function buildToolInfo(stashDir: string, filePath: string): ToolInfo {
  const ext = path.extname(filePath).toLowerCase()

  if (ext === ".sh") {
    return {
      runCmd: `bash ${shellQuote(filePath)}`,
      kind: "bash",
      execute: { command: "bash", args: [filePath] },
    }
  }

  if (ext === ".ps1") {
    return {
      runCmd: `powershell -ExecutionPolicy Bypass -File ${shellQuote(filePath)}`,
      kind: "powershell",
      execute: { command: "powershell", args: ["-ExecutionPolicy", "Bypass", "-File", filePath] },
    }
  }

  if (ext === ".cmd" || ext === ".bat") {
    return {
      runCmd: `cmd /c ${shellQuote(filePath)}`,
      kind: "cmd",
      execute: { command: "cmd", args: ["/c", filePath] },
    }
  }

  if (ext !== ".ts" && ext !== ".js") {
    throw new Error(`Unsupported tool extension: ${ext}`)
  }

  const toolsRoot = path.resolve(path.join(stashDir, "tools"))
  const pkgDir = findNearestPackageDir(path.dirname(filePath), toolsRoot)
  if (!pkgDir) {
    return {
      runCmd: `bun ${shellQuote(filePath)}`,
      kind: "bun",
      execute: { command: "bun", args: [filePath] },
    }
  }
  const installFlag = process.env.AGENTIKIT_BUN_INSTALL
  const shouldInstall = installFlag === "1" || installFlag === "true" || installFlag === "yes"

  const quotedPkgDir = shellQuote(pkgDir)
  const quotedFilePath = shellQuote(filePath)
  const cdCmd = IS_WINDOWS ? `cd /d ${quotedPkgDir}` : `cd ${quotedPkgDir}`
  const chain = IS_WINDOWS ? " & " : " && "
  return {
    runCmd: shouldInstall
      ? `${cdCmd}${chain}bun install${chain}bun ${quotedFilePath}`
      : `${cdCmd}${chain}bun ${quotedFilePath}`,
    kind: "bun",
    install: shouldInstall ? { command: "bun", args: ["install"], cwd: pkgDir } : undefined,
    execute: { command: "bun", args: [filePath], cwd: pkgDir },
  }
}

/**
 * Spawn a synchronous child process for a tool execution step.
 */
export function runToolExecution(execution: ToolExecution): { output: string; exitCode: number } {
  const result = spawnSync(execution.command, execution.args, {
    cwd: execution.cwd,
    encoding: "utf8",
    timeout: 60_000,
  })

  const stdout = typeof result.stdout === "string" ? result.stdout : ""
  const stderr = typeof result.stderr === "string" ? result.stderr : ""
  const combinedOutput = combineProcessOutput(stdout, stderr)
  if (typeof result.status === "number") {
    return { output: combinedOutput, exitCode: result.status }
  }
  if (result.error) {
    return {
      output: `${combinedOutput}${result.error.message ? `\n${result.error.message}` : ""}`.trim(),
      exitCode: 1,
    }
  }
  return {
    output: combinedOutput || `Unexpected process termination while running "${execution.command}": no status code or error information available.`,
    exitCode: 1,
  }
}

/**
 * Combine stdout and stderr into a single string.
 */
export function combineProcessOutput(stdout: string, stderr: string): string {
  if (stdout && stderr) {
    return `stdout:\n${stdout.trim()}\n\nstderr:\n${stderr.trim()}`
  }
  return `${stdout}${stderr}`.trim()
}

/**
 * Shell-quote a path for inclusion in a human-readable `runCmd` string.
 */
export function shellQuote(input: string): string {
  if (/[\r\n\t\0]/.test(input)) {
    throw new Error("Unsupported control characters in stash path.")
  }
  if (IS_WINDOWS) {
    return `"${input.replace(/"/g, '""')}"`
  }
  const escaped = input
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\$/g, "\\$")
    .replace(/`/g, "\\`")
  return `"${escaped}"`
}

/**
 * Walk up from `startDir` toward `toolsRoot` looking for the nearest `package.json`.
 */
export function findNearestPackageDir(startDir: string, toolsRoot: string): string | undefined {
  let current = path.resolve(startDir)
  const root = path.resolve(toolsRoot)
  while (isWithin(current, root)) {
    if (fs.existsSync(path.join(current, "package.json"))) {
      return current
    }
    if (current === root) return undefined
    current = path.dirname(current)
  }
  return undefined
}

// ── Internal helpers ────────────────────────────────────────────────────────

function isWithin(candidate: string, root: string): boolean {
  const normalizedRoot = normalizeFsPathForComparison(path.resolve(root))
  const normalizedCandidate = normalizeFsPathForComparison(path.resolve(candidate))
  const rel = path.relative(normalizedRoot, normalizedCandidate)
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
}

function normalizeFsPathForComparison(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value
}
