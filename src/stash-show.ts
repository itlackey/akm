import fs from "node:fs"
import { parseFrontmatter, toStringOrUndefined } from "./frontmatter"
import { resolveStashDir } from "./common"
import { parseOpenRef } from "./stash-ref"
import { resolveAssetPath } from "./stash-resolve"
import type { KnowledgeView, ShowResponse } from "./stash-types"
import { parseMarkdownToc, extractSection, extractLineRange, extractFrontmatterOnly, formatToc } from "./markdown"
import { buildToolInfo } from "./tool-runner"

export function agentikitShow(input: { ref: string; view?: KnowledgeView }): ShowResponse {
  const parsed = parseOpenRef(input.ref)
  const stashDir = resolveStashDir()
  const assetPath = resolveAssetPath(stashDir, parsed.type, parsed.name)
  const content = fs.readFileSync(assetPath, "utf8")

  switch (parsed.type) {
    case "skill":
      return {
        type: "skill",
        name: parsed.name,
        path: assetPath,
        content,
      }
    case "command": {
      const parsedMd = parseFrontmatter(content)
      return {
        type: "command",
        name: parsed.name,
        path: assetPath,
        description: toStringOrUndefined(parsedMd.data.description),
        template: parsedMd.content,
      }
    }
    case "agent": {
      const parsedMd = parseFrontmatter(content)
      return {
        type: "agent",
        name: parsed.name,
        path: assetPath,
        description: toStringOrUndefined(parsedMd.data.description),
        prompt: parsedMd.content,
        toolPolicy: parsedMd.data.tools,
        modelHint: parsedMd.data.model,
      }
    }
    case "tool": {
      const toolInfo = buildToolInfo(stashDir, assetPath)
      return {
        type: "tool",
        name: parsed.name,
        path: assetPath,
        runCmd: toolInfo.runCmd,
        kind: toolInfo.kind,
      }
    }
    case "knowledge": {
      const v = input.view ?? { mode: "full" }
      switch (v.mode) {
        case "toc": {
          const toc = parseMarkdownToc(content)
          return { type: "knowledge", name: parsed.name, path: assetPath, content: formatToc(toc) }
        }
        case "frontmatter": {
          const fm = extractFrontmatterOnly(content)
          return { type: "knowledge", name: parsed.name, path: assetPath, content: fm ?? "(no frontmatter)" }
        }
        case "section": {
          const section = extractSection(content, v.heading)
          if (!section) throw new Error(`Section "${v.heading}" not found in ${parsed.name}`)
          return { type: "knowledge", name: parsed.name, path: assetPath, content: section.content }
        }
        case "lines": {
          return { type: "knowledge", name: parsed.name, path: assetPath, content: extractLineRange(content, v.start, v.end) }
        }
        default: {
          return { type: "knowledge", name: parsed.name, path: assetPath, content }
        }
      }
    }
  }
}
