/**
 * Bridge utility that converts legacy ShowInput into a RenderContext,
 * allowing handlers to delegate their buildShowResponse to renderers.
 */

import path from "node:path"
import { toPosix } from "../common"
import type { ShowInput } from "../asset-type-handler"
import type { RenderContext, MatchResult } from "../file-context"
import fs from "node:fs"

/**
 * Convert a legacy ShowInput into a RenderContext suitable for passing
 * to an AssetRenderer's buildShowResponse method.
 *
 * This avoids hitting the filesystem since ShowInput already carries
 * the file content.
 */
export function showInputToRenderContext(input: ShowInput, rendererName: string): RenderContext {
  const absPath = path.resolve(input.path)
  const stashDirs = input.stashDirs ?? []
  // Derive a stash root from stashDirs if possible
  const stashRoot = stashDirs.find((d) =>
    absPath.startsWith(path.resolve(d) + path.sep),
  ) ?? stashDirs[0] ?? path.dirname(absPath)

  const relPath = toPosix(path.relative(stashRoot, absPath))
  const ext = path.extname(absPath).toLowerCase()
  const fileName = path.basename(absPath)
  const parentDirAbs = path.dirname(absPath)
  const parentDir = path.basename(parentDirAbs)

  const relDir = toPosix(path.dirname(relPath))
  const ancestorDirs: string[] =
    relDir === "." ? [] : relDir.split("/").filter((seg) => seg.length > 0)

  // Cache the content from input (no filesystem read needed)
  const cachedContent = input.content

  const matchResult: MatchResult = {
    type: rendererName.split("-")[0], // e.g. "tool" from "tool-script"
    specificity: 10,
    renderer: rendererName,
    meta: { name: input.name, view: input.view },
  }

  return {
    absPath,
    relPath,
    ext,
    fileName,
    parentDir,
    parentDirAbs,
    ancestorDirs,
    stashRoot,
    content: () => cachedContent,
    frontmatter: () => null, // Renderers parse frontmatter from content() themselves
    stat(): fs.Stats { throw new Error("stat() not available in handler bridge context") },
    matchResult,
    stashDirs,
  }
}
