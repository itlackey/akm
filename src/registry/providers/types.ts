// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Registry provider interface.
 *
 * A `RegistryProvider` is a read-only catalog that answers discovery queries —
 * it does *not* materialise files to disk (that is a `SourceProvider`). The two
 * built-in providers are:
 *
 * - `static-index` — reads the v2 JSON index schema (the official akm registry
 *   and any static-hosted team registry).
 * - `skills-sh` — wraps the skills.sh REST API.
 *
 * The contract is a single `search()` method (the orchestrator's only entry
 * point). An earlier "v1-spec" surface (`searchKits`/`searchAssets`/`getKit`/
 * `canHandle`) was implemented by every provider but never called by any
 * non-test code; it was removed along with its supporting types.
 */

import type { RegistryConfigEntry } from "../../core/config/config";
import type { RegistryAssetSearchHit, RegistrySearchHit } from "../types";

export interface RegistryProviderSearchOptions {
  query: string;
  /** Maximum number of results to return. Always in range [1, 100]. */
  limit: number;
  includeAssets?: boolean;
}

export interface RegistryProviderResult {
  hits: RegistrySearchHit[];
  assetHits?: RegistryAssetSearchHit[];
  warnings?: string[];
}

export interface RegistryProvider {
  /** Discriminator — e.g. "static-index", "skills-sh". */
  readonly type: string;

  /**
   * Search entry point used by the orchestrator. Implementations must never
   * throw — errors are returned as `warnings[]`.
   */
  search(options: RegistryProviderSearchOptions): Promise<RegistryProviderResult>;
}

export type RegistryProviderFactory = (config: RegistryConfigEntry) => RegistryProvider;
