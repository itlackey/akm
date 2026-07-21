// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

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

import { type AkmConfig, getSources, loadConfig } from "../../core/config/config";
import { rethrowIfTestIsolationError, UsageError } from "../../core/errors";
import { appendEvent } from "../../core/events";
import { isTransientStashPath } from "../../core/paths";
import type { StashEntryScope } from "../../indexer/passes/metadata";
import { resolveReadSources } from "../../indexer/read-preflight";
import { searchLocal } from "../../indexer/search/db-search";
import { getEntryIdByFilePath, getItemRefById } from "../../storage/repositories/index-entries-repository";
import { bumpUtilityScoresBatch } from "../../storage/repositories/index-utility-repository";
import { getCurrentWorkflowScopeKey } from "../../workflows/authoring/scope-key";
// Eagerly import source providers to trigger self-registration before the
// indexer or path-resolution code runs.
import "../../sources/providers/index";
import { withStateDbTelemetry } from "../../core/state-db";
import { insertUsageEvent, type UsageEventSource } from "../../indexer/usage/usage-events";
import type {
  AkmSearchType,
  BeliefFilterMode,
  RegistrySearchResultHit,
  SearchHit,
  SearchResponse,
  SearchSource,
  SourceSearchHit,
} from "../../sources/types";
import { TELEMETRY_BUSY_TIMEOUT_MS, withIndexDb } from "../../storage/repositories/index-db";
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
  /**
   * Belief-state filter. Applies to ANY entry carrying a `beliefState`
   * (memory OR knowledge — 03), so flagged knowledge is filtered too:
   * - `all` keeps current + historical hits (default)
   * - `current` keeps active/asserted/unspecified beliefs (and unflagged entries)
   * - `historical` keeps deprecated/contradicted/superseded/archived beliefs
   */
  belief?: BeliefFilterMode;
  /**
   * #627 — when true, re-include asset types normally hidden from the default
   * (untyped) search path via `config.search.defaultExcludeTypes` (notably
   * `session`). No effect when an explicit `type` is supplied.
   */
  includeSessions?: boolean;
  /** Disable the automatic project-context ranking boost for this search only. */
  disableProjectContext?: boolean;
  /** Disable scoped-utility ranking and usage-score bumps for this search only. */
  disableScopedUtility?: boolean;
  /**
   * When true, skip logging usage events. Used by internal callers
   * (curate, improve context gathering) to avoid polluting user
   * search history with programmatic lookups.
   */
  skipLogging?: boolean;
  /**
   * Event source for usage logging. Defaults to `"user"`. Set to
   * `"improve"` when called from improve's reflect/distill agents
   * so events can be filtered out of user-facing history.
   */
  eventSource?: UsageEventSource;
}): Promise<SearchResponse> {
  const t0 = Date.now();
  const query = input.query.trim();
  const normalizedQuery = query.toLowerCase();
  const searchType = input.type ?? "any";
  const limit = normalizeLimit(input.limit);
  const parsedSource = parseSearchSource(input.source ?? "stash");
  const config = loadConfig();

  // Named-source filter: when --source is not a standard enum value, treat it
  // as a named source (a `bundles` key). Validated early (before
  // resolveSourceEntries, which can throw STASH_DIR_NOT_FOUND) so that a bad
  // --source name always produces INVALID_SOURCE_VALUE regardless of stash state.
  let namedSourceName: string | undefined;
  let source: SearchSource;
  if (parsedSource !== "stash" && parsedSource !== "registry" && parsedSource !== "both") {
    namedSourceName = parsedSource as string;
    assertNamedSourceExists(config, namedSourceName);
    source = "stash";
  } else {
    source = parsedSource as SearchSource;
  }

  let allSources = resolveReadSources(undefined, config).sources;

  // When a named source was requested, narrow the sources list to just that entry.
  // `resolveSourceEntries` sets `registryId` to `entry.name` for each config source.
  if (namedSourceName !== undefined) {
    const ns = namedSourceName;
    allSources = allSources.filter((s) => s.registryId === ns || s.path === ns);
    // allSources may still be empty if the configured source dir doesn't exist on
    // disk (resolveSourceEntries skips non-existent dirs). Fall through to the
    // zero-sources guard below which emits a friendly warning.
  }

  if (allSources.length === 0) {
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
    if (!input.skipLogging) logSearchEvent(query, response, undefined, input.eventSource);
    return response;
  }
  // Primary stash directory — used for DB path lookups and as the default
  // stash root. Safe because the empty-sources case is handled above.
  const stashDir = allSources[0].path;
  // Expose the filtered source list to downstream search calls.
  const sources = allSources;

  const filters = normalizeScopeFilters(input.filters);
  const includeProposed = input.includeProposed === true;
  const belief = input.belief ?? "all";
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
          beliefFilter: belief,
          // When `--source <name>` narrowed the source list above, propagate
          // that intent down to the database layer so FTS/vector hits from
          // sources outside the narrowed set are filtered out post-ranking.
          // Without this, the index (which spans every configured source)
          // would leak hits from sources the caller did not request.
          restrictToSources: namedSourceName !== undefined,
          includeExcludedTypes: input.includeSessions === true,
          disableProjectContext: input.disableProjectContext === true,
          disableScopedUtility: input.disableScopedUtility === true,
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
    if (!input.skipLogging) {
      logSearchEvent(
        query,
        response,
        localResult?.mode ?? "keyword",
        input.eventSource,
        input.disableScopedUtility === true,
      );
    }
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
    if (!input.skipLogging)
      logSearchEvent(query, response, undefined, input.eventSource, input.disableScopedUtility === true);
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
  if (!input.skipLogging)
    logSearchEvent(query, response, undefined, input.eventSource, input.disableScopedUtility === true);
  return response;
}

/**
 * Resolve entry IDs by file_path lookup (exact match, not LIKE).
 */
function resolveEntryIds(
  db: import("../../storage/database").Database,
  hits: SourceSearchHit[],
): Array<{ entryId: number; ref: string }> {
  const results: Array<{ entryId: number; ref: string }> = [];
  for (const hit of hits) {
    try {
      const entryId = getEntryIdByFilePath(db, hit.path);
      if (entryId !== undefined) {
        // F4c: persist the DURABLE fully-qualified `bundle//conceptId` spelling,
        // derived from the resolved entry row's `item_ref` (D-R3: durable keys
        // come from the resolved item, never raw input).
        const itemRef = getItemRefById(db, entryId);
        if (itemRef !== null) {
          results.push({ entryId, ref: itemRef });
        }
      }
    } catch {
      /* skip unresolvable */
    }
  }
  return results;
}

/**
 * Fire-and-forget: log a search event to the usage_events table.
 * Never blocks the caller; errors are silently ignored.
 *
 * Result count semantics:
 *   - `stashHitCount`: number of local stash hits (response.hits, source-only
 *     entries). Always 0 for registry-only searches.
 *   - `registryHitCount`: number of registry hits (response.registryHits).
 *     Only non-zero when source is "registry" or "both".
 *   - `resultCount`: total across both pools so telemetry reflects the actual
 *     number of results the user saw, regardless of source mode.
 *
 * Per-entry events are recorded only for stash hits because registry hits
 * have no local entry_id to reference.
 */
function logSearchEvent(
  query: string,
  response: SearchResponse,
  mode: "semantic" | "keyword" = "keyword",
  eventSource: UsageEventSource = "user",
  disableScopedUtility = false,
): void {
  // Emit a structured event to events.jsonl so workflow-trace consumers
  // detect akm search invocations without relying on stdout scraping.
  const stashHits = response.hits.filter((h): h is SourceSearchHit => h.type !== "registry");
  // D8: include registry hit refs so a show following a registry-only search generates a select event
  const registryHitRefs = (response.registryHits ?? []).map((h) => `registry:${h.id}`);
  const allResultRefs = [...stashHits.map((h) => h.ref), ...registryHitRefs];
  appendEvent({
    eventType: "search",
    metadata: { query, hitCount: stashHits.length, resultRefs: allResultRefs, mode },
  });

  try {
    // Short busy timeout: telemetry must never stall the search result behind
    // a background reindex holding the index.db write lock (30s default wait).
    // Under contention these usage hints are skipped, not waited for.
    withIndexDb(
      (db) => {
        const resolved = resolveEntryIds(db, stashHits.slice(0, 50));
        // usage_events telemetry now writes to state.db (Chunk-8 WI-8.3);
        // entry_id/entry_ref are resolved from index.db above and carried across.
        const stashHitCount = response.hits.length;
        const registryHitCount = Array.isArray(response.registryHits) ? response.registryHits.length : 0;
        withStateDbTelemetry((stateDb) => {
          for (const { entryId, ref } of resolved) {
            insertUsageEvent(stateDb, {
              event_type: "search",
              query,
              entry_id: entryId,
              entry_ref: ref,
              source: eventSource,
            });
          }
          // Count registry hits separately so registry-only searches record a
          // non-zero resultCount. response.hits is always [] when source="registry".
          insertUsageEvent(stateDb, {
            event_type: "search",
            query,
            metadata: JSON.stringify({
              resultCount: stashHitCount + registryHitCount,
              stashHitCount,
              registryHitCount,
              resolvedCount: resolved.length,
              mode,
            }),
            source: eventSource,
          });
        }, TELEMETRY_BUSY_TIMEOUT_MS);
        // Bump utility scores for all resolved entries (MemRL retrieval signal).
        // The indexer overwrites these at next reindex; bumps are temporary hints.
        // Gated to user-sourced events: pipeline searches (improve probes, task
        // runner) must not feed the utility signal (meta-review 05 DRIFT-6 —
        // the bump previously fired unconditionally, so even correctly-tagged
        // machine traffic inflated utility). utility_scores stays in index.db.
        const resolvedIds =
          eventSource === "user" ? resolved.map((r) => r.entryId).filter((id): id is number => id !== undefined) : [];
        if (resolvedIds.length > 0) {
          let scopeKey: string | undefined;
          try {
            const stashPath = response.stashDir;
            const disabled = disableScopedUtility || (stashPath && isTransientStashPath(stashPath));
            scopeKey = disabled ? undefined : getCurrentWorkflowScopeKey();
          } catch {
            // Non-fatal — fall back to global-only bumps on any error.
          }
          bumpUtilityScoresBatch(db, resolvedIds, 1.0, 0.1, scopeKey);
        }
      },
      { busyTimeoutMs: TELEMETRY_BUSY_TIMEOUT_MS },
    );
  } catch (err) {
    rethrowIfTestIsolationError(err);
    /* fire-and-forget */
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Validate a named `--source` against the bundle-derived source list (0.9.0
 * spec §10.1: a named source is a `bundles` key, matched via its derived
 * source entry's `name`, or an exact path). Throws INVALID_SOURCE_VALUE with
 * the known names before any stash access can fail differently.
 */
function assertNamedSourceExists(config: AkmConfig, namedSourceName: string): void {
  const configSources = getSources(config);
  const foundInConfig =
    configSources.some((s) => s.name === namedSourceName) || configSources.some((s) => s.path === namedSourceName);
  if (!foundInConfig) {
    const validNames = configSources.map((s) => s.name).filter((n): n is string => Boolean(n));
    const hint =
      validNames.length > 0
        ? `Known source names: ${validNames.join(", ")}`
        : "No named sources are configured. Run `akm list` to see installed stashes.";
    throw new UsageError(`Unknown source name: "${namedSourceName}". ${hint}`, "INVALID_SOURCE_VALUE");
  }
}

function normalizeLimit(limit?: number): number {
  if (typeof limit !== "number" || Number.isNaN(limit) || limit <= 0) {
    return DEFAULT_LIMIT;
  }
  return Math.min(Math.floor(limit), 200);
}

/**
 * Parse the `--source` flag value.
 *
 * Accepts:
 *   - `stash` (default) — search the local stash index only
 *   - `registry`        — search remote registries only
 *   - `both`            — search stash and registries
 *   - `local`           — alias for `stash`
 *   - Any named source from `config.sources[].name` — filters stash results to
 *     that single source only. The named-source path is detected and resolved
 *     inside `akmSearch`; this function returns the raw name so the caller can
 *     pass it through to `akmSearch` which accepts `SearchSource | string`.
 *
 * Unknown values that are not a known enum AND not a named source will still
 * produce an error inside `akmSearch` when the config lookup finds nothing.
 * This allows the CLI to accept named sources without requiring config access
 * at parse time.
 */
export function parseSearchSource(source: SearchSource | string | undefined): SearchSource | string {
  if (source === "stash" || source === "registry" || source === "both") return source;
  // Accept "local" as alias for "stash"
  if (source === "local") return "stash";
  if (typeof source === "undefined") return "stash";
  // Pass through unknown strings — they may be valid named sources.
  // `akmSearch` will validate against config.sources and throw a UsageError
  // with a helpful message if the name isn't found.
  return source;
}

export function parseBeliefFilterMode(value: string | undefined): BeliefFilterMode {
  if (value === undefined || value === "all") return "all";
  if (value === "current" || value === "historical") return value;
  throw new UsageError(
    `Invalid value for --belief: ${String(value)}. Expected one of: all|current|historical`,
    "INVALID_FLAG_VALUE",
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
