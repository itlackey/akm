import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fetchWithRetry, isWithin } from "./common"
import { TYPE_DIRS } from "./asset-spec"
import { loadConfig, saveConfig, type AgentikitConfig } from "./config"
import { parseRegistryRef, resolveRegistryArtifact } from "./registry-resolve"
import type { ParsedGitRef, ParsedLocalRef, RegistryInstallResult, RegistryInstalledEntry, RegistrySource } from "./registry-types"
import { getRegistryCacheDir as _getRegistryCacheDir } from "./paths"

const REGISTRY_STASH_DIR_NAMES = new Set<string>(Object.values(TYPE_DIRS))

export interface InstallRegistryRefOptions {
  cacheRootDir?: string
  now?: Date
}

export async function installRegistryRef(ref: string, options?: InstallRegistryRefOptions): Promise<RegistryInstallResult> {
  const parsed = parseRegistryRef(ref)
  if (parsed.source === "local") {
    return installLocalRegistryRef(parsed, options)
  }
  if (parsed.source === "git") {
    return installGitRegistryRef(parsed, options)
  }
  const resolved = await resolveRegistryArtifact(parsed)

  const installedAt = (options?.now ?? new Date()).toISOString()
  const cacheRootDir = options?.cacheRootDir ?? getRegistryCacheRootDir()
  const cacheDir = buildInstallCacheDir(cacheRootDir, resolved.source, resolved.id, resolved.resolvedVersion ?? resolved.resolvedRevision)
  const archivePath = path.join(cacheDir, "artifact.tar.gz")
  const extractedDir = path.join(cacheDir, "extracted")

  // Check for cache hit: if extracted dir already exists and has a valid stash root, reuse it
  if (isDirectory(extractedDir)) {
    try {
      const cachedStashRoot = detectStashRoot(extractedDir)
      if (cachedStashRoot) {
        const integrity = fs.existsSync(archivePath) ? await computeFileHash(archivePath) : undefined
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
          stashRoot: cachedStashRoot,
          integrity,
        }
      }
    } catch {
      // Cache invalid, re-download
    }
  }

  fs.mkdirSync(cacheDir, { recursive: true })

  await downloadArchive(resolved.artifactUrl, archivePath)
  verifyArchiveIntegrity(archivePath, resolved.resolvedRevision, resolved.source)
  const integrity = await computeFileHash(archivePath)
  extractTarGzSecure(archivePath, extractedDir)

  const provisionalKitRoot = detectStashRoot(extractedDir)
  const installRoot = applyAgentikitIncludeConfig(provisionalKitRoot, cacheDir, extractedDir) ?? provisionalKitRoot
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
    integrity,
  }
}

async function installLocalRegistryRef(parsed: ParsedLocalRef, options?: InstallRegistryRefOptions): Promise<RegistryInstallResult> {
  const resolved = await resolveRegistryArtifact(parsed)
  const installedAt = (options?.now ?? new Date()).toISOString()
  const cacheRootDir = options?.cacheRootDir ?? getRegistryCacheRootDir()
  const cacheDir = buildInstallCacheDir(cacheRootDir, parsed.source, parsed.id)
  const extractedDir = path.join(cacheDir, "extracted")

  fs.mkdirSync(cacheDir, { recursive: true })
  fs.rmSync(extractedDir, { recursive: true, force: true })
  fs.mkdirSync(extractedDir, { recursive: true })

  const searchRoot = parsed.repoRoot ?? parsed.sourcePath
  const includeConfig = findNearestAgentikitIncludeConfig(parsed.sourcePath, searchRoot)
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

async function installGitRegistryRef(parsed: ParsedGitRef, options?: InstallRegistryRefOptions): Promise<RegistryInstallResult> {
  const resolved = await resolveRegistryArtifact(parsed)
  const installedAt = (options?.now ?? new Date()).toISOString()
  const cacheRootDir = options?.cacheRootDir ?? getRegistryCacheRootDir()
  const cacheDir = buildInstallCacheDir(cacheRootDir, parsed.source, parsed.id, resolved.resolvedRevision)
  const cloneDir = path.join(cacheDir, "clone")
  const extractedDir = path.join(cacheDir, "extracted")

  // Check for cache hit
  if (isDirectory(extractedDir)) {
    try {
      const provisionalKitRoot = detectStashRoot(extractedDir)
      const installRoot = applyAgentikitIncludeConfig(provisionalKitRoot, cacheDir, extractedDir) ?? provisionalKitRoot
      const stashRoot = detectStashRoot(installRoot)
      if (stashRoot) {
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
    } catch {
      // Cache invalid, re-clone
    }
  }

  fs.mkdirSync(cacheDir, { recursive: true })

  const cloneArgs = ["clone", "--depth", "1"]
  if (parsed.requestedRef) {
    cloneArgs.push("--branch", parsed.requestedRef)
  }
  cloneArgs.push(parsed.url, cloneDir)

  const cloneResult = spawnSync("git", cloneArgs, { encoding: "utf8", timeout: 120_000 })
  if (cloneResult.status !== 0) {
    const err = cloneResult.stderr?.trim() || cloneResult.error?.message || "unknown error"
    throw new Error(`Failed to clone ${parsed.url}: ${err}`)
  }

  // Copy contents to extracted dir without .git
  fs.mkdirSync(extractedDir, { recursive: true })
  copyDirectoryContents(cloneDir, extractedDir)

  // Clean up the clone dir
  fs.rmSync(cloneDir, { recursive: true, force: true })

  const provisionalKitRoot = detectStashRoot(extractedDir)
  const installRoot = applyAgentikitIncludeConfig(provisionalKitRoot, cacheDir, extractedDir) ?? provisionalKitRoot
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

export function upsertInstalledRegistryEntry(entry: RegistryInstalledEntry): AgentikitConfig {
  const current = loadConfig()
  const currentInstalled = current.registry?.installed ?? []
  const withoutExisting = currentInstalled.filter((item) => item.id !== entry.id)
  const nextInstalled = [...withoutExisting, normalizeInstalledEntry(entry)]

  const nextConfig: AgentikitConfig = {
    ...current,
    registry: { installed: nextInstalled },
  }
  saveConfig(nextConfig)
  return nextConfig
}

export function removeInstalledRegistryEntry(id: string): AgentikitConfig {
  const current = loadConfig()
  const currentInstalled = current.registry?.installed ?? []
  const nextInstalled = currentInstalled.filter((item) => item.id !== id)

  const nextConfig: AgentikitConfig = {
    ...current,
    registry: nextInstalled.length > 0 ? { installed: nextInstalled } : undefined,
  }
  saveConfig(nextConfig)
  return nextConfig
}

export function getRegistryCacheRootDir(): string {
  return _getRegistryCacheDir()
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

function buildInstallCacheDir(cacheRootDir: string, source: RegistrySource, id: string, version?: string): string {
  const slug = `${source}-${id.replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "")}`
  const versionSlug = source === "local"
    ? `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    : (version?.replace(/[^a-zA-Z0-9_.-]+/g, "-") ?? `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`)
  return path.join(cacheRootDir, slug || source, versionSlug)
}

function applyAgentikitIncludeConfig(
  sourceRoot: string,
  cacheDir: string,
  searchRoot: string = sourceRoot,
): string | undefined {
  const includeConfig = findNearestAgentikitIncludeConfig(sourceRoot, searchRoot)
  if (!includeConfig) return undefined

  const selectedDir = path.join(cacheDir, "selected")
  fs.rmSync(selectedDir, { recursive: true, force: true })
  fs.mkdirSync(selectedDir, { recursive: true })
  copyIncludedPaths(includeConfig.baseDir, includeConfig.include, selectedDir)
  return selectedDir
}

async function downloadArchive(url: string, destination: string): Promise<void> {
  const response = await fetchWithRetry(url, undefined, { timeout: 120_000 })
  if (!response.ok) {
    throw new Error(`Failed to download archive (${response.status}) from ${url}`)
  }
  // Stream response to disk instead of buffering the entire archive in memory.
  // Uses Bun.write which handles Response streaming natively.
  const BunRuntime: { write(path: string, body: Response): Promise<number> } =
    (globalThis as Record<string, unknown>).Bun as typeof BunRuntime
  if (BunRuntime?.write) {
    await BunRuntime.write(destination, response)
  } else {
    // Fallback for non-Bun environments (e.g., tests)
    const arrayBuffer = await response.arrayBuffer()
    fs.writeFileSync(destination, Buffer.from(arrayBuffer))
  }
}

export function verifyArchiveIntegrity(
  archivePath: string,
  expected: string | undefined,
  source?: RegistrySource,
): void {
  if (!expected) return

  // For GitHub and git sources, resolvedRevision is a commit SHA, not a content hash.
  // Content integrity cannot be verified from a commit hash, so skip verification.
  if (source === "github" || source === "git") return

  const fileBuffer = fs.readFileSync(archivePath)

  // SRI hash format: sha256-<base64> or sha512-<base64>
  if (expected.startsWith("sha256-") || expected.startsWith("sha512-")) {
    const dashIndex = expected.indexOf("-")
    const algorithm = expected.slice(0, dashIndex)
    const expectedBase64 = expected.slice(dashIndex + 1)
    const actualBase64 = createHash(algorithm).update(fileBuffer).digest("base64")
    if (actualBase64 !== expectedBase64) {
      fs.unlinkSync(archivePath)
      throw new Error(
        `Integrity check failed for ${archivePath}: expected ${algorithm} digest ${expectedBase64}, got ${actualBase64}`,
      )
    }
    return
  }

  // Hex shasum (SHA-1 from npm)
  if (/^[0-9a-f]{40}$/i.test(expected)) {
    const actualHex = createHash("sha1").update(fileBuffer).digest("hex")
    if (actualHex.toLowerCase() !== expected.toLowerCase()) {
      fs.unlinkSync(archivePath)
      throw new Error(
        `Integrity check failed for ${archivePath}: expected sha1 ${expected}, got ${actualHex}`,
      )
    }
    return
  }

  // Unrecognized format — skip verification
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

function readAgentikitIncludeConfigAtDir(dirPath: string): { baseDir: string; include: string[] } | undefined {
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
    const config = readAgentikitIncludeConfigAtDir(current)
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
      throw new Error(`Path in agentikit.include escapes the package root: ${entry}`)
    }
    if (!fs.existsSync(resolvedSource)) {
      throw new Error(`Path in agentikit.include does not exist: ${entry}`)
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

async function computeFileHash(filePath: string): Promise<string> {
  const data = fs.readFileSync(filePath)
  const hash = createHash("sha256").update(data).digest("hex")
  return `sha256:${hash}`
}

