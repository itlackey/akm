import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { TYPE_DIRS } from "../../core/asset-spec";
import { fetchWithRetry } from "../../core/common";
import type { SourceSpec } from "../../core/config";
import { copyIncludedPaths, findNearestIncludeConfig } from "../source-include";

const REGISTRY_STASH_DIR_NAMES = new Set<string>(Object.values(TYPE_DIRS));

/** Strip terminal control characters from untrusted strings. */
export function sanitizeString(value: unknown, maxLength = 255): string {
  if (typeof value !== "string") return "";
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — strip control chars from untrusted remote data
  return value.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, maxLength);
}

/** Check whether a cached timestamp has exceeded its TTL. */
export function isExpired(mtimeMs: number, ttlMs: number): boolean {
  return Date.now() - mtimeMs > ttlMs;
}

/**
 * Find the directory inside `extractedDir` that should be treated as the
 * stash root. Looks for a `.stash` marker, then well-known type dirs, then
 * BFS for the shallowest such candidate.
 */
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

/**
 * Build a per-source cache directory under `cacheRootDir`.
 *
 * Versioned sources get `${source}-${id}/${version}` for cache reuse;
 * `local` sources get a unique timestamped slug so each install is isolated.
 */
export function buildInstallCacheDir(
  cacheRootDir: string,
  source: SourceSpec["type"],
  id: string,
  version?: string,
): string {
  const slug = `${source}-${id.replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "")}`;
  const versionSlug =
    source === "local"
      ? `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
      : (version?.replace(/[^a-zA-Z0-9_.-]+/g, "-") ?? `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
  return path.join(cacheRootDir, slug || source, versionSlug);
}

/**
 * Apply an `.akm-include` config (if any) by copying the selected paths
 * into a sibling `selected/` directory and returning that path. Returns
 * undefined when no include config is found.
 */
export function applyAkmIncludeConfig(
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

/** Stream a remote archive to disk using Bun.write when available. */
export async function downloadArchive(url: string, destination: string): Promise<void> {
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

/** SHA-256 of a file, returned as `sha256:<hex>`. */
export async function computeFileHash(filePath: string): Promise<string> {
  const data = fs.readFileSync(filePath);
  const hash = createHash("sha256").update(data).digest("hex");
  return `sha256:${hash}`;
}

/** Recursively copy directory contents, excluding `.git`. */
export function copyDirectoryContents(sourceDir: string, destinationDir: string): void {
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

export function isDirectory(target: string): boolean {
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
