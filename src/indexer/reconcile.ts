// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The reconcile engine (docs/plans/index-redesign-contract.md, B1).
 *
 * Replaces the incremental dir-staleness pass (`passes/dir-staleness.ts`) and
 * the directory-fingerprint walk in `indexer.ts` with a flat, file-level
 * diff: stat every file under a root, hash and re-parse only the ones whose
 * `(size, mtime)` moved or are new, and delete whichever previously-tracked
 * paths are gone. `files` (`storage/repositories/files-repository.ts`) is
 * the stat cache the diff runs against. Idempotent — a second run with
 * nothing changed on disk touches no row.
 *
 * Per changed file: parse it with the SAME per-file parse the full-directory
 * drain uses (`scan/parse-file.ts`'s `parseFileDocument`, shared so the two
 * never drift), upsert `entries` (`content_hash` = the parsed blob hash),
 * derive its embedding units (A1's `deriveUnits`, `units/unit.ts`) bounded by
 * the provider's real window (`unitMaxChars(probeProviderLimits(...))`,
 * probed once and cached for the whole run), write any new unit texts, and
 * point `entry_units` at them (A2's `replaceEntryUnits`). Because units are
 * content-addressed, `unit_texts`/`units_fts` never gain a duplicate row for
 * a hash already stored — `INSERT OR IGNORE` skips it.
 *
 * `reconcileRoots` additionally recognizes a same-bundle rename: a gone path
 * whose last known `blob_hash` matches a changed/new path's freshly-parsed
 * hash is re-pointed with ONE `UPDATE` of the existing `entries` row
 * (`repointEntry`) rather than a delete-then-insert, so the row keeps its
 * `id` (and anything keyed off it, e.g. usage history) across the move. Note
 * on "no re-derive": the akm adapter's canonical name — and therefore every
 * unit's header line — is derived from the file's path (`akm-adapter.ts`,
 * "NOT the frontmatter title"), so a rename that changes the name still
 * changes every unit's hash; "no re-derive" here means the row is updated in
 * place (not deleted and re-inserted under a fresh id) and its `content_hash`
 * is the SAME blob hash already produced by the one parse this file went
 * through, never independently recomputed. Content-addressing (INSERT OR
 * IGNORE) still means a fragment whose text is unchanged after the header is
 * rebuilt never becomes a distinct stored row versus an unrelated edit that
 * happens to produce the same fragment text elsewhere.
 *
 * Every per-file write is its own short `BEGIN IMMEDIATE` transaction
 * (`core/state-db.ts`'s `withImmediateTransaction`, which already retries on
 * contention) — never one transaction for the whole run — so two reconciles
 * racing the same root serialize file-by-file and converge on the same end
 * state instead of one clobbering the other's snapshot.
 */

import fs from "node:fs";
import path from "node:path";
import { hashContent } from "../core/adapter/adapters/shared";
import type { BundleAdapter } from "../core/adapter/bundle-adapter";
import { adapterForId } from "../core/adapter/registry";
import type { BundleComponent } from "../core/adapter/types";
import { compareCodePoints } from "../core/common";
import type { AkmConfig } from "../core/config/config";
import { loadConfig } from "../core/config/config";
import { classifyPathAccess, describeInaccessiblePath } from "../core/path-access";
import { canonicalizeWorkflowName } from "../core/recognition-util";
import { withImmediateTransaction } from "../core/state-db";
import { isVerbose, warn, warnOnce } from "../core/warn";
import { probeProviderLimits, unitMaxChars } from "../llm/embedders/provider-limits";
import type { Database } from "../storage/database";
import {
  deleteFileStates,
  type FileStateRow,
  getFileState,
  getFileStatesByBundle,
  insertNewUnitTexts,
  pruneOrphanUnitTexts,
  pruneOrphanUnitTextsForHashes,
  upsertFileState,
} from "../storage/repositories/files-repository";
import { deleteEntriesByIds, upsertEntry } from "../storage/repositories/index-entries-repository";
import type { EntryProvenance } from "../storage/repositories/index-entry-types";
import { replaceFragmentSource } from "../storage/repositories/index-fts-repository";
import { replaceEntryUnits } from "../storage/repositories/units-repository";
import { resolveWorkflowSourceDomains, workflowNameForSourcePath } from "../workflows/source-files";
import { enrichReconciledEntries, type MetadataEnrichmentCandidate } from "./enrich";
import { deriveEntryProvenance, deriveInstallations } from "./installations";
import {
  getMarkdownFragmentContent,
  hasMarkdownFragmentContent,
  type IndexDocument,
  isWorkflowSkipWarning,
  setMarkdownFragmentContent,
} from "./passes/metadata";
import { parseFileDocument } from "./scan/parse-file";
import { buildSearchText } from "./search/search-fields";
import { resolveSourceEntries } from "./search/search-source";
import { deriveUnits, toUnitSource } from "./units/unit";
import { buildFileContext, type FileContext } from "./walk/file-context";
import { type WalkStashFlatOptions, walkStashFlatWithStatus } from "./walk/walker";

// ── Types ───────────────────────────────────────────────────────────────────

export interface ReconcileCounts {
  scanned: number;
  unchanged: number;
  added: number;
  changed: number;
  removed: number;
  unitsAdded: number;
  /**
   * False when any root's walk could not be trusted (a listing or stat
   * failure somewhere under it — see the gone-path sweep below) or named a
   * bundle whose adapter did not resolve. `akmIndex()` (index-redesign B5)
   * reduces this across every root it reconciled to decide `scanComplete` on
   * its `IndexResponse`. `reconcilePaths` has no walk to trust or distrust,
   * so it is always `true` there.
   */
  complete: boolean;
  /**
   * Per-file skip warnings (a missing conceptId, or a workflow document that
   * fails to compile — `parseFileDocument`'s `warning`), in the order
   * encountered. `akmIndex()` surfaces these verbatim as `IndexResponse.warnings`
   * regardless of verbosity; verbosity only gates the immediate stderr line
   * (`buildMetadataSkipWarning`) and the one-line workflow-skip summary
   * `reconcileRoots` emits itself (issue #273's noise gate).
   */
  warnings: string[];
}

interface RootContext {
  bundleId: string;
  component: BundleComponent;
  adapter: BundleAdapter;
}

/** `applyChange` always either inserts a fresh row or writes into an existing one — "unchanged"/"removed" are decided before it is ever called. */
interface FileResult {
  outcome: "added" | "changed";
  unitsAdded: number;
  /**
   * The row id, written entry, and provenance `applyChange` just committed —
   * carried out so `reconcileRoots` can offer this file as a
   * {@link MetadataEnrichmentCandidate} (B5e) without a redundant re-query.
   * `reconcilePaths` (the write-time path) ignores these fields; it never
   * runs enrichment (see `enrich.ts`'s module doc for why).
   */
  entryId: number;
  entry: IndexDocument;
  provenance: EntryProvenance;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Prefix of the per-root "done with this root" progress line
 * (`"${RECONCILE_ROOT_PROGRESS_PREFIX}<path>": N files scanned."`), one per
 * root reconciled. Exported so a caller juggling several `onProgress`
 * sources (`stash-cli.ts`'s `akm index`) can recognize — and, outside
 * `--verbose`, suppress — this specific high-frequency line by prefix rather
 * than re-deriving its own copy of the pattern (#954), while still always
 * showing the aggregate reconcile-totals line `akmIndex` emits separately
 * after this whole walk finishes.
 */
export const RECONCILE_ROOT_PROGRESS_PREFIX = 'Reconciled "';

/**
 * Stat-walk every root, hash files whose (size, mtime) moved or are new,
 * derive new blob hashes, delete gone paths. Idempotent.
 */
export async function reconcileRoots(
  db: Database,
  roots: readonly { path: string; bundleId: string }[],
  opts?: {
    signal?: AbortSignal;
    onProgress?: (line: string) => void;
    /**
     * `akm index --full`: treat every walked file as needing re-derivation,
     * ignoring the stat-hint shortcut that ordinarily short-circuits an
     * unchanged file — the mechanism for "re-derive everything even though
     * nothing's stat moved" (a parsing-logic change, an adapter fix). Gone-
     * path detection is unaffected (still compares against the real stat
     * cache), so a genuinely deleted file is still removed normally.
     */
    forceReparse?: boolean;
    /**
     * `akm bundle update`'s coordinator holds one `BEGIN IMMEDIATE` spanning
     * index.db and an attached state.db for the whole `akmIndex` call
     * (`indexer.ts`'s `deferredUpdateTransaction`). The embedding drain is
     * already skipped entirely in that mode for the same reason (a
     * long-running provider call must not nest inside a long-lived
     * transaction and lock out every other akm process touching index.db or
     * state.db for as long as it takes) — this mirrors that skip:
     * `enrichReconciledEntries` is not called at all, and the next ordinary
     * `akm index` enriches these candidates instead (the content-addressed
     * cache means no work is repeated).
     */
    insideBorrowedTransaction?: boolean;
  },
): Promise<ReconcileCounts> {
  const counts = emptyCounts();
  const config = loadConfig();
  const maxChars = unitMaxChars(await probeProviderLimits(config.embedding ?? {}, { signal: opts?.signal }));
  // Collected across every root, then handed to `enrichReconciledEntries`
  // ONCE after this whole walk (and `resolvePhysicalOverlaps`) settles — see
  // `enrich.ts`'s module doc for why this runs only on the full-root path and
  // only after every per-file transaction below has already committed.
  const enrichmentCandidates: MetadataEnrichmentCandidate[] = [];

  for (const root of roots) {
    throwIfAborted(opts?.signal);

    const ctx = resolveRootContext(root.path, root.bundleId);
    if (!ctx) {
      opts?.onProgress?.(`Skipping "${root.path}": no adapter resolved for bundle "${root.bundleId}".`);
      counts.complete = false;
      continue;
    }

    const walked = walkStashFlatWithStatus(root.path, walkOptionsFor(ctx.component));
    counts.scanned += walked.files.length;

    // An incomplete walk (a listing or stat failure somewhere under this
    // root) freezes the WHOLE root's snapshot for this run, not merely the
    // gone-path sweep below: the walker cannot vouch for what it saw either,
    // since a transient failure on one file says nothing about whether the
    // OTHER files it did list are genuinely current — a sibling that
    // legitimately changed on disk this run is not distinguishable, from
    // here, from one whose apparent change is an artifact of the same
    // underlying disruption (a mid-run unmount, a git-index race). Applying
    // adds/changes for the files that happened to walk fine while treating
    // the rest as gone would publish a half-true snapshot with no way for a
    // caller to know it is half true. The next complete walk catches up
    // fully; `counts.complete = false` (→ `IndexResponse.scanComplete`)
    // reports the freeze truthfully in the meantime.
    if (!walked.complete) {
      opts?.onProgress?.(`"${root.path}" was not scanned completely; preserving its entire snapshot this run.`);
      counts.complete = false;
      continue;
    }

    warnIfAdapterSkipsAkmContent(ctx.component, walked.files, ctx.adapter);

    // #339-adjacent: `files` (the stat cache) and `entries` can desync —
    // most plainly when something clears `entries` without also clearing
    // `files` (a crash mid-rebuild, a hand operation, a bug elsewhere) —
    // and the two are two different tables with no FK between them, so
    // SQLite enforces nothing here. A `storedHint` whose row has genuinely
    // gone missing must never let `classifyFile`'s stat-only short-circuit
    // conclude "unchanged": that would leave the file silently unindexed
    // forever, since nothing else would ever re-examine it. Filtering
    // `storedByPath` down to paths that still have a live `entries` row
    // makes every other file look "new" to `classifyFile`, which reparses
    // and reinserts it — self-healing the desync on the very next reconcile;
    // the orphaned `files` rows the filter drops are deleted below so they
    // do not linger and inflate the stat cache forever.
    const entryPaths = new Set(
      (
        db.prepare("SELECT file_path FROM entries WHERE bundle_id = ?").all(root.bundleId) as { file_path: string }[]
      ).map((row) => row.file_path),
    );
    const allFileStates = getFileStatesByBundle(db, root.bundleId);
    const orphanedFileStates = allFileStates.filter((row) => !entryPaths.has(row.path));
    if (orphanedFileStates.length > 0) {
      withImmediateTransaction(
        db,
        () => {
          deleteFileStates(
            db,
            orphanedFileStates.map((row) => row.path),
          );
        },
        "index",
      );
    }
    const storedByPath = new Map(allFileStates.filter((row) => entryPaths.has(row.path)).map((row) => [row.path, row]));
    const currentPaths = new Set(walked.files.map((file) => file.absPath));

    // A full-root walk can see both peer workflow formats (.md/.yml) for one
    // canonical ref at once — ownership arbitration needs that whole-root view,
    // so it happens here rather than in the single-file `classifyFile` (which
    // only ever sees one already-known-changed file, mirroring drain-dir.ts's
    // pre-redesign "peer-workflow-format ownership arbitration" doc comment,
    // fallback included: the owner file is always tried FIRST, and if IT
    // drops with its own workflow-compile error, the shadow lifts so the
    // previously-shadowed sibling still gets indexed rather than the whole
    // canonical ref silently vanishing). Only `reconcileRoots` (the full-walk
    // path) does this: `reconcilePaths` (index-written-assets.ts's targeted
    // write) has no visibility into a sibling file it did not just write, so
    // a newly-added shadowed sibling there deliberately stales the cache
    // instead — the next full reconcile (or the read-path physical-owner
    // fallback in the meantime) resolves it.
    const ownership = workflowOwnershipContext(ctx.component, walked.files);

    // Phase 1: classify every walked file without writing anything yet.
    // Unchanged files short-circuit on the stat hint alone; everything else
    // is parsed once (yielding the hash a rename match needs) and queued.
    // Iterates in ownership order (a workflow canonical ref's owner file
    // before its shadowed peers) so the fallback above can observe the
    // owner's outcome before deciding a peer's fate.
    const pendingChanges: ParsedChange[] = [];
    for (const file of ownership.orderedFiles) {
      throwIfAborted(opts?.signal);
      if (ownership.isShadowed(file)) {
        if (deleteFileAndEntryByPath(db, file.absPath)) counts.removed++;
        continue;
      }
      const classified = classifyFile(
        ctx,
        file,
        opts?.forceReparse ? undefined : storedByPath.get(file.absPath),
        (message, isWorkflowDrop) => {
          counts.warnings.push(message);
          ownership.onDropped(file, isWorkflowDrop);
        },
      );
      if (classified === "unchanged") {
        counts.unchanged++;
      } else if (classified === "unindexable") {
        if (deleteFileAndEntryByPath(db, file.absPath)) counts.removed++;
      } else {
        pendingChanges.push(classified);
      }
    }

    // Phase 2: gone paths, indexed by blob hash so phase 3 can recognize a
    // same-bundle rename instead of a delete paired with an unrelated
    // insert. The walk is known-complete here (an incomplete one already
    // `continue`d the whole root above), so reading "not currently walked" as
    // "gone" is safe — nothing this root's walk merely failed to see can end
    // up here.
    const goneByHash = new Map<string, FileStateRow[]>();
    for (const stale of storedByPath.values()) {
      if (currentPaths.has(stale.path)) continue;
      const bucket = goneByHash.get(stale.blobHash);
      if (bucket) bucket.push(stale);
      else goneByHash.set(stale.blobHash, [stale]);
    }

    // Phase 3: apply every queued change, claiming a rename match when one exists.
    for (const change of pendingChanges) {
      throwIfAborted(opts?.signal);
      const bucket = goneByHash.get(change.hash);
      // A rename match is only trustworthy when exactly one gone row shares
      // this hash. With two or more byte-identical candidates (e.g. three
      // copies of the same memory, one deleted and another renamed this same
      // run) there is no evidence which one this change actually became —
      // `bucket[0]` would pick whichever row `getFileStatesByBundle`
      // happened to list first, silently repointing the change onto a
      // possibly-unrelated row's `entries.id` (and therefore its usage
      // history). Leaving an ambiguous bucket untouched here falls through
      // to the ordinary upsert below and lets Phase 4 delete every row still
      // sitting in it as genuinely gone.
      const candidate = bucket?.length === 1 ? bucket[0] : undefined;
      // Only actually CLAIM (shift out of `goneByHash`) a same-hash "gone"
      // row when it is a genuine rename — the identity this change's own
      // content/path derives is not ALREADY a different, established row.
      // Two independently-named files that happen to be byte-identical
      // (e.g. an un-cleaned-up duplicate memory) hash-match a "gone" row
      // that is not really them renamed; repointOrInsert declines that case
      // too (see its own doc comment) and falls back to a plain upsert, so
      // leaving the candidate UNSHIFTED here is what lets Phase 4 still see
      // it as genuinely gone and delete it — shifting it out regardless of
      // whether it gets used would strand it: not repointed, not deleted,
      // permanently stale.
      const itemRefAlreadyClaimed = candidate
        ? db
            .prepare("SELECT 1 FROM entries WHERE item_ref = ? AND file_path <> ?")
            .get(deriveItemRefForChange(ctx, change), candidate.path) != null
        : false;
      const renameSource = candidate && !itemRefAlreadyClaimed ? bucket?.shift() : undefined;
      const result = applyChange(db, ctx, change, maxChars, renameSource, false);
      applyOutcome(counts, result);
      enrichmentCandidates.push({
        entryId: result.entryId,
        blobHash: change.hash,
        entry: result.entry,
        filePath: change.file.absPath,
        provenance: result.provenance,
      });
    }

    // Phase 4: whatever gone rows no rename claimed are genuinely gone —
    // except a path the walk merely could not read (a permission change, a
    // symlink loop — #791): `walkStashManual`/`walkStashGit` silently drop an
    // unresolvable path from `walked.files` the same way they drop an
    // ordinary symlink, so it lands here looking exactly like "deleted".
    // "Absent" (ENOENT) is deleted as before; "inaccessible" keeps its row
    // and is reported, mirroring the pre-redesign `--clean` pass's own
    // absent-vs-inaccessible contract, now applied on every run since
    // reconcile is what "removes what's gone" unconditionally.
    const unreadableStale: FileStateRow[] = [];
    for (const bucket of goneByHash.values()) {
      for (const stale of bucket) {
        throwIfAborted(opts?.signal);
        if (classifyPathAccess(stale.path).access === "inaccessible") {
          unreadableStale.push(stale);
          continue;
        }
        if (deleteFileAndEntryByPath(db, stale.path)) counts.removed++;
      }
    }
    if (unreadableStale.length > 0) {
      const shown = unreadableStale
        .slice(0, 5)
        .map((row) => describeInaccessiblePath(row.path, classifyPathAccess(row.path).code));
      warn(
        `Reconcile kept ${unreadableStale.length} entr${unreadableStale.length === 1 ? "y" : "ies"} whose file akm ` +
          `cannot read (unreadable is not deleted): ${shown.join("; ")}${unreadableStale.length > shown.length ? "; …" : ""}`,
      );
    }

    opts?.onProgress?.(`${RECONCILE_ROOT_PROGRESS_PREFIX}${root.path}": ${walked.files.length} files scanned.`);
  }

  // Runs BEFORE `resolvePhysicalOverlaps` below, not after: enrichment writes
  // through `upsertEntry`, keyed by `item_ref` (INSERT ... ON CONFLICT), so
  // applying it to a candidate whose row `resolvePhysicalOverlaps` is about to
  // delete as a physical-overlap LOSER would silently re-INSERT that exact
  // row — resurrecting the very row the overlap resolution just removed.
  // Running first means a wasted enrichment call on a loser is simply deleted
  // moments later (entry_units cascades with its `entries` row; any orphaned
  // `unit_texts`/`units_fts` rows are swept by `pruneOrphanUnitTexts` below
  // regardless of ordering) — never a resurrection.
  if (!opts?.insideBorrowedTransaction) {
    await enrichReconciledEntries(db, config, enrichmentCandidates, maxChars, {
      signal: opts?.signal,
      onProgress: opts?.onProgress,
    });
  }

  // Two configured bundle roots can physically overlap (a bundle added inside
  // another bundle's root, or one adapter's `includeAllDirectories` reaching a
  // dotdir the other skips): each root's own per-file loop above writes its
  // own row for the shared file under its own item_ref, oblivious to the
  // other root's claim — and `files` (the stat cache) has exactly one row PER
  // PATH (`path TEXT PRIMARY KEY`, files-repository.ts), so whichever root's
  // write lands last simply steals that tracking row out from under the
  // other, regardless of which bundle should actually own the file. Resolving
  // this per-file, during either root's own walk, would make the outcome
  // depend on processing order; instead this runs once, after every root has
  // had its turn, and is therefore order-independent.
  resolvePhysicalOverlaps(db, roots);

  pruneOrphanUnitTexts(db);

  // Workflow validation noise gate (issue #273): suppress per-spec stderr
  // lines at default verbosity and emit a single summary instead. In verbose
  // mode the per-spec lines are already printed by `buildMetadataSkipWarning`
  // at generation time (inside `parseFileDocument`) — no second pass needed
  // here. `counts.warnings` itself always carries every per-file detail,
  // verbosity or not — only this immediate stderr summary is gated.
  if (!isVerbose()) {
    const skippedWorkflowCount = counts.warnings.filter(isWorkflowSkipWarning).length;
    if (skippedWorkflowCount > 0) {
      const noun = skippedWorkflowCount === 1 ? "workflow spec" : "workflow specs";
      warn(
        `${skippedWorkflowCount} ${noun} skipped due to validation errors; ` +
          "rerun with --verbose (or AKM_VERBOSE=1) to see details.",
      );
    }
  }

  return counts;
}

interface WorkflowOwnershipContext {
  /** `files` reordered so each canonical ref's owner is visited before its shadowed peers. */
  orderedFiles: readonly FileContext[];
  /** Whether `file` is currently shadowed by a higher-precedence peer (ported from drain-dir.ts's `orderedFileContexts`/`ownerPath` check). */
  isShadowed(file: FileContext): boolean;
  /** Record a file's drop outcome — an owner's own workflow-compile failure lifts the shadow over its peers (drain-dir.ts's `invalidWorkflowOwnerNames`). */
  onDropped(file: FileContext, isWorkflowDrop: boolean): void;
}

const NO_WORKFLOW_OWNERSHIP: WorkflowOwnershipContext = {
  orderedFiles: [],
  isShadowed: () => false,
  onDropped: () => undefined,
};

/**
 * Peer-workflow-format ownership arbitration over one root's walked files —
 * the deterministic ".md wins over .yml" precedence `resolveWorkflowSourceDomains`
 * already applies for the read path (`resolveAdapterConceptOwner` →
 * `resolveUniqueWorkflowSource` → `pickWorkflowSource`), now applied at
 * indexing time (ported verbatim from the pre-redesign `drain-dir.ts`'s
 * `drainDirDocuments`, whose caller this reconcile engine replaced) so the
 * persisted row for a colliding canonical ref agrees with what a lookup/show
 * would physically resolve to.
 *
 * Content validity plays no part in the INITIAL pick — a malformed `.md`
 * still shadows a perfectly valid `.yml` sibling, since `pickWorkflowSource`'s
 * domain resolution is path-level only — but the shadow is provisional:
 * `orderedFiles` visits the owner before its peers, and if the owner's own
 * `parseFileDocument` call reports a workflow-compile drop (`onDropped` with
 * `isWorkflowDrop: true`), `isShadowed` starts returning `false` for that
 * canonical name so the peer still gets indexed rather than the ref vanishing
 * entirely — never a "multiple sources" collision, just the owner's own
 * parse error surfacing alone. A domain with no resolvable owner at all
 * (every candidate individually invalid — a broken symlink, an escaping
 * path) shadows nothing: each candidate fails its own validation independently.
 */
function workflowOwnershipContext(component: BundleComponent, files: readonly FileContext[]): WorkflowOwnershipContext {
  if (component.adapter !== "akm" && component.adapter !== "akm-workflow") {
    return { ...NO_WORKFLOW_OWNERSHIP, orderedFiles: files };
  }
  const adapterId = component.adapter;
  const domains = resolveWorkflowSourceDomains(
    component.root,
    adapterId,
    files.map((file) => file.absPath),
  );
  const ownerPathByCanonicalName = new Map<string, string>();
  for (const domain of domains) {
    if (domain.source) ownerPathByCanonicalName.set(domain.canonicalName, path.resolve(domain.source.path));
  }
  const invalidOwnerNames = new Set<string>();

  const canonicalNameFor = (file: FileContext): string | undefined => {
    const name = workflowNameForSourcePath(component.root, adapterId, file.absPath);
    return name === undefined ? undefined : canonicalizeWorkflowName(name);
  };

  const orderedFiles = [...files].sort((left, right) => {
    const leftName = canonicalNameFor(left);
    const rightName = canonicalNameFor(right);
    const leftOwner = leftName !== undefined && ownerPathByCanonicalName.get(leftName) === path.resolve(left.absPath);
    const rightOwner =
      rightName !== undefined && ownerPathByCanonicalName.get(rightName) === path.resolve(right.absPath);
    if (leftOwner !== rightOwner) return leftOwner ? -1 : 1;
    return compareCodePoints(left.absPath, right.absPath);
  });

  return {
    orderedFiles,
    isShadowed(file) {
      const canonicalName = canonicalNameFor(file);
      if (canonicalName === undefined) return false;
      const ownerPath = ownerPathByCanonicalName.get(canonicalName);
      return (
        ownerPath !== undefined && ownerPath !== path.resolve(file.absPath) && !invalidOwnerNames.has(canonicalName)
      );
    },
    onDropped(file, isWorkflowDrop) {
      if (!isWorkflowDrop) return;
      const canonicalName = canonicalNameFor(file);
      if (canonicalName !== undefined) invalidOwnerNames.add(canonicalName);
    },
  };
}

/**
 * The same per-file step for a known list of paths (the write paths call this
 * inline).
 *
 * `opts.root`, when given, is used directly to build the component/adapter
 * context (the same direct derivation `reconcileRoots` uses for its own
 * roots) instead of resolving `bundleId` back to a root through the
 * configured-sources lookup (`resolveBundleRoot`, below). A write-path caller
 * that already knows the exact stash directory it just wrote to (every
 * caller of `indexWrittenAssets` does) should pass it: `bundleId` alone can
 * resolve to the WRONG root for a bundle that is not (yet, or ever) a
 * `bundles.<key>` config entry — for example a proposal's ad hoc named write
 * target — silently deriving a corrupt, path-traversal-laced conceptId
 * rather than a clean no-op. Omit `opts.root` only when no root is at hand
 * (e.g. a caller working purely from a configured bundle id); the id must
 * then match a real `bundles` entry or this is a documented no-op.
 */
export async function reconcilePaths(
  db: Database,
  paths: readonly string[],
  bundleId: string,
  opts?: { root?: string },
): Promise<ReconcileCounts> {
  const counts = emptyCounts();
  if (paths.length === 0) return counts;

  const config = loadConfig();
  let rootPath: string;
  let ctx: RootContext;
  if (opts?.root) {
    const resolvedCtx = resolveRootContext(opts.root, bundleId);
    if (!resolvedCtx) return counts;
    rootPath = opts.root;
    ctx = resolvedCtx;
  } else {
    const resolvedRoot = resolveBundleRoot(bundleId, config);
    if (!resolvedRoot) return counts;
    rootPath = resolvedRoot.rootPath;
    ctx = { bundleId, component: resolvedRoot.component, adapter: resolvedRoot.adapter };
  }

  const maxChars = unitMaxChars(await probeProviderLimits(config.embedding ?? {}));

  for (const rawPath of paths) {
    counts.scanned++;
    const absPath = path.resolve(rawPath);
    if (!fs.existsSync(absPath)) {
      if (deleteFileAndEntryByPath(db, absPath)) counts.removed++;
      continue;
    }
    const file = buildFileContext(rootPath, absPath);
    const classified = classifyFile(ctx, file, getFileState(db, absPath), (message) => counts.warnings.push(message));
    if (classified === "unchanged") counts.unchanged++;
    else if (classified === "unindexable") {
      if (deleteFileAndEntryByPath(db, absPath)) counts.removed++;
    } else {
      // No rename matching for the known-paths write path (index-redesign B1
      // scoping decision): the caller already knows exactly which paths it
      // just wrote, so there is no gone-path pool here to correlate against.
      applyOutcome(counts, applyChange(db, ctx, classified, maxChars, undefined, true));
    }
  }

  return counts;
}

// ── Root / bundle resolution ─────────────────────────────────────────────────

/**
 * Resolve `(path, bundleId)` into the component + adapter that dispatches
 * `recognize` for it, exactly the way `indexer.ts` resolves a configured
 * source's provenance (`deriveInstallations`) — `bundleId` becomes the
 * installation id verbatim (a slug-legal `registryId` IS the installation id).
 */
function resolveRootContext(rootPath: string, bundleId: string): RootContext | undefined {
  const component = deriveInstallations([
    { path: rootPath, registryId: bundleId, writable: true, adapterId: configuredAdapterIdForBundle(bundleId) },
  ])[0]?.components[0];
  if (!component) return undefined;
  const adapter = adapterForId(component.adapter);
  if (!adapter) return undefined;
  return { bundleId, component, adapter };
}

/**
 * A bundle's explicitly configured adapter (`bundles.<id>.components.<name>.adapter`),
 * or `undefined` when unconfigured. Without this, `resolveRootContext` built its
 * synthetic single-source `SearchSource` with no `adapterId` at all, so
 * `deriveInstallations` fell through to `detectAdapterId` — silently
 * AUTO-DETECTING an adapter instead of respecting one a human explicitly
 * configured, exactly the kind of drift `detectAndPersistBundleAdapters`
 * (indexer.ts) exists to prevent everywhere else. Mirrors the same
 * first-component convention `detectAndPersistBundleAdapters` and
 * `resolveBundleRoot` (below) already use for a single-component bundle.
 */
function configuredAdapterIdForBundle(bundleId: string): string | undefined {
  const bundle = loadConfig().bundles?.[bundleId];
  if (!bundle) return undefined;
  return Object.values(bundle.components ?? {})[0]?.adapter;
}

/** Resolve a configured bundle id back to its root path + component + adapter, for `reconcilePaths`. */
function resolveBundleRoot(
  bundleId: string,
  config: AkmConfig,
): { rootPath: string; component: BundleComponent; adapter: BundleAdapter } | undefined {
  const sources = resolveSourceEntries(undefined, config);
  const installations = deriveInstallations(sources);
  const index = installations.findIndex((installation) => installation.id === bundleId);
  const source = index === -1 ? undefined : sources[index];
  const component = index === -1 ? undefined : installations[index]?.components[0];
  if (!source || !component) return undefined;
  const adapter = adapterForId(component.adapter);
  if (!adapter) return undefined;
  return { rootPath: source.path, component, adapter };
}

/** `includeAllDirectories`/`workflowSymlinkAdapter` mirror the full-index walk's own adapter-specific options exactly. */
function walkOptionsFor(component: BundleComponent): WalkStashFlatOptions {
  return {
    includeAllDirectories: component.adapter === "okf",
    ...(component.adapter === "akm" || component.adapter === "akm-workflow"
      ? { workflowSymlinkAdapter: component.adapter }
      : {}),
  };
}

/**
 * #908: a bundle whose explicitly configured adapter is not `akm` can shadow
 * whole top-level directories of ordinary akm-recognizable content (a stash
 * with `content/`, `knowledge/`, `scripts/`, `workflows/`, `workspace/`
 * indexed under, say, `agent-skills` — an adapter that only claims one of
 * those) with zero disclosure: the files are simply never recognized, never
 * indexed, and nothing says why. This warns ONCE per root, naming the count
 * and the directories, not one warning per directory — enough to point an
 * operator at the fix (`components.<name>.adapter: "akm"`).
 *
 * A directory only counts as "skipped" when the CHOSEN adapter recognizes
 * NOTHING in it (so a directory the chosen adapter partially owns is not
 * flagged) AND the `akm` adapter would have recognized at least one file
 * there (so a directory neither adapter cares about — e.g. `.git/`, `node_modules/`
 * — is not a false positive).
 */
function warnIfAdapterSkipsAkmContent(
  component: BundleComponent,
  files: readonly FileContext[],
  adapter: BundleAdapter,
): void {
  if (adapter.id === "akm") return;
  const akm = adapterForId("akm");
  if (!akm) return;

  const byTopDir = new Map<string, FileContext[]>();
  for (const file of files) {
    const top = file.ancestorDirs[0];
    if (!top) continue; // a root-level file is not a "skipped directory" concern
    const group = byTopDir.get(top);
    if (group) group.push(file);
    else byTopDir.set(top, [file]);
  }

  const akmComponent: BundleComponent = { ...component, adapter: "akm" };
  let skippedCount = 0;
  const skippedDirs: string[] = [];
  for (const [dir, dirFiles] of byTopDir) {
    const chosenRecognizesAny = dirFiles.some((file) => {
      try {
        return adapter.recognize(component, file) !== null;
      } catch {
        return false;
      }
    });
    if (chosenRecognizesAny) continue; // the chosen adapter owns this dir; nothing skipped
    const akmCandidates = dirFiles.filter((file) => {
      try {
        return akm.recognize(akmComponent, file) !== null;
      } catch {
        return false;
      }
    });
    if (akmCandidates.length === 0) continue; // akm would drop it too — not a shadowing case
    skippedCount += akmCandidates.length;
    skippedDirs.push(dir);
  }
  if (skippedCount === 0) return;
  skippedDirs.sort();
  warnOnce(
    "adapter-skip-akm-content",
    `${adapter.id} adapter skipped ${skippedCount} file${skippedCount === 1 ? "" : "s"} in ` +
      `${skippedDirs.map((dir) => `${dir}/`).join(", ")} — set components.<name>.adapter to "akm" to index them`,
  );
}

// ── Per-file reconcile ────────────────────────────────────────────────────────

/** A file that needs a write: parsed once, carrying everything `applyChange` needs. */
interface ParsedChange {
  file: FileContext;
  stat: fs.Stats;
  entry: IndexDocument;
  conceptId: string;
  hash: string;
}

/**
 * Classify one walked file against its stored stat hint WITHOUT writing
 * anything: `"unchanged"` short-circuits before any parse; `"unindexable"`
 * covers both "vanished before it could be stat'd" and "no matcher claims it
 * (any more)"; otherwise the file is parsed (the one parse its `ParsedChange`
 * carries forward) and queued for `applyChange`.
 */
function classifyFile(
  ctx: RootContext,
  file: FileContext,
  storedHint: FileStateRow | undefined,
  onWarning?: (message: string, isWorkflowDrop: boolean) => void,
): "unchanged" | "unindexable" | ParsedChange {
  let stat: fs.Stats;
  try {
    stat = file.stat();
  } catch {
    // #791, applied here too (not just the gone-path sweep below): a walker
    // can list a path (a git-tracked listing, say) that a later, individual
    // stat call cannot reach — a permission change or a symlink loop, not
    // "gone". Treating that as "unindexable" would delete any existing row
    // for a file that is still genuinely there. `classifyPathAccess`
    // distinguishes the two; only a truly absent path (or any other
    // unexpected classification) falls through to "unindexable" and its
    // unconditional delete.
    const access = classifyPathAccess(file.absPath);
    if (access.access === "inaccessible") {
      // A known file (a row already exists) is a no-op — "unchanged" leaves
      // that existing row untouched, exactly like the sweep's own
      // `unreadableStale` handling below. A file with NO prior row has
      // nothing to preserve, so silently folding it into `counts.unchanged`
      // would mean it is never indexed and nothing ever says why. Report it
      // through the same channel a parse failure uses, mirroring the
      // gone-path sweep's own unreadable disclosure.
      if (!storedHint) {
        onWarning?.(
          `New file akm cannot read, never indexed: ${describeInaccessiblePath(file.absPath, access.code)}`,
          false,
        );
      }
      return "unchanged";
    }
    return "unindexable";
  }

  // A file's own (size, mtime) cannot move when only its BUNDLE's configured
  // adapter changes — the adapter comparison catches that case and forces a
  // re-parse under the new adapter even though the file on disk is untouched.
  // ctime is compared alongside size/mtime (not size/mtime alone) because an
  // edit that happens to restore the exact same size and mtime (`rsync -a`,
  // `cp -p`, reproducible-build tooling) still moves ctime on every
  // filesystem akm supports — the only signal left standing to catch it.
  if (
    storedHint &&
    storedHint.size === stat.size &&
    storedHint.mtimeMs === stat.mtimeMs &&
    storedHint.ctimeMs === stat.ctimeMs &&
    storedHint.adapterId === ctx.adapter.id
  ) {
    return "unchanged";
  }

  const outcome = parseFileDocument(ctx.adapter, ctx.component, file);
  if (outcome.parsed === null) {
    if (outcome.warning !== null) onWarning?.(outcome.warning, outcome.isWorkflowDrop);
    return "unindexable";
  }

  const hash = outcome.parsed.hash ?? hashContent(file.content());
  return { file, stat, entry: outcome.parsed.entry, conceptId: outcome.parsed.conceptId, hash };
}

/** The `item_ref` a change's own content/path would derive — same inputs `applyChange` itself feeds `deriveEntryProvenance`, exposed separately so Phase 3 can check it BEFORE deciding whether to claim a same-hash rename candidate. */
function deriveItemRefForChange(ctx: RootContext, change: ParsedChange): string {
  return deriveEntryProvenance(
    { bundleId: ctx.bundleId, componentId: ctx.component.id, adapterId: ctx.component.adapter },
    change.entry.type,
    change.entry.name,
    change.conceptId,
  ).itemRef;
}

/**
 * Write one already-parsed change: with a `renameSource`, re-point the
 * existing row at `renameSource.path` in place (`repointEntry`, preserving
 * `entries.id`); otherwise upsert normally (`upsertEntry`, keyed by
 * `item_ref`). Either way, derive units and point `entry_units` at them, all
 * inside one `BEGIN IMMEDIATE` transaction.
 */
function applyChange(
  db: Database,
  ctx: RootContext,
  change: ParsedChange,
  maxChars: number,
  renameSource: FileStateRow | undefined,
  supersedeOtherBundles: boolean,
): FileResult {
  const { file, stat, entry, conceptId, hash } = change;
  const searchText = buildSearchText(entry);
  const provenance = deriveEntryProvenance(
    { bundleId: ctx.bundleId, componentId: ctx.component.id, adapterId: ctx.component.adapter },
    entry.type,
    entry.name,
    conceptId,
  );
  const entryWithSize: IndexDocument = { ...entry, fileSize: stat.size };
  if (hasMarkdownFragmentContent(entry)) setMarkdownFragmentContent(entryWithSize, getMarkdownFragmentContent(entry));

  // Populated inside the transaction below (F4), then pruned AFTER it
  // commits — see the call site past `withImmediateTransaction` for why.
  let orphanedUnitHashes: string[] = [];

  const result = withImmediateTransaction(
    db,
    () => {
      // A materialized file has one current owner: if `entries` already holds a
      // row at this exact path under a DIFFERENT item_ref — the same physical
      // file reconciled earlier under another bundle identity (a config change,
      // or a write path with no stable configured bundle to anchor to) — drop
      // that stale row before publishing the canonical one below, mirroring
      // the pre-redesign write path's own supersede check
      // (index-written-assets.ts's prior `supersededIds` logic). Without this a
      // second identity's reconcile leaves two rows at one file_path and any
      // plain `WHERE file_path = ?` lookup can return either.
      //
      // `reconcileRoots`'s full walk passes `supersedeOtherBundles: false`: a
      // NESTED bundle (`akm bundle add ./vendor` where vendor sits inside the
      // primary stash) walks the same physical file from BOTH roots by design
      // — the enclosing bundle's own path-derived conceptId and the nested
      // bundle's own conceptId are two legitimate, simultaneously-valid
      // identities for it, and an unqualified ref can only resolve through the
      // enclosing bundle's copy (`lookupBundleRefWithResolutionUsing`,
      // indexer.ts, stops at the first candidate whose physical owner has no
      // matching row rather than trying a later, more specific source). Which
      // of the two ends up the durable survivor when they physically collide on
      // the SAME file is `resolvePhysicalOverlaps`'s job, run once after every
      // root has had its own turn (see its own doc comment) — not this
      // per-file, order-dependent supersede. Only `reconcilePaths` (the
      // write-time path, which reconciles ONE bundle at a time with no
      // whole-root visibility into a sibling bundle that might physically
      // overlap it, so it has no later pass to rely on) still needs the
      // stale-identity cleanup this guards.
      if (supersedeOtherBundles) supersedeOtherItemRefsAtPath(db, file.absPath, provenance.itemRef);
      const written = renameSource
        ? repointOrInsert(db, renameSource.path, file.absPath, entryWithSize, searchText, provenance, hash)
        : upsertOrInsert(db, file.absPath, entryWithSize, searchText, provenance, hash);
      if (renameSource) deleteFileStates(db, [renameSource.path]);
      upsertFileState(db, {
        path: file.absPath,
        bundleId: ctx.bundleId,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        ctimeMs: stat.ctimeMs,
        blobHash: hash,
        adapterId: ctx.adapter.id,
      });

      const units = deriveUnits(toUnitSource(written.entryId, entry), maxChars);
      const { inserted } = insertNewUnitTexts(
        db,
        units.map((unit) => ({
          hash: unit.hash,
          kind: unit.fragmentId === null ? "card" : "fragment",
          text: unit.text,
        })),
      );
      // Capture the entry's PREVIOUS unit_hash mapping before replaceEntryUnits
      // overwrites it — this write's own replaced hashes are exactly the ones
      // it may have just orphaned (F4). A brand-new entry simply has no prior
      // mapping, so this is empty and nothing below does any work.
      const previousHashes = (
        db.prepare("SELECT unit_hash FROM entry_units WHERE entry_id = ?").all(written.entryId) as {
          unit_hash: string;
        }[]
      ).map((row) => row.unit_hash);
      replaceEntryUnits(
        db,
        written.entryId,
        units.map((unit) => ({ ordinal: unit.ordinal, fragmentId: unit.fragmentId, hash: unit.hash })),
      );
      const currentHashes = new Set(units.map((unit) => unit.hash));
      orphanedUnitHashes = previousHashes.filter((oldHash) => !currentHashes.has(oldHash));

      return {
        outcome: written.outcome,
        unitsAdded: inserted,
        entryId: written.entryId,
        entry: entryWithSize,
        provenance,
      } satisfies FileResult;
    },
    "index",
  );

  // Outside the transaction (mirroring reconcileRoots's own end-of-run
  // pruneOrphanUnitTexts, which also runs after every per-file write has
  // committed): a hash this write replaced is only ACTUALLY orphaned once
  // nothing else references it, and pruneOrphanUnitTextsForHashes checks
  // that itself — narrow, hash-scoped cleanup instead of reconcileRoots's
  // whole-table sweep, so `reconcilePaths` (which never ran that sweep) no
  // longer leaks a replaced unit's text/FTS rows forever on every edit.
  // Vectors are untouched: dropping unit_texts never drops units/units_vec.
  if (orphanedUnitHashes.length > 0) pruneOrphanUnitTextsForHashes(db, orphanedUnitHashes);

  return result;
}

interface WrittenRow {
  entryId: number;
  outcome: "added" | "changed";
}

/** The ordinary path: `upsertEntry`, keyed by `item_ref` — a fresh row if none existed at this path before, else an update in place. */
function upsertOrInsert(
  db: Database,
  filePath: string,
  entry: IndexDocument,
  searchText: string,
  provenance: EntryProvenance,
  hash: string,
): WrittenRow {
  const existedBefore = getFileState(db, filePath) !== undefined;
  const entryId = upsertEntry(db, filePath, entry, searchText, provenance, hash);
  return { entryId, outcome: existedBefore ? "changed" : "added" };
}

/**
 * The rename path: find the entries row still sitting at `oldPath` and
 * re-point it at `newPath` in place, preserving its id. Falls back to a
 * plain insert on the (should-not-happen) case where the stale `files` row
 * outlived its `entries` row.
 */
function repointOrInsert(
  db: Database,
  oldPath: string,
  newPath: string,
  entry: IndexDocument,
  searchText: string,
  provenance: EntryProvenance,
  hash: string,
): WrittenRow {
  const oldRow = db.prepare("SELECT id FROM entries WHERE file_path = ?").get(oldPath) as { id: number } | undefined;
  if (!oldRow) return upsertOrInsert(db, newPath, entry, searchText, provenance, hash);
  // A blob-hash match is only a genuine rename when the identity the NEW
  // path's own content derives (`provenance.itemRef`) is not ALREADY a
  // different, established row. Two independently-named files that happen
  // to be byte-identical (e.g. an un-cleaned-up duplicate memory) hash-match
  // a "gone" row that is not really them renamed — it just happens to share
  // bytes with something that went away elsewhere. Repointing onto an
  // item_ref another row already legitimately holds would collide on the
  // UNIQUE constraint, and would be wrong even if it somehow did not: it
  // would silently reassign that OTHER row's id/embeddings/utility scores
  // onto this unrelated file. Fall back to a plain upsert at the new path
  // instead — the existing row for THIS identity updates in place as usual,
  // and the old "gone" row is left unclaimed for Phase 4's ordinary delete.
  const claimedByOther = db
    .prepare("SELECT 1 FROM entries WHERE item_ref = ? AND id <> ?")
    .get(provenance.itemRef, oldRow.id);
  if (claimedByOther) return upsertOrInsert(db, newPath, entry, searchText, provenance, hash);
  repointEntry(db, oldRow.id, newPath, entry, searchText, provenance, hash);
  return { entryId: oldRow.id, outcome: "changed" };
}

/** UPDATE one `entries` row in place — same id, new path/identity/content — and refresh its safe-fragment source. */
function repointEntry(
  db: Database,
  entryId: number,
  filePath: string,
  entry: IndexDocument,
  searchText: string,
  provenance: EntryProvenance,
  contentHash: string,
): void {
  const derivedFrom =
    typeof entry.derivedFrom === "string" && entry.derivedFrom.trim() ? entry.derivedFrom.trim() : null;
  db.prepare(
    `UPDATE entries SET item_ref = ?, bundle_id = ?, component_id = ?, concept_id = ?, adapter_id = ?, type = ?,
       file_path = ?, content_hash = ?, document_json = ?, search_text = ?, derived_from = ?
     WHERE id = ?`,
  ).run(
    provenance.itemRef,
    provenance.bundleId,
    provenance.componentId,
    provenance.conceptId,
    provenance.adapterId,
    entry.type,
    filePath,
    contentHash,
    JSON.stringify(entry),
    searchText,
    derivedFrom,
    entryId,
  );
  replaceFragmentSource(
    db,
    entryId,
    hasMarkdownFragmentContent(entry) ? (getMarkdownFragmentContent(entry) ?? null) : undefined,
  );
}

/** Delete any `entries` row at `filePath` whose `item_ref` is not `keepItemRef` (cascade removes its `entry_units`). Must run inside the caller's own transaction. */
function supersedeOtherItemRefsAtPath(db: Database, filePath: string, keepItemRef: string): void {
  const staleIds = (
    db.prepare("SELECT id FROM entries WHERE file_path = ? AND item_ref <> ?").all(filePath, keepItemRef) as {
      id: number;
    }[]
  ).map((row) => row.id);
  if (staleIds.length > 0) deleteEntriesByIds(db, staleIds);
}

/**
 * Resolve every file_path this run's `roots` disagree about: when it has
 * `entries` rows under more than one of THESE bundles, keep exactly one and
 * delete the rest, then repoint the shared `files` stat-cache row at the
 * winner. Two bundles can only physically share one file when one bundle's
 * root contains the other's (there is no other way for the same absolute
 * path to fall under two distinct configured roots), so comparing resolved
 * root-path length is sufficient to find the more specific (longer) root's
 * sibling and the broader (shorter, outer) root that contains it — the outer
 * root's row wins, mirroring the pre-redesign read path's own
 * `findSourceForPath` "more specific source is attributed the asset for
 * POLICY purposes, but the outer bundle is still what a plain unqualified ref
 * resolves through" split: the physical-owner arbitration in
 * `resolveAdapterConceptOwner`/`findSourceForPath` already picks the more
 * specific source for a raw path lookup regardless of which bundle's index
 * row exists, so the index only needs to keep ONE durable identity per file
 * and the outer bundle's is the one every unqualified/enclosing ref depends
 * on. A collision naming a bundleId outside `roots` (some other, unrelated
 * bundle this call was not asked to reconcile) is left alone.
 */
function resolvePhysicalOverlaps(db: Database, roots: readonly { path: string; bundleId: string }[]): void {
  if (roots.length < 2) return;
  const rootPathByBundle = new Map(roots.map((root) => [root.bundleId, path.resolve(root.path)]));

  const collisions = db
    .prepare(
      `SELECT file_path FROM entries WHERE file_path IN (
         SELECT file_path FROM entries GROUP BY file_path HAVING COUNT(DISTINCT bundle_id) > 1
       ) GROUP BY file_path`,
    )
    .all() as { file_path: string }[];

  for (const { file_path: filePath } of collisions) {
    withImmediateTransaction(
      db,
      () => {
        const rows = db.prepare("SELECT id, bundle_id AS bundleId FROM entries WHERE file_path = ?").all(filePath) as {
          id: number;
          bundleId: string;
        }[];
        if (rows.length < 2 || !rows.every((row) => rootPathByBundle.has(row.bundleId))) return;

        let winner = rows[0]!;
        for (const row of rows) {
          if (
            (rootPathByBundle.get(row.bundleId) ?? "").length < (rootPathByBundle.get(winner.bundleId) ?? "").length
          ) {
            winner = row;
          }
        }
        const losers = rows.filter((row) => row.id !== winner.id);
        deleteEntriesByIds(
          db,
          losers.map((row) => row.id),
        );

        // `files` has one row per path (the global PK), so whichever losing
        // bundle wrote it last this run may currently own its tracking even
        // though it just lost the collision. Repoint it at the winner with a
        // fresh stat: the winner's own next reconcile then sees this path as
        // already tracked (an "unchanged" short-circuit), and a demoted loser
        // sees it as untracked — able to compete again if it ever regains sole
        // physical access to the file.
        try {
          const stat = fs.statSync(filePath);
          const winnerRow = db
            .prepare("SELECT content_hash AS hash, adapter_id AS adapterId FROM entries WHERE id = ?")
            .get(winner.id) as { hash: string; adapterId: string } | undefined;
          if (winnerRow) {
            upsertFileState(db, {
              path: filePath,
              bundleId: winner.bundleId,
              size: stat.size,
              mtimeMs: stat.mtimeMs,
              ctimeMs: stat.ctimeMs,
              blobHash: winnerRow.hash,
              adapterId: winnerRow.adapterId,
            });
          }
        } catch {
          // Vanished between the write and this pass — the next gone-path sweep handles it.
        }
      },
      "index",
    );
  }
}

/** Delete a gone path's `entries` row (cascade removes `entry_units`) and its `files` row. Returns whether anything existed. */
function deleteFileAndEntryByPath(db: Database, filePath: string): boolean {
  return withImmediateTransaction(
    db,
    () => {
      const entryIds = (db.prepare("SELECT id FROM entries WHERE file_path = ?").all(filePath) as { id: number }[]).map(
        (row) => row.id,
      );
      if (entryIds.length > 0) deleteEntriesByIds(db, entryIds);
      const hadFileRow = getFileState(db, filePath) !== undefined;
      if (hadFileRow) deleteFileStates(db, [filePath]);
      return entryIds.length > 0 || hadFileRow;
    },
    "index",
  );
}

// ── Small helpers ─────────────────────────────────────────────────────────────

function emptyCounts(): ReconcileCounts {
  return { scanned: 0, unchanged: 0, added: 0, changed: 0, removed: 0, unitsAdded: 0, complete: true, warnings: [] };
}

function applyOutcome(counts: ReconcileCounts, result: FileResult): void {
  if (result.outcome === "added") counts.added++;
  else counts.changed++;
  counts.unitsAdded += result.unitsAdded;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("reconcile interrupted");
}
