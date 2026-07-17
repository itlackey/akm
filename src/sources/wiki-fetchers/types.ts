// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Leaf types for the wiki-fetcher plugin contract (see
 * `sources/wiki-fetchers/registry.ts`).
 *
 * Split out of `registry.ts` so that `youtube.ts` (a built-in fetcher that
 * `registry.ts` imports by value) does not need a type-only import back into
 * `registry.ts` — that back-edge is a static-graph cycle even though it is
 * type-only (chunk 9 WI-9.8 KILL 3 sever). `registry.ts` re-exports these
 * types so existing import sites are unaffected.
 */

export interface WikiSnapshotResult {
  url: string;
  title: string;
  markdown: string;
  preferredName?: string;
  tags?: string[];
}

export interface FetcherContext {
  stashDir: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface WikiSnapshotFetcher {
  name: string;
  matches(url: URL, context: FetcherContext): boolean;
  fetch(url: URL, context: FetcherContext): Promise<WikiSnapshotResult | null>;
}
