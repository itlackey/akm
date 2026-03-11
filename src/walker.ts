/**
 * Shared filesystem walker for akm stash directories.
 *
 * Provides a single implementation used by both the search fallback
 * (stash.ts) and the indexer (indexer.ts) to walk type-specific asset
 * directories and group files by parent directory.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { isRelevantAssetFile } from "./asset-spec";
import type { AgentikitAssetType } from "./common";
import { buildFileContext, type FileContext } from "./file-context";

export interface DirectoryGroup {
  dirPath: string;
  files: string[];
}

/**
 * Walk a type root directory and return files grouped by their parent directory.
 *
 * Only files relevant to the given `assetType` are included (e.g. `.md` for
 * commands, script extensions for tools, `SKILL.md` for skills).
 */
export function walkStash(typeRoot: string, assetType: AgentikitAssetType): DirectoryGroup[] {
  if (!fs.existsSync(typeRoot)) return [];

  const groups = new Map<string, string[]>();

  const stack = [typeRoot];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".stash.json") continue;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && isRelevantAssetFile(assetType, entry.name)) {
        const parentDir = path.dirname(fullPath);
        const existing = groups.get(parentDir);
        if (existing) {
          existing.push(fullPath);
        } else {
          groups.set(parentDir, [fullPath]);
        }
      }
    }
  }

  return Array.from(groups, ([dirPath, files]) => ({ dirPath, files }));
}

/**
 * Walk an entire stash root directory and return FileContext objects for every
 * regular file found.
 *
 * Unlike walkStash(), this does NOT filter by asset type or require files to
 * live under type-specific directories. Matchers decide what each file is.
 *
 * If the directory is a git repo, uses `git ls-files` to respect .gitignore.
 * Otherwise falls back to a manual walk that skips .git, node_modules, bin,
 * .cache, dot-directories, and .stash.json files.
 */
export function walkStashFlat(stashRoot: string): FileContext[] {
  if (!fs.existsSync(stashRoot)) return [];

  // Try git-based walk first (respects .gitignore)
  const gitResult = walkStashGit(stashRoot);
  if (gitResult) return gitResult;

  // Fallback: manual walk
  return walkStashManual(stashRoot);
}

/**
 * Walk using `git ls-files` to respect .gitignore.
 * Returns null if the directory is not a git repo or git fails.
 */
function walkStashGit(stashRoot: string): FileContext[] | null {
  // Quick check: is this a git repo? Look for .git in this dir or parents.
  if (!isInsideGitRepo(stashRoot)) return null;

  // Get tracked + untracked (non-ignored) files
  const result = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", "."], {
    cwd: stashRoot,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 10 * 1024 * 1024, // 10MB
  });
  if (result.status !== 0) return null;

  const SKIP_DIRS = new Set([".git", "node_modules", "bin", ".cache"]);
  const SKIP_FILES = new Set([".stash.json", ".gitignore", ".gitattributes"]);

  const files = result.stdout
    .split("\0")
    .filter((f) => f.length > 0)
    .filter((f) => !f.startsWith("..") && !path.isAbsolute(f))
    .filter((f) => {
      const dirParts = path
        .dirname(f)
        .split(/[\\/]+/)
        .filter(Boolean);
      return !dirParts.some((part) => SKIP_DIRS.has(part) || part.startsWith("."));
    })
    .filter((f) => !SKIP_FILES.has(path.basename(f)))
    .filter((f) => !f.includes("/.") && !f.startsWith(".")); // skip dot-dirs/files

  const results: FileContext[] = [];
  for (const relFile of files) {
    const absPath = path.join(stashRoot, relFile);
    try {
      if (fs.statSync(absPath).isFile()) {
        results.push(buildFileContext(stashRoot, absPath));
      }
    } catch {
      // File may have been deleted since git ls-files ran
    }
  }

  return results;
}

/** Check if a directory is inside a git repository by walking up to find .git. */
function isInsideGitRepo(dir: string): boolean {
  let current = path.resolve(dir);
  const root = path.parse(current).root;
  while (current !== root) {
    try {
      const gitDir = path.join(current, ".git");
      const stat = fs.statSync(gitDir);
      if (stat.isDirectory() || stat.isFile()) return true;
    } catch {
      // .git doesn't exist at this level, keep climbing
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return false;
}

/** Manual walk for non-git directories. */
function walkStashManual(stashRoot: string): FileContext[] {
  const results: FileContext[] = [];
  const SKIP_DIRS = new Set([".git", "node_modules", "bin", ".cache"]);

  const stack = [stashRoot];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".stash.json") continue;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        stack.push(fullPath);
      } else if (entry.isFile()) {
        results.push(buildFileContext(stashRoot, fullPath));
      }
    }
  }

  return results;
}
