// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Curate logic for `akm curate`.
 *
 * Given a query (and optional type filter / source / limit), pick a small,
 * high-signal set of stash + registry hits and enrich each with the data
 * needed to act (ref, run, parameters, follow-up command).
 *
 * Curation is one search with the fused ranking, the top `limit` hits, and
 * per-hit enrichment (preview, run and parameters, graph support refs). An
 * optional reranker reorders the top fused candidates first.
 *
 * The exported `akmCurate()` API is the single entry point; tests can also
 * drive `curateSearchResults` with a fixture search response.
 */

import { loadConfig } from "../../core/config/config";
import { rethrowIfTestIsolationError, UsageError } from "../../core/errors";
import { appendEvent } from "../../core/events";
import { redactCredentialPatterns } from "../../core/redaction";
import { withStateDbTelemetry } from "../../core/state-db";
import { searchHitContent } from "../../indexer/search/db-search";
import {
  type AttributionProjection,
  copySearchHitAttribution,
  getSearchHitAttribution,
  usageEventAttributionMetadata,
} from "../../indexer/search/search-attribution";
import { insertUsageEvent, type UsageEventSource } from "../../indexer/usage/usage-events";
import { estimateTokenCount } from "../../llm/embedders/remote";
import { isLlmFeatureEnabled, tryLlmFeature } from "../../llm/feature-gate";
import { rerankDocuments } from "../../llm/rerank-client";
import { truncateDescription } from "../../output/shapes/helpers";
import type {
  RegistrySearchResultHit,
  SearchExecutionMode,
  SearchResponse,
  ShowResponse,
  SourceSearchHit,
} from "../../sources/types";
import { TELEMETRY_BUSY_TIMEOUT_MS, withIndexDb } from "../../storage/repositories/index-db";
import { findEntryIdByRef, getItemRefById } from "../../storage/repositories/index-entries-repository";
import { akmSearch, parseSearchSource } from "./search";
import { akmShowUnified } from "./show";

export type CurateSupportRef = {
  ref: string;
  type?: string;
  reason: string;
};

export type CuratedStashItem = {
  source: "local";
  type: string;
  name: string;
  ref: string;
  path: string;
  editable: boolean;
  editHint?: string;
  description?: string;
  preview?: string;
  keys?: string[];
  parameters?: string[];
  run?: string;
  supportRefs?: CurateSupportRef[];
  followUp: string;
  reason: string;
  score?: number;
};

export type CuratedRegistryItem = {
  source: "registry";
  type: "registry";
  name: string;
  id: string;
  description?: string;
  followUp: string;
  reason: string;
  score?: number;
};

export type CuratedItem = CuratedStashItem | CuratedRegistryItem;

export interface CurateResponse {
  query: string;
  summary: string;
  items: CuratedItem[];
  warnings?: string[];
  searchMode?: SearchExecutionMode;
  tip?: string;
}

export interface CurateOptions {
  query: string;
  type?: string;
  limit?: number;
  source?: ReturnType<typeof parseSearchSource>;
  /**
   * Optional pre-fetched search response (for tests). When supplied,
   * `akmCurate` skips its IO and curates this fixture directly.
   */
  searchResponse?: SearchResponse;
  /**
   * Usage-event provenance for telemetry. Defaults to `"user"`. The CLI passes
   * the AKM_EVENT_SOURCE-derived value so pipeline/task-runner curates are not
   * recorded as user demand (was previously hardcoded to "user").
   */
  eventSource?: UsageEventSource;
  /** Internal projection used only to decide whether derived surface content was emitted. */
  attributionProjection?: AttributionProjection;
  /**
   * When true, skip logging usage events for this curate call (F2/R-055):
   * neither the top-level curate event nor the underlying search/show reads
   * feed usage-events telemetry. Wired to `akm curate --no-track-usage`.
   * Curate's own nested `akmSearch`/`akmShowUnified` calls always pass
   * `skipLogging: true` — this flag additionally silences curate's OWN
   * top-level event.
   */
  skipLogging?: boolean;
}

const DEFAULT_CURATE_LIMIT = 4;
const MAX_CURATE_SUPPORT_REFS = 2;
/** Fused candidates the reranker reorders when `search.curateRerank.topN` is unset. */
const DEFAULT_CURATE_RERANK_TOP_N = 30;
/** Characters of name, description and content sent to the reranker per candidate. */
const RERANK_DOCUMENT_CHARS = 2000;

/**
 * Fire-and-forget: log a curate event to the usage_events table and events.jsonl.
 * Never blocks the caller; errors are silently ignored.
 */
function logCurateEvent(
  rawQuery: string,
  result: CurateResponse,
  eventSource: UsageEventSource = "user",
  attributionProjection: AttributionProjection = "full",
): void {
  // Credentials pasted into a query (e.g. by the Claude Code hook that
  // curates every user prompt) must never reach state.db verbatim — see
  // `redactCredentialPatterns`. Redacted once here so every persistence call
  // below (events.metadata_json via appendEvent, usage_events.query via
  // insertUsageEvent) gets the same scrubbed text.
  const query = redactCredentialPatterns(rawQuery);
  const itemRefs = result.items.map((item) => ("ref" in item ? item.ref : `registry:${item.id}`));
  appendEvent({
    eventType: "curate",
    metadata: { query, itemCount: result.items.length, itemRefs },
  });

  try {
    withIndexDb(
      (db) => {
        // Resolve each curated item's DURABLE fully-qualified `item_ref` (D-R3)
        // + entry_id from index.db (`db`); the usage_events writes land in
        // state.db (Chunk-8 WI-8.3).
        const perItem = result.items
          .filter((item): item is typeof item & { ref: string } => "ref" in item && typeof item.ref === "string")
          .flatMap((item) => {
            const entryId = findEntryIdByRef(db, item.ref);
            if (entryId === undefined) return [];
            const itemRef = getItemRefById(db, entryId);
            return itemRef ? [{ entryRef: itemRef, entryId, item }] : [];
          });
        withStateDbTelemetry((stateDb) => {
          insertUsageEvent(stateDb, {
            event_type: "curate",
            query,
            metadata: JSON.stringify({
              itemCount: result.items.length,
              itemRefs,
            }),
            source: eventSource,
          });
          for (const { entryRef, entryId, item } of perItem) {
            insertUsageEvent(stateDb, {
              event_type: "curate",
              query,
              entry_ref: entryRef,
              entry_id: entryId,
              metadata: usageEventAttributionMetadata(getSearchHitAttribution(item), entryRef, attributionProjection),
              source: eventSource,
            });
          }
        }, TELEMETRY_BUSY_TIMEOUT_MS);
      },
      { busyTimeoutMs: TELEMETRY_BUSY_TIMEOUT_MS },
    );
  } catch (err) {
    rethrowIfTestIsolationError(err);
  }
}

export async function akmCurate(options: CurateOptions): Promise<CurateResponse> {
  const trimmedQuery = options.query.trim();
  if (!trimmedQuery) {
    throw new UsageError(
      'A curation query is required. Usage: akm curate "<task or prompt>" [--type <type>] [--limit <n>]',
      "MISSING_REQUIRED_ARGUMENT",
    );
  }

  const limit = options.limit && options.limit > 0 ? options.limit : DEFAULT_CURATE_LIMIT;
  const source = options.source ?? parseSearchSource("local");
  const searchResponse =
    options.searchResponse ??
    (await akmSearch({
      query: options.query,
      type: options.type,
      // An enabled reranker reorders the top fused candidates, not just the final `limit`.
      limit: Math.max(limit, rerankTopN(loadConfig())),
      source,
      skipLogging: true,
    }));
  const result = await curateSearchResults(options.query, searchResponse, limit, options.type, options.eventSource);
  if (!options.skipLogging) {
    logCurateEvent(options.query, result, options.eventSource, options.attributionProjection);
  }
  return result;
}

export async function curateSearchResults(
  query: string,
  result: SearchResponse,
  limit: number,
  selectedType?: string,
  eventSource?: UsageEventSource,
): Promise<CurateResponse> {
  const allStashHits = result.hits.filter((hit): hit is SourceSearchHit => hit.type !== "registry");
  const registryHits = result.registryHits ?? [];

  // F3/R-018: `--type` NARROWS the candidate pool. The caller's search
  // usually applied the filter already, but `curateSearchResults` is also
  // driven directly (tests, `searchResponse` fixtures) with a
  // `SearchResponse` that was never type-filtered.
  const stashHits =
    selectedType && selectedType !== "any" ? allStashHits.filter((hit) => hit.type === selectedType) : allStashHits;

  const selectedStashHits = (await maybeRerankCuratedStashHits(query, stashHits)).slice(0, limit);

  // F4/R-019: respect `--limit` for registry fill instead of hard-capping it
  // at a bare literal 2 — the remaining slots after stash hits ARE the cap.
  const selectedRegistryHits =
    selectedStashHits.length >= limit ? [] : registryHits.slice(0, limit - selectedStashHits.length);
  const selectedRefs = new Set(selectedStashHits.map((hit) => hit.ref));

  const items = [
    ...(await Promise.all(
      selectedStashHits.map((hit) => enrichCuratedStashHit(query, hit, selectedRefs, eventSource)),
    )),
    ...selectedRegistryHits.map((hit) => buildCuratedRegistryItem(query, hit)),
  ].slice(0, limit);
  return {
    query,
    summary: buildCurateSummary(query, items),
    items,
    ...(result.warnings?.length ? { warnings: result.warnings } : {}),
    ...(result.searchMode ? { searchMode: result.searchMode } : {}),
    ...(result.tip ? { tip: result.tip } : {}),
  };
}

export interface PackedCurateItem {
  ref: string;
  tokens: number;
  content: string;
}

export interface CuratePackResult {
  query: string;
  budget: number;
  tokens: number;
  items: PackedCurateItem[];
}

/**
 * Pack a curate result's stash hits into a single token-budgeted blob:
 * resolve each hit's content via the SAME path `akm show` uses
 * (`akmShowUnified` — this also means a `ref#fragment` hit packs just the
 * matched section), then greedily accumulate hits, in the ranking order
 * `curateSearchResults` already produced, until the next hit would exceed
 * `budgetTokens`.
 *
 * Registry hits are never packed — only `CuratedStashItem`s (locked
 * contract, AGENTS.md: registry results stay separate/opt-in).
 *
 * Truncation policy: drop whole hits from the tail of the ranked list first.
 * The only exception is a single high-rank hit that alone exceeds the
 * budget — that one hit is truncated to fit rather than dropping everything.
 */
export async function packCuratedHits(result: CurateResponse, budgetTokens: number): Promise<CuratePackResult> {
  const stashItems = result.items.filter((item): item is CuratedStashItem => item.source === "local");
  const packed: PackedCurateItem[] = [];
  let used = 0;

  for (const item of stashItems) {
    let shown: ShowResponse | undefined;
    try {
      shown = await akmShowUnified({ ref: item.ref, skipLogging: true });
    } catch {
      continue;
    }
    const content = shown.content ?? shown.template ?? shown.prompt ?? "";
    const tokens = estimateTokenCount(content);

    if (used + tokens <= budgetTokens) {
      packed.push({ ref: item.ref, tokens, content });
      used += tokens;
      continue;
    }

    if (packed.length === 0) {
      const remaining = budgetTokens - used;
      if (remaining > 0) {
        const truncated = content.slice(0, remaining * 4);
        packed.push({ ref: item.ref, tokens: estimateTokenCount(truncated), content: truncated });
        used += estimateTokenCount(truncated);
      }
    }
    break;
  }

  return { query: result.query, budget: budgetTokens, tokens: used, items: packed };
}

async function enrichCuratedStashHit(
  query: string,
  hit: SourceSearchHit,
  selectedRefs: Set<string>,
  eventSource?: UsageEventSource,
): Promise<CuratedStashItem> {
  let shown: ShowResponse | undefined;
  try {
    shown = await akmShowUnified({ ref: hit.ref, eventSource, skipLogging: true });
  } catch {
    shown = undefined;
  }

  const description = shown?.description ?? hit.description;
  const preview = buildCuratedPreview(shown, hit);
  const supportRefs = buildCurateSupportRefs(shown?.related?.hits, selectedRefs, hit.ref);

  const item: CuratedStashItem = {
    source: "local",
    type: shown?.type ?? hit.type,
    name: shown?.name ?? hit.name,
    ref: hit.ref,
    path: shown?.path ?? hit.path,
    editable: shown?.editable ?? hit.editable ?? false,
    ...((shown?.editable ?? hit.editable ?? false) === false
      ? { editHint: shown?.editHint ?? hit.editHint ?? `This asset is read-only. Inspect it with: akm show ${hit.ref}` }
      : {}),
    ...(description ? { description } : {}),
    ...(preview ? { preview } : {}),
    ...(shown?.keys?.length ? { keys: shown.keys } : {}),
    ...(shown?.parameters?.length ? { parameters: shown.parameters } : {}),
    ...(shown?.run ? { run: shown.run } : {}),
    ...(supportRefs.length > 0 ? { supportRefs } : {}),
    followUp: `akm show ${hit.ref}`,
    reason: buildCuratedReason(query, shown?.type ?? hit.type),
    ...(hit.score !== undefined ? { score: hit.score } : {}),
  };
  copySearchHitAttribution(hit, item, item.description);
  return item;
}

function buildCuratedRegistryItem(query: string, hit: RegistrySearchResultHit): CuratedRegistryItem {
  return {
    source: "registry",
    type: "registry",
    name: hit.name,
    id: hit.id,
    ...(hit.description ? { description: hit.description } : {}),
    followUp: hit.action ?? `akm bundle add ${hit.id}`,
    reason: `Useful external source to explore for ${query}.`,
    ...(hit.score !== undefined ? { score: hit.score } : {}),
  };
}

function firstNonEmpty(values: Array<string | undefined>): string | undefined {
  return values.find((value) => typeof value === "string" && value.trim().length > 0);
}

function buildCuratedPreview(shown: ShowResponse | undefined, hit: SourceSearchHit): string | undefined {
  if (shown?.run) return truncateDescription(`run ${shown.run}`, 160);
  const payload = firstNonEmpty([shown?.template, shown?.prompt, shown?.content, hit.description])
    ?.replace(/\s+/g, " ")
    .trim();
  return payload ? truncateDescription(payload, 160) : undefined;
}

function buildCuratedReason(query: string, type: string): string {
  switch (type) {
    case "script":
      return `Strong runnable script match for "${query}".`;
    case "command":
      return `Strong reusable command/template match for "${query}".`;
    case "knowledge":
      return `Strong reference document match for "${query}".`;
    case "skill":
      return `Strong instructions/workflow match for "${query}".`;
    case "agent":
      return `Strong specialized agent prompt match for "${query}".`;
    case "memory":
      return `Strong saved context match for "${query}".`;
    default:
      return `Strong ${type} match for "${query}".`;
  }
}

function buildCurateSummary(query: string, items: CuratedItem[]): string {
  if (items.length === 0) {
    return `No curated assets were selected for "${query}".`;
  }
  // F4b: emit the flipped conceptId ref for stash items (registry items have no
  // ref — keep their `registry:<name>` label).
  const labels = items.map((item) => ("ref" in item ? item.ref : `${item.type}:${item.name}`));
  return `Selected ${items.length} curated result${items.length === 1 ? "" : "s"}: ${labels.join(", ")}.`;
}

/** How many fused candidates curate fetches for the reranker; 0 when reranking is off. */
function rerankTopN(config: ReturnType<typeof loadConfig>): number {
  if (!isLlmFeatureEnabled(config, "curate_rerank")) return 0;
  return config.search?.curateRerank?.topN ?? DEFAULT_CURATE_RERANK_TOP_N;
}

/**
 * Optional cross-encoder rerank of the top fused candidates (#951). Disabled
 * by default (`search.curateRerank.enabled`) and, when enabled, best-effort:
 * any failure (misconfigured endpoint, network error, timeout, malformed
 * response) keeps the fused order — a reranker outage must never turn into a
 * curate failure. The top `topN` candidates (default
 * {@link DEFAULT_CURATE_RERANK_TOP_N}) are sent as name, description and the
 * start of the indexed content; the rest keep their fused order after them.
 */
async function maybeRerankCuratedStashHits(query: string, hits: SourceSearchHit[]): Promise<SourceSearchHit[]> {
  if (hits.length <= 1) return hits;
  const config = loadConfig();
  const rerankConfig = config.search?.curateRerank;
  return tryLlmFeature(
    "curate_rerank",
    config,
    async () => {
      const head = hits.slice(0, rerankTopN(config));
      const tail = hits.slice(head.length);
      const ranked = await rerankDocuments(rerankConfig ?? {}, query, rerankDocumentTexts(head));
      const rerankedHead = ranked
        .map(({ index }) => head[index])
        .filter((hit): hit is SourceSearchHit => hit !== undefined);
      return [...rerankedHead, ...tail];
    },
    hits,
    { timeoutMs: rerankConfig?.timeoutMs ?? null },
  );
}

/**
 * Name, description and the start of each hit's indexed content, capped for
 * the reranker. The content is the index's safe projection (env and secret
 * values never reach it), never the raw file.
 */
function rerankDocumentTexts(hits: SourceSearchHit[]): string[] {
  return hits.map((hit) =>
    [hit.name, hit.description, searchHitContent(hit)].filter(Boolean).join("\n").slice(0, RERANK_DOCUMENT_CHARS),
  );
}

/** Up to {@link MAX_CURATE_SUPPORT_REFS} graph-related assets not already selected. */
function buildCurateSupportRefs(
  relatedHits:
    | Array<{ ref?: string; path: string; type: string; sharedEntities: string[]; relationCount: number }>
    | undefined,
  selectedRefs: Set<string>,
  ownerRef: string,
): CurateSupportRef[] {
  const supportRefs: CurateSupportRef[] = [];
  for (const hit of relatedHits ?? []) {
    if (!hit.ref || hit.ref === ownerRef || selectedRefs.has(hit.ref)) continue;
    if (supportRefs.some((existing) => existing.ref === hit.ref)) continue;
    supportRefs.push({ ref: hit.ref, type: hit.type, reason: "Related asset via shared entities." });
    if (supportRefs.length >= MAX_CURATE_SUPPORT_REFS) break;
  }
  return supportRefs;
}
