/**
 * Built-in asset renderers.
 *
 * Each renderer mirrors the show/search/metadata behavior of its corresponding
 * legacy AssetTypeHandler, re-expressed against the AssetRenderer interface
 * from ./file-context. Renderers are registered at module-load time so that
 * importing this module is sufficient to make them available.
 */

import path from "node:path"
import { registerRenderer } from "./file-context"
import type { AssetRenderer, RenderContext } from "./file-context"
import type { ShowResponse, LocalSearchHit, KnowledgeView } from "./stash-types"
import type { StashEntry } from "./metadata"
import { parseFrontmatter, toStringOrUndefined } from "./frontmatter"
import { SCRIPT_EXTENSIONS } from "./asset-spec"
import { buildToolInfo } from "./tool-runner"
import { hasErrnoCode } from "./common"
import { extractDescriptionFromComments } from "./metadata"
import {
  parseMarkdownToc,
  extractSection,
  extractLineRange,
  extractFrontmatterOnly,
  formatToc,
} from "./markdown"

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Derive a display name from the RenderContext.
 *
 * Prefers `matchResult.meta.name` when present; otherwise falls back to the
 * POSIX-style relative path stripped of its extension.
 */
function deriveName(ctx: RenderContext): string {
  const metaName = ctx.matchResult.meta?.name
  if (typeof metaName === "string" && metaName) return metaName

  // Strip the extension from the relPath for a reasonable fallback.
  const ext = path.extname(ctx.relPath)
  return ext ? ctx.relPath.slice(0, -ext.length) : ctx.relPath
}

/**
 * Find the stashDir that contains `filePath`, falling back to the first
 * entry in the array when no prefix match is found.
 */
function findContainingStashDir(stashDirs: string[], filePath: string): string | undefined {
  return (
    stashDirs.find((d) =>
      path.resolve(filePath).startsWith(path.resolve(d) + path.sep),
    ) ?? stashDirs[0]
  )
}

// ── 1. tool-script ───────────────────────────────────────────────────────────

const toolScriptRenderer: AssetRenderer = {
  name: "tool-script",

  buildShowResponse(ctx: RenderContext): ShowResponse {
    const name = deriveName(ctx)
    const stashDirs = ctx.stashDirs
    const assetStashDir = findContainingStashDir(stashDirs, ctx.absPath)

    if (!assetStashDir) {
      return { type: "tool", name, path: ctx.absPath, content: ctx.content() }
    }

    const toolInfo = buildToolInfo(assetStashDir, ctx.absPath)
    return {
      type: "tool",
      name,
      path: ctx.absPath,
      runCmd: toolInfo.runCmd,
      kind: toolInfo.kind,
    }
  },

  enrichSearchHit(hit: LocalSearchHit, stashDir: string): void {
    try {
      const toolInfo = buildToolInfo(stashDir, hit.path)
      hit.runCmd = toolInfo.runCmd
      hit.kind = toolInfo.kind
    } catch (error: unknown) {
      if (!hasErrnoCode(error, "ENOENT")) throw error
    }
  },

  extractMetadata(entry: StashEntry, ctx: RenderContext): void {
    if (SCRIPT_EXTENSIONS.has(ctx.ext) && ctx.ext !== ".md") {
      const commentDesc = extractDescriptionFromComments(ctx.absPath)
      if (commentDesc && !entry.description) {
        entry.description = commentDesc
        entry.source = "comments"
        entry.confidence = 0.7
      }
    }
  },

  usageGuide: [
    "Use the hit's runCmd for execution so runtime and working directory stay correct.",
    "Use `akm show <openRef>` to inspect the tool before running it.",
  ],
}

// ── 2. skill-md ──────────────────────────────────────────────────────────────

const skillMdRenderer: AssetRenderer = {
  name: "skill-md",

  buildShowResponse(ctx: RenderContext): ShowResponse {
    const name = deriveName(ctx)
    return {
      type: "skill",
      name,
      path: ctx.absPath,
      content: ctx.content(),
    }
  },

  usageGuide: [
    "Read and apply the skill instructions as written, then adapt examples to your current repo state and task.",
    "Use `akm show <openRef>` to read the full SKILL.md for required steps and constraints.",
  ],
}

// ── 3. command-md ────────────────────────────────────────────────────────────

const commandMdRenderer: AssetRenderer = {
  name: "command-md",

  buildShowResponse(ctx: RenderContext): ShowResponse {
    const name = deriveName(ctx)
    const parsedMd = parseFrontmatter(ctx.content())
    return {
      type: "command",
      name,
      path: ctx.absPath,
      description: toStringOrUndefined(parsedMd.data.description),
      template: parsedMd.content,
      modelHint: parsedMd.data.model,
      agent: toStringOrUndefined(parsedMd.data.agent),
    }
  },

  usageGuide: [
    "Read the .md file, fill $ARGUMENTS placeholders, and run it in the current repo context.",
    "Use `akm show <openRef>` to retrieve the command template body.",
    "When `agent` is specified, dispatch the command to that agent.",
  ],
}

// ── 4. agent-md ──────────────────────────────────────────────────────────────

const agentMdRenderer: AssetRenderer = {
  name: "agent-md",

  buildShowResponse(ctx: RenderContext): ShowResponse {
    const name = deriveName(ctx)
    const parsedMd = parseFrontmatter(ctx.content())
    return {
      type: "agent",
      name,
      path: ctx.absPath,
      description: toStringOrUndefined(parsedMd.data.description),
      prompt:
        "Dispatching prompt must include the agent's full prompt content verbatim; summaries are non-compliant. \n\n" +
        parsedMd.content,
      toolPolicy: parsedMd.data.tools,
      modelHint: parsedMd.data.model,
    }
  },

  usageGuide: [
    "Read the .md file and dispatch an agent using the content of the file. Use modelHint/toolPolicy when present to run the agent with compatible settings.",
    "Use with `akm show <openRef>` to get the full prompt payload.",
  ],
}

// ── 5. knowledge-md ──────────────────────────────────────────────────────────

const knowledgeMdRenderer: AssetRenderer = {
  name: "knowledge-md",

  buildShowResponse(ctx: RenderContext): ShowResponse {
    const name = deriveName(ctx)
    const v = (ctx.matchResult.meta?.view as KnowledgeView) ?? { mode: "full" }
    const content = ctx.content()

    switch (v.mode) {
      case "toc": {
        const toc = parseMarkdownToc(content)
        return { type: "knowledge", name, path: ctx.absPath, content: formatToc(toc) }
      }
      case "frontmatter": {
        const fm = extractFrontmatterOnly(content)
        return { type: "knowledge", name, path: ctx.absPath, content: fm ?? "(no frontmatter)" }
      }
      case "section": {
        const section = extractSection(content, v.heading)
        if (!section) {
          return {
            type: "knowledge",
            name,
            path: ctx.absPath,
            content: `Section "${v.heading}" not found in ${name}. Try --view toc to discover available headings.`,
          }
        }
        return { type: "knowledge", name, path: ctx.absPath, content: section.content }
      }
      case "lines": {
        return {
          type: "knowledge",
          name,
          path: ctx.absPath,
          content: extractLineRange(content, v.start, v.end),
        }
      }
      default: {
        return { type: "knowledge", name, path: ctx.absPath, content }
      }
    }
  },

  extractMetadata(entry: StashEntry, ctx: RenderContext): void {
    try {
      const toc = parseMarkdownToc(ctx.content())
      if (toc.headings.length > 0) entry.toc = toc.headings
    } catch {
      // Non-fatal: skip TOC if file can't be read
    }
  },

  usageGuide: [
    "Use `akm show <openRef>` to read the document; start with `--view toc` for large files.",
    "Use `--view section` or `--view lines` to load only the part you need.",
  ],
}

// ── 6. script-source ─────────────────────────────────────────────────────────

/** Extensions that buildToolInfo can handle (tool-runner supported) */
const RUNNABLE_EXTENSIONS = SCRIPT_EXTENSIONS

const scriptSourceRenderer: AssetRenderer = {
  name: "script-source",

  buildShowResponse(ctx: RenderContext): ShowResponse {
    const name = deriveName(ctx)
    const ext = path.extname(ctx.absPath).toLowerCase()

    // For extensions supported by tool-runner, show runCmd
    if (RUNNABLE_EXTENSIONS.has(ext)) {
      const stashDirs = ctx.stashDirs
      const assetStashDir = findContainingStashDir(stashDirs, ctx.absPath)

      if (assetStashDir) {
        try {
          const toolInfo = buildToolInfo(assetStashDir, ctx.absPath)
          return {
            type: "script",
            name,
            path: ctx.absPath,
            runCmd: toolInfo.runCmd,
            kind: toolInfo.kind,
          }
        } catch {
          // Fall through to content display
        }
      }
    }

    // For other extensions or when buildToolInfo fails, show file content
    return {
      type: "script",
      name,
      path: ctx.absPath,
      content: ctx.content(),
    }
  },

  enrichSearchHit(hit: LocalSearchHit, stashDir: string): void {
    const ext = path.extname(hit.path).toLowerCase()
    if (!RUNNABLE_EXTENSIONS.has(ext)) return

    try {
      const toolInfo = buildToolInfo(stashDir, hit.path)
      hit.runCmd = toolInfo.runCmd
      hit.kind = toolInfo.kind
    } catch (error: unknown) {
      if (!hasErrnoCode(error, "ENOENT")) throw error
    }
  },

  extractMetadata(entry: StashEntry, ctx: RenderContext): void {
    if (ctx.ext !== ".md") {
      const commentDesc = extractDescriptionFromComments(ctx.absPath)
      if (commentDesc && !entry.description) {
        entry.description = commentDesc
        entry.source = "comments"
        entry.confidence = 0.7
      }
    }
  },

  usageGuide: [
    "Use the hit's runCmd for execution when available, or run the script directly with the appropriate interpreter.",
    "Use `akm show <openRef>` to inspect the script before running it.",
  ],
}

// ── Registration ─────────────────────────────────────────────────────────────

registerRenderer(toolScriptRenderer)
registerRenderer(skillMdRenderer)
registerRenderer(commandMdRenderer)
registerRenderer(agentMdRenderer)
registerRenderer(knowledgeMdRenderer)
registerRenderer(scriptSourceRenderer)

// ── Named exports for testing ────────────────────────────────────────────────

export {
  toolScriptRenderer,
  skillMdRenderer,
  commandMdRenderer,
  agentMdRenderer,
  knowledgeMdRenderer,
  scriptSourceRenderer,
}
