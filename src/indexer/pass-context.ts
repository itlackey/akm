// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { Database } from "bun:sqlite";
import type { AkmConfig } from "../core/config";
import type { SearchSource } from "./search-source";

/**
 * Parameter object shared by the three indexer pass functions
 * (`runMemoryInferencePass`, `runGraphExtractionPass`,
 * `runStalenessDetectionPass`).
 *
 * WS10 (parameter-object consolidation): these passes previously cloned the
 * same leading positional signature (`config, sources, signal?, db?`). Collapsing
 * it into one value object is TYPE-ONLY — the runtime values threaded through are
 * identical; no branch, order, or lifecycle change.
 *
 * The memory-inference and graph-extraction passes additionally accept a
 * `reEnrich` flag, an `onProgress` callback (whose event shape differs per
 * pass), and a per-pass `options` bag. Those are modelled by extending this
 * base type via the generic parameters below.
 */
export interface PassContext {
  config: AkmConfig;
  sources: SearchSource[];
  signal?: AbortSignal;
  db?: Database;
}

/**
 * {@link PassContext} extended with the enrichment / progress / options fields
 * shared by the memory-inference and graph-extraction passes.
 *
 * @typeParam TProgress - the per-pass progress event shape.
 * @typeParam TOptions  - the per-pass options bag.
 */
export interface EnrichmentPassContext<TProgress, TOptions> extends PassContext {
  /** When true, re-run enrichment even for entries with a valid cache hit. */
  reEnrich?: boolean;
  onProgress?: (event: TProgress) => void;
  options?: TOptions;
}
