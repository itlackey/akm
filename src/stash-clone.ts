import fs from "node:fs"
import path from "node:path"
import { TYPE_DIRS } from "./asset-spec"
import { parseAssetRef, makeAssetRef } from "./stash-ref"
import { resolveSourcesForOrigin } from "./origin-resolve"
import { resolveAssetPath } from "./stash-resolve"
import { resolveStashSources, findSourceForPath, type StashSource, type StashSourceKind } from "./stash-source"

export interface CloneOptions {
  /** Source ref (e.g., npm:@scope/pkg//tool:deploy.sh) */
  sourceRef: string
  /** Optional new name for the cloned asset */
  newName?: string
  /** If true, overwrite existing asset in working stash */
  force?: boolean
}

export interface CloneResponse {
  source: {
    path: string
    sourceKind: StashSourceKind
    registryId?: string
  }
  destination: {
    path: string
    ref: string
  }
  overwritten: boolean
}

export async function agentikitClone(options: CloneOptions): Promise<CloneResponse> {
  const parsed = parseAssetRef(options.sourceRef)
  const allSources = resolveStashSources()
  const workingSource = allSources.find((s) => s.kind === "working")
  if (!workingSource) {
    throw new Error("No working stash configured. Run `akm init` first.")
  }

  const searchSources = resolveSourcesForOrigin(parsed.origin, allSources)

  let sourcePath: string | undefined
  let lastError: Error | undefined
  for (const source of searchSources) {
    try {
      sourcePath = resolveAssetPath(source.path, parsed.type, parsed.name)
      break
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
    }
  }
  if (!sourcePath) {
    throw lastError ?? new Error(`Source asset not found for ref: ${options.sourceRef}`)
  }

  const sourceSource = findSourceForPath(sourcePath, allSources)
  const sourceKind = sourceSource?.kind ?? "working"

  const destName = options.newName ?? parsed.name
  const typeDir = TYPE_DIRS[parsed.type]
  const workingDir = workingSource.path

  // Guard against self-clone
  if (parsed.type === "skill") {
    const sourceSkillDir = path.resolve(path.dirname(sourcePath))
    const destSkillDir = path.resolve(path.join(workingDir, typeDir, destName))
    if (sourceSkillDir === destSkillDir) {
      throw new Error(
        `Source and destination are the same path. Use --name to provide a new name for the clone.`,
      )
    }
  } else {
    const resolvedSource = path.resolve(sourcePath)
    const resolvedDest = path.resolve(path.join(workingDir, typeDir, destName))
    if (resolvedSource === resolvedDest) {
      throw new Error(
        `Source and destination are the same path. Use --name to provide a new name for the clone.`,
      )
    }
  }

  let destPath: string
  if (parsed.type === "skill") {
    const sourceSkillDir = path.dirname(sourcePath)
    const destSkillDir = path.join(workingDir, typeDir, destName)
    const overwritten = fs.existsSync(destSkillDir)

    if (overwritten && !options.force) {
      throw new Error(
        `Asset already exists in working stash: ${destSkillDir}. Use --force to overwrite.`,
      )
    }

    if (overwritten) {
      fs.rmSync(destSkillDir, { recursive: true, force: true })
    }
    fs.cpSync(sourceSkillDir, destSkillDir, { recursive: true })

    destPath = path.join(destSkillDir, "SKILL.md")
    const ref = makeAssetRef(parsed.type, destName, "local")

    return {
      source: { path: sourcePath, sourceKind, registryId: sourceSource?.registryId },
      destination: { path: destPath, ref },
      overwritten,
    }
  }

  destPath = path.join(workingDir, typeDir, destName)
  const overwritten = fs.existsSync(destPath)

  if (overwritten && !options.force) {
    throw new Error(
      `Asset already exists in working stash: ${destPath}. Use --force to overwrite.`,
    )
  }

  fs.mkdirSync(path.dirname(destPath), { recursive: true })
  fs.copyFileSync(sourcePath, destPath)

  const ref = makeAssetRef(parsed.type, destName, "local")

  return {
    source: { path: sourcePath, sourceKind, registryId: sourceSource?.registryId },
    destination: { path: destPath, ref },
    overwritten,
  }
}
