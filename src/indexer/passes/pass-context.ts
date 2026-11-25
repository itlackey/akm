// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { adapterWrites } from "../../core/assets/gate";
import type { AkmConfig } from "../../core/config/config";
import { warn } from "../../core/warn";
import { resolveWritable, writeTargetAt } from "../../core/write-source";
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

/** Inference only reads and writes the working directory, never a cache or store. */
export function memoryInferenceRoot(sources: readonly SearchSource[], config: AkmConfig): string | undefined {
  const primary = sources.find((source) => source.isDefault === true);
  if (!primary) {
    warn("memory inference: skipped — no default bundle among the sources, so there is no write target");
    return undefined;
  }
  if (primary.path === undefined || !adapterWrites(primary, "memory")) {
    warn(`memory inference: skipped — the default bundle at ${primary.path ?? primary.bundleId} is not an akm bundle`);
    return undefined;
  }
  const target = writeTargetAt(primary.path, config);
  if (!resolveWritable(target.config)) {
    warn(`memory inference: skipped — bundle "${target.source.name}" is not writable, so its pending memories wait`);
    return undefined;
  }
  return primary.path;
}
