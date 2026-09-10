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
 * lock-contention footgun removed alongside this module's introduction, per
 * the 2026-07 read-path reindex-contention findings §7).
 *
 * This is NOT a general reindex. It upserts exactly the files the caller just
 * wrote: frontmatter/metadata via the shared matcher pipeline, the canonical
 * row with its transactionally owned FTS projection, and vectors for changed
 * entry IDs when semantic search is enabled. Index-time LLM passes, graph
 * extraction, `builtAt`, and the per-dir walk cache remain full-index
 * responsibilities.
 */

import fs from "node:fs";
import path from "node:path";
import { akmAdapter } from "../core/adapter/adapters/akm-adapter";
import { loadConfig } from "../core/config/config";
import { isDataDirUnreadableError } from "../core/errors";
import { probeLock } from "../core/file-lock";
import { isPathAbsent } from "../core/path-access";
import { getDbPath, getIndexRebuildLockPath } from "../core/paths";
import { formatLockHolderPid } from "../core/run-lock";
import { warn, warnVerbose } from "../core/warn";
import { closeDatabase, openExistingDatabase } from "../storage/repositories/index-connection";
import { deleteEntriesByIds, getEntryCount, upsertEntry } from "../storage/repositories/index-entries-repository";
import { deriveEntryProvenance, deriveInstallations } from "./installations";
import { generateEmbeddingsForDb, publishTargetedEmbeddingMeta } from "./materialize-embeddings";
import {
  getMarkdownFragmentContent,
  hasMarkdownFragmentContent,
  type IndexDocument,
  setMarkdownFragmentContent,
} from "./passes/metadata";
import { drainDirDocuments } from "./scan/drain-dir";
import { buildSearchText } from "./search/search-fields";
import { buildFileContext } from "./walk/file-context";

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
 *
 * A live rebuild holding the rebuild lock is the SAME kind of skip, not a
 * failure (#956 fix): a live `akm index` run owns bringing the index to the
 * expected state on its own, so this call returns `true` on that skip
 * exactly like the absent-index and empty-index cases above. Callers that
 * gate their own success on this boolean (`acceptProposal`, `source clone`)
 * must never fail or warn just because a concurrent rebuild is in progress.
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
    return await (async () => {
      // #956: a live `akm index` rebuild holds index.db under one long
      // transaction (persistDirRecords), which this fast path's own 5s
      // busy_timeout would just contend with pointlessly. Interactive
      // commands (remember, import, extract session assets) must never wait
      // on it — skip the inline upsert/embedding entirely; the write itself
      // (file + commit) has already succeeded by the time this runs, and the
      // rebuild in progress will pick up the change on its own.
      const rebuildProbe = probeLock(getIndexRebuildLockPath());
      if (rebuildProbe.state === "held") {
        // #956: name the launcher pid alongside the holder pid when known —
        // every process listing and task log shows the launcher's pid, not
        // the bun/node child's.
        const holderLabel = formatLockHolderPid({
          pid: rebuildProbe.holderPid,
          launcherPid: rebuildProbe.launcherPid ?? null,
        });
        warn(`index rebuild in progress (pid ${holderLabel}); the next index pass will index ${filePaths.join(", ")}`);
        return true;
      }

      const dbPath = getDbPath();
      // `true` here means "the index is in the state the caller expects" — and
      // `acceptProposal` advances its journal to `index-finalized` on the
      // strength of it. Only a genuinely ABSENT index earns that answer: an
      // index we cannot read has NOT been updated, so it falls through to
      // `openExistingDatabase` and surfaces as the honest `false` (#791).
      if (isPathAbsent(dbPath)) return true;

      // The full walk never descends into dot-directories (for example `.meta/`)
      // — mirror that dot-segment skip here so this fast path indexes exactly
      // what a full run would. Sensitive/
      // infra abstention is the adapter's job now (see the `akmAdapter` note
      // below), not a path pre-filter.
      const files = filePaths.filter((f) => {
        const rel = path.relative(stashDir, f);
        return !rel.split(/[\\/]+/).some((segment) => segment.startsWith("."));
      });
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
        if (entry && conceptId)
          pairs.push({ file, entry, conceptId, contentHash: drained.hashByFile.get(ctx.absPath) });
        else unindexable.add(file);
      }

      const db = openExistingDatabase(dbPath);
      try {
        db.exec(`PRAGMA busy_timeout = ${WRITE_PATH_INDEX_BUSY_TIMEOUT_MS}`);
        if (getEntryCount(db) === 0) return true;
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
            let entryWithSize = entry;
            try {
              entryWithSize = { ...entry, fileSize: fs.statSync(file).size };
              if (hasMarkdownFragmentContent(entry)) {
                setMarkdownFragmentContent(entryWithSize, getMarkdownFragmentContent(entry));
              }
            } catch {
              // stat raced a delete — index without the size, like the full walk does.
            }
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
            targetEntryIds.add(upsertEntry(db, file, entryWithSize, buildSearchText(entry), provenance, contentHash));
            mutated = true;
          }
        })();
        if (mutated) {
          const config = loadConfig();
          await generateEmbeddingsForDb(db, config, () => {}, undefined, [...targetEntryIds]);
          publishTargetedEmbeddingMeta(db, config);
        }
      } finally {
        closeDatabase(db);
      }
      return true;
    })();
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
    warnVerbose(
      "Write-path index update skipped (asset appears after the next full index):",
      error instanceof Error ? error.message : String(error),
    );
    return false;
  }
}
