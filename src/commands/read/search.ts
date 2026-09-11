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
 * a registry search behind `--from registry|all`, and log a usage event.
 * Provider `search()` methods do not exist.
 */

import { type AkmConfig, getSources, loadConfig } from "../../core/config/config";
import { rethrowIfTestIsolationError, UsageError } from "../../core/errors";
import { appendEvent } from "../../core/events";
import type { StashEntryScope } from "../../indexer/passes/metadata";
import { resolveReadSources } from "../../indexer/read-preflight";
import { searchLocal } from "../../indexer/search/db-search";
import {
  type AttributionProjection,
  getSearchHitAttribution,
  usageEventAttributionMetadata,
} from "../../indexer/search/search-attribution";
import { tryLlmFeature } from "../../llm/feature-gate";
import { rerankDocuments } from "../../llm/rerank-client";
import { getEntryIdByFilePath, getItemRefById } from "../../storage/repositories/index-entries-repository";
// Eagerly import source providers to trigger self-registration before the
// indexer or path-resolution code runs.
import "../../sources/providers/index";
import { withStateDbTelemetry } from "../../core/state-db";
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
import { TELEMETRY_BUSY_TIMEOUT_MS, withIndexDb } from "../../storage/repositories/index-db";
import { searchRegistry } from "./registry-search";

const DEFAULT_LIMIT = 20;

interface SearchEventLoggingInput {
  skipLogging?: boolean;
  eventSource?: UsageEventSource;
  attributionProjection?: AttributionProjection;
}

export async function akmSearch(input: {
  query: string;
  type?: AkmSearchType;
  limit?: number;
  source?: SearchSource | string;
  /**
   * Optional scope filter. Each present field narrows local hits to entries
   * whose `entry.scope.<key>` exactly equals the supplied value. Unfiltered
   * queries match entries with or without scope metadata.
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
  /** Disable scoped-utility ranking for this search only. */
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
  /** Internal projection used only to decide whether derived surface content was emitted. */
  attributionProjection?: AttributionProjection;
  /**
   * Include asset-level search results from registry providers (only
   * meaningful when `source` is `registry` or `all`). Folded in from the
   * retired `akm registry search --assets` flag (0.9.0 CLI overhaul, S8).
   */
  assets?: boolean;
}): Promise<SearchResponse> {
  const t0 = Date.now();
  const query = input.query.trim();
  const normalizedQuery = query.toLowerCase();
  const searchType = input.type ?? "any";
  const limit = normalizeLimit(input.limit);
  const parsedSource = parseSearchSource(input.source ?? "local");
  const config = loadConfig();

  // Named-source filter: when --from is not a standard enum value, treat it
  // as a named source (a `bundles` key). Validated early (before
  // resolveSourceEntries, which can throw STASH_DIR_NOT_FOUND) so that a bad
  // --from name always produces INVALID_SOURCE_VALUE regardless of stash state.
  let namedSourceName: string | undefined;
  let source: SearchSource;
  if (parsedSource !== "local" && parsedSource !== "registry" && parsedSource !== "all") {
    namedSourceName = parsedSource as string;
    assertNamedSourceExists(config, namedSourceName);
    source = "local";
  } else {
    source = parsedSource as SearchSource;
  }

  // A pure `--from registry` search needs no local stash at all (this is the
  // one path folded in from the retired `akm registry search`, which never
  // touched local source/stash resolution either) — only resolve local
  // sources when local hits are actually needed, or a named source narrows
  // to a local bundle. Without this, `resolveReadSources` (which can throw
  // STASH_DIR_NOT_FOUND via `resolveStashDir()`) would make registry-only
  // search fail on a machine with no stash ever configured.
  const needsLocalSources = source !== "registry" || namedSourceName !== undefined;
  let allSources = needsLocalSources ? resolveReadSources(undefined, config).sources : [];

  // When a named source was requested, narrow the sources list to just that entry.
  // `resolveSourceEntries` sets `registryId` to `entry.name` for each config source.
  if (namedSourceName !== undefined) {
    const ns = namedSourceName;
    allSources = allSources.filter((s) => s.registryId === ns || s.path === ns);
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
          // When `--from <name>` narrowed the source list above, propagate
          // that intent down to the database layer so FTS/vector hits from
          // sources outside the narrowed set are filtered out post-ranking.
          // Without this, the index (which spans every configured source)
          // would leak hits from sources the caller did not request.
          restrictToSources: namedSourceName !== undefined,
          includeExcludedTypes: input.includeSessions === true,
          disableProjectContext: input.disableProjectContext === true,
          disableScopedUtility: input.disableScopedUtility === true,
        });

  // #951 (moved from curate in 0.9.16 — the pass was always meant for
  // search). Applied ONCE here, to LOCAL hits only, before the source
  // branches below divide the same `localResult.hits` between the "local"
  // and "all" responses — so both get the rerank and neither double-applies
  // it. `localResult` is `undefined` for `source === "registry"`, so a
  // registry-only search never reaches this call and never pays for the
  // reranker's HTTP request; registry hits are never reranked (registry
  // results staying separate from stash hits is a locked contract,
  // AGENTS.md).
  const rerankedLocalHits = localResult ? await maybeRerankSearchHits(query, localResult.hits, config) : undefined;

  const registryResult =
    source === "local"
      ? undefined
      : await searchRegistry(query, { limit, includeAssets: input.assets === true, registries: config.registries });

  if (source === "local") {
    const localHits = rerankedLocalHits ?? [];
    const hasResults = localHits.length > 0;
    const response: SearchResponse = {
      schemaVersion: 1,
      bundleDir: stashDir,
      source,
      hits: localHits,
      tip: hasResults ? undefined : localResult?.tip,
      warnings: localResult?.warnings?.length ? localResult.warnings : undefined,
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
  const allStashHits = (rerankedLocalHits ?? []).slice(0, limit);
  const warnings = [...(localResult?.warnings ?? []), ...(registryResult?.warnings ?? [])];
  const hasResults = allStashHits.length > 0 || registryHits.length > 0;

  const response: SearchResponse = {
    schemaVersion: 1,
    bundleDir: stashDir,
    source,
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

/** Usage telemetry retains its historical semantic|keyword vocabulary. */
function usageSearchMode(mode: SearchExecutionMode | undefined): "semantic" | "keyword" {
  return mode === "semantic" ? "semantic" : "keyword";
}

/** Default number of `searchLocal`'s already-ranked LOCAL hits sent to the reranker when `search.rerank.topN` isn't set. */
const DEFAULT_SEARCH_RERANK_TOP_N = 8;

/**
 * Optional cross-encoder rerank pass over `akm search`'s already-ranked LOCAL
 * hits (#951, moved from `akm curate` in 0.9.16 — the pass was always meant
 * for search). Disabled by default (`search.rerank.enabled` is falsy) and,
 * when enabled, best-effort: any failure (misconfigured endpoint, network
 * error, timeout, malformed response, an out-of-range or duplicate index in
 * the response) falls back to `searchLocal`'s own ranking unchanged — a
 * reranker outage must never turn into a search failure.
 *
 * Only the top `topN` (default {@link DEFAULT_SEARCH_RERANK_TOP_N}) hits are
 * sent (bounded request size); anything past that keeps its original
 * position appended after the reranked prefix. The reranker changes ARRAY
 * ORDER only — each hit's own `score` is left untouched as the retrieval
 * score (see docs/reference/cli.md and docs/reference/configuration.md for
 * why: `SearchHit.score` is a locked `[0,1]` contract downstream consumers
 * compare and threshold on, while ordering is the field a rerank-aware
 * consumer reads).
 */
async function maybeRerankSearchHits(
  query: string,
  hits: SourceSearchHit[],
  config: AkmConfig,
): Promise<SourceSearchHit[]> {
  if (hits.length <= 1) return hits;
  const rerankConfig = config.search?.rerank;
  return tryLlmFeature(
    "search_rerank",
    config,
    async () => {
      const topN = rerankConfig?.topN ?? DEFAULT_SEARCH_RERANK_TOP_N;
      const head = hits.slice(0, topN);
      const tail = hits.slice(topN);
      const documents = head.map((hit) => [hit.name, hit.description].filter(Boolean).join(" — "));
      const ranked = await rerankDocuments(rerankConfig ?? {}, query, documents);
      const rerankedHead = ranked
        .map(({ index }) => head[index])
        .filter((hit): hit is SourceSearchHit => hit !== undefined);
      return [...rerankedHead, ...tail];
    },
    hits,
    { timeoutMs: rerankConfig?.timeoutMs ?? null },
  );
}

function maybeLogSearchEvent(
  input: SearchEventLoggingInput,
  query: string,
  response: SearchResponse,
  mode?: "semantic" | "keyword",
): void {
  if (input.skipLogging) return;
  logSearchEvent(query, response, mode, input.eventSource, input.attributionProjection);
}

/**
 * Resolve entry IDs by file_path lookup (exact match, not LIKE).
 */
function resolveEntryIds(
  db: import("../../storage/database").Database,
  hits: SourceSearchHit[],
): Array<{ entryId: number; ref: string; hit: SourceSearchHit }> {
  const results: Array<{ entryId: number; ref: string; hit: SourceSearchHit }> = [];
  for (const hit of hits) {
    try {
      const entryId = getEntryIdByFilePath(db, hit.path);
      if (entryId !== undefined) {
        // F4c: persist the DURABLE fully-qualified `bundle//conceptId` spelling,
        // derived from the resolved entry row's `item_ref` (D-R3: durable keys
        // come from the resolved item, never raw input).
        const itemRef = getItemRefById(db, entryId);
        if (itemRef !== null) {
          results.push({ entryId, ref: itemRef, hit });
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
 *     Only non-zero when source is "registry" or "all".
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
  attributionProjection: AttributionProjection = "full",
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
          for (const { entryId, ref, hit } of resolved) {
            insertUsageEvent(stateDb, {
              event_type: "search",
              query,
              entry_id: entryId,
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
            }),
            source: eventSource,
          });
        }, TELEMETRY_BUSY_TIMEOUT_MS);
        // No live utility_scores/utility_scores_scoped write here (#862): a
        // search result is an impression, not a signal that the asset was
        // useful. Rewarding every returned hit created a feedback loop where
        // merely appearing in results inflated future ranking — assets
        // surfaced because they'd surfaced before, not because a user acted
        // on them. Retrieval counts are still recorded above via
        // insertUsageEvent (search_count) and rolled into utility_scores by
        // the offline `recomputeUtilityScores` pass (`akm index`), which uses
        // the show/search *select rate* — a ratio that requires an actual
        // `show`/select event, not raw impressions. Explicit signal comes
        // from `akm feedback` (applyFeedbackToUtilityScore) and from
        // selection (recordShowUsage / the `select` event derived from it).
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
 * Validate a named `--from` against the bundle-derived source list (0.9.0
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
 *     The named-source path is detected and resolved
 *     inside `akmSearch`; this function returns the raw name so the caller can
 *     pass it through to `akmSearch` which accepts `SearchSource | string`.
 *
 * Unknown values that are not a known enum AND not a named source will still
 * produce an error inside `akmSearch` when the config lookup finds nothing.
 * This allows the CLI to accept named sources without requiring config access
 * at parse time.
 */
export function parseSearchSource(source: SearchSource | string | undefined): SearchSource | string {
  if (source === "local" || source === "registry" || source === "all") return source;
  if (typeof source === "undefined") return "local";
  // 0.9.0 (S8): `--source stash`/`--source both` renamed to `--from
  // local`/`--from all`. Reject the retired values explicitly — otherwise
  // they fall through to the named-source lookup below and surface as a
  // misleading "no source named stash/both" error instead of naming the
  // rename.
  if (source === "stash") {
    throw new UsageError('"stash" was renamed to "local" in 0.9. Use `--from local` instead.', "INVALID_FLAG_VALUE");
  }
  if (source === "both") {
    throw new UsageError('"both" was renamed to "all" in 0.9. Use `--from all` instead.', "INVALID_FLAG_VALUE");
  }
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
 * Parse repeated `--filter k=v` argv tokens into a
 * `StashEntryScope`. Throws a {@link UsageError} for malformed tokens
 * (missing `=`, unknown key) so callers don't see ambiguous misses.
 *
 * Used by both `akm search --filter` and `akm show --filter` — the two
 * commands share one spelling for the scope-narrowing axis.
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
 * `filters`. A missing `entry.scope` only matches when `filters` is empty or
 * undefined.
 *
 * Filter semantics:
 *   - No filter passed → all entries match.
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
