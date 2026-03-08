import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import type { ParsedGitRef, ParsedGithubRef, ParsedNpmRef, ParsedRegistryRef, ResolvedRegistryArtifact } from "./registry-types"

const GITHUB_API_BASE = "https://api.github.com"

export function parseRegistryRef(rawRef: string): ParsedRegistryRef {
  const ref = rawRef.trim()
  if (!ref) throw new Error("Registry ref is required.")

  if (ref.startsWith("npm:")) {
    return parseNpmRef(ref.slice(4), ref)
  }
  if (ref.startsWith("github:")) {
    return parseGithubShorthand(ref.slice(7), ref)
  }
  if (ref.startsWith("http://") || ref.startsWith("https://")) {
    return parseGithubUrl(ref)
  }
  const localGitRef = tryParseLocalGitRef(ref, isPathLikeRef(ref))
  if (localGitRef) {
    return localGitRef
  }

  if (ref.startsWith("@") || !looksLikeGithubOwnerRepo(ref)) {
    return parseNpmRef(ref, ref)
  }

  return parseGithubShorthand(ref, ref)
}

export async function resolveRegistryArtifact(parsed: ParsedRegistryRef): Promise<ResolvedRegistryArtifact> {
  if (parsed.source === "npm") {
    return resolveNpmArtifact(parsed)
  }
  if (parsed.source === "git") {
    return resolveGitArtifact(parsed)
  }
  return resolveGithubArtifact(parsed)
}

function parseNpmRef(input: string, originalRef: string): ParsedNpmRef {
  const trimmed = input.trim()
  if (!trimmed) throw new Error("Invalid npm ref.")

  const parsed = splitNpmNameAndVersion(trimmed)
  validateNpmPackageName(parsed.packageName)

  return {
    source: "npm",
    ref: originalRef,
    id: `npm:${parsed.packageName}`,
    packageName: parsed.packageName,
    requestedVersionOrTag: parsed.requestedVersionOrTag,
  }
}

function parseGithubShorthand(input: string, originalRef: string): ParsedGithubRef {
  const [repoPart, requestedRef] = splitRefSuffix(input.trim())
  const segments = repoPart.split("/").filter(Boolean)
  if (segments.length !== 2) {
    throw new Error("Invalid GitHub ref. Expected owner/repo or owner/repo#ref.")
  }
  const owner = segments[0]
  const repo = segments[1].replace(/\.git$/i, "")
  if (!owner || !repo) {
    throw new Error("Invalid GitHub ref. Expected owner/repo.")
  }
  return {
    source: "github",
    ref: originalRef,
    id: `github:${owner}/${repo}`,
    owner,
    repo,
    requestedRef,
  }
}

function parseGithubUrl(rawUrl: string): ParsedGithubRef {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new Error("Invalid registry URL.")
  }
  if (url.hostname !== "github.com") {
    throw new Error("Only GitHub URLs are currently supported for URL refs.")
  }

  const segments = url.pathname.split("/").filter(Boolean)
  if (segments.length < 2) {
    throw new Error("Invalid GitHub URL. Expected https://github.com/owner/repo.")
  }
  const owner = segments[0]
  const repo = segments[1].replace(/\.git$/i, "")
  const requestedRef = url.hash ? decodeURIComponent(url.hash.slice(1)) : undefined

  return {
    source: "github",
    ref: rawUrl,
    id: `github:${owner}/${repo}`,
    owner,
    repo,
    requestedRef,
  }
}

function tryParseLocalGitRef(rawRef: string, explicitPath: boolean): ParsedGitRef | undefined {
  if (!explicitPath) {
    return undefined
  }

  const resolvedPath = path.resolve(rawRef)
  let stat: fs.Stats
  try {
    stat = fs.statSync(resolvedPath)
  } catch {
    throw new Error(`Local add path does not exist: ${resolvedPath}`)
  }

  if (!stat.isDirectory()) {
    throw new Error("Local add path must be a directory, but the provided path is not one.")
  }

  const repoRoot = findGitRepoRoot(resolvedPath)
  if (!repoRoot) {
    throw new Error("Local add path must be inside a git repository.")
  }

  return {
    source: "git",
    ref: rawRef,
    id: `git:${encodeURIComponent(resolvedPath)}`,
    repoRoot,
    sourcePath: resolvedPath,
  }
}

function isPathLikeRef(ref: string): boolean {
  if (path.isAbsolute(ref)) return true
  if (ref.startsWith("./") || ref.startsWith("../") || ref.startsWith(".\\") || ref.startsWith("..\\")) {
    return true
  }
  return ref.includes("/") || ref.includes("\\")
}

async function resolveNpmArtifact(parsed: ParsedNpmRef): Promise<ResolvedRegistryArtifact> {
  const encodedName = encodeURIComponent(parsed.packageName)
  const metadata = await fetchJson<Record<string, unknown>>(`https://registry.npmjs.org/${encodedName}`)

  const versions = asRecord(metadata.versions)
  const distTags = asRecord(metadata["dist-tags"])

  const requested = parsed.requestedVersionOrTag
  let resolvedVersion: string | undefined
  if (!requested) {
    resolvedVersion = asString(distTags.latest)
  } else if (requested in versions) {
    resolvedVersion = requested
  } else {
    resolvedVersion = asString(distTags[requested])
  }

  if (!resolvedVersion || !(resolvedVersion in versions)) {
    throw new Error(`Unable to resolve npm ref \"${parsed.ref}\".`)
  }

  const versionMeta = asRecord(versions[resolvedVersion])
  const dist = asRecord(versionMeta.dist)
  const tarballUrl = asString(dist.tarball)
  if (!tarballUrl) {
    throw new Error(`npm package ${parsed.packageName}@${resolvedVersion} does not expose a tarball URL.`)
  }

  const resolvedRevision = asString(dist.shasum) ?? asString(dist.integrity)

  return {
    id: parsed.id,
    source: parsed.source,
    ref: parsed.ref,
    artifactUrl: tarballUrl,
    resolvedVersion,
    resolvedRevision,
  }
}

async function resolveGithubArtifact(parsed: ParsedGithubRef): Promise<ResolvedRegistryArtifact> {
  const headers = githubHeaders()

  if (parsed.requestedRef) {
    const commit = await tryFetchJson<Record<string, unknown>>(
      `${GITHUB_API_BASE}/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/commits/${encodeURIComponent(parsed.requestedRef)}`,
      headers,
    )
    const resolvedRevision = asString(commit?.sha) ?? parsed.requestedRef
    return {
      id: parsed.id,
      source: parsed.source,
      ref: parsed.ref,
      artifactUrl: `${GITHUB_API_BASE}/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/tarball/${encodeURIComponent(parsed.requestedRef)}`,
      resolvedRevision,
      resolvedVersion: parsed.requestedRef,
    }
  }

  const latestRelease = await tryFetchJson<Record<string, unknown>>(
    `${GITHUB_API_BASE}/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/releases/latest`,
    headers,
  )
  if (latestRelease) {
    const tarballUrl = asString(latestRelease.tarball_url)
    if (tarballUrl) {
      return {
        id: parsed.id,
        source: parsed.source,
        ref: parsed.ref,
        artifactUrl: tarballUrl,
        resolvedVersion: asString(latestRelease.tag_name),
        resolvedRevision: asString(latestRelease.target_commitish),
      }
    }
  }

  const repoMeta = await fetchJson<Record<string, unknown>>(
    `${GITHUB_API_BASE}/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}`,
    headers,
  )
  const defaultBranch = asString(repoMeta.default_branch)
  if (!defaultBranch) {
    throw new Error(`Unable to resolve default branch for ${parsed.owner}/${parsed.repo}.`)
  }

  const commit = await tryFetchJson<Record<string, unknown>>(
    `${GITHUB_API_BASE}/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/commits/${encodeURIComponent(defaultBranch)}`,
    headers,
  )

  return {
    id: parsed.id,
    source: parsed.source,
    ref: parsed.ref,
    artifactUrl: `${GITHUB_API_BASE}/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/tarball/${encodeURIComponent(defaultBranch)}`,
    resolvedVersion: defaultBranch,
    resolvedRevision: asString(commit?.sha) ?? defaultBranch,
  }
}

async function resolveGitArtifact(parsed: ParsedGitRef): Promise<ResolvedRegistryArtifact> {
  return {
    id: parsed.id,
    source: parsed.source,
    ref: parsed.ref,
    artifactUrl: pathToFileURL(parsed.sourcePath).toString(),
    resolvedRevision: readGitValue(parsed.repoRoot, "rev-parse", "HEAD"),
    resolvedVersion: readGitValue(parsed.repoRoot, "rev-parse", "--abbrev-ref", "HEAD"),
  }
}

function splitNpmNameAndVersion(input: string): { packageName: string; requestedVersionOrTag?: string } {
  if (input.startsWith("@")) {
    const secondAt = input.indexOf("@", 1)
    if (secondAt > 0) {
      return {
        packageName: input.slice(0, secondAt),
        requestedVersionOrTag: input.slice(secondAt + 1) || undefined,
      }
    }
    return { packageName: input }
  }

  const at = input.lastIndexOf("@")
  if (at > 0) {
    return {
      packageName: input.slice(0, at),
      requestedVersionOrTag: input.slice(at + 1) || undefined,
    }
  }
  return { packageName: input }
}

function validateNpmPackageName(name: string): void {
  if (!name || name.includes(" ")) {
    throw new Error(`Invalid npm package name: \"${name}\".`)
  }
}

function looksLikeGithubOwnerRepo(ref: string): boolean {
  const [repoPart] = splitRefSuffix(ref)
  const parts = repoPart.split("/").filter(Boolean)
  return parts.length === 2
}

function splitRefSuffix(value: string): [string, string | undefined] {
  const hash = value.indexOf("#")
  if (hash < 0) return [value, undefined]
  return [value.slice(0, hash), value.slice(hash + 1) || undefined]
}

function githubHeaders(): HeadersInit {
  const token = process.env.GITHUB_TOKEN?.trim()
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "agentikit-registry",
  }
  if (token) headers.Authorization = `Bearer ${token}`
  return headers
}

function findGitRepoRoot(startDir: string): string | undefined {
  let current = path.resolve(startDir)
  while (true) {
    if (fs.existsSync(path.join(current, ".git"))) {
      return current
    }
    const parent = path.dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

function readGitValue(repoRoot: string, ...args: string[]): string | undefined {
  const result = spawnSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" })
  if (result.status !== 0) return undefined
  const value = result.stdout.trim()
  return value || undefined
}

async function fetchJson<T>(url: string, headers?: HeadersInit): Promise<T> {
  const response = await fetch(url, { headers })
  if (!response.ok) {
    throw new Error(`Request failed (${response.status}) for ${url}`)
  }
  return await response.json() as T
}

async function tryFetchJson<T>(url: string, headers?: HeadersInit): Promise<T | null> {
  const response = await fetch(url, { headers })
  if (!response.ok) return null
  return await response.json() as T
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined
}
