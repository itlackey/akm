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
 * per-hit enrichment (preview, run and parameters, support refs from the
 * hit's declared links).
 *
 * The exported `akmCurate()` API is the single entry point; tests can also
 * drive `curateSearchResults` with a fixture search response.
 */

import fs from "node:fs";
import { parseBundleRef } from "../../core/asset/asset-ref";
import { parseFrontmatter } from "../../core/asset/frontmatter";
import { UsageError } from "../../core/errors";
import { appendEvent } from "../../core/events";
import { nonTaskInput } from "../../core/non-task-input";
import type { ProjectView } from "../../core/projects";
import { redactCredentialPatterns } from "../../core/redaction";
import { withStateDbTelemetry } from "../../core/state-db";
import { lookupBundleRef } from "../../indexer/indexer";
import { applyCuratedFrontmatter } from "../../indexer/passes/metadata";
import { resolveReadSources } from "../../indexer/read-preflight";
import {
  applyEntryFilters,
  type EntryFilterOptions,
  matchBeliefFilter,
  type ProjectContext,
} from "../../indexer/search/db-search";
import {
  type AttributionProjection,
  copySearchHitAttribution,
  getSearchHitAttribution,
  usageEventAttributionMetadata,
} from "../../indexer/search/search-attribution";
import { insertUsageEvent, type UsageEventSource } from "../../indexer/usage/usage-events";
import { estimateTokenCount } from "../../llm/embedders/remote";
import { truncateDescription } from "../../output/shapes/helpers";
import type {
  RecallOptions,
  RegistrySearchResultHit,
  SearchExecutionMode,
  SearchResponse,
  ShowResponse,
  SourceSearchHit,
} from "../../sources/types";
import { TELEMETRY_BUSY_TIMEOUT_MS, withIndexDb } from "../../storage/repositories/index-db";
import { findEntryIdByRef, getEntryById } from "../../storage/repositories/index-entries-repository";
import {
  akmSearch,
  narrowSourcesToName,
  normalizeScopeFilters,
  parseBeliefFilterMode,
  parseSearchSource,
} from "./search";
import { akmShowUnified } from "./show";

export type CurateSupportRef = {
  ref: string;
  type?: string;
  reason: string;
  beliefState?: string;
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
  reason?: string;
  score?: number;
  beliefState?: string;
};

export type CuratedRegistryItem = {
  source: "registry";
  type: "registry";
  name: string;
  id: string;
  description?: string;
  reason?: string;
  score?: number;
};

export type CuratedItem = CuratedStashItem | CuratedRegistryItem;

export interface CurateResponse {
  query: string;
  summary: string;
  items: CuratedItem[];
  warnings?: string[];
  searchMode?: SearchExecutionMode;
  /** The bundles a repeated `--from` searched; absent for a single `--from`. */
  bundles?: string[];
  /** The project whose defaults applied; absent when none did. */
  project?: ProjectView;
  tip?: string;
}

export interface CurateOptions extends RecallOptions {
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
   * feed usage-events telemetry.
   * Curate's own nested `akmSearch`/`akmShowUnified` calls always pass
   * `skipLogging: true` — this flag additionally silences curate's OWN
   * top-level event.
   */
  skipLogging?: boolean;
  /** Present: only the project's applicable rules are returned (see `akmSearch`). */
  project?: ProjectContext;
}

/** The run's explicit filters, built once in {@link akmCurate} and checked against every hit and link. */
type EvidencePolicy = Omit<EntryFilterOptions, "db">;
const DEFAULT_CURATE_LIMIT = 4;
const MAX_CURATE_SUPPORT_REFS = 2;

/** The durable `bundle//conceptId` ref of the search hit a curated item was built from, for telemetry. */
const durableItemRef = new WeakMap<CuratedItem, string>();

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
    // Each curated item remembers the durable ref of the hit it came from, so
    // no index connection is opened here.
    const perItem = result.items.flatMap((item) => {
      const entryRef = durableItemRef.get(item);
      return entryRef ? [{ entryRef, item }] : [];
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
      for (const { entryRef, item } of perItem) {
        insertUsageEvent(stateDb, {
          event_type: "curate",
          query,
          entry_ref: entryRef,
          metadata: usageEventAttributionMetadata(getSearchHitAttribution(item), entryRef, attributionProjection),
          source: eventSource,
        });
      }
    }, TELEMETRY_BUSY_TIMEOUT_MS);
  } catch {}
}

export async function akmCurate(options: CurateOptions): Promise<CurateResponse> {
  const trimmedQuery = options.query.trim();
  if (!trimmedQuery) {
    throw new UsageError(
      'A curation query is required. Usage: akm curate "<task or prompt>" [--type <type>] [--limit <n>]',
      "MISSING_REQUIRED_ARGUMENT",
    );
  }

  const recall: RecallOptions = {
    source: options.source ?? "local",
    filters: normalizeScopeFilters(options.filters),
    prefer: normalizeScopeFilters(options.prefer),
    belief: parseBeliefFilterMode(options.belief ?? "current"),
  };
  const nonTask = nonTaskInput(trimmedQuery);
  if (nonTask) {
    const abstained: CurateResponse = {
      query: options.query,
      summary: `Curate abstained: the input is ${nonTask}, not a task.`,
      items: [],
      tip: 'Nothing was selected on purpose. To curate for it, pass the task itself: akm curate "<what you are trying to do>". For a literal asset or word lookup, use akm search "<literal words>".',
    };
    if (!options.skipLogging) {
      logCurateEvent(options.query, abstained, options.eventSource, options.attributionProjection);
    }
    return abstained;
  }

  const limit = options.limit && options.limit > 0 ? options.limit : DEFAULT_CURATE_LIMIT;
  const source = options.source ?? parseSearchSource("local");
  const searchResponse =
    options.searchResponse ??
    (await akmSearch({
      query: options.query,
      type: options.type,
      limit,
      source,
      filters: recall.filters,
      prefer: recall.prefer,
      belief: recall.belief,
      project: options.project,
      skipLogging: true,
    }));
  const result = await curateSearchResults(
    options.query,
    searchResponse,
    limit,
    options.type,
    options.eventSource,
    options.searchResponse || source === "registry" ? undefined : evidencePolicy(recall, options.project),
  );
  if (!options.skipLogging) {
    logCurateEvent(options.query, result, options.eventSource, options.attributionProjection);
  }
  return result;
}

function evidencePolicy(recall: RecallOptions, project?: ProjectContext): EvidencePolicy {
  const allSources = resolveReadSources().sources;
  const named =
    recall.source === undefined || recall.source === "local" || recall.source === "all" ? undefined : recall.source;
  return {
    sources: named === undefined ? allSources : narrowSourcesToName(allSources, named),
    restrictToSources: true,
    filters: recall.filters,
    includeProposed: false,
    beliefFilter: recall.belief ?? "current",
    project,
  };
}

/**
 * Whether a ref still satisfies the run's filters, judged on the indexed row
 * with the live file's frontmatter laid over it (scope cleared first, so a
 * scope or belief changed after indexing is not restored from the index). Gives
 * the durable ref to show and the belief state; undefined when the entry or its
 * file is gone or no longer eligible. Callers drop such a hit, never show it
 * unfiltered.
 */
function eligibleEvidence(ref: string, policy: EvidencePolicy): { itemRef: string; beliefState?: string } | undefined {
  return withIndexDb((db) => {
    const id = findEntryIdByRef(db, ref);
    const row = id === undefined ? undefined : getEntryById(db, id);
    if (!row || id === undefined) return undefined;
    let raw: string;
    try {
      raw = fs.readFileSync(row.filePath, "utf8");
    } catch {
      return undefined;
    }
    const entry = { ...row.entry, scope: undefined, frontmatter: undefined };
    applyCuratedFrontmatter(entry, parseFrontmatter(raw).data);
    const kept = applyEntryFilters([{ ...row, id, entry }], { ...policy, db });
    return kept.length > 0 ? { itemRef: row.itemRef, beliefState: entry.beliefState } : undefined;
  });
}

/** `ref`'s fragment, if any, on the durable `itemRef`. */
function withFragmentOf(itemRef: string, ref: string): string {
  const fragment = parseBundleRef(ref).fragment;
  return fragment ? `${itemRef}#${fragment}` : itemRef;
}

export async function curateSearchResults(
  query: string,
  result: SearchResponse,
  limit: number,
  selectedType?: string,
  eventSource?: UsageEventSource,
  policy?: EvidencePolicy,
): Promise<CurateResponse> {
  const allStashHits = result.results.filter((hit): hit is SourceSearchHit => hit.type !== "registry");
  const registryHits = result.registryHits ?? [];

  // F3/R-018: `--type` NARROWS the candidate pool. The caller's search
  // usually applied the filter already, but `curateSearchResults` is also
  // driven directly (tests, `searchResponse` fixtures) with a
  // `SearchResponse` that was never type-filtered.
  const stashHits =
    selectedType && selectedType !== "any" ? allStashHits.filter((hit) => hit.type === selectedType) : allStashHits;

  const selectedStashHits = stashHits.slice(0, limit);

  // F4/R-019: respect `--limit` for registry fill instead of hard-capping it
  // at a bare literal 2 — the remaining slots after stash hits ARE the cap.
  const selectedRegistryHits =
    selectedStashHits.length >= limit ? [] : registryHits.slice(0, limit - selectedStashHits.length);
  const selectedRefs = new Set(selectedStashHits.flatMap((hit) => (hit.itemRef ? [hit.ref, hit.itemRef] : [hit.ref])));

  const items = [
    ...(
      await Promise.all(selectedStashHits.map((hit) => enrichCuratedStashHit(hit, selectedRefs, eventSource, policy)))
    ).filter((item): item is CuratedStashItem => item !== undefined),
    ...selectedRegistryHits.map((hit) => buildCuratedRegistryItem(hit)),
  ].slice(0, limit);
  return {
    query,
    summary: buildCurateSummary(query, items),
    items,
    ...(result.warnings?.length ? { warnings: result.warnings } : {}),
    ...(result.searchMode ? { searchMode: result.searchMode } : {}),
    ...(result.bundles ? { bundles: result.bundles } : {}),
    ...(result.tip ? { tip: result.tip } : {}),
  };
}

export interface PackedCurateItem {
  ref: string;
  tokens: number;
  content: string;
  beliefState?: string;
  reason?: string;
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
 * contract: registry results stay separate/opt-in).
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
    // The items are the ones curate just validated, so they are shown as they are.
    let shown: ShowResponse;
    try {
      shown = await akmShowUnified({ ref: item.ref, skipLogging: true });
    } catch {
      continue;
    }
    const historical = matchBeliefFilter(item.beliefState, "historical");
    const context = {
      ...(item.beliefState ? { beliefState: item.beliefState } : {}),
      ...(historical ? { reason: "Historical context; not current supporting authority." } : {}),
    };
    const content = shown.content ?? shown.template ?? shown.prompt ?? "";
    const tokens = estimateTokenCount(content);

    if (used + tokens <= budgetTokens) {
      packed.push({ ref: item.ref, tokens, content, ...context });
      used += tokens;
      continue;
    }

    if (packed.length === 0) {
      const remaining = budgetTokens - used;
      if (remaining > 0) {
        const truncated = content.slice(0, remaining * 4);
        packed.push({ ref: item.ref, tokens: estimateTokenCount(truncated), content: truncated, ...context });
        used += estimateTokenCount(truncated);
      }
    }
    break;
  }

  return { query: result.query, budget: budgetTokens, tokens: used, items: packed };
}

async function enrichCuratedStashHit(
  hit: SourceSearchHit,
  selectedRefs: Set<string>,
  eventSource?: UsageEventSource,
  policy?: EvidencePolicy,
): Promise<CuratedStashItem | undefined> {
  const evidence = policy ? eligibleEvidence(hit.itemRef ?? hit.ref, policy) : undefined;
  if (policy && !evidence) return undefined;
  let shown: ShowResponse | undefined;
  try {
    shown = await akmShowUnified({
      ref: evidence ? withFragmentOf(evidence.itemRef, hit.ref) : hit.ref,
      eventSource,
      skipLogging: true,
    });
  } catch {
    if (policy) return undefined;
    shown = undefined;
  }
  const beliefState = evidence?.beliefState;

  const ref = shown?.selectedRef ?? shown?.ref ?? hit.ref;
  const description = shown?.description ?? hit.description;
  const preview = buildCuratedPreview(shown, hit);
  const supportRefs = await buildCurateSupportRefs(shown?.links, selectedRefs, ref, policy);

  const item: CuratedStashItem = {
    source: "local",
    type: shown?.type ?? hit.type,
    name: shown?.name ?? hit.name,
    ref,
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
    ...(beliefState ? { beliefState } : {}),
    ...(matchBeliefFilter(beliefState, "historical")
      ? { reason: "Historical context; not current supporting authority." }
      : {}),
    ...(hit.score !== undefined ? { score: hit.score } : {}),
  };
  copySearchHitAttribution(hit, item, item.description);
  const itemRef = evidence?.itemRef ?? hit.itemRef;
  if (itemRef) durableItemRef.set(item, itemRef);
  return item;
}

function buildCuratedRegistryItem(hit: RegistrySearchResultHit): CuratedRegistryItem {
  return {
    source: "registry",
    type: "registry",
    name: hit.name,
    id: hit.id,
    ...(hit.description ? { description: hit.description } : {}),
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

function buildCurateSummary(query: string, items: CuratedItem[]): string {
  if (items.length === 0) {
    return `No curated assets were selected for "${query}".`;
  }
  // F4b: emit the flipped conceptId ref for stash items (registry items have no
  // ref — keep their `registry:<name>` label).
  const labels = items.map((item) => ("ref" in item ? item.ref : `${item.type}:${item.name}`));
  return `Selected ${items.length} curated result${items.length === 1 ? "" : "s"}: ${labels.join(", ")}.`;
}

/**
 * Up to {@link MAX_CURATE_SUPPORT_REFS} assets the hit's declared links (#935)
 * name, not already selected: what the hit links to first, then what links to
 * it, in the order `akm show` lists them. The LLM entity graph's `related`
 * list no longer feeds them.
 */
async function buildCurateSupportRefs(
  links: ShowResponse["links"],
  selectedRefs: Set<string>,
  ownerRef: string,
  policy?: EvidencePolicy,
): Promise<CurateSupportRef[]> {
  const supportRefs: CurateSupportRef[] = [];
  for (const [part, direction] of [
    ["outgoing", "from"],
    ["incoming", "to"],
  ] as const) {
    for (const [kind, group] of Object.entries(links?.[part] ?? {})) {
      for (const ref of group.refs) {
        if (ref === ownerRef || selectedRefs.has(ref) || supportRefs.some((existing) => existing.ref === ref)) continue;
        // A support ref is a link, not a hit: `--type` narrows the hits only. A short link ref
        // is checked on the asset `akm show <ref>` resolves, not another bundle's same conceptId.
        const entry = await lookupBundleRef(parseBundleRef(ref)).catch(() => null);
        const evidence = policy && entry ? eligibleEvidence(entry.itemRef, policy) : undefined;
        if (policy && !evidence) continue;
        const historical = matchBeliefFilter(evidence?.beliefState, "historical");
        const type = entry?.type;
        supportRefs.push({
          ref,
          ...(type ? { type } : {}),
          ...(evidence?.beliefState ? { beliefState: evidence.beliefState } : {}),
          reason: `${historical ? "Historical context; " : ""}Declared link (${kind}) ${direction} this asset.`,
        });
        if (supportRefs.length >= MAX_CURATE_SUPPORT_REFS) return supportRefs;
      }
    }
  }
  return supportRefs;
}
