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
 * `IndexDocument` is the sole cross-layer type dependency and it is intentionally
 * imported type-only from the indexer metadata pass (its rename/relocation is a
 * later slice); nothing here imports a repository, so this module never
 * re-enters a cycle.
 */

import type { IndexDocument } from "../../indexer/passes/metadata";
import type { LexicalQueryExecution } from "../../indexer/search/fts-query";

/**
 * Durable bundle-adapter identity attached to every current `entries` row.
 * `item_ref` is the canonical `<bundle>//<concept-id>` stored spelling (§1.3).
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
  filePath: string;
  entry: IndexDocument;
  searchText: string;
  /** Canonical durable ref from `entries.item_ref`. */
  itemRef: string;
  /**
   * Chunk-5 flip (Checkpoint A): the durable `concept_id`/`bundle_id` provenance
   * columns, surfaced from the `entries` row so state.db readers can reconstruct
   * the fully-qualified `<bundle>//<concept-id>` key with no extra query.
   * Undefined provenance marks an invalid indexed row.
   */
  conceptId: string;
  bundleId: string;
  componentId: string;
  adapterId: string;
  type: string;
  contentHash?: string;
}

/** One FTS5 search hit joined back to its `entries` row. */
export interface DbSearchResult {
  id: number;
  filePath: string;
  entry: IndexDocument;
  searchText: string;
  bm25Score: number;
  /** Fixed-calibrated lexical contribution; fragment and parent FTS tables are
   * not asserted to have directly comparable raw BM25 magnitudes. */
  lexicalScore?: number;
  /** Present only when a single safe Markdown fragment independently matched. */
  fragmentId?: string;
  /**
   * Chunk-5 flip F5d (Step 2): the durable fully-qualified `<bundle>//<concept-id>`
   * stored spelling from the `entries.item_ref` column, surfaced onto the search
   * read path so salience keys on durable identity. Null provenance marks an
   * invalid indexed row.
   */
  itemRef: string;
  bundleId: string;
  conceptId: string;
  adapterId: string;
  /** Which stage of the single progressive lexical plan produced this row. */
  lexicalMatch: LexicalQueryExecution;
}

/** One nearest-neighbour hit from the vector index (id + L2 distance). */
export interface DbVecResult {
  id: number;
  distance: number;
}

/** Parameters for `rekeyEntryInPlace`. */
export interface RekeyEntryOptions {
  /** New canonical asset name, written into `document_json.name`. */
  newName: string;
  /** Absolute path of the renamed file. */
  newFilePath: string;
  /**
   * Old canonical conceptId. Together with {@link newRef} this drives the
   * `usage_events.entry_ref` rewrite —
   * `entry_ref` (not `entry_id`) is the STABLE column `relinkUsageEvents`
   * uses to re-attach events after a full rebuild re-mints every entry id,
   * so leaving old-ref events behind would reset the asset's usage/utility
   * history at the first `akm index --full`.
   */
  oldRef: string;
  /** New canonical conceptId. */
  newRef: string;
  /** Configured source identity owning the moved entry. */
  sourceName: string;
  /** Absolute source root owning the moved entry. */
  sourceRoot: string;
  /**
   * For memory `.derived` twins: the base memory's new conceptId, written into
   * the `derived_from` column and
   * `document_json.derivedFrom`. Omit to leave both untouched.
   */
  newDerivedFrom?: string;
}

/** Options for {@link getRetrievalCounts} scoping. */
export interface RetrievalCountOptions {
  /** Configured source identity persisted in qualified usage refs. */
  sourceName?: string;
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
  /** Ordered sources from the active index run. */
  sources?: readonly UsageEventRelinkSource[];
  /** Default root from the active index run. Bare durable refs are not relinked. */
  defaultStashDir?: string;
  /** Attached state.db schema used by the source-update unified transaction. */
  stateSchema?: string;
}
