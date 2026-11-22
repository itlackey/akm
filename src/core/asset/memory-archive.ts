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
 * erased (the concern #884 raised against a bare edge-scrub).
 *
 * A ref whose target has NO tombstone and no file is genuinely dangling — it
 * was removed by something other than prune (a hand `git rm`, an older
 * release). Those stay reported; clearing them mutates user data and so is
 * gated behind `akm lint --prune-dangling-edges`.
 */

import { archivedOriginalPaths, MEMORY_ARCHIVE_REL, resetArchiveCache } from "../adapter/directory-archive";

export { archivedOriginalPaths, MEMORY_ARCHIVE_REL };

/** @internal Drop the memoized scans — process-global state needs a reset seam for tests (#785). */
export function resetMemoryArchiveCache(): void {
  resetArchiveCache();
}

/**
 * True when `relPath` (stash-relative, POSIX) names a memory that prune
 * archived — the ref resolves to a tombstone rather than to nothing.
 */
export function isArchivedRelPath(relPath: string, root: string): boolean {
  return archivedOriginalPaths(root).has(relPath.replace(/\\/g, "/"));
}
