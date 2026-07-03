// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { AkmConfig } from "../core/config/config";
import { ensureIndex } from "./ensure-index";
import type { SearchSource } from "./search/search-source";
import { resolveSourceEntries } from "./search/search-source";

export interface ReadSourceEnvelope {
  /** Ordered stash/read sources for the current invocation. */
  sources: SearchSource[];
  /** Primary source for this invocation (first in `sources`, if any). */
  primarySource?: SearchSource;
}

/** Resolve the active read sources using the same resolution rules as search/show. */
export function resolveReadSources(overrideStashDir?: string, existingConfig?: AkmConfig): ReadSourceEnvelope {
  const sources = resolveSourceEntries(overrideStashDir, existingConfig);
  return { sources, primarySource: sources[0] };
}

/** Ensure the primary source index is readable for reads, when a primary exists. */
export async function ensurePrimaryIndexForRead(primarySource?: SearchSource): Promise<boolean> {
  if (!primarySource?.path) return false;
  return ensureIndex(primarySource.path);
}

/**
 * Convenience helper for callers that only need to ensure a read index from a
 * configured stash path and default config.
 */
export async function ensurePrimaryIndexFromConfig(
  overrideStashDir?: string,
  existingConfig?: AkmConfig,
): Promise<boolean> {
  return ensurePrimaryIndexForRead(resolveReadSources(overrideStashDir, existingConfig).primarySource);
}
