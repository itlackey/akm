/**
 * Legacy re-export shim.
 *
 * Phase 6 of the v1 architecture refactor moved the canonical RegistryProvider
 * interface to `src/registry-providers/types.ts`. This module remains as a
 * thin re-export for callers that still import from the old path. New code
 * should import from `./registry-providers/types` directly.
 */

export type {
  AssetPreview,
  KitId,
  KitManifest,
  KitResult,
  RegistryProvider,
  RegistryProviderFactory,
  RegistryProviderResult,
  RegistryProviderSearchOptions,
  RegistryQuery,
} from "./registry-providers/types";
