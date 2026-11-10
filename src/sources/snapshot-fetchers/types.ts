// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Leaf types for the wiki-fetcher plugin contract (see
 * `sources/snapshot-fetchers/registry.ts`).
 *
 * Split out of `registry.ts` so that `youtube.ts` (a built-in fetcher that
 * `registry.ts` imports by value) does not need a type-only import back into
 * `registry.ts`.
 */

export interface WikiSnapshotResult {
  url: string;
  title: string;
  markdown: string;
  preferredName?: string;
  tags?: string[];
}

/**
 * Resolve a secret by ref (e.g. `secrets/x-bearer-token`) from akm's secret
 * store, or null when absent. Named once here so the crawl plumbing threads a
 * single type rather than re-spelling the signature at each layer.
 *
 * Implementations must never log or otherwise surface the returned value.
 */
export type SecretResolveFn = (ref: string) => string | null;

export interface FetcherContext {
  stashDir: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /**
   * Test-only: permit loopback/private hosts on this fetcher's outbound
   * requests. Mirrors the same hatch in the website crawler; production
   * callers never set it.
   */
  allowPrivateHosts?: boolean;
  /**
   * Resolve a secret by ref (e.g. `secrets/x-bearer-token`) from akm's secret
   * store, or null when absent.
   *
   * Injected rather than imported: `sources/env-secret-ref` transitively imports
   * the source providers, which import the fetcher registry, so a fetcher
   * reading the store directly would form an import cycle. Callers that can
   * already import it populate this; fetchers stay leaves in the import graph.
   *
   * Implementations must never log or otherwise surface the returned value.
   */
  resolveSecret?: SecretResolveFn;
}

export interface WikiSnapshotFetcher {
  name: string;
  matches(url: URL, context: FetcherContext): boolean;
  fetch(url: URL, context: FetcherContext): Promise<WikiSnapshotResult | null>;
}
