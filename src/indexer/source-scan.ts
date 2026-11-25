// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import path from "node:path";
import type { AssetEntry, BundleListing } from "../core/adapter/bundle-adapter";
import type { Bundle, FileContext } from "../core/adapter/types";
import { type BundleScan, scanBundle } from "../core/assets/read";
import { toErrorMessage } from "../core/common";
import { isVerbose, warn } from "../core/warn";
import type { Database } from "../storage/database";
import {
  type DeletedEntry,
  getAllEntries,
  getIndexedBundleIdsByDir,
  getIndexedDirPathsByBundleId,
} from "../storage/repositories/index-entries-repository";
import type { EntryProvenance } from "../storage/repositories/index-entry-types";
import { setStoreFindings } from "../storage/repositories/index-meta-repository";
import type { IncompleteIndexSource } from "./index-context";
import type { IndexProgressEvent } from "./indexer";
import {
  computeDirFingerprint,
  type DirFingerprint,
  type DirStaleReason,
  getCachedDirState,
  getDirIndexState,
} from "./passes/dir-staleness";
import { CONTENT_PROJECTION_VERSION } from "./passes/markdown-projection";
import type { IndexDocument, StashFile } from "./passes/metadata";
import { drainDirDocuments, indexRowEntry } from "./scan/drain-dir";
import type { SearchSource } from "./search/search-source";

type DirScanReason =
  | DirStaleReason
  | { kind: "duplicate-dir" | "no-indexable-files" | "full-rebuild" | "not-in-source-snapshot"; detail?: string };

type DirectoryRecord = {
  bundleId: string;
  dirPath: string;
  files: string[];
  stash: StashFile | null;
  skip: boolean;
  reason?: DirScanReason;
  persistedRowCount?: number;
  /** Walked-set fingerprint taken at scan time (#900); persisted as-is for scanned and unchanged dirs. */
  fingerprint?: DirFingerprint;
  /**
   * `doc.hash` keyed by recognized-file absolute path, produced by
   * the per-dir document drain. Read by the persist layer to populate
   * `content_hash`. Absent on skipped dirs (nothing drained).
   */
  hashByFile?: Map<string, string>;
  /**
   * `doc.conceptId` keyed by recognized-file absolute path — the OWNING
   * adapter's identity, preferred by the persist layer over akm's
   * `stashDirFor` re-derivation (D-R3 identity fidelity for non-akm adapters).
   */
  conceptIdByFile?: Map<string, string>;
  /** Adapter id/version folded into incremental directory freshness. */
  indexVariant?: string;
  /** Persisted directory omitted by the current successful adapter walk. */
  remove?: boolean;
  rows?: never;
};

/** A store drains as a whole and has no directory. */
export type DirRecord =
  | DirectoryRecord
  | {
      bundleId: string;
      rows: StoreRow[];
      reason: DirScanReason;
      indexVariant: string;
      skip: false;
      remove?: never;
    };

/** One drained entry of a bundle that is no directory. */
type StoreRow = { entry: IndexDocument; conceptId: string; contentHash?: string };

type IndexedSourceOwner = Pick<EntryProvenance, "bundleId" | "adapterId">;

type SourceScanPlan = {
  source: SearchSource;
  bundle: Bundle;
  scan?: BundleScan;
  dirGroups: Map<string, FileContext[]>;
  /** A bundle that is no directory lists its entries whole, not grouped by directory. */
  storeEntries?: AssetEntry[];
  removals: Array<DirectoryRecord & { reason: DirScanReason }>;
  walkComplete: boolean;
  /** When the scan of this source is incomplete: the error that stopped it. */
  incompleteReason?: string;
  /** For a source that did not resolve: its real directory, or `unknown`. */
  incompletePath?: string;
};

type SourceScanResult = {
  dirRecords: DirRecord[];
  bundleOwners: Map<string, IndexedSourceOwner>;
  storeBundleIds: string[];
  /** The freshness variant each completely scanned bundle's rows were described under. */
  variants: Map<string, string>;
  scannedDirs: number;
  skippedDirs: number;
  generatedCount: number;
  warnings: string[];
  complete: boolean;
  incompleteSources: IncompleteIndexSource[];
};

function removalsFirst(records: DirRecord[]): DirRecord[] {
  return [...records.filter((record) => record.remove), ...records.filter((record) => !record.remove)];
}

export function addDeletedEntries(target: Map<number, DeletedEntry>, entries: DeletedEntry[]): void {
  for (const entry of entries) target.set(entry.id, entry);
}

function groupFileContextsByDir(fileContexts: FileContext[]): Map<string, FileContext[]> {
  const groups = new Map<string, FileContext[]>();
  for (const ctx of fileContexts) {
    const group = groups.get(ctx.parentDirAbs);
    if (group) group.push(ctx);
    else groups.set(ctx.parentDirAbs, [ctx]);
  }
  return groups;
}

function sourceSnapshotRemovals(
  db: Database,
  bundleId: string,
  currentDirs: ReadonlySet<string>,
  allIndexedDirsByBundle?: ReadonlyMap<string, ReadonlySet<string>>,
): string[] {
  const indexedDirs = allIndexedDirsByBundle?.get(bundleId) ?? getIndexedDirPathsByBundleId(db, bundleId);
  return [...indexedDirs].map((dirPath) => path.resolve(dirPath)).filter((dirPath) => !currentDirs.has(dirPath));
}

/** The bundle's listing; one that cannot be listed (unreachable, locked or failing) is an incomplete one: one bundle never stops the index, which keeps the rows it had and warns. */
function listOrKeep(scan: BundleScan): BundleListing {
  try {
    return scan.list();
  } catch (error) {
    return { assets: [], complete: false, incompleteReason: toErrorMessage(error) };
  }
}

function buildSourceScanPlans(
  db: Database,
  allSourceEntries: SearchSource[],
  isIncremental: boolean,
  reconcileMissingDirs: boolean,
): { plans: SourceScanPlan[]; handoffDirs: Set<string> } {
  const handoffDirs = new Set<string>();
  const plans = allSourceEntries.map((source): SourceScanPlan => {
    const bundle = { id: source.bundleId, root: source.path, location: source.location };
    if (source.unresolved) {
      return {
        source,
        bundle,
        scan: undefined,
        dirGroups: new Map(),
        removals: [],
        walkComplete: false,
        incompleteReason: source.unresolved.reason,
        incompletePath: source.unresolved.path ?? "unknown",
      };
    }
    // A bundle that names an adapter akm does not have stops the index before it changes anything.
    const scan = scanBundle(source, bundle.id);
    const listing = listOrKeep(scan);
    // A store's findings (invalid or shadowed names) are recorded for `akm lint`, which never lists the store.
    if (!scan.inDirectories && listing.complete) {
      setStoreFindings(db, bundle.id, listing.findings ?? []);
      for (const finding of listing.findings ?? []) warn(`${finding.ref} ${finding.issue}: ${finding.detail}`);
    }
    const entries = listing.assets.map(({ entry }) => entry);
    const dirGroups = scan.inDirectories
      ? groupFileContextsByDir(entries.map((entry) => scan.fileContext(entry)))
      : new Map<string, FileContext[]>();
    return {
      source,
      bundle,
      scan,
      dirGroups,
      ...(scan.inDirectories ? {} : { storeEntries: entries }),
      removals: [],
      walkComplete: listing.complete,
      ...(listing.incompleteReason ? { incompleteReason: listing.incompleteReason } : {}),
    };
  });

  const removalKeys = new Set<string>();
  const addRemoval = (plan: SourceScanPlan, dirPath: string, bundleId: string) => {
    const resolvedDir = path.resolve(dirPath);
    const key = `${resolvedDir}\0${bundleId}`;
    if (removalKeys.has(key)) return;
    removalKeys.add(key);
    plan.removals.push({
      dirPath,
      bundleId,
      files: [],
      stash: null,
      skip: false,
      remove: true,
      reason: { kind: "not-in-source-snapshot" },
    });
    handoffDirs.add(resolvedDir);
  };

  const allComplete = plans.every((plan) => plan.walkComplete && plan.scan !== undefined);

  // Reconcile departed directories for every source that produced a
  // trustworthy snapshot; a source that was not walked completely keeps its
  // last-known-good rows.
  if (reconcileMissingDirs) {
    const allIndexedDirsByBundle = !isIncremental ? new Map<string, Set<string>>() : undefined;
    if (allIndexedDirsByBundle) {
      for (const entry of getAllEntries(db)) {
        if (entry.filePath === "") continue;
        const dirs = allIndexedDirsByBundle.get(entry.bundleId) ?? new Set<string>();
        dirs.add(path.dirname(path.resolve(entry.filePath)));
        allIndexedDirsByBundle.set(entry.bundleId, dirs);
      }
    }
    for (const plan of plans) {
      if (!plan.walkComplete || !plan.scan?.inDirectories) continue;
      const currentDirs = new Set([...plan.dirGroups.keys()].map((dirPath) => path.resolve(dirPath)));
      for (const dirPath of sourceSnapshotRemovals(db, plan.bundle.id, currentDirs, allIndexedDirsByBundle)) {
        addRemoval(plan, dirPath, plan.bundle.id);
      }
    }
  }

  // Cross-source ownership handoffs can delete another source's rows, so they
  // still require every possible owner to have completed its scan.
  if (!allComplete) return { plans, handoffDirs };

  // The first configured source that exposes a physical directory owns it.
  // Remove rows left by a prior owner even when both adapters are identical.
  const claimedDirs = new Set<string>();
  const configuredBundles = new Set(plans.map((plan) => plan.bundle.id));
  for (const plan of plans) {
    for (const dirPath of plan.dirGroups.keys()) {
      const resolvedDir = path.resolve(dirPath);
      if (claimedDirs.has(resolvedDir)) continue;
      claimedDirs.add(resolvedDir);
      for (const priorOwnerBundle of getIndexedBundleIdsByDir(db, dirPath)) {
        if (priorOwnerBundle !== plan.bundle.id && configuredBundles.has(priorOwnerBundle))
          addRemoval(plan, dirPath, priorOwnerBundle);
      }
    }
  }
  return { plans, handoffDirs };
}

/**
 * Phase 1 (async): walk every source directory and pre-generate all metadata
 * outside any transaction, producing the per-directory scan records that
 * {@link persistDirRecords} later writes.
 *
 * The per-dir document drain (`drainDirDocuments` × the bundle's dispatched
 * `adapter.recognize`) is synchronous, but the walk still runs
 * outside `db.transaction()` so the persist pass can be a single synchronous
 * transaction.
 */
export async function scanSourceDirs(
  db: Database,
  allSourceEntries: SearchSource[],
  isIncremental: boolean,
  builtAtMs: number,
  onProgress?: (event: IndexProgressEvent) => void,
  reconcileMissingDirs = true,
): Promise<SourceScanResult> {
  let scannedDirs = 0;
  let skippedDirs = 0;
  let generatedCount = 0;
  const warnings: string[] = [];
  const incompleteSources: IncompleteIndexSource[] = [];
  const seenPaths = new Set<string>();
  const { plans, handoffDirs } = buildSourceScanPlans(db, allSourceEntries, isIncremental, reconcileMissingDirs);

  const dirRecords: DirRecord[] = [];
  const bundleOwners = new Map<string, IndexedSourceOwner>();
  const storeBundleIds: string[] = [];
  const variants = new Map<string, string>();
  let processedDirs = 0;

  const reportScanProgress = (message: string) =>
    onProgress?.({ phase: "scan", message, processed: processedDirs, total: allSourceEntries.length });

  const reportDirDecision = (
    kind: "scan" | "skip",
    dirPath: string,
    source: SearchSource,
    reason: DirScanReason,
    persistedRowCount?: number,
  ) => {
    if (!isVerbose()) return;
    const detail = reason.detail ? ` (${reason.detail})` : "";
    const rowInfo = persistedRowCount !== undefined ? `; previous rows=${persistedRowCount}` : "";
    const label =
      source.path === undefined ? source.bundleId : `${path.relative(source.path, dirPath) || "."} from ${source.path}`;
    reportScanProgress(`${kind === "scan" ? "Rescanning" : "Skipping"} ${label}: ${reason.kind}${detail}${rowInfo}`);
  };

  // Only the first source that exposes a physical directory may index it.
  const markSeenOrSkipDuplicate = (dirPath: string, source: SearchSource, files: string[]): boolean => {
    const resolved = path.resolve(dirPath);
    if (seenPaths.has(resolved)) {
      const reason = { kind: "duplicate-dir" } satisfies DirScanReason;
      dirRecords.push({ dirPath, bundleId: source.bundleId, files, stash: null, skip: true, reason });
      reportDirDecision("skip", dirPath, source, reason);
      return true;
    }
    seenPaths.add(resolved);
    return false;
  };

  for (const plan of plans) {
    const { source, bundle, scan, dirGroups, removals, walkComplete } = plan;
    if (plan.storeEntries !== undefined) storeBundleIds.push(bundle.id);
    processedDirs++;
    reportScanProgress(
      `Processed ${processedDirs}/${allSourceEntries.length} source${allSourceEntries.length === 1 ? "" : "s"}.`,
    );

    if (!walkComplete || scan === undefined) {
      for (const dirPath of dirGroups.keys()) seenPaths.add(path.resolve(dirPath));
      const reason = plan.incompleteReason ?? "the scan did not complete";
      incompleteSources.push({
        bundle: bundle.id,
        ...(scan?.inDirectories === false ? {} : { path: plan.incompletePath ?? source.path }),
        reason,
      });
      warn(`[index] source "${bundle.id}" was not scanned completely; preserving its last-known-good rows. ${reason}`);
      continue;
    }

    // Dispatch each bundle's DETECTED adapter.
    // The content projection's version is part of the variant: a change to what Markdown bodies index re-projects
    // every directory once instead of keeping the old text for unchanged files.
    const indexVariant = `${scan.variantPrefix}content${CONTENT_PROJECTION_VERSION}`;
    variants.set(bundle.id, indexVariant);
    bundleOwners.set(bundle.id, { bundleId: bundle.id, adapterId: scan.adapterId });

    for (const removal of removals) {
      dirRecords.push(removal);
      scannedDirs++;
      reportDirDecision("scan", removal.dirPath, source, removal.reason);
    }

    if (plan.storeEntries) {
      // A bundle that is no directory is drained whole, each entry through its own `recognize`, under no path.
      const rows: StoreRow[] = [];
      for (const entry of plan.storeEntries) {
        const doc = scan.recognize(entry);
        if (doc === null) continue;
        if (!doc.conceptId) {
          warnings.push(`Skipped ${bundle.id}//${entry.key}: adapter "${scan.adapterId}" returned no conceptId.`);
          continue;
        }
        rows.push({
          entry: indexRowEntry(doc, path.posix.basename(entry.key)),
          conceptId: doc.conceptId,
          contentHash: doc.hash,
        });
      }
      generatedCount += rows.length;
      const reason = isIncremental
        ? ({ kind: "index-context-changed" } satisfies DirScanReason)
        : ({ kind: "full-rebuild" } satisfies DirScanReason);
      // Keep the scan tally by logical group, without manufacturing a path.
      for (const group of new Set(plan.storeEntries.map((entry) => path.posix.dirname(entry.key)))) {
        scannedDirs++;
        reportDirDecision("scan", group, source, reason);
      }
      dirRecords.push({
        bundleId: bundle.id,
        skip: false,
        reason,
        rows,
        indexVariant,
      });
      continue;
    }

    for (const [dirPath, ctxs] of dirGroups) {
      // Adapter-owned filtering: the drain does not pre-filter with AKM-stash policy — each adapter's `recognize` claims or
      // abstains on its own bundle's walked files. The core walk keeps only the
      // universal hygiene `walkStashFlat` already applies (.git/dot-dirs/etc.).
      const indexableFiles = ctxs.map((ctx) => ctx.absPath);
      const forceScan = handoffDirs.has(path.resolve(dirPath)) || requiresWorkflowSourcePreflight(ctxs);

      if (markSeenOrSkipDuplicate(dirPath, source, indexableFiles)) continue;

      if (indexableFiles.length === 0) {
        skippedDirs++;
        const reason = { kind: "no-indexable-files" } satisfies DirScanReason;
        dirRecords.push({ dirPath, bundleId: bundle.id, files: indexableFiles, stash: null, skip: true, reason });
        reportDirDecision("skip", dirPath, source, reason);
        continue;
      }

      // #900: decide from stat data alone whether the directory can be skipped,
      // before drainDirDocuments reads, hashes, and parses every file.
      const fingerprint = computeDirFingerprint(dirPath, indexableFiles, indexVariant);
      const cachedState =
        isIncremental &&
        !forceScan &&
        getCachedDirState(db, dirPath, indexableFiles, builtAtMs, indexVariant, fingerprint);
      if (cachedState) {
        skippedDirs++;
        dirRecords.push({
          dirPath,
          bundleId: bundle.id,
          files: indexableFiles,
          stash: null,
          skip: true,
          reason: cachedState.reason,
          indexVariant,
        });
        reportDirDecision("skip", dirPath, source, cachedState.reason, cachedState.persistedRowCount);
        continue;
      }

      // Drain the dir's `IndexDocument` stream via the
      // bundle's dispatched `adapter.recognize` (broken workflows dropped-with-
      // warning at the drain layer) and reconstruct the durable `IndexDocument`s.
      drainObserverForTests?.(dirPath, ctxs.length);
      const drained = drainDirDocuments(
        { id: scan.adapterId, recognize: (_bundle, entry) => scan.recognize(entry) },
        bundle,
        ctxs,
      );
      if (drained.warnings.length) warnings.push(...drained.warnings);
      generatedCount += drained.entries.length;
      const stash = drained.entries.length > 0 ? { entries: drained.entries } : null;
      // Freshness is judged over the files the entries came from (every walked
      // file when none was recognized).
      const entryFiles = new Set(
        drained.entries.flatMap((entry) => (entry.filename ? [path.join(dirPath, entry.filename)] : [])),
      );
      const staleFiles = entryFiles.size > 0 ? [...entryFiles] : indexableFiles;

      // Incremental freshness gate: consult the persisted dir state and record
      // either a skip (unchanged + eligible) or a scan carrying the drained stash.
      const previousState = getDirIndexState(db, dirPath, staleFiles, builtAtMs, indexVariant, fingerprint);
      const { persistedRowCount } = previousState;
      if (isIncremental && !forceScan && !previousState.stale) {
        skippedDirs++;
        const reason = previousState.reason;
        dirRecords.push({
          dirPath,
          bundleId: bundle.id,
          files: staleFiles,
          fingerprint,
          stash: null,
          skip: true,
          reason,
          persistedRowCount,
          indexVariant,
        });
        reportDirDecision("skip", dirPath, source, reason, persistedRowCount);
        continue;
      }
      scannedDirs++;
      const reason = isIncremental ? previousState.reason : ({ kind: "full-rebuild" } satisfies DirScanReason);
      dirRecords.push({
        dirPath,
        bundleId: bundle.id,
        files: staleFiles,
        fingerprint,
        stash,
        skip: false,
        reason,
        persistedRowCount,
        hashByFile: drained.hashByFile,
        conceptIdByFile: drained.conceptIdByFile,
        indexVariant,
      });
      reportDirDecision("scan", dirPath, source, reason, persistedRowCount);
    }
  }

  return {
    dirRecords: removalsFirst(dirRecords),
    bundleOwners,
    storeBundleIds,
    variants,
    scannedDirs,
    skippedDirs,
    generatedCount,
    warnings,
    complete: plans.every((plan) => plan.walkComplete && plan.scan !== undefined),
    incompleteSources,
  };
}

function requiresWorkflowSourcePreflight(ctxs: readonly FileContext[]): boolean {
  return ctxs.some((ctx) => {
    try {
      // asset-io: deprecated a symlinked workflow source is warned about by the workflow code
      return fs.lstatSync(ctx.absPath).isSymbolicLink();
    } catch {
      return true;
    }
  });
}

let drainObserverForTests: ((dirPath: string, fileCount: number) => void) | undefined;

/**
 * TEST-ONLY. Observe every directory that actually reaches
 * `drainDirDocuments` — the per-file read/sha256-hash/frontmatter-parse step
 * (#900) — with the directory path and its walked file count. `undefined`
 * restores. A directory the pre-drain gate (`getCachedDirState`) skips never
 * fires this observer, so it is the
 * seam #900's own tests use to assert an unchanged directory's files are
 * never read on a no-op incremental run.
 */
export function _setDrainObserverForTests(observer?: (dirPath: string, fileCount: number) => void): void {
  drainObserverForTests = observer;
}
