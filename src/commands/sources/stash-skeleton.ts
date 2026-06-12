// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import path from "node:path";
import { getDirname } from "../../runtime";

const SKELETON_DIR = path.join(getDirname(import.meta.url), "../../assets/stash-skeleton");

/**
 * Copy the default stash skeleton into a newly created stash directory.
 *
 * Each file in src/assets/stash-skeleton/ is written to the stash root only
 * if the destination does not already exist — existing files are never
 * overwritten. Non-fatal: if the skeleton directory is missing or a copy
 * fails the caller continues normally.
 */
export function copyStashSkeleton(stashDir: string): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(SKELETON_DIR);
  } catch {
    return;
  }

  for (const entry of entries) {
    const src = path.join(SKELETON_DIR, entry);
    const dest = path.join(stashDir, entry);
    if (fs.existsSync(dest)) continue;
    try {
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

const STASH_META_INDEX_TEMPLATE = `---
# Optional, human-authored orientation for this stash. Not indexed; surfaced
# on demand via \`akm show meta\` (this file) or \`akm show <stash>//meta\`.
# Every field is optional — delete what you don't need.
purpose:
  - Describe what this stash is for.
entry_points:
  # Refs an agent should start from, e.g. skill:code-review, workflow:ship-release
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
