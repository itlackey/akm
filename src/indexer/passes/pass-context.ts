// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { AkmConfig } from "../../core/config/config";
import type { Database } from "../../storage/database";
import type { SearchSource } from "../search/search-source";

/**
 * Parameter object for the indexer pass functions (`runMemoryInferencePass`;
 * the sibling `runGraphExtractionPass` and `runStalenessDetectionPass` this
 * was shared with were later retired).
 *
 * WS10 (parameter-object consolidation): these passes previously cloned the
 * same leading positional signature (`config, sources, signal?, db?`). Collapsing
 * it into one value object is TYPE-ONLY — the runtime values threaded through are
 * identical; no branch, order, or lifecycle change.
 *
 * The memory-inference pass additionally accepts a `reEnrich` flag, an
 * `onProgress` callback, and a per-pass `options` bag — modelled directly on
 * `MemoryInferencePassContext` (memory-inference.ts). Those three fields used
 * to be factored out into a generic `EnrichmentPassContext<TProgress,
 * TOptions>` shared with the graph-extraction pass; with that pass retired
 * (0.9.17-alpha.9) memory-inference is the only user, so the generic
 * indirection was removed as unneeded abstraction for a single caller.
 */
export interface PassContext {
  config: AkmConfig;
  sources: SearchSource[];
  signal?: AbortSignal;
  db?: Database;
}
