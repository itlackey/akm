import path from "node:path"
import { SCRIPT_EXTENSIONS } from "../asset-spec"
import { toPosix } from "../common"
import { extractDescriptionFromComments } from "../metadata"
import { getRenderer } from "../file-context"
import { showInputToRenderContext } from "./handler-bridge"
import type { AssetTypeHandler, ShowInput } from "../asset-type-handler"
import type { ShowResponse, LocalSearchHit } from "../stash-types"
import type { StashEntry } from "../metadata"

export const toolHandler: AssetTypeHandler = {
  typeName: "tool",
  stashDir: "tools",

  isRelevantFile(fileName: string): boolean {
    return SCRIPT_EXTENSIONS.has(path.extname(fileName).toLowerCase())
  },

  toCanonicalName(typeRoot: string, filePath: string): string | undefined {
    return toPosix(path.relative(typeRoot, filePath))
  },

  toAssetPath(typeRoot: string, name: string): string {
    return path.join(typeRoot, name)
  },

  buildShowResponse(input: ShowInput): ShowResponse {
    const renderer = getRenderer("tool-script")!
    const ctx = showInputToRenderContext(input, "tool-script")
    return renderer.buildShowResponse(ctx)
  },

  enrichSearchHit(hit: LocalSearchHit, stashDir: string): void {
    const renderer = getRenderer("tool-script")!
    renderer.enrichSearchHit!(hit, stashDir)
  },

  defaultUsageGuide: [
    "Use the hit's runCmd for execution so runtime and working directory stay correct.",
    "Use `akm show <openRef>` to inspect the tool before running it.",
  ],

  extractTypeMetadata(entry: StashEntry, file: string, ext: string): void {
    if (SCRIPT_EXTENSIONS.has(ext) && ext !== ".md") {
      const commentDesc = extractDescriptionFromComments(file)
      if (commentDesc && !entry.description) {
        entry.description = commentDesc
        entry.source = "comments"
        entry.confidence = 0.7
      }
    }
  },
}
