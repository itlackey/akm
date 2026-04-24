import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { TYPE_DIRS } from "./asset-spec";
import { fetchWithRetry, isWithin } from "./common";
import { type AkmConfig, loadConfig, loadUserConfig, saveConfig } from "./config";
import {
  auditInstallCandidate,
  deriveRegistryLabels,
  enforceRegistryInstallPolicy,
  formatInstallAuditFailure,
} from "./install-audit";
import { getRegistryCacheDir as _getRegistryCacheDir } from "./paths";
import { parseRegistryRef, resolveRegistryArtifact, validateGitRef, validateGitUrl } from "./registry-resolve";
import type {
  InstalledStashEntry,
  KitSource,
  ParsedGithubRef,
  ParsedGitRef,
  ParsedLocalRef,
  StashInstallResult,
} from "./registry-types";
import { copyIncludedPaths, findNearestIncludeConfig } from "./stash-include";
import { warn } from "./warn";

const REGISTRY_STASH_DIR_NAMES = new Set<string>(Object.values(TYPE_DIRS));

export interface InstallRegistryRefOptions {
  cacheRootDir?: string;
  now?: Date;
  trustThisInstall?: boolean;
  writable?: boolean;
}

export async function installRegistryRef(
  ref: string,
  options?: InstallRegistryRefOptions,
): Promise<StashInstallResult> {
  const parsed = parseRegistryRef(ref);
  const config = loadConfig();
  if (parsed.source === "local") {
    return installLocalRegistryRef(parsed, config, options);
  }
  if (parsed.source === "git") {
    return installGitRegistryRef(parsed, config, options);
  }
  if (parsed.source === "github") {
    return installGithubRegistryRef(parsed, config, options);
  }
  const resolved = await resolveRegistryArtifact(parsed);
  const registryLabels = deriveRegistryLabels({
    source: resolved.source,
    ref: resolved.ref,
    artifactUrl: resolved.artifactUrl,
  });
  enforceRegistryInstallPolicy(registryLabels, config, ref);

  const installedAt = (options?.now ?? new Date()).toISOString();
  const cacheRootDir = options?.cacheRootDir ?? getRegistryCacheRootDir();
  const cacheDir = buildInstallCacheDir(
    cacheRootDir,
    resolved.source,
    resolved.id,
    resolved.resolvedVersion ?? resolved.resolvedRevision,
  );
  const archivePath = path.join(cacheDir, "artifact.tar.gz");
  const extractedDir = path.join(cacheDir, "extracted");

  // Check for cache hit: if extracted dir already exists and has a valid stash root, reuse it
  if (isDirectory(extractedDir)) {
    try {
      const cachedStashRoot = detectStashRoot(extractedDir);
      if (cachedStashRoot) {
        const integrity = fs.existsSync(archivePath) ? await computeFileHash(archivePath) : undefined;
        const audit = runInstallAuditOrThrow(
          extractedDir,
          resolved.source,
          resolved.ref,
          registryLabels,
          config,
          options,
        );
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
          writable: options?.writable,
          audit,
        };
      }
    } catch {
      // Cache invalid, re-download
    }
  }

  fs.mkdirSync(cacheDir, { recursive: true });

  let integrity: string;
  let provisionalKitRoot: string;
  let installRoot: string;
  let stashRoot: string;
  let audit: StashInstallResult["audit"];
  try {
    await downloadArchive(resolved.artifactUrl, archivePath);
    verifyArchiveIntegrity(archivePath, resolved.resolvedRevision, resolved.source);
    integrity = await computeFileHash(archivePath);
    extractTarGzSecure(archivePath, extractedDir);
    audit = runInstallAuditOrThrow(extractedDir, resolved.source, resolved.ref, registryLabels, config, options);

    provisionalKitRoot = detectStashRoot(extractedDir);
    installRoot = applyAkmIncludeConfig(provisionalKitRoot, cacheDir, extractedDir) ?? provisionalKitRoot;
    stashRoot = detectStashRoot(installRoot);
  } catch (err) {
    // Clean up the cache directory so stale or partially-extracted artifacts
    // don't cause false cache hits on the next install attempt.
    try {
      fs.rmSync(cacheDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup; ignore errors
    }
    throw err;
  }

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
    writable: options?.writable,
    audit,
  };
}

async function installGithubRegistryRef(
  parsed: ParsedGithubRef,
  config: AkmConfig,
  options?: InstallRegistryRefOptions,
): Promise<StashInstallResult> {
  const gitParsed: ParsedGitRef = {
    source: "git",
    ref: parsed.ref,
    id: parsed.id,
    url: `https://github.com/${parsed.owner}/${parsed.repo}.git`,
    requestedRef: parsed.requestedRef,
  };
  const installed = await installGitRegistryRef(gitParsed, config, options);
  return {
    ...installed,
    source: "github",
  };
}

async function installLocalRegistryRef(
  parsed: ParsedLocalRef,
  config: AkmConfig,
  options?: InstallRegistryRefOptions,
): Promise<StashInstallResult> {
  const resolved = await resolveRegistryArtifact(parsed);
  const installedAt = (options?.now ?? new Date()).toISOString();
  const registryLabels = deriveRegistryLabels({
    source: resolved.source,
    ref: resolved.ref,
    artifactUrl: resolved.artifactUrl,
  });
  const audit = runInstallAuditOrThrow(
    parsed.sourcePath,
    resolved.source,
    resolved.ref,
    registryLabels,
    config,
    options,
  );

  // For local directories, detect the stash root within the source path.
  // If no nested stash is found, the source path itself is used.
  const stashRoot = detectStashRoot(parsed.sourcePath);

  return {
    id: resolved.id,
    source: resolved.source,
    ref: resolved.ref,
    artifactUrl: resolved.artifactUrl,
    resolvedVersion: resolved.resolvedVersion,
    resolvedRevision: resolved.resolvedRevision,
    installedAt,
    cacheDir: parsed.sourcePath,
    extractedDir: parsed.sourcePath,
    stashRoot,
    writable: options?.writable,
    audit,
  };
}

async function installGitRegistryRef(
  parsed: ParsedGitRef,
  config: AkmConfig,
  options?: InstallRegistryRefOptions,
): Promise<StashInstallResult> {
  const resolved = await resolveRegistryArtifact(parsed);
  const registryLabels = deriveRegistryLabels({
    source: resolved.source,
    ref: resolved.ref,
    artifactUrl: resolved.artifactUrl,
    gitUrl: parsed.url,
  });
  enforceRegistryInstallPolicy(registryLabels, config, parsed.ref);
  const installedAt = (options?.now ?? new Date()).toISOString();
  const cacheRootDir = options?.cacheRootDir ?? getRegistryCacheRootDir();
  const cacheDir = buildInstallCacheDir(cacheRootDir, parsed.source, parsed.id, resolved.resolvedRevision);
  const cloneDir = path.join(cacheDir, "clone");
  const extractedDir = path.join(cacheDir, "extracted");

  // Check for cache hit
  if (isDirectory(extractedDir)) {
    try {
      const provisionalKitRoot = detectStashRoot(extractedDir);
      const installRoot = applyAkmIncludeConfig(provisionalKitRoot, cacheDir, extractedDir) ?? provisionalKitRoot;
      const stashRoot = detectStashRoot(installRoot);
      if (stashRoot) {
        const audit = runInstallAuditOrThrow(
          extractedDir,
          resolved.source,
          resolved.ref,
          registryLabels,
          config,
          options,
        );
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
          writable: options?.writable,
          audit,
        };
      }
    } catch {
      // Cache invalid, re-clone
    }
  }

  fs.mkdirSync(cacheDir, { recursive: true });

  // Validate URL and ref before passing to git to prevent command injection
  validateGitUrl(parsed.url);
  if (parsed.requestedRef) validateGitRef(parsed.requestedRef);

  let provisionalKitRoot: string;
  let installRoot: string;
  let stashRoot: string;
  let audit: StashInstallResult["audit"];
  try {
    const cloneArgs = ["clone", "--depth", "1"];
    if (parsed.requestedRef) {
      cloneArgs.push("--branch", parsed.requestedRef);
    }
    cloneArgs.push(parsed.url, cloneDir);

    const cloneResult = spawnSync("git", cloneArgs, { encoding: "utf8", timeout: 120_000 });
    if (cloneResult.status !== 0) {
      const err = cloneResult.stderr?.trim() || cloneResult.error?.message || "unknown error";
      throw new Error(`Failed to clone ${parsed.url}: ${err}`);
    }

    // Copy contents to extracted dir without .git
    fs.mkdirSync(extractedDir, { recursive: true });
    copyDirectoryContents(cloneDir, extractedDir);

    // Clean up the clone dir
    fs.rmSync(cloneDir, { recursive: true, force: true });

    audit = runInstallAuditOrThrow(extractedDir, resolved.source, resolved.ref, registryLabels, config, options);
    provisionalKitRoot = detectStashRoot(extractedDir);
    installRoot = applyAkmIncludeConfig(provisionalKitRoot, cacheDir, extractedDir) ?? provisionalKitRoot;
    stashRoot = detectStashRoot(installRoot);
  } catch (err) {
    // Clean up the cache directory so stale or partially-cloned artifacts
    // don't cause false cache hits on the next install attempt.
    try {
      fs.rmSync(cacheDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup; ignore errors
    }
    throw err;
  }

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
    writable: options?.writable,
    audit,
  };
}

export function upsertInstalledRegistryEntry(entry: InstalledStashEntry): AkmConfig {
  const current = loadUserConfig();
  const currentInstalled = current.installed ?? [];
  const withoutExisting = currentInstalled.filter((item) => item.id !== entry.id);
  const nextInstalled = [...withoutExisting, normalizeInstalledEntry(entry)];

  const nextConfig: AkmConfig = {
    ...current,
    installed: nextInstalled,
  };
  saveConfig(nextConfig);
  return nextConfig;
}

export function removeInstalledRegistryEntry(id: string): AkmConfig {
  const current = loadUserConfig();
  const currentInstalled = current.installed ?? [];
  const nextInstalled = currentInstalled.filter((item) => item.id !== id);

  const nextConfig: AkmConfig = {
    ...current,
    installed: nextInstalled.length > 0 ? nextInstalled : undefined,
  };
  saveConfig(nextConfig);
  return nextConfig;
}

export function getRegistryCacheRootDir(): string {
  return _getRegistryCacheDir();
}

export function detectStashRoot(extractedDir: string): string {
  const root = path.resolve(extractedDir);

  const rootDotStash = path.join(root, ".stash");
  if (isDirectory(rootDotStash)) {
    return root;
  }

  if (hasStashDirs(root)) {
    return root;
  }

  const shallowest = findShallowestStashRoot(root);
  if (shallowest) return shallowest;

  return root;
}

function buildInstallCacheDir(cacheRootDir: string, source: KitSource, id: string, version?: string): string {
  const slug = `${source}-${id.replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "")}`;
  const versionSlug =
    source === "local"
      ? `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
      : (version?.replace(/[^a-zA-Z0-9_.-]+/g, "-") ?? `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
  return path.join(cacheRootDir, slug || source, versionSlug);
}

function applyAkmIncludeConfig(
  sourceRoot: string,
  cacheDir: string,
  searchRoot: string = sourceRoot,
): string | undefined {
  const includeConfig = findNearestIncludeConfig(sourceRoot, searchRoot);
  if (!includeConfig) return undefined;

  const selectedDir = path.join(cacheDir, "selected");
  fs.rmSync(selectedDir, { recursive: true, force: true });
  fs.mkdirSync(selectedDir, { recursive: true });
  copyIncludedPaths(includeConfig.include, includeConfig.baseDir, selectedDir);
  return selectedDir;
}

async function downloadArchive(url: string, destination: string): Promise<void> {
  const response = await fetchWithRetry(url, undefined, { timeout: 120_000 });
  if (!response.ok) {
    throw new Error(`Failed to download archive (${response.status}) from ${url}`);
  }
  // Stream response to disk instead of buffering the entire archive in memory.
  // Uses Bun.write which handles Response streaming natively.
  const BunRuntime: { write(path: string, body: Response): Promise<number> } = (globalThis as Record<string, unknown>)
    .Bun as typeof BunRuntime;
  if (BunRuntime?.write) {
    await BunRuntime.write(destination, response);
  } else {
    // Fallback for non-Bun environments (e.g., tests)
    const arrayBuffer = await response.arrayBuffer();
    fs.writeFileSync(destination, Buffer.from(arrayBuffer));
  }
}

export function verifyArchiveIntegrity(archivePath: string, expected: string | undefined, source?: KitSource): void {
  if (!expected) return;

  // For GitHub and git sources, resolvedRevision is a commit SHA, not a content hash.
  // Content integrity cannot be verified from a commit hash, so skip verification.
  if (source === "github" || source === "git") return;

  const fileBuffer = fs.readFileSync(archivePath);

  // SRI hash format: sha256-<base64> or sha512-<base64>
  if (expected.startsWith("sha256-") || expected.startsWith("sha512-")) {
    const dashIndex = expected.indexOf("-");
    const algorithm = expected.slice(0, dashIndex);
    const expectedBase64 = expected.slice(dashIndex + 1);
    const actualBase64 = createHash(algorithm).update(fileBuffer).digest("base64");
    if (actualBase64 !== expectedBase64) {
      fs.unlinkSync(archivePath);
      throw new Error(
        `Integrity check failed for ${archivePath}: expected ${algorithm} digest ${expectedBase64}, got ${actualBase64}`,
      );
    }
    return;
  }

  // Hex shasum (SHA-1 from npm)
  if (/^[0-9a-f]{40}$/i.test(expected)) {
    const actualHex = createHash("sha1").update(fileBuffer).digest("hex");
    if (actualHex.toLowerCase() !== expected.toLowerCase()) {
      fs.unlinkSync(archivePath);
      throw new Error(`Integrity check failed for ${archivePath}: expected sha1 ${expected}, got ${actualHex}`);
    }
    return;
  }

  // Unrecognized format — warn and skip verification
  warn("Unrecognized integrity format: %s — verification skipped", expected);
}

export function extractTarGzSecure(archivePath: string, destinationDir: string): void {
  const listResult = spawnSync("tar", ["tzf", archivePath], { encoding: "utf8" });
  if (listResult.status !== 0) {
    const err = listResult.stderr?.trim() || listResult.error?.message || "unknown error";
    throw new Error(`Failed to inspect archive ${archivePath}: ${err}`);
  }

  validateTarEntries(listResult.stdout);

  fs.rmSync(destinationDir, { recursive: true, force: true });
  fs.mkdirSync(destinationDir, { recursive: true });

  const extractResult = spawnSync(
    "tar",
    ["xzf", archivePath, "--no-same-owner", "--strip-components=1", "-C", destinationDir],
    { encoding: "utf8" },
  );
  if (extractResult.status !== 0) {
    const err = extractResult.stderr?.trim() || extractResult.error?.message || "unknown error";
    throw new Error(`Failed to extract archive ${archivePath}: ${err}`);
  }

  // Post-extraction scan: verify all extracted files are within destinationDir
  // This mitigates TOCTOU between validateTarEntries (list) and tar extract.
  scanExtractedFiles(destinationDir, destinationDir);
}

function scanExtractedFiles(dir: string, root: string): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    // Check for ".." segments in names (e.g. symlink tricks or crafted filenames)
    if (entry.name.includes("..")) {
      throw new Error(`Post-extraction scan: suspicious entry name: ${fullPath}`);
    }
    // Resolve symlinks to detect escapes outside the destination directory
    if (entry.isSymbolicLink()) {
      const target = fs.realpathSync(fullPath);
      if (!isWithin(target, root)) {
        throw new Error(`Post-extraction scan: symlink escapes destination directory: ${fullPath} -> ${target}`);
      }
    }
    if (entry.isDirectory()) {
      scanExtractedFiles(fullPath, root);
    }
  }
}

export function validateTarEntries(listOutput: string): void {
  const lines = listOutput.split(/\r?\n/).filter(Boolean);
  for (const rawLine of lines) {
    const entry = rawLine.trim();
    if (!entry || entry.includes("\0")) {
      throw new Error(`Archive contains an invalid entry: ${JSON.stringify(rawLine)}`);
    }
    if (entry.startsWith("/")) {
      throw new Error(`Archive contains an absolute path entry: ${entry}`);
    }

    const normalized = path.posix.normalize(entry);
    if (normalized === ".." || normalized.startsWith("../")) {
      throw new Error(`Archive contains a path traversal entry: ${entry}`);
    }

    const parts = normalized.split("/").filter(Boolean);
    const stripped = parts.slice(1).join("/");
    if (!stripped) continue;
    const normalizedStripped = path.posix.normalize(stripped);
    if (
      normalizedStripped === ".." ||
      normalizedStripped.startsWith("../") ||
      path.posix.isAbsolute(normalizedStripped)
    ) {
      throw new Error(`Archive contains an unsafe entry after strip-components: ${entry}`);
    }
  }
}

function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function hasStashDirs(dirPath: string): boolean {
  if (!isDirectory(dirPath)) return false;
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  return entries.some((entry) => entry.isDirectory() && REGISTRY_STASH_DIR_NAMES.has(entry.name));
}

function countStashDirs(dirPath: string): number {
  if (!isDirectory(dirPath)) return 0;
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory() && REGISTRY_STASH_DIR_NAMES.has(entry.name)).length;
}

/**
 * BFS to find the shallowest directory that looks like a stash root.
 * Checks for both `.stash` directories and well-known type directories
 * (scripts/, skills/, etc.), so nested layouts like `project/my-stash/scripts/`
 * are discovered even without a `.stash` marker.
 *
 * Skips `root` itself since the caller already checked it via `hasStashDirs`.
 */
const BFS_MAX_DEPTH = 5;

function findShallowestStashRoot(root: string): string | undefined {
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (queue.length > 0) {
    const item = queue.shift();
    if (!item) {
      continue;
    }
    const { dir: current, depth } = item;
    if (current !== root) {
      // .stash directory is a strong stash marker
      if (isDirectory(path.join(current, ".stash"))) {
        return current;
      }
      // Require 2+ type dirs for BFS candidates to avoid false positives.
      // A single "scripts/" is too common (skill dirs, npm packages, etc.).
      if (countStashDirs(current) >= 2) {
        return current;
      }
    }
    if (depth >= BFS_MAX_DEPTH) continue;
    let children: fs.Dirent[];
    try {
      children = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const child of children) {
      if (!child.isDirectory()) continue;
      if (child.name === ".git" || child.name === "node_modules") continue;
      queue.push({ dir: path.join(current, child.name), depth: depth + 1 });
    }
  }
  return undefined;
}

function normalizeInstalledEntry(entry: InstalledStashEntry): InstalledStashEntry {
  return {
    ...entry,
    stashRoot: path.resolve(entry.stashRoot),
    cacheDir: path.resolve(entry.cacheDir),
  };
}

function copyDirectoryContents(sourceDir: string, destinationDir: string): void {
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const src = path.join(sourceDir, entry.name);
    const dest = path.join(destinationDir, entry.name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (entry.isDirectory()) {
      fs.cpSync(src, dest, { recursive: true, force: true });
    } else {
      fs.copyFileSync(src, dest);
    }
  }
}

async function computeFileHash(filePath: string): Promise<string> {
  const data = fs.readFileSync(filePath);
  const hash = createHash("sha256").update(data).digest("hex");
  return `sha256:${hash}`;
}

function runInstallAuditOrThrow(
  rootDir: string,
  source: KitSource,
  ref: string,
  registryLabels: string[],
  config: AkmConfig,
  options?: InstallRegistryRefOptions,
) {
  const audit = auditInstallCandidate({
    rootDir,
    source,
    ref,
    registryLabels,
    config,
    trustThisInstall: options?.trustThisInstall,
  });
  if (audit.blocked) {
    throw new Error(formatInstallAuditFailure(ref, audit));
  }
  return audit;
}
