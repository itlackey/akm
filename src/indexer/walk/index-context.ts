// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** Result types shared by `akmIndex()` and its callers. */

/** Live runtime state of semantic search, computed fresh at index-finalize time. */
export type SemanticSearchRuntimeStatus = "pending" | "ready-js" | "ready-vec" | "blocked";

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
