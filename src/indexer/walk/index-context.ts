// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** Result types shared by `akmIndex()` and its callers. */

/**
 * Live runtime state of semantic search, computed fresh at index-finalize
 * time. `ready-js` means every entry has a vector; the name is historical (the
 * sqlite-vec variant, `ready-vec`, is gone).
 */
export type SemanticSearchRuntimeStatus = "pending" | "ready-js" | "blocked";

/**
 * Verification of the post-index semantic-search state. Produced by the
 * finalize phase and surfaced to the `akmIndex()` caller.
 */
export interface IndexVerification {
  ok: boolean;
  message: string;
  guidance?: string;
  semanticSearchEnabled: boolean;
  semanticSearchMode: "off" | "auto";
  semanticStatus: "disabled" | SemanticSearchRuntimeStatus;
  embeddingProvider: "local" | "remote";
  /** The runtime the local embedder embedded with in this run; absent for a remote provider or when nothing was embedded locally. */
  embeddingRuntime?: "onnxruntime-node";
  entryCount: number;
  embeddingCount: number;
}

/** The `index_meta` key holding the last index run's {@link SemanticSearchRecord}. */
export const SEMANTIC_SEARCH_META_KEY = "semanticSearch";

/**
 * What the last index run found about semantic search, kept beside `hasEmbeddings`
 * for `akm health`'s `semantic-search` check. A record, not a gate: search never
 * reads it (#873). `unavailable` is a `blocked` run whose local embedding runtime
 * could not load on this machine.
 */
export interface SemanticSearchRecord {
  status: IndexVerification["semanticStatus"] | "unavailable";
  provider: IndexVerification["embeddingProvider"];
  /** The runtime the local embedder embedded with in that run; absent when it embedded nothing. */
  runtime?: string;
  /** Why semantic search is blocked or unavailable. */
  reason?: string;
}

/** Canonical configured owner that disappeared or moved since the last complete scan. */
export interface RemovedIndexSource {
  bundleId: string;
  sourceRoot: string;
  /** False when the same bundle id remains configured at a different root. */
  removeBundleEntries: boolean;
}
