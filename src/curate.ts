/**
 * Curate logic for `akm curate`.
 *
 * Given a query (and optional type filter / source / limit), pick a small,
 * high-signal set of stash + registry hits and enrich each with the data
 * needed to act (ref, run, parameters, follow-up command).
 *
 * The exported `akmCurate()` API is the single entry point. Internal
 * helpers stay private. Tests can drive the public API or call the smaller
 * pure helpers (`curateSearchResults`, `orderCuratedTypes`,
 * `deriveCurateFallbackQueries`) by importing them directly.
 */

import { truncateDescription } from "./output-shapes";
import { akmSearch, parseSearchSource } from "./stash-search";
import { akmShowUnified } from "./stash-show";
import type { RegistrySearchResultHit, SearchResponse, ShowResponse, StashSearchHit } from "./stash-types";

export type CuratedStashItem = {
  source: "stash";
  type: string;
  name: string;
  ref: string;
  description?: string;
  preview?: string;
  parameters?: string[];
  run?: string;
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
}

const CURATE_FALLBACK_FILTER_WORDS = new Set([
  "a",
  "an",
  "and",
  "for",
  "how",
  "i",
  "in",
  "of",
  "or",
  "the",
  "to",
  "with",
]);
const CURATED_TYPE_FALLBACK_ORDER = ["skill", "command", "script", "knowledge", "agent", "memory"];
const CURATED_TYPE_FALLBACK_INDEX = new Map(CURATED_TYPE_FALLBACK_ORDER.map((type, index) => [type, index]));
const MIN_CURATE_FALLBACK_TOKEN_LENGTH = 3;
const MAX_CURATE_FALLBACK_KEYWORDS = 6;
export const CURATE_SEARCH_LIMIT_MULTIPLIER = 4;
export const MIN_CURATE_SEARCH_LIMIT = 12;
const DEFAULT_CURATE_LIMIT = 4;

/**
 * Public curate entry point. Performs the search itself when
 * `options.searchResponse` is not supplied.
 */
export async function akmCurate(options: CurateOptions): Promise<CurateResponse> {
  const limit = options.limit && options.limit > 0 ? options.limit : DEFAULT_CURATE_LIMIT;
  const source = options.source ?? parseSearchSource("stash");
  const searchResponse =
    options.searchResponse ??
    (await searchForCuration({
      query: options.query,
      type: options.type,
      // Search deeper than the final curated count so we can pick one strong
      // match per type and still have room for fallback retries.
      limit: Math.max(limit * CURATE_SEARCH_LIMIT_MULTIPLIER, MIN_CURATE_SEARCH_LIMIT),
      source,
    }));
  return curateSearchResults(options.query, searchResponse, limit, options.type);
}

export async function curateSearchResults(
  query: string,
  result: SearchResponse,
  limit: number,
  selectedType?: string,
): Promise<CurateResponse> {
  const stashHits = result.hits.filter((hit): hit is StashSearchHit => hit.type !== "registry");
  const registryHits = result.registryHits ?? [];

  let selectedStashHits: StashSearchHit[];
  if (selectedType && selectedType !== "any") {
    selectedStashHits = stashHits.slice(0, limit);
  } else {
    const bestByType = new Map<string, StashSearchHit>();
    for (const hit of stashHits) {
      if (!bestByType.has(hit.type)) bestByType.set(hit.type, hit);
    }
    const orderedTypes = orderCuratedTypes(query, Array.from(bestByType.keys()));
    selectedStashHits = orderedTypes
      .map((type) => bestByType.get(type))
      .filter((hit): hit is StashSearchHit => Boolean(hit));
  }

  const selectedRegistryHits =
    selectedStashHits.length >= limit ? [] : registryHits.slice(0, Math.min(2, limit - selectedStashHits.length));

  const items = [
    ...(await Promise.all(selectedStashHits.slice(0, limit).map((hit) => enrichCuratedStashHit(query, hit)))),
    ...selectedRegistryHits.map((hit) => buildCuratedRegistryItem(query, hit)),
  ].slice(0, limit);

  return {
    query,
    summary: buildCurateSummary(query, items),
    items,
    ...(result.warnings?.length ? { warnings: result.warnings } : {}),
    ...(result.tip ? { tip: result.tip } : {}),
  };
}

export function orderCuratedTypes(query: string, types: string[]): string[] {
  const lower = query.toLowerCase();
  const boosts = new Map<string, number>();
  const addBoost = (type: string, amount: number) => boosts.set(type, (boosts.get(type) ?? 0) + amount);

  if (/(run|script|bash|shell|cli|execute|automation|deploy|build|test|lint)/.test(lower)) {
    addBoost("script", 6);
    addBoost("command", 4);
  }
  if (/(guide|docs?|readme|reference|how|explain|learn|why)/.test(lower)) {
    addBoost("knowledge", 6);
    addBoost("skill", 4);
  }
  if (/(agent|assistant|planner|review|analy[sz]e|architect|prompt)/.test(lower)) {
    addBoost("agent", 6);
    addBoost("skill", 3);
  }
  if (/(config|template|release|generate|command)/.test(lower)) {
    addBoost("command", 5);
  }
  if (/(memory|context|recall|remember)/.test(lower)) {
    addBoost("memory", 6);
  }

  return [...types].sort((a, b) => {
    const boostDiff = (boosts.get(b) ?? 0) - (boosts.get(a) ?? 0);
    if (boostDiff !== 0) return boostDiff;
    return (
      (CURATED_TYPE_FALLBACK_INDEX.get(a) ?? Number.MAX_SAFE_INTEGER) -
      (CURATED_TYPE_FALLBACK_INDEX.get(b) ?? Number.MAX_SAFE_INTEGER)
    );
  });
}

async function enrichCuratedStashHit(query: string, hit: StashSearchHit): Promise<CuratedStashItem> {
  let shown: ShowResponse | undefined;
  try {
    shown = await akmShowUnified({ ref: hit.ref });
  } catch {
    shown = undefined;
  }

  const description = shown?.description ?? hit.description;
  const preview = buildCuratedPreview(shown, hit);
  return {
    source: "stash",
    type: shown?.type ?? hit.type,
    name: shown?.name ?? hit.name,
    ref: hit.ref,
    ...(description ? { description } : {}),
    ...(preview ? { preview } : {}),
    ...(shown?.parameters?.length ? { parameters: shown.parameters } : {}),
    ...(shown?.run ? { run: shown.run } : {}),
    followUp: `akm show ${hit.ref}`,
    reason: buildCuratedReason(query, shown?.type ?? hit.type),
    ...(hit.score !== undefined ? { score: hit.score } : {}),
  };
}

function buildCuratedRegistryItem(query: string, hit: RegistrySearchResultHit): CuratedRegistryItem {
  return {
    source: "registry",
    type: "registry",
    name: hit.name,
    id: hit.id,
    ...(hit.description ? { description: hit.description } : {}),
    followUp: hit.action ?? `akm add ${hit.id}`,
    reason: `Useful external source to explore for ${query}.`,
    ...(hit.score !== undefined ? { score: hit.score } : {}),
  };
}

function firstNonEmpty(values: Array<string | undefined>): string | undefined {
  return values.find((value) => typeof value === "string" && value.trim().length > 0);
}

function buildCuratedPreview(shown: ShowResponse | undefined, hit: StashSearchHit): string | undefined {
  if (shown?.run) return truncateDescription(`run ${shown.run}`, 160);
  const payload = firstNonEmpty([shown?.template, shown?.prompt, shown?.content, hit.description])
    ?.replace(/\s+/g, " ")
    .trim();
  return payload ? truncateDescription(payload, 160) : undefined;
}

function buildCuratedReason(query: string, type: string): string {
  switch (type) {
    case "script":
      return `Best runnable script match for "${query}".`;
    case "command":
      return `Best reusable command/template match for "${query}".`;
    case "knowledge":
      return `Best reference document match for "${query}".`;
    case "skill":
      return `Best instructions/workflow match for "${query}".`;
    case "agent":
      return `Best specialized agent prompt match for "${query}".`;
    case "memory":
      return `Best saved context match for "${query}".`;
    default:
      return `Best ${type} match for "${query}".`;
  }
}

function buildCurateSummary(query: string, items: CuratedItem[]): string {
  if (items.length === 0) {
    return `No curated assets were selected for "${query}".`;
  }
  const labels = items.map((item) => `${item.type}:${item.name}`);
  return `Selected ${items.length} high-signal result${items.length === 1 ? "" : "s"}: ${labels.join(", ")}.`;
}

function hasSearchResults(result: SearchResponse): boolean {
  return result.hits.length > 0 || (result.registryHits?.length ?? 0) > 0;
}

/**
 * Extract a small set of fallback keywords when a prompt-style curate query
 * returns no hits as a whole phrase.
 *
 * We keep up to MAX_CURATE_FALLBACK_KEYWORDS distinct keywords and drop short
 * or common filler words so follow-up searches stay inexpensive while focusing
 * on higher-signal terms.
 */
export function deriveCurateFallbackQueries(query: string): string[] {
  return Array.from(
    new Set(
      query
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .map((token) => token.trim())
        // Keep longer tokens so fallback stays focused on higher-signal terms
        // and avoids broad one- and two-letter matches that overwhelm curation.
        .filter(
          (token) => token.length >= MIN_CURATE_FALLBACK_TOKEN_LENGTH && !CURATE_FALLBACK_FILTER_WORDS.has(token),
        ),
    ),
  ).slice(0, MAX_CURATE_FALLBACK_KEYWORDS);
}

export function mergeCurateSearchResponses(base: SearchResponse, extras: SearchResponse[]): SearchResponse {
  const hitsByRef = new Map<string, StashSearchHit>();
  for (const hit of base.hits.filter((entry): entry is StashSearchHit => entry.type !== "registry")) {
    hitsByRef.set(hit.ref, hit);
  }
  for (const result of extras) {
    for (const hit of result.hits.filter((entry): entry is StashSearchHit => entry.type !== "registry")) {
      const existing = hitsByRef.get(hit.ref);
      if (!existing || (hit.score ?? 0) > (existing.score ?? 0)) {
        hitsByRef.set(hit.ref, hit);
      }
    }
  }

  const registryById = new Map<string, RegistrySearchResultHit>();
  for (const hit of base.registryHits ?? []) {
    registryById.set(hit.id, hit);
  }
  for (const result of extras) {
    for (const hit of result.registryHits ?? []) {
      const existing = registryById.get(hit.id);
      if (!existing || (hit.score ?? 0) > (existing.score ?? 0)) {
        registryById.set(hit.id, hit);
      }
    }
  }

  const warnings = Array.from(
    new Set([...(base.warnings ?? []), ...extras.flatMap((result) => result.warnings ?? [])]),
  );
  const mergedHits = [...hitsByRef.values()].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const mergedRegistryHits = [...registryById.values()].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

  return {
    ...base,
    hits: mergedHits,
    ...(mergedRegistryHits.length > 0 ? { registryHits: mergedRegistryHits } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(mergedHits.length > 0 || mergedRegistryHits.length > 0 ? { tip: undefined } : {}),
  };
}

export async function searchForCuration(input: {
  query: string;
  type?: string;
  limit: number;
  source: ReturnType<typeof parseSearchSource>;
}): Promise<SearchResponse> {
  const initial = await akmSearch(input);
  if (hasSearchResults(initial)) return initial;

  const fallbackQueries = deriveCurateFallbackQueries(input.query);
  if (fallbackQueries.length <= 1) return initial;

  const fallbackResults = await Promise.all(
    fallbackQueries.map((token) =>
      akmSearch({
        query: token,
        type: input.type,
        limit: input.limit,
        source: input.source,
      }),
    ),
  );
  return mergeCurateSearchResponses(initial, fallbackResults);
}
