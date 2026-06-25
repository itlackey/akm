// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * SourceProvider — minimal interface.
 *
 * A SourceProvider gets files into a directory. The indexer walks `path()` and
 * reads files from disk; search and show go through the indexer, not through
 * provider methods.
 *
 *   - name      configured source name
 *   - kind      "filesystem" | "git" | "website" | "npm"
 *   - path()    the directory the indexer walks (stable for instance lifetime)
 *   - sync?()   refresh the directory from upstream (no-op for filesystem)
 *
 * All other writing/reading concerns live outside this interface:
 *   - Writes:    src/core/write-source.ts
 *   - Reads:     src/indexer.ts
 *   - Install:   src/sources/providers/sync-from-ref.ts
 *
 * (An earlier `init(ctx)` + `ProviderContext` member was implemented by every
 * provider but never invoked by any caller; both were removed.)
 */

import type { SourceConfigEntry } from "../core/config/config";

export interface SourceProvider {
  readonly name: string;
  /** Discriminator string. Supports "filesystem" | "git" | "website" | "npm". */
  readonly kind: string;

  /**
   * The directory the indexer walks. Must return the same path for the
   * lifetime of the provider instance.
   */
  path(): string;

  /** Refresh the directory from upstream. No-op for filesystem. */
  sync?(): Promise<void>;
}

/** Factory that builds a provider for a configured source. */
export type SourceProviderFactory = (config: SourceConfigEntry) => SourceProvider;
