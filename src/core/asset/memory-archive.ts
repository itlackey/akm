// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The memory-cleanup archive as a REF-RESOLUTION surface (#884).
 *
 * `analyzeMemoryCleanup`'s prune (`commands/improve/memory/memory-improve.ts`
 * `#archiveMemory`) does not delete a memory: it `rename`s the file under
 * `.akm/memory-cleanup/archive/<stamp>-<ref>/<originalPath>` and writes a
 * sibling `cleanup.md` audit asset carrying `ref` / `originalPath` /
 * `archivedPath`. The bytes and the identity both survive — but the ref stops
 * resolving at its ORIGINAL location, so every inbound belief edge
 * (`contradictedBy` / `supersededBy`) pointing at the pruned memory becomes a
 * `missing-ref` the moment #882 made those channels validatable.
 *
 * That is the #884 defect, and the archive already holds everything needed to
 * fix it: the audit record IS a tombstone. This module reads those tombstones
 * so ref resolution can answer "archived" instead of "missing". Resolution
 * stays non-destructive — pruning never rewrites an unrelated memory's
 * frontmatter, and the contradiction an edge records is preserved rather than
 * erased.
 *
 * A ref whose target has NO tombstone and no file is genuinely dangling — it
 * was removed by something other than prune (a hand `git rm`, an older
 * release). Those stay reported; clearing them mutates user data and so is
 * gated behind `akm lint --prune-dangling-edges`.
 */

import fs from "node:fs";
import path from "node:path";
import { parseFrontmatter } from "./frontmatter";

/** Stash-relative root the prune path archives into. Must match `memory-improve.ts#createArchiveDir`. */
export const MEMORY_ARCHIVE_REL = ".akm/memory-cleanup/archive";

/** Filename of the per-archive audit asset written alongside the archived memory. */
const AUDIT_FILENAME = "cleanup.md";

/**
 * Cache keyed by stash root. A lint sweep resolves thousands of refs against a
 * directory that only the prune path ever writes, so the scan runs once per
 * root instead of once per missing ref.
 */
const cache = new Map<string, Set<string>>();

/** @internal Drop the memoized scans — process-global state needs a reset seam for tests (#785). */
export function resetMemoryArchiveCache(): void {
  cache.clear();
}

/**
 * Every stash-relative `originalPath` archived under `root`, i.e. the set of
 * paths that USED to hold a memory and now hold a tombstone instead.
 *
 * Unreadable or malformed audit records are skipped rather than thrown: a
 * corrupt tombstone must degrade to "this ref is missing" (the pre-#884
 * answer), never break the whole lint sweep.
 */
export function archivedOriginalPaths(root: string): Set<string> {
  const cached = cache.get(root);
  if (cached !== undefined) return cached;

  const paths = new Set<string>();
  const archiveRoot = path.join(root, MEMORY_ARCHIVE_REL);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(archiveRoot, { withFileTypes: true });
  } catch {
    cache.set(root, paths); // no archive dir — nothing was ever pruned here
    return paths;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    let raw: string;
    try {
      raw = fs.readFileSync(path.join(archiveRoot, entry.name, AUDIT_FILENAME), "utf8");
    } catch {
      continue;
    }
    let originalPath: unknown;
    try {
      originalPath = parseFrontmatter(raw).data.originalPath;
    } catch {
      continue;
    }
    if (typeof originalPath === "string" && originalPath.trim().length > 0) {
      paths.add(originalPath.trim().replace(/\\/g, "/"));
    }
  }

  cache.set(root, paths);
  return paths;
}

/**
 * True when `relPath` (stash-relative, POSIX) names a memory that prune
 * archived — the ref resolves to a tombstone rather than to nothing.
 */
export function isArchivedRelPath(relPath: string, root: string): boolean {
  return archivedOriginalPaths(root).has(relPath.replace(/\\/g, "/"));
}
