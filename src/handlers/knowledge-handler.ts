import fs from "node:fs"
import { parseMarkdownToc } from "../markdown"
import { getRenderer } from "../file-context"
import { isMarkdownFile, markdownCanonicalName, markdownAssetPath } from "./markdown-helpers"
import { showInputToRenderContext } from "./handler-bridge"
import type { AssetTypeHandler, ShowInput } from "../asset-type-handler"
import type { ShowResponse } from "../stash-types"
import type { StashEntry } from "../metadata"

export const knowledgeHandler: AssetTypeHandler = {
  typeName: "knowledge",
  stashDir: "knowledge",

  isRelevantFile: isMarkdownFile,
  toCanonicalName: markdownCanonicalName,
  toAssetPath: markdownAssetPath,

  buildShowResponse(input: ShowInput): ShowResponse {
    const renderer = getRenderer("knowledge-md")!
    const ctx = showInputToRenderContext(input, "knowledge-md")
    return renderer.buildShowResponse(ctx)
  },

  defaultUsageGuide: [
    "Use `akm show <openRef>` to read the document; start with `--view toc` for large files.",
    "Use `--view section` or `--view lines` to load only the part you need.",
  ],

  extractTypeMetadata(entry: StashEntry, file: string): void {
    try {
      const mdContent = fs.readFileSync(file, "utf8")
      const toc = parseMarkdownToc(mdContent)
      if (toc.headings.length > 0) entry.toc = toc.headings
    } catch {
      // Non-fatal: skip TOC if file can't be read
    }
  },
}
