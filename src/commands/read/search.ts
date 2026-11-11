// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm search` — entry point.
 *
 * Search consults the local FTS5 index. There is one query path
 * because there is one data store; there is no provider fan-out.
 *
 * The orchestration here is thin: build the FTS query, optionally interleave
 * a registry search behind `--from registry|all`, and log a usage event.
 * Provider `search()` methods do not exist.
 */

import { type AkmConfig, getSources, loadConfig } from "../../core/config/config";
import { rethrowIfTestIsolationError, UsageError } from "../../core/errors";
import { appendEvent } from "../../core/events";
import { type IncludeSelectors, includedTypes, includesProposed, normalizeInclude } from "../../core/include";
import { redactCredentialPatterns } from "../../core/redaction";
import { withStateDbTelemetry } from "../../core/state-db";
import type { ScopeFilters } from "../../indexer/passes/metadata";
import { resolveReadSources } from "../../indexer/read-preflight";
import { type ProjectContext, searchLocal } from "../../indexer/search/db-search";
import {
  type AttributionProjection,
  getSearchHitAttribution,
  usageEventAttributionMetadata,
} from "../../indexer/search/search-attribution";
import { insertUsageEvent, type UsageEventSource } from "../../indexer/usage/usage-events";
import type {
  AkmSearchType,
  BeliefFilterMode,
  RegistrySearchResultHit,
  SearchExecutionMode,
  SearchResponse,
  SearchSource,
  SourceSearchHit,
} from "../../sources/types";
import { TELEMETRY_BUSY_TIMEOUT_MS } from "../../storage/repositories/index-db";
import { searchRegistry } from "./registry-search";

const DEFAULT_LIMIT = 20;

function duplicateConceptWarnings(hits: SourceSearchHit[], defaultBundle?: string): string[] {
  const ownersByConcept = new Map<string, string[]>();
  for (const hit of hits) {
    const displayRef = hit.ref.split("#", 1)[0] ?? hit.ref;
    const boundary = displayRef.indexOf("//");
    const conceptId = boundary >= 0 ? displayRef.slice(boundary + 2) : displayRef;
    const owner = hit.origin ?? defaultBundle ?? "working-bundle";
    const owners = ownersByConcept.get(conceptId) ?? [];
    if (!owners.includes(owner)) owners.push(owner);
    ownersByConcept.set(conceptId, owners);
  }

  return [...ownersByConcept]
    .filter(([, owners]) => owners.length > 1)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([conceptId, owners]) =>
        `Multiple bundles provide "${conceptId}": ${owners.join(", ")}. ` +
        "Unqualified refs resolve by configured bundle priority; use a bundle-qualified ref to select explicitly.",
    );
}

interface SearchEventLoggingInput {
  skipLogging?: boolean;
  byUsage?: boolean;
  readOnly?: boolean;
  eventSource?: UsageEventSource;
  attributionProjection?: AttributionProjection;
}

export async function akmSearch(input: {
  query: string;
  type?: AkmSearchType;
  limit?: number;
  source?: SearchSource | string | string[];
  /**
   * Optional scope filter. Each present field narrows local hits to entries
   * whose `entry.scope.<key>` exactly equals the supplied value. Unfiltered
   * queries match entries with or without scope metadata.
   *
   * Eligibility is applied before each channel's candidate budget.
   */
  filters?: ScopeFilters;
  /**
   * Optional scope preference, same keys and match rule as `filters`. Matching
   * local hits rank first; it never drops or admits a hit.
   */
  prefer?: ScopeFilters;
  /** Inclusive `YYYY-MM-DD` bounds on the hit's `observed` date, else `updated`. Local hits only. */
  since?: string;
  until?: string;
  /**
   * When true, hits with `quality === "proposed"` are kept in the result
   * set. Default behavior excludes them. The flag has no
   * effect on registry hits.
   */
  includeProposed?: boolean;
  include?: IncludeSelectors;
  /**
   * Belief-state filter. Applies to ANY entry carrying a `beliefState`
   * (memory OR knowledge — 03), so flagged knowledge is filtered too:
   * - `all` keeps current + historical hits
   * - `current` keeps active/asserted/unspecified beliefs (and unflagged entries; default)
   * - `historical` keeps deprecated/contradicted/superseded/archived beliefs
   */
  belief?: BeliefFilterMode;
  /**
   * #627 — when true, re-include asset types normally hidden from the default
   * (untyped) search path via `config.search.defaultExcludeTypes` (notably
   * `session`). No effect when an explicit `type` is supplied.
   */
  includeSessions?: boolean;
  /**
   * When true, skip logging usage events. Used by internal callers
   * (curate, improve context gathering) to avoid polluting user
   * search history with programmatic lookups.
   */
  skipLogging?: boolean;
  /**
   * Read without side effects (the workspace): no usage events and no inline index
   * build, so the search never counts as demand and never writes `index.db`
   * or `state.db`. Implies `skipLogging`.
   */
  readOnly?: boolean;
  /**
   * Event source for usage logging. Defaults to `"user"`. Set to
   * `"improve"` when called from improve's reflect/distill agents
   * so events can be filtered out of user-facing history.
   */
  eventSource?: UsageEventSource;
  /** Internal projection used only to decide whether derived surface content was emitted. */
  attributionProjection?: AttributionProjection;
  /**
   * Present: the call runs under project selection (`name` absent: no project). The applicable
   * `rules/` assets are those naming the project and shared ones; other projects' rules are
   * never returned.
   */
  project?: ProjectContext;
  /**
   * List instead of search: the eligible assets that were shown in the project (every show when `project`
   * names none), most shown first, ties by ref. Takes no query; records no usage event; rules are not listed.
   */
  byUsage?: boolean;
}): Promise<SearchResponse> {
  const t0 = Date.now();
  const byUsage = input.byUsage === true;
  const query = byUsage ? "" : input.query.trim();
  const searchType = input.type ?? "any";
  const limit = normalizeLimit(input.limit);
  const parsedSource = parseSearchSource(input.source ?? "local");
  const config = loadConfig();

  // Named-source filter: when --from is not a standard enum value, treat it
  // as a named source (a `bundles` key). Validated early (before
  // resolveSourceEntries, which can throw STASH_DIR_NOT_FOUND) so that a bad
  // --from name always produces INVALID_SOURCE_VALUE regardless of stash state.
  let namedSourceNames: string[] | undefined;
  let source: SearchSource;
  if (
    Array.isArray(parsedSource) ||
    (parsedSource !== "local" && parsedSource !== "registry" && parsedSource !== "all")
  ) {
    namedSourceNames = Array.isArray(parsedSource) ? parsedSource : [parsedSource];
    for (const name of namedSourceNames) assertNamedSourceExists(config, name);
    source = "local";
  } else {
    source = parsedSource;
  }
  if (byUsage) source = "local";

  // A pure `--from registry` search needs no local stash at all (this is the
  // one path folded in from the retired `akm registry search`, which never
  // touched local source/stash resolution either) — only resolve local
  // sources when local hits are actually needed, or a named source narrows
  // to a local bundle. Without this, `resolveReadSources` (which can throw
  // STASH_DIR_NOT_FOUND via `resolveStashDir()`) would make registry-only
  // search fail on a machine with no stash ever configured.
  const needsLocalSources = source !== "registry" || namedSourceNames !== undefined;
  let allSources = needsLocalSources ? resolveReadSources(undefined, config).sources : [];

  // When a named source was requested, narrow the sources list to just that entry.
  // `resolveSourceEntries` sets `registryId` to `entry.name` for each config source.
  if (namedSourceNames !== undefined) {
    allSources = narrowSourcesToName(allSources, namedSourceNames);
    // allSources may still be empty if the configured source dir doesn't exist on
    // disk (resolveSourceEntries skips non-existent dirs). Fall through to the
    // zero-sources guard below which emits a friendly warning.
  }

  if (needsLocalSources && allSources.length === 0) {
    // stashDir: "" is a safe sentinel here — the response carries zero hits
    // and a warning, so no downstream code will try to use the empty path.
    const response: SearchResponse = {
      schemaVersion: 1,
      bundleDir: "",
      source,
      hits: [],
      warnings: ["No bundles configured. Run `akm bundle create` to create your working bundle."],
      timing: { totalMs: Date.now() - t0 },
    };
    maybeLogSearchEvent(input, query, response);
    return response;
  }
  // Primary stash directory — used for DB path lookups and as the default
  // stash root. Empty when a pure registry search skipped local resolution
  // entirely (safe: registry-only responses never read `stashDir`).
  const stashDir = allSources[0]?.path ?? "";
  // Expose the filtered source list to downstream search calls.
  const sources = allSources;

  const filters = normalizeScopeFilters(input.filters);
  const include = normalizeInclude(input.include);
  const includeProposed = input.includeProposed === true || includesProposed(include);
  const belief = parseBeliefFilterMode(input.belief ?? "current");
  const localResult =
    source === "registry"
      ? undefined
      : await searchLocal({
          query,
          searchType,
          limit,
          stashDir,
          sources,
          config,
          filters,
          prefer: normalizeScopeFilters(input.prefer),
          since: input.since,
          until: input.until,
          includeProposed,
          beliefFilter: belief,
          // When `--from <name>` narrowed the source list above, propagate
          // that intent down to the database layer so FTS/vector hits from
          // sources outside the narrowed set cannot consume candidate budgets.
          // Without this, the index (which spans every configured source)
          // would leak hits from sources the caller did not request.
          restrictToSources: namedSourceNames !== undefined,
          includeExcludedTypes: input.includeSessions === true,
          includeTypes: includedTypes(include),
          readOnly: input.readOnly,
          project: input.project,
          byUsage,
        });
  const registryResult =
    source === "local" ? undefined : await searchRegistry(query, { limit, registries: config.registries });

  if (source === "local") {
    const localHits = localResult?.hits ?? [];
    const warnings = [
      ...(localResult?.warnings ?? []),
      ...duplicateConceptWarnings(localHits, config.defaultBundle),
      ...(byUsage && input.query.trim() ? ["--by-usage lists by use and ignores the query."] : []),
      ...(byUsage && (parsedSource === "registry" || parsedSource === "all")
        ? [`--by-usage lists local bundles and ignores --from ${parsedSource}.`]
        : []),
    ];
    const hasResults = localHits.length > 0;
    const response: SearchResponse = {
      schemaVersion: 1,
      bundleDir: stashDir,
      source,
      ...bundlesField(namedSourceNames),
      hits: localHits,
      tip: hasResults ? undefined : localResult?.tip,
      warnings: warnings.length ? warnings : undefined,
      searchMode: localResult?.mode ?? "keyword",
      timing: { totalMs: Date.now() - t0, rankMs: localResult?.rankMs, embedMs: localResult?.embedMs },
    };
    maybeLogSearchEvent(input, query, response, usageSearchMode(localResult?.mode));
    return response;
  }

  const registryHits = (registryResult?.hits ?? []).map((hit): RegistrySearchResultHit => {
    const installRef = hit.installRef;
    // Hit-level `warnings` are forwarded when the provider surfaced any.
    return {
      type: "registry",
      name: hit.title,
      id: hit.id,
      description: hit.description,
      action: `akm bundle add ${installRef} -> then search again`,
      installRef,
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
      bundleDir: stashDir,
      source,
      hits: [],
      registryHits: slicedRegistryHits,
      tip: hasResults ? undefined : "No matching registry entries were found.",
      warnings: registryResult?.warnings.length ? registryResult.warnings : undefined,
      timing: { totalMs: Date.now() - t0 },
    };
    maybeLogSearchEvent(input, query, response);
    return response;
  }

  // source === "all"
  const allStashHits = (localResult?.hits ?? []).slice(0, limit);
  const warnings = [
    ...(localResult?.warnings ?? []),
    ...duplicateConceptWarnings(allStashHits, config.defaultBundle),
    ...(registryResult?.warnings ?? []),
  ];
  const hasResults = allStashHits.length > 0 || registryHits.length > 0;

  const response: SearchResponse = {
    schemaVersion: 1,
    bundleDir: stashDir,
    source,
    ...bundlesField(namedSourceNames),
    hits: allStashHits,
    registryHits,
    tip: hasResults ? undefined : "No matching stash assets or registry entries were found.",
    warnings: warnings.length ? warnings : undefined,
    searchMode: localResult?.mode ?? "keyword",
    timing: { totalMs: Date.now() - t0 },
  };
  maybeLogSearchEvent(input, query, response, usageSearchMode(localResult?.mode));
  return response;
}

/** Several `--from` bundles are reported back; a single one reports nothing extra, as before. */
function bundlesField(names: string[] | undefined): { bundles?: string[] } {
  return names !== undefined && names.length > 1 ? { bundles: names } : {};
}

/** Usage telemetry retains its historical semantic|keyword vocabulary. */
function usageSearchMode(mode: SearchExecutionMode | undefined): "semantic" | "keyword" {
  return mode === "semantic" ? "semantic" : "keyword";
}

function maybeLogSearchEvent(
  input: SearchEventLoggingInput,
  query: string,
  response: SearchResponse,
  mode?: "semantic" | "keyword",
): void {
  if (input.skipLogging || input.readOnly || input.byUsage) return;
  logSearchEvent(query, response, mode, input.eventSource, input.attributionProjection);
}

/** The sources the named `--from <name>` values select (any of them): matched on `registryId` or path. */
export function narrowSourcesToName<T extends { registryId?: string; path: string }>(
  sources: T[],
  names: string | readonly string[],
): T[] {
  const wanted = typeof names === "string" ? [names] : names;
  return sources.filter((s) => wanted.some((name) => s.registryId === name || s.path === name));
}

/**
 * Fire-and-forget: log a search event to the usage_events table.
 * Never blocks the caller; errors are silently ignored.
 *
 * Result count semantics:
 *   - `stashHitCount`: number of local stash hits (response.hits, source-only
 *     entries). Always 0 for registry-only searches.
 *   - `registryHitCount`: number of registry hits (response.registryHits).
 *     Only non-zero when source is "registry" or "all".
 *   - `resultCount`: total across both pools so telemetry reflects the actual
 *     number of results the user saw, regardless of source mode.
 *
 * Per-entry events are recorded only for stash hits because registry hits
 * have no local entry_id to reference.
 */
function logSearchEvent(
  rawQuery: string,
  response: SearchResponse,
  mode: "semantic" | "keyword" = "keyword",
  eventSource: UsageEventSource = "user",
  attributionProjection: AttributionProjection = "full",
): void {
  // Credentials pasted into a query (e.g. by the Claude Code hook that
  // curates every user prompt) must never reach state.db verbatim — see
  // `redactCredentialPatterns`. Redacted once here so every persistence call
  // below (events.metadata_json via appendEvent, usage_events.query via
  // insertUsageEvent) gets the same scrubbed text.
  const query = redactCredentialPatterns(rawQuery);
  // Emit a structured event to events.jsonl so workflow-trace consumers
  // detect akm search invocations without relying on stdout scraping.
  const stashHits = response.hits.filter((h): h is SourceSearchHit => h.type !== "registry");
  // Include registry hit refs so a show following a registry-only search generates a select event
  const registryHitRefs = (response.registryHits ?? []).map((h) => `registry:${h.id}`);
  // Lets a later `select` name the search it came from, so metrics can dedupe
  // repeated shows of one result and attribute them to this search's source.
  const searchId = crypto.randomUUID();
  const allResultRefs = [...stashHits.map((h) => h.ref), ...registryHitRefs];
  appendEvent({
    eventType: "search",
    metadata: { query, hitCount: stashHits.length, resultRefs: allResultRefs, mode, source: eventSource, searchId },
  });

  try {
    // Each hit already carries its durable `bundle//conceptId` ref, so no index
    // connection is opened here. Short busy timeout: telemetry must never stall
    // the search result behind a background write on state.db.
    const resolved = stashHits.slice(0, 50).flatMap((hit) => (hit.itemRef ? [{ ref: hit.itemRef, hit }] : []));
    const stashHitCount = response.hits.length;
    const registryHitCount = Array.isArray(response.registryHits) ? response.registryHits.length : 0;
    withStateDbTelemetry((stateDb) => {
      for (const { ref, hit } of resolved) {
        insertUsageEvent(stateDb, {
          event_type: "search",
          query,
          entry_ref: ref,
          metadata: usageEventAttributionMetadata(getSearchHitAttribution(hit), ref, attributionProjection),
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
          // Whole-search latency plus the rank/embed phases when the local
          // search reported them, so `akm metrics` can show timings later.
          totalMs: response.timing?.totalMs,
          rankMs: response.timing?.rankMs,
          embedMs: response.timing?.embedMs,
        }),
        source: eventSource,
      });
    }, TELEMETRY_BUSY_TIMEOUT_MS);
    // No live utility_scores write here (#862): a search result is an
    // impression, not a signal that the asset was useful. Retrieval
    // counts are recorded above via insertUsageEvent (search_count) and
    // rolled into utility_scores by the offline `recomputeUtilityScores`
    // pass (`akm index`).
  } catch (err) {
    rethrowIfTestIsolationError(err);
    /* fire-and-forget */
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Validate a named `--from` against the bundle-derived source list (a named
 * source is a `bundles` key, matched via its derived
 * source entry's `name`, or an exact path). Throws INVALID_SOURCE_VALUE with
 * the known names before any stash access can fail differently.
 */
function assertNamedSourceExists(config: AkmConfig, namedSourceName: string): void {
  const configSources = getSources(config);
  const foundInConfig = configSources.find(
    (source) => source.name === namedSourceName || source.path === namedSourceName,
  );
  if (foundInConfig?.enabled === false) {
    throw new UsageError(`Source "${namedSourceName}" is disabled.`, "INVALID_SOURCE_VALUE");
  }
  if (!foundInConfig) {
    const validNames = configSources
      .filter((source) => source.enabled !== false)
      .map((source) => source.name)
      .filter((name): name is string => Boolean(name));
    const hint =
      validNames.length > 0
        ? `Known source names: ${validNames.join(", ")}`
        : "No named sources are configured. Run `akm bundle list` to see installed bundles.";
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
 * Parse the `--from` flag value.
 *
 * Accepts:
 *   - `local` (default) — search the local stash index only
 *   - `registry`        — search remote registries only
 *   - `all`             — search local and registries
 *   - Any named configured bundle — filters local results to that bundle only.
 *     Repeated (an array), several bundles are searched as one set (OR); a
 *     keyword cannot be mixed with bundle names.
 *     The named-source path is detected and resolved
 *     inside `akmSearch`; this function returns the raw name so the caller can
 *     pass it through to `akmSearch` which accepts `SearchSource | string`.
 *
 * Unknown values that are not a known enum AND not a named source will still
 * produce an error inside `akmSearch` when the config lookup finds nothing.
 * This allows the CLI to accept named sources without requiring config access
 * at parse time.
 */
export function parseSearchSource(
  source: SearchSource | string | string[] | undefined,
): SearchSource | string | string[] {
  if (Array.isArray(source)) {
    const names = [...new Set(source)];
    if (names.length <= 1) return parseSearchSource(names[0]);
    const keyword = names.find((name) => name === "local" || name === "registry" || name === "all");
    if (keyword !== undefined) {
      throw new UsageError(
        `--from "${keyword}" cannot be combined with other --from values. Repeat --from only for bundle names.`,
        "INVALID_SOURCE_VALUE",
        `Use "${keyword}" alone, or repeat --from with configured bundle names only.`,
      );
    }
    return names;
  }
  if (source === "local" || source === "registry" || source === "all") return source;
  if (typeof source === "undefined") return "local";
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
 * Normalise scope filters to per-key value lists: strings are trimmed, and
 * non-string values and duplicates are dropped; an empty string stays (it
 * selects assets without the key). Returns `undefined`
 * when nothing meaningful remains, so callers don't pay for an empty-filter
 * post-walk in `searchLocal`.
 */
export function normalizeScopeFilters(raw: ScopeFilters | undefined): ScopeFilters | undefined {
  if (!raw) return undefined;
  const out: Record<string, string[]> = Object.create(null);
  for (const [key, given] of Object.entries(raw)) {
    const values = new Set<string>();
    for (const value of Array.isArray(given) ? given : [given]) {
      if (typeof value === "string") values.add(value.trim());
    }
    if (values.size > 0) out[key] = [...values];
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Parse repeated `--filter k=v` argv tokens into a
 * `ScopeFilters`: a repeated key collects all its values (matched as OR; see
 * `scopeMatchesFilters`). An empty value (`key=`) selects assets without the
 * key. Throws a {@link UsageError} for malformed tokens (missing `=` or an
 * empty key) so callers don't see ambiguous misses.
 *
 * Used by `akm search --filter` and `akm curate --filter`.
 */
export function parseScopeFilterFlags(values: string[], flagName = "--filter"): ScopeFilters | undefined {
  if (values.length === 0) return undefined;
  const out: Record<string, string[]> = Object.create(null);
  for (const raw of values) {
    const eq = raw.indexOf("=");
    if (eq <= 0) {
      throw new UsageError(`Invalid ${flagName} value "${raw}". Expected key=value (e.g. team=platform).`);
    }
    const key = raw.slice(0, eq).trim();
    const value = raw.slice(eq + 1).trim();
    if (!key) {
      throw new UsageError(`Invalid ${flagName} value "${raw}". Expected key=value (e.g. team=platform).`);
    }
    out[key] = [...(out[key] ?? []), value];
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
