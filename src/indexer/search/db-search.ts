// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Database-backed (SQLite FTS5 + vector) search.
 *
 * Ranking is two candidate channels fused by reciprocal rank (`ranking.ts`):
 * BM25 over whole documents matching any query word, and the nearest document
 * vectors to the query embedding. Filters narrow the fused list; nothing else
 * reorders it.
 */

import path from "node:path";
import { stashDirFor } from "../../core/asset/asset-placement";
import { displayRef } from "../../core/asset/resolve-ref";
import { compareCodePoints } from "../../core/common";
import type { AkmConfig } from "../../core/config/config";
import { classifyPathAccess } from "../../core/path-access";
import { getDbPath } from "../../core/paths";
import { systemErrorCode } from "../../core/system-error";
import { presentationFor } from "../../core/type-presentation";
import { embed } from "../../llm/embedder";
import { applyEmbeddingTemplate, resolveEmbeddingProfile } from "../../llm/embedders/profile";
import { normalizeEmbeddingEndpoint } from "../../llm/embedders/remote";
import type {
  AkmSearchType,
  BeliefFilterMode,
  SearchExecutionMode,
  SearchHitSize,
  SourceSearchHit,
} from "../../sources/types";
import type { Database } from "../../storage/database";
import {
  assertIndexPathReadable,
  closeDatabase,
  openExistingDatabase,
} from "../../storage/repositories/index-connection";
import {
  getAllEntries,
  getBaseBeliefStatesForDerivedTwins,
  getEntryById,
  getEntryCount,
  getEntryRefsAndTypes,
} from "../../storage/repositories/index-entries-repository";
import type { DbVecResult } from "../../storage/repositories/index-entry-types";
import { searchFts } from "../../storage/repositories/index-fts-repository";
import { getMeta } from "../../storage/repositories/index-meta-repository";
import { getEmbeddingCount, searchVec } from "../../storage/repositories/index-vec-repository";
import { ensureIndex } from "../ensure-index";
import { type IndexDocument, isProposedQuality, type StashEntryScope } from "../passes/metadata";
import { ftsQueryTokens, parseRefPrefixQuery, parseRetiredTypePrefixQuery } from "./fts-query";
import { type FusedCandidate, type RankedRef, reciprocalRankFusion } from "./ranking";
import { attachSearchHitAttribution } from "./search-attribution";
import { enrichSearchHit } from "./search-hit-enrichers";
import { buildEditHint, findSourceForPath, isEditable, type SearchSource } from "./search-source";

/**
 * Age past which search surfaces a "run akm index" hint. Reads serve the
 * existing index as-is (freshness is the writers' job — `indexWrittenAssets`
 * plus full runs), so on installs with no improve cron a hand-edited or
 * git-pulled file stays invisible until someone reindexes. The hint makes that
 * actionable without re-introducing read-triggered reindexing.
 */
const STALE_INDEX_HINT_MS = 7 * 24 * 60 * 60 * 1000;

/** Candidates each channel contributes to fusion. */
const CHANNEL_DEPTH = 100;

/** How long search waits for the query embedding unless `embedding.queryTimeoutMs` says otherwise. */
export const DEFAULT_QUERY_EMBED_TIMEOUT_MS = 3000;

type IndexedProvenance = { itemRef: string; bundleId: string; conceptId: string };

/** Each search hit's indexed content, kept off the output object for curate's reranker. */
const hitContent = new WeakMap<SourceSearchHit, string>();

/** The indexed (safe-projected) content of a hit this process's search returned. */
export function searchHitContent(hit: SourceSearchHit): string | undefined {
  return hitContent.get(hit);
}

function hasIndexedProvenance<
  T extends { itemRef?: string | null; bundleId?: string | null; conceptId?: string | null },
>(entry: T): entry is T & IndexedProvenance {
  return Boolean(entry.itemRef && entry.bundleId && entry.conceptId);
}

function buildStaleIndexHint(db: Database): string | undefined {
  try {
    const builtAt = getMeta(db, "builtAt");
    if (!builtAt) return undefined;
    const ageMs = Date.now() - new Date(builtAt).getTime();
    if (!Number.isFinite(ageMs) || ageMs < STALE_INDEX_HINT_MS) return undefined;
    const days = Math.floor(ageMs / (24 * 60 * 60 * 1000));
    return `Search index was last built ${days} day(s) ago. Files added or edited outside akm since then are not searchable — run 'akm index' to refresh.`;
  } catch {
    return undefined;
  }
}

export function buildLocalAction(type: string, ref: string): string {
  return presentationFor(type).action?.(ref) ?? `akm show ${ref}`;
}

function resolveSearchHitRef(entry: IndexDocument, provenance: IndexedProvenance, defaultBundleId?: string): string {
  return displayRef(
    {
      type: entry.type,
      name: entry.name,
      conceptId: provenance.conceptId,
      bundleId: provenance.bundleId,
    },
    defaultBundleId,
  );
}

// ── Main search entrypoint ───────────────────────────────────────────────────

/**
 * Whether an embedding provider is actually configured.
 *
 * A remote provider needs BOTH endpoint and model. A LOCAL provider needs
 * neither — `embedding.localModel` selects a transformers model that runs in
 * process. Checking only the remote pair told every local-provider user that
 * "no embedding provider is configured" and pointed them at
 * `akm config set embedding '{"endpoint":...}'`, which is the wrong remedy and
 * hid the real diagnostic recorded in the semantic status.
 */
function hasConfiguredEmbeddingProvider(config: {
  embedding?: { endpoint?: string; model?: string; localModel?: string };
}): boolean {
  if (config.embedding?.localModel) return true;
  return Boolean(config.embedding?.endpoint && config.embedding?.model);
}

export interface SearchLocalInput {
  query: string;
  searchType: AkmSearchType;
  limit: number;
  stashDir: string;
  sources: SearchSource[];
  config: AkmConfig;
  /**
   * Optional scope filter (`user`, `agent`, `run`, `channel`). When present,
   * hits whose `entry.scope` does not satisfy every supplied key are dropped
   * after fusion — filtering narrows the result set, it does not reorder it.
   */
  filters?: StashEntryScope;
  /**
   * When true, entries with `quality === "proposed"` are kept in the result
   * set. By default (false) they are filtered out after fusion per v1
   * spec §4.2.
   */
  includeProposed?: boolean;
  beliefFilter?: BeliefFilterMode;
  /**
   * When true, hits are restricted to entries whose file path lives under one of
   * the provided `sources`. Set by callers that narrowed `sources` via a
   * `--from <name>` filter so the FTS index (which spans all sources) does
   * not leak hits from sources the caller did not request. Default false
   * preserves prior behavior for the unnamed default search path.
   */
  restrictToSources?: boolean;
  /**
   * #627 — when true, re-include the asset types normally hidden from the
   * default (untyped) path via `config.search.defaultExcludeTypes` (notably
   * `session`). No effect when an explicit `--type` is supplied.
   */
  includeExcludedTypes?: boolean;
}

export async function searchLocal(input: SearchLocalInput): Promise<{
  hits: SourceSearchHit[];
  tip?: string;
  warnings?: string[];
  embedMs?: number;
  rankMs?: number;
  /** Actual ranking mode, including a failed semantic attempt. */
  mode: SearchExecutionMode;
}> {
  const { query, stashDir, config } = input;
  const warnings: string[] = [];
  // Semantic search is attempted fresh on every query (see `startVectorChannel`);
  // there is no cached readiness verdict to consult here. The only thing
  // worth flagging ahead of the attempt is a config that can never succeed.
  if (config.semanticSearchMode === "auto" && !hasConfiguredEmbeddingProvider(config)) {
    warnings.push(
      "Semantic search is enabled (semanticSearchMode='auto') but no embedding provider is configured. " +
        'Either: (a) `akm config set embedding \'{"endpoint":"...","model":"..."}\'`, or ' +
        "(b) `akm config set semanticSearchMode off` to use keyword-only search.",
    );
  }

  // Bootstrap-only: builds the index inline when it cannot serve this stash.
  // Content freshness is the writers' job (indexWrittenAssets + full runs);
  // reads serve the existing index as-is.
  await ensureIndex(stashDir);

  const dbPath = getDbPath();
  // An index we cannot READ is not an index that does not exist (#791). Saying
  // "No search index available" for a populated index the caller merely lacks
  // permission on is a lie at exit 0 — and an agent consuming this JSON has no
  // way to tell it from a genuine empty result, so it relays the lie onward.
  assertIndexPathReadable(dbPath);
  if (classifyPathAccess(dbPath).access === "absent") {
    return {
      hits: [],
      tip: "No search index available. Run 'akm index' to build one.",
      warnings: warnings.length > 0 ? warnings : undefined,
      mode: "keyword",
    };
  }

  const db = openExistingDatabase(dbPath);
  try {
    const entryCount = getEntryCount(db);
    if (entryCount === 0) {
      return {
        hits: [],
        tip: "Index is empty. Run 'akm index' to populate it.",
        warnings: warnings.length > 0 ? warnings : undefined,
        mode: "keyword",
      };
    }

    const staleHint = buildStaleIndexHint(db);
    if (staleHint) warnings.push(staleHint);

    const { hits, embedMs, rankMs, mode, semanticWarning } = await searchDatabase(db, input);
    if (semanticWarning) warnings.push(semanticWarning);
    return {
      hits,
      tip: hits.length === 0 ? emptyResultTip(query) : undefined,
      warnings: warnings.length > 0 ? warnings : undefined,
      embedMs,
      rankMs,
      // Report the mode the search ACTUALLY used, carried explicitly from the
      // vector channel — not inferred from elapsed embedding milliseconds.
      mode,
    };
  } finally {
    closeDatabase(db);
  }
}

// ── Database search ─────────────────────────────────────────────────────────

async function searchDatabase(
  db: Database,
  input: SearchLocalInput,
): Promise<{
  hits: SourceSearchHit[];
  embedMs?: number;
  rankMs?: number;
  mode: SearchExecutionMode;
  semanticWarning?: string;
}> {
  const { query, searchType, limit, stashDir, sources, config, filters } = input;
  const filterOptions = {
    db,
    sources,
    restrictToSources: input.restrictToSources === true,
    filters,
    includeProposed: input.includeProposed === true,
    beliefFilter: input.beliefFilter ?? "all",
  };

  // #627 — resolve the default type-exclusion policy. It applies ONLY on the
  // untyped ('any') path and only when the caller did not opt back in via
  // `includeExcludedTypes`. When the config key is ABSENT a built-in default of
  // ['session'] is applied; an explicit empty list disables exclusion.
  const defaultExcludes =
    searchType === "any" && !input.includeExcludedTypes ? (config.search?.defaultExcludeTypes ?? ["session"]) : [];

  // D4 — conceptId-prefix queries (`memories/projecta/`, `bundle//`,
  // `bundle//skills/`) translate to a deterministic enumeration narrowed by
  // conceptId instead of a keyword search over their path words. The branch
  // fires only on the untyped path: an explicit `--type` flag expresses
  // stronger intent and wins. The PREFIX is itself explicit intent, so
  // `defaultExcludeTypes` does not apply — `sessions/` enumerates sessions
  // exactly like `--type session` does, and `bundle//` means the whole bundle.
  const refPrefix = searchType === "any" ? parseRefPrefixQuery(query) : null;
  if (refPrefix) {
    return {
      hits: await enumerateEntries({
        ...filterOptions,
        limit,
        stashDir,
        config,
        excludeTypes: [],
        conceptIdPrefix: refPrefix.conceptIdPrefix,
        ...(refPrefix.bundle !== undefined ? { bundle: refPrefix.bundle } : {}),
      }),
      mode: "keyword",
    };
  }

  // Empty queries — including ones with no searchable token such as "." —
  // enumerate matching entries instead of returning nothing.
  if (ftsQueryTokens(query).length === 0) {
    return {
      hits: await enumerateEntries({
        ...filterOptions,
        limit,
        stashDir,
        config,
        typeFilter: searchType === "any" ? undefined : searchType,
        excludeTypes: defaultExcludes,
      }),
      mode: "keyword",
    };
  }

  const typeFilter = searchType === "any" ? undefined : searchType;
  const startedAt = Date.now();
  // The query embedding request goes out first, so FTS runs while it is in flight.
  const vectorChannel = startVectorChannel(db, query, config);
  const lexical = searchFts(db, query, CHANNEL_DEPTH, typeFilter, defaultExcludes);
  const vector = await vectorChannel;
  const embedMs = Date.now() - startedAt;

  const tRank0 = Date.now();
  const vectorCandidates = vector.neighbors ? keepAllowedTypes(db, vector.neighbors, typeFilter, defaultExcludes) : [];
  const fused = reciprocalRankFusion([lexical, vectorCandidates]);
  const selected = selectFusedEntries(db, fused, limit, filterOptions);
  const rankMs = Date.now() - tRank0;

  const hits = await Promise.all(
    selected.map(({ candidate, row }) =>
      buildDbHit({
        entry: row.entry,
        path: row.filePath,
        itemRef: row.itemRef,
        bundleId: row.bundleId,
        conceptId: row.conceptId,
        score: Math.round(candidate.score * 1e6) / 1e6,
        whyMatched: describeRanks(candidate),
        defaultStashDir: stashDir,
        sources,
        config,
        db,
      }),
    ),
  );

  const mode: SearchExecutionMode = vector.warning ? "fts-fallback" : vector.neighbors ? "semantic" : "keyword";
  return { embedMs, rankMs, hits, mode, semanticWarning: vector.warning };
}

type HydratedEntry = NonNullable<ReturnType<typeof getEntryById>> & { id: number };

/**
 * Walk the fused list in order, loading entries a batch at a time, and keep
 * the first `limit` that survive path deduplication and the filters.
 */
function selectFusedEntries(
  db: Database,
  fused: FusedCandidate[],
  limit: number,
  filterOptions: EntryFilterOptions,
): Array<{ candidate: FusedCandidate; row: HydratedEntry }> {
  const selected: Array<{ candidate: FusedCandidate; row: HydratedEntry }> = [];
  const seenPaths = new Set<string>();
  const batchSize = Math.max(limit * 2, 20);
  for (let offset = 0; offset < fused.length && selected.length < limit; offset += batchSize) {
    const batch: Array<HydratedEntry & { candidate: FusedCandidate }> = [];
    for (const candidate of fused.slice(offset, offset + batchSize)) {
      const row = getEntryById(db, candidate.id);
      if (!row || !hasIndexedProvenance(row) || seenPaths.has(row.filePath)) continue;
      seenPaths.add(row.filePath);
      batch.push({ ...row, id: candidate.id, candidate });
    }
    for (const kept of applyEntryFilters(batch, filterOptions)) {
      const { candidate, ...row } = kept;
      selected.push({ candidate, row });
    }
  }
  return selected.slice(0, limit);
}

/** Vector candidates of the requested type, nearest first; equal distances are ordered by ref. */
function keepAllowedTypes(
  db: Database,
  neighbors: readonly DbVecResult[],
  typeFilter: string | undefined,
  excludeTypes: readonly string[],
): RankedRef[] {
  const rows = getEntryRefsAndTypes(
    db,
    neighbors.map((neighbor) => neighbor.id),
  );
  const excluded = new Set(excludeTypes);
  return neighbors
    .flatMap(({ id, distance }) => {
      const row = rows.get(id);
      if (!row) return [];
      if (typeFilter ? row.type !== typeFilter : excluded.has(row.type)) return [];
      return [{ id, itemRef: row.itemRef, distance }];
    })
    .sort((a, b) => a.distance - b.distance || compareCodePoints(a.itemRef, b.itemRef))
    .map(({ id, itemRef }) => ({ id, itemRef }));
}

/** `whyMatched` for a fused hit: its rank in each channel that returned it. */
function describeRanks(candidate: FusedCandidate): string[] {
  const [lexicalRank, vectorRank] = candidate.ranks;
  return [
    ...(lexicalRank !== undefined ? [`lexical rank ${lexicalRank}`] : []),
    ...(vectorRank !== undefined ? [`vector rank ${vectorRank}`] : []),
  ];
}

/**
 * The no-hits tip. A query in the retired `<type>:` / `<type>:<prefix>/` browse
 * grammar gets the conceptId spelling that replaces it: without this it comes
 * back empty and silent, which is the failure D4 removed the grammar to avoid.
 */
function emptyResultTip(query: string): string {
  const generic = "No matching stash assets were found. Try a different query or run 'akm index' to rebuild.";
  const retired = parseRetiredTypePrefixQuery(query);
  if (!retired) return generic;
  const root = stashDirFor(retired.type);
  if (!root) return generic;
  return `No matching stash assets were found. The '<type>:' browse grammar was removed in 0.9.0 — use the conceptId spelling: 'akm search "${root}/${retired.rest}"'.`;
}

// ── Enumeration (browse) path ────────────────────────────────────────────────

/**
 * Enumerate index entries without FTS scoring — the browse path shared by
 * empty/unsearchable queries and D4 conceptId-prefix queries (`memories/`,
 * `bundle//`, `bundle//skills/`). Applies the same filters as the scored
 * path (source narrowing, scope, proposed-quality, belief) before the limit
 * slice. Hits carry the fixed browse score 1 in type-then-name order — this is
 * a deterministic listing, not a relevance ranking.
 */
async function enumerateEntries(
  opts: EntryFilterOptions & {
    /** Restrict enumeration to a single asset type; undefined enumerates all. */
    typeFilter?: string;
    /** Types hidden from untyped enumeration (config `defaultExcludeTypes`). */
    excludeTypes: string[];
    /**
     * D4 conceptId-prefix narrowing (e.g. `"memories/projecta/"`, trailing slash
     * retained for exact `/`-boundary subtree semantics). Compared
     * case-insensitively: on-disk directory names — and therefore conceptIds —
     * may carry mixed case. Empty/undefined keeps every entry.
     */
    conceptIdPrefix?: string;
    /**
     * D4 bundle narrowing (the `bundle//` half). Undefined spans every bundle;
     * an unknown slug matches nothing rather than widening.
     */
    bundle?: string;
    limit: number;
    stashDir: string;
    config: AkmConfig;
  },
): Promise<SourceSearchHit[]> {
  const { db, sources, config } = opts;
  const allEntries = getAllEntries(db, opts.typeFilter, opts.excludeTypes).filter(hasIndexedProvenance);
  // Explicit listing order: type, then name, then filePath. The underlying
  // SELECT carries no ORDER BY, so its row order tracks the query plan and the
  // index-insertion (file-walk) order — both machine-dependent. A browse
  // listing must not change order across hosts or SQLite versions.
  allEntries.sort(
    (a, b) =>
      a.entry.type.localeCompare(b.entry.type) ||
      a.entry.name.localeCompare(b.entry.name) ||
      a.filePath.localeCompare(b.filePath),
  );
  // D4: narrow to the requested bundle and subtree. Matching is against the
  // conceptId — the spelling every emitted `ref` carries — so a ref copied out
  // of search output round-trips back in. `startsWith` on the full
  // slash-retaining prefix is exact: "memories/projecta/" cannot match a
  // sibling "memories/projectalpha/…" scope.
  const bundle = opts.bundle?.toLowerCase();
  const bundleFiltered =
    bundle === undefined ? allEntries : allEntries.filter((ie) => ie.bundleId.toLowerCase() === bundle);
  const conceptIdPrefix = opts.conceptIdPrefix?.toLowerCase() ?? "";
  const prefixFiltered =
    conceptIdPrefix.length > 0
      ? bundleFiltered.filter((ie) => ie.conceptId.toLowerCase().startsWith(conceptIdPrefix))
      : bundleFiltered;
  // Deduplicate by file path — multiple entries can share the same file.
  // Filtering happens BEFORE the limit slice so a restrictive filter still
  // returns up to `limit` results.
  const selected = applyEntryFilters(deduplicateByPath(prefixFiltered), opts).slice(0, opts.limit);
  return Promise.all(
    selected.map((ie) =>
      buildDbHit({
        entry: ie.entry,
        path: ie.filePath,
        itemRef: ie.itemRef,
        bundleId: ie.bundleId,
        conceptId: ie.conceptId,
        score: 1,
        defaultStashDir: opts.stashDir,
        sources,
        config,
        db,
      }),
    ),
  );
}

interface EntryFilterOptions {
  db: Database;
  sources: SearchSource[];
  restrictToSources: boolean;
  filters?: StashEntryScope;
  includeProposed: boolean;
  beliefFilter: BeliefFilterMode;
}

/**
 * Filter chain shared by the scored and browse paths, in this order:
 * source-narrowing → scope → proposed-quality → derived-twin belief
 * inheritance → belief filter.
 */
function applyEntryFilters<T extends { id: number; entry: IndexDocument; filePath: string }>(
  items: T[],
  opts: EntryFilterOptions,
): T[] {
  const { filters } = opts;
  // Source filter: when the caller narrowed `sources` via `--from <name>`,
  // drop entries whose filePath does not live under any requested source. The
  // index spans every configured source, so without this filter a narrowed
  // --from request would still leak results from other sources.
  const sourceFiltered = opts.restrictToSources
    ? items.filter((item) => findSourceForPath(item.filePath, opts.sources) !== undefined)
    : items;
  // Scope filter: drop entries whose stored scope does not satisfy every
  // supplied key.
  const scopeFiltered = filters
    ? sourceFiltered.filter((item) => entryMatchesScope(item.entry.scope, filters))
    : sourceFiltered;
  // Proposed-quality filter (v1 spec §4.2): exclude `quality: "proposed"`
  // entries unless the caller opts in.
  const qualityFiltered = opts.includeProposed
    ? scopeFiltered
    : scopeFiltered.filter((item) => !isProposedQuality(item.entry.quality));
  // 03-R3: derived twins inherit their base's demoting belief state BEFORE the
  // belief filter, so the filter (and the reported hit state) stays consistent
  // across both paths.
  inheritDerivedTwinBeliefStates(opts.db, qualityFiltered);
  return qualityFiltered.filter((item) => matchBeliefFilter(item.entry.beliefState, opts.beliefFilter));
}

/**
 * 03-R3: let each `.derived` twin inherit its base memory's demoting belief
 * state, so `--belief` treats a stale flag-free twin like its corrected base.
 * The base carries the flag; its near-duplicate `.derived` twin carries none.
 * Done in-memory at search time — NOT by writing the twin's frontmatter —
 * because the SCC belief resolver refreshes any non-frozen state written to a
 * derived memory back to `active` on the next improve run, erasing it. Only
 * twins with no state of their own inherit; an explicit twin state always wins.
 */
function inheritDerivedTwinBeliefStates(db: Database, items: Array<{ id: number; entry: IndexDocument }>): void {
  const DEMOTING = new Set(["contradicted", "superseded", "deprecated", "archived"]);
  const twins = items.filter(
    (it) =>
      it.entry.type === "memory" &&
      it.entry.beliefState === undefined &&
      it.entry.name.toLowerCase().endsWith(".derived"),
  );
  if (twins.length === 0) return;
  const baseBeliefByTwinId = getBaseBeliefStatesForDerivedTwins(
    db,
    twins.map((t) => t.id),
  );
  for (const t of twins) {
    const baseBelief = baseBeliefByTwinId.get(t.id);
    // Only inherit DEMOTIONS — never let a base's active/asserted state lift a twin.
    if (baseBelief && DEMOTING.has(baseBelief)) {
      t.entry.beliefState = baseBelief as IndexDocument["beliefState"];
    }
  }
}

function matchBeliefFilter(beliefState: string | undefined, filter: BeliefFilterMode): boolean {
  if (filter === "all") return true;
  // 03: the belief filter applies to ANY flagged entry, not just memories, so
  // `current`/`historical` filters catch contradicted/superseded KNOWLEDGE too.
  // Unflagged entries (beliefState === undefined) still pass the `current` filter.
  if (filter === "current") {
    // Phase 1A: `asserted` is a "current" state (stronger authority than `active`);
    // `deprecated` is excluded from current results.
    return beliefState === undefined || beliefState === "active" || beliefState === "asserted";
  }
  // historical
  return (
    beliefState === "contradicted" ||
    beliefState === "superseded" ||
    beliefState === "deprecated" ||
    beliefState === "archived"
  );
}

// ── Vector channel ──────────────────────────────────────────────────────────

/**
 * Embed the query and return its nearest document ids, best first. The
 * embedding request is dispatched before this returns, so the caller's FTS
 * query overlaps it. A slow or failing embedder degrades the search to keyword
 * ranking with a warning after `embedding.queryTimeoutMs`.
 */
function startVectorChannel(
  db: Database,
  query: string,
  config: AkmConfig,
): Promise<{ neighbors: DbVecResult[] | null; warning?: string }> {
  if (config.semanticSearchMode === "off") return Promise.resolve({ neighbors: null });
  // A real-time completeness fact, not a cached verdict: skip the round trip
  // only when the index has never embedded anything. A PARTIAL failure still
  // attempts — and if the endpoint is genuinely down, the failure surfaces as
  // a live warning instead of silently skipping with no signal.
  if (getEmbeddingCount(db) === 0) return Promise.resolve({ neighbors: null });

  const timeoutMs = config.embedding?.queryTimeoutMs ?? DEFAULT_QUERY_EMBED_TIMEOUT_MS;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`Query embedding timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  const queryText = applyEmbeddingTemplate(resolveEmbeddingProfile(config.embedding).queryTemplate, query);
  return Promise.race([embed(queryText, config.embedding, controller.signal), timeout])
    .then((vector) => ({ neighbors: searchVec(db, vector, CHANNEL_DEPTH) }))
    .catch((error: unknown) => ({ neighbors: null, warning: buildVectorFallbackWarning(config, error) }))
    .finally(() => clearTimeout(timer));
}

function buildVectorFallbackWarning(config: AkmConfig, error: unknown): string {
  const endpoint = safeEmbeddingEndpoint(config);
  const reason = classifyVectorFailure(error);
  const target = endpoint
    ? `embedding endpoint ${endpoint}`
    : config.embedding?.endpoint
      ? "configured embedding endpoint"
      : "local embedding model";
  const unavailable = reason === "connection failed" ? `cannot reach ${target}` : `${target} is unavailable`;
  return `Vector search unavailable: ${unavailable} (${reason}) — falling back to keyword search.`;
}

/**
 * Name the useful endpoint without ever carrying URL userinfo, query secrets,
 * or fragments into a warning. Invalid authored values fail closed.
 */
function safeEmbeddingEndpoint(config: AkmConfig): string | undefined {
  const endpoint = config.embedding?.endpoint;
  if (!endpoint) return undefined;
  try {
    const parsed = new URL(normalizeEmbeddingEndpoint(endpoint));
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return undefined;
  }
}

/** Map untrusted runtime failures onto a small, non-secret diagnostic set. */
function classifyVectorFailure(error: unknown): string {
  const code = systemErrorCode(error);
  const message = error instanceof Error ? error.message : "";
  if (
    code === "ECONNREFUSED" ||
    code === "ECONNRESET" ||
    code === "ENETUNREACH" ||
    code === "EHOSTUNREACH" ||
    code === "ENOTFOUND" ||
    code === "EAI_AGAIN" ||
    /typo in the url or port|connection (?:refused|failed|reset)|fetch failed/i.test(message)
  ) {
    return "connection failed";
  }
  if (code === "ETIMEDOUT" || /timed? out|timeout/i.test(message)) return "request timed out";
  const httpStatus = message.match(/Embedding (?:batch )?request failed \((\d{3})\)/i)?.[1];
  if (httpStatus) return `HTTP ${httpStatus}`;
  if (/unexpected embedding response|missing data\[0\]\.embedding/i.test(message)) return "invalid embedding response";
  return "request failed";
}

// ── Hit building ────────────────────────────────────────────────────────────

export async function buildDbHit(input: {
  entry: IndexDocument;
  path: string;
  itemRef: string;
  bundleId: string;
  conceptId: string;
  score: number;
  whyMatched?: string[];
  defaultStashDir: string;
  sources: SearchSource[];
  config?: AkmConfig;
  /**
   * Phase 5A / Advantage D5: open DB connection threaded into the search-hit
   * enricher pipeline so the derived-memory enricher can resolve parent→child
   * via the `entries.derived_from` index. Absent for call sites that build
   * hits without a DB — the enricher then skips that step.
   */
  db?: Database;
}): Promise<SourceSearchHit> {
  const absolutePath = path.resolve(input.path);
  const source = findSourceForPath(absolutePath, input.sources);
  const entryStashDir = source?.path ?? input.defaultStashDir;

  const defaultBundleId =
    input.config?.defaultBundle ??
    (source && path.resolve(source.path) === path.resolve(input.defaultStashDir)
      ? (input.bundleId ?? undefined)
      : undefined);
  const ref = resolveSearchHitRef(input.entry, input, defaultBundleId);
  const editable = isEditable(absolutePath, input.config, input.sources);
  const estimatedTokens = typeof input.entry.fileSize === "number" ? Math.round(input.entry.fileSize / 4) : undefined;

  const hit: SourceSearchHit = {
    type: input.entry.type,
    name: input.entry.name,
    path: absolutePath,
    ref,
    origin: source?.registryId ?? null,
    editable,
    ...(!editable ? { editHint: buildEditHint(ref) } : {}),
    description: input.entry.description,
    tags: input.entry.tags,
    size: deriveSize(input.entry.fileSize),
    action: buildLocalAction(input.entry.type, ref),
    score: input.score,
    ...(input.whyMatched ? { whyMatched: input.whyMatched } : {}),
    ...(estimatedTokens !== undefined ? { estimatedTokens } : {}),
    // Surface optional quality (v1 spec §4.2). Omitted when entry has
    // no `quality` field so payloads stay compact for the common case.
    ...(input.entry.quality ? { quality: input.entry.quality } : {}),
    ...(input.entry.beliefState ? { beliefState: input.entry.beliefState } : {}),
    ...(input.entry.currentBeliefRefs ? { currentBeliefRefs: input.entry.currentBeliefRefs } : {}),
  };

  if (input.entry.content) hitContent.set(hit, input.entry.content);
  if (input.entry.derivedFrom) {
    attachSearchHitAttribution(hit, {
      memoryInference: { exposure: "direct" },
    });
  }
  await enrichSearchHit(hit, {
    type: input.entry.type,
    stashDir: entryStashDir,
    bundleId: input.bundleId,
    db: input.db,
  });

  return hit;
}

// ── Utilities ────────────────────────────────────────────────────────────────

export function deriveSize(bytes?: number): SearchHitSize | undefined {
  if (bytes === undefined) return undefined;
  if (bytes < 1024) return "small";
  if (bytes < 10240) return "medium";
  return "large";
}

/** Keep the first entry per file path; the caller owns the order. */
function deduplicateByPath<T extends { filePath: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.filePath)) return false;
    seen.add(item.filePath);
    return true;
  });
}

/**
 * Exact-match scope filter check. Entries without a `scope` object only
 * match when no filter is supplied — which is what the caller guards on
 * before invoking this helper.
 */
function entryMatchesScope(scope: StashEntryScope | undefined, filters: StashEntryScope): boolean {
  for (const key of ["user", "agent", "run", "channel"] as const) {
    const expected = filters[key];
    if (expected === undefined) continue;
    if (!scope || scope[key] !== expected) return false;
  }
  return true;
}
