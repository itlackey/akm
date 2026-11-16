// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import path from "node:path";
import { SCRATCH_DIR } from "../../core/asset/scratch";
import { getDirname } from "../../runtime";

const SKELETON_DIR = path.join(getDirname(import.meta.url), "../../assets/stash-skeleton");
const SCRATCH_README = path.join(getDirname(import.meta.url), "../../assets/scratch-readme.md");

/**
 * Copy the default stash skeleton into a stash directory.
 *
 * The skeleton tree under src/assets/stash-skeleton/ is mirrored **recursively**
 * into the stash root, preserving relative subpaths (e.g.
 * `facts/conventions/assets/skill.md` lands at the matching stash subpath).
 * Each file is written only if the destination does not already exist — existing
 * (possibly user-edited) files are never overwritten. Intermediate directories
 * are created as needed.
 *
 * Idempotent and absent-only: running it again on an existing stash backfills
 * any skeleton files that are missing without clobbering present ones. Non-fatal:
 * if the skeleton directory is missing or a copy fails the caller continues.
 */
export function copyStashSkeleton(stashDir: string): void {
  copySkeletonDir(SKELETON_DIR, stashDir);
}

/** Recursively mirror `srcDir` into `destDir`, writing files only when absent. */
function copySkeletonDir(srcDir: string, destDir: string): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(srcDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const src = path.join(srcDir, entry.name);
    const dest = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copySkeletonDir(src, dest);
      continue;
    }
    if (fs.existsSync(dest)) continue;
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
    } catch {
      // Non-fatal — stash is usable without skeleton files
    }
  }
}

/**
 * Scaffold the optional `.meta/index.md` orientation doc for the stash
 * `.meta/` convention. Written only when absent — an existing `.meta/index.md`
 * is never overwritten. Non-fatal: a stash works fine without it.
 *
 * `.meta/` is a dot-directory, so the indexer skips it; the template is
 * written here (rather than shipped under `src/assets/`) because the
 * build-time asset glob excludes dotfiles.
 */
export function scaffoldStashMeta(stashDir: string): void {
  const metaDir = path.join(stashDir, ".meta");
  const indexPath = path.join(metaDir, "index.md");
  if (fs.existsSync(indexPath)) return;
  try {
    fs.mkdirSync(metaDir, { recursive: true });
    fs.writeFileSync(indexPath, STASH_META_INDEX_TEMPLATE);
  } catch {
    // Non-fatal — stash is usable without the .meta orientation doc
  }
}

/**
 * Scaffold the bundle-root `.scratch/README.md`. Written only when absent; the
 * directory's other contents are never touched. The template lives outside
 * `stash-skeleton/` because the build-time asset glob excludes dot-directories.
 */
export function scaffoldScratch(stashDir: string): void {
  const readmePath = path.join(stashDir, SCRATCH_DIR, "README.md");
  if (fs.existsSync(readmePath)) return;
  try {
    fs.mkdirSync(path.dirname(readmePath), { recursive: true });
    fs.copyFileSync(SCRATCH_README, readmePath);
  } catch {
    // Non-fatal — the bundle is usable without the scratch scaffold.
  }
}

/** Add the root-scoped scratch ignore rule unless present. */
export function ensureScratchGitignore(stashDir: string): void {
  try {
    const gitignorePath = path.join(stashDir, ".gitignore");
    const existing = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, "utf8") : "";
    // `.scratch`, `/.scratch`, `.scratch/` and `/.scratch/` all already ignore the root directory.
    if (existing.split(/\r?\n/).some((line) => line.trim().replace(/^\/|\/$/g, "") === SCRATCH_DIR)) return;
    const gap = existing.length === 0 ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
    fs.writeFileSync(gitignorePath, `${existing}${gap}# Local scratch material\n${SCRATCH_GITIGNORE_RULE}\n`);
  } catch {
    // Non-fatal — the bundle is usable without the ignore scaffold.
  }
}

const SCRATCH_GITIGNORE_RULE = `/${SCRATCH_DIR}/`;

const STASH_META_INDEX_TEMPLATE = `---
# Optional, human-authored orientation for this stash. Not indexed; surfaced
# on demand via \`akm show meta\` (this file) or \`akm show <stash>//meta\`.
# Every field is optional — delete what you don't need.
purpose:
  - Describe what this stash is for.
entry_points:
  # Refs an agent should start from, e.g. skills/code-review, workflows/ship-release
conventions:
  # House rules an agent should follow when working in this stash.
maintainer:
---
# About this stash

Replace this with a short orientation for agents and humans: what lives here,
where to start, and the conventions to follow.

Extend the \`.meta/\` directory with more docs as needed — \`.meta/about.md\`,
\`.meta/conventions.md\`, \`.meta/license\` — and read any of them with
\`akm show meta:<name>\` (or \`akm show <stash>//meta:<name>\`).
`;
