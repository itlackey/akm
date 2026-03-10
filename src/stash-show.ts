import fs from "node:fs"
import { parseAssetRef } from "./stash-ref"
import { resolveSourcesForOrigin } from "./origin-resolve"
import { resolveAssetPath } from "./stash-resolve"
import type { KnowledgeView, ShowResponse } from "./stash-types"
import { getHandler } from "./asset-type-handler"
import { resolveStashSources, findSourceForPath, isEditable, buildEditHint } from "./stash-source"
import { buildFileContext, runMatchers, getRenderer, buildRenderContext } from "./file-context"
import { loadConfig } from "./config"
import { NotFoundError } from "./errors"

export async function agentikitShow(input: { ref: string; view?: KnowledgeView }): Promise<ShowResponse> {
  const parsed = parseAssetRef(input.ref)
  const config = loadConfig()
  const allSources = resolveStashSources()
  const searchSources = resolveSourcesForOrigin(parsed.origin, allSources)

  const allStashDirs = searchSources.map((s) => s.path)

  let assetPath: string | undefined
  let lastError: Error | undefined
  for (const dir of allStashDirs) {
    try {
      assetPath = resolveAssetPath(dir, parsed.type, parsed.name)
      break
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
    }
  }

  if (!assetPath && parsed.origin && searchSources.length === 0) {
    const installCmd = `akm add ${parsed.origin}`
    throw new NotFoundError(
      `Stash asset not found for ref: ${parsed.type}:${parsed.name}. ` +
      `Kit "${parsed.origin}" is not installed. Run: ${installCmd}`
    )
  }

  if (!assetPath) {
    throw lastError ?? new NotFoundError(`Stash asset not found for ref: ${parsed.type}:${parsed.name}`)
  }

  const source = findSourceForPath(assetPath, allSources)
  const sourceStashDir = source?.path ?? allStashDirs[0]

  // Try new renderer pipeline first
  if (sourceStashDir) {
    const fileCtx = buildFileContext(sourceStashDir, assetPath)
    const match = runMatchers(fileCtx)
    if (match) {
      match.meta = { ...match.meta, name: parsed.name, view: input.view }
      const renderer = getRenderer(match.renderer)
      if (renderer) {
        const renderCtx = buildRenderContext(fileCtx, match, allStashDirs)
        const response = renderer.buildShowResponse(renderCtx)
        const editable = isEditable(assetPath, config)
        return {
          ...response,
          registryId: source?.registryId,
          editable,
          ...(!editable ? { editHint: buildEditHint(assetPath, parsed.type, parsed.name, source?.registryId) } : {}),
        }
      }
    }
  }

  // Fallback to legacy handler
  const content = fs.readFileSync(assetPath, "utf8")
  const handler = getHandler(parsed.type)
  const response = handler.buildShowResponse({
    name: parsed.name,
    path: assetPath,
    content,
    view: input.view,
    stashDirs: allStashDirs,
  })

  const editable = isEditable(assetPath, config)
  return {
    ...response,
    registryId: source?.registryId,
    editable,
    ...(!editable ? { editHint: buildEditHint(assetPath, parsed.type, parsed.name, source?.registryId) } : {}),
  }
}
