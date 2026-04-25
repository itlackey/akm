import type { InstallAuditReport } from "../commands/install-audit";
import type { SourceSpec } from "../core/config";

/**
 * KitSource — the discriminator string of a {@link SourceSpec}.
 *
 * This used to be a hand-maintained union of `"npm" | "github" | "git" | "local"`.
 * It is now derived from {@link SourceSpec}["type"] so adding a new source
 * kind in `config.ts` automatically widens this type.
 *
 * Use {@link KitSource} where you only need the discriminator string. Use
 * {@link SourceSpec} where you also need the kind-specific options
 * (path/url/owner/etc.).
 */
export type KitSource = SourceSpec["type"];

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

export interface InstalledStashEntry {
  id: string;
  source: KitSource;
  ref: string;
  resolvedVersion?: string;
  resolvedRevision?: string;
  artifactUrl: string;
  stashRoot: string;
  cacheDir: string;
  installedAt: string;
  writable?: boolean;
  /** If set, all .md files in this stash are indexed as wiki pages under this wiki name */
  wikiName?: string;
}

export interface StashInstallResult extends InstalledStashEntry {
  extractedDir: string;
  integrity?: string;
  audit?: InstallAuditReport;
}

export interface RegistryAssetEntry {
  type: string;
  name: string;
  description?: string;
  tags?: string[];
  estimatedTokens?: number;
}

export interface RegistrySearchHit {
  source: KitSource;
  id: string;
  title: string;
  description?: string;
  ref: string;
  /** Ready-to-use ref for `akm add`. Always prefixed with the source type. */
  installRef: string;
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
  estimatedTokens?: number;
  stash: { id: string; name: string };
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
