// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Shared index-verification types.
 *
 * Used to also carry `IndexRunContext` — the state bag threaded through every
 * phase of the old walk/clean/embed/finalize pipeline in `indexer.ts`. The
 * index redesign (docs/plans/index-redesign-contract.md, B5) replaced that
 * pipeline with reconcile + drain, which needs no per-phase context object;
 * only the verification/status vocabulary below survives.
 */

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
 * Verification of the post-index semantic-search state. Produced by
 * `akmIndex()`'s finalize step and surfaced to its caller.
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
