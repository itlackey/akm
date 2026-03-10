import fs from "node:fs"
import path from "node:path"
import { type AgentikitAssetType, hasErrnoCode, isWithin } from "./common"
import { TYPE_DIRS, isRelevantAssetFile, resolveAssetPathFromName } from "./asset-spec"
import { NotFoundError, UsageError } from "./errors"

export function resolveAssetPath(stashDir: string, type: AgentikitAssetType, name: string): string {
  const root = path.join(stashDir, TYPE_DIRS[type])
  const target = resolveAssetPathFromName(type, root, name)
  const resolvedRoot = resolveAndValidateTypeRoot(root, type, name)
  const resolvedTarget = path.resolve(target)
  if (!isWithin(resolvedTarget, resolvedRoot)) {
    throw new UsageError("Ref resolves outside the stash root.")
  }
  if (!fs.existsSync(resolvedTarget) || !fs.statSync(resolvedTarget).isFile()) {
    throw new NotFoundError(`Stash asset not found for ref: ${type}:${name}`)
  }
  const realTarget = fs.realpathSync(resolvedTarget)
  if (!isWithin(realTarget, resolvedRoot)) {
    throw new UsageError("Ref resolves outside the stash root.")
  }
  if (!isRelevantAssetFile(type, path.basename(resolvedTarget))) {
    if (type === "tool") {
      throw new NotFoundError("Tool ref must resolve to a .sh, .ts, .js, .ps1, .cmd, or .bat file.")
    }
    if (type === "script") {
      throw new NotFoundError("Script ref must resolve to a file with a supported script extension. Refer to the Agentikit documentation for the complete list of supported script extensions.");
    }
    throw new NotFoundError(`Stash asset not found for ref: ${type}:${name}`)
  }
  return realTarget
}

function resolveAndValidateTypeRoot(root: string, type: AgentikitAssetType, name: string): string {
  const rootStat = readTypeRootStat(root, type, name)
  if (!rootStat.isDirectory()) {
    throw new NotFoundError(`Stash type root is not a directory for ref: ${type}:${name}`)
  }
  return fs.realpathSync(root)
}

function readTypeRootStat(root: string, type: AgentikitAssetType, name: string): fs.Stats {
  try {
    return fs.statSync(root)
  } catch (error: unknown) {
    if (hasErrnoCode(error, "ENOENT")) {
      throw new NotFoundError(`Stash type root not found for ref: ${type}:${name}`)
    }
    throw error
  }
}
