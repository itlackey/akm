import fs from "node:fs"
import { parseAssetRef } from "./stash-ref"
import { resolveSourcesForOrigin } from "./origin-resolve"
import { resolveAssetPath } from "./stash-resolve"
import type { KnowledgeView, ShowResponse } from "./stash-types"
import { getHandler } from "./asset-type-handler"
import { resolveStashSources, findSourceForPath } from "./stash-source"

export async function agentikitShow(input: { ref: string; view?: KnowledgeView }): Promise<ShowResponse> {
  const parsed = parseAssetRef(input.ref)
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
    throw new Error(
      `Stash asset not found for ref: ${parsed.type}:${parsed.name}. ` +
      `Kit "${parsed.origin}" is not installed. Run: ${installCmd}`
    )
  }

  if (!assetPath) {
    throw lastError ?? new Error(`Stash asset not found for ref: ${parsed.type}:${parsed.name}`)
  }
  const content = fs.readFileSync(assetPath, "utf8")

  const source = findSourceForPath(assetPath, allSources)
  const handler = getHandler(parsed.type)
  const response = handler.buildShowResponse({
    name: parsed.name,
    path: assetPath,
    content,
    view: input.view,
    stashDirs: allStashDirs,
  })

  return {
    ...response,
    registryId: source?.registryId,
    editable: source?.writable ?? false,
  }
}
