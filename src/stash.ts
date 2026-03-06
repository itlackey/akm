import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

export type AgentikitAssetType = "tool" | "skill" | "command" | "agent"
export type AgentikitSearchType = AgentikitAssetType | "any"

export interface SearchHit {
  type: AgentikitAssetType
  name: string
  path: string
  openRef: string
  summary?: string
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
  const assets = indexAssets(stashDir, searchType)
  const hits = assets
    .filter((asset) => asset.name.toLowerCase().includes(query))
    .sort(compareAssets)
    .slice(0, limit)
    .map((asset): SearchHit => {
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
    })

  return {
    stashDir,
    hits,
    tip: hits.length === 0 ? "No matching stash assets were found." : undefined,
  }
}

export function agentikitOpen(input: { ref: string }): OpenResponse {
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
  }
}

export function agentikitRun(input: { ref: string }): RunResponse {
  const parsed = parseOpenRef(input.ref)
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
  const root = path.join(stashDir, type === "tool" ? "tools" : `${type}s`)
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
  return type === "tool" || type === "skill" || type === "command" || type === "agent"
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

function hasErrnoCode(error: unknown, code: string): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false
  return (error as Record<string, unknown>).code === code
}
