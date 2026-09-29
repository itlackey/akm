// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `memory-cleanup-archive` advisory for `akm health` (item 4, 0.9.17-alpha.9
 * plan §5.4/§8 step 8).
 *
 * The purge sweep only ever runs on a git-backed bundle (git history is what
 * makes deleting the archived bytes recoverable — D27). A bundle with no
 * `.git` of its own keeps every retirement's archived bytes forever, so its
 * size and file count are reported here instead — nothing more; there is no
 * purge command for a bundle this check fires on.
 *
 * Silent whenever there is nothing to say: the bundle is git-backed (the
 * purge sweep already covers it), or the archive does not exist or is empty.
 */

import fs from "node:fs";
import path from "node:path";
import { MEMORY_ARCHIVE_REL } from "../../core/asset/memory-archive";
import { isGitBackedStash } from "../../sources/providers/git-stash";
import type { HealthCheckResult } from "./types";

interface ArchiveUsage {
  bytes: number;
  files: number;
}

/** Best-effort recursive size/count walk; an unreadable entry just does not add to the totals. */
function walk(target: string): ArchiveUsage {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(target);
  } catch {
    return { bytes: 0, files: 0 };
  }
  if (!stat.isDirectory()) return stat.isFile() ? { bytes: stat.size, files: 1 } : { bytes: 0, files: 0 };
  let children: string[];
  try {
    children = fs.readdirSync(target);
  } catch {
    return { bytes: 0, files: 0 };
  }
  let usage: ArchiveUsage = { bytes: 0, files: 0 };
  for (const child of children) {
    const sub = walk(path.join(target, child));
    usage = { bytes: usage.bytes + sub.bytes, files: usage.files + sub.files };
  }
  return usage;
}

/**
 * Build the `memory-cleanup-archive` advisory, or `undefined` when there is
 * nothing to report.
 */
export function collectArchiveUsageAdvisory(stashDir: string): HealthCheckResult | undefined {
  if (isGitBackedStash(stashDir)) return undefined; // the purge sweep already covers it
  const archiveRoot = path.join(stashDir, MEMORY_ARCHIVE_REL);
  if (!fs.existsSync(archiveRoot)) return undefined;
  const usage = walk(archiveRoot);
  if (usage.files === 0) return undefined;
  return {
    name: "memory-cleanup-archive",
    kind: "deterministic",
    status: "pass",
    confidence: "high",
    message:
      `${usage.files} archived file(s), ${usage.bytes} byte(s) in .akm/memory-cleanup/archive — ` +
      "this bundle has no git history, so the purge sweep leaves it untouched.",
    evidence: { files: usage.files, bytes: usage.bytes },
  };
}
