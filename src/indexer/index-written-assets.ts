// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Write-path indexing: targeted single-file index updates for asset writers.
 *
 * The index is maintained eagerly by every first-class mutation command
 * (`source add`, `wiki`, `workflow`, `setup` all run `akmIndex()` after
 * writing). The memory write paths — `akm remember` / `writeMarkdownAsset`
 * and extract's session assets — historically did not, which is why reads
 * used to compensate with stale-triggered background reindexes (the
 * lock-contention footgun removed alongside this module's introduction; see
 * docs/design/read-path-reindex-contention-findings.md §7).
 *
 * This is NOT a general reindex. It upserts exactly the files the caller just
 * wrote: frontmatter/metadata via the shared matcher pipeline, the `entries`
 * row, and an incremental FTS refresh. Embeddings, index-time LLM passes,
 * graph extraction, `builtAt`, and the per-dir walk cache are all deliberately
 * untouched — the next full run heals them (the opportunistic-recovery
 * strategy of docs/technical/index-consistency-adr.md).
 */

import fs from "node:fs";
import path from "node:path";
import { getDbPath } from "../core/paths";
import { warnVerbose } from "../core/warn";
import { takeWorkflowDocument } from "../workflows/runtime/document-cache";
import {
  closeDatabase,
  getEntryCount,
  openExistingDatabase,
  rebuildFts,
  upsertEntry,
  upsertWorkflowDocument,
} from "./db/db";
import { generateMetadataFlat } from "./passes/metadata";
import { buildSearchText } from "./search/search-fields";

/**
 * Busy-timeout (ms) for write-path index upserts. A real write — unlike the
 * 250ms telemetry inserts — but it must not hang `akm remember` for the full
 * default 30s behind a running full reindex. When it times out, the upsert is
 * skipped and the asset becomes searchable after that reindex instead.
 */
export const WRITE_PATH_INDEX_BUSY_TIMEOUT_MS = 5_000;

/**
 * Index the given just-written asset files into the existing local index.
 *
 * FAIL-OPEN at every step: any error (index.db absent, empty, locked past the
 * busy timeout, unparseable file) is reduced to a verbose-only warning and the
 * write command succeeds untouched. The degraded outcome is exactly the
 * pre-write-path-indexing behavior: the asset appears after the next full
 * `akm index` / improve-cron run.
 *
 * An absent or empty index is skipped on purpose — bootstrap belongs to the
 * first read (`ensureIndex`) or an explicit `akm index`, which also cover
 * embeddings and the other passes this fast path skips.
 */
export async function indexWrittenAssets(stashDir: string, filePaths: string[]): Promise<void> {
  try {
    const dbPath = getDbPath();
    if (!fs.existsSync(dbPath)) return;

    // The full walk never descends into dot-directories (they hold state like
    // `.meta/`, `.stash.json`), and `shouldIndexStashFile` relies on the walker
    // for that — mirror it here so this fast path indexes exactly what a full
    // run would.
    const files = filePaths.filter((f) => {
      if (!fs.existsSync(f)) return false;
      const rel = path.relative(stashDir, f);
      return !rel.split(/[\\/]+/).some((segment) => segment.startsWith("."));
    });
    if (files.length === 0) return;

    // Generate metadata BEFORE opening the DB so the write window stays
    // short. One call per file keeps the entry↔path pairing exact.
    const pairs: Array<{ file: string; entry: Awaited<ReturnType<typeof generateMetadataFlat>>["entries"][number] }> =
      [];
    for (const file of files) {
      const generated = await generateMetadataFlat(stashDir, [file]);
      const entry = generated.entries[0];
      // Workflows also carry a workflow_documents side-table upsert — handled
      // below, mirroring the full walk — since `akm mv` rewrites citer files
      // that can be workflows.
      if (entry) pairs.push({ file, entry });
    }
    if (pairs.length === 0) return;

    const db = openExistingDatabase(dbPath);
    try {
      db.exec(`PRAGMA busy_timeout = ${WRITE_PATH_INDEX_BUSY_TIMEOUT_MS}`);
      if (getEntryCount(db) === 0) return;
      for (const { file, entry } of pairs) {
        const entryKey = `${stashDir}:${entry.type}:${entry.name}`;
        let entryWithSize = entry;
        try {
          entryWithSize = { ...entry, fileSize: fs.statSync(file).size };
        } catch {
          // stat raced a delete — index without the size, like the full walk does.
        }
        const entryId = upsertEntry(db, entryKey, path.dirname(file), file, stashDir, entryWithSize, buildSearchText(entry));
        if (entry.type === "workflow") {
          // Same contract as the full walk (indexer.ts): the renderer cached
          // the parsed document during metadata generation; persist it so the
          // workflow runtime never sees an entry without its document.
          const doc = takeWorkflowDocument(entry);
          if (doc) upsertWorkflowDocument(db, entryId, doc, fs.readFileSync(file));
        }
      }
      rebuildFts(db, { incremental: true });
    } finally {
      closeDatabase(db);
    }
  } catch (error) {
    warnVerbose(
      "Write-path index update skipped (asset appears after the next full index):",
      error instanceof Error ? error.message : String(error),
    );
  }
}
