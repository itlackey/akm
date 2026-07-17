// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Leaf types for the persisted graph artifact (see
 * `indexer/graph/graph-extraction.ts`, `indexer/db/graph-db.ts`).
 *
 * Split out of `graph-extraction.ts` so that `indexer/db/graph-db.ts` — the
 * SQLite-backed store, which `graph-extraction.ts` imports
 * `drainExtractionQueue`/`loadStoredGraphSnapshot`/`replaceStoredGraph` from
 * by value — does not need to import back into `graph-extraction.ts` (the
 * orchestrator) just for these shapes. That back-edge was a static-graph
 * cycle even though it was type-only (chunk 9 WI-9.8 KILL 5 sever): the
 * store must not depend on the orchestrator. `graph-extraction.ts`
 * re-exports these types so existing import sites are unaffected.
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
}

/** Persisted graph shape loaded from SQLite. */
export interface GraphFile {
  schemaVersion: number;
  /** ISO-8601 timestamp of the last refresh. */
  generatedAt: string;
  /** Stash root the file was extracted from (canonicalised). */
  stashRoot: string;
  /** Per-file extraction results. */
  files: GraphFileNode[];
  /** Deduplicated entity list across all files (schema v2+). Canonical casing, first-seen order. */
  entities?: string[];
  /** Deduplicated relation list across all files (schema v2+). Dangling relations excluded. */
  relations?: GraphRelation[];
  /** Graph quality telemetry emitted by the extraction pass. */
  quality?: GraphQualityTelemetry;
  /** Durable latest-run extraction telemetry. */
  telemetry?: GraphExtractionTelemetry;
}

export interface GraphQualityTelemetry {
  /** Eligible files considered by extraction. */
  consideredFiles: number;
  /** Files with at least one extracted entity. */
  extractedFiles: number;
  /** Unique deduplicated entity count in the graph. */
  entityCount: number;
  /** Unique deduplicated relation count in the graph. */
  relationCount: number;
  /** Fraction of eligible files that produced at least one entity. */
  extractionCoverage: number;
  /** Undirected graph density over unique entities/relations. */
  density: number;
}
