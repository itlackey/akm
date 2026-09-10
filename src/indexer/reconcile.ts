// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * stage-2 stub, superseded at merge.
 *
 * Owner: module B1, docs/plans/index-redesign-contract.md. This file exists
 * only so module B2 (`index-written-assets.ts`) can be written and tested
 * against B1's real function signatures before B1 lands. It does NONE of
 * B1's actual job — no `files` table, no blob hashing, no content-addressed
 * `unit_texts` / `units_fts`, no idempotent stat-walk. It reuses today's
 * entries-table upsert (`upsertEntry`) so a targeted write is still
 * lexically searchable through the existing `entries_fts` projection, and
 * derives real unit hashes (stage-1 `deriveUnits`) so B2's `onlyHashes`
 * wiring has real hashes to prove itself against. The integrator deletes
 * this file and takes B1's `src/indexer/reconcile.ts` instead.
 */

import fs from "node:fs";
import { akmAdapter } from "../core/adapter/adapters/akm-adapter";
import type { Database } from "../storage/database";
import { deleteEntriesByIds, upsertEntry } from "../storage/repositories/index-entries-repository";
import { deriveEntryProvenance, deriveInstallations } from "./installations";
import { getMarkdownFragmentContent, hasMarkdownFragmentContent } from "./passes/metadata";
import { drainDirDocuments } from "./scan/drain-dir";
import { buildSearchFields, buildSearchText } from "./search/search-fields";
import { deriveUnits } from "./units/unit";
import { buildFileContext } from "./walk/file-context";

export interface ReconcileCounts {
  scanned: number;
  unchanged: number;
  added: number;
  changed: number;
  removed: number;
  unitsAdded: number;
}

/**
 * Stub-only bound on a unit's text, standing in for B1's real
 * `unitMaxChars(probeProviderLimits(config))` (module A3, not yet merged
 * into this branch). Generous enough that no fixture in this module's own
 * tests overflows it, so the stub never has to replicate the split logic to
 * prove the hash-wiring it exists for.
 */
const STUB_UNIT_MAX_CHARS = 8_000;

/**
 * Stage-2 stub glue: the contract's `ReconcileCounts` carries only a count,
 * not the hashes themselves (B2's `onlyHashes` comes from a DB query against
 * B1's real `entry_units` table once that lands — module A2, also not yet
 * merged into this branch). Until then, `reconcilePaths` records the hashes
 * it derived for each path here so `index-written-assets.ts` can read them
 * back immediately after the call. Keyed by absolute path; each call
 * overwrites only the paths it was given.
 */
const unitHashesByPath = new Map<string, readonly string[]>();

/** Stage-2 stub glue (see {@link unitHashesByPath}): the units B2 should ask B4's drain to embed for `paths`. */
export function unitHashesForPaths(paths: readonly string[]): string[] {
  const hashes = new Set<string>();
  for (const p of paths) for (const h of unitHashesByPath.get(p) ?? []) hashes.add(h);
  return [...hashes];
}

/**
 * Stage-2 stub glue, NOT part of B1's contracted signature: `reconcilePaths`
 * is given only a `bundleId`, on the assumption B1's real implementation
 * resolves that to a stash root itself (e.g. a config lookup, once A2/B1
 * land). This stub has no such resolution, so `index-written-assets.ts`
 * registers the root right before calling `reconcilePaths`, purely so the
 * stub's borrowed recognize/drain pipeline can compute paths relative to it.
 * Flagged for the integrator: confirm whether B1's real `reconcilePaths`
 * needs the root passed explicitly, or derives it from `bundleId`.
 */
const stashRootByBundleId = new Map<string, string>();
export function registerStashRootForBundleId(bundleId: string, root: string): void {
  stashRootByBundleId.set(bundleId, root);
}

export async function reconcileRoots(
  _db: Database,
  _roots: readonly { path: string; bundleId: string }[],
  _opts?: { signal?: AbortSignal; onProgress?: (line: string) => void },
): Promise<ReconcileCounts> {
  // Not exercised by B2 (the write path never walks a whole root) and not
  // needed to prove B2's wiring, so the stub does not implement it.
  throw new Error("reconcileRoots: not implemented by the stage-2 B1 stub — this is B1's real deliverable");
}

/**
 * The per-file step `indexWrittenAssets` (B2) calls inline. Parses each path
 * with the same recognize/drain pipeline the full walk uses, upserts the
 * result through the existing `upsertEntry` (which owns its own `entries_fts`
 * projection, so a written asset is lexically searchable the moment this
 * returns), deletes a path's entry row when the path is gone or unindexable,
 * and derives that entry's embedding units to record their hashes for
 * {@link unitHashesForPaths}. Does not touch `files`, `unit_texts`, or
 * `units_fts` — those are B1's real content-addressed tables.
 */
export async function reconcilePaths(
  db: Database,
  paths: readonly string[],
  bundleId: string,
): Promise<ReconcileCounts> {
  const counts: ReconcileCounts = { scanned: 0, unchanged: 0, added: 0, changed: 0, removed: 0, unitsAdded: 0 };
  const root = stashRootByBundleId.get(bundleId);
  if (!root) throw new Error(`reconcilePaths: no stash root registered for bundle "${bundleId}" (stage-2 stub)`);
  const component = deriveInstallations([{ path: root, writable: true, registryId: bundleId }])[0]?.components[0];
  if (!component) throw new Error(`reconcilePaths: could not derive bundle provenance for ${bundleId}`);

  for (const filePath of paths) {
    counts.scanned++;
    unitHashesByPath.delete(filePath);
    if (!fs.existsSync(filePath)) {
      const removedCount = deleteEntryRows(db, filePath);
      if (removedCount > 0) counts.removed++;
      continue;
    }

    const ctx = buildFileContext(root, filePath);
    const drained = drainDirDocuments(akmAdapter, component, [ctx]);
    const entry = drained.entries[0];
    if (!entry) {
      // Unrecognized or rejected (e.g. a broken workflow) — same outcome as a
      // gone path: nothing left behind that search could serve.
      const removedCount = deleteEntryRows(db, filePath);
      if (removedCount > 0) counts.removed++;
      continue;
    }

    const contentHash = drained.hashByFile.get(ctx.absPath);
    const provenance = deriveEntryProvenance(
      { bundleId: component.id, componentId: component.id, adapterId: component.adapter },
      entry.type,
      entry.name,
      drained.conceptIdByFile.get(ctx.absPath),
    );
    // A materialized file has one current owner: if this write changed what
    // the file resolves to (a rewrite that renames its own concept, e.g. a
    // proposal revert restoring different frontmatter), drop the stale row
    // left at this path under the old item_ref before publishing the new one
    // — otherwise both rows carry the same file_path and a lookup keyed on it
    // can return either.
    const supersededIds = db
      .prepare("SELECT id FROM entries WHERE file_path = ? AND item_ref <> ?")
      .all(filePath, provenance.itemRef) as Array<{ id: number }>;
    if (supersededIds.length > 0)
      deleteEntriesByIds(
        db,
        supersededIds.map((row) => row.id),
      );

    const previous = db.prepare("SELECT content_hash FROM entries WHERE item_ref = ?").get(provenance.itemRef) as
      | { content_hash: string | null }
      | undefined;
    const entryId = upsertEntry(db, filePath, entry, buildSearchText(entry), provenance, contentHash);
    if (!previous) counts.added++;
    else if (previous.content_hash !== (contentHash ?? null)) counts.changed++;
    else counts.unchanged++;

    const fields = buildSearchFields(entry);
    const units = deriveUnits(
      {
        entryId,
        name: fields.name,
        description: fields.description,
        tags: fields.tags,
        hints: fields.hints,
        safeMarkdown: hasMarkdownFragmentContent(entry) ? (getMarkdownFragmentContent(entry) ?? null) : null,
      },
      STUB_UNIT_MAX_CHARS,
    );
    unitHashesByPath.set(
      filePath,
      units.map((u) => u.hash),
    );
    counts.unitsAdded += units.length;
  }

  return counts;
}

function deleteEntryRows(db: Database, filePath: string): number {
  const rows = db.prepare("SELECT id FROM entries WHERE file_path = ?").all(filePath) as Array<{ id: number }>;
  if (rows.length === 0) return 0;
  deleteEntriesByIds(
    db,
    rows.map((r) => r.id),
  );
  return rows.length;
}
