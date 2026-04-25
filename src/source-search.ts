import { loadConfig } from "./config";
import { closeDatabase, openDatabase } from "./db";
import { searchLocal } from "./db-search";

// Eagerly import stash providers to trigger self-registration
import "./source-providers/index";
import { UsageError } from "./errors";
import { searchRegistry } from "./registry-search";
import { resolveSourceEntries } from "./search-source";
import type {
  AkmSearchType,
  RegistrySearchResultHit,
  SearchHit,
  SearchResponse,
  SearchSource,
  SourceSearchHit,
} from "./source-types";
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
  const sources = resolveSourceEntries(undefined, config);
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

  const registryResult =
    source === "stash" ? undefined : await searchRegistry(query, { limit, registries: config.registries });

  if (source === "stash") {
    const localHits = localResult?.hits ?? [];
    const hasResults = localHits.length > 0;
    const response: SearchResponse = {
      schemaVersion: 1,
      stashDir,
      source,
      hits: localHits,
      tip: hasResults ? undefined : localResult?.tip,
      warnings: localResult?.warnings?.length ? localResult.warnings : undefined,
      timing: { totalMs: Date.now() - t0, rankMs: localResult?.rankMs, embedMs: localResult?.embedMs },
    };
    logSearchEvent(query, response);
    return response;
  }

  const registryHits = (registryResult?.hits ?? []).map((hit): RegistrySearchResultHit => {
    // Use the provider-supplied installRef when available (already correctly
    // prefixed), otherwise derive it from source + ref for backward compat.
    const installRef =
      hit.installRef ??
      (hit.source === "npm" ? `npm:${hit.ref}` : hit.source === "git" ? `git+${hit.ref}` : `github:${hit.ref}`);
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
    const slicedRegistryHits = registryHits.slice(0, limit);
    const hasResults = slicedRegistryHits.length > 0;
    const response: SearchResponse = {
      schemaVersion: 1,
      stashDir,
      source,
      hits: [],
      registryHits: slicedRegistryHits,
      tip: hasResults ? undefined : "No matching registry entries were found.",
      warnings: registryResult?.warnings.length ? registryResult.warnings : undefined,
      timing: { totalMs: Date.now() - t0 },
    };
    logSearchEvent(query, response);
    return response;
  }

  // source === "both"
  const allStashHits = (localResult?.hits ?? []).slice(0, limit);
  const warnings = [...(localResult?.warnings ?? []), ...(registryResult?.warnings ?? [])];
  const hasResults = allStashHits.length > 0 || registryHits.length > 0;

  const response: SearchResponse = {
    schemaVersion: 1,
    stashDir,
    source,
    hits: allStashHits,
    registryHits,
    tip: hasResults ? undefined : "No matching stash assets or registry entries were found.",
    warnings: warnings.length ? warnings : undefined,
    timing: { totalMs: Date.now() - t0 },
  };
  logSearchEvent(query, response);
  return response;
}

/**
 * Resolve entry IDs by file_path lookup (exact match, not LIKE).
 */
function resolveEntryIds(
  db: import("bun:sqlite").Database,
  hits: SourceSearchHit[],
): Array<{ entryId: number; ref: string }> {
  const results: Array<{ entryId: number; ref: string }> = [];
  const stmt = db.prepare("SELECT id FROM entries WHERE file_path = ? LIMIT 1");
  for (const hit of hits) {
    try {
      const row = stmt.get(hit.path) as { id: number } | undefined;
      if (row) results.push({ entryId: row.id, ref: hit.ref });
    } catch {
      /* skip unresolvable */
    }
  }
  return results;
}

/**
 * Fire-and-forget: log a search event to the usage_events table.
 * Never blocks the caller; errors are silently ignored.
 */
function logSearchEvent(query: string, response: SearchResponse, existingDb?: import("bun:sqlite").Database): void {
  try {
    const db = existingDb ?? openDatabase();
    try {
      const stashHits = response.hits.filter((h): h is SourceSearchHit => h.type !== "registry").slice(0, 50);
      const resolved = resolveEntryIds(db, stashHits);
      for (const { entryId, ref } of resolved) {
        insertUsageEvent(db, {
          event_type: "search",
          query,
          entry_id: entryId,
          entry_ref: ref,
        });
      }
      insertUsageEvent(db, {
        event_type: "search",
        query,
        metadata: JSON.stringify({ resultCount: response.hits.length, resolvedCount: resolved.length }),
      });
    } finally {
      if (!existingDb) closeDatabase(db);
    }
  } catch {
    /* fire-and-forget */
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

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
  throw new UsageError(
    `Invalid value for --source: ${String(source)}. Expected one of: stash|registry|both`,
    "INVALID_SOURCE_VALUE",
  );
}

/**
 * Merge stash hits and registry hits via simple concatenation.
 */
export function mergeSearchHits(
  localHits: SourceSearchHit[],
  registryHits: RegistrySearchResultHit[],
  limit: number,
): SearchHit[] {
  return [...localHits, ...registryHits].slice(0, limit);
}
