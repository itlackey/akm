// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Legacy `.stash.json` sidecar read/write — the pre-0.9.0 per-directory metadata
 * layout. This is 0.8-compat behavior that real stashes still depend on: the
 * indexer merges a directory's sidecar overrides onto the freshly-recognized
 * entries so curated metadata (captured openings, quality, descriptions) is not
 * lost on re-index.
 *
 * MIGRATOR-OWNED HOME (akm 0.9.0 Chunk-5 flip, scope-B ruling): the sidecar
 * layout is a pre-0.9 on-disk shape, so its reader/writer live here under
 * `src/migrate/` alongside the other legacy-layout code rather than in the live
 * indexer passes. The indexer imports {@link readLegacyStashOverrides} from here
 * with a `// Chunk-8: dies with the content migration` note — Chunk 8's content
 * migration folds the sidecar into the bundle format and retires this module.
 *
 * The `StashFile` container type and the per-entry `validateStashEntry` gate stay
 * in `indexer/passes/metadata.ts` (they are the live in-memory metadata shape and
 * the shared validator); this module imports them.
 */

import fs from "node:fs";
import path from "node:path";
import type { IndexDocument } from "../core/adapter/types";
import { writeFileAtomic } from "../core/common";
import { warn } from "../core/warn";
import { type StashFile, validateStashEntry } from "../indexer/passes/metadata";

/** The pre-0.9.0 per-directory metadata sidecar filename. */
const LEGACY_STASH_FILENAME = ".stash.json";

export interface LegacyStashOptions {
  requireFilename?: boolean;
}

/** Absolute path of a directory's legacy metadata sidecar. */
export function legacyStashFilePath(dirPath: string): string {
  return path.join(dirPath, LEGACY_STASH_FILENAME);
}

/**
 * Read a directory's legacy metadata sidecar and return its validated entries,
 * or `null` when absent/empty/corrupt. Was `loadStashFile` in `metadata.ts`;
 * relocated verbatim to the migrator home (scope-B ruling) — behavior unchanged.
 */
export function readLegacyStashOverrides(dirPath: string, options?: LegacyStashOptions): StashFile | null {
  const filePath = legacyStashFilePath(dirPath);
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!raw || !Array.isArray(raw.entries)) return null;
    const entries: IndexDocument[] = [];
    for (const e of raw.entries) {
      const validated = validateStashEntry(e);
      if (validated) {
        if (options?.requireFilename && !validated.filename) continue;
        entries.push(validated);
      } else {
        const name =
          typeof e === "object" && e !== null && typeof (e as Record<string, unknown>).name === "string"
            ? (e as Record<string, unknown>).name
            : "(unknown)";
        warn(`Warning: Skipping invalid entry "${name}" in ${filePath}`);
      }
    }
    return entries.length > 0 ? { entries } : null;
  } catch {
    return null;
  }
}

/** Write a legacy metadata sidecar (test/migrator fixtures). Was `writeStashFile`. */
export function writeLegacyStashFile(dirPath: string, stash: StashFile): void {
  const filePath = legacyStashFilePath(dirPath);
  writeFileAtomic(filePath, `${JSON.stringify(stash, null, 2)}\n`);
}
