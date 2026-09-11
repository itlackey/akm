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

/**
 * Live runtime state of semantic search, computed fresh at index-finalize
 * time. `"ready-js"` (a JS-computed cosine-similarity fallback for when the
 * sqlite-vec extension was unavailable, reading a BLOB-vector table instead)
 * is retired (index redesign, B5): `units_vec` is a vec0-only store with no
 * BLOB fallback to fall back to, so nothing produces that value any more.
 */
export type SemanticSearchRuntimeStatus = "pending" | "ready-vec" | "blocked";

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
