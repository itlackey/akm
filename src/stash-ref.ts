import path from "node:path"
import { type AgentikitAssetType, isAssetType } from "./common"

// ── Types ───────────────────────────────────────────────────────────────────

export interface AssetRef {
  type: AgentikitAssetType
  name: string
  /**
   * Where to find this asset.
   *   - undefined: search all sources (working → mounted → installed)
   *   - "local": working stash only
   *   - registry ref: e.g. "npm:@scope/pkg", "owner/repo", "github:owner/repo#v1"
   *   - filesystem path: e.g. "/mnt/shared-stash"
   */
  origin?: string
}

// ── Construction ────────────────────────────────────────────────────────────

/**
 * Build a ref string from components.
 *
 * Examples:
 *   makeAssetRef("tool", "deploy.sh")
 *     → "tool:deploy.sh"
 *   makeAssetRef("tool", "deploy.sh", "npm:@scope/pkg")
 *     → "npm:@scope/pkg//tool:deploy.sh"
 *   makeAssetRef("skill", "code-review", "local")
 *     → "local//skill:code-review"
 *   makeAssetRef("tool", "db/migrate/run.sh", "owner/repo")
 *     → "owner/repo//tool:db/migrate/run.sh"
 */
export function makeAssetRef(
  type: AgentikitAssetType,
  name: string,
  origin?: string,
): string {
  validateName(name)
  const normalized = normalizeName(name)
  const asset = `${type}:${normalized}`
  if (!origin) return asset
  return `${origin}//${asset}`
}

// ── Parsing ─────────────────────────────────────────────────────────────────

/**
 * Parse a ref string in the format `[origin//]type:name`.
 */
export function parseAssetRef(ref: string): AssetRef {
  const trimmed = ref.trim()
  if (!trimmed) throw new Error("Empty ref.")

  let origin: string | undefined
  let body = trimmed

  const boundary = trimmed.indexOf("//")
  if (boundary >= 0) {
    origin = trimmed.slice(0, boundary)
    body = trimmed.slice(boundary + 2)
    if (!origin) throw new Error("Empty origin in ref.")
  }

  const colon = body.indexOf(":")
  if (colon <= 0) {
    throw new Error(`Invalid ref "${trimmed}". Expected [origin//]type:name`)
  }

  const rawType = body.slice(0, colon)
  const rawName = body.slice(colon + 1)

  if (!isAssetType(rawType)) {
    throw new Error(`Invalid asset type: "${rawType}".`)
  }

  validateName(rawName)
  const name = normalizeName(rawName)

  return { type: rawType, name, origin: origin || undefined }
}

// ── Validation ──────────────────────────────────────────────────────────────

function validateName(name: string): void {
  if (!name) throw new Error("Empty asset name.")
  if (name.includes("\0")) throw new Error("Null byte in asset name.")
  if (/^[A-Za-z]:/.test(name)) throw new Error("Windows drive path in asset name.")

  const normalized = path.posix.normalize(name.replace(/\\/g, "/"))
  if (path.posix.isAbsolute(normalized)) throw new Error("Absolute path in asset name.")
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new Error("Path traversal in asset name.")
  }
}

function normalizeName(name: string): string {
  return path.posix.normalize(name.replace(/\\/g, "/"))
}
