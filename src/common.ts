import fs from "node:fs"
import path from "node:path"

// ── Types ───────────────────────────────────────────────────────────────────

export type AgentikitAssetType = "tool" | "skill" | "command" | "agent" | "knowledge"

// ── Constants ───────────────────────────────────────────────────────────────

export const IS_WINDOWS = process.platform === "win32"
export const SCRIPT_EXTENSIONS = new Set([".sh", ".ts", ".js", ".ps1", ".cmd", ".bat"])

export const TYPE_DIRS: Record<AgentikitAssetType, string> = {
  tool: "tools",
  skill: "skills",
  command: "commands",
  agent: "agents",
  knowledge: "knowledge",
}

// ── Validators ──────────────────────────────────────────────────────────────

export function isAssetType(type: string): type is AgentikitAssetType {
  return type === "tool" || type === "skill" || type === "command" || type === "agent" || type === "knowledge"
}

// ── Utilities ───────────────────────────────────────────────────────────────

export function resolveStashDir(): string {
  const raw = process.env.AGENTIKIT_STASH_DIR?.trim()
  if (!raw) {
    throw new Error("AGENTIKIT_STASH_DIR is not set. Set it to your Agentikit stash path.")
  }
  const stashDir = path.resolve(raw)
  let stat: fs.Stats
  try {
    stat = fs.statSync(stashDir)
  } catch {
    throw new Error(`Unable to read AGENTIKIT_STASH_DIR at "${stashDir}".`)
  }
  if (!stat.isDirectory()) {
    throw new Error(`AGENTIKIT_STASH_DIR must point to a directory: "${stashDir}".`)
  }
  return stashDir
}

export function toPosix(input: string): string {
  return input.split(path.sep).join("/")
}

export function hasErrnoCode(error: unknown, code: string): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false
  return (error as Record<string, unknown>).code === code
}
