import { DEFAULT_CONFIG, loadConfig, type RegistryConfigEntry } from "./config";
import { resolveProviderFactory } from "./provider-registry";
import type { RegistryAssetSearchHit, RegistrySearchHit, RegistrySearchResponse } from "./registry-types";

// ── Eagerly import providers to trigger self-registration ───────────────────

import "./providers/static-index";
import "./providers/skills-sh";

// ── Re-exports for backward compatibility ───────────────────────────────────

export type { RegistryIndex, RegistryKitEntry } from "./providers/static-index";
export type { RegistryAssetSearchHit } from "./registry-types";

// ── Types ───────────────────────────────────────────────────────────────────

export interface RegistrySearchOptions {
  limit?: number;
  /** Override registries. Accepts an array of RegistryConfigEntry objects. */
  registries?: RegistryConfigEntry[];
  /** When true, also search asset-level metadata within kits. */
  includeAssets?: boolean;
}

// ── Public API ──────────────────────────────────────────────────────────────

export async function searchRegistry(query: string, options?: RegistrySearchOptions): Promise<RegistrySearchResponse> {
  const trimmed = query.trim();
  if (!trimmed) {
    return { query: "", hits: [], warnings: [] };
  }

  const limit = clampLimit(options?.limit);
  // resolveRegistries() already filters by enabled; explicit registries are filtered here
  const raw = options?.registries ?? resolveRegistries();
  const entries = options?.registries ? raw.filter((r) => r.enabled !== false) : raw;
  const warnings: string[] = [];

  // Resolve and search all providers concurrently
  const results = await Promise.allSettled(
    entries.map((entry) => {
      const provider = createProvider(entry, warnings);
      if (!provider) return Promise.resolve(null);
      return provider.search({ query: trimmed, limit, includeAssets: options?.includeAssets });
    }),
  );

  // Merge results grouped by provider
  const allHits: RegistrySearchHit[] = [];
  const allAssetHits: RegistryAssetSearchHit[] = [];

  for (const result of results) {
    if (result.status === "rejected") {
      warnings.push(toErrorMessage(result.reason));
      continue;
    }
    const value = result.value;
    if (!value) continue;

    allHits.push(...value.hits);
    if (value.assetHits) allAssetHits.push(...value.assetHits);
    if (value.warnings) warnings.push(...value.warnings);
  }

  // Sort merged hits by score descending, apply limit
  allHits.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const limitedHits = allHits.slice(0, limit);

  allAssetHits.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const limitedAssetHits = allAssetHits.slice(0, limit);

  return {
    query: trimmed,
    hits: limitedHits,
    warnings,
    assetHits: limitedAssetHits.length > 0 ? limitedAssetHits : undefined,
  };
}

// ── Registry resolution ─────────────────────────────────────────────────────

/**
 * Resolve the list of enabled registries.
 *
 * Priority:
 * 1. AKM_REGISTRY_URL env var (CI override, comma-separated)
 * 2. config.registries (filtered by enabled !== false)
 * 3. Default registries from DEFAULT_CONFIG
 */
export function resolveRegistries(configRegistries?: RegistryConfigEntry[]): RegistryConfigEntry[] {
  // Allow env var override (comma-separated URLs) — CI escape hatch
  const envUrls = process.env.AKM_REGISTRY_URL?.trim();
  if (envUrls) {
    return envUrls
      .split(",")
      .map((u) => u.trim())
      .filter(Boolean)
      .map((url) => ({ url }));
  }

  const registries = configRegistries ?? loadConfig().registries ?? DEFAULT_CONFIG.registries ?? [];
  return registries.filter((r) => r.enabled !== false);
}

// ── Provider resolution ─────────────────────────────────────────────────────

function createProvider(entry: RegistryConfigEntry, warnings: string[]) {
  const providerType = entry.provider ?? "static-index";
  const factory = resolveProviderFactory(providerType);
  if (!factory) {
    const label = entry.name ? `${entry.name} (${entry.url})` : entry.url;
    warnings.push(`Registry ${label}: unknown provider type "${providerType}"`);
    return null;
  }
  return factory(entry);
}

// ── Utilities ───────────────────────────────────────────────────────────────

function clampLimit(limit: number | undefined): number {
  if (!limit || !Number.isFinite(limit)) return 20;
  return Math.min(100, Math.max(1, Math.trunc(limit)));
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
