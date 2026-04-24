import { toErrorMessage } from "./common";
import { DEFAULT_CONFIG, loadConfig, type RegistryConfigEntry } from "./config";
import { resolveProviderFactory } from "./registry-factory";
import type { RegistryAssetSearchHit, RegistrySearchHit, RegistrySearchResponse } from "./registry-types";

// ── Eagerly import providers to trigger self-registration ───────────────────

import "./providers/index";

// ── Re-exports for backward compatibility ───────────────────────────────────

export type { RegistryIndex, RegistryStashEntry } from "./providers/static-index";
export type { RegistryAssetSearchHit } from "./registry-types";

// ── Types ───────────────────────────────────────────────────────────────────

export interface RegistrySearchOptions {
  limit?: number;
  /** Override registries. Accepts an array of RegistryConfigEntry objects. */
  registries?: RegistryConfigEntry[];
  /** When true, also search asset-level metadata within stashes. */
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

    let dropped = 0;
    for (const hit of value.hits) {
      if (isCompleteHit(hit)) {
        allHits.push(hit);
      } else {
        dropped++;
      }
    }
    if (value.assetHits) {
      for (const hit of value.assetHits) {
        if (isCompleteAssetHit(hit)) {
          allAssetHits.push(hit);
        } else {
          dropped++;
        }
      }
    }
    if (dropped > 0) {
      warnings.push(`Registry returned ${dropped} incomplete hit(s); dropped from response.`);
    }
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
    const entries: RegistryConfigEntry[] = [];
    for (const raw of envUrls.split(",")) {
      const url = raw.trim();
      if (!url) continue;
      if (!url.startsWith("http://") && !url.startsWith("https://")) {
        console.warn(`[akm] Ignoring AKM_REGISTRY_URL entry: must start with http:// or https://, got "${url}"`);
        continue;
      }
      entries.push({ url });
    }
    return entries;
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

// A complete hit must have the fields downstream consumers (CLI rendering,
// `akm add`) rely on. Providers that return partial records would otherwise
// surface as `{}` in the JSON output.
function isCompleteHit(hit: RegistrySearchHit | undefined | null): hit is RegistrySearchHit {
  if (!hit || typeof hit !== "object") return false;
  return (
    typeof hit.source === "string" &&
    typeof hit.id === "string" &&
    hit.id.length > 0 &&
    typeof hit.title === "string" &&
    hit.title.length > 0 &&
    typeof hit.ref === "string" &&
    hit.ref.length > 0 &&
    typeof hit.installRef === "string" &&
    hit.installRef.length > 0
  );
}

function isCompleteAssetHit(hit: RegistryAssetSearchHit | undefined | null): hit is RegistryAssetSearchHit {
  if (!hit || typeof hit !== "object") return false;
  if (
    hit.type !== "registry-asset" ||
    typeof hit.assetType !== "string" ||
    hit.assetType.length === 0 ||
    typeof hit.assetName !== "string" ||
    hit.assetName.length === 0 ||
    typeof hit.action !== "string"
  ) {
    return false;
  }
  // `stash` is required by the consumer (output shaping + asset-action display);
  // rejecting incomplete stashes here keeps malformed objects out of the JSON
  // output. Flagged in PR #168 review (#9).
  const stash = hit.stash as { id?: unknown; name?: unknown } | undefined;
  if (!stash || typeof stash !== "object") return false;
  if (typeof stash.id !== "string" || stash.id.length === 0) return false;
  if (typeof stash.name !== "string" || stash.name.length === 0) return false;
  return true;
}
