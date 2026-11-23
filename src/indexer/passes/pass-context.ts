// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { AkmConfig } from "../../core/config/config";
import type { Database } from "../../storage/database";
import type { SearchSource } from "../search/search-source";

/**
 * Parameter object for the indexer pass functions (`runMemoryInferencePass`).
 *
 * It replaces the leading positional signature (`config, sources, signal?, db?`) with one
 * value object.
 *
 * The memory-inference pass additionally accepts a `reEnrich` flag, an
 * `onProgress` callback, and a per-pass `options` bag — modelled directly on
 * `MemoryInferencePassContext` (memory-inference.ts).
 */
export interface PassContext {
  config: AkmConfig;
  sources: SearchSource[];
  signal?: AbortSignal;
  db?: Database;
}
