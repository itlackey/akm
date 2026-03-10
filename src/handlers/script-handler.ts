import path from "node:path"
import { SCRIPT_EXTENSIONS_BROAD } from "../asset-spec"
import { toPosix } from "../common"
import { extractDescriptionFromComments } from "../metadata"
import { getRenderer } from "../file-context"
import { showInputToRenderContext } from "./handler-bridge"
import type { AssetTypeHandler, ShowInput } from "../asset-type-handler"
import type { ShowResponse, LocalSearchHit } from "../stash-types"
import type { StashEntry } from "../metadata"

export const scriptHandler: AssetTypeHandler = {
  typeName: "script",
  stashDir: "scripts",

  isRelevantFile(fileName: string): boolean {
    return SCRIPT_EXTENSIONS_BROAD.has(path.extname(fileName).toLowerCase())
  },

  toCanonicalName(typeRoot: string, filePath: string): string | undefined {
    return toPosix(path.relative(typeRoot, filePath))
  },

  toAssetPath(typeRoot: string, name: string): string {
    return path.join(typeRoot, name)
  },

  buildShowResponse(input: ShowInput): ShowResponse {
    const renderer = getRenderer("script-source")!
    const ctx = showInputToRenderContext(input, "script-source")
    return renderer.buildShowResponse(ctx)
  },

  enrichSearchHit(hit: LocalSearchHit, stashDir: string): void {
    const renderer = getRenderer("script-source")!
    renderer.enrichSearchHit!(hit, stashDir)
  },

  defaultUsageGuide: [
    "Use the hit's runCmd for execution when available, or run the script directly with the appropriate interpreter.",
    "Use `akm show <openRef>` to inspect the script before running it.",
  ],

  extractTypeMetadata(entry: StashEntry, file: string, ext: string): void {
    if (ext !== ".md") {
      const commentDesc = extractDescriptionFromComments(file)
      if (commentDesc && !entry.description) {
        entry.description = commentDesc
        entry.source = "comments"
        entry.confidence = 0.7
      }
    }
  },
}
