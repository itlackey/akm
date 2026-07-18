// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Shared row/result/option TYPES for the `index.db` storage repositories.
 *
 * A LEAF types module (WI-5a): the `index.db` repos and the indexer passes that
 * feed them both import these shapes from here instead of reaching across the
 * storage↔indexer boundary into `db.ts` — which is what used to pin the
 * `db.ts` / `entry-mapper.ts` / `schema.ts` trio inside the import cycle.
 *
 * `StashEntry` is the sole cross-layer type dependency and it is intentionally
 * imported type-only from the indexer metadata pass (its rename/relocation is a
 * later slice); nothing here imports a repository, so this module never
 * re-enters a cycle.
 */

import type { StashEntry } from "../../indexer/passes/metadata";

/**
 * Chunk-5 Step 2 (spec §14.4): the durable bundle-adapter identity + provenance
 * a writer attaches to an `entries` row, persisted to the additive `item_ref`/
 * `bundle_id`/`component_id`/`concept_id`/`adapter_id` columns. Optional on the
 * write path during the transition — a caller that cannot yet derive the bundle
 * (e.g. the write-back fast-path) passes `undefined` and the columns stay NULL
 * until the next full `akm index` repopulates them. `item_ref` is the canonical
 * `<bundle>//<concept-id>` stored spelling (§1.3), equal to `IndexDocument.ref`.
 */
export interface EntryProvenance {
  itemRef: string;
  bundleId: string;
  componentId: string;
  conceptId: string;
  adapterId: string;
}

/** A fully-materialised indexed entry mapped from an `entries` row. */
export interface DbIndexedEntry {
  id: number;
  entryKey: string;
  dirPath: string;
  filePath: string;
  stashDir: string;
  entry: StashEntry;
  searchText: string;
}

/** One FTS5 search hit joined back to its `entries` row. */
export interface DbSearchResult {
  id: number;
  filePath: string;
  entry: StashEntry;
  searchText: string;
  bm25Score: number;
}

/** One nearest-neighbour hit from the vector index (id + L2 distance). */
export interface DbVecResult {
  id: number;
  distance: number;
}

/** Per-directory incremental-index state row. */
export interface IndexDirState {
  dirPath: string;
  fileSetHash: string;
  fileMtimeMaxMs: number;
  reason: string;
  updatedAt: string;
}

/** A raw `(file_path, entry_json)` pair from the `entries` table. */
export interface EntryRefRow {
  file_path: string;
  entry_json: string;
}

/** Parameters for `rekeyEntryInPlace`. */
export interface RekeyEntryOptions {
  /** Current `entry_key` of the row to re-key (`<stashDir>:<type>:<oldName>`). */
  oldEntryKey: string;
  /** New `entry_key` after the rename (`<stashDir>:<type>:<newName>`). */
  newEntryKey: string;
  /** New canonical asset name, written into `entry_json.name`. */
  newName: string;
  /** Absolute path of the renamed file (feeds `file_path` / `dir_path`). */
  newFilePath: string;
  /**
   * Old canonical bare ref (`type:oldName`, `makeAssetRef` form). Together
   * with {@link newRef} this drives the `usage_events.entry_ref` rewrite —
   * `entry_ref` (not `entry_id`) is the STABLE column `relinkUsageEvents`
   * uses to re-attach events after a full rebuild re-mints every entry id,
   * so leaving old-ref events behind would reset the asset's usage/utility
   * history at the first `akm index --full`.
   */
  oldRef: string;
  /** New canonical bare ref (`type:newName`, `makeAssetRef` form). */
  newRef: string;
  /** Configured source identity owning the moved entry. */
  sourceName?: string;
  /** Absolute source root owning the moved entry. */
  sourceRoot?: string;
  /** Whether pre-source-qualification bare usage refs belong to this source. */
  includeLegacyBare?: boolean;
  /**
   * For memory `.derived` twins: the base memory's NEW ref (e.g.
   * `memory:projectA/new-name`), written into the `derived_from` column and
   * `entry_json.derivedFrom`. Omit to leave both untouched.
   */
  newDerivedFrom?: string;
}

/** Options for {@link getRetrievalCounts} scoping. */
export interface RetrievalCountOptions {
  /** Configured source identity persisted in qualified usage refs. */
  sourceName?: string;
  /** Selected source root used to validate usage-event entry IDs. */
  stashDir?: string;
  /** Accept detached pre-cutover bare events only for the historical local source. */
  includeLegacyBare?: boolean;
}

/** Aggregated per-entry utility metrics. */
export interface UtilityScoreData {
  utility: number;
  showCount: number;
  searchCount: number;
  selectRate: number;
  lastUsedAt?: string;
}

/** A full `utility_scores` row. */
export interface UtilityScoreRow extends UtilityScoreData {
  entryId: number;
  updatedAt: string;
}

/** A single row from `utility_scores_scoped`. */
export interface ScopedUtilityRow {
  entryId: number;
  scopeKey: string;
  utility: number;
  lastUsedAt: number;
}

/**
 * A cached LLM enrichment result keyed by a stable asset_ref string.
 * The body_hash (SHA-256 hex) guards against stale results when the
 * underlying file changes between index runs.
 */
export interface LlmCacheEntry {
  assetRef: string;
  cacheVariant: string;
  bodyHash: string;
  resultJson: string;
  updatedAt: number;
}

/** Source mapping used to preserve qualified usage-event identity while relinking. */
export interface UsageEventRelinkSource {
  path: string;
  registryId?: string;
}

export interface RelinkUsageEventsOptions {
  /** Ordered sources from the active index run; the first source owns `local//`. */
  sources?: readonly UsageEventRelinkSource[];
  /** Explicit historical/default root allowed to adopt legacy bare refs. */
  defaultStashDir?: string;
}
