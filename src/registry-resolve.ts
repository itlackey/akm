import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { fetchWithRetry } from "./common";
import { asRecord, asString, GITHUB_API_BASE, githubHeaders } from "./github";
import type {
  ParsedGithubRef,
  ParsedGitRef,
  ParsedLocalRef,
  ParsedNpmRef,
  ParsedRegistryRef,
  ResolvedRegistryArtifact,
} from "./registry-types";

export function parseRegistryRef(rawRef: string): ParsedRegistryRef {
  const ref = rawRef.trim();
  if (!ref) throw new Error("Registry ref is required.");

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

export async function resolveRegistryArtifact(parsed: ParsedRegistryRef): Promise<ResolvedRegistryArtifact> {
  if (parsed.source === "npm") {
    return resolveNpmArtifact(parsed);
  }
  if (parsed.source === "local") {
    return resolveLocalArtifact(parsed);
  }
  if (parsed.source === "git") {
    return resolveGitArtifact(parsed);
  }
  return resolveGithubArtifact(parsed);
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
  const repo = segments[1].replace(/\.git$/i, "");
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
  const owner = segments[0];
  const repo = segments[1].replace(/\.git$/i, "");
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
      throw new Error(`Local path not found: ${resolvedPath}`);
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
  if (ref === "." || ref === "..") return true;
  if (path.isAbsolute(ref)) return true;
  if (ref.startsWith("./") || ref.startsWith("../") || ref.startsWith(".\\") || ref.startsWith("..\\")) {
    return true;
  }
  return ref.includes("/") || ref.includes("\\");
}

async function resolveNpmArtifact(parsed: ParsedNpmRef): Promise<ResolvedRegistryArtifact> {
  const encodedName = encodeURIComponent(parsed.packageName);
  const metadata = await fetchJson<Record<string, unknown>>(`https://registry.npmjs.org/${encodedName}`);

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

  const resolvedRevision = asString(dist.shasum) ?? asString(dist.integrity);

  return {
    id: parsed.id,
    source: parsed.source,
    ref: parsed.ref,
    artifactUrl: tarballUrl,
    resolvedVersion,
    resolvedRevision,
  };
}

async function resolveGithubArtifact(parsed: ParsedGithubRef): Promise<ResolvedRegistryArtifact> {
  const headers = githubHeaders();

  if (parsed.requestedRef) {
    const commit = await tryFetchJson<Record<string, unknown>>(
      `${GITHUB_API_BASE}/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/commits/${encodeURIComponent(parsed.requestedRef)}`,
      headers,
    );
    const resolvedRevision = asString(commit?.sha) ?? parsed.requestedRef;
    return {
      id: parsed.id,
      source: parsed.source,
      ref: parsed.ref,
      artifactUrl: `${GITHUB_API_BASE}/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/tarball/${encodeURIComponent(parsed.requestedRef)}`,
      resolvedRevision,
      resolvedVersion: parsed.requestedRef,
    };
  }

  const latestRelease = await tryFetchJson<Record<string, unknown>>(
    `${GITHUB_API_BASE}/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/releases/latest`,
    headers,
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

  const repoMeta = await fetchJson<Record<string, unknown>>(
    `${GITHUB_API_BASE}/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}`,
    headers,
  );
  const defaultBranch = asString(repoMeta.default_branch);
  if (!defaultBranch) {
    throw new Error(`Unable to resolve default branch for ${parsed.owner}/${parsed.repo}.`);
  }

  const commit = await tryFetchJson<Record<string, unknown>>(
    `${GITHUB_API_BASE}/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/commits/${encodeURIComponent(defaultBranch)}`,
    headers,
  );

  return {
    id: parsed.id,
    source: parsed.source,
    ref: parsed.ref,
    artifactUrl: `${GITHUB_API_BASE}/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/tarball/${encodeURIComponent(defaultBranch)}`,
    resolvedVersion: defaultBranch,
    resolvedRevision: asString(commit?.sha) ?? defaultBranch,
  };
}

async function resolveGitArtifact(parsed: ParsedGitRef): Promise<ResolvedRegistryArtifact> {
  const ref = parsed.requestedRef ?? "HEAD";
  const result = spawnSync("git", ["ls-remote", parsed.url, ref], { encoding: "utf8", timeout: 30_000 });
  let resolvedRevision: string | undefined;
  if (result.status === 0) {
    const firstLine = result.stdout.trim().split(/\r?\n/)[0];
    resolvedRevision = firstLine?.split(/\s/)[0] || undefined;
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
 * Supports `file:./relative`, `file:../relative`, and `file:///absolute`.
 */
function fileUriToPath(ref: string): string {
  const after = ref.slice(5); // strip "file:"
  // file:///absolute/path or file:///C:/path
  if (after.startsWith("///")) {
    return after.slice(2); // keep one leading /
  }
  // file://hostname/path (rare, treat hostname/path as absolute)
  if (after.startsWith("//")) {
    return after.slice(1);
  }
  // file:./relative or file:../relative or file:/absolute
  return after;
}

/**
 * Build a human-readable local ID from an absolute path.
 *   /home/user/.hyphn/skills  → ~/.hyphn/skills
 *   /tmp/my-kit               → /tmp/my-kit
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

// ── Semver helpers ──────────────────────────────────────────────────────────

interface SemverParts {
  major: number;
  minor: number;
  patch: number;
  prerelease?: string;
}

function parseSemver(version: string): SemverParts | undefined {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/);
  if (!match) return undefined;
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
    prerelease: match[4],
  };
}

function isExactSemver(version: string): boolean {
  return /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.+-]+)?$/.test(version);
}

function isSemverRange(input: string): boolean {
  return /^[~^>=<*]/.test(input) || /^\d+\.(\d+|\*)/.test(input);
}

function compareSemver(a: SemverParts, b: SemverParts): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  // Versions with prerelease are lower than release
  if (a.prerelease && !b.prerelease) return -1;
  if (!a.prerelease && b.prerelease) return 1;
  return 0;
}

function semverGte(a: SemverParts, b: SemverParts): boolean {
  return compareSemver(a, b) >= 0;
}

function satisfiesRange(version: SemverParts, range: string): boolean {
  // Skip pre-release versions unless range specifically mentions one
  if (version.prerelease && !range.includes("-")) return false;

  // ^1.2.3 — compatible with version: same major, >= minor.patch
  const caretMatch = range.match(/^\^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/);
  if (caretMatch) {
    const rMajor = parseInt(caretMatch[1], 10);
    const rMinor = parseInt(caretMatch[2], 10);
    const rPatch = parseInt(caretMatch[3], 10);
    if (version.major !== rMajor) return false;
    // ^0.x has special behavior: ^0.2.3 means >=0.2.3 <0.3.0
    if (rMajor === 0) {
      if (version.minor !== rMinor) return false;
      return version.patch >= rPatch;
    }
    return semverGte(version, { major: rMajor, minor: rMinor, patch: rPatch });
  }

  // ~1.2.3 — same major.minor, patch >= specified
  const tildeMatch = range.match(/^~(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/);
  if (tildeMatch) {
    const rMajor = parseInt(tildeMatch[1], 10);
    const rMinor = parseInt(tildeMatch[2], 10);
    const rPatch = parseInt(tildeMatch[3], 10);
    return version.major === rMajor && version.minor === rMinor && version.patch >= rPatch;
  }

  // >=1.2.3
  const gteMatch = range.match(/^>=(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/);
  if (gteMatch) {
    const rMajor = parseInt(gteMatch[1], 10);
    const rMinor = parseInt(gteMatch[2], 10);
    const rPatch = parseInt(gteMatch[3], 10);
    return semverGte(version, { major: rMajor, minor: rMinor, patch: rPatch });
  }

  // * or latest
  if (range === "*" || range === "latest") return true;

  return false;
}

export function maxSatisfying(versions: string[], range: string): string | undefined {
  const candidates: Array<{ version: string; parsed: SemverParts }> = [];
  for (const v of versions) {
    const parsed = parseSemver(v);
    if (!parsed) continue;
    if (satisfiesRange(parsed, range)) {
      candidates.push({ version: v, parsed });
    }
  }
  if (candidates.length === 0) return undefined;
  candidates.sort((a, b) => compareSemver(b.parsed, a.parsed));
  return candidates[0].version;
}

async function fetchJson<T>(url: string, headers?: HeadersInit): Promise<T> {
  const response = await fetchWithRetry(url, { headers });
  if (!response.ok) {
    throw new Error(`Request failed (${response.status}) for ${url}`);
  }
  return (await response.json()) as T;
}

async function tryFetchJson<T>(url: string, headers?: HeadersInit): Promise<T | null> {
  const response = await fetchWithRetry(url, { headers });
  if (!response.ok) return null;
  return (await response.json()) as T;
}
