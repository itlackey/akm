import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { isWithin, TYPE_DIRS } from "./common"
import { loadConfig, saveConfig, type AgentikitConfig } from "./config"
import { parseRegistryRef, resolveRegistryArtifact } from "./registry-resolve"
import type { ParsedGitRef, RegistryInstallResult, RegistryInstalledEntry, RegistrySource } from "./registry-types"

const REGISTRY_STASH_DIR_NAMES = new Set<string>(Object.values(TYPE_DIRS))

export interface InstallRegistryRefOptions {
  cacheRootDir?: string
  now?: Date
}

export async function installRegistryRef(ref: string, options?: InstallRegistryRefOptions): Promise<RegistryInstallResult> {
  const parsed = parseRegistryRef(ref)
  if (parsed.source === "git") {
    return installGitRegistryRef(parsed, options)
  }
  const resolved = await resolveRegistryArtifact(parsed)

  const installedAt = (options?.now ?? new Date()).toISOString()
  const cacheRootDir = options?.cacheRootDir ?? getRegistryCacheRootDir()
  const cacheDir = buildInstallCacheDir(cacheRootDir, resolved.source, resolved.id)
  const archivePath = path.join(cacheDir, "artifact.tar.gz")
  const extractedDir = path.join(cacheDir, "extracted")

  fs.mkdirSync(cacheDir, { recursive: true })

  await downloadArchive(resolved.artifactUrl, archivePath)
  extractTarGzSecure(archivePath, extractedDir)

  const installRoot = applyAgentikitIncludeConfig(extractedDir, cacheDir) ?? extractedDir
  const stashRoot = detectStashRoot(installRoot)

  return {
    id: resolved.id,
    source: resolved.source,
    ref: resolved.ref,
    artifactUrl: resolved.artifactUrl,
    resolvedVersion: resolved.resolvedVersion,
    resolvedRevision: resolved.resolvedRevision,
    installedAt,
    cacheDir,
    extractedDir,
    stashRoot,
  }
}

async function installGitRegistryRef(parsed: ParsedGitRef, options?: InstallRegistryRefOptions): Promise<RegistryInstallResult> {
  const resolved = await resolveRegistryArtifact(parsed)
  const installedAt = (options?.now ?? new Date()).toISOString()
  const cacheRootDir = options?.cacheRootDir ?? getRegistryCacheRootDir()
  const cacheDir = buildInstallCacheDir(cacheRootDir, parsed.source, parsed.id)
  const extractedDir = path.join(cacheDir, "extracted")

  fs.mkdirSync(cacheDir, { recursive: true })
  fs.rmSync(extractedDir, { recursive: true, force: true })
  fs.mkdirSync(extractedDir, { recursive: true })

  const includeConfig = findNearestAgentikitIncludeConfig(parsed.sourcePath, parsed.repoRoot)
  if (includeConfig) {
    copyIncludedPaths(includeConfig.baseDir, includeConfig.include, extractedDir)
  } else {
    copyDirectoryContents(parsed.sourcePath, extractedDir)
  }

  const stashRoot = detectStashRoot(extractedDir)

  return {
    id: resolved.id,
    source: resolved.source,
    ref: resolved.ref,
    artifactUrl: resolved.artifactUrl,
    resolvedVersion: resolved.resolvedVersion,
    resolvedRevision: resolved.resolvedRevision,
    installedAt,
    cacheDir,
    extractedDir,
    stashRoot,
  }
}

export function upsertInstalledRegistryEntry(entry: RegistryInstalledEntry, stashDir?: string): AgentikitConfig {
  const current = loadConfig(stashDir)
  const currentInstalled = current.registry?.installed ?? []
  const previousRegistryRoots = new Set(currentInstalled.map((item) => path.resolve(item.stashRoot)))

  const withoutExisting = currentInstalled.filter((item) => item.id !== entry.id)
  const nextInstalled = [...withoutExisting, normalizeInstalledEntry(entry)]
  const nextRegistryRoots = new Set(nextInstalled.map((item) => path.resolve(item.stashRoot)))
  const preservedAdditional = current.additionalStashDirs.filter(
    (dir) => !previousRegistryRoots.has(path.resolve(dir)),
  )
  const syncedAdditional = uniquePaths([...preservedAdditional, ...nextRegistryRoots])

  const nextConfig: AgentikitConfig = {
    ...current,
    additionalStashDirs: syncedAdditional,
    registry: {
      installed: nextInstalled,
    },
  }
  saveConfig(nextConfig, stashDir)
  return nextConfig
}

export function removeInstalledRegistryEntry(id: string, stashDir?: string): AgentikitConfig {
  const current = loadConfig(stashDir)
  const currentInstalled = current.registry?.installed ?? []
  const previousRegistryRoots = new Set(currentInstalled.map((item) => path.resolve(item.stashRoot)))

  const nextInstalled = currentInstalled.filter((item) => item.id !== id)
  const nextRegistryRoots = new Set(nextInstalled.map((item) => path.resolve(item.stashRoot)))

  const preservedAdditional = current.additionalStashDirs.filter(
    (dir) => !previousRegistryRoots.has(path.resolve(dir)),
  )
  const syncedAdditional = uniquePaths([...preservedAdditional, ...nextRegistryRoots])

  const nextConfig: AgentikitConfig = {
    ...current,
    additionalStashDirs: syncedAdditional,
    registry: nextInstalled.length > 0 ? { installed: nextInstalled } : undefined,
  }
  saveConfig(nextConfig, stashDir)
  return nextConfig
}

export function getRegistryCacheRootDir(): string {
  const xdgCache = process.env.XDG_CACHE_HOME?.trim()
  if (xdgCache) {
    return path.join(path.resolve(xdgCache), "agentikit", "registry")
  }
  const home = process.env.HOME?.trim()
  if (!home) {
    throw new Error("Unable to determine cache directory. Set XDG_CACHE_HOME or HOME.")
  }
  return path.join(path.resolve(home), ".cache", "agentikit", "registry")
}

export function detectStashRoot(extractedDir: string): string {
  const root = path.resolve(extractedDir)

  const rootDotStash = path.join(root, ".stash")
  if (isDirectory(rootDotStash)) {
    return root
  }

  if (hasStashDirs(root)) {
    return root
  }

  const opencodeDir = path.join(root, "opencode")
  if (hasStashDirs(opencodeDir)) {
    return opencodeDir
  }

  const shallowest = findShallowestDotStashRoot(root)
  if (shallowest) return shallowest

  return root
}

function buildInstallCacheDir(cacheRootDir: string, source: RegistrySource, id: string): string {
  const slug = `${source}-${id.replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "")}`
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  return path.join(cacheRootDir, slug || source, stamp)
}

function applyAgentikitIncludeConfig(sourceRoot: string, cacheDir: string): string | undefined {
  const includeConfig = readAgentikitIncludeConfig(sourceRoot)
  if (!includeConfig) return undefined

  const selectedDir = path.join(cacheDir, "selected")
  fs.rmSync(selectedDir, { recursive: true, force: true })
  fs.mkdirSync(selectedDir, { recursive: true })
  copyIncludedPaths(includeConfig.baseDir, includeConfig.include, selectedDir)
  return selectedDir
}

async function downloadArchive(url: string, destination: string): Promise<void> {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Failed to download archive (${response.status}) from ${url}`)
  }
  const arrayBuffer = await response.arrayBuffer()
  fs.writeFileSync(destination, Buffer.from(arrayBuffer))
}

function extractTarGzSecure(archivePath: string, destinationDir: string): void {
  const listResult = spawnSync("tar", ["tzf", archivePath], { encoding: "utf8" })
  if (listResult.status !== 0) {
    const err = listResult.stderr?.trim() || listResult.error?.message || "unknown error"
    throw new Error(`Failed to inspect archive ${archivePath}: ${err}`)
  }

  validateTarEntries(listResult.stdout)

  fs.rmSync(destinationDir, { recursive: true, force: true })
  fs.mkdirSync(destinationDir, { recursive: true })

  const extractResult = spawnSync("tar", ["xzf", archivePath, "--strip-components=1", "-C", destinationDir], {
    encoding: "utf8",
  })
  if (extractResult.status !== 0) {
    const err = extractResult.stderr?.trim() || extractResult.error?.message || "unknown error"
    throw new Error(`Failed to extract archive ${archivePath}: ${err}`)
  }
}

function validateTarEntries(listOutput: string): void {
  const lines = listOutput.split(/\r?\n/).filter(Boolean)
  for (const rawLine of lines) {
    const entry = rawLine.trim()
    if (!entry || entry.includes("\0")) {
      throw new Error(`Archive contains an invalid entry: ${JSON.stringify(rawLine)}`)
    }
    if (entry.startsWith("/")) {
      throw new Error(`Archive contains an absolute path entry: ${entry}`)
    }

    const normalized = path.posix.normalize(entry)
    if (normalized === ".." || normalized.startsWith("../")) {
      throw new Error(`Archive contains a path traversal entry: ${entry}`)
    }

    const parts = normalized.split("/").filter(Boolean)
    const stripped = parts.slice(1).join("/")
    if (!stripped) continue
    const normalizedStripped = path.posix.normalize(stripped)
    if (normalizedStripped === ".." || normalizedStripped.startsWith("../") || path.posix.isAbsolute(normalizedStripped)) {
      throw new Error(`Archive contains an unsafe entry after strip-components: ${entry}`)
    }
  }
}

function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory()
  } catch {
    return false
  }
}

function readAgentikitIncludeConfig(dirPath: string): { baseDir: string; include: string[] } | undefined {
  const packageJsonPath = path.join(dirPath, "package.json")
  if (!fs.existsSync(packageJsonPath)) return undefined

  let pkg: unknown
  try {
    pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"))
  } catch {
    return undefined
  }
  if (typeof pkg !== "object" || pkg === null || Array.isArray(pkg)) return undefined

  const agentikit = (pkg as Record<string, unknown>).agentikit
  if (typeof agentikit !== "object" || agentikit === null || Array.isArray(agentikit)) return undefined

  const include = (agentikit as Record<string, unknown>).include
  if (!Array.isArray(include)) return undefined

  const parsedInclude = include
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean)

  return parsedInclude.length > 0 ? { baseDir: dirPath, include: parsedInclude } : undefined
}

function findNearestAgentikitIncludeConfig(
  startDir: string,
  stopDir: string,
): { baseDir: string; include: string[] } | undefined {
  let current = path.resolve(startDir)
  const boundary = path.resolve(stopDir)

  while (isWithin(current, boundary)) {
    const config = readAgentikitIncludeConfig(current)
    if (config) return config
    if (current === boundary) break
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }

  return undefined
}

function copyIncludedPaths(baseDir: string, include: string[], destinationDir: string): void {
  for (const entry of include) {
    const resolvedSource = path.resolve(baseDir, entry)
    if (!isWithin(resolvedSource, baseDir)) {
      throw new Error(`agentikit.include path must stay within ${baseDir}: ${entry}`)
    }
    if (!fs.existsSync(resolvedSource)) {
      throw new Error(`agentikit.include path not found: ${entry}`)
    }
    if (path.basename(resolvedSource) === ".git") {
      continue
    }
    const relativePath = path.relative(baseDir, resolvedSource)
    if (!relativePath || relativePath === ".") {
      copyDirectoryContents(baseDir, destinationDir)
      continue
    }
    copyPath(resolvedSource, path.join(destinationDir, relativePath))
  }
}

function copyDirectoryContents(sourceDir: string, destinationDir: string): void {
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    if (entry.name === ".git") continue
    copyPath(path.join(sourceDir, entry.name), path.join(destinationDir, entry.name))
  }
}

function copyPath(sourcePath: string, destinationPath: string): void {
  const stat = fs.statSync(sourcePath)
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true })
  if (stat.isDirectory()) {
    fs.cpSync(sourcePath, destinationPath, { recursive: true, force: true })
    return
  }
  fs.copyFileSync(sourcePath, destinationPath)
}

function hasStashDirs(dirPath: string): boolean {
  if (!isDirectory(dirPath)) return false
  const entries = fs.readdirSync(dirPath, { withFileTypes: true })
  return entries.some((entry) => entry.isDirectory() && REGISTRY_STASH_DIR_NAMES.has(entry.name))
}

function findShallowestDotStashRoot(root: string): string | undefined {
  const queue: string[] = [root]
  while (queue.length > 0) {
    const current = queue.shift()!
    const dotStash = path.join(current, ".stash")
    if (isDirectory(dotStash)) {
      return current
    }
    let children: fs.Dirent[]
    try {
      children = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const child of children) {
      if (!child.isDirectory()) continue
      if (child.name === ".git" || child.name === "node_modules") continue
      queue.push(path.join(current, child.name))
    }
  }
  return undefined
}

function normalizeInstalledEntry(entry: RegistryInstalledEntry): RegistryInstalledEntry {
  return {
    ...entry,
    stashRoot: path.resolve(entry.stashRoot),
    cacheDir: path.resolve(entry.cacheDir),
  }
}

function uniquePaths(paths: Iterable<string>): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const candidate of paths) {
    const normalized = path.resolve(candidate)
    if (seen.has(normalized)) continue
    seen.add(normalized)
    result.push(normalized)
  }
  return result
}
