import fs from "node:fs"
import path from "node:path"
import { type AgentikitAssetType, SCRIPT_EXTENSIONS, TYPE_DIRS, isAssetType, resolveStashDir, toPosix, hasErrnoCode } from "./common"
import { parseFrontmatter, toStringOrUndefined } from "./frontmatter"
import { agentikitInit, type InitResponse } from "./init"
import { loadSearchIndex, buildSearchText } from "./indexer"
import { TfIdfAdapter, type ScoredEntry } from "./similarity"
import { rgFilterCandidates } from "./ripgrep"
import { parseMarkdownToc, extractSection, extractLineRange, extractFrontmatterOnly, formatToc } from "./markdown"
import { buildToolInfo, runToolExecution, type ToolKind } from "./tool-runner"
import { walkStash } from "./walker"

export type { AgentikitAssetType } from "./common"
export { resolveStashDir } from "./common"
export { agentikitInit } from "./init"
export type { InitResponse } from "./init"
export type { ToolKind } from "./tool-runner"
export type AgentikitSearchType = AgentikitAssetType | "any"

export interface SearchHit {
  type: AgentikitAssetType
  name: string
  path: string
  openRef: string
  description?: string
  tags?: string[]
  score?: number
  runCmd?: string
  kind?: ToolKind
}

export interface SearchResponse {
  stashDir: string
  hits: SearchHit[]
  tip?: string
}

export interface OpenResponse {
  type: AgentikitAssetType
  name: string
  path: string
  content?: string
  template?: string
  prompt?: string
  description?: string
  toolPolicy?: unknown
  modelHint?: unknown
  runCmd?: string
  kind?: ToolKind
}

export interface RunResponse {
  type: "tool"
  name: string
  path: string
  output: string
  exitCode: number
}

export type KnowledgeView =
  | { mode: "full" }
  | { mode: "toc" }
  | { mode: "frontmatter" }
  | { mode: "section"; heading: string }
  | { mode: "lines"; start: number; end: number }

type IndexedAsset = {
  type: AgentikitAssetType
  name: string
  path: string
}

const DEFAULT_LIMIT = 20

export function agentikitSearch(input: {
  query: string
  type?: AgentikitSearchType
  limit?: number
}): SearchResponse {
  const query = input.query.trim().toLowerCase()
  const searchType = input.type ?? "any"
  const limit = normalizeLimit(input.limit)
  const stashDir = resolveStashDir()

  // Try semantic search via persisted index
  const semanticHits = trySemanticSearch(query, searchType, limit, stashDir)
  if (semanticHits) {
    return {
      stashDir,
      hits: semanticHits,
      tip: semanticHits.length === 0 ? "No matching stash assets were found. Try running 'agentikit index' to rebuild." : undefined,
    }
  }

  // Fallback: substring matching (no index built yet)
  const assets = indexAssets(stashDir, searchType)
  const hits = assets
    .filter((asset) => asset.name.toLowerCase().includes(query))
    .sort(compareAssets)
    .slice(0, limit)
    .map((asset): SearchHit => assetToSearchHit(asset, stashDir))

  return {
    stashDir,
    hits,
    tip: hits.length === 0 ? "No matching stash assets were found." : undefined,
  }
}

function trySemanticSearch(
  query: string,
  searchType: AgentikitSearchType,
  limit: number,
  stashDir: string,
): SearchHit[] | null {
  const index = loadSearchIndex()
  if (!index || !index.entries || index.entries.length === 0) return null
  if (index.stashDir !== stashDir) return null

  // Stage 1: ripgrep candidate filtering
  // Use rg to pre-filter .stash.json files that contain query tokens,
  // then only run TF-IDF ranking on those candidates.
  let candidateEntries = index.entries
  if (query) {
    const rgResult = rgFilterCandidates(query, stashDir, stashDir)
    if (rgResult && rgResult.usedRg) {
      const matchedDirs = new Set(rgResult.matchedFiles.map((f) => path.dirname(f)))
      candidateEntries = index.entries.filter((ie) => matchedDirs.has(ie.dirPath))
      // If rg found nothing but we have a query, still fall through to TF-IDF
      // on all entries — rg is a fast pre-filter, not the final authority
      if (candidateEntries.length === 0) {
        candidateEntries = index.entries
      }
    }
  }

  // Stage 2: TF-IDF semantic ranking
  const scoredEntries: ScoredEntry[] = candidateEntries.map((ie) => ({
    id: `${ie.entry.type}:${ie.entry.name}`,
    text: buildSearchText(ie.entry),
    entry: ie.entry,
    path: ie.path,
  }))

  let adapter: TfIdfAdapter
  if (index.tfidf && !query) {
    // Use cached TF-IDF state for empty queries (listing all)
    const allScored: ScoredEntry[] = index.entries.map((ie) => ({
      id: `${ie.entry.type}:${ie.entry.name}`,
      text: buildSearchText(ie.entry),
      entry: ie.entry,
      path: ie.path,
    }))
    adapter = TfIdfAdapter.deserialize(index.tfidf as any, allScored)
  } else {
    // Rebuild adapter from candidate subset
    adapter = new TfIdfAdapter()
    adapter.buildIndex(scoredEntries)
  }

  const typeFilter = searchType === "any" ? undefined : searchType
  const results = adapter.search(query, limit, typeFilter)

  return results.map((r): SearchHit => {
    // Derive the openRef name from the filesystem path, not the stash entry name,
    // because agentikitOpen resolves assets by their relative path under the type root.
    const openRefName = deriveOpenRefName(r.entry.type, r.path, stashDir)

    const hit: SearchHit = {
      type: r.entry.type,
      name: r.entry.name,
      path: r.path,
      openRef: makeOpenRef(r.entry.type, openRefName),
      description: r.entry.description,
      tags: r.entry.tags,
      score: r.score,
    }

    if (r.entry.type === "tool") {
      try {
        const toolInfo = buildToolInfo(stashDir, r.path)
        hit.runCmd = toolInfo.runCmd
        hit.kind = toolInfo.kind
      } catch {
        // Tool file may have been removed since indexing
      }
    }

    return hit
  })
}

/**
 * Derive the correct openRef name for a semantic search result.
 * Tools use their relative file path (e.g., "deploy/deploy-k8s.sh"),
 * skills use directory name, commands/agents use relative .md path.
 */
function deriveOpenRefName(
  type: AgentikitAssetType,
  filePath: string,
  stashDir: string,
): string {
  const root = path.join(stashDir, TYPE_DIRS[type])
  if (type === "skill") {
    // Skills resolve by directory name relative to skills/
    const rel = toPosix(path.dirname(path.relative(root, filePath)))
    return rel === "." ? path.basename(path.dirname(filePath)) : rel
  }
  return toPosix(path.relative(root, filePath))
}

export function agentikitOpen(input: { ref: string; view?: KnowledgeView }): OpenResponse {
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

export function agentikitRun(input: { ref: string }): RunResponse {
  const parsed = parseOpenRef(input.ref)
  if (parsed.type === "knowledge") {
    throw new Error(
      `Knowledge assets are read-only. Use agentikitOpen with ref "${input.ref}" instead.`
      + ` You can pass a view parameter to retrieve specific sections, line ranges, or the table of contents.`,
    )
  }
  if (parsed.type !== "tool") {
    throw new Error(`agentikitRun only supports tool refs. Got: "${parsed.type}".`)
  }
  const stashDir = resolveStashDir()
  const assetPath = resolveAssetPath(stashDir, "tool", parsed.name)
  const toolInfo = buildToolInfo(stashDir, assetPath)

  if (toolInfo.install) {
    const installResult = runToolExecution(toolInfo.install)
    if (installResult.exitCode !== 0) {
      return {
        type: "tool",
        name: parsed.name,
        path: assetPath,
        output: installResult.output,
        exitCode: installResult.exitCode,
      }
    }
  }

  const runResult = runToolExecution(toolInfo.execute)

  return {
    type: "tool",
    name: parsed.name,
    path: assetPath,
    output: runResult.output,
    exitCode: runResult.exitCode,
  }
}

function assetToSearchHit(asset: IndexedAsset, stashDir: string): SearchHit {
  if (asset.type !== "tool") {
    return {
      type: asset.type,
      name: asset.name,
      path: asset.path,
      openRef: makeOpenRef(asset.type, asset.name),
    }
  }
  const toolInfo = buildToolInfo(stashDir, asset.path)
  return {
    type: "tool",
    name: asset.name,
    path: asset.path,
    openRef: makeOpenRef("tool", asset.name),
    runCmd: toolInfo.runCmd,
    kind: toolInfo.kind,
  }
}

function normalizeLimit(limit?: number): number {
  if (typeof limit !== "number" || Number.isNaN(limit) || limit <= 0) {
    return DEFAULT_LIMIT
  }
  return Math.min(Math.floor(limit), 200)
}

function fileToAsset(assetType: AgentikitAssetType, root: string, file: string): IndexedAsset | undefined {
  switch (assetType) {
    case "tool":
      return { type: "tool", name: toPosix(path.relative(root, file)), path: file }
    case "skill": {
      const relDir = toPosix(path.dirname(path.relative(root, file)))
      if (!relDir || relDir === ".") return undefined
      return { type: "skill", name: relDir, path: file }
    }
    case "command":
    case "agent":
    case "knowledge":
      return { type: assetType, name: toPosix(path.relative(root, file)), path: file }
  }
}

function indexAssets(stashDir: string, type: AgentikitSearchType): IndexedAsset[] {
  const assets: IndexedAsset[] = []
  const types = type === "any" ? (Object.keys(TYPE_DIRS) as AgentikitAssetType[]) : [type]
  for (const assetType of types) {
    const root = path.join(stashDir, TYPE_DIRS[assetType])
    const groups = walkStash(root, assetType)
    for (const { files } of groups) {
      for (const file of files) {
        const asset = fileToAsset(assetType, root, file)
        if (asset) assets.push(asset)
      }
    }
  }
  return assets
}

function compareAssets(a: IndexedAsset, b: IndexedAsset): number {
  if (a.type !== b.type) return a.type.localeCompare(b.type)
  return a.name.localeCompare(b.name)
}

function parseOpenRef(ref: string): { type: AgentikitAssetType; name: string } {
  const separator = ref.indexOf(":")
  if (separator <= 0) {
    throw new Error("Invalid open ref. Expected format '<type>:<name>'.")
  }
  const rawType = ref.slice(0, separator)
  const rawName = ref.slice(separator + 1)
  if (!isAssetType(rawType)) {
    throw new Error(`Invalid open ref type: "${rawType}".`)
  }
  let name: string
  try {
    name = decodeURIComponent(rawName)
  } catch {
    throw new Error("Invalid open ref encoding.")
  }
  const normalized = path.posix.normalize(name.replace(/\\/g, "/"))
  if (
    !name
    || name.includes("\0")
    || /^[A-Za-z]:/.test(name)
    || path.posix.isAbsolute(normalized)
    || normalized === ".."
    || normalized.startsWith("../")
  ) {
    throw new Error("Invalid open ref name.")
  }
  return { type: rawType, name: normalized }
}

function makeOpenRef(type: AgentikitAssetType, name: string): string {
  return `${type}:${encodeURIComponent(name)}`
}

function resolveAssetPath(stashDir: string, type: AgentikitAssetType, name: string): string {
  const root = path.join(stashDir, TYPE_DIRS[type])
  const target = type === "skill" ? path.join(root, name, "SKILL.md") : path.join(root, name)
  const resolvedRoot = resolveAndValidateTypeRoot(root, type, name)
  const resolvedTarget = path.resolve(target)
  if (!isWithin(resolvedTarget, resolvedRoot)) {
    throw new Error("Ref resolves outside the stash root.")
  }
  if (!fs.existsSync(resolvedTarget) || !fs.statSync(resolvedTarget).isFile()) {
    throw new Error(`Stash asset not found for ref: ${type}:${name}`)
  }
  const realTarget = fs.realpathSync(resolvedTarget)
  if (!isWithin(realTarget, resolvedRoot)) {
    throw new Error("Ref resolves outside the stash root.")
  }
  if (type === "tool" && !SCRIPT_EXTENSIONS.has(path.extname(resolvedTarget).toLowerCase())) {
    throw new Error("Tool ref must resolve to a .sh, .ts, .js, .ps1, .cmd, or .bat file.")
  }
  return realTarget
}

function resolveAndValidateTypeRoot(root: string, type: AgentikitAssetType, name: string): string {
  const rootStat = readTypeRootStat(root, type, name)
  if (!rootStat.isDirectory()) {
    throw new Error(`Stash type root is not a directory for ref: ${type}:${name}`)
  }
  return fs.realpathSync(root)
}

function readTypeRootStat(root: string, type: AgentikitAssetType, name: string): fs.Stats {
  try {
    return fs.statSync(root)
  } catch (error: unknown) {
    if (hasErrnoCode(error, "ENOENT")) {
      throw new Error(`Stash type root not found for ref: ${type}:${name}`)
    }
    throw error
  }
}

function isWithin(candidate: string, root: string): boolean {
  const normalizedRoot = normalizeFsPathForComparison(path.resolve(root))
  const normalizedCandidate = normalizeFsPathForComparison(path.resolve(candidate))
  const rel = path.relative(normalizedRoot, normalizedCandidate)
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
}

function normalizeFsPathForComparison(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value
}

