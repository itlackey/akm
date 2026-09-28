// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Leaf types for the persisted graph artifact (see
 * `indexer/graph/graph-extraction.ts`, `indexer/db/graph-db.ts`).
 *
 * Split out of `graph-extraction.ts` so that `indexer/db/graph-db.ts` — the
 * SQLite-backed store, which `graph-extraction.ts` imports
 * `loadStoredGraphSnapshot`/`replaceStoredGraph` from
 * by value — does not need to import back into `graph-extraction.ts` (the
 * orchestrator) just for these shapes. That back-edge was a static-graph
 * cycle even though it was type-only (chunk 9 WI-9.8 KILL 5 sever): the
 * store must not depend on the orchestrator. `graph-extraction.ts`
 * owns these shared graph shapes without importing the extraction orchestrator.
 */

import type { GraphExtractionReason, GraphExtractionStatus, GraphRelation } from "../../llm/graph-extract";

/** One node in the graph — corresponds to a single asset file. */
export interface GraphFileNode {
  /** Absolute path on disk. */
  path: string;
  /** Asset type (`memory` or `knowledge`). */
  type: string;
  /** SHA-256 hash of the parsed markdown body used for staleness checks. */
  bodyHash?: string;
  /** Entities surfaced by the LLM for this file. */
  entities: string[];
  /** Relations the LLM surfaced from this file's body. */
  relations: GraphRelation[];
  /** Optional extraction confidence score in [0,1]. */
  confidence?: number;
  /** Extraction outcome for this file. */
  status?: GraphExtractionStatus;
  /** Empty/failure reason for this file. */
  reason?: GraphExtractionReason;
  /** Run id that most recently updated this file. */
  extractionRunId?: string;
}

export interface GraphExtractionTelemetry {
  extractorId?: string;
  extractionRunId?: string;
  model?: string;
  promptVersion?: string;
  batchSize?: number;
  cacheHits: number;
  cacheMisses: number;
  truncationCount: number;
  failureCount: number;
  /**
   * Asset extractions where the provider returned an HTML body (e.g. LM Studio
   * serving its web UI) instead of JSON. Tracked distinctly from
   * `failureCount` so a provider-load failure is observable in health output
   * rather than folded into the generic failure count (#497).
   */
  htmlErrorCount?: number;
  /** Count of single bounded retries triggered for transient LLM failures. */
  retryAttempts: number;
  /**
   * Batch graph-extraction calls whose response was not a JSON array even
   * after the one stricter-reprompt retry — each one cost a wasted batch call
   * plus a per-asset fallback. Surfaced so a rising batch-fallback rate is
   * observable instead of silent (#635).
   */
  nonArrayBatchFailures?: number;
  /**
   * Chunks skipped because an asset's body exceeded
   * `processes.graphExtraction.maxChunksPerAsset` (R12b + R20) — coverage
   * loss from the per-asset chunk cap, tracked distinctly from
   * `truncationCount` (hard splits within a kept chunk).
   */
  truncatedChunks?: number;
  /**
   * Set when the run stopped early because the failure rate crossed the
   * threshold (R2) — the eligible set was only partially processed; files not
   * yet attempted were left untouched rather than written as empty/failed.
   */
  aborted?: boolean;
}

/** Persisted graph shape loaded from SQLite. */
export interface GraphFile {
  /** ISO-8601 timestamp of the last refresh. */
  generatedAt: string;
  /** Stash root the file was extracted from (canonicalised). */
  stashRoot: string;
  /** Per-file extraction results. */
  files: GraphFileNode[];
  /** Distinct entity names across all files (loaded snapshots only). */
  entities?: string[];
  /** Every file's relations (loaded snapshots only). */
  relations?: GraphRelation[];
  /** The stored counts from `graph_meta` (loaded snapshots only; a write derives them from the rows). */
  quality?: GraphQualityTelemetry;
  /** Durable latest-run extraction telemetry. */
  telemetry?: GraphExtractionTelemetry;
}

/**
 * The `graph_meta` counts. Every field is derived from the rows stored for one
 * stash root (`readStoredGraphQuality` in `../db/graph-db.ts`), so the counts
 * always describe what the graph tables hold.
 */
export interface GraphQualityTelemetry {
  /** Stored graph files: every extraction outcome kept for the root, with or without entities. */
  consideredFiles: number;
  /** Stored graph files with at least one entity row. */
  extractedFiles: number;
  /** Distinct entities in the stored rows, case-folded. */
  entityCount: number;
  /** Distinct relations in the stored rows, keyed on case-folded endpoints and type. */
  relationCount: number;
  /** `extractedFiles / consideredFiles`. */
  extractionCoverage: number;
  /** Undirected graph density: `relationCount` over the possible pairs of `entityCount` entities. */
  density: number;
}
