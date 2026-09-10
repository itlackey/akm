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
import type { LoweringNotice } from "../../execution/resolved-request";
import type { LoweredExecutionDispatchLease } from "../../integrations/agent/execution-lowering";
import type { ResolvedIndexPassExecution } from "../../llm/index-passes";
import type { Database } from "../../storage/database";
import type { SearchSource } from "../search/search-source";

/** Live runtime state of semantic search, computed fresh at index-finalize time. */
export type SemanticSearchRuntimeStatus = "pending" | "ready-js" | "ready-vec" | "blocked";

export type SemanticSearchReason =
  | "missing-package"
  | "local-model-download"
  | "remote-network"
  | "remote-auth"
  | "remote-model"
  | "remote-rate-limit"
  | "db-open"
  | "db-locked"
  | "index-missing"
  | "dimension-mismatch"
  | "onnx-runtime-failed"
  | "native-lib-missing"
  | "permission-denied"
  | "index-failed"
  | "unknown";

/** Timing accumulator written by each phase. All values are in milliseconds. */
export interface IndexTiming {
  t0: number;
  tWalkStart: number;
  tWalkEnd: number;
  tLlmEnd: number;
  tFtsEnd: number;
  tEmbedEnd: number;
  tFinalizeStart: number;
  tFinalizeEnd: number;
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

/** Canonical configured owner that disappeared or moved since the last complete scan. */
export interface RemovedIndexSource {
  bundleId: string;
  sourceRoot: string;
  /** False when the same bundle id remains configured at a different root. */
  removeBundleEntries: boolean;
}

/** Progress event emitted during indexing. Mirrors IndexProgressEvent in indexer.ts. */
export interface IndexPhaseEvent {
  phase: "summary" | "preflight" | "scan" | "llm" | "embeddings" | "fts" | "finalize" | "verify";
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
  /** Frozen standalone metadata-enrichment selection for this invocation. */
  enrichmentExecution: ResolvedIndexPassExecution;
  /** Opaque credential snapshot held for the full metadata mutation scope. */
  enrichmentLease?: LoweredExecutionDispatchLease;
  /** Stable, deduped lowering diagnostics accumulated across enrichment calls. */
  loweringNotices: Array<Readonly<LoweringNotice>>;
  /** All resolved stash source entries (primary + additional). */
  sources: SearchSource[];
  /** All source directory paths (derived from `sources`). */
  sourceDirs: string[];
  /** Whether to perform a full rebuild (true) or incremental update (false). */
  full: boolean;
  /** Whether the explicit post-index missing-file clean pass owns disappearance reporting. */
  clean: boolean;
  /**
   * Whether `akm index --reembed` was passed: force a full purge + re-embed
   * of every entry, bypassing the fingerprint-rename canary entirely (#955).
   */
  reembed: boolean;
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
  /** Prior canonical owners to remove only after every current source scans completely. */
  removedSources: RemovedIndexSource[];
  /** Whether every configured component produced a trustworthy source snapshot. */
  scanComplete: boolean;
  /**
   * Borrowed source-update coordinator transaction, when this run is `akm
   * bundle update`'s deferred embedding phase. When set, the embedding phase
   * is SKIPPED entirely (#954; the ambient-transaction drift guard would
   * reject calling it here anyway) and finalize records semantic state as
   * `"pending"`, never `"ready"` — the coordinator runs the shared
   * `runEmbeddingPass` itself on its own connection AFTER its own commit.
   */
  deferredUpdateTransaction?: {
    db: Database;
    stateSchema: string;
  };

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

  // ── Finalize-phase results ───────────────────────────────────────────────────
  // Written by `runFinalizePhase` and read back by `akmIndex()` to assemble the
  // response. Undefined until the finalize phase has run.

  /** Semantic-search verification result computed during finalize. */
  verification?: IndexVerification;
  /** Total entry count in the index after finalize. */
  totalEntries?: number;
}
