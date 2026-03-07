import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { loadSearchIndex, buildSearchText } from "./indexer"
import { TfIdfAdapter, type ScoredEntry } from "./similarity"
import { rgFilterCandidates, ensureRg } from "./ripgrep"
import { parseMarkdownToc, extractSection, extractLineRange, extractFrontmatterOnly, formatToc } from "./markdown"

export type AgentikitAssetType = "tool" | "skill" | "command" | "agent" | "knowledge"
export type AgentikitSearchType = AgentikitAssetType | "any"

export interface SearchHit {
  type: AgentikitAssetType
  name: string
  path: string
  openRef: string
  summary?: string
  description?: string
  tags?: string[]
  score?: number
  runCmd?: string
  kind?: "bash" | "bun" | "powershell" | "cmd"
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
  kind?: "bash" | "bun" | "powershell" | "cmd"
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

interface ToolExecution {
  command: string
  args: string[]
  cwd?: string
}

interface ToolInfo {
  runCmd: string
  kind: "bash" | "bun" | "powershell" | "cmd"
  install?: ToolExecution
  execute: ToolExecution
}

const IS_WINDOWS = process.platform === "win32"
const TOOL_EXTENSIONS = new Set([".sh", ".ts", ".js", ".ps1", ".cmd", ".bat"])
const DEFAULT_LIMIT = 20

export function resolveStashDir(): string {
  const raw = process.env.AGENTIKIT_STASH_DIR?.trim()
  if (!raw) {
    throw new Error("AGENTIKIT_STASH_DIR is not set. Set it to your Agentikit stash path.")
  }
  const stashDir = path.resolve(raw)
  let stat: fs.Stats
  try {
    stat = fs.statSync(stashDir)
  } catch {
    throw new Error(`Unable to read AGENTIKIT_STASH_DIR at "${stashDir}".`)
  }
  if (!stat.isDirectory()) {
    throw new Error(`AGENTIKIT_STASH_DIR must point to a directory: "${stashDir}".`)
  }
  return stashDir
}

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
  const indexer = ASSET_INDEXERS[type]
  const root = path.join(stashDir, indexer.dir)
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

const ASSET_INDEXERS: Record<AgentikitAssetType, { dir: string; collect: (root: string, file: string) => IndexedAsset | undefined }> = {
  tool: {
    dir: "tools",
    collect(root, file) {
      if (!TOOL_EXTENSIONS.has(path.extname(file).toLowerCase())) return undefined
      return { type: "tool", name: toPosix(path.relative(root, file)), path: file }
    },
  },
  skill: {
    dir: "skills",
    collect(root, file) {
      if (path.basename(file) !== "SKILL.md") return undefined
      const relDir = toPosix(path.dirname(path.relative(root, file)))
      if (!relDir || relDir === ".") return undefined
      return { type: "skill", name: relDir, path: file }
    },
  },
  command: {
    dir: "commands",
    collect(root, file) {
      if (path.extname(file).toLowerCase() !== ".md") return undefined
      return { type: "command", name: toPosix(path.relative(root, file)), path: file }
    },
  },
  agent: {
    dir: "agents",
    collect(root, file) {
      if (path.extname(file).toLowerCase() !== ".md") return undefined
      return { type: "agent", name: toPosix(path.relative(root, file)), path: file }
    },
  },
  knowledge: {
    dir: "knowledge",
    collect(root, file) {
      if (path.extname(file).toLowerCase() !== ".md") return undefined
      return { type: "knowledge", name: toPosix(path.relative(root, file)), path: file }
    },
  },
}

function indexAssets(stashDir: string, type: AgentikitSearchType): IndexedAsset[] {
  const assets: IndexedAsset[] = []
  const types = type === "any" ? (Object.keys(ASSET_INDEXERS) as AgentikitAssetType[]) : [type]
  for (const assetType of types) {
    const indexer = ASSET_INDEXERS[assetType]
    const root = path.join(stashDir, indexer.dir)
    walkFiles(root, (file) => {
      const asset = indexer.collect(root, file)
      if (asset) assets.push(asset)
    })
  }
  return assets
}

function walkFiles(root: string, onFile: (file: string) => void): void {
  if (!fs.existsSync(root)) return
  const stack = [root]
  while (stack.length > 0) {
    const current = stack.pop()
    if (!current) continue
    const entries = fs.readdirSync(current, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(fullPath)
      } else if (entry.isFile()) {
        onFile(fullPath)
      }
    }
  }
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
  const root = path.join(stashDir, ASSET_INDEXERS[type].dir)
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
  if (type === "tool" && !TOOL_EXTENSIONS.has(path.extname(resolvedTarget).toLowerCase())) {
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

function buildToolInfo(stashDir: string, filePath: string): ToolInfo {
  const ext = path.extname(filePath).toLowerCase()

  if (ext === ".sh") {
    return {
      runCmd: `bash ${shellQuote(filePath)}`,
      kind: "bash",
      execute: { command: "bash", args: [filePath] },
    }
  }

  if (ext === ".ps1") {
    return {
      runCmd: `powershell -ExecutionPolicy Bypass -File ${shellQuote(filePath)}`,
      kind: "powershell",
      execute: { command: "powershell", args: ["-ExecutionPolicy", "Bypass", "-File", filePath] },
    }
  }

  if (ext === ".cmd" || ext === ".bat") {
    return {
      runCmd: `cmd /c ${shellQuote(filePath)}`,
      kind: "cmd",
      execute: { command: "cmd", args: ["/c", filePath] },
    }
  }

  if (ext !== ".ts" && ext !== ".js") {
    throw new Error(`Unsupported tool extension: ${ext}`)
  }

  const toolsRoot = path.resolve(path.join(stashDir, "tools"))
  const pkgDir = findNearestPackageDir(path.dirname(filePath), toolsRoot)
  if (!pkgDir) {
    return {
      runCmd: `bun ${shellQuote(filePath)}`,
      kind: "bun",
      execute: { command: "bun", args: [filePath] },
    }
  }
  const installFlag = process.env.AGENTIKIT_BUN_INSTALL
  const shouldInstall = installFlag === "1" || installFlag === "true" || installFlag === "yes"

  const quotedPkgDir = shellQuote(pkgDir)
  const quotedFilePath = shellQuote(filePath)
  const cdCmd = IS_WINDOWS ? `cd /d ${quotedPkgDir}` : `cd ${quotedPkgDir}`
  const chain = IS_WINDOWS ? " & " : " && "
  return {
    runCmd: shouldInstall
      ? `${cdCmd}${chain}bun install${chain}bun ${quotedFilePath}`
      : `${cdCmd}${chain}bun ${quotedFilePath}`,
    kind: "bun",
    install: shouldInstall ? { command: "bun", args: ["install"], cwd: pkgDir } : undefined,
    execute: { command: "bun", args: [filePath], cwd: pkgDir },
  }
}

function findNearestPackageDir(startDir: string, toolsRoot: string): string | undefined {
  let current = path.resolve(startDir)
  const root = path.resolve(toolsRoot)
  while (isWithin(current, root)) {
    if (fs.existsSync(path.join(current, "package.json"))) {
      return current
    }
    if (current === root) return undefined
    current = path.dirname(current)
  }
  return undefined
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

function toPosix(input: string): string {
  return input.split(path.sep).join("/")
}

function parseFrontmatter(raw: string): { data: Record<string, unknown>; content: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) {
    return { data: {}, content: raw }
  }

  const data: Record<string, unknown> = {}
  let currentKey: string | null = null
  let nested: Record<string, unknown> | null = null

  for (const line of match[1].split(/\r?\n/)) {
    const indented = line.match(/^  (\w[\w-]*):\s*(.+)$/)
    if (indented && currentKey && nested) {
      nested[indented[1]] = parseYamlScalar(indented[2].trim())
      continue
    }

    const top = line.match(/^(\w[\w-]*):\s*(.*)$/)
    if (!top) {
      continue
    }

    currentKey = top[1]
    const value = top[2].trim()
    if (value === "") {
      nested = {}
      data[currentKey] = nested
    } else {
      nested = null
      data[currentKey] = parseYamlScalar(value)
    }
  }
  return { data, content: match[2] }
}

function parseYamlScalar(value: string): unknown {
  if (value === "") return ""
  if (value === "true") return true
  if (value === "false") return false
  const asNumber = Number(value)
  if (!Number.isNaN(asNumber)) return asNumber
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1)
  }
  return value
}

function isAssetType(type: string): type is AgentikitAssetType {
  return type === "tool" || type === "skill" || type === "command" || type === "agent" || type === "knowledge"
}

function toStringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined
}

function shellQuote(input: string): string {
  if (/[\r\n\t\0]/.test(input)) {
    throw new Error("Unsupported control characters in stash path.")
  }
  if (IS_WINDOWS) {
    return `"${input.replace(/"/g, '""')}"`
  }
  const escaped = input
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\$/g, "\\$")
    .replace(/`/g, "\\`")
  return `"${escaped}"`
}

function runToolExecution(execution: ToolExecution): { output: string; exitCode: number } {
  const result = spawnSync(execution.command, execution.args, {
    cwd: execution.cwd,
    encoding: "utf8",
    timeout: 60_000,
  })

  const stdout = typeof result.stdout === "string" ? result.stdout : ""
  const stderr = typeof result.stderr === "string" ? result.stderr : ""
  const combinedOutput = combineProcessOutput(stdout, stderr)
  if (typeof result.status === "number") {
    return { output: combinedOutput, exitCode: result.status }
  }
  if (result.error) {
    return {
      output: `${combinedOutput}${result.error.message ? `\n${result.error.message}` : ""}`.trim(),
      exitCode: 1,
    }
  }
  return {
    output: combinedOutput || `Unexpected process termination while running "${execution.command}": no status code or error information available.`,
    exitCode: 1,
  }
}

function combineProcessOutput(stdout: string, stderr: string): string {
  if (stdout && stderr) {
    return `stdout:\n${stdout.trim()}\n\nstderr:\n${stderr.trim()}`
  }
  return `${stdout}${stderr}`.trim()
}

export interface InitResponse {
  stashDir: string
  created: boolean
  envSet: boolean
  profileUpdated?: string
  ripgrep?: {
    rgPath: string
    installed: boolean
    version: string
  }
}

export function agentikitInit(): InitResponse {
  let stashDir: string
  const home = process.env.HOME || ""
  if (IS_WINDOWS) {
    const docs = process.env.USERPROFILE
      ? path.join(process.env.USERPROFILE, "Documents")
      : ""
    if (!docs) {
      throw new Error("Unable to determine Documents folder. Ensure USERPROFILE is set.")
    }
    stashDir = path.join(docs, "agentikit")
  } else {
    if (!home) {
      throw new Error("Unable to determine home directory. Set HOME.")
    }
    stashDir = path.join(home, "agentikit")
  }

  let created = false
  if (!fs.existsSync(stashDir)) {
    fs.mkdirSync(stashDir, { recursive: true })
    created = true
  }

  for (const sub of ["tools", "skills", "commands", "agents", "knowledge"]) {
    const subDir = path.join(stashDir, sub)
    if (!fs.existsSync(subDir)) {
      fs.mkdirSync(subDir, { recursive: true })
    }
  }

  let envSet = false
  let profileUpdated: string | undefined

  if (IS_WINDOWS) {
    const result = spawnSync("setx", ["AGENTIKIT_STASH_DIR", stashDir], {
      encoding: "utf8",
      timeout: 10_000,
    })
    envSet = result.status === 0
  } else {
    const shell = process.env.SHELL || ""
    let profile: string
    if (shell.endsWith("/zsh")) {
      profile = path.join(home, ".zshrc")
    } else if (shell.endsWith("/bash")) {
      profile = path.join(home, ".bashrc")
    } else {
      profile = path.join(home, ".profile")
    }

    const exportLine = `export AGENTIKIT_STASH_DIR="${stashDir}"`
    const existing = fs.existsSync(profile) ? fs.readFileSync(profile, "utf8") : ""
    if (!existing.includes("AGENTIKIT_STASH_DIR")) {
      fs.appendFileSync(profile, `\n# Agentikit stash directory\n${exportLine}\n`)
      envSet = true
      profileUpdated = profile
    }
  }

  process.env.AGENTIKIT_STASH_DIR = stashDir

  // Ensure ripgrep is available (install to stash/bin if needed)
  let ripgrep: InitResponse["ripgrep"]
  try {
    const rgResult = ensureRg(stashDir)
    ripgrep = rgResult
  } catch {
    // Non-fatal: ripgrep is optional, search works without it
  }

  return { stashDir, created, envSet, profileUpdated, ripgrep }
}

function hasErrnoCode(error: unknown, code: string): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false
  return (error as Record<string, unknown>).code === code
}
