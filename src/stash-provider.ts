import type { StashConfigEntry, StashSource } from "./config";
import type { InstallAuditReport } from "./install-audit";
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
 * therefore cannot participate in the FTS5 indexing pipeline. Local providers
 * whose content is also indexed locally still implement this surface so that
 * callers have a uniform query API; the `search()` method may return an empty
 * hit list and let the FTS5 pipeline supply hits instead.
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
 * @deprecated Use {@link LiveStashProvider} for query-style providers and
 * {@link SyncableStashProvider} for cache-backed providers. `StashProvider`
 * remains as an alias for {@link LiveStashProvider} to keep existing
 * provider implementations source-compatible during the migration.
 */
export type StashProvider = LiveStashProvider;

export type StashProviderFactory = (config: StashConfigEntry) => StashProvider;

// ── SyncableStashProvider interface ────────────────────────────────────────
//
// SyncableStashProvider — provider that materializes its content onto local
// disk so the FTS5 indexer can walk it. Replaces the registry-install pipeline
// (#125) for cache-backed providers (`git`, `npm`, `github`, `website`).
// Syncable providers typically also implement {@link LiveStashProvider} (with
// a no-op `search()`/`show()`) so they show up in the unified provider list.

export interface SyncOptions {
  /** Force a fresh fetch even when cached content is still valid. */
  force?: boolean;
  /** Override "now" — used by tests to make `syncedAt` deterministic. */
  now?: Date;
  /** Skip blocking install audit for this single sync (`--trust`). */
  trustThisInstall?: boolean;
  /** Treat the cloned repo as writable (keeps `.git` and pulls instead of re-cloning). */
  writable?: boolean;
  /** Override cache root directory — primarily for tests. */
  cacheRootDir?: string;
}

export interface StashLockData {
  /** Stable identifier for the source (e.g. npm package name, git owner/repo, local path). */
  id: string;
  /** Source kind — the discriminator string of the originating {@link StashSource}. */
  source: StashSource["type"];
  /** The original ref that was synced (e.g. `npm:foo@1.2.3`). */
  ref: string;
  /** Resolved registry/upstream URL for the artifact, if any. */
  artifactUrl: string;
  /** Resolved semantic version, if applicable. */
  resolvedVersion?: string;
  /** Resolved git revision (commit SHA), if applicable. */
  resolvedRevision?: string;
  /** Content hash of the fetched archive when one was downloaded. */
  integrity?: string;
  /** Absolute path the walker should index. */
  contentDir: string;
  /** Cache directory holding raw + extracted artifacts. */
  cacheDir: string;
  /** Provisional staging directory before include filtering, if any. */
  extractedDir: string;
  /** Whether the synced cache should be treated as writable. */
  writable?: boolean;
  /** Audit report when the post-sync hook is invoked by the orchestrator. */
  audit?: InstallAuditReport;
  /** ISO timestamp at which the sync resolved. */
  syncedAt: string;
}

export interface SyncableStashProvider extends StashProvider {
  readonly kind: "syncable";
  /** Fetch (or refresh) the source and return content directory + lock metadata. */
  sync(config: StashConfigEntry, options?: SyncOptions): Promise<StashLockData>;
  /** Return the on-disk content directory for an already-synced source. */
  getContentDir(config: StashConfigEntry): string;
  /** Remove the on-disk cache for the source. */
  remove(config: StashConfigEntry): Promise<void>;
}

export function isSyncable(p: StashProvider): p is SyncableStashProvider {
  return (p as Partial<SyncableStashProvider>).kind === "syncable";
}
