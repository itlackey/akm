import path from "node:path"
import { type AgentikitAssetType, isAssetType } from "./common"
import type { StashSourceKind } from "./stash-source"

export interface OpenRef {
  type: AgentikitAssetType
  name: string
  /** Which stash source kind this ref targets */
  sourceKind?: StashSourceKind
  /** For installed sources, the registry id */
  registryId?: string
}

const SOURCE_KIND_SET = new Set<string>(["working", "mounted", "installed"])

function isSourceKind(value: string): value is StashSourceKind {
  return SOURCE_KIND_SET.has(value)
}

/**
 * Parse a ref in the format `@source/type:name` or `@installed:registryId/type:name`.
 *
 * Examples:
 *   `@working/tool:script.sh`
 *   `@mounted/skill:code-review`
 *   `@installed:npm%3A%40scope%2Fpkg/tool:deploy.sh`
 */
export function parseOpenRef(ref: string): OpenRef {
  let sourceKind: StashSourceKind | undefined
  let registryId: string | undefined
  let body = ref

  // Parse @source/ prefix
  if (body.startsWith("@")) {
    const slashIdx = body.indexOf("/")
    if (slashIdx <= 1) {
      throw new Error("Invalid open ref. Expected format 'type:name' or '@source/type:name'.")
    }
    const sourceSegment = body.slice(1, slashIdx)
    body = body.slice(slashIdx + 1)

    // Check for @installed:registryId format
    const colonIdx = sourceSegment.indexOf(":")
    if (colonIdx > 0) {
      const kind = sourceSegment.slice(0, colonIdx)
      if (!isSourceKind(kind)) {
        throw new Error(`Invalid source kind: "${kind}". Expected one of: working, mounted, installed.`)
      }
      sourceKind = kind
      try {
        registryId = decodeURIComponent(sourceSegment.slice(colonIdx + 1))
      } catch {
        throw new Error("Invalid registry id encoding in ref.")
      }
      if (!registryId) {
        throw new Error("Empty registry id in ref.")
      }
    } else {
      if (!isSourceKind(sourceSegment)) {
        throw new Error(`Invalid source kind: "${sourceSegment}". Expected one of: working, mounted, installed.`)
      }
      sourceKind = sourceSegment
    }
  }

  const separator = body.indexOf(":")
  if (separator <= 0) {
    throw new Error("Invalid open ref. Expected format 'type:name' or '@source/type:name'.")
  }
  const rawType = body.slice(0, separator)
  const rawName = body.slice(separator + 1)
  if (!isAssetType(rawType)) {
    throw new Error(`Invalid open ref type: "${rawType}".`)
  }
  let name: string
  try {
    name = decodeURIComponent(rawName)
  } catch {
    throw new Error("Invalid open ref encoding.")
  }
  const normalized = path.posix.normalize(name.replace(/\\/g, "/"))
  if (
    !name
    || name.includes("\0")
    || /^[A-Za-z]:/.test(name)
    || path.posix.isAbsolute(normalized)
    || normalized === ".."
    || normalized.startsWith("../")
  ) {
    throw new Error("Invalid open ref name.")
  }
  return { type: rawType, name: normalized, sourceKind, registryId }
}

/**
 * Create a ref string from components.
 *
 * Examples:
 *   makeOpenRef("tool", "script.sh") → "@working/tool:script.sh" (if sourceKind provided)
 *   makeOpenRef("tool", "deploy.sh", "installed", "npm:@scope/pkg") → "@installed:npm%3A%40scope%2Fpkg/tool:deploy.sh"
 */
export function makeOpenRef(
  type: AgentikitAssetType,
  name: string,
  sourceKind?: StashSourceKind,
  registryId?: string,
): string {
  const body = `${type}:${encodeURIComponent(name)}`
  if (!sourceKind) return body

  if (sourceKind === "installed" && registryId) {
    return `@${sourceKind}:${encodeURIComponent(registryId)}/${body}`
  }
  return `@${sourceKind}/${body}`
}
