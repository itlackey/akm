// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * LLM metadata-enrichment pass, restored on the reconcile path
 * (docs/plans/index-redesign-contract.md, B5e).
 *
 * Before the index redesign, `akm index` ran a config-driven metadata
 * enhancement pass over every "generated"-quality entry, keyed by a
 * `(assetRef, cacheVariant)` cache row whose `body_hash` column happened to
 * gate freshness. The reconcile rewrite (`reconcile.ts`, B1) dropped the
 * call site along with the rest of the old phase pipeline. This module
 * restores the feature on the NEW path, content-addressed throughout:
 * `reconcileRoots` collects one {@link MetadataEnrichmentCandidate} per file
 * it just upserted (added or changed) and hands the batch to
 * {@link enrichReconciledEntries} once, AFTER every per-file transaction in
 * this run has already committed — a provider call must never run inside
 * `applyChange`'s `BEGIN IMMEDIATE` transaction (docs/plans/index-redesign.md
 * rule 5: every index write stays a short, idempotent transaction; an LLM
 * call can take seconds to minutes and must not hold one open).
 *
 * **Content-addressed cache** — `llm_enrichment_cache` (still shared with
 * graph-extraction and memory-inference, which key it by absolute file path)
 * is used here with `asset_ref = body_hash = candidate.blobHash`: the cache
 * row IS the content address, so a cache hit means "this exact byte content
 * has already been enriched" regardless of which entry or how many entries
 * currently carry it, and a rename or an unrelated field edit elsewhere in
 * the same file never invalidates it. `withLlmCache` (`./db/llm-cache.ts`)
 * already implements exactly this hash-gated lookup/call/write shape, so this
 * module reuses it rather than duplicating the pattern a third time.
 *
 * **Fail-soft** — `enhanceMetadata`'s `EnhanceMetadataOutcome` distinguishes
 * `enriched` (real success — cache it) from `skipped` (feature gate closed)
 * and `failed` (provider/network error): `withLlmCache`'s "only cache a
 * defined result" contract means a `skipped`/`failed` outcome (mapped to
 * `undefined` below) writes no cache row and leaves the entry's `quality`
 * untouched, so a transient provider outage can never poison an entry into a
 * permanent enrichment skip.
 *
 * **`--full` re-applies without a new provider call** — `reconcileRoots`'s
 * `forceReparse` re-parses every file, so an unchanged file's fresh
 * `IndexDocument` is `quality: "generated"` again (enrichment only ever
 * updated the DB row, never the source file) and becomes an enrichment
 * candidate again on every `--full` run. Its `blobHash` is unchanged, so the
 * content-addressed cache lookup above hits and re-applies the SAME cached
 * fields with no new provider call — this falls out of content-addressing
 * for free and needs no `--full`-specific branch here.
 */

import fs from "node:fs";
import { concurrentMap } from "../core/concurrent";
import type { AkmConfig } from "../core/config/config";
import { ConfigError } from "../core/errors";
import { defaultConcurrencyForEndpoint } from "../core/loopback";
import { withImmediateTransaction } from "../core/state-db";
import { warn } from "../core/warn";
import { resolveIndexPassExecution } from "../llm/index-passes";
import { type EnhancedMetadata, enhanceMetadata } from "../llm/metadata-enhance";
import type { StructuredLlmRunner } from "../llm/structured-call";
import type { Database } from "../storage/database";
import { insertNewUnitTexts } from "../storage/repositories/files-repository";
import { upsertEntry } from "../storage/repositories/index-entries-repository";
import type { EntryProvenance } from "../storage/repositories/index-entry-types";
import { replaceEntryUnits } from "../storage/repositories/units-repository";
import { withLlmCache } from "./db/llm-cache";
import {
  getMarkdownFragmentContent,
  hasMarkdownFragmentContent,
  type IndexDocument,
  isEnrichmentComplete,
  setMarkdownFragmentContent,
} from "./passes/metadata";
import { buildSearchText } from "./search/search-fields";
import { deriveUnits, toUnitSource } from "./units/unit";

/**
 * Namespaces this pass's `llm_enrichment_cache` rows away from
 * graph-extraction's and memory-inference's own `cacheVariant` values, which
 * key the SAME shared table by absolute file path rather than content hash.
 */
const METADATA_ENRICHMENT_CACHE_VARIANT = "metadata-enhance-v1";

/** One file `reconcileRoots` just upserted (added or changed), eligible for enrichment consideration. */
export interface MetadataEnrichmentCandidate {
  entryId: number;
  /** The file's content hash (`entries.content_hash`) — the enrichment cache key. */
  blobHash: string;
  /**
   * The exact `IndexDocument` `applyChange` just wrote (fragment-tagged via
   * `setMarkdownFragmentContent` when the akm adapter produced one) —
   * carried through rather than re-read from `entries`, both to avoid a
   * redundant query and because `hasMarkdownFragmentContent`/
   * `getMarkdownFragmentContent` key off object identity: a JSON-round-
   * tripped copy would silently look fragment-less to `toUnitSource`.
   */
  entry: IndexDocument;
  filePath: string;
  provenance: EntryProvenance;
}

export interface MetadataEnrichmentCounts {
  /** Eligible candidates (quality "generated", not already complete) this pass considered. */
  attempted: number;
  /** Of those, how many resolved from a content-addressed cache hit (no provider call). */
  cacheHits: number;
  /** Of those, how many now carry `quality: "enriched"` (cache hit or a genuine provider success). */
  enriched: number;
  /** Provider/network failures — fail-soft: entry and cache both left untouched. */
  failed: number;
  /** The `metadata_enhance` feature gate was closed for this call. */
  skipped: number;
}

function emptyCounts(): MetadataEnrichmentCounts {
  return { attempted: 0, cacheHits: 0, enriched: 0, failed: 0, skipped: 0 };
}

/** Only "generated"-quality entries missing description/tags/searchHints are worth an LLM call — see `isEnrichmentComplete`. */
function isEligibleForEnrichment(entry: IndexDocument): boolean {
  return entry.quality === "generated" && !isEnrichmentComplete(entry);
}

/**
 * Bounded-pool width for this pass — kept as a direct call to the shared
 * classifier (not `indexer.ts`'s `getDefaultLlmConcurrency` wrapper) to avoid
 * an indexer.ts → enrich.ts → indexer.ts import cycle, exactly like
 * `src/llm/embedders/remote.ts`'s `resolveEmbeddingConcurrency` — see that
 * function's neighboring comment. `tests/indexer/llm-concurrency-default.test.ts`
 * pins `getDefaultLlmConcurrency`'s behavior; this mirrors it exactly.
 */
function resolveEnrichmentConcurrency(connection: StructuredLlmRunner["connection"]): number {
  if (typeof connection?.concurrency === "number") return connection.concurrency;
  return defaultConcurrencyForEndpoint(connection?.endpoint);
}

/**
 * Run the metadata-enrichment pass over every eligible candidate
 * `reconcileRoots` collected this run, with a bounded concurrency pool
 * (`resolveEnrichmentConcurrency`). Only called when
 * `resolveIndexPassExecution("enrichment", config)` resolves a runner — an
 * unconfigured engine, or `index.enrichment.enabled: false`, is a no-op with
 * zero cache reads and zero provider calls. The separate `metadata_enhance`
 * feature gate (`index.metadataEnhance.enabled`, default `false`) is checked
 * per-call inside `enhanceMetadata` itself, so a closed gate still shows up
 * here as a cheap `skipped` outcome rather than being special-cased twice.
 *
 * A `ConfigError` (a required symbolic credential that resolved to nothing)
 * is not fail-soft like a provider error — `enhanceMetadata` lets it escape
 * `tryLlmFeature`'s normal fallback (`llm/structured-call.ts`'s
 * `callStructured`) precisely so a genuinely broken config surfaces loudly
 * instead of reading as an ordinary per-entry failure. `concurrentMap`
 * itself swallows a thrown callback into an `undefined` slot, so this
 * catches it per-candidate and rethrows the first occurrence once every
 * in-flight candidate has settled.
 */
export async function enrichReconciledEntries(
  db: Database,
  config: AkmConfig,
  candidates: readonly MetadataEnrichmentCandidate[],
  maxChars: number,
  opts?: { signal?: AbortSignal; onProgress?: (line: string) => void },
): Promise<MetadataEnrichmentCounts> {
  const counts = emptyCounts();
  const eligible = candidates.filter((candidate) => isEligibleForEnrichment(candidate.entry));
  if (eligible.length === 0) return counts;

  const runner = resolveIndexPassExecution("enrichment", config).runner;
  if (!runner) return counts;

  const concurrency = resolveEnrichmentConcurrency(runner.connection);
  opts?.onProgress?.(
    `Metadata enrichment starting for ${eligible.length} entr${eligible.length === 1 ? "y" : "ies"} (concurrency ${concurrency}).`,
  );

  let configFailure: ConfigError | undefined;
  await concurrentMap(
    eligible,
    async (candidate) => {
      if (opts?.signal?.aborted) return;
      counts.attempted++;
      try {
        await enrichOneCandidate(db, runner, config, candidate, maxChars, counts, opts?.signal);
      } catch (err) {
        if (err instanceof ConfigError) {
          configFailure ??= err;
          return;
        }
        throw err;
      }
    },
    concurrency,
  );
  if (configFailure) throw configFailure;

  opts?.onProgress?.(
    `Metadata enrichment finished: ${counts.enriched} enriched (${counts.cacheHits} from cache), ` +
      `${counts.failed} failed, ${counts.skipped} skipped.`,
  );
  if (counts.failed > 0 && counts.enriched === 0 && counts.skipped === 0) {
    warn(
      `LLM metadata enrichment failed for all ${counts.failed} attempted entr${counts.failed === 1 ? "y" : "ies"} — ` +
        "index built without enrichment. Check the engine selected by index.enrichment.engine (or defaults.llmEngine).",
    );
  }
  return counts;
}

async function enrichOneCandidate(
  db: Database,
  runner: StructuredLlmRunner,
  config: AkmConfig,
  candidate: MetadataEnrichmentCandidate,
  maxChars: number,
  counts: MetadataEnrichmentCounts,
  signal?: AbortSignal,
): Promise<void> {
  let sawOutcome: "failed" | "skipped" | undefined;
  let cacheHit = false;
  const metadata = await withLlmCache<EnhancedMetadata>(
    db,
    candidate.blobHash,
    "",
    false,
    async () => {
      let fileContent: string | undefined;
      try {
        fileContent = fs.readFileSync(candidate.filePath, "utf8");
      } catch {
        // Best-effort context for the prompt only — enhanceMetadata still
        // runs (with less context) when the file cannot be re-read.
      }
      const outcome = await enhanceMetadata(runner, candidate.entry, fileContent, signal, config);
      if (outcome.status !== "enriched") {
        sawOutcome = outcome.status;
        return undefined;
      }
      return outcome.metadata;
    },
    (raw) => (raw !== null && typeof raw === "object" ? (raw as EnhancedMetadata) : undefined),
    candidate.blobHash,
    METADATA_ENRICHMENT_CACHE_VARIANT,
    { onCacheHit: () => (cacheHit = true) },
  );

  if (metadata === undefined) {
    if (sawOutcome === "failed") counts.failed++;
    else counts.skipped++;
    return;
  }
  if (cacheHit) counts.cacheHits++;
  counts.enriched++;
  applyEnrichmentToEntry(db, candidate, maxChars, metadata);
}

/**
 * Merge enrichment fields onto the candidate's entry, re-derive its units,
 * and write both through the SAME canonical entry/FTS mutation and
 * `unit_texts`/`entry_units` maintenance `applyChange` (`reconcile.ts`) uses
 * — one short `BEGIN IMMEDIATE` transaction, no `content_hash` argument so
 * `upsertEntry`'s `COALESCE` preserves the scan-derived blob hash untouched.
 *
 * Fragment units are unaffected: only `description`/`tags`/`searchHints`
 * change, which feeds solely unit ordinal 0 (`structuredFieldsText`,
 * `units/unit.ts`); `replaceEntryUnits` is still a full delete-then-insert
 * for the entry, so `getMarkdownFragmentContent`/`setMarkdownFragmentContent`
 * re-tag the merged copy — otherwise `deriveUnits` would see no markdown
 * body at all and silently drop every fragment unit `applyChange` already
 * derived for this entry.
 */
function applyEnrichmentToEntry(
  db: Database,
  candidate: MetadataEnrichmentCandidate,
  maxChars: number,
  metadata: EnhancedMetadata,
): void {
  const merged: IndexDocument = { ...candidate.entry, quality: "enriched" };
  if (metadata.description) merged.description = metadata.description;
  if (metadata.tags?.length) merged.tags = metadata.tags;
  if (metadata.searchHints?.length) merged.searchHints = metadata.searchHints;
  if (hasMarkdownFragmentContent(candidate.entry)) {
    setMarkdownFragmentContent(merged, getMarkdownFragmentContent(candidate.entry));
  }
  const searchText = buildSearchText(merged);

  withImmediateTransaction(db, () => {
    upsertEntry(db, candidate.filePath, merged, searchText, candidate.provenance);
    const units = deriveUnits(toUnitSource(candidate.entryId, merged), maxChars);
    insertNewUnitTexts(
      db,
      units.map((unit) => ({ hash: unit.hash, kind: unit.fragmentId === null ? "card" : "fragment", text: unit.text })),
    );
    replaceEntryUnits(
      db,
      candidate.entryId,
      units.map((unit) => ({ ordinal: unit.ordinal, fragmentId: unit.fragmentId, hash: unit.hash })),
    );
  });
}
