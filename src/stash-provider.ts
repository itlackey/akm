import type { KnowledgeView, ShowResponse } from "./stash-types";

// ── Stash provider search types ─────────────────────────────────────────────

export interface StashSearchOptions {
  query: string;
  type?: string;
  limit: number;
}

export interface StashSearchResult {
  hits: import("./stash-types").StashSearchHit[];
  warnings?: string[];
  embedMs?: number;
  rankMs?: number;
}

// ── Provider interfaces ─────────────────────────────────────────────────────

/**
 * LiveStashProvider — provider that answers `search()` and `show()` against
 * a live data source on every call.
 *
 * Use this for providers whose content is *not* mirrored to local disk and
 * therefore cannot participate in the FTS5 indexing pipeline (e.g.
 * OpenViking). Local providers whose content is also indexed locally still
 * implement this surface so that callers have a uniform query API; the
 * `search()` method may return an empty hit list and let the FTS5 pipeline
 * supply hits instead.
 */
export interface LiveStashProvider {
  readonly type: string;
  readonly name: string;
  search(options: StashSearchOptions): Promise<StashSearchResult>;
  show(ref: string, view?: KnowledgeView): Promise<ShowResponse>;
  /**
   * Returns true if this provider is available to show assets.
   * Local show is tried first; remote providers are tried as fallbacks.
   */
  canShow(ref: string): boolean;
}

/**
 * SyncableStashProvider — provider that materializes its content onto local
 * disk so the FTS5 indexer can walk it.
 *
 * Use this for cache-backed providers (`git`, `website`) that need a refresh
 * step before the indexer runs. `sync()` ensures the local mirror is fresh,
 * `getContentDir()` returns the directory the indexer should walk, and
 * `remove()` deletes the local mirror.
 *
 * Syncable providers typically also implement {@link LiveStashProvider} (with
 * a no-op `search()`/`show()`) so they show up in the unified provider list.
 */
export interface SyncableStashProvider {
  readonly type: string;
  readonly name: string;
  sync(): Promise<void>;
  getContentDir(): string;
  remove(): Promise<void>;
}

/**
 * @deprecated Use {@link LiveStashProvider} for query-style providers and
 * {@link SyncableStashProvider} for cache-backed providers. `StashProvider`
 * remains as an alias for {@link LiveStashProvider} to keep existing
 * provider implementations source-compatible during the migration.
 */
export type StashProvider = LiveStashProvider;

export type StashProviderFactory = (config: import("./config").StashConfigEntry) => LiveStashProvider;
