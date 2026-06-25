// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * IndexRunContext — shared state threaded through every phase of `akmIndex()`.
 *
 * Extracted from `src/indexer/indexer.ts` so each named phase function
 * (`runSourceCachePhase`, `runMemoryInferencePhase`, …) can receive a single
 * typed argument rather than a long positional parameter list. The context is
 * assembled once at the top of `akmIndex()` and passed to each phase in
 * sequence.
 */

import type { AkmConfig } from "../../core/config/config";
import type { Database } from "../../storage/database";
import type { GraphExtractionResult } from "../graph/graph-extraction";
import type { SearchSource } from "../search/search-source";
import type { SemanticSearchReason, SemanticSearchRuntimeStatus } from "../search/semantic-status";

/** Timing accumulator written by each phase. All values are in milliseconds. */
export interface IndexTiming {
  t0: number;
  tWalkStart: number;
  tWalkEnd: number;
  tLlmEnd: number;
  tFtsEnd: number;
  tEmbedEnd: number;
}

/**
 * Verification of the post-index semantic-search state. Produced by the
 * finalize phase and surfaced to the `akmIndex()` caller via the run context.
 */
export interface IndexVerification {
  ok: boolean;
  message: string;
  guidance?: string;
  semanticSearchEnabled: boolean;
  semanticSearchMode: "off" | "auto";
  semanticStatus: "disabled" | SemanticSearchRuntimeStatus;
  embeddingProvider: "local" | "remote";
  entryCount: number;
  embeddingCount: number;
  vecAvailable: boolean;
}

/** Progress event emitted during indexing. Mirrors IndexProgressEvent in indexer.ts. */
export interface IndexPhaseEvent {
  phase: "summary" | "scan" | "llm" | "fts" | "embeddings" | "verify";
  message: string;
  processed?: number;
  total?: number;
}

/** Shared state passed to every phase of the index run. */
export interface IndexRunContext {
  /** Open SQLite database for the current index run. */
  db: Database;
  /** Resolved AKM configuration. */
  config: AkmConfig;
  /** All resolved stash source entries (primary + additional). */
  sources: SearchSource[];
  /** All source directory paths (derived from `sources`). */
  sourceDirs: string[];
  /** Whether to perform a full rebuild (true) or incremental update (false). */
  full: boolean;
  /** Whether to re-enrich already-enriched entries. */
  reEnrich: boolean;
  /** Primary stash directory. */
  stashDir: string;
  /** Progress emitter (always defined; may be a no-op). */
  onProgress: (event: IndexPhaseEvent) => void;
  /** Abort signal (may be undefined when no cancellation is needed). */
  signal: AbortSignal | undefined;
  /** Timing accumulator — phases fill this in as they complete. */
  timing: IndexTiming;
  /** Whether this run is incremental (false = full rebuild). */
  isIncremental: boolean;
  /** The epoch timestamp for the previous successful build (0 for full). */
  builtAtMs: number;
  /** Whether sources were removed since the last run (triggers orphan cleanup). */
  hadRemovedSources: boolean;

  // ── Inter-phase result accumulation ─────────────────────────────────────────
  // These fields are written by phases and read by later phases or the
  // final summary assembly. They start as undefined / empty until their
  // producing phase completes.

  /** Directories scanned during the walk phase. */
  scannedDirs: number;
  /** Directories skipped during the walk phase. */
  skippedDirs: number;
  /** Total generated metadata entries during the walk phase. */
  generatedCount: number;
  /** Walk-phase warnings (e.g. malformed workflow specs). */
  walkWarnings: string[];
  /** Directories that need LLM enrichment after the walk phase. */
  dirsNeedingLlm: Array<{
    dirPath: string;
    files: string[];
    currentStashDir: string;
    stash: import("../passes/metadata").StashFile;
  }>;
  /** Result from the embedding phase. */
  embeddingResult: {
    success: boolean;
    reason?: SemanticSearchReason;
    message?: string;
  } | null;
  /** Result from the graph extraction phase. */
  graphExtractionResult: GraphExtractionResult | null;

  // ── Finalize-phase results ───────────────────────────────────────────────────
  // Written by `runFinalizePhase` and read back by `akmIndex()` to assemble the
  // response. Undefined until the finalize phase has run.

  /** Semantic-search verification result computed during finalize. */
  verification?: IndexVerification;
  /** Total entry count in the index after finalize. */
  totalEntries?: number;
}
