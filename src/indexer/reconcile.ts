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
import type { AkmConfig } from "../core/config/config";
import { loadConfig } from "../core/config/config";
import { withImmediateTransaction } from "../core/state-db";
import { probeProviderLimits, unitMaxChars } from "../llm/embedders/provider-limits";
import type { Database } from "../storage/database";
import {
  deleteFileStates,
  type FileStateRow,
  getFileState,
  getFileStatesByBundle,
  insertNewUnitTexts,
  pruneOrphanUnitTexts,
  upsertFileState,
} from "../storage/repositories/files-repository";
import { deleteEntriesByIds, upsertEntry } from "../storage/repositories/index-entries-repository";
import type { EntryProvenance } from "../storage/repositories/index-entry-types";
import { replaceFtsEntry } from "../storage/repositories/index-fts-repository";
import { replaceEntryUnits } from "../storage/repositories/units-repository";
import { deriveEntryProvenance, deriveInstallations } from "./installations";
import {
  getMarkdownFragmentContent,
  hasMarkdownFragmentContent,
  type IndexDocument,
  setMarkdownFragmentContent,
} from "./passes/metadata";
import { parseFileDocument } from "./scan/parse-file";
import { buildSearchFields, buildSearchText } from "./search/search-fields";
import { resolveSourceEntries } from "./search/search-source";
import { deriveUnits, type UnitSource } from "./units/unit";
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
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Stat-walk every root, hash files whose (size, mtime) moved or are new,
 * derive new blob hashes, delete gone paths. Idempotent.
 */
export async function reconcileRoots(
  db: Database,
  roots: readonly { path: string; bundleId: string }[],
  opts?: { signal?: AbortSignal; onProgress?: (line: string) => void },
): Promise<ReconcileCounts> {
  const counts = emptyCounts();
  const config = loadConfig();
  const maxChars = unitMaxChars(await probeProviderLimits(config.embedding ?? {}, { signal: opts?.signal }));

  for (const root of roots) {
    throwIfAborted(opts?.signal);

    const ctx = resolveRootContext(root.path, root.bundleId);
    if (!ctx) {
      opts?.onProgress?.(`Skipping "${root.path}": no adapter resolved for bundle "${root.bundleId}".`);
      continue;
    }

    const walked = walkStashFlatWithStatus(root.path, walkOptionsFor(ctx.component));
    counts.scanned += walked.files.length;

    const storedByPath = new Map(getFileStatesByBundle(db, root.bundleId).map((row) => [row.path, row]));
    const currentPaths = new Set(walked.files.map((file) => file.absPath));

    // Phase 1: classify every walked file without writing anything yet.
    // Unchanged files short-circuit on the stat hint alone; everything else
    // is parsed once (yielding the hash a rename match needs) and queued.
    const pendingChanges: ParsedChange[] = [];
    for (const file of walked.files) {
      throwIfAborted(opts?.signal);
      const classified = classifyFile(ctx, file, storedByPath.get(file.absPath));
      if (classified === "unchanged") {
        counts.unchanged++;
      } else if (classified === "unindexable") {
        if (deleteFileAndEntryByPath(db, file.absPath)) counts.removed++;
      } else {
        pendingChanges.push(classified);
      }
    }

    // Phase 2: gone paths (only when the walk was trustworthy — see below),
    // indexed by blob hash so phase 3 can recognize a same-bundle rename
    // instead of a delete paired with an unrelated insert.
    //
    // An incomplete walk (a listing or stat failure somewhere under the root)
    // must never be read as "everything else is gone" — that would cascade a
    // transient scan failure into a mass delete. Additions/edits this walk DID
    // see are still applied above; only the gone-path sweep is skipped.
    const goneByHash = new Map<string, FileStateRow[]>();
    if (walked.complete) {
      for (const stale of storedByPath.values()) {
        if (currentPaths.has(stale.path)) continue;
        const bucket = goneByHash.get(stale.blobHash);
        if (bucket) bucket.push(stale);
        else goneByHash.set(stale.blobHash, [stale]);
      }
    } else {
      opts?.onProgress?.(`"${root.path}" was not scanned completely; preserving rows this walk could not see.`);
    }

    // Phase 3: apply every queued change, claiming a rename match when one exists.
    for (const change of pendingChanges) {
      throwIfAborted(opts?.signal);
      const renameSource = goneByHash.get(change.hash)?.shift();
      applyOutcome(counts, applyChange(db, ctx, change, maxChars, renameSource));
    }

    // Phase 4: whatever gone rows no rename claimed are genuinely gone.
    for (const bucket of goneByHash.values()) {
      for (const stale of bucket) {
        throwIfAborted(opts?.signal);
        if (deleteFileAndEntryByPath(db, stale.path)) counts.removed++;
      }
    }

    opts?.onProgress?.(`Reconciled "${root.path}": ${walked.files.length} files scanned.`);
  }

  pruneOrphanUnitTexts(db);

  return counts;
}

/** The same per-file step for a known list of paths (the write paths call this inline). */
export async function reconcilePaths(
  db: Database,
  paths: readonly string[],
  bundleId: string,
): Promise<ReconcileCounts> {
  const counts = emptyCounts();
  if (paths.length === 0) return counts;

  const config = loadConfig();
  const root = resolveBundleRoot(bundleId, config);
  if (!root) return counts;

  const maxChars = unitMaxChars(await probeProviderLimits(config.embedding ?? {}));
  const ctx: RootContext = { bundleId, component: root.component, adapter: root.adapter };

  for (const rawPath of paths) {
    counts.scanned++;
    const absPath = path.resolve(rawPath);
    if (!fs.existsSync(absPath)) {
      if (deleteFileAndEntryByPath(db, absPath)) counts.removed++;
      continue;
    }
    const file = buildFileContext(root.rootPath, absPath);
    const classified = classifyFile(ctx, file, getFileState(db, absPath));
    if (classified === "unchanged") counts.unchanged++;
    else if (classified === "unindexable") {
      if (deleteFileAndEntryByPath(db, absPath)) counts.removed++;
    } else {
      // No rename matching for the known-paths write path (index-redesign B1
      // scoping decision): the caller already knows exactly which paths it
      // just wrote, so there is no gone-path pool here to correlate against.
      applyOutcome(counts, applyChange(db, ctx, classified, maxChars, undefined));
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
  const component = deriveInstallations([{ path: rootPath, registryId: bundleId, writable: true }])[0]?.components[0];
  if (!component) return undefined;
  const adapter = adapterForId(component.adapter);
  if (!adapter) return undefined;
  return { bundleId, component, adapter };
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
): "unchanged" | "unindexable" | ParsedChange {
  let stat: fs.Stats;
  try {
    stat = file.stat();
  } catch {
    return "unindexable";
  }

  if (storedHint && storedHint.size === stat.size && storedHint.mtimeMs === stat.mtimeMs) return "unchanged";

  const outcome = parseFileDocument(ctx.adapter, ctx.component, file);
  if (outcome.parsed === null) return "unindexable";

  const hash = outcome.parsed.hash ?? hashContent(file.content());
  return { file, stat, entry: outcome.parsed.entry, conceptId: outcome.parsed.conceptId, hash };
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

  return withImmediateTransaction(db, () => {
    const written = renameSource
      ? repointOrInsert(db, renameSource.path, file.absPath, entryWithSize, searchText, provenance, hash)
      : upsertOrInsert(db, file.absPath, entryWithSize, searchText, provenance, hash);
    if (renameSource) deleteFileStates(db, [renameSource.path]);
    upsertFileState(db, {
      path: file.absPath,
      bundleId: ctx.bundleId,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      blobHash: hash,
    });

    const units = deriveUnits(toUnitSource(written.entryId, entry), maxChars);
    const { inserted } = insertNewUnitTexts(
      db,
      units.map((unit) => ({ hash: unit.hash, kind: unit.fragmentId === null ? "card" : "fragment", text: unit.text })),
    );
    replaceEntryUnits(
      db,
      written.entryId,
      units.map((unit) => ({ ordinal: unit.ordinal, fragmentId: unit.fragmentId, hash: unit.hash })),
    );

    return { outcome: written.outcome, unitsAdded: inserted } satisfies FileResult;
  });
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
  repointEntry(db, oldRow.id, newPath, entry, searchText, provenance, hash);
  return { entryId: oldRow.id, outcome: "changed" };
}

/** UPDATE one `entries` row in place — same id, new path/identity/content — and refresh its FTS projection. */
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
  replaceFtsEntry(
    db,
    entryId,
    entry,
    hasMarkdownFragmentContent(entry) ? (getMarkdownFragmentContent(entry) ?? null) : undefined,
  );
}

/** Delete a gone path's `entries` row (cascade removes `entry_units`) and its `files` row. Returns whether anything existed. */
function deleteFileAndEntryByPath(db: Database, filePath: string): boolean {
  return withImmediateTransaction(db, () => {
    const entryIds = (db.prepare("SELECT id FROM entries WHERE file_path = ?").all(filePath) as { id: number }[]).map(
      (row) => row.id,
    );
    if (entryIds.length > 0) deleteEntriesByIds(db, entryIds);
    const hadFileRow = getFileState(db, filePath) !== undefined;
    if (hadFileRow) deleteFileStates(db, [filePath]);
    return entryIds.length > 0 || hadFileRow;
  });
}

/** `UnitSource` from the freshly parsed entry — `buildSearchFields` for the structured fields, the entry's own carried markdown for fragments. */
function toUnitSource(entryId: number, entry: IndexDocument): UnitSource {
  const fields = buildSearchFields(entry);
  return {
    entryId,
    name: fields.name,
    description: fields.description,
    tags: fields.tags,
    hints: fields.hints,
    safeMarkdown: hasMarkdownFragmentContent(entry) ? (getMarkdownFragmentContent(entry) ?? null) : null,
  };
}

// ── Small helpers ─────────────────────────────────────────────────────────────

function emptyCounts(): ReconcileCounts {
  return { scanned: 0, unchanged: 0, added: 0, changed: 0, removed: 0, unitsAdded: 0 };
}

function applyOutcome(counts: ReconcileCounts, result: FileResult): void {
  if (result.outcome === "added") counts.added++;
  else counts.changed++;
  counts.unitsAdded += result.unitsAdded;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("reconcile interrupted");
}
