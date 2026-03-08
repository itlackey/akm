import fs from "node:fs"
import path from "node:path"
import { parseFrontmatter, toStringOrUndefined } from "./frontmatter"
import { resolveStashDir } from "./common"
import { parseOpenRef } from "./stash-ref"
import { resolveAssetPath } from "./stash-resolve"
import type { KnowledgeView, ShowResponse } from "./stash-types"
import { parseMarkdownToc, extractSection, extractLineRange, extractFrontmatterOnly, formatToc } from "./markdown"
import { buildToolInfo } from "./tool-runner"
import { loadConfig } from "./config"

export function agentikitShow(input: { ref: string; view?: KnowledgeView }): ShowResponse {
  const parsed = parseOpenRef(input.ref)
  const stashDir = resolveStashDir()
  const config = loadConfig(stashDir)
  const allStashDirs = [
    stashDir,
    ...config.additionalStashDirs.filter((d) => {
      try { return fs.statSync(d).isDirectory() } catch { return false }
    }),
  ]

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
  if (!assetPath) {
    throw lastError ?? new Error(`Stash asset not found for ref: ${parsed.type}:${parsed.name}`)
  }
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
        prompt: "Dispatching prompt must include the agent's full prompt content verbatim; summaries are non-compliant. \n\n" 
        + parsedMd.content,
        toolPolicy: parsedMd.data.tools,
        modelHint: parsedMd.data.model,
      }
    }
    case "tool": {
      const assetStashDir = allStashDirs.find((d) => path.resolve(assetPath!).startsWith(path.resolve(d) + path.sep)) ?? stashDir
      const toolInfo = buildToolInfo(assetStashDir, assetPath)
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
          if (!section) {
            return {
              type: "knowledge",
              name: parsed.name,
              path: assetPath,
              content: `Section "${v.heading}" not found in ${parsed.name}. Try --view toc to discover available headings.`,
            }
          }
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
