export type RegistrySource = "npm" | "github" | "git"

export interface RegistryRefBase {
  source: RegistrySource
  ref: string
  id: string
}

export interface ParsedNpmRef extends RegistryRefBase {
  source: "npm"
  packageName: string
  requestedVersionOrTag?: string
}

export interface ParsedGithubRef extends RegistryRefBase {
  source: "github"
  owner: string
  repo: string
  requestedRef?: string
}

export interface ParsedGitRef extends RegistryRefBase {
  source: "git"
  repoRoot: string
  sourcePath: string
}

export type ParsedRegistryRef = ParsedNpmRef | ParsedGithubRef | ParsedGitRef

export interface ResolvedRegistryArtifact {
  id: string
  source: RegistrySource
  ref: string
  artifactUrl: string
  resolvedVersion?: string
  resolvedRevision?: string
}

export interface RegistryInstalledEntry {
  id: string
  source: RegistrySource
  ref: string
  resolvedVersion?: string
  resolvedRevision?: string
  artifactUrl: string
  stashRoot: string
  cacheDir: string
  installedAt: string
}

export interface RegistryInstallResult extends RegistryInstalledEntry {
  extractedDir: string
}

export interface RegistrySearchHit {
  source: RegistrySource
  id: string
  title: string
  description?: string
  ref: string
  homepage?: string
  score?: number
  metadata?: Record<string, string>
}

export interface RegistrySearchResponse {
  query: string
  hits: RegistrySearchHit[]
  warnings: string[]
}
