// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `memory-cleanup-archive` advisory for `akm health` (item 4, 0.9.17-alpha.9
 * plan §5.4/§8 step 8).
 *
 * Reports the archive's size and file count for every bundle, git-backed or
 * not. A bundle with no `.git` of its own keeps every retirement's archived
 * bytes forever (the purge sweep never runs there at all), so that alone is
 * reported. A git-backed bundle can ALSO have bytes the purge sweep will
 * never remove: `.git` presence alone does not prove a retirement was ever
 * committed (`proposal accept` only commits for a `kind: "git"` write
 * target, and a `kind: "filesystem"` bundle that merely happens to have a
 * `.git` directory never gets one) — those bytes sit there indefinitely,
 * however old they get, with nothing else to say so. This checks the SAME
 * git state `purgeGracedArchive` checks (tracked, clean, verifiable) and
 * reports how much of the archive fails it.
 *
 * Silent whenever there is nothing to say: the archive does not exist or is
 * empty, or (for a git-backed bundle) every byte in it is purgeable once it
 * ages out.
 */

import fs from "node:fs";
import path from "node:path";
import { MEMORY_ARCHIVE_REL } from "../../core/asset/memory-archive";
import { toPosix } from "../../core/common";
import { checkGitPathSafety, isGitBackedStash } from "../../sources/providers/git-stash";
import { MAX_WALK_ENTRIES, sizeOfPath } from "./data-dir-usage";
import type { HealthCheckResult } from "./types";

/**
 * Build the `memory-cleanup-archive` advisory, or `undefined` when there is
 * nothing to report.
 */
export function collectArchiveUsageAdvisory(stashDir: string): HealthCheckResult | undefined {
  const archiveRoot = path.join(stashDir, MEMORY_ARCHIVE_REL);
  if (!fs.existsSync(archiveRoot)) return undefined;

  if (!isGitBackedStash(stashDir)) {
    const usage = sizeOfPath(archiveRoot, { remaining: MAX_WALK_ENTRIES });
    if (usage.files === 0) return undefined;
    const lowerBound = usage.truncated ? ` (a lower bound — the walk stopped after ${MAX_WALK_ENTRIES} entries)` : "";
    return {
      name: "memory-cleanup-archive",
      kind: "deterministic",
      status: "pass",
      confidence: "high",
      message:
        `${usage.files} archived file(s), ${usage.bytes} byte(s)${lowerBound} in .akm/memory-cleanup/archive — ` +
        "this bundle has no git history, so the purge sweep leaves it untouched.",
      evidence: { files: usage.files, bytes: usage.bytes, truncated: usage.truncated },
    };
  }

  // Git-backed: the SAME three checks purgeGracedArchive runs (B1, G10) —
  // computed once here, not per file, and reused via `onFile` below instead
  // of a second walk of the same tree. A failed git check here fails the
  // same way purgeGracedArchive's own sweep would: nothing in the archive
  // can be proven purgeable, so every byte counts as unpurgeable rather
  // than guessing (`checkGitPathSafety`'s `isSafe` is always `false` when
  // `ok` is `false`).
  const gitSafety = checkGitPathSafety(stashDir, MEMORY_ARCHIVE_REL);

  let unpurgeableFiles = 0;
  let unpurgeableBytes = 0;
  const usage = sizeOfPath(archiveRoot, { remaining: MAX_WALK_ENTRIES }, (filePath, bytes) => {
    const key = toPosix(path.relative(stashDir, filePath));
    if (!gitSafety.isSafe(key)) {
      unpurgeableFiles++;
      unpurgeableBytes += bytes;
    }
  });
  if (usage.files === 0) return undefined;
  if (unpurgeableFiles === 0) return undefined; // everything here is purgeable once it ages out — nothing to say

  const lowerBound = usage.truncated ? ` (a lower bound — the walk stopped after ${MAX_WALK_ENTRIES} entries)` : "";
  return {
    name: "memory-cleanup-archive",
    kind: "deterministic",
    status: "warn",
    confidence: "high",
    message:
      `${usage.files} archived file(s), ${usage.bytes} byte(s)${lowerBound} in .akm/memory-cleanup/archive; ` +
      `${unpurgeableFiles} file(s), ${unpurgeableBytes} byte(s) of that cannot be purged (untracked, modified, ` +
      "or unverifiable in git) — commit them so the purge sweep can remove them once they age out.",
    evidence: {
      files: usage.files,
      bytes: usage.bytes,
      truncated: usage.truncated,
      unpurgeableFiles,
      unpurgeableBytes,
      gitStateKnown: gitSafety.ok,
    },
  };
}
