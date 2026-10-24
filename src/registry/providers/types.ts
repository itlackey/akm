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
 * - `static-index` — reads v2/v3 JSON indexes from the official akm registry
 *   and static-hosted team registries.
 * - `skills-sh` — wraps the skills.sh REST API.
 *
 * The contract is a single `search()` method, the orchestrator's only entry
 * point.
 */

import type { RegistryConfigEntry } from "../../core/config/config";
import type { RegistrySearchHit } from "../types";

export interface RegistryProviderSearchOptions {
  query: string;
  /** Maximum number of results to return. Always in range [1, 100]. */
  limit: number;
}

export interface RegistryProviderResult {
  hits: RegistrySearchHit[];
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
