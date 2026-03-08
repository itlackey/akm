import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { TYPE_DIRS } from "./common"
import { loadConfig, saveConfig, type AgentikitConfig } from "./config"
import { parseRegistryRef, resolveRegistryArtifact } from "./registry-resolve"
import type { RegistryInstallResult, RegistryInstalledEntry, RegistrySource } from "./registry-types"

const REGISTRY_STASH_DIR_NAMES = new Set<string>(Object.values(TYPE_DIRS))

export interface InstallRegistryRefOptions {
  cacheRootDir?: string
  now?: Date
}

export async function installRegistryRef(ref: string, options?: InstallRegistryRefOptions): Promise<RegistryInstallResult> {
  const parsed = parseRegistryRef(ref)
  const resolved = await resolveRegistryArtifact(parsed)

  const installedAt = (options?.now ?? new Date()).toISOString()
  const cacheRootDir = options?.cacheRootDir ?? getRegistryCacheRootDir()
  const cacheDir = buildInstallCacheDir(cacheRootDir, resolved.source, resolved.id)
  const archivePath = path.join(cacheDir, "artifact.tar.gz")
  const extractedDir = path.join(cacheDir, "extracted")

  fs.mkdirSync(cacheDir, { recursive: true })

  await downloadArchive(resolved.artifactUrl, archivePath)
  extractTarGzSecure(archivePath, extractedDir)

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
