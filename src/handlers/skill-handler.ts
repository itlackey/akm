import path from "node:path"
import { toPosix } from "../common"
import { getRenderer } from "../file-context"
import { showInputToRenderContext } from "./handler-bridge"
import type { AssetTypeHandler, ShowInput } from "../asset-type-handler"
import type { ShowResponse } from "../stash-types"

export const skillHandler: AssetTypeHandler = {
  typeName: "skill",
  stashDir: "skills",

  isRelevantFile(fileName: string): boolean {
    return fileName === "SKILL.md"
  },

  toCanonicalName(typeRoot: string, filePath: string): string | undefined {
    const relDir = toPosix(path.dirname(path.relative(typeRoot, filePath)))
    if (!relDir || relDir === ".") return undefined
    return relDir
  },

  toAssetPath(typeRoot: string, name: string): string {
    return path.join(typeRoot, name, "SKILL.md")
  },

  buildShowResponse(input: ShowInput): ShowResponse {
    const renderer = getRenderer("skill-md")!
    const ctx = showInputToRenderContext(input, "skill-md")
    return renderer.buildShowResponse(ctx)
  },

  defaultUsageGuide: [
    "Read and apply the skill instructions as written, then adapt examples to your current repo state and task.",
    "Use `akm show <openRef>` to read the full SKILL.md for required steps and constraints.",
  ],
}
