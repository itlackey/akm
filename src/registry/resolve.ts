// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { jsonWithByteCap } from "../core/common";
import { NotFoundError, UsageError } from "../core/errors";
import { asRecord, asString, GITHUB_API_BASE, githubHeaders } from "../integrations/github";
import { cancelRegistryResponse, fetchRegistryResponse, type RegistryNetworkPolicy } from "./network";
import { isExactSemver, isSemverRange, maxSatisfying } from "./semver";
import type {
  InstallKind,
  ParsedGithubRef,
  ParsedGitRef,
  ParsedLocalRef,
  ParsedNpmRef,
  ParsedRegistryRef,
  ResolvedRegistryArtifact,
} from "./types";

/**
 * Pass an HTTPS bearer credential to Git without placing it in the remote URL
 * or argv. The value exists only in the child-process environment and is never
 * persisted or included in diagnostics.
 */
export function gitCredentialEnvironment(credential?: string): NodeJS.ProcessEnv {
  if (!credential) return { ...process.env };
  if (/[\r\n\0]/.test(credential)) {
    throw new UsageError("Git credential contains an invalid control character.");
  }
  const configuredCount = process.env.GIT_CONFIG_COUNT;
  const nextIndex = configuredCount === undefined ? 0 : Number(configuredCount);
  if (!Number.isSafeInteger(nextIndex) || nextIndex < 0) {
    throw new UsageError("GIT_CONFIG_COUNT must be a non-negative integer before a Git credential can be added.");
  }
  return {
    ...process.env,
    GIT_CONFIG_COUNT: String(nextIndex + 1),
    [`GIT_CONFIG_KEY_${nextIndex}`]: "http.extraHeader",
    [`GIT_CONFIG_VALUE_${nextIndex}`]: `Authorization: Bearer ${credential}`,
  };
}

/**
 * Validate that a URL is safe to pass to git.
 * Allowlists https:, http:, ssh:, git: schemes and git@ SSH shorthand.
 * Rejects git protocol helpers (ext::, fd::) that can execute arbitrary commands.
 */
export function validateGitUrl(url: string): void {
  // git@ SSH shorthand: git@host:path
  if (/^git@[^:]+:.+$/.test(url)) return;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new UsageError(`Invalid git URL: ${url}`);
  }

  const allowed = ["https:", "http:", "ssh:", "git:"];
  if (!allowed.includes(parsed.protocol)) {
    throw new UsageError(
      `Unsafe git URL scheme "${parsed.protocol}" in "${url}". Allowed: https, http, ssh, git, git@host:path`,
    );
  }
}

/** Validate that a git ref (branch/tag/commit) contains only safe characters. */
export function validateGitRef(ref: string): void {
  if (!/^[a-zA-Z0-9._\-/]+$/.test(ref)) {
    throw new UsageError(`Unsafe git ref "${ref}": only alphanumerics, '.', '_', '-', '/' are allowed`);
  }
}

export function parseRegistryRef(rawRef: string): ParsedRegistryRef {
  const ref = rawRef.trim();
  if (!ref) throw new Error("Registry ref is required.");

  // Detect registry search result IDs (e.g. "skills-sh:org/skills/name")
  // that are not installable refs. Known installable prefixes are handled below.
  const registryIdHint = detectRegistrySearchId(ref);
  if (registryIdHint) {
    throw new Error(registryIdHint);
  }

  if (ref.startsWith("npm:")) {
    return parseNpmRef(ref.slice(4), ref);
  }
  if (ref.startsWith("github:")) {
    return parseGithubShorthand(ref.slice(7), ref);
  }
  if (ref.startsWith("git+")) {
    return parseGitUrl(stripGitTransport(ref), ref);
  }
  if (ref.startsWith("file:")) {
    return tryParseLocalRef(fileUriToPath(ref), true) as ParsedLocalRef;
  }
  if (ref.startsWith("http://") || ref.startsWith("https://")) {
    return parseRemoteUrl(ref);
  }
  const localRef = tryParseLocalRef(ref, isPathLikeRef(ref));
  if (localRef) {
    return localRef;
  }

  if (ref.startsWith("@") || !looksLikeGithubOwnerRepo(ref)) {
    return parseNpmRef(ref, ref);
  }

  return parseGithubShorthand(ref, ref);
}

/** Inverse of {@link parseRegistryRef}: build the install ref for a source kind. */
export function buildInstallRef(
  source: InstallKind,
  ref: string,
  provenance: "operator" | "registry" = "operator",
): string {
  if (source === "git" && provenance === "registry") {
    throw new UsageError(
      "Registry-provided git transport refs are not installable. Add a trusted git URL directly if you intend to use it.",
    );
  }
  switch (source) {
    case "npm":
      return `npm:${ref}`;
    case "git":
      return `git+${ref}`;
    case "local":
      return `file:${ref}`;
    case "github":
      return `github:${ref}`;
  }
}

/**
 * Known prefixes that `parseRegistryRef` handles as installable sources.
 * Anything with a colon that doesn't start with one of these is likely a
 * registry search result ID (e.g. `skills-sh:org/skills/name`).
 */
const KNOWN_PREFIXES = ["npm:", "github:", "git+", "file:", "http://", "https://"];

function detectRegistrySearchId(ref: string): string | undefined {
  const colonIdx = ref.indexOf(":");
  if (colonIdx < 1) return undefined;

  // Skip known installable prefixes
  for (const prefix of KNOWN_PREFIXES) {
    if (ref.startsWith(prefix)) return undefined;
  }

  const prefix = ref.slice(0, colonIdx);
  // Registry IDs use lowercase-with-hyphens prefixes (e.g. skills-sh, static-index)
  if (!/^[a-z][a-z0-9-]*$/.test(prefix)) return undefined;

  const rest = ref.slice(colonIdx + 1);

  // Try to extract a plausible owner/repo from the rest (e.g. "org/repo/skill" → "org/repo")
  const segments = rest.split("/").filter(Boolean);
  const suggestedRef = segments.length >= 2 ? `github:${segments[0]}/${segments[1]}` : undefined;

  const lines = [
    `"${ref}" looks like a registry search result ID, not an installable ref.`,
    `The "${prefix}:" prefix is a registry identifier and cannot be passed to \`akm bundle add\`.`,
    "",
  ];
  if (suggestedRef) {
    lines.push(`Try installing the source repository directly:`, `  akm bundle add ${suggestedRef}`, "");
  }
  lines.push(
    "Or search for the installable ref:",
    `  akm search "${segments.length > 2 ? segments[segments.length - 1] : rest}" --from registry`,
    "Then install using the installRef value from the result:",
    "  akm bundle add github:owner/repo",
    "  akm bundle add npm:package-name",
  );
  return lines.join("\n");
}

export async function resolveRegistryArtifact(
  parsed: ParsedRegistryRef,
  options?: { gitCredential?: string },
): Promise<ResolvedRegistryArtifact> {
  switch (parsed.source) {
    case "npm":
      return resolveNpmArtifact(parsed);
    case "local":
      return resolveLocalArtifact(parsed);
    case "git":
      return resolveGitArtifact(parsed, options?.gitCredential);
    case "github":
      return resolveGithubArtifact(parsed, options?.gitCredential);
  }
}

function parseNpmRef(input: string, originalRef: string): ParsedNpmRef {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("Invalid npm ref.");

  const parsed = splitNpmNameAndVersion(trimmed);
  validateNpmPackageName(parsed.packageName);

  return {
    source: "npm",
    ref: originalRef,
    id: `npm:${parsed.packageName}`,
    packageName: parsed.packageName,
    requestedVersionOrTag: parsed.requestedVersionOrTag,
  };
}

function parseGithubShorthand(input: string, originalRef: string): ParsedGithubRef {
  const [repoPart, requestedRef] = splitRefSuffix(input.trim());
  const segments = repoPart.split("/").filter(Boolean);
  if (segments.length !== 2) {
    throw new Error("Invalid GitHub ref. Expected owner/repo or owner/repo#ref.");
  }
  const owner = segments[0];
  const repo = segments[1]!.replace(/\.git$/i, "");
  if (!owner || !repo) {
    throw new Error("Invalid GitHub ref. Expected owner/repo.");
  }
  return {
    source: "github",
    ref: originalRef,
    id: `github:${owner}/${repo}`,
    owner,
    repo,
    requestedRef,
  };
}

function parseRemoteUrl(rawUrl: string): ParsedGithubRef | ParsedGitRef {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Invalid registry URL.");
  }

  if (url.hostname === "github.com") {
    return parseGithubUrl(url, rawUrl);
  }

  return parseGitUrl(rawUrl, rawUrl);
}

function parseGithubUrl(url: URL, rawUrl: string): ParsedGithubRef {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length < 2) {
    throw new Error("Invalid GitHub URL. Expected https://github.com/owner/repo.");
  }
  const owner = segments[0]!;
  const repo = segments[1]!.replace(/\.git$/i, "");
  const requestedRef = url.hash ? decodeURIComponent(url.hash.slice(1)) : undefined;

  return {
    source: "github",
    ref: rawUrl,
    id: `github:${owner}/${repo}`,
    owner,
    repo,
    requestedRef,
  };
}

function parseGitUrl(input: string, originalRef: string): ParsedGitRef {
  const [urlPart, requestedRef] = splitRefSuffix(input.trim());
  if (!urlPart) throw new Error("Invalid git ref. A URL is required.");

  // Normalize the URL for the id (strip .git suffix, fragment)
  const normalized = urlPart.replace(/\.git$/i, "");

  return {
    source: "git",
    ref: originalRef,
    id: `git:${normalized}`,
    url: urlPart,
    requestedRef,
  };
}

function tryParseLocalRef(rawRef: string, explicitPath: boolean): ParsedLocalRef | undefined {
  const resolvedPath = path.resolve(rawRef);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolvedPath);
  } catch {
    // Explicit paths (./foo, ../bar, /abs) should throw on missing
    if (explicitPath) {
      throw new NotFoundError(
        `Local path not found: ${resolvedPath}`,
        "FILE_NOT_FOUND",
        "Check the path exists and is readable.",
      );
    }
    // Bare names that don't exist on disk — let caller fall through to npm/github
    return undefined;
  }

  if (!stat.isDirectory()) {
    if (explicitPath) {
      throw new Error("Local add path must be a directory, but the provided path is not one.");
    }
    // Bare name exists but isn't a directory — not a local ref
    return undefined;
  }

  const repoRoot = findGitRepoRoot(resolvedPath);

  return {
    source: "local",
    ref: rawRef,
    id: `local:${toReadableLocalId(resolvedPath)}`,
    repoRoot,
    sourcePath: resolvedPath,
  };
}

function isPathLikeRef(ref: string): boolean {
  // A leading `@` marks an npm scope (`@scope/pkg`), never a filesystem path —
  // treat it as non-path so it falls through to the npm branch instead of
  // being resolved (and rejected) as an explicit local path.
  if (ref.startsWith("@")) return false;
  if (ref === "." || ref === "..") return true;
  if (path.isAbsolute(ref)) return true;
  if (ref.startsWith("./") || ref.startsWith("../") || ref.startsWith(".\\") || ref.startsWith("..\\")) {
    return true;
  }
  // R-007: a bare `owner/repo` (or `owner/repo#ref`) shorthand is ambiguous
  // with a relative directory of the same shape, and is never an EXPLICIT
  // local path the way `./owner/repo` is. Treating it as non-path here means
  // `tryParseLocalRef` silently returns `undefined` (rather than throwing
  // NotFoundError) when no such directory exists on disk, letting
  // `parseRegistryRef`'s GitHub-shorthand fallback run instead. A directory
  // that DOES exist with this shape is unaffected — `tryParseLocalRef`
  // resolves it before the missing-path distinction ever matters.
  if (looksLikeGithubOwnerRepo(ref)) return false;
  return ref.includes("/") || ref.includes("\\");
}

/** Default public npm registry host. */
const DEFAULT_NPM_REGISTRY_HOST = "registry.npmjs.org";

/**
 * Typed error raised when the npm registry returns a tarball URL on a host
 * that is not the public registry or the operator-configured mirror. Carries
 * a stable `.code` so callers (and JSON envelope output) can branch on it
 * without parsing the message string.
 */
export class UntrustedNpmTarballError extends Error {
  readonly code = "UNTRUSTED_NPM_TARBALL" as const;
  private readonly _hint?: string;
  constructor(msg: string, hint?: string) {
    super(msg);
    this.name = "UntrustedNpmTarballError";
    this._hint = hint;
    Object.setPrototypeOf(this, new.target.prototype);
  }
  hint(): string | undefined {
    return (
      this._hint ??
      "Set AKM_NPM_REGISTRY to your private npm mirror's base URL if you install from a non-default registry."
    );
  }
}

/**
 * Resolve the set of npm registry hosts whose tarballs are considered trusted.
 * Always includes the public npm registry, plus the host of an operator-set
 * `AKM_NPM_REGISTRY` environment variable (if it parses to a valid URL).
 */
export function trustedNpmTarballHosts(): Set<string> {
  const hosts = new Set<string>([DEFAULT_NPM_REGISTRY_HOST]);
  const override = process.env.AKM_NPM_REGISTRY?.trim();
  if (override) {
    // A malformed override must not be silently ignored (falling back to the
    // public registry as though nothing was configured) — that would install
    // from the wrong registry without telling the operator (R-035).
    let overrideHost: string;
    try {
      overrideHost = new URL(override).hostname.toLowerCase();
    } catch {
      throw new UsageError(`AKM_NPM_REGISTRY is set to an invalid URL: ${override}`);
    }
    if (overrideHost) hosts.add(overrideHost);
  }
  return hosts;
}

/**
 * Validate that an npm tarball URL starts at the exact metadata registry
 * origin. A compromised mirror must not change scheme or port (or nominate a
 * different host) in `dist.tarball`; later public redirects remain subject to
 * the outbound boundary's hop-by-hop policy.
 */
export function validateNpmTarballUrl(tarballUrl: string, packageRef: string, registryOrigin?: string): void {
  let url: URL;
  try {
    url = new URL(tarballUrl);
  } catch {
    throw new UntrustedNpmTarballError(`npm package ${packageRef} returned an invalid tarball URL: ${tarballUrl}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new UntrustedNpmTarballError(
      `npm package ${packageRef} returned a tarball with disallowed scheme "${url.protocol}".`,
    );
  }
  const expectedOrigin = registryOrigin ?? new URL(npmMetadataRegistry().baseUrl).origin;
  if (url.origin !== expectedOrigin) {
    throw new UntrustedNpmTarballError(
      `npm package ${packageRef} returned a tarball URL on untrusted origin "${url.origin}" (expected: ${expectedOrigin}).`,
    );
  }
}

/** Network policy for a tarball URL that already passed {@link validateNpmTarballUrl}. */
export function npmArtifactNetworkPolicy(
  artifact: Pick<ResolvedRegistryArtifact, "registryOrigin" | "allowPrivateRegistryOrigin">,
): Extract<RegistryNetworkPolicy, { kind: "npm-api" }> {
  if (!artifact.registryOrigin) {
    throw new UsageError("npm artifact network policy requires the registry origin that authorized its metadata.");
  }
  return {
    kind: "npm-api",
    registryOrigin: new URL(artifact.registryOrigin).origin,
    allowPrivateRegistryOrigin: artifact.allowPrivateRegistryOrigin === true,
  };
}

/**
 * Resolve the npm registry base URL used to fetch package METADATA.
 *
 * R-035: `AKM_NPM_REGISTRY` previously only widened the trusted-tarball-host
 * allowlist (see {@link trustedNpmTarballHosts}) while the metadata endpoint
 * stayed hardcoded to the public registry — so an operator-configured mirror
 * was never actually consulted, making the `UntrustedNpmTarballError.hint()`
 * text below false. Honoring the override here for metadata too makes the
 * hint true: installs really do resolve entirely against the configured
 * mirror when it is set, mirroring how a private npm registry replaces the
 * default wholesale (like npm's own `--registry` flag) rather than being
 * merged with it.
 */
function npmMetadataRegistry(): { baseUrl: string; allowPrivateRegistryOrigin: boolean } {
  const override = process.env.AKM_NPM_REGISTRY?.trim();
  if (override) {
    // A malformed override must not be silently ignored (falling back to the
    // public registry as though nothing was configured) — that would install
    // from the wrong registry without telling the operator (R-035).
    let url: URL;
    try {
      url = new URL(override);
    } catch {
      throw new UsageError(`AKM_NPM_REGISTRY is set to an invalid URL: ${override}`);
    }
    const base = `${url.origin}${url.pathname === "/" ? "" : url.pathname}`;
    return { baseUrl: base.replace(/\/+$/, ""), allowPrivateRegistryOrigin: true };
  }
  return { baseUrl: `https://${DEFAULT_NPM_REGISTRY_HOST}`, allowPrivateRegistryOrigin: false };
}

/**
 * Resolve an npm dist-tag (e.g. "latest", "next") to the version it
 * currently points at, via the npm registry's per-version endpoint (`GET
 * <registry>/<name>/<tag>`), honouring `AKM_NPM_REGISTRY` exactly as a
 * package install does. Used by `akm upgrade --tag` (self-update.ts) to
 * resolve a dist-tag without pulling the full package metadata document.
 */
export async function resolveNpmDistTagVersion(packageName: string, tag: string): Promise<string> {
  const npmRegistry = npmMetadataRegistry();
  const npmPolicy: RegistryNetworkPolicy = {
    kind: "npm-api",
    registryOrigin: new URL(npmRegistry.baseUrl).origin,
    allowPrivateRegistryOrigin: npmRegistry.allowPrivateRegistryOrigin,
  };
  const encodedName = encodeURIComponent(packageName);
  const encodedTag = encodeURIComponent(tag);
  const versionDoc = await fetchJson<Record<string, unknown>>(
    `${npmRegistry.baseUrl}/${encodedName}/${encodedTag}`,
    undefined,
    npmPolicy,
  );
  const version = asString(versionDoc.version);
  if (!version) {
    throw new Error(`npm dist-tag "${tag}" for ${packageName} did not resolve to a version.`);
  }
  return version;
}

async function resolveNpmArtifact(parsed: ParsedNpmRef): Promise<ResolvedRegistryArtifact> {
  const encodedName = encodeURIComponent(parsed.packageName);
  const npmRegistry = npmMetadataRegistry();
  const npmPolicy: RegistryNetworkPolicy = {
    kind: "npm-api",
    registryOrigin: new URL(npmRegistry.baseUrl).origin,
    allowPrivateRegistryOrigin: npmRegistry.allowPrivateRegistryOrigin,
  };
  const metadata = await fetchJson<Record<string, unknown>>(
    `${npmRegistry.baseUrl}/${encodedName}`,
    undefined,
    npmPolicy,
  );

  const versions = asRecord(metadata.versions);
  const distTags = asRecord(metadata["dist-tags"]);

  const requested = parsed.requestedVersionOrTag;
  let resolvedVersion: string | undefined;
  if (!requested) {
    resolvedVersion = asString(distTags.latest);
  } else if (requested in versions) {
    resolvedVersion = requested;
  } else {
    // Try dist-tag first
    resolvedVersion = asString(distTags[requested]);

    // If not a dist-tag, try semver range resolution
    if (!resolvedVersion && isSemverRange(requested)) {
      const versionKeys = Object.keys(versions).filter(isExactSemver);
      resolvedVersion = maxSatisfying(versionKeys, requested);
    }
  }

  if (!resolvedVersion || !(resolvedVersion in versions)) {
    throw new Error(`Unable to resolve npm ref "${parsed.ref}".`);
  }

  const versionMeta = asRecord(versions[resolvedVersion]);
  const dist = asRecord(versionMeta.dist);
  const tarballUrl = asString(dist.tarball);
  if (!tarballUrl) {
    throw new Error(`npm package ${parsed.packageName}@${resolvedVersion} does not expose a tarball URL.`);
  }
  validateNpmTarballUrl(tarballUrl, `${parsed.packageName}@${resolvedVersion}`, npmPolicy.registryOrigin);

  const resolvedRevision = asString(dist.shasum) ?? asString(dist.integrity);

  return {
    id: parsed.id,
    source: parsed.source,
    ref: parsed.ref,
    artifactUrl: tarballUrl,
    resolvedVersion,
    resolvedRevision,
    registryOrigin: npmPolicy.registryOrigin,
    allowPrivateRegistryOrigin: npmPolicy.allowPrivateRegistryOrigin,
  };
}

async function resolveGithubArtifact(parsed: ParsedGithubRef, credential?: string): Promise<ResolvedRegistryArtifact> {
  const gitUrl = `https://github.com/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}.git`;
  const repoBase = `${GITHUB_API_BASE}/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}`;

  // Prefer git-backed installs so private GitHub repos work with the user's
  // normal git credential helper rather than requiring API-specific auth.
  const gitResolvedRevision = resolveGitRevisionFromRemote(gitUrl, parsed.requestedRef, credential);
  if (gitResolvedRevision) {
    return {
      id: parsed.id,
      source: parsed.source,
      ref: parsed.ref,
      artifactUrl: gitUrl,
      resolvedVersion: parsed.requestedRef,
      resolvedRevision: gitResolvedRevision,
    };
  }

  const headers = { ...githubHeaders(), ...(credential ? { Authorization: `Bearer ${credential}` } : {}) };

  if (parsed.requestedRef) {
    const commit = await tryFetchJson<Record<string, unknown>>(
      `${repoBase}/commits/${encodeURIComponent(parsed.requestedRef)}`,
      headers,
      GITHUB_API_POLICY,
    );
    const resolvedRevision = asString(commit?.sha) ?? parsed.requestedRef;
    return {
      id: parsed.id,
      source: parsed.source,
      ref: parsed.ref,
      artifactUrl: `${repoBase}/tarball/${encodeURIComponent(parsed.requestedRef)}`,
      resolvedRevision,
      resolvedVersion: parsed.requestedRef,
    };
  }

  const latestRelease = await tryFetchJson<Record<string, unknown>>(
    `${repoBase}/releases/latest`,
    headers,
    GITHUB_API_POLICY,
  );
  if (latestRelease) {
    const tarballUrl = asString(latestRelease.tarball_url);
    if (tarballUrl) {
      return {
        id: parsed.id,
        source: parsed.source,
        ref: parsed.ref,
        artifactUrl: tarballUrl,
        resolvedVersion: asString(latestRelease.tag_name),
        resolvedRevision: asString(latestRelease.target_commitish),
      };
    }
  }

  const repoMeta = await fetchJson<Record<string, unknown>>(repoBase, headers, GITHUB_API_POLICY);
  const defaultBranch = asString(repoMeta.default_branch);
  if (!defaultBranch) {
    throw new Error(`Unable to resolve default branch for ${parsed.owner}/${parsed.repo}.`);
  }

  const commit = await tryFetchJson<Record<string, unknown>>(
    `${repoBase}/commits/${encodeURIComponent(defaultBranch)}`,
    headers,
    GITHUB_API_POLICY,
  );

  return {
    id: parsed.id,
    source: parsed.source,
    ref: parsed.ref,
    artifactUrl: `${repoBase}/tarball/${encodeURIComponent(defaultBranch)}`,
    resolvedVersion: defaultBranch,
    resolvedRevision: asString(commit?.sha) ?? defaultBranch,
  };
}

function resolveGitRevisionFromRemote(url: string, requestedRef?: string, credential?: string): string | undefined {
  validateGitUrl(url);
  const ref = requestedRef ?? "HEAD";
  if (requestedRef) validateGitRef(requestedRef);
  const result = spawnSync("git", ["ls-remote", url, ref], {
    encoding: "utf8",
    timeout: 30_000,
    env: gitCredentialEnvironment(credential),
  });
  if (result.status !== 0) return undefined;
  const firstLine = result.stdout.trim().split(/\r?\n/)[0];
  return firstLine?.split(/\s/)[0] || undefined;
}

async function resolveGitArtifact(parsed: ParsedGitRef, credential?: string): Promise<ResolvedRegistryArtifact> {
  const resolvedRevision = resolveGitRevisionFromRemote(parsed.url, parsed.requestedRef, credential);
  if (!resolvedRevision) {
    // Unlike the GitHub path (which falls back to the REST API on a failed
    // `git ls-remote`), a plain git source has no fallback resolver — an
    // unresolved revision here would silently disable the post-clone
    // revision-integrity check in `verifyClonedRevision` (R-011).
    throw new Error(
      `Unable to resolve ${parsed.requestedRef ?? "HEAD"} for ${parsed.url} via 'git ls-remote'; refusing to install without a verifiable revision.`,
    );
  }
  return {
    id: parsed.id,
    source: parsed.source,
    ref: parsed.ref,
    artifactUrl: parsed.url,
    resolvedVersion: parsed.requestedRef,
    resolvedRevision,
  };
}

async function resolveLocalArtifact(parsed: ParsedLocalRef): Promise<ResolvedRegistryArtifact> {
  return {
    id: parsed.id,
    source: parsed.source,
    ref: parsed.ref,
    artifactUrl: pathToFileURL(parsed.sourcePath).toString(),
    resolvedRevision: parsed.repoRoot ? readGitValue(parsed.repoRoot, "rev-parse", "HEAD") : undefined,
    resolvedVersion: parsed.repoRoot ? readGitValue(parsed.repoRoot, "rev-parse", "--abbrev-ref", "HEAD") : undefined,
  };
}

function splitNpmNameAndVersion(input: string): { packageName: string; requestedVersionOrTag?: string } {
  if (input.startsWith("@")) {
    const secondAt = input.indexOf("@", 1);
    if (secondAt > 0) {
      return {
        packageName: input.slice(0, secondAt),
        requestedVersionOrTag: input.slice(secondAt + 1) || undefined,
      };
    }
    return { packageName: input };
  }

  const at = input.lastIndexOf("@");
  if (at > 0) {
    return {
      packageName: input.slice(0, at),
      requestedVersionOrTag: input.slice(at + 1) || undefined,
    };
  }
  return { packageName: input };
}

function validateNpmPackageName(name: string): void {
  if (!name) throw new Error("Invalid npm package name: name is required.");
  if (name.length > 214) throw new Error(`Invalid npm package name: "${name}" exceeds 214 characters.`);
  if (name !== name.toLowerCase() && !name.startsWith("@")) {
    throw new Error(`Invalid npm package name: "${name}" must be lowercase.`);
  }
  if (name.startsWith(".") || name.startsWith("_")) {
    throw new Error(`Invalid npm package name: "${name}" cannot start with . or _.`);
  }
  if (
    /[~'!()*]/.test(name) ||
    name.includes(" ") ||
    encodeURIComponent(name)
      .replace(/%40/g, "@")
      .replace(/%2[Ff]/g, "/") !== name
  ) {
    throw new Error(`Invalid npm package name: "${name}" contains invalid characters.`);
  }
}

function looksLikeGithubOwnerRepo(ref: string): boolean {
  const [repoPart] = splitRefSuffix(ref);
  const parts = repoPart.split("/").filter(Boolean);
  return parts.length === 2;
}

function splitRefSuffix(value: string): [string, string | undefined] {
  const hash = value.indexOf("#");
  if (hash < 0) return [value, undefined];
  return [value.slice(0, hash), value.slice(hash + 1) || undefined];
}

/**
 * Strip the `git+` transport prefix from a ref, returning the inner URL.
 * Handles `git+https://...`, `git+ssh://...`, `git+http://...`, etc.
 */
function stripGitTransport(ref: string): string {
  return ref.slice(4); // strip "git+"
}

/**
 * Convert a `file:` URI to a local filesystem path.
 *
 * Standard `file:///absolute` forms are handled by Node's `fileURLToPath`.
 * Non-standard `file:./relative` and `file:../relative` shorthand forms
 * (not a valid RFC 8089 URL) are handled with a custom fallback.
 */
function fileUriToPath(ref: string): string {
  const after = ref.slice(5); // strip "file:"
  // Standard file:///absolute/path — delegate to Node's implementation
  if (after.startsWith("//")) {
    try {
      return fileURLToPath(ref);
    } catch {
      // Fall through to custom handling
    }
  }
  // Non-standard file:./relative or file:../relative or file:/absolute
  return after;
}

/**
 * Build a human-readable local ID from an absolute path.
 *   /home/user/akm/skills     → ~/akm/skills
 *   /tmp/my-stash               → /tmp/my-stash
 */
function toReadableLocalId(absolutePath: string): string {
  const home = os.homedir();
  if (absolutePath === home) return "~";
  if (absolutePath.startsWith(home + path.sep)) {
    return `~/${absolutePath.slice(home.length + 1)}`;
  }
  return absolutePath;
}

function findGitRepoRoot(startDir: string): string | undefined {
  let current = path.resolve(startDir);
  while (true) {
    if (fs.existsSync(path.join(current, ".git"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function readGitValue(repoRoot: string, ...args: string[]): string | undefined {
  const result = spawnSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" });
  if (result.status !== 0) return undefined;
  const value = result.stdout.trim();
  return value || undefined;
}

// Cap JSON responses at 10 MB — npm package manifests and GitHub API
// responses are typically a few KB; a compromised registry streaming
// tens of MB of JSON is a DoS surface, not a feature.
const REGISTRY_JSON_BYTE_CAP = 10 * 1024 * 1024;

const GITHUB_API_POLICY: RegistryNetworkPolicy = { kind: "github-api" };

async function fetchJson<T>(url: string, headers: HeadersInit | undefined, policy: RegistryNetworkPolicy): Promise<T> {
  const response = await fetchRegistryResponse(url, { headers }, { policy, timeoutMs: 30_000 });
  if (!response.ok) {
    await cancelRegistryResponse(response);
    throw new Error(`Request failed (${response.status}) for ${url}`);
  }
  return jsonWithByteCap<T>(response, REGISTRY_JSON_BYTE_CAP, { bodyTimeoutMs: 30_000 });
}

async function tryFetchJson<T>(
  url: string,
  headers: HeadersInit | undefined,
  policy: RegistryNetworkPolicy,
): Promise<T | null> {
  const response = await fetchRegistryResponse(url, { headers }, { policy, timeoutMs: 30_000 });
  if (!response.ok) {
    await cancelRegistryResponse(response);
    return null;
  }
  return jsonWithByteCap<T>(response, REGISTRY_JSON_BYTE_CAP, { bodyTimeoutMs: 30_000 });
}
