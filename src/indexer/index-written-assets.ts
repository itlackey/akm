// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Write-path indexing: targeted single-file index updates for asset writers.
 *
 * Writers index what they write; reads never walk. Mutation commands (`source add`, `bundle update`, ...)
 * build the index after writing, and the memory write paths (`akm remember`, extract's session assets)
 * call this instead.
 *
 * This is NOT a general reindex. It upserts exactly the files the caller just
 * wrote: frontmatter/metadata via the shared matcher pipeline, the canonical
 * row with its transactionally owned FTS projection, and vectors for changed
 * entry IDs when semantic search is enabled. `builtAt` and the per-dir walk
 * cache remain full-index responsibilities.
 */

import fs from "node:fs";
import path from "node:path";
import { akmAdapter } from "../core/adapter/adapters/akm-adapter";
import { loadConfig } from "../core/config/config";
import { isDataDirUnreadableError, TransientError } from "../core/errors";
import { isPathAbsent } from "../core/path-access";
import { getDbPath } from "../core/paths";
import { warn, warnVerbose } from "../core/warn";
import { closeDatabase } from "../storage/repositories/index-connection";
import { deleteEntriesByIds, upsertEntry } from "../storage/repositories/index-entries-repository";
import { isSqliteContentionError } from "../storage/sqlite-transaction";
import { openUsableIndex } from "./index-readiness";
import { deriveEntryProvenance, deriveInstallations } from "./installations";
import { embeddingInputCap, generateEmbeddingsForDb, publishTargetedEmbeddingMeta } from "./materialize-embeddings";
import { type IndexDocument, withFileSize } from "./passes/metadata";
import { drainDirDocuments } from "./scan/drain-dir";
import { buildFileContext } from "./walk/file-context";
import { walkedFiles } from "./walk/walker";

/**
 * Busy-timeout (ms) for write-path index upserts. A real write — unlike the
 * 250ms telemetry inserts — but it must not hang `akm remember` for the full
 * default 30s behind a running build. When it times out, the upsert is
 * skipped and the asset becomes searchable after the next build instead.
 */
export const WRITE_PATH_INDEX_BUSY_TIMEOUT_MS = 5_000;

/**
 * Index the given just-written asset files into the existing local index.
 *
 * FAIL-OPEN at every step: any error (index.db absent, locked past the busy timeout, unparseable file) is
 * reduced to a verbose-only warning and the write command succeeds untouched. A write the index misses is
 * picked up by the next build. Returns `true` when the index is busy (a build holds the write lock past the
 * busy timeout, or the embedding step reports contention): the file is on disk and the next build indexes it,
 * so the write is not reported as unindexed. `false` is for an index akm may not read and for genuine errors.
 *
 * Upserts whenever a usable index exists for the library (`index-readiness.ts`):
 * persisted keyword data, whether or not a build has completed. An absent or
 * unusable index is skipped on purpose — building one is `akm index`'s job, and
 * it also covers the embeddings and other passes this fast path skips.
 *
 * A write that lands while a build runs is not a failure and does not look for
 * the build: the upsert goes in on the 5 s busy timeout, or is skipped (still
 * `true`) when the build holds the write lock longer, and the next build picks
 * the change up from the directory fingerprints it takes. Callers that gate
 * their own success on this boolean (`acceptProposal`, `source clone`) never
 * fail or warn just because a build is in progress.
 */
export async function indexWrittenAssets(
  stashDir: string,
  filePaths: string[],
  options: {
    /** Configured stable identity for a managed source. */
    bundleId?: string;
  } = {},
): Promise<boolean> {
  try {
    const dbPath = getDbPath();
    // `true` means "nothing more to do here": the files are indexed, or there is no usable index to update
    // (absent, unusable, built for another library) and the next build indexes them. An index akm may not
    // read is the exception: `openUsableIndex` raises and the catch below reports `false` (#791).
    if (isPathAbsent(dbPath)) return true;

    // Index exactly what a full walk would list: skipped and ignored directories, sidecar files and the like stay out.
    const files = walkedFiles(stashDir, filePaths);
    if (files.length === 0) return true;

    // Generate metadata BEFORE opening the DB so the write window stays
    // short. One drain call per file keeps the entry↔path pairing exact and
    // reuses the full-index recognize engine (F4a M-core-2 item 5): broken
    // workflows drop, valid workflow docs are cached for the side-table upsert.
    const component = deriveInstallations([
      { path: stashDir, writable: true, ...(options.bundleId ? { registryId: options.bundleId } : {}) },
    ])[0]?.components[0];
    if (!component) throw new Error(`Could not derive bundle provenance for ${stashDir}`);
    const pairs: Array<{ file: string; entry: IndexDocument; conceptId: string; contentHash?: string }> = [];
    const unindexable = new Set<string>();
    const rejectedConceptIds = new Set<string>();
    for (const file of files) {
      if (!fs.existsSync(file)) {
        let authoredDanglingSymlink = false;
        try {
          authoredDanglingSymlink = fs.lstatSync(file).isSymbolicLink();
        } catch {
          // A genuinely absent path has no source identity to preflight.
        }
        if (!authoredDanglingSymlink) {
          unindexable.add(file);
          continue;
        }
      }
      const ctx = buildFileContext(stashDir, file);
      // Hardcoded `akmAdapter` on purpose (owner ruling 2026-07-21): this
      // write-path fast path only ever runs for assets a first-class akm
      // mutation command just wrote into a managed akm source, so the akm
      // adapter is always the right recognizer here — no per-component
      // dispatch needed.
      const drained = drainDirDocuments(akmAdapter, component, [ctx]);
      for (const rejectedPath of drained.rejectedPaths) unindexable.add(rejectedPath);
      for (const conceptId of drained.rejectedConceptIds) rejectedConceptIds.add(conceptId);
      const entry = drained.entries[0];
      // A broken workflow drains to zero entries and is treated as
      // unindexable; valid peer sources have already compiled to source IR.
      const conceptId = drained.conceptIdByFile.get(ctx.absPath);
      if (entry && conceptId) pairs.push({ file, entry, conceptId, contentHash: drained.hashByFile.get(ctx.absPath) });
      else unindexable.add(file);
    }

    const usable = openUsableIndex(stashDir, { busyTimeoutMs: WRITE_PATH_INDEX_BUSY_TIMEOUT_MS });
    if (!usable) return true;
    const { db } = usable;
    try {
      const config = loadConfig();
      const targetEntryIds = new Set<number>();
      let mutated = false;
      db.transaction(() => {
        const unindexableEntryIds = new Set<number>();
        for (const file of unindexable) {
          const rows = db
            .prepare(
              `SELECT id FROM entries
                WHERE file_path = ?
                  AND bundle_id = ?
                  AND adapter_id = ?`,
            )
            .all(file, component.id, component.adapter) as Array<{ id: number }>;
          for (const row of rows) unindexableEntryIds.add(row.id);
        }
        for (const conceptId of rejectedConceptIds) {
          const itemRef = `${component.id}//${conceptId}`;
          const rows = db
            .prepare(
              `SELECT id FROM entries
                WHERE bundle_id = ? AND adapter_id = ?
                  AND type = 'workflow'
                  AND (concept_id = ? OR item_ref = ?)`,
            )
            .all(component.id, component.adapter, conceptId, itemRef) as Array<{ id: number }>;
          for (const row of rows) unindexableEntryIds.add(row.id);
        }
        deleteEntriesByIds(db, [...unindexableEntryIds]);
        mutated ||= unindexableEntryIds.size > 0;
        for (const { file, entry, conceptId, contentHash } of pairs) {
          const entryWithSize = withFileSize(entry, file);
          // Real provenance (F4a M-core-2 item 5): populate item_ref/content_hash
          // via the SAME derivation the full-index writer uses, so a write-path
          // row is never a NULL-item_ref straggler.
          const provenance = deriveEntryProvenance(
            { bundleId: component.id, componentId: component.id, adapterId: component.adapter },
            entry.type,
            entry.name,
            conceptId,
          );
          // A materialized file has one current owner. If a targeted write is
          // the ownership handoff (for example an explicitly named bundle
          // replacing an earlier path-derived bootstrap identity), remove the
          // superseded physical-path row before publishing the canonical ref.
          const supersededIds = db
            .prepare("SELECT id FROM entries WHERE file_path = ? AND item_ref <> ?")
            .all(file, provenance.itemRef) as Array<{ id: number }>;
          deleteEntriesByIds(
            db,
            supersededIds.map((row) => row.id),
          );
          targetEntryIds.add(upsertEntry(db, file, entryWithSize, provenance, contentHash, embeddingInputCap(config)));
          mutated = true;
        }
      })();
      if (mutated) {
        await generateEmbeddingsForDb(db, config, () => {}, undefined, [...targetEntryIds]);
        publishTargetedEmbeddingMeta(db, config);
      }
    } finally {
      closeDatabase(db);
    }
    return true;
  } catch (error) {
    // A permission fault is the one failure the next full index will NOT heal,
    // so it does not get the verbose-only treatment the other skips do: fail
    // open (the caller's write still stands) but say so where an operator can
    // see it (#791).
    if (isDataDirUnreadableError(error)) {
      warn(
        `Write-path index update skipped — ${error.message} The asset will not appear in search until that is fixed.`,
      );
      return false;
    }
    const message = error instanceof Error ? error.message : String(error);
    if (isSqliteContentionError(error) || (error instanceof TransientError && error.code === "INDEX_DB_CONTENDED")) {
      warnVerbose(
        `Write-path index update skipped, the index is busy (asset appears after the next build): ${message}`,
      );
      return true;
    }
    warnVerbose("Write-path index update skipped (asset appears after the next full index):", message);
    return false;
  }
}
