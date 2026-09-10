// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Database-backed (SQLite + FTS5/vector) source search implementation.
 *
 * Extracted from source-search.ts to break the circular import:
 *   source-search.ts → sources/providers/filesystem.ts → db-search.ts (no cycle)
 *
 * source-search.ts imports this module for the `searchLocal` export.
 * sources/providers/filesystem.ts also imports `searchLocal` from here.
 *
 * Renamed from `local-search.ts` to signal that this is the DB-layer search
 * implementation, not a "local vs. remote" distinction.
 */

import path from "node:path";
import { buildActionFromContributors, defaultActionContributors } from "../../core/action-contributors";
import { stashDirFor } from "../../core/asset/asset-placement";
import { displayRef } from "../../core/asset/resolve-ref";
import { compareCodePoints } from "../../core/common";
import type { AkmConfig, ImproveConfig } from "../../core/config/config";
import { classifyPathAccess } from "../../core/path-access";
import { getDbPath } from "../../core/paths";
import { systemErrorCode } from "../../core/system-error";
import { allowsFragmentRef, defaultRendererRegistry, type RendererRegistry } from "../../core/type-presentation";
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
  getPositiveFeedbackCountsByIds,
} from "../../storage/repositories/index-entries-repository";
import {
  getIndexedMarkdownFragment,
  getIndexedMarkdownFragments,
  type IndexedMarkdownFragment,
  searchFts,
} from "../../storage/repositories/index-fts-repository";
import { getMeta } from "../../storage/repositories/index-meta-repository";
import { getEmbeddingCount, searchVec } from "../../storage/repositories/index-vec-repository";
import { getCurrentWorkflowScopeKey } from "../../workflows/authoring/scope-key";
import { ensureIndex } from "../ensure-index";
import { collectGraphRelatedHit, type GraphBoostContext, loadGraphBoostContext } from "../graph/graph-boost";
import { type IndexDocument, isProposedQuality, type StashEntryScope } from "../passes/metadata";
import { resolveProjectContext } from "../walk/project-context";
import {
  buildLexicalQueryPlan,
  type LexicalQueryExecution,
  parseRefPrefixQuery,
  parseRetiredTypePrefixQuery,
} from "./fts-query";
import { applyRankingRules, combineSearchScores, lexicalNameMatchTier, normalizeFtsScores } from "./ranking";
import { typeBoostFor } from "./ranking-contributors";
import type { RankedEntryInput } from "./ranking-types";
import { attachSearchHitAttribution, copySearchHitAttribution, getSearchHitAttribution } from "./search-attribution";
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

type IndexedProvenance = { itemRef: string; bundleId: string; conceptId: string };

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

function indexedProvenance(
  entry: RankedEntryInput & IndexedProvenance,
): Pick<IndexedProvenance, "itemRef" | "bundleId" | "conceptId"> {
  return { itemRef: entry.itemRef, bundleId: entry.bundleId, conceptId: entry.conceptId };
}

export function buildLocalAction(
  type: string,
  ref: string,
  registry: RendererRegistry = defaultRendererRegistry,
): string {
  return buildActionFromContributors({ type, ref }, defaultActionContributors(registry)) ?? `akm show ${ref}`;
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

function resolveSearchHitOrigin(source?: SearchSource): string | null {
  return source?.registryId ?? null;
}

/**
 * Phase 2A / Rec 5: gate for the per-search `getPositiveFeedbackCountsByIds`
 * lookup. Returns `true` only when the user has explicitly opted into
 * `improve.utilityDecay` AND configured a `feedbackStabilityBoost > 1.0`.
 * Either condition being false makes the DB query pure overhead (the ranking
 * contributor ignores `positiveFeedbackCounts` when `utilityDecayConfig` is
 * absent, and `1.0^count == 1` collapses the boost into a no-op).
 *
 * Exported for unit testing — keeps the gate decision pinned so a future edit
 * can't quietly broaden the hot path.
 */
export function shouldQueryPositiveFeedbackCounts(utilityDecayRaw: ImproveConfig["utilityDecay"]): boolean {
  if (utilityDecayRaw === undefined) return false;
  const boost = utilityDecayRaw.feedbackStabilityBoost ?? 1.5;
  return boost > 1.0;
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

export async function searchLocal(input: {
  query: string;
  searchType: AkmSearchType;
  limit: number;
  stashDir: string;
  sources: SearchSource[];
  config: AkmConfig;
  /** Optional renderer registry override for test isolation. */
  rendererRegistry?: RendererRegistry;
  /**
   * Optional scope filter (`user`, `agent`, `run`, `channel`). When present,
   * hits whose `entry.scope` does not satisfy every supplied key are dropped
   * AFTER ranking — filtering narrows the result set, it does not alter the
   * single FTS5+boosts scoring pipeline.
   */
  filters?: StashEntryScope;
  /**
   * When true, entries with `quality === "proposed"` are kept in the result
   * set. By default (false) they are filtered out post-ranking per v1
   * spec §4.2. Filtering happens AFTER scoring — there is still one
   * scoring pipeline.
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
  /** Disable project-context ranking for this invocation only. */
  disableProjectContext?: boolean;
  /** Disable scoped-utility ranking for this invocation only. */
  disableScopedUtility?: boolean;
}): Promise<{
  hits: SourceSearchHit[];
  tip?: string;
  warnings?: string[];
  embedMs?: number;
  rankMs?: number;
  /** Actual ranking mode, including a failed semantic attempt. */
  mode: SearchExecutionMode;
}> {
  const { query, searchType, limit, stashDir, sources, config } = input;
  const filters = input.filters;
  const includeProposed = input.includeProposed === true;
  const beliefFilter = input.beliefFilter ?? "all";
  const restrictToSources = input.restrictToSources === true;
  const includeExcludedTypes = input.includeExcludedTypes === true;
  const disableProjectContext = input.disableProjectContext === true;
  const disableScopedUtility = input.disableScopedUtility === true;
  const rendererRegistry = input.rendererRegistry ?? defaultRendererRegistry;
  const allSourceDirs = sources.map((s) => s.path);
  const warnings: string[] = [];
  // Semantic search is attempted fresh on every query (see `tryVecScores`);
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

    const { hits, embedMs, rankMs, mode, semanticWarning } = await searchDatabase(
      db,
      query,
      searchType,
      limit,
      stashDir,
      allSourceDirs,
      config,
      sources,
      rendererRegistry,
      filters,
      includeProposed,
      beliefFilter,
      restrictToSources,
      includeExcludedTypes,
      disableProjectContext,
      disableScopedUtility,
    );
    if (semanticWarning) warnings.push(semanticWarning);
    return {
      hits,
      tip: hits.length === 0 ? emptyResultTip(query) : undefined,
      warnings: warnings.length > 0 ? warnings : undefined,
      embedMs,
      rankMs,
      // Report the mode the search ACTUALLY used, carried explicitly from the
      // vector scorer — not inferred from elapsed embedding milliseconds.
      mode,
    };
  } finally {
    closeDatabase(db);
  }
}

// ── Database search ─────────────────────────────────────────────────────────

/**
 * Keep public scores in [0, 1] without flattening every boosted result to the
 * same hard-clamped value. The ranking pipeline deliberately keeps its raw
 * score for deterministic ordering before stable path deduplication; this
 * monotone display projection preserves that order and leaves visible
 * separation for graph, type, and project-context signals.
 */
function displaySearchScore(score: number): number {
  return 1 - Math.exp(-Math.max(0, score));
}

/**
 * A final deterministic key for genuinely tied candidates.  It deliberately
 * excludes the asset name, filename, path, durable ref, and SQLite id: callers
 * such as the memory-pack adapter generate each of those from an opaque source
 * id, so using one here makes an otherwise equal search depend on that id.
 *
 * The normal AKM Markdown adapter keeps an H1 title in `content`; strip that
 * one synthetic title too, because the adapter may derive it from the opaque
 * filename.  Identical remaining bodies are semantically indistinguishable at
 * this ranking stage and intentionally continue to the existing name/path
 * fallback for repeatable local presentation.
 */
function asciiCaseFold(value: string): string {
  // SQLite's built-in lower() folds ASCII only unless a build opts into ICU.
  // Keep this key deliberately in that portable shared subset instead of
  // introducing locale-dependent JavaScript ordering for non-ASCII content.
  return value.replace(/[A-Z]/g, (letter) => String.fromCharCode(letter.charCodeAt(0) + 32));
}

/** The portable byte-level title/body rule mirrored in index-fts-repository. */
export function canonicalContentTieKey(entry: Pick<IndexDocument, "content" | "description">): string {
  const content = entry.content ?? "";
  const newline = content.startsWith("# ") ? content.indexOf("\n") : -1;
  // SQLite uses ltrim(value, char(13) || char(10) || ' ') after an exact '# '
  // title and trim(value, ' ') otherwise. Keep exactly that deliberately
  // narrow byte contract; do not use locale or Unicode-whitespace helpers.
  const body = newline >= 0 ? content.slice(newline + 1).replace(/^[\r\n ]+/, "") : content;
  const source = (body || entry.description || "").replace(/^ +| +$/g, "");
  return Buffer.from(asciiCaseFold(source), "utf8").toString("hex");
}

function buildSearchResultComparator(query: string): (a: RankedEntryInput, b: RankedEntryInput) => number {
  const queryTokens = buildLexicalQueryPlan(query).tokens.map((token) => token.toLowerCase());
  const displayScore = (score: number): number => Math.round(displaySearchScore(score) * 10000) / 10000;
  const stableRankScore = (score: number): number => Math.round(score * 10000) / 10000;

  return (a, b) => {
    const aNameTier = lexicalNameMatchTier(a.entry, queryTokens);
    const bNameTier = lexicalNameMatchTier(b.entry, queryTokens);
    if (aNameTier === 3 || bNameTier === 3) {
      const nameDiff = bNameTier - aNameTier;
      if (nameDiff !== 0) return nameDiff;
    }
    const scoreDiff = displayScore(b.score) - displayScore(a.score);
    if (scoreDiff !== 0) return scoreDiff;
    const rawScoreDiff = stableRankScore(b.score) - stableRankScore(a.score);
    if (rawScoreDiff !== 0) return rawScoreDiff;
    // Ceiling values are intentionally allowed to demote visibility, but not
    // to erase relevance. Prefer the score before a relaxed body-only ceiling;
    // a later belief-state ceiling has its own minScore handoff and must not
    // overwrite this ordering evidence. Belief-only ceilings fall back to
    // their `preCeilingScore`.
    const preCeilingRelevance = (item: RankedEntryInput): number =>
      item.preRelaxedCeilingScore ?? item.preCeilingScore ?? item.score;
    const ceilingDiff = stableRankScore(preCeilingRelevance(b)) - stableRankScore(preCeilingRelevance(a));
    if (ceilingDiff !== 0) return ceilingDiff;
    const nameDiff = bNameTier - aNameTier;
    if (nameDiff !== 0) return nameDiff;
    const typeDiff = typeBoostFor(b.entry.type) - typeBoostFor(a.entry.type);
    if (typeDiff !== 0) return typeDiff;
    // Keep opaque generated IDs out of the final relevance tie-break.  This
    // runs only after every ranking contributor (including the #940 preserved
    // pre-ceiling evidence), exact-name, and type comparison has tied.
    const contentDiff = compareCodePoints(canonicalContentTieKey(a.entry), canonicalContentTieKey(b.entry));
    if (contentDiff !== 0) return contentDiff;
    return a.filePath.localeCompare(b.filePath);
  };
}

async function searchDatabase(
  db: Database,
  query: string,
  searchType: AkmSearchType,
  limit: number,
  stashDir: string,
  allSourceDirs: string[],
  config: AkmConfig,
  sources: SearchSource[],
  rendererRegistry: RendererRegistry = defaultRendererRegistry,
  filters?: StashEntryScope,
  includeProposed = false,
  beliefFilter: BeliefFilterMode = "all",
  restrictToSources = false,
  includeExcludedTypes = false,
  disableProjectContext = false,
  disableScopedUtility = false,
): Promise<{
  hits: SourceSearchHit[];
  embedMs?: number;
  rankMs?: number;
  mode: SearchExecutionMode;
  semanticWarning?: string;
}> {
  const hasSearchableTokens = query.length > 0 && buildLexicalQueryPlan(query).tokens.length > 0;

  // #627 — resolve the default type-exclusion policy. It applies ONLY on the
  // untyped ('any') path and only when the caller did not opt back in via
  // `includeExcludedTypes`. When the config key is ABSENT a built-in default of
  // ['session'] is applied; an explicit empty list disables exclusion.
  const defaultExcludes =
    searchType === "any" && !includeExcludedTypes ? (config.search?.defaultExcludeTypes ?? ["session"]) : [];

  // D4 — conceptId-prefix queries (`memories/projecta/`, `bundle//`,
  // `bundle//skills/`) translate to a deterministic enumeration narrowed by
  // conceptId, instead of degenerating into the AND-token FTS query their
  // sanitized form would produce ("memories projecta" — noise). The branch
  // fires only on the untyped path: an explicit `--type` flag expresses
  // stronger intent and wins. The PREFIX is itself explicit intent, so
  // `defaultExcludeTypes` does not apply — `sessions/` enumerates sessions
  // exactly like `--type session` does, and `bundle//` means the whole bundle.
  const refPrefix = searchType === "any" ? parseRefPrefixQuery(query) : null;
  // Shared args for the two browse paths below; browse never runs semantic
  // ranking, so both return usedSemantic: false.
  const browseArgs = {
    db,
    query,
    limit,
    stashDir,
    allSourceDirs,
    sources,
    config,
    rendererRegistry,
    filters,
    includeProposed,
    beliefFilter,
    restrictToSources,
  };
  if (refPrefix) {
    // Browse path (conceptId-prefix enumeration).
    return {
      ...(await enumerateEntries({
        ...browseArgs,
        excludeTypes: [],
        conceptIdPrefix: refPrefix.conceptIdPrefix,
        ...(refPrefix.bundle !== undefined ? { bundle: refPrefix.bundle } : {}),
      })),
      mode: "keyword",
    };
  }

  // Empty queries — including ones that sanitize down to no searchable FTS
  // tokens such as "." — should enumerate matching entries instead of
  // returning an empty result set from FTS.
  if (!hasSearchableTokens) {
    // Browse path (empty/unsearchable query).
    return {
      ...(await enumerateEntries({
        ...browseArgs,
        typeFilter: searchType === "any" ? undefined : searchType,
        excludeTypes: defaultExcludes,
      })),
      mode: "keyword",
    };
  }

  // Start the async embedding request without awaiting, then run FTS
  // synchronously while the HTTP/local embedding request is in-flight.
  const typeFilter = searchType === "any" ? undefined : searchType;
  const { ftsResults, embeddingScores, embedMs, mode, semanticWarning } = await collectSearchSignals(
    db,
    query,
    limit * 3,
    typeFilter,
    defaultExcludes,
    config,
  );

  const tRank0 = Date.now();

  // ── Score normalization ──────────────────────────────────────────────
  // Stable bounded BM25 transform + cosine similarity with weighted addition
  // (FTS 0.7, vector 0.3). The lexical transform is per-row, so widening the
  // candidate set cannot alter a pre-existing row's base score.
  const ftsScoreMap = normalizeFtsScores(ftsResults);

  // Build embedding score map (cosine similarities already 0-1)
  const embedScoreMap = new Map<number, number>();
  if (embeddingScores) {
    for (const [id, cosine] of embeddingScores) {
      embedScoreMap.set(id, cosine);
    }
  }

  // ── Combine FTS + vector scores ──────────────────────────────────────
  const scored = combineSearchScores({
    ftsScoreMap,
    embedScoreMap,
    getEntryById: (id) => getEntryById(db, id) ?? undefined,
    typeFilter,
    // #627 — also exclude default-hidden types from the vector-only branch so a
    // session asset that is a top-k vector neighbor (but not an FTS match) does
    // not leak into default ('any') results. defaultExcludes is already []
    // unless this is the untyped path without includeExcludedTypes.
    excludeTypes: defaultExcludes,
  }).filter(hasIndexedProvenance);

  // ── Scoring Phase ──────────────────────────────────────────────────────
  // Apply boosts as multiplicative factors (all boosts in a single phase
  // so that sort order and displayed scores are always consistent).
  // Ranking philosophy: the goal is to surface the MOST USEFUL result for the
  // user's intent. An exact name match is the strongest signal. Actionable
  // asset types (skills, commands, agents) are more useful than passive
  // reference docs. Curated metadata is more reliable than auto-generated.
  // Graph boost context (#207). Built once per query and reused across
  // every scored entry so the disk read + JSON parse only happens once
  // per search invocation. `null` when no graph file is present, when
  // the schema doesn't match, or when no query token matches a graph
  // entity — in all of those cases the per-entry call is skipped and
  // graph contributes nothing. The graph signal feeds this single
  // FTS5+boosts loop as ONE additive component (CLAUDE.md / spec §6:
  // one scoring pipeline, no parallel SearchHit scorer).
  const graphContext: GraphBoostContext | null = (() => {
    // Search across all source dirs; the graph file lives next to the
    // primary source root. Cache misses are silent — the helper handles
    // missing files internally and returns `null` instead of throwing.
    if (allSourceDirs.length === 0) return null;
    return loadGraphBoostContext(allSourceDirs, query, config, db);
  })();

  // Resolve project-context tokens from the current working directory once
  // per search invocation. Returns null when running from home dir / /tmp,
  // or when the caller passed `--no-project-context` (disableProjectContext).
  const projectContext = disableProjectContext ? null : resolveProjectContext(process.cwd());

  // Phase 2A / Rec 5: resolve forgetting-curve config and skip the feedback
  // count query when the boost cannot make a difference (default ≤ 1.0 means
  // boost^count == 1 — zero overhead for the common case).
  const utilityDecayRaw = config.improve?.utilityDecay;
  const halfLifeDays = utilityDecayRaw?.halfLifeDays ?? 30;
  const feedbackStabilityBoost = utilityDecayRaw?.feedbackStabilityBoost ?? 1.5;
  const utilityDecayConfig = utilityDecayRaw !== undefined ? { halfLifeDays, feedbackStabilityBoost } : undefined;
  // Gate the feedback-count query on the user having explicitly opted into
  // utilityDecay. Without an opt-in, `utilityDecayConfig` is undefined and the
  // ranking contributor ignores `positiveFeedbackCounts` — so running the DB
  // query here would be pure overhead. The boost > 1.0 sub-gate then skips the
  // query when the configured boost is a no-op (1.5^count when boost==1 is 1).
  const positiveFeedbackCounts = shouldQueryPositiveFeedbackCounts(utilityDecayRaw)
    ? getPositiveFeedbackCountsByIds(scored.map((item) => item.id))
    : undefined;

  // Resolve per-project scope key for scoped utility scoring.
  // `disableScopedUtility` (wired from `akm search --no-project-context`)
  // opts out (e.g. for registry searches or tests).
  let scopeKey: string | undefined;
  try {
    scopeKey = disableScopedUtility ? undefined : getCurrentWorkflowScopeKey();
  } catch {
    // Non-fatal — ranking proceeds without scoped utility on any error.
  }

  // 03-R3: derived twins inherit their base's demoting belief state before
  // ranking, so the (03) belief-state ranker demotes a stale flag-free twin.
  inheritDerivedTwinBeliefStates(db, scored);

  applyRankingRules({
    db,
    query,
    items: scored,
    graphContext,
    projectContext,
    utilityDecayConfig,
    positiveFeedbackCounts,
    scopeKey,
  });

  // ── minScore floor ──────────────────────────────────────────────────────
  // Drop semantic-only hits (cosine-only, no FTS match) whose score falls
  // below the configured floor. FTS hits and hybrid hits are always kept.
  // Default floor: 0.2. Set search.minScore = 0 in config to disable.
  // Judged on the PRE-ceiling score when a demoting belief state clamped the
  // item (`preCeilingScore`): the belief ceilings can sit below this floor
  // (archived 0.15 < 0.2), and a demotion must rank the hit last, not
  // silently remove a result that would otherwise have listed.
  const minScore = config.search?.minScore ?? 0.2;
  const preFilter =
    minScore > 0
      ? scored.filter((item) => item.rankingMode !== "semantic" || (item.preCeilingScore ?? item.score) >= minScore)
      : scored;

  preFilter.sort(buildSearchResultComparator(query));

  // Deduplicate by file path — keep only the highest-scored entry per file.
  const deduped = deduplicateByPath(preFilter);

  // Source → scope → proposed-quality → derived-twin belief inheritance →
  // belief: the post-candidate filter chain shared with enumerateEntries (see
  // applyEntryFilters). Applied AFTER ranking so filtering narrows the result
  // set without touching the single FTS5+boosts scoring pipeline. The twin
  // inheritance inside the chain re-runs here as an idempotent no-op — it
  // already ran on the full candidate pool before ranking (:460) to feed the
  // belief-state ranker.
  const beliefFiltered = applyEntryFilters(deduped, {
    db,
    sources,
    restrictToSources,
    filters,
    includeProposed,
    beliefFilter,
  });

  const rankMs = Date.now() - tRank0;

  const selected = beliefFiltered.slice(0, limit);
  const fragmentSelections = selected.flatMap((ranked) =>
    ranked.fragmentId && allowsFragmentRef(ranked.entry.type) && hasIndexedProvenance(ranked)
      ? [{ entryId: ranked.id, itemRef: ranked.itemRef, fragmentId: ranked.fragmentId }]
      : [],
  );
  const selectedFragments = getIndexedMarkdownFragments(db, fragmentSelections);
  const selectedFragmentByEntryId = new Map<number, IndexedMarkdownFragment | undefined>();
  fragmentSelections.forEach((selection, index) => {
    selectedFragmentByEntryId.set(selection.entryId, selectedFragments[index]);
  });
  const hits = await Promise.all(
    selected.map((ranked) => {
      const { entry, filePath, score, rankingMode, utilityBoosted } = ranked;
      // CLAUDE.md locks SearchHit.score in [0,1]. The boost loop deliberately
      // remains raw for ranking, then takes a monotone bounded projection at
      // the public boundary so contributors do not collapse into hard-clamped
      // ties.
      const finalScore = displaySearchScore(score);
      return buildDbHit({
        entry,
        path: filePath,
        ...indexedProvenance(ranked),
        score: Math.round(finalScore * 10000) / 10000,
        query,
        rankingMode,
        lexicalMatch: ranked.lexicalMatch,
        fragmentId: ranked.fragmentId,
        indexedFragment: ranked.fragmentId ? (selectedFragmentByEntryId.get(ranked.id) ?? null) : undefined,
        defaultStashDir: stashDir,
        allSourceDirs,
        sources,
        config,
        utilityBoosted,
        graphContext,
        attributionSource: ranked,
        rendererRegistry,
        db,
      });
    }),
  );

  return { embedMs, rankMs, hits, mode, semanticWarning };
}

async function collectSearchSignals(
  db: Database,
  query: string,
  candidateLimit: number,
  typeFilter: string | undefined,
  excludeTypes: string[],
  config: AkmConfig,
) {
  const startedAt = Date.now();
  const embeddingPromise = tryVecScores(db, query, candidateLimit, config);
  const ftsResults = searchFts(db, query, candidateLimit, typeFilter, excludeTypes);
  const embeddingResult = await embeddingPromise;
  const mode: SearchExecutionMode = embeddingResult.warning
    ? "fts-fallback"
    : embeddingResult.scores !== null
      ? "semantic"
      : "keyword";
  return {
    ftsResults,
    embeddingScores: embeddingResult.scores,
    embedMs: Date.now() - startedAt,
    mode,
    semanticWarning: embeddingResult.warning,
  };
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
 * `bundle//`, `bundle//skills/`). Applies the same post-ranking filters as the scored
 * path (source narrowing, scope, proposed-quality, belief) before the limit
 * slice. Hits carry the fixed browse score 1 in type-then-name order — this is
 * a deterministic listing, not a relevance ranking.
 */
async function enumerateEntries(opts: {
  db: Database;
  query: string;
  /** Restrict enumeration to a single asset type; undefined enumerates all. */
  typeFilter?: string;
  /** Types hidden from untyped enumeration (config `defaultExcludeTypes`). */
  excludeTypes: string[];
  /**
   * D4 conceptId-prefix narrowing (e.g. `"memories/projecta/"`, trailing slash
   * retained for exact `/`-boundary subtree semantics). Compared
   * case-insensitively: the command layer lowercases queries while on-disk
   * directory names — and therefore conceptIds — may carry mixed case.
   * Empty/undefined keeps every entry.
   */
  conceptIdPrefix?: string;
  /**
   * D4 bundle narrowing (the `bundle//` half). Undefined spans every bundle;
   * an unknown slug matches nothing rather than widening.
   */
  bundle?: string;
  limit: number;
  stashDir: string;
  allSourceDirs: string[];
  sources: SearchSource[];
  config: AkmConfig;
  rendererRegistry: RendererRegistry;
  filters?: StashEntryScope;
  includeProposed: boolean;
  beliefFilter: BeliefFilterMode;
  restrictToSources: boolean;
}): Promise<{ hits: SourceSearchHit[] }> {
  const { db, query, sources, config, rendererRegistry, filters, beliefFilter } = opts;
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
  // Deduplicate by file path — multiple entries can share the same file
  const seenFilePaths = new Set<string>();
  const uniqueEntries = prefixFiltered.filter((ie) => {
    if (seenFilePaths.has(ie.filePath)) return false;
    seenFilePaths.add(ie.filePath);
    return true;
  });
  // Source → scope → proposed-quality → derived-twin belief inheritance →
  // belief: the post-candidate filter chain shared with searchDatabase's
  // scored path (see applyEntryFilters). Filtering happens BEFORE the limit
  // slice so a restrictive filter still returns up to `limit` results. On this
  // path the twin inheritance is the ONLY place it runs (there is no ranking
  // pass), keeping the belief filter and reported hit state consistent with
  // the scored path.
  const beliefFiltered = applyEntryFilters(uniqueEntries, {
    db,
    sources,
    restrictToSources: opts.restrictToSources,
    filters,
    includeProposed: opts.includeProposed,
    beliefFilter,
  });
  const selected = beliefFiltered.slice(0, opts.limit);
  const hits = await Promise.all(
    selected.map((ie) =>
      buildDbHit({
        entry: ie.entry,
        path: ie.filePath,
        itemRef: ie.itemRef,
        bundleId: ie.bundleId,
        conceptId: ie.conceptId,
        score: 1,
        query,
        rankingMode: "fts",
        defaultStashDir: opts.stashDir,
        allSourceDirs: opts.allSourceDirs,
        sources,
        config,
        rendererRegistry,
        db,
      }),
    ),
  );
  return { hits };
}

/**
 * Post-candidate filter chain shared by BOTH search paths — the scored path
 * (`searchDatabase`) and the browse path (`enumerateEntries`). Applies, in this
 * exact order: source-narrowing → scope → proposed-quality → derived-twin
 * belief inheritance → belief filter. Extracting the chain removes the two
 * paths' formerly-duplicated filter sequences so the predicates, their order,
 * and the twin-inheritance placement can never drift apart (plan §4.3).
 *
 * What this does NOT unify — and deliberately leaves divergent — is CANDIDATE-
 * POOL construction, which is inherent search-vs-browse semantics: the scored
 * path's pool is `searchFts`/vector matches for the query's own tokens (FTS
 * includes structured fields and bounded adapter content), while the
 * enumerate path's pool is `getAllEntries` for the type, independent of query
 * text. A derived twin sharing no indexed token with the query is therefore an
 * enumerate-path candidate but never a scored-path candidate. (A golden
 * fixture used to pin that divergence; the golden suites were deleted in
 * 0.9.8, so this comment is now the record of it.)
 *
 * `inheritDerivedTwinBeliefStates` is idempotent, so running it here is safe on
 * the scored path, which must ALSO call it before ranking (the belief-state
 * ranker demotes inherited states): by the time this chain runs, those twins
 * already carry a state and the call here is a no-op for them. The enumerate
 * path never ranks, so this is the only place it inherits.
 */
function applyEntryFilters<T extends { id: number; entry: IndexDocument; filePath: string }>(
  items: T[],
  opts: {
    db: Database;
    sources: SearchSource[];
    restrictToSources: boolean;
    filters?: StashEntryScope;
    includeProposed: boolean;
    beliefFilter: BeliefFilterMode;
  },
): T[] {
  const { filters } = opts;
  // Source filter: when the caller narrowed `sources` via `--from <name>`,
  // drop entries whose filePath does not live under any requested source. The
  // FTS/enumerate index spans every configured source, so without this filter a
  // narrowed --from request would still leak results from other sources.
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
 * state for this ranking pass, so a stale flag-free twin is demoted like its
 * corrected base. The base carries the flag (a contradicted base takes a real
 * ranking penalty); its near-duplicate `.derived` twin carries none and would
 * otherwise outrank the corrected copy. Done in-memory at search time — NOT by
 * writing the twin's frontmatter — because the SCC belief resolver refreshes any
 * non-frozen state written to a derived memory back to `active` on the next
 * improve run, erasing it. Only twins with no state of their own inherit; an
 * explicit twin state always wins. Reuses the (03) belief-state ranker + filter.
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

// ── Vector scorer ───────────────────────────────────────────────────────────

async function tryVecScores(
  db: Database,
  query: string,
  k: number,
  config: AkmConfig,
): Promise<{ scores: Map<number, number> | null; warning?: string }> {
  if (config.semanticSearchMode === "off") return { scores: null };
  // A real-time completeness fact, not a cached verdict: skip the network
  // round trip only when the index has never embedded anything. A PARTIAL
  // failure (some entries embedded, one write degraded) still attempts —
  // and if the endpoint is genuinely down, the failure surfaces as a live
  // `semanticWarning` below instead of silently skipping with no signal.
  if (getEmbeddingCount(db) === 0) return { scores: null };

  try {
    const { embed } = await import("../../llm/embedder.js");
    const queryEmbedding = await embed(query, config.embedding);
    const vecResults = searchVec(db, queryEmbedding, k);

    const scores = new Map<number, number>();
    for (const { id, distance } of vecResults) {
      // Convert L2 distance to cosine similarity (vectors are normalized).
      // Guard against NaN/Infinity from sqlite-vec edge cases.
      const raw = 1 - (distance * distance) / 2;
      scores.set(id, Number.isFinite(raw) ? Math.max(0, raw) : 0);
    }
    return { scores };
  } catch (error) {
    return { scores: null, warning: buildVectorFallbackWarning(config, error) };
  }
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
  query: string;
  rankingMode: "hybrid" | "semantic" | "fts";
  lexicalMatch?: LexicalQueryExecution;
  fragmentId?: string;
  /** Preloaded by the search batch; null means the indexed selector was absent. */
  indexedFragment?: IndexedMarkdownFragment | null;
  defaultStashDir: string;
  allSourceDirs: string[];
  sources: SearchSource[];
  config?: AkmConfig;
  utilityBoosted?: boolean;
  graphContext?: GraphBoostContext | null;
  attributionSource?: object;
  /** Optional renderer registry override for test isolation. */
  rendererRegistry?: RendererRegistry;
  /**
   * Phase 5A / Advantage D5: open DB connection threaded into the search-hit
   * enricher pipeline so the derived-memory enricher can resolve parent→child
   * via the `entries.derived_from` index. Absent for unit tests / call sites
   * that build hits without a DB — the enricher then becomes a no-op.
   */
  db?: Database;
}): Promise<SourceSearchHit> {
  const rendererRegistry = input.rendererRegistry ?? defaultRendererRegistry;
  const absolutePath = path.resolve(input.path);
  const entryStashDir = findSourceForPath(absolutePath, input.sources)?.path ?? input.defaultStashDir;

  // Quality and confidence boosts are now applied in the main scoring
  // phase (searchDatabase). buildDbHit receives the already-final score and
  // passes it through without further multiplication. We still compute the
  // boost values here for buildWhyMatched reporting.
  // Mirrors the boost computation in `searchDatabase`; only `curated`
  // contributes a positive boost. Used for `whyMatched` reporting only.
  const qualityBoost = input.entry.quality === "curated" ? 0.05 : 0;
  const confidenceBoost =
    typeof input.entry.confidence === "number" ? Math.min(0.05, Math.max(0, input.entry.confidence) * 0.05) : 0;
  // Round to 4 decimal places, no boost multiplication
  const score = Math.round(input.score * 10000) / 10000;

  const graphBoost = getSearchHitAttribution(input.attributionSource ?? {})?.graphExtraction?.boost ?? 0;

  const whyMatched = buildWhyMatched(
    input.entry,
    input.query,
    input.rankingMode,
    qualityBoost,
    confidenceBoost,
    input.utilityBoosted,
    graphBoost,
    input.lexicalMatch,
  );

  const graphHit = input.graphContext ? collectGraphRelatedHit(input.graphContext, absolutePath) : null;

  const source = findSourceForPath(absolutePath, input.sources);
  const defaultBundleId =
    input.config?.defaultBundle ??
    (source && path.resolve(source.path) === path.resolve(input.defaultStashDir)
      ? (input.bundleId ?? undefined)
      : undefined);
  const parentRef = resolveSearchHitRef(input.entry, input, defaultBundleId);
  // Fragments prove lexical relevance, but executable assets must retain the
  // parent ref consumed by their advertised action (for example workflow run).
  // The central type-presentation contract opts those types out explicitly.
  const ref = input.fragmentId && allowsFragmentRef(input.entry.type) ? `${parentRef}#${input.fragmentId}` : parentRef;

  const editable = isEditable(absolutePath, input.config, input.sources);
  const indexedFragment =
    input.indexedFragment === undefined
      ? input.fragmentId && input.db
        ? getIndexedMarkdownFragment(input.db, input.itemRef, input.fragmentId)
        : undefined
      : (input.indexedFragment ?? undefined);
  const selectedRef = input.fragmentId && ref !== parentRef ? `${parentRef}#${input.fragmentId}` : undefined;
  const parentEstimatedTokens =
    typeof input.entry.fileSize === "number"
      ? Math.round(input.entry.fileSize / 4)
      : indexedFragment
        ? Math.round(indexedFragment.parentChars / 4)
        : undefined;
  const fragmentEstimatedTokens = indexedFragment ? Math.round(indexedFragment.fragmentChars / 4) : undefined;
  const estimatedTokens =
    selectedRef === ref && fragmentEstimatedTokens !== undefined ? fragmentEstimatedTokens : parentEstimatedTokens;

  const hit: SourceSearchHit = {
    type: input.entry.type,
    name: input.entry.name,
    path: absolutePath,
    ref,
    origin: resolveSearchHitOrigin(source),
    editable,
    ...(!editable ? { editHint: buildEditHint(ref) } : {}),
    description: input.entry.description,
    tags: input.entry.tags,
    size: deriveSize(input.entry.fileSize),
    action: buildLocalAction(input.entry.type, ref, rendererRegistry),
    score,
    whyMatched,
    ...(estimatedTokens !== undefined ? { estimatedTokens } : {}),
    ...(selectedRef
      ? {
          selectedRef,
          parentRef,
          ...(indexedFragment
            ? {
                fragmentOrdinal: indexedFragment.ordinal + 1,
                fragmentCount: indexedFragment.count,
                startLine: indexedFragment.startLine,
                endLine: indexedFragment.endLine,
                ...(indexedFragment.previousFragmentId
                  ? { previousRef: `${parentRef}#${indexedFragment.previousFragmentId}` }
                  : {}),
                ...(indexedFragment.nextFragmentId
                  ? { nextRef: `${parentRef}#${indexedFragment.nextFragmentId}` }
                  : {}),
                fragmentChars: indexedFragment.fragmentChars,
                fragmentEstimatedTokens,
                parentChars: indexedFragment.parentChars,
                ...(parentEstimatedTokens !== undefined ? { parentEstimatedTokens } : {}),
              }
            : parentEstimatedTokens !== undefined
              ? { parentEstimatedTokens }
              : {}),
        }
      : {}),
    // Surface optional quality (v1 spec §4.2). Omitted when entry has
    // no `quality` field so payloads stay compact for the common case.
    ...(input.entry.quality ? { quality: input.entry.quality } : {}),
    ...(input.entry.beliefState ? { beliefState: input.entry.beliefState } : {}),
    ...(input.entry.currentBeliefRefs ? { currentBeliefRefs: input.entry.currentBeliefRefs } : {}),
    ...(graphHit ? { graph: { entities: graphHit.entities, relations: graphHit.relations } } : {}),
    // Which stage of the progressive AND->OR lexical ladder produced this
    // hit. Omitted when the hit has no FTS component (pure-semantic hybrid
    // contribution).
    ...(input.lexicalMatch ? { matchStage: input.lexicalMatch } : {}),
  };

  attachDbHitAttribution(hit, input);

  if (input.entry.derivedFrom) {
    attachSearchHitAttribution(hit, {
      memoryInference: { exposure: "direct" },
    });
  }
  await enrichSearchHit(hit, {
    type: input.entry.type,
    stashDir: entryStashDir,
    bundleId: input.bundleId,
    rendererRegistry,
    db: input.db,
  });

  return hit;
}

function attachDbHitAttribution(
  hit: SourceSearchHit,
  input: {
    entry: IndexDocument;
    query: string;
    lexicalMatch?: LexicalQueryExecution;
    attributionSource?: object;
  },
): void {
  if (input.lexicalMatch) {
    attachSearchHitAttribution(hit, {
      lexical: {
        execution: input.lexicalMatch,
        nameMatchTier: lexicalNameMatchTier(input.entry, buildLexicalQueryPlan(input.query).tokens),
      },
    });
  }
  if (input.attributionSource) copySearchHitAttribution(input.attributionSource, hit);
}

export function buildWhyMatched(
  entry: IndexDocument,
  query: string,
  // "hybrid" ranking mode
  rankingMode: "hybrid" | "semantic" | "fts",
  qualityBoost: number,
  confidenceBoost: number,
  utilityBoosted?: boolean,
  graphBoost?: number,
  lexicalMatch?: LexicalQueryExecution,
): string[] {
  const reasons: string[] = [
    rankingMode === "hybrid"
      ? "hybrid (fts + semantic)"
      : rankingMode === "semantic"
        ? "semantic similarity"
        : "fts bm25 relevance",
  ];
  if (lexicalMatch === "relaxed") reasons.push("lexical recovery after strict query returned no hits");
  if (lexicalMatch === "prefix") reasons.push("prefix match after strict query returned no hits");
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);

  const queryLower = query.toLowerCase().trim();
  const name = entry.name.toLowerCase();
  const nameBase = name.split("/").pop() ?? name;
  const tags = entry.tags?.join(" ").toLowerCase() ?? "";
  const searchHints = entry.searchHints?.join(" ").toLowerCase() ?? "";
  const aliases = entry.aliases?.join(" ").toLowerCase() ?? "";
  const desc = entry.description?.toLowerCase() ?? "";

  // Name match quality
  if (nameBase === queryLower || name === queryLower) {
    reasons.push("exact name match");
  } else if (nameBase.includes(queryLower) || queryLower.includes(nameBase)) {
    reasons.push("near-exact name match");
  } else if (tokens.some((t) => nameBase.includes(t))) {
    reasons.push("matched name tokens");
  }

  // Type relevance
  if (entry.type === "skill" || entry.type === "command" || entry.type === "agent") {
    reasons.push(`${entry.type} type boost`);
  }

  if (tokens.some((t) => tags.includes(t))) reasons.push("matched tags");
  if (tokens.some((t) => searchHints.includes(t))) reasons.push("matched searchHints");
  if (tokens.some((t) => aliases.includes(t))) reasons.push("matched aliases");
  if (tokens.some((t) => desc.includes(t))) reasons.push("matched description");
  if (qualityBoost > 0) reasons.push("curated metadata boost");
  if (confidenceBoost > 0) reasons.push("metadata confidence boost");
  if (entry.beliefState === "active") reasons.push("active belief state");
  if (entry.beliefState === "asserted") reasons.push("asserted belief state");
  if (entry.beliefState === "contradicted") reasons.push("contradicted belief state");
  if (entry.beliefState === "superseded") reasons.push("superseded belief state");
  if (entry.beliefState === "deprecated") reasons.push("deprecated belief state");
  if (entry.beliefState === "archived") reasons.push("archived belief state");
  if (utilityBoosted) reasons.push("usage history boost");
  if (typeof graphBoost === "number" && graphBoost > 0) {
    reasons.push(`graph boost +${graphBoost.toFixed(2)}`);
  }

  return reasons;
}

// ── Utilities ────────────────────────────────────────────────────────────────

export function deriveSize(bytes?: number): SearchHitSize | undefined {
  if (bytes === undefined) return undefined;
  if (bytes < 1024) return "small";
  if (bytes < 10240) return "medium";
  return "large";
}

/**
 * Deduplicate the already-ranked result stream by file path. The caller owns
 * the one ranking order; re-sorting here would silently discard exact-name and
 * relaxed-recovery ordering in favor of an internal pre-clamp score.
 */
function deduplicateByPath<T extends { filePath: string; score?: number }>(items: T[]): T[] {
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
