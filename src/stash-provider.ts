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

// ── StashProvider interface ─────────────────────────────────────────────────

export interface StashProvider {
  readonly type: string;
  readonly name: string;
  search(options: StashSearchOptions): Promise<StashSearchResult>;
  show(ref: string, view?: KnowledgeView): Promise<ShowResponse>;
  /**
   * Returns true if this provider can handle the given ref.
   * Providers are checked in registration order; first match wins.
   * Convention: filesystem provider handles all non-viking:// refs,
   * OpenViking provider handles viking:// refs.
   */
  canShow(ref: string): boolean;
}

export type StashProviderFactory = (config: import("./config").StashConfigEntry) => StashProvider;
