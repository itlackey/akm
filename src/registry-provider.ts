import type { RegistryConfigEntry } from "./config";
import type { RegistryAssetSearchHit, RegistrySearchHit } from "./registry-types";

// ── Provider interface ──────────────────────────────────────────────────────

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
  readonly type: string;
  /**
   * Search this provider. Implementations must never throw — errors should
   * be caught internally and returned as `warnings[]` in the result.
   * The orchestrator uses Promise.allSettled as a safety net, but providers
   * should handle their own errors for better warning messages.
   */
  search(options: RegistryProviderSearchOptions): Promise<RegistryProviderResult>;
}

export type RegistryProviderFactory = (config: RegistryConfigEntry) => RegistryProvider;
