// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Shared filesystem walker for akm stash directories.
 *
 * Provides a single implementation used by both the search fallback
 * (stash.ts) and the indexer (indexer.ts) to walk type-specific asset
 * directories and group files by parent directory.
 */

import fs from "node:fs";
import path from "node:path";
import { isRelevantAssetFile } from "../../core/asset/asset-placement";
import { WORKFLOW_EXTENSIONS } from "../../core/recognition-util";
import { spawnSync } from "../../runtime";
import { buildFileContext, type FileContext } from "./file-context";

const ALWAYS_SKIP_DIRS = new Set([".git"]);
const AKM_SKIP_DIRS = new Set(["node_modules", "bin", ".cache"]);

export interface WalkStashFlatOptions {
  /** Let the owning adapter see every directory except VCS internals. */
  includeAllDirectories?: boolean;
  /** Include workflow-file symlinks for the named native adapter without following symlink directories. */
  workflowSymlinkAdapter?: "akm" | "akm-workflow";
}

export interface WalkStashFlatResult {
  files: FileContext[];
  /** False when any directory or candidate file could not be inspected. */
  complete: boolean;
}

export interface DirectoryGroup {
  dirPath: string;
  files: string[];
}

/**
 * Walk a type root directory and return files grouped by their parent directory.
 *
 * Only files relevant to the given `assetType` are included (e.g. `.md` for
 * commands, script extensions for scripts, `SKILL.md` for skills).
 */
export function walkStash(typeRoot: string, assetType: string): DirectoryGroup[] {
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
 * .cache, dot-directories, and the legacy metadata sidecar.
 */
export function walkStashFlat(stashRoot: string, options: WalkStashFlatOptions = {}): FileContext[] {
  return walkStashFlatWithStatus(stashRoot, options).files;
}

export function walkStashFlatWithStatus(stashRoot: string, options: WalkStashFlatOptions = {}): WalkStashFlatResult {
  if (!fs.existsSync(stashRoot)) return { files: [], complete: false };

  // Try git-based walk first (respects .gitignore)
  const gitResult = walkStashGit(stashRoot, options);
  if (gitResult) return gitResult;

  // Fallback: manual walk
  return walkStashManual(stashRoot, options);
}

/**
 * Walk using `git ls-files` to respect .gitignore.
 * Returns null if the directory is not a git repo or git fails.
 */
function walkStashGit(stashRoot: string, options: WalkStashFlatOptions): WalkStashFlatResult | null {
  // Quick check: is this a git repo? Look for .git in this dir or parents.
  if (!isInsideGitRepo(stashRoot)) return null;

  // Get tracked + untracked (non-ignored) files
  const result = spawnSync(["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", "."], {
    cwd: stashRoot,
  });
  // result.success is false if the process exited non-zero OR git was not found
  if (!result.success) return null;

  // `--cached` includes tracked files deleted from the worktree. They are not
  // scan failures and must not make an otherwise complete snapshot look stale.
  const deletedResult = spawnSync(["git", "ls-files", "--deleted", "-z", "--", "."], { cwd: stashRoot });
  if (!deletedResult.success) return null;
  const deletedStdout = Buffer.isBuffer(deletedResult.stdout)
    ? deletedResult.stdout.toString("utf8")
    : String(deletedResult.stdout ?? "");
  const deletedFiles = new Set(deletedStdout.split("\0").filter(Boolean));

  // Data-hygiene filename skips: the legacy metadata sidecar (never indexed as
  // content — Chunk-8 folds it into the bundle format) plus git dot-files.
  const SKIP_FILES = new Set([".stash.json", ".gitignore", ".gitattributes"]);

  const stdout = Buffer.isBuffer(result.stdout) ? result.stdout.toString("utf8") : String(result.stdout ?? "");
  const files = stdout
    .split("\0")
    .filter((f) => f.length > 0)
    .filter((f) => !deletedFiles.has(f))
    .filter((f) => !f.startsWith("..") && !path.isAbsolute(f))
    .filter((f) => {
      const dirParts = path
        .dirname(f)
        .split(/[\\/]+/)
        .filter(Boolean);
      return !dirParts.some(
        (part) =>
          ALWAYS_SKIP_DIRS.has(part) ||
          (!options.includeAllDirectories && (AKM_SKIP_DIRS.has(part) || part.startsWith("."))),
      );
    })
    .filter((f) => !SKIP_FILES.has(path.basename(f)));

  const results: FileContext[] = [];
  let complete = true;
  for (const relFile of files) {
    const absPath = path.join(stashRoot, relFile);
    try {
      // lstat, not stat: a tracked symlink must not be dereferenced. statSync
      // follows the link, so a target outside stashRoot would be read and
      // indexed. The manual walk below already skips symlinks for exactly this
      // reason; the two walkers have to agree regardless of whether the stash
      // happens to sit inside a git repo.
      const stat = fs.lstatSync(absPath);
      if (stat.isFile() || (stat.isSymbolicLink() && isOwnedWorkflowSymlink(stashRoot, absPath, options))) {
        results.push(buildFileContext(stashRoot, absPath));
      }
    } catch {
      // File may have been deleted since git ls-files ran
      complete = false;
    }
  }

  return { files: results, complete };
}

/**
 * Check if a directory is inside a git repository by walking up to find .git.
 * Intentionally walks above stashRoot so that parent repo .gitignore rules
 * apply when the stash is nested inside a larger git repository.
 */
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

export interface WalkMarkdownFilesResult {
  files: string[];
  /** False when any directory under `root` could not be read (e.g. permission errors). */
  complete: boolean;
}

/**
 * Recursively collect every `.md` file under `root`.
 *
 * Used by memory-inference. Mirrors the `complete` tracking of the other
 * walkers in this file: a directory that cannot be read makes the result
 * incomplete instead of silently looking like a clean, empty scan.
 */
export function walkMarkdownFiles(root: string): WalkMarkdownFilesResult {
  const files: string[] = [];
  let complete = true;
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      complete = false;
      continue;
    }

    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        files.push(full);
      }
    }
  }
  return { files, complete };
}

/** Manual walk for non-git directories. */
function walkStashManual(stashRoot: string, options: WalkStashFlatOptions): WalkStashFlatResult {
  const results: FileContext[] = [];
  let complete = true;

  const stack = [stashRoot];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      complete = false;
      continue;
    }
    for (const entry of entries) {
      if (entry.name === ".stash.json") continue;
      const fullPath = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        // Native workflow components arbitrate file symlinks explicitly in the
        // drain before reading them. Directory symlinks remain unfollowed.
        if (isOwnedWorkflowSymlink(stashRoot, fullPath, options)) {
          results.push(buildFileContext(stashRoot, fullPath));
        }
        continue;
      }
      if (entry.isDirectory()) {
        if (
          ALWAYS_SKIP_DIRS.has(entry.name) ||
          (!options.includeAllDirectories && (AKM_SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")))
        )
          continue;
        stack.push(fullPath);
      } else if (entry.isFile()) {
        results.push(buildFileContext(stashRoot, fullPath));
      }
    }
  }

  return { files: results, complete };
}

function isOwnedWorkflowSymlink(stashRoot: string, candidatePath: string, options: WalkStashFlatOptions): boolean {
  const adapterId = options.workflowSymlinkAdapter;
  if (!adapterId) return false;
  const relativePath = path.relative(path.resolve(stashRoot), path.resolve(candidatePath)).replaceAll("\\", "/");
  if (!relativePath || relativePath.startsWith("../") || path.posix.isAbsolute(relativePath)) return false;
  if (adapterId === "akm" && !relativePath.startsWith("workflows/")) return false;
  const extension = path.posix.extname(relativePath).toLowerCase();
  return (WORKFLOW_EXTENSIONS as readonly string[]).includes(extension);
}
