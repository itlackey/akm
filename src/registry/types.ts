// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// SourceSpec's defining module (config.ts only re-exports it) — importing the
// leaf directly breaks the config → config-schema → registry/types → config
// ring (chunk-8 WI-8.6, DoD 11).
import type { SourceSpec } from "../core/config/config-types";

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

/** The install/registry source discriminator: exactly the kinds `parseRegistryRef` can emit. */
export type InstallKind = ParsedRegistryRef["source"]; // "npm" | "github" | "git" | "local"

export interface RegistryRefBase {
  source: InstallKind;
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
  source: InstallKind;
  ref: string;
  artifactUrl: string;
  resolvedVersion?: string;
  resolvedRevision?: string;
}

export interface InstalledBundle {
  id: string;
  source: InstallKind;
  ref: string;
  resolvedVersion?: string;
  resolvedRevision?: string;
  artifactUrl: string;
  stashRoot: string;
  cacheDir: string;
  installedAt: string;
  writable?: boolean;
}

export interface StashInstallResult extends InstalledBundle {
  extractedDir: string;
  integrity?: string;
}

export interface RegistryAssetEntry {
  type: string;
  name: string;
  description?: string;
  tags?: string[];
  estimatedTokens?: number;
}

export interface RegistrySearchHit {
  source: InstallKind;
  id: string;
  title: string;
  description?: string;
  ref: string;
  /** Ready-to-use ref for `akm add`. Always prefixed with the source type. */
  installRef: string;
  homepage?: string;
  /**
   * Registry-native ranking score. NOT comparable to the locked v1
   * `SearchHit.score` (which is `[0, 1]`, higher = better). Provider-defined
   * and may exceed `1` (e.g. `scoreStash()` in `providers/static-index.ts` can
   * emit values up to ~1.85). Use only for ranking within a single registry;
   * do not cross-compare with `SearchHit.score` or scores from other
   * registries. See docs/reference/cli.md.
   */
  score?: number;
  metadata?: Record<string, string>;
  /** Name of the registry that provided this hit (provenance tracking) */
  registryName?: string;
  /**
   * Non-fatal hit-level warnings surfaced by the registry provider (v1 spec
   * §4.2). Optional; absent when there is nothing to surface. Adding a value
   * here MUST NOT change ranking — warnings are informational only.
   */
  warnings?: string[];
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
