export type KitSource = "npm" | "github" | "git" | "local";

export interface RegistryRefBase {
  source: KitSource;
  ref: string;
  id: string;
}

export interface ParsedNpmRef extends RegistryRefBase {
  source: "npm";
  packageName: string;
  requestedVersionOrTag?: string;
}

export interface ParsedGithubRef extends RegistryRefBase {
  source: "github";
  owner: string;
  repo: string;
  requestedRef?: string;
}

export interface ParsedGitRef extends RegistryRefBase {
  source: "git";
  url: string;
  requestedRef?: string;
}

export interface ParsedLocalRef extends RegistryRefBase {
  source: "local";
  repoRoot?: string;
  sourcePath: string;
}

export type ParsedRegistryRef = ParsedNpmRef | ParsedGithubRef | ParsedGitRef | ParsedLocalRef;

export interface ResolvedRegistryArtifact {
  id: string;
  source: KitSource;
  ref: string;
  artifactUrl: string;
  resolvedVersion?: string;
  resolvedRevision?: string;
}

export interface InstalledKitEntry {
  id: string;
  source: KitSource;
  ref: string;
  resolvedVersion?: string;
  resolvedRevision?: string;
  artifactUrl: string;
  stashRoot: string;
  cacheDir: string;
  installedAt: string;
}

export interface KitInstallResult extends InstalledKitEntry {
  extractedDir: string;
  integrity?: string;
}

export interface RegistryAssetEntry {
  type: string;
  name: string;
  description?: string;
  tags?: string[];
}

export interface RegistrySearchHit {
  source: KitSource;
  id: string;
  title: string;
  description?: string;
  ref: string;
  homepage?: string;
  score?: number;
  metadata?: Record<string, string>;
  /** Whether this entry was manually reviewed and approved */
  curated?: boolean;
  /** Name of the registry that provided this hit (provenance tracking) */
  registryName?: string;
}

export interface RegistryAssetSearchHit {
  type: "registry-asset";
  assetType: string;
  assetName: string;
  description?: string;
  kit: { id: string; name: string };
  registryName?: string;
  action: string;
  score?: number;
}

export interface RegistrySearchResponse {
  query: string;
  hits: RegistrySearchHit[];
  warnings: string[];
  assetHits?: RegistryAssetSearchHit[];
}
