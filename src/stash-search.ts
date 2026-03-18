import { registerActionBuilder, registerTypeRenderer } from "./asset-registry";
import { loadConfig } from "./config";
import { closeDatabase, openDatabase } from "./db";
import { buildLocalAction, rendererForType, searchLocal } from "./local-search";
import { resolveStashProviders } from "./stash-provider-factory";

// Eagerly import stash providers to trigger self-registration
import "./stash-providers/index";
import { UsageError } from "./errors";
import { searchRegistry } from "./registry-search";
import { resolveStashSources } from "./search-source";
import type {
  AkmSearchType,
  RegistrySearchResultHit,
  SearchHit,
  SearchResponse,
  SearchSource,
  StashSearchHit,
} from "./stash-types";
import { insertUsageEvent } from "./usage-events";

const DEFAULT_LIMIT = 20;

export async function akmSearch(input: {
  query: string;
  type?: AkmSearchType;
  limit?: number;
  source?: SearchSource | string;
}): Promise<SearchResponse> {
  const t0 = Date.now();
  const query = input.query.trim();
  const normalizedQuery = query.toLowerCase();
  const searchType = input.type ?? "any";
  const limit = normalizeLimit(input.limit);
  const source = parseSearchSource(input.source ?? "stash");
  const config = loadConfig();
  const sources = resolveStashSources(undefined, config);
  if (sources.length === 0) {
    // stashDir: "" is a safe sentinel here — the response carries zero hits
    // and a warning, so no downstream code will try to use the empty path.
    const response: SearchResponse = {
      schemaVersion: 1,
      stashDir: "",
      source,
      hits: [],
      warnings: ["No stashes configured. Run `akm init` to create your working stash."],
      timing: { totalMs: Date.now() - t0 },
    };
    logSearchEvent(query, response);
    return response;
  }
  // Primary stash directory — used for DB path lookups and as the default
  // stash root. Safe because the empty-sources case is handled above.
  const stashDir = sources[0].path;

  // Resolve additional stash providers (e.g. OpenViking) from config
  const additionalStashProviders = resolveStashProviders(config);

  const localResult =
    source === "registry"
      ? undefined
      : await searchLocal({
          query: normalizedQuery,
          searchType,
          limit,
          stashDir,
          sources,
          config,
        });

  // Query additional stash providers (e.g. OpenViking)
  const additionalStashResults =
    source === "registry" || additionalStashProviders.length === 0 || !query
      ? []
      : await Promise.all(
          additionalStashProviders.map(async (provider) => {
            try {
              return await provider.search({ query, type: searchType === "any" ? undefined : searchType, limit });
            } catch (err) {
              return {
                hits: [] as StashSearchHit[],
                warnings: [`Stash ${provider.name}: ${err instanceof Error ? err.message : String(err)}`],
              };
            }
          }),
        );

  // Merge stash hits from all providers
  const additionalHits = additionalStashResults.flatMap((r) => r.hits);
  const additionalWarnings = additionalStashResults.flatMap((r) => r.warnings ?? []);

  const registryResult =
    source === "stash" ? undefined : await searchRegistry(query, { limit, registries: config.registries });

  if (source === "stash") {
    const allStashHits = mergeStashHits(localResult?.hits ?? [], additionalHits, limit);
    const localWarnings = [...(localResult?.warnings ?? []), ...additionalWarnings];
    const hasResults = allStashHits.length > 0;
    const response: SearchResponse = {
      schemaVersion: 1,
      stashDir,
      source,
      hits: allStashHits,
      tip: hasResults ? undefined : localResult?.tip,
      warnings: localWarnings.length > 0 ? localWarnings : undefined,
      timing: { totalMs: Date.now() - t0, rankMs: localResult?.rankMs, embedMs: localResult?.embedMs },
    };
    logSearchEvent(query, response);
    return response;
  }

  const registryHits = (registryResult?.hits ?? []).map((hit): RegistrySearchResultHit => {
    const installRef =
      hit.source === "npm" ? `npm:${hit.ref}` : hit.source === "git" ? `git+${hit.ref}` : `github:${hit.ref}`;
    return {
      type: "registry",
      name: hit.title,
      id: hit.id,
      description: hit.description,
      action: `akm add ${installRef} -> then search again`,
      score: hit.score,
      curated: hit.curated,
      registryName: hit.registryName,
    };
  });

  if (source === "registry") {
    const hits = registryHits.slice(0, limit);
    const hasResults = hits.length > 0;
    const response: SearchResponse = {
      schemaVersion: 1,
      stashDir,
      source,
      hits,
      tip: hasResults ? undefined : "No matching registry entries were found.",
      warnings: registryResult?.warnings.length ? registryResult.warnings : undefined,
      timing: { totalMs: Date.now() - t0 },
    };
    logSearchEvent(query, response);
    return response;
  }

  // source === "both"
  const allStashHits = mergeStashHits(localResult?.hits ?? [], additionalHits, limit * 2);
  const mergedHits = mergeSearchHits(allStashHits, registryHits, limit);
  const warnings = [...(localResult?.warnings ?? []), ...additionalWarnings, ...(registryResult?.warnings ?? [])];
  const hasResults = mergedHits.length > 0;

  const response: SearchResponse = {
    schemaVersion: 1,
    stashDir,
    source,
    hits: mergedHits,
    tip: hasResults ? undefined : "No matching stash assets or registry entries were found.",
    warnings: warnings.length ? warnings : undefined,
    timing: { totalMs: Date.now() - t0 },
  };
  logSearchEvent(query, response);
  return response;
}

/**
 * Fire-and-forget: log a search event to the usage_events table.
 * Never blocks the caller; errors are silently ignored.
 */
// TODO: Pass the existing DB connection from the search/show path
// instead of opening a second connection. Not a correctness issue
// (WAL mode handles concurrent access) but wasteful.
function logSearchEvent(query: string, response: SearchResponse): void {
  try {
    const db = openDatabase();
    try {
      const entryRefs = response.hits
        .filter((h): h is StashSearchHit => h.type !== "registry")
        .map((h) => h.ref)
        .slice(0, 50);
      insertUsageEvent(db, {
        event_type: "search",
        query,
        metadata: JSON.stringify({ resultCount: response.hits.length, entry_refs: entryRefs }),
      });
    } finally {
      closeDatabase(db);
    }
  } catch {
    /* fire-and-forget */
  }
}

// Re-export searchLocal so existing callers (filesystem.ts) still work via this module
export { searchLocal };

// Re-export for consumers that were already importing from stash-search
export { buildLocalAction, rendererForType, registerTypeRenderer, registerActionBuilder };

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Merge local and additional stash hits preserving local score quality.
 *
 * Local hits retain their original scores from the FTS+boost pipeline.
 * Provider-only hits are placed below the lowest local hit so they don't
 * displace well-ranked local results. Duplicates (same path) keep the
 * local version.
 */
/**
 * Merge local and additional stash hits preserving local score quality.
 *
 * Local hits have meaningful scores from the FTS+boost pipeline. Additional
 * provider hits (context-hub, OpenViking) have their own scores that may use
 * a different scale. The merge strategy:
 *
 * 1. Local hits retain their original scores (the scoring pipeline already
 *    produced well-differentiated values).
 * 2. Provider hits that duplicate a local hit are dropped (local version wins).
 * 3. Provider-only hits are interleaved using their rank position, scored
 *    below the lowest local hit so they don't displace locally-ranked results.
 */
export function mergeStashHits(
  localHits: StashSearchHit[],
  additionalHits: StashSearchHit[],
  limit: number,
): StashSearchHit[] {
  if (additionalHits.length === 0) return localHits.slice(0, limit);

  // Track local hits by a dedup key (path > ref > name)
  const localKeys = new Set<string>();
  for (const h of localHits) {
    localKeys.add(h.path ?? h.ref ?? h.name);
  }

  // Find the lowest local score to use as a ceiling for provider-only hits
  const minLocalScore = localHits.length > 0 ? Math.min(...localHits.map((h) => h.score ?? 0)) : 0;

  // Provider-only hits get scores just below the lowest local hit,
  // decreasing by rank position so their relative order is preserved.
  const providerOnly: StashSearchHit[] = [];
  for (let i = 0; i < additionalHits.length; i++) {
    const key = additionalHits[i].path ?? additionalHits[i].ref ?? additionalHits[i].name;
    if (localKeys.has(key)) continue; // Local version wins
    const providerScore = Math.max(0, minLocalScore * 0.9 - i * 0.0001);
    providerOnly.push({
      ...additionalHits[i],
      score: Math.round(providerScore * 10000) / 10000,
    });
  }

  // Combine: local hits first (already sorted by score), then provider hits
  return [...localHits, ...providerOnly].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, limit);
}

function normalizeLimit(limit?: number): number {
  if (typeof limit !== "number" || Number.isNaN(limit) || limit <= 0) {
    return DEFAULT_LIMIT;
  }
  return Math.min(Math.floor(limit), 200);
}

export function parseSearchSource(source: SearchSource | string | undefined): SearchSource {
  if (source === "stash" || source === "registry" || source === "both") return source;
  // Accept "local" as alias for "stash"
  if (source === "local") return "stash";
  if (typeof source === "undefined") return "stash";
  throw new UsageError(`Invalid value for --source: ${String(source)}. Expected one of: stash|registry|both`);
}

/**
 * Merge stash hits and registry hits, preserving local scores.
 *
 * Local stash hits retain their original scores. Registry hits are placed
 * after local hits with scores derived from their rank position, scaled
 * below the lowest local score. This ensures local results (which have
 * gone through the full FTS+boost pipeline) are not displaced by registry
 * results on a different score scale.
 */
export function mergeSearchHits(
  localHits: StashSearchHit[],
  registryHits: RegistrySearchResultHit[],
  limit: number,
): SearchHit[] {
  if (registryHits.length === 0) return localHits.slice(0, limit);
  if (localHits.length === 0) return registryHits.slice(0, limit);

  const minLocalScore = Math.min(...localHits.map((h) => h.score ?? 0));

  // Registry hits get scores below the lowest local hit
  const scoredRegistry: SearchHit[] = registryHits.map((hit, i) => ({
    ...hit,
    score: Math.round(Math.max(0, minLocalScore * 0.9 - i * 0.0001) * 10000) / 10000,
  }));

  return [...localHits, ...scoredRegistry].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, limit);
}
