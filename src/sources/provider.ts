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
 *   - Reads:     src/indexer/indexer.ts
 *   - Install:   src/sources/providers/sync-from-ref.ts
 */

import type { SourceConfigEntry } from "../core/config/config";
import type { SourceKind } from "./types";

/**
 * Resolves a secret-store ref (e.g. `secrets/x-bearer-token`) to its value, or
 * null when absent.
 *
 * This is a leaf abstraction on purpose. The concrete store reader
 * (`core/env-secret-ref.ts`) transitively imports the source providers, which
 * import the fetcher registry — so any module inside that subgraph that
 * imported the reader directly would close the import cycle the ratchet
 * forbids. Consumers (fetchers, provider `sync()`) depend on this interface;
 * the concrete binding is INJECTED from a composition root above the cycle
 * (see `snapshot-fetchers/secret-seam.ts` and `indexer/indexer.ts`). Keeping
 * the type here — in a module that is a sink of the import graph (it imports
 * only type-only `config` and `./types`) — means `search-source`/`website`
 * can name the type without creating a runtime back-edge.
 *
 * Implementations must never log or otherwise surface the resolved value.
 */
export interface SecretResolver {
  resolveSecret(ref: string): string | null;
}

/** Options the website provider passes to its injected mirror capability. */
export interface WebsiteMirrorOptions {
  requireStashDir?: boolean;
  force?: boolean;
  allowPrivateHosts?: boolean;
  resolveSecret?: SecretResolver["resolveSecret"];
}

/**
 * Materializes a website source into its cache.
 *
 * This capability lives on the provider seam so the website provider can
 * refresh without importing website-ingest and its snapshot-fetcher registry.
 */
export type EnsureWebsiteMirror = (config: SourceConfigEntry, options?: WebsiteMirrorOptions) => Promise<unknown>;

/** Options accepted by {@link SourceProvider.sync}. */
export interface SyncOptions {
  /** Bypass the cache-freshness TTL and re-fetch unconditionally. */
  force?: boolean;
  /**
   * Secret resolver for provider kinds whose refresh needs credentials
   * (today: the website provider's X fetcher). Absent means environment
   * variables only — the documented default.
   */
  secrets?: SecretResolver;
  /**
   * Website mirror implementation supplied by the source-sync composition.
   * Required when invoking a website provider's `sync()`; omitted for other
   * provider kinds. Website sync fails with a `ConfigError` when it is absent
   * so a missing composition binding cannot silently report a refresh.
   */
  ensureWebsiteMirror?: EnsureWebsiteMirror;
}

export interface SourceProvider {
  readonly name: string;
  readonly kind: SourceKind;

  /**
   * The directory the indexer walks. Must return the same path for the
   * lifetime of the provider instance.
   */
  path(): string;

  /**
   * Refresh the directory from upstream. No-op for filesystem.
   */
  sync?(options?: SyncOptions): Promise<void>;
}

/** Factory that builds a provider for a configured source. */
export type SourceProviderFactory = (config: SourceConfigEntry) => SourceProvider;
