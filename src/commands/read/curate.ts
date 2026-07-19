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
 * The exported `akmCurate()` API is the single entry point. Internal helpers
 * stay private. Tests can drive the public API or call the smaller pure
 * helpers (`curateSearchResults`, `deriveCurateFallbackQueries`,
 * `mergeCurateSearchResponses`) by importing them directly.
 */

import fs from "node:fs";
import { parseFrontmatter } from "../../core/asset/frontmatter";
import { parseRefInput } from "../../core/asset/resolve-ref";
import { getIndexPassConfig, loadConfig } from "../../core/config/config";
import { rethrowIfTestIsolationError, UsageError } from "../../core/errors";
import { appendEvent } from "../../core/events";
import { enqueueGraphExtraction, hasGraphData } from "../../indexer/db/graph-db";
import { findSourceForPath, resolveSourceEntries } from "../../indexer/search/search-source";
import { insertUsageEvent, type UsageEventSource } from "../../indexer/usage/usage-events";
import { truncateDescription } from "../../output/shapes";
import type { RegistrySearchResultHit, SearchResponse, ShowResponse, SourceSearchHit } from "../../sources/types";
import { TELEMETRY_BUSY_TIMEOUT_MS, withIndexDb } from "../../storage/repositories/index-db";
import { findEntryIdByRef, getItemRefById } from "../../storage/repositories/index-entries-repository";
import { computeBodyHash } from "../../storage/repositories/index-llm-cache-repository";
import { akmSearch, parseSearchSource } from "./search";
import { akmShowUnified } from "./show";

export type CurateSupportRef = {
  ref: string;
  type?: string;
  reason: string;
};

export type CuratedStashItem = {
  source: "stash";
  type: string;
  name: string;
  ref: string;
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
const CURATE_SHORT_FALLBACK_TOKENS = new Set(["ai", "ci", "cd", "go", "js", "ts"]);
const MIN_CURATE_FALLBACK_TOKEN_LENGTH = 3;
const MAX_CURATE_FALLBACK_KEYWORDS = 6;
export const CURATE_SEARCH_LIMIT_MULTIPLIER = 4;
export const MIN_CURATE_SEARCH_LIMIT = 12;
const DEFAULT_CURATE_LIMIT = 4;
const CURATE_CLOSE_SCORE_BAND = 0.12;
const CURATE_TAIL_SCORE_FLOOR = 0.35;
const CURATE_RELATIVE_SCORE_FLOOR = 0.7;
const CURATE_FALLBACK_TOP_SCORE_THRESHOLD = 0.8;
const CURATE_FALLBACK_STRONG_SCORE_FLOOR = 0.35;
const MAX_CURATE_SUPPORT_REFS = 2;

type CurateIntent = {
  executionHeavy: boolean;
  multiStep: boolean;
  delegation: boolean;
  recall: boolean;
  reference: boolean;
};

type CurateFamily = { key: string; role: "root" } | { key: string; role: "reference"; topicTokens: string[] };

type AnnotatedCurateHit = {
  hit: SourceSearchHit;
  rawScore: number;
  adjustedScore: number;
  originalIndex: number;
  family?: CurateFamily;
};

type CollapsedCurateHit = {
  hit: SourceSearchHit;
  originalIndex: number;
};

const CURATE_REFERENCE_QUERY_RE = /\b(?:reference|docs?|guide|how|explain|learn|readme|why)\b/;

/**
 * Fire-and-forget: log a curate event to the usage_events table and events.jsonl.
 * Never blocks the caller; errors are silently ignored.
 */
function logCurateEvent(query: string, result: CurateResponse, eventSource: UsageEventSource = "user"): void {
  const itemRefs = result.items.map((item) => ("ref" in item ? item.ref : `registry:${item.id}`));
  appendEvent({
    eventType: "curate",
    metadata: { query, itemCount: result.items.length, itemRefs },
  });

  try {
    withIndexDb(
      (db) => {
        insertUsageEvent(db, {
          event_type: "curate",
          query,
          metadata: JSON.stringify({
            itemCount: result.items.length,
            itemRefs,
          }),
          source: eventSource,
        });
        for (const item of result.items) {
          if (!("ref" in item) || typeof item.ref !== "string") continue;
          // F4c: resolve the entry and persist its DURABLE fully-qualified
          // `item_ref` (D-R3), keying the event on entry_id so the count survives
          // a rebuild via the id join.
          const entryId = findEntryIdByRef(db, item.ref);
          const itemRef = entryId !== undefined ? getItemRefById(db, entryId) : null;
          // Post-flip the resolved row carries `item_ref`; fall back to the
          // item's own (new-grammar) ref for an unresolved straggler.
          const entryRef = itemRef ?? item.ref;
          insertUsageEvent(db, {
            event_type: "curate",
            query,
            entry_ref: entryRef,
            entry_id: entryId,
            source: eventSource,
          });
        }
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
  const source = options.source ?? parseSearchSource("stash");
  const searchResponse =
    options.searchResponse ??
    (await searchForCuration({
      query: options.query,
      type: options.type,
      limit: Math.max(limit * CURATE_SEARCH_LIMIT_MULTIPLIER, MIN_CURATE_SEARCH_LIMIT),
      source,
    }));
  const result = await curateSearchResults(options.query, searchResponse, limit, options.type);
  logCurateEvent(options.query, result, options.eventSource);
  return result;
}

export async function curateSearchResults(
  query: string,
  result: SearchResponse,
  limit: number,
  selectedType?: string,
): Promise<CurateResponse> {
  const stashHits = result.hits.filter((hit): hit is SourceSearchHit => hit.type !== "registry");
  const registryHits = result.registryHits ?? [];

  let selectedStashHits: SourceSearchHit[];
  let supportRefsByRef = new Map<string, CurateSupportRef[]>();
  if (selectedType && selectedType !== "any") {
    selectedStashHits = stashHits.slice(0, limit);
  } else {
    const selected = selectCuratedStashHits(query, stashHits, limit);
    const preferred = preferBroadRootRepresentative(query, selected.selected, stashHits, selected.supportRefsByRef);
    selectedStashHits = preferred.selected;
    supportRefsByRef = preferred.supportRefsByRef;
  }

  const selectedRegistryHits =
    selectedStashHits.length >= limit ? [] : registryHits.slice(0, Math.min(2, limit - selectedStashHits.length));
  const selectedRefs = new Set(selectedStashHits.map((hit) => hit.ref));

  const items = [
    ...(await Promise.all(
      selectedStashHits
        .slice(0, limit)
        .map((hit) => enrichCuratedStashHit(query, hit, supportRefsByRef.get(hit.ref) ?? [], selectedRefs)),
    )),
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

async function enrichCuratedStashHit(
  query: string,
  hit: SourceSearchHit,
  supportRefs: CurateSupportRef[],
  selectedRefs: Set<string>,
): Promise<CuratedStashItem> {
  let shown: ShowResponse | undefined;
  try {
    shown = await akmShowUnified({ ref: hit.ref });
  } catch {
    shown = undefined;
  }

  // #624-P3: when lazy graph extraction is opted in, enqueue an ungraphed
  // asset for a later pass to extract. Fire-and-forget, non-blocking, NO inline
  // extraction and NO LLM call here. Default-off (flag unset) = byte-identical.
  if (shown?.path) maybeEnqueueLazyGraph(shown.path);

  const description = shown?.description ?? hit.description;
  const preview = buildCuratedPreview(shown, hit);
  const mergedSupportRefs = mergeCurateSupportRefs(supportRefs, shown?.related?.hits, selectedRefs, hit.ref);

  return {
    source: "stash",
    type: shown?.type ?? hit.type,
    name: shown?.name ?? hit.name,
    ref: hit.ref,
    ...(description ? { description } : {}),
    ...(preview ? { preview } : {}),
    ...(shown?.keys?.length ? { keys: shown.keys } : {}),
    ...(shown?.parameters?.length ? { parameters: shown.parameters } : {}),
    ...(shown?.run ? { run: shown.run } : {}),
    ...(mergedSupportRefs.length > 0 ? { supportRefs: mergedSupportRefs } : {}),
    followUp: `akm show ${hit.ref}`,
    reason: buildCuratedReason(query, shown?.type ?? hit.type),
    ...(hit.score !== undefined ? { score: hit.score } : {}),
  };
}

/**
 * #624-P3 — enqueue an ungraphed asset for lazy graph extraction when the
 * `index.graph.lazyGraphExtraction` flag is on. Pure side-effect, fully
 * best-effort: any failure (config, fs, db) is swallowed so curate never fails
 * on it. NO LLM call and NO inline extraction — only a cheap queue insert.
 * Default-off (flag unset) returns immediately = byte-identical behavior.
 */
function maybeEnqueueLazyGraph(assetPath: string): void {
  try {
    const config = loadConfig();
    if (getIndexPassConfig(config.index, "graph")?.lazyGraphExtraction !== true) return;

    const sources = resolveSourceEntries();
    const source = findSourceForPath(assetPath, sources);
    const stashRoot = source?.path;
    if (!stashRoot) return;

    let raw: string;
    try {
      raw = fs.readFileSync(assetPath, "utf8");
    } catch {
      return;
    }
    const body = parseFrontmatter(raw).content.trim();
    if (!body) return;
    const bodyHash = computeBodyHash(body);

    withIndexDb(
      (db) => {
        if (!hasGraphData(db, stashRoot, assetPath)) {
          enqueueGraphExtraction(db, stashRoot, assetPath, bodyHash, 0);
        }
      },
      { busyTimeoutMs: TELEMETRY_BUSY_TIMEOUT_MS },
    );
  } catch (err) {
    rethrowIfTestIsolationError(err);
  }
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

export function deriveCurateFallbackQueries(query: string): string[] {
  const normalizedWhole = query
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  const tokens = Array.from(
    new Set(
      query
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .map((token) => token.trim())
        .filter(
          (token) =>
            token.length > 0 &&
            !CURATE_FALLBACK_FILTER_WORDS.has(token) &&
            (token.length >= MIN_CURATE_FALLBACK_TOKEN_LENGTH || CURATE_SHORT_FALLBACK_TOKENS.has(token)),
        ),
    ),
  ).slice(0, MAX_CURATE_FALLBACK_KEYWORDS);
  if (tokens.length === 1 && tokens[0] === normalizedWhole) return [];
  return tokens;
}

export function mergeCurateSearchResponses(base: SearchResponse, extras: SearchResponse[]): SearchResponse {
  // The base (full-query) ranking is the relevance signal — keyword fallback
  // searches exist only to ADD recall when that ranking is thin, never to
  // re-rank it. So we PRESERVE base order and APPEND fallback-only hits below
  // it. A single-token fallback match on an exact title/path normalizes to a
  // high FTS score, but those scores are not comparable to the full-query
  // (hybrid) scores; re-sorting the union by raw score (the prior behaviour)
  // let that keyword junk leapfrog the contextually-relevant full-query hits.
  // Dup refs (present in both base and a fallback) keep their base POSITION but
  // take the MAX score, since matching both the full query and a key term is a
  // stronger relevance signal for the downstream score floor.
  const bestExtraStashScore = new Map<string, number>();
  for (const result of extras) {
    for (const hit of result.hits.filter((entry): entry is SourceSearchHit => entry.type !== "registry")) {
      const prev = bestExtraStashScore.get(hit.ref);
      if (prev === undefined || (hit.score ?? 0) > prev) bestExtraStashScore.set(hit.ref, hit.score ?? 0);
    }
  }
  const baseRefs = new Set<string>();
  const baseStash: SourceSearchHit[] = [];
  for (const hit of base.hits.filter((entry): entry is SourceSearchHit => entry.type !== "registry")) {
    baseRefs.add(hit.ref);
    const extraScore = bestExtraStashScore.get(hit.ref);
    baseStash.push(extraScore !== undefined && extraScore > (hit.score ?? 0) ? { ...hit, score: extraScore } : hit);
  }
  const extraOnly = new Map<string, SourceSearchHit>();
  for (const result of extras) {
    for (const hit of result.hits.filter((entry): entry is SourceSearchHit => entry.type !== "registry")) {
      if (baseRefs.has(hit.ref)) continue;
      const existing = extraOnly.get(hit.ref);
      if (!existing || (hit.score ?? 0) > (existing.score ?? 0)) extraOnly.set(hit.ref, hit);
    }
  }
  // Fallback-only hits must rank BELOW every full-query hit through the rest of
  // the pipeline. The downstream selector (`selectCuratedStashHits`) RE-SORTS by
  // score and derives its relevance floor from the top score, so preserving
  // order here is not enough — a single-token FTS match (normalized ~0.9) would
  // otherwise become the leader and evict the contextual full-query memories.
  // We therefore restamp fallback-only scores into a band strictly below the
  // minimum base score (keeping their own relative order). When there are no
  // base hits, fallback IS the result, so scores are kept as-is.
  const sortedExtra = [...extraOnly.values()].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const minBaseScore = baseStash.length
    ? Math.min(...baseStash.map((hit) => hit.score ?? 0))
    : Number.POSITIVE_INFINITY;
  const cappedExtra = baseStash.length
    ? sortedExtra.map((hit, i) => ({ ...hit, score: minBaseScore - 1e-6 * (i + 1) }))
    : sortedExtra;
  const mergedHits = [...baseStash, ...cappedExtra];

  // Registry hits are supplemental fill — same rule: base first (max score on
  // dups), then fallback-only registry hits appended by score.
  const bestExtraRegScore = new Map<string, number>();
  for (const result of extras) {
    for (const hit of result.registryHits ?? []) {
      const prev = bestExtraRegScore.get(hit.id);
      if (prev === undefined || (hit.score ?? 0) > prev) bestExtraRegScore.set(hit.id, hit.score ?? 0);
    }
  }
  const baseRegIds = new Set<string>();
  const baseReg: RegistrySearchResultHit[] = [];
  for (const hit of base.registryHits ?? []) {
    baseRegIds.add(hit.id);
    const extraScore = bestExtraRegScore.get(hit.id);
    baseReg.push(extraScore !== undefined && extraScore > (hit.score ?? 0) ? { ...hit, score: extraScore } : hit);
  }
  const extraRegOnly = new Map<string, RegistrySearchResultHit>();
  for (const result of extras) {
    for (const hit of result.registryHits ?? []) {
      if (baseRegIds.has(hit.id)) continue;
      const existing = extraRegOnly.get(hit.id);
      if (!existing || (hit.score ?? 0) > (existing.score ?? 0)) extraRegOnly.set(hit.id, hit);
    }
  }

  const warnings = Array.from(
    new Set([...(base.warnings ?? []), ...extras.flatMap((result) => result.warnings ?? [])]),
  );
  const mergedRegistryHits = [
    ...baseReg,
    ...[...extraRegOnly.values()].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)),
  ];

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
  const initial = await akmSearch({ ...input, skipLogging: true });
  if (!shouldRunCurateFallback(initial, input.limit)) return initial;

  const fallbackQueries = deriveCurateFallbackQueries(input.query);
  if (fallbackQueries.length === 0) return initial;

  const fallbackResults = await Promise.all(
    fallbackQueries.map((token) =>
      akmSearch({
        query: token,
        type: input.type,
        limit: input.limit,
        source: input.source,
        skipLogging: true,
      }),
    ),
  );
  return mergeCurateSearchResponses(initial, fallbackResults);
}

function parseCurateIntent(query: string): CurateIntent {
  const lower = query.toLowerCase();
  return {
    executionHeavy: /(run|script|bash|shell|cli|execute|automation|deploy|build|test|lint)/.test(lower),
    multiStep: /(plan|workflow|steps?|procedure|rollout|review|migration|release|checklist)/.test(lower),
    delegation: /(agent|assistant|planner|reviewer|architect|prompt)/.test(lower),
    recall: /(memory|context|recall|remember)/.test(lower),
    reference: CURATE_REFERENCE_QUERY_RE.test(lower),
  };
}

function computeCurateTypeNudge(type: string, intent: CurateIntent): number {
  let nudge = 0;
  if (intent.executionHeavy) {
    if (type === "script") nudge += 0.06;
    else if (type === "command") nudge += 0.04;
    else if (type === "memory") nudge -= 0.04;
  }
  if (intent.multiStep) {
    if (type === "workflow") nudge += 0.06;
    else if (type === "skill") nudge += 0.04;
    else if (type === "knowledge") nudge -= 0.02;
  }
  if (intent.delegation && type === "agent") nudge += 0.06;
  if (intent.recall && type === "memory") nudge += 0.08;
  if (intent.reference) {
    if (type === "knowledge") nudge += 0.05;
    else if (type === "skill") nudge += 0.02;
  }
  return nudge;
}

function getCurateFamily(ref: string): CurateFamily | undefined {
  try {
    // F4b: `ref` is a search-hit ref in the 0.9.0 conceptId grammar — parse via
    // the new-grammar `parseRefInput` so skill/reference family grouping still
    // recognizes it.
    const parsed = parseRefInput(ref);
    if (parsed.type === "skill") {
      return { key: parsed.name, role: "root" };
    }
    if (parsed.type !== "knowledge") return undefined;
    const match = /^skills\/(.+?)\/references\/(.+)$/.exec(parsed.name);
    if (!match) return undefined;
    return {
      key: match[1],
      role: "reference",
      topicTokens: match[2]
        .split(/[^a-z0-9]+/i)
        .map((token) => token.trim().toLowerCase())
        .filter(Boolean),
    };
  } catch {
    return undefined;
  }
}

function annotateCurateHit(
  query: string,
  hit: SourceSearchHit,
  index: number,
  intent: CurateIntent,
): AnnotatedCurateHit {
  const rawScore = hit.score ?? 0;
  const family = getCurateFamily(hit.ref);
  let adjustedScore = rawScore + computeCurateTypeNudge(hit.type, intent);
  if (family?.role === "root" && !isNarrowReferenceFamilyQuery(query, family)) adjustedScore += 0.07;
  if (family?.role === "reference" && isNarrowReferenceFamilyQuery(query, family)) adjustedScore += 0.07;
  return {
    hit,
    rawScore,
    adjustedScore,
    originalIndex: index,
    family,
  };
}

function compareCurateHits(a: AnnotatedCurateHit, b: AnnotatedCurateHit): number {
  const rawDiff = b.rawScore - a.rawScore;
  if (Math.abs(rawDiff) > CURATE_CLOSE_SCORE_BAND) return rawDiff;

  const adjustedDiff = b.adjustedScore - a.adjustedScore;
  if (adjustedDiff !== 0) return adjustedDiff;
  if (rawDiff !== 0) return rawDiff;
  return a.originalIndex - b.originalIndex;
}

function passesCurateScoreFloor(hit: AnnotatedCurateHit, leaderScore: number | undefined): boolean {
  if (leaderScore === undefined) return true;
  return hit.rawScore >= Math.max(CURATE_TAIL_SCORE_FLOOR, leaderScore * CURATE_RELATIVE_SCORE_FLOOR);
}

function isNarrowReferenceFamilyQuery(query: string, family: CurateFamily | undefined): boolean {
  if (!family || family.role !== "reference") return false;
  const lower = query.toLowerCase();
  if (CURATE_REFERENCE_QUERY_RE.test(lower)) return true;
  return family.topicTokens.some((token) => token.length >= 3 && lower.includes(token));
}

function appendCurateSupportRef(
  supportRefsByRef: Map<string, CurateSupportRef[]>,
  ownerRef: string,
  supportRef: CurateSupportRef,
): void {
  const existing = supportRefsByRef.get(ownerRef) ?? [];
  if (existing.some((entry) => entry.ref === supportRef.ref)) return;
  supportRefsByRef.set(ownerRef, [...existing, supportRef]);
}

function selectCuratedStashHits(
  query: string,
  hits: SourceSearchHit[],
  limit: number,
): { selected: SourceSearchHit[]; supportRefsByRef: Map<string, CurateSupportRef[]> } {
  const intent = parseCurateIntent(query);
  const collapsed = collapseCurateFamilies(query, hits);
  const ranked = collapsed.hits
    .map(({ hit, originalIndex }) => annotateCurateHit(query, hit, originalIndex, intent))
    .sort(compareCurateHits);
  const selected: AnnotatedCurateHit[] = [];
  const supportRefsByRef = collapsed.supportRefsByRef;
  let leaderScore: number | undefined;

  for (const candidate of ranked) {
    if (!passesCurateScoreFloor(candidate, leaderScore)) continue;

    selected.push(candidate);
    if (leaderScore === undefined) leaderScore = candidate.rawScore;
    if (selected.length >= limit) break;
  }

  return { selected: selected.map((entry) => entry.hit), supportRefsByRef };
}

function collapseCurateFamilies(
  query: string,
  hits: SourceSearchHit[],
): { hits: CollapsedCurateHit[]; supportRefsByRef: Map<string, CurateSupportRef[]> } {
  const passthrough: CollapsedCurateHit[] = [];
  const supportRefsByRef = new Map<string, CurateSupportRef[]>();
  const groups = new Map<
    string,
    {
      root?: CollapsedCurateHit;
      references: CollapsedCurateHit[];
    }
  >();

  for (const [index, hit] of hits.entries()) {
    const family = getCurateFamily(hit.ref);
    if (!family) {
      passthrough.push({ hit, originalIndex: index });
      continue;
    }
    const group = groups.get(family.key) ?? { references: [] };
    if (family.role === "root") {
      if (!group.root) group.root = { hit, originalIndex: index };
    } else {
      group.references.push({ hit, originalIndex: index });
    }
    groups.set(family.key, group);
  }

  const collapsedFamilies: CollapsedCurateHit[] = [];
  for (const group of groups.values()) {
    const bestReference = group.references[0];
    const representative =
      group.root && !isNarrowReferenceFamilyQuery(query, getCurateFamily(bestReference?.hit.ref ?? group.root.hit.ref))
        ? group.root
        : (bestReference ?? group.root);
    if (!representative) continue;

    collapsedFamilies.push(representative);
    const supportCandidates = [group.root, ...group.references].filter((entry): entry is CollapsedCurateHit => {
      return entry !== undefined && entry.hit.ref !== representative.hit.ref;
    });
    for (const support of supportCandidates) {
      appendCurateSupportRef(supportRefsByRef, representative.hit.ref, {
        ref: support.hit.ref,
        type: support.hit.type,
        reason: "Related family asset to inspect next.",
      });
    }
  }

  return {
    hits: [...passthrough, ...collapsedFamilies].sort((a, b) => a.originalIndex - b.originalIndex),
    supportRefsByRef,
  };
}

function preferBroadRootRepresentative(
  query: string,
  selected: SourceSearchHit[],
  allHits: SourceSearchHit[],
  supportRefsByRef: Map<string, CurateSupportRef[]>,
): { selected: SourceSearchHit[]; supportRefsByRef: Map<string, CurateSupportRef[]> } {
  const first = selected[0];
  if (!first) return { selected, supportRefsByRef };

  const match = /^knowledge:skills\/(.+?)\/references\/(.+)$/.exec(first.ref);
  if (!match) return { selected, supportRefsByRef };

  const lower = query.toLowerCase();
  const topicTokens = match[2].split(/[^a-z0-9]+/i).filter(Boolean);
  const wantsReference =
    CURATE_REFERENCE_QUERY_RE.test(lower) ||
    topicTokens.some((token) => token.length >= 3 && lower.includes(token.toLowerCase()));
  if (wantsReference) return { selected, supportRefsByRef };

  const rootRef = `skill:${match[1]}`;
  const rootHit = allHits.find((hit) => hit.ref === rootRef);
  if (!rootHit) return { selected, supportRefsByRef };

  const next = [rootHit, ...selected.filter((hit) => hit.ref !== first.ref && hit.ref !== rootRef)];
  const merged = new Map(supportRefsByRef);
  const priorSupport = merged.get(first.ref) ?? [];
  for (const entry of priorSupport) appendCurateSupportRef(merged, rootRef, entry);
  appendCurateSupportRef(merged, rootRef, {
    ref: first.ref,
    type: first.type,
    reason: "Related family asset to inspect next.",
  });
  merged.delete(first.ref);

  return { selected: next, supportRefsByRef: merged };
}

function mergeCurateSupportRefs(
  seeded: CurateSupportRef[],
  relatedHits:
    | Array<{ ref?: string; path: string; type: string; sharedEntities: string[]; relationCount: number }>
    | undefined,
  selectedRefs: Set<string>,
  ownerRef: string,
): CurateSupportRef[] {
  const merged: CurateSupportRef[] = [];
  for (const entry of seeded) {
    if (entry.ref === ownerRef || selectedRefs.has(entry.ref)) continue;
    if (merged.some((existing) => existing.ref === entry.ref)) continue;
    merged.push(entry);
    if (merged.length >= MAX_CURATE_SUPPORT_REFS) return merged;
  }

  if (!Array.isArray(relatedHits)) return merged;
  for (const hit of relatedHits) {
    if (!hit.ref || hit.ref === ownerRef || selectedRefs.has(hit.ref)) continue;
    if (merged.some((existing) => existing.ref === hit.ref)) continue;
    merged.push({ ref: hit.ref, type: hit.type, reason: "Related asset via shared entities." });
    if (merged.length >= MAX_CURATE_SUPPORT_REFS) break;
  }
  return merged;
}

function shouldRunCurateFallback(initial: SearchResponse, desiredCount: number): boolean {
  const stashHits = initial.hits.filter((hit): hit is SourceSearchHit => hit.type !== "registry");
  if (stashHits.length === 0) return true;

  const topScore = stashHits[0]?.score ?? 0;
  const strongFloor = Math.max(CURATE_FALLBACK_STRONG_SCORE_FLOOR, topScore * CURATE_RELATIVE_SCORE_FLOOR);
  const strongCount = stashHits.filter((hit) => (hit.score ?? 0) >= strongFloor).length;
  return !(topScore >= CURATE_FALLBACK_TOP_SCORE_THRESHOLD && strongCount >= Math.min(2, desiredCount));
}
