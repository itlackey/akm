// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import path from "node:path";
import { safeRealpath } from "../core/common";
import { appendEvent } from "../core/events";
import { warn, warnVerbose } from "../core/warn";
import type { Database } from "../storage/database";
import {
  type DeletedEntry,
  deleteEntriesByBundleExceptRefs,
  deleteEntriesByDirAndBundle,
  deleteEntriesByDirExceptRefs,
  deleteEntriesByIds,
  deleteEntriesOutsideLibrary,
  deleteUsageEventsForEntries,
  getStoredEntriesInDirectory,
  upsertEntry,
} from "../storage/repositories/index-entries-repository";
import type { EntryProvenance } from "../storage/repositories/index-entry-types";
import { rekeyLlmCache } from "../storage/repositories/index-llm-cache-repository";
import {
  bundleVariantKey,
  deleteIndexDirState,
  deleteMeta,
  getIndexDirState,
  getMeta,
  setMeta,
  upsertIndexDirState,
} from "../storage/repositories/index-meta-repository";
import { withImmediateTransaction } from "../storage/sqlite-transaction";
import { reclassifyIndexDbContention } from "./index-db-contention";
import { clearIndexOnMissRefs, readIndexOnMissRefs } from "./index-on-miss";
import type { IndexMoves } from "./indexer";
import { deriveEntryProvenance } from "./installations";
import { legacyRefMove, rekeyLegacyEntry } from "./legacy-refs";
import { computeDirFingerprint, inferZeroRowReason } from "./passes/dir-staleness";
import { type IndexDocument, withFileSize } from "./passes/metadata";
import {
  type MovePairing,
  type NewEntry,
  pairMovedFiles,
  type RefMove,
  rekeyStateRefs,
  repointEntry,
  type StoredEntry,
} from "./ref-moves";
import { addDeletedEntries, type DirRecord } from "./source-scan";

/** The stored row a drained entry is compared against before it is re-persisted. */
interface PersistedEntryRow {
  id: number;
  content_hash: string | null;
  file_path: string;
  adapter_id: string;
}

/**
 * An index built before sources were keyed by real path stores the library under another spelling of
 * its directories. Rewriting those paths in place keeps its rows, and with them their embeddings,
 * which a delete and re-insert under the real spelling would drop.
 */
export function canonicalizeStoredPaths(db: Database): void {
  const stored = [getMeta(db, "stashDir"), ...(JSON.parse(getMeta(db, "stashDirs") ?? "[]") as string[])];
  const moves = [...new Set(stored.filter((dir): dir is string => dir !== undefined))]
    .map((dir) => ({ from: dir, to: safeRealpath(dir) }))
    .filter(({ from, to }) => from !== to);
  if (moves.length === 0) return;
  const rewrite = (table: string, column: string, exact: boolean) =>
    db.prepare(
      `UPDATE OR IGNORE ${table} SET ${column} = ? || substr(${column}, ?) WHERE substr(${column}, 1, ?) = ?${
        exact ? ` OR ${column} = ?` : ""
      }`,
    );
  db.transaction(() => {
    for (const { from, to } of moves) {
      const prefix = `${from}${path.sep}`;
      rewrite("entries", "file_path", false).run(to, from.length + 1, prefix.length, prefix);
      rewrite("index_dir_state", "dir_path", true).run(to, from.length + 1, prefix.length, prefix, from);
    }
    setMeta(db, "stashDirs", JSON.stringify(JSON.parse(getMeta(db, "stashDirs") ?? "[]").map(safeRealpath)));
    const stashDir = getMeta(db, "stashDir");
    if (stashDir !== undefined) setMeta(db, "stashDir", safeRealpath(stashDir));
  })();
}

/** Whether the stored library marker names `stashDir`: the same directory, however either is spelled. */
export function servesLibrary(stored: string | undefined, stashDir: string): boolean {
  return stored !== undefined && safeRealpath(stored) === safeRealpath(stashDir);
}

/**
 * Phase 2 (sync): write all pre-generated scan records inside a single transaction.
 *
 * The same transaction records which library the persisted keyword data is for
 * (`stashDir` / `stashDirs`). That is the "usable index" marker readers test
 * (`index-readiness.ts`), so it commits atomically with the entries and FTS rows
 * it describes, however the rest of the build goes.
 *
 * It takes the write lock up front (`BEGIN IMMEDIATE`): a writer that overlaps
 * it waits out the busy timeout instead of failing at once on a stale snapshot.
 */
export function persistDirRecords(
  db: Database,
  dirRecords: DirRecord[],
  warnings: string[],
  bundleByRoot: ReadonlyMap<string, { bundleId: string; adapterId: string }>,
  maxInputTokens: number,
  library: {
    stashDir: string;
    sourceDirs: string[];
    unresolvedBundleIds: ReadonlySet<string | undefined>;
    variants: ReadonlyMap<string, string>;
  },
): IndexMoves | undefined {
  const deletedEntries = new Map<number, DeletedEntry>();
  const legacyMoves: RefMove[] = [];
  const findPersisted = db.prepare("SELECT id, content_hash, file_path, adapter_id FROM entries WHERE item_ref = ?");
  // Files renamed or moved on disk since the last run: each vanished entry whose content is now at another path.
  let pairing: MovePairing = { pairs: [], unpaired: [] };
  const movedRefs = new Set<string>();

  const onMissRefs = readIndexOnMissRefs(db);
  const scannedRefs = new Set<string>();
  const pairMoves = (): MovePairing => {
    const stored: StoredEntry[] = [];
    const fresh: NewEntry[] = [];
    for (const record of dirRecords) {
      const bundle = bundleByRoot.get(path.resolve(record.currentStashDir));
      if (record.skip || record.rows || !bundle) continue;
      const kept = new Set<string>();
      for (const entry of record.remove ? [] : (record.stash?.entries ?? [])) {
        const found = identifyEntry(record.dirPath, bundle, entry, record.conceptIdByFile);
        if ("problem" in found) continue;
        kept.add(found.provenance.itemRef);
        const contentHash = record.hashByFile?.get(found.entryPath);
        // A row index-on-miss wrote since the last scan is a new file too: it may be a vanished entry's move.
        if (
          contentHash !== undefined &&
          (!findPersisted.get(found.provenance.itemRef) || onMissRefs.has(found.provenance.itemRef))
        )
          fresh.push({ filePath: found.entryPath, provenance: found.provenance, contentHash });
      }
      stored.push(
        ...getStoredEntriesInDirectory(db, record.dirPath, bundle.bundleId).filter((row) => !kept.has(row.itemRef)),
      );
    }
    return pairMovedFiles(stored, fresh);
  };

  const persist = (): void => {
    // Entries are about to describe another library: the old watermark is not theirs, and neither are rows outside
    // its directories. They go in this transaction, so the marker never names a library whose index serves another's.
    if (!servesLibrary(getMeta(db, "stashDir"), library.stashDir)) {
      deleteMeta(db, "builtAt");
      addDeletedEntries(
        deletedEntries,
        deleteEntriesOutsideLibrary(db, library.sourceDirs, library.unresolvedBundleIds),
      );
    }
    setMeta(db, "stashDir", safeRealpath(library.stashDir));
    setMeta(db, "stashDirs", JSON.stringify(library.sourceDirs));
    pairing = pairMoves();
    for (const pair of pairing.pairs) {
      // The row index-on-miss wrote for the moved file gives way to the vanished entry's, which keeps its history.
      const onMiss = onMissRefs.has(pair.entry.provenance.itemRef)
        ? (findPersisted.get(pair.entry.provenance.itemRef) as { id: number } | null)
        : null;
      if (onMiss) deleteEntriesByIds(db, [onMiss.id]);
      repointEntry(db, pair.id, pair.entry);
      rekeyLlmCache(db, pair.oldFilePath, pair.entry.filePath);
      movedRefs.add(pair.entry.provenance.itemRef);
    }
    for (const {
      dirPath,
      currentStashDir,
      files,
      fingerprint,
      stash,
      skip,
      reason,
      persistedRowCount,
      hashByFile,
      conceptIdByFile,
      indexVariant,
      remove,
      rows,
    } of dirRecords) {
      const bundle = bundleByRoot.get(path.resolve(currentStashDir));
      if (!bundle) throw new Error(`Missing bundle provenance for indexed source ${currentStashDir}`);
      if (rows) {
        // A bundle that is no directory: one row per entry, keyed by its ref and holding no path. An entry whose hash,
        // adapter and (absent) file are as stored is left as it is; a row written before 4f.2 holds a path, so it is
        // written again in this form. What the listing no longer holds is pruned.
        const kept = new Set<string>();
        const sameVariant =
          reason?.kind !== "full-rebuild" &&
          indexVariant !== undefined &&
          getMeta(db, bundleVariantKey(bundle.bundleId)) === indexVariant;
        for (const { entry, conceptId, contentHash } of rows) {
          const provenance = deriveEntryProvenance(bundle, entry.type, entry.name, conceptId);
          const previous = sameVariant
            ? ((findPersisted.get(provenance.itemRef) as PersistedEntryRow | null) ?? undefined)
            : undefined;
          kept.add(provenance.itemRef);
          scannedRefs.add(provenance.itemRef);
          if (
            previous !== undefined &&
            contentHash !== undefined &&
            previous.content_hash === contentHash &&
            previous.file_path === "" &&
            previous.adapter_id === bundle.adapterId
          ) {
            continue;
          }
          upsertEntry(db, "", entry, provenance, contentHash, maxInputTokens);
        }
        addDeletedEntries(
          deletedEntries,
          deleteEntriesByBundleExceptRefs(db, bundle.bundleId, kept, { cleanupUsageEvents: false }),
        );
        continue;
      }
      if (remove) {
        const removed = deleteEntriesByDirAndBundle(db, dirPath, bundle.bundleId, {
          cleanupUsageEvents: false,
        });
        addDeletedEntries(deletedEntries, removed);
        deleteIndexDirState(db, dirPath);
        continue;
      }
      if (skip) {
        // "unchanged" is the post-drain verdict: re-persist so the row carries
        // row_count and the gate skips this directory before draining next
        // time. "unchanged-precheck" already matched the stored row.
        if (reason?.kind === "unchanged" && fingerprint) {
          upsertIndexDirState(db, {
            dirPath,
            ...fingerprint,
            reason: reason.kind,
            rowCount: persistedRowCount,
            indexVariant,
          });
        }
        continue;
      }

      // Diff-persist: upsert the current file set
      // FIRST (ON CONFLICT preserving `entries.id` so embeddings / utility /
      // usage stay attached to unchanged rows), tracking every upserted
      // durable `item_ref`, then prune only the departed rows below. Replaces the old
      // `deleteEntriesByDir` truncate-and-reinsert (which discarded ids).
      const keptItemRefs = new Set<string>();

      // Per-file cursor: a directory is drained whole (one changed file
      // re-reads its siblings), but on an incremental run a sibling whose
      // content hash, path and adapter are unchanged since the last drain
      // under the same adapter variant is already persisted exactly as this
      // drain would persist it — including any metadata layered onto its row
      // — so it is neither rewritten nor re-persisted. `--full` re-persists
      // every entry.
      const sameVariant =
        reason?.kind !== "full-rebuild" &&
        indexVariant !== undefined &&
        getIndexDirState(db, dirPath)?.indexVariant === indexVariant;

      let persistedRows = 0;

      if (stash) {
        for (const entry of stash.entries) {
          const found = identifyEntry(dirPath, bundle, entry, conceptIdByFile);
          if ("problem" in found) {
            warn(found.problem);
            continue;
          }
          const { entryPath, provenance } = found;
          // content_hash = doc.hash from the drain, keyed by the recognized
          // file's path. A missing hash preserves the existing value on upsert.
          const contentHash = hashByFile?.get(entryPath);

          // The adapter lists one entry per ref (the spelling it reads wins), so the ref has one holder.
          const holder = (findPersisted.get(provenance.itemRef) as PersistedEntryRow | null) ?? undefined;
          keptItemRefs.add(provenance.itemRef);
          scannedRefs.add(provenance.itemRef);
          persistedRows++;

          const previous = sameVariant ? holder : undefined;
          const moved = movedRefs.has(provenance.itemRef);
          const unchanged =
            !moved &&
            previous !== undefined &&
            contentHash !== undefined &&
            previous.content_hash === contentHash &&
            previous.file_path === entryPath &&
            previous.adapter_id === bundle.adapterId;
          if (unchanged) {
            continue;
          }

          const legacy = legacyRefMove(bundle.bundleId, entry.type, provenance.conceptId);
          if (legacy) {
            rekeyLegacyEntry(db, legacy, provenance.conceptId, entryPath);
            legacyMoves.push(legacy);
          }
          upsertEntry(db, entryPath, withFileSize(entry, entryPath), provenance, contentHash, maxInputTokens, moved);
        }
      }

      // Prune the departed rows: everything under this dir NOT re-upserted above
      // (files deleted, deduped away, or abstained on by the adapter). With
      // an empty kept-set this deletes every row for the dir — the exact net
      // effect of the old unconditional `deleteEntriesByDir`, minus the id churn.
      // (A source whose walk was incomplete never reaches this point.)
      addDeletedEntries(
        deletedEntries,
        deleteEntriesByDirExceptRefs(db, dirPath, bundle.bundleId, keptItemRefs, { cleanupUsageEvents: false }),
      );

      const persistedFingerprint = fingerprint ?? computeDirFingerprint(dirPath, files, indexVariant);
      const persistedReason =
        persistedRows === 0
          ? inferZeroRowReason(stash, reason, warnings, dirPath)
          : reason?.kind === "full-rebuild"
            ? "full-rebuild"
            : (reason?.kind ?? "updated");
      upsertIndexDirState(db, {
        dirPath,
        ...persistedFingerprint,
        reason: persistedReason,
        rowCount: persistedRows,
        indexVariant,
      });
      if (persistedRows === 0) warnVerbose(`[index] zero-row ${dirPath}: ${persistedReason}`);
    }
    for (const [bundleId, variant] of library.variants) setMeta(db, bundleVariantKey(bundleId), variant);
    clearIndexOnMissRefs(db, scannedRefs);
    // Atomicity observation point: the new generation is fully written but
    // uncommitted, so it must still be invisible to other connections.
    indexTransactionHookForTests?.("records-persisted");
  };

  withImmediateTransaction(db, persist, reclassifyIndexDbContention);
  // A ref deleted from one directory may have been re-inserted by another in
  // this same run: only refs that no longer exist lose their events.
  const refStillIndexed = db.prepare("SELECT 1 FROM entries WHERE item_ref = ?");
  deleteUsageEventsForEntries(
    [...deletedEntries.values()].filter((entry) => refStillIndexed.get(entry.itemRef) == null),
  );
  const movedAssets = pairing.pairs.map((pair) => ({ from: pair.oldItemRef, to: pair.entry.provenance.itemRef }));
  try {
    rekeyStateRefs([...legacyMoves, ...movedAssets.map(({ from, to }) => ({ oldItemRef: from, newItemRef: to }))]);
  } catch (error) {
    warnings.push(
      `[index] could not carry over the history of ${legacyMoves.length + movedAssets.length} re-keyed asset(s): ${String(error)}`,
    );
  }
  // Each move is recorded on the asset's new ref, which later moves re-key with the rest of its history.
  for (const { from, to } of movedAssets) appendEvent({ eventType: "moved", ref: to, metadata: { from } });
  if (pairing.unpaired.length > 0) {
    warnings.push(
      `[index] ${pairing.unpaired.length} moved file(s) not paired: other files with identical content appeared, so ` +
        `each is indexed as a new asset and its history stays with the old ref (${pairing.unpaired.map((entry) => entry.itemRef).join(", ")}).`,
    );
  }
  return movedAssets.length > 0 || pairing.unpaired.length > 0
    ? { moved: movedAssets, unpaired: pairing.unpaired.length }
    : undefined;
}

/** The path and durable identity of a drained entry, or why it has none. */
function identifyEntry(
  dirPath: string,
  bundle: { bundleId: string; adapterId: string },
  entry: IndexDocument,
  conceptIdByFile: Map<string, string> | undefined,
): { entryPath: string; provenance: EntryProvenance } | { problem: string } {
  const entryPath = entry.filename ? path.join(dirPath, entry.filename) : null;
  if (!entryPath) return { problem: `Skipping entry with no resolvable path in ${dirPath}` };
  const adapterConceptId = conceptIdByFile?.get(entryPath);
  if (!adapterConceptId) return { problem: `Skipping entry without adapter-owned concept identity: ${entryPath}` };
  // Adapter-owned concept identity is path-based and cannot be replaced by presentation fields such as type/title.
  return { entryPath, provenance: deriveEntryProvenance(bundle, entry.type, entry.name, adapterConceptId) };
}

/**
 * Named observation point fired from INSIDE the reindex write transaction
 * (see {@link persistDirRecords}). TEST-ONLY.
 *
 *  - `records-persisted` — every directory's rows are upserted and pruned,
 *    but the transaction has not committed yet, so the new generation is
 *    still invisible outside.
 */
export type IndexTransactionPoint = "records-persisted";

let indexTransactionHookForTests: ((point: IndexTransactionPoint) => void) | undefined;

/**
 * TEST-ONLY. Observe the in-flight reindex transaction; `undefined` restores.
 *
 * Exists because the persist transaction's atomicity is, by construction,
 * invisible from outside it: by the time `akmIndex()` resolves, the commit
 * has already collapsed both generations into one observable state.
 * Concurrency tests install a hook that opens a SECOND connection at this
 * point and asserts it still sees the previous complete generation. Inert in
 * production (one `undefined?.()` per reindex).
 */
export function _setIndexTransactionHookForTests(hook?: (point: IndexTransactionPoint) => void): void {
  indexTransactionHookForTests = hook;
}
