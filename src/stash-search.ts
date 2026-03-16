import { loadConfig } from "./config";
import { ACTION_BUILDERS, buildLocalAction, rendererForType, searchLocal, TYPE_TO_RENDERER } from "./local-search";
import { resolveStashProviders } from "./stash-provider-factory";

// Eagerly import stash providers to trigger self-registration
import "./stash-providers/index";
import { UsageError } from "./errors";
import { searchRegistry } from "./registry-search";
import { resolveStashSources } from "./stash-source";
import type {
  AkmSearchType,
  RegistrySearchResultHit,
  SearchHit,
  SearchResponse,
  SearchSource,
  StashSearchHit,
} from "./stash-types";

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
    return {
      schemaVersion: 1,
      stashDir: "",
      source,
      hits: [],
      warnings: ["No stashes configured. Run `akm init` to create your working stash."],
      timing: { totalMs: Date.now() - t0 },
    };
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
    return {
      schemaVersion: 1,
      stashDir,
      source,
      hits: allStashHits,
      tip: hasResults ? undefined : localResult?.tip,
      warnings: localWarnings.length > 0 ? localWarnings : undefined,
      timing: { totalMs: Date.now() - t0, rankMs: localResult?.rankMs, embedMs: localResult?.embedMs },
    };
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
    return {
      schemaVersion: 1,
      stashDir,
      source,
      hits,
      tip: hasResults ? undefined : "No matching registry entries were found.",
      warnings: registryResult?.warnings.length ? registryResult.warnings : undefined,
      timing: { totalMs: Date.now() - t0 },
    };
  }

  // source === "both"
  const allStashHits = mergeStashHits(localResult?.hits ?? [], additionalHits, limit * 2);
  const mergedHits = mergeSearchHits(allStashHits, registryHits, limit);
  const warnings = [...(localResult?.warnings ?? []), ...additionalWarnings, ...(registryResult?.warnings ?? [])];
  const hasResults = mergedHits.length > 0;

  return {
    schemaVersion: 1,
    stashDir,
    source,
    hits: mergedHits,
    tip: hasResults ? undefined : "No matching stash assets or registry entries were found.",
    warnings: warnings.length ? warnings : undefined,
    timing: { totalMs: Date.now() - t0 },
  };
}

// Re-export searchLocal so existing callers (filesystem.ts) still work via this module
export { searchLocal };

// ── Type renderer and action builder registration ────────────────────────────

export function registerTypeRenderer(type: string, rendererName: string): void {
  TYPE_TO_RENDERER[type] = rendererName;
}

export function registerActionBuilder(type: string, builder: (ref: string) => string): void {
  ACTION_BUILDERS[type] = builder;
}

// Re-export for consumers that were already importing from stash-search
export { buildLocalAction, rendererForType };

// ── Helpers ──────────────────────────────────────────────────────────────────

function mergeStashHits(
  localHits: StashSearchHit[],
  additionalHits: StashSearchHit[],
  limit: number,
): StashSearchHit[] {
  if (additionalHits.length === 0) return localHits.slice(0, limit);
  const all = [...localHits, ...additionalHits];
  all.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  return all.slice(0, limit);
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

function mergeSearchHits(
  localHits: StashSearchHit[],
  registryHits: RegistrySearchResultHit[],
  limit: number,
): SearchHit[] {
  const all: SearchHit[] = [...localHits, ...registryHits];
  all.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  return all.slice(0, limit);
}
