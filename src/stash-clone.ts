import fs from "node:fs"
import path from "node:path"
import { TYPE_DIRS } from "./asset-spec"
import { parseOpenRef, makeOpenRef } from "./stash-ref"
import { resolveAssetPath } from "./stash-resolve"
import { resolveStashSources, findSourceForPath, type StashSource, type StashSourceKind } from "./stash-source"

// Ensure handlers are registered
import "./handlers/index"

export interface CloneOptions {
  /** Source ref (e.g., @installed:my-pkg/tool:deploy.sh) */
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

export function agentikitClone(options: CloneOptions): CloneResponse {
  const parsed = parseOpenRef(options.sourceRef)
  const sources = resolveStashSources()
  const workingSource = sources.find((s) => s.kind === "working")
  if (!workingSource) {
    throw new Error("No working stash configured. Run `akm init` first.")
  }

  // Resolve the source asset — search matching sources
  let searchSources = sources
  if (parsed.sourceKind) {
    if (parsed.sourceKind === "installed" && parsed.registryId) {
      searchSources = sources.filter((s) => s.kind === "installed" && s.registryId === parsed.registryId)
    } else {
      searchSources = sources.filter((s) => s.kind === parsed.sourceKind)
    }
  }

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

  const sourceSource = findSourceForPath(sourcePath, sources)
  const sourceKind = sourceSource?.kind ?? "working"

  // Determine destination name and path
  const destName = options.newName ?? parsed.name
  const typeDir = TYPE_DIRS[parsed.type]
  const workingDir = workingSource.path

  let destPath: string
  if (parsed.type === "skill") {
    // Skills are directories — clone the entire skill directory
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
    const ref = makeOpenRef(parsed.type, destName, "working")

    return {
      source: { path: sourcePath, sourceKind, registryId: sourceSource?.registryId },
      destination: { path: destPath, ref },
      overwritten,
    }
  }

  // For non-skill assets, copy the single file
  destPath = path.join(workingDir, typeDir, destName)
  const overwritten = fs.existsSync(destPath)

  if (overwritten && !options.force) {
    throw new Error(
      `Asset already exists in working stash: ${destPath}. Use --force to overwrite.`,
    )
  }

  fs.mkdirSync(path.dirname(destPath), { recursive: true })
  fs.copyFileSync(sourcePath, destPath)

  const ref = makeOpenRef(parsed.type, destName, "working")

  return {
    source: { path: sourcePath, sourceKind, registryId: sourceSource?.registryId },
    destination: { path: destPath, ref },
    overwritten,
  }
}
