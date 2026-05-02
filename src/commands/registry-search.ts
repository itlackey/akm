import { toErrorMessage } from "../core/common";
import { DEFAULT_CONFIG, loadConfig, type RegistryConfigEntry } from "../core/config";
import { warn } from "../core/warn";
import { resolveProviderFactory } from "../registry/factory";
import type { RegistryAssetSearchHit, RegistrySearchHit, RegistrySearchResponse } from "../registry/types";

// ── Eagerly import providers to trigger self-registration ───────────────────

import "../registry/providers/index";

// ── Re-exports for backward compatibility ───────────────────────────────────

export type { RegistryIndex, RegistryStashEntry } from "../registry/providers/static-index";
export type { RegistryAssetSearchHit } from "../registry/types";

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
  // Each provider batch is normalized to [0, 1] before merging so that raw
  // scores from different providers (e.g. static-index can exceed 1.85 while
  // skills-sh uses installs-relative scoring) are comparable in the merged list.
  const allHits: RegistrySearchHit[] = [];
  const allAssetHits: RegistryAssetSearchHit[] = [];

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === "rejected") {
      warnings.push(toErrorMessage(result.reason));
      continue;
    }
    const value = result.value;
    if (!value) continue;

    const registryLabel = entries[i].name ? `"${entries[i].name}"` : entries[i].url;
    let dropped = 0;

    const validHits: RegistrySearchHit[] = [];
    for (const hit of value.hits) {
      if (isCompleteHit(hit)) {
        validHits.push(hit);
      } else {
        dropped++;
      }
    }
    // Normalize scores within this provider's batch before merging
    normalizeScores(validHits);
    for (const hit of validHits) {
      allHits.push(hit);
    }

    if (value.assetHits) {
      const validAssetHits: RegistryAssetSearchHit[] = [];
      for (const hit of value.assetHits) {
        if (isCompleteAssetHit(hit)) {
          validAssetHits.push(hit);
        } else {
          dropped++;
        }
      }
      normalizeScores(validAssetHits);
      for (const hit of validAssetHits) {
        allAssetHits.push(hit);
      }
    }

    if (dropped > 0) {
      warnings.push(`Registry ${registryLabel} returned ${dropped} incomplete hit(s); dropped from response.`);
    }
    if (value.warnings) warnings.push(...value.warnings);
  }

  // Sort merged hits by normalized score descending, apply limit
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
 *
 * AKM_REGISTRY_URL syntax (comma-separated):
 *   - Bare URL: `https://example.com/index.json`  → defaults to provider "static-index"
 *   - Typed URL: `skills-sh::https://skills.sh/api`  → explicit provider type
 *     Format: `<provider-type>::<url>`
 */
export function resolveRegistries(configRegistries?: RegistryConfigEntry[]): RegistryConfigEntry[] {
  // Allow env var override (comma-separated URLs) — CI escape hatch
  const envUrls = process.env.AKM_REGISTRY_URL?.trim();
  if (envUrls) {
    const entries: RegistryConfigEntry[] = [];
    for (const raw of envUrls.split(",")) {
      const trimmed = raw.trim();
      if (!trimmed) continue;

      // Parse optional `<provider-type>::<url>` prefix
      let provider: string | undefined;
      let url: string;
      const colonColonIdx = trimmed.indexOf("::");
      if (colonColonIdx !== -1 && !trimmed.startsWith("http://") && !trimmed.startsWith("https://")) {
        // Only treat as `provider::url` if the prefix doesn't look like a URL scheme itself
        provider = trimmed.slice(0, colonColonIdx).trim();
        url = trimmed.slice(colonColonIdx + 2).trim();
        if (!provider) {
          warn(`[akm] Ignoring AKM_REGISTRY_URL entry: empty provider type before "::" in "${trimmed}"`);
          continue;
        }
      } else {
        url = trimmed;
      }

      if (!url.startsWith("http://") && !url.startsWith("https://")) {
        warn(`[akm] Ignoring AKM_REGISTRY_URL entry: must start with http:// or https://, got "${url}"`);
        continue;
      }
      entries.push(provider ? { url, provider } : { url });
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

/**
 * Normalize the `score` field of a batch of hits in-place to [0, 1].
 *
 * Different registry providers use incompatible score scales
 * (static-index can exceed 1.85; skills-sh uses installs-relative values
 * in [0, 1]).  Normalizing each provider's batch independently before merging
 * makes the merged sort order meaningful.
 *
 * When all scores are identical (or absent), scores are left unchanged so
 * relative ordering within the batch is preserved (all-same is effectively
 * already normalized).
 */
function normalizeScores(hits: Array<{ score?: number }>): void {
  if (hits.length === 0) return;
  const rawScores = hits.map((h) => h.score ?? 0);
  const max = Math.max(...rawScores);
  if (max <= 0) return; // all zero or negative — leave as-is
  const min = Math.min(...rawScores);
  const range = max - min;
  for (let i = 0; i < hits.length; i++) {
    const raw = rawScores[i];
    // Min-max normalize: [0, 1]. When all scores are equal (range === 0),
    // fall back to dividing by max so the value stays in [0, 1].
    hits[i].score = range > 0 ? (raw - min) / range : raw / max;
  }
}

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
