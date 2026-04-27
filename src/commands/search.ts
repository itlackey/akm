/**
 * `akm search` — entry point.
 *
 * Spec §6.1: search consults the local FTS5 index. There is one query path
 * because there is one data store. Provider fan-out is gone.
 *
 * The orchestration here is thin: build the FTS query, optionally interleave
 * a registry search behind `--source registry|both`, and log a usage event.
 * Provider `search()` methods do not exist.
 */

import { loadConfig } from "../core/config";
import { UsageError } from "../core/errors";
import { closeDatabase, openDatabase } from "../indexer/db";
import { searchLocal } from "../indexer/db-search";
import type { StashEntryScope } from "../indexer/metadata";
import { resolveSourceEntries } from "../indexer/search-source";
// Eagerly import source providers to trigger self-registration before the
// indexer or path-resolution code runs.
import "../sources/providers/index";
import { insertUsageEvent } from "../indexer/usage-events";
import type {
  AkmSearchType,
  RegistrySearchResultHit,
  SearchHit,
  SearchResponse,
  SearchSource,
  SourceSearchHit,
} from "../sources/types";
import { searchRegistry } from "./registry-search";

const DEFAULT_LIMIT = 20;

export async function akmSearch(input: {
  query: string;
  type?: AkmSearchType;
  limit?: number;
  source?: SearchSource | string;
  /**
   * Optional scope filter. Each present field narrows local hits to entries
   * whose `entry.scope.<key>` exactly equals the supplied value. Unfiltered
   * queries (no `filters` argument or all keys absent) preserve the legacy
   * behavior — entries without any scope keys still match.
   *
   * Filtering narrows the result set; ranking is unchanged. There is still
   * one scoring pipeline.
   */
  filters?: StashEntryScope;
  /**
   * When true, hits with `quality === "proposed"` are kept in the result
   * set (v1 spec §4.2). Default behavior excludes them. The flag has no
   * effect on registry hits.
   */
  includeProposed?: boolean;
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

  const filters = normalizeScopeFilters(input.filters);
  const includeProposed = input.includeProposed === true;
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
          filters,
          includeProposed,
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
    // The legacy registry boolean `curated` was removed in v1 (spec §4.2).
    // Hit-level `warnings` are forwarded when the provider surfaced any.
    return {
      type: "registry",
      name: hit.title,
      id: hit.id,
      description: hit.description,
      action: `akm add ${installRef} -> then search again`,
      score: hit.score,
      registryName: hit.registryName,
      ...(hit.warnings && hit.warnings.length > 0 ? { warnings: hit.warnings } : {}),
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
 * Strip empty / non-string values from a scope filter object. Returns
 * `undefined` when nothing meaningful remains, so callers don't pay for an
 * empty-filter post-walk in `searchLocal`.
 */
function normalizeScopeFilters(raw: StashEntryScope | undefined): StashEntryScope | undefined {
  if (!raw) return undefined;
  const out: StashEntryScope = {};
  for (const key of ["user", "agent", "run", "channel"] as const) {
    const value = raw[key];
    if (typeof value === "string" && value.trim()) {
      out[key] = value.trim();
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Parse repeated `--filter k=v` / `--scope k=v` argv tokens into a
 * `StashEntryScope`. Throws a {@link UsageError} for malformed tokens
 * (missing `=`, unknown key) so callers don't see ambiguous misses.
 *
 * Used by both `akm search --filter` and `akm show --scope`.
 */
export function parseScopeFilterFlags(values: string[], flagName = "--filter"): StashEntryScope | undefined {
  if (values.length === 0) return undefined;
  const out: StashEntryScope = {};
  for (const raw of values) {
    const eq = raw.indexOf("=");
    if (eq <= 0) {
      throw new UsageError(`Invalid ${flagName} value "${raw}". Expected key=value (e.g. user=alice).`);
    }
    const key = raw.slice(0, eq).trim();
    const value = raw.slice(eq + 1).trim();
    if (key !== "user" && key !== "agent" && key !== "run" && key !== "channel") {
      throw new UsageError(`Unknown scope key "${key}" in ${flagName}. Valid keys: user, agent, run, channel.`);
    }
    if (!value) {
      throw new UsageError(`${flagName} ${key}=… requires a non-empty value.`);
    }
    out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Returns true iff `entry.scope` (when present) satisfies every key in
 * `filters`. A missing `entry.scope` (legacy memories) only matches when
 * `filters` is empty / undefined.
 *
 * Filter semantics:
 *   - No filter passed → all entries match (legacy behavior preserved).
 *   - `filters.user = "alice"` → entry must have `scope.user === "alice"`.
 *   - Multiple keys → AND-joined; every supplied key must match.
 */
export function entryMatchesScopeFilters(
  scope: StashEntryScope | undefined,
  filters: StashEntryScope | undefined,
): boolean {
  if (!filters) return true;
  for (const key of ["user", "agent", "run", "channel"] as const) {
    const expected = filters[key];
    if (expected === undefined) continue;
    if (!scope || scope[key] !== expected) return false;
  }
  return true;
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
