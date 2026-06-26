// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Shared consolidate domain types. This module is the dependency sink for the
// consolidate cluster: the leaf modules (merge, chunking, …) and the
// orchestrator (`consolidate.ts`) all import from here, and it imports nothing
// from the consolidate domain — keeping the cluster's import graph acyclic.

export interface ConsolidateMergeOp {
  op: "merge";
  primary: string;
  secondaries: string[];
  mergeStrategy: string;
  /** LLM self-reported confidence in [0, 1]. Used by the auto-accept gate. */
  confidence?: number;
}

export interface ConsolidateDeleteOp {
  op: "delete";
  ref: string;
  reason: string;
  /** LLM self-reported confidence in [0, 1]. Used by the auto-accept gate. */
  confidence?: number;
}

export interface ConsolidatePromoteOp {
  op: "promote";
  ref: string;
  knowledgeRef: string;
  reason: string;
  /** One-sentence description for the new knowledge asset's frontmatter. */
  description?: string;
  /** LLM self-reported confidence in [0, 1]. Used by the auto-accept gate. */
  confidence?: number;
}

/**
 * Contradict op (C-3 / #382): two memories make mutually exclusive factual
 * claims. The consolidate engine writes `contradictedBy` frontmatter edges
 * so `resolveFamilyContradictions` in `memory-improve.ts` can resolve them
 * via its SCC algorithm. Zep arXiv:2501.13956 §3.
 */
export interface ConsolidateContradictOp {
  op: "contradict";
  /** The memory that should be marked as contradicted. */
  ref: string;
  /** The memory that contradicts it. */
  contradictedByRef: string;
  reason: string;
  /** LLM self-reported confidence in [0, 1]. Used by the auto-accept gate. */
  confidence?: number;
}

export type ConsolidateOperation =
  | ConsolidateMergeOp
  | ConsolidateDeleteOp
  | ConsolidatePromoteOp
  | ConsolidateContradictOp;

export interface MemoryEntry {
  name: string;
  filePath: string;
  description: string;
  tags: string[];
  stashDir: string;
}

export interface RawChunkPlan {
  operations?: unknown[];
  warnings?: unknown[];
}
