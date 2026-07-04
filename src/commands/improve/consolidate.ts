// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import consolidateSystemPrompt from "../../assets/prompts/consolidate-system.md" with { type: "text" };
import { parseAssetRef } from "../../core/asset/asset-ref";
import { assembleAssetFromString, serializeFrontmatter } from "../../core/asset/asset-serialize";
import { parseFrontmatter } from "../../core/asset/frontmatter";
import { resolveStashDir, timestampForFilename } from "../../core/common";
import type { AkmConfig } from "../../core/config/config";
import { getDefaultLlmConfig, getImproveProcessConfig, loadConfig } from "../../core/config/config";
import { ConfigError } from "../../core/errors";
// Note: appendEvent import removed (WS-3a: archive TTL machinery retired)
import { parseEmbeddedJsonResponse } from "../../core/parse";
import { resolveStashStandards } from "../../core/standards/resolve-stash-standards";
import { detectTruncatedDescription } from "../../core/text-truncation";
import { parseDuration } from "../../core/time";
import { createProposal, isProposalSkipped, listProposals } from "../proposal/repository";
import {
  hasSupersededStatus,
  MERGE_ABSOLUTE_FLOOR_CHARS,
  MERGE_SHRINK_RATIO_MIN,
  validateProposalFrontmatter,
} from "../proposal/validators/proposal-quality-validators";
import {
  type AntiCollapseConfig,
  checkGenerationGuard,
  checkLexicalDiversity,
  checkMergeInformationFloor,
  computeMergedGeneration,
  readAssetGeneration,
} from "./anti-collapse";
import { cacheHash, type DedupConfig, runDeterministicDedup, stripFrontmatterBody } from "./dedup";
import { shouldSkipHotProbationInLlm } from "./hot-probation";
import { writeContradictEdge } from "./memory/memory-belief";

// Re-export the moved helpers so existing test imports continue to resolve.
export { hasSupersededStatus, validateProposalFrontmatter };

import { openStateDatabase, withStateDb } from "../../core/state-db";
import { warn } from "../../core/warn";
import {
  commitWriteTargetBoundary,
  deleteAssetFromSource,
  resolveWriteTarget,
  writeAssetToSource,
} from "../../core/write-source";
import type { DbIndexedEntry } from "../../indexer/db/db";
import {
  closeDatabase,
  findEntryIdByRef,
  getAllEntries,
  getEntryById,
  getNeighborsByEntryId,
  openExistingDatabase,
} from "../../indexer/db/db";
import { resolveImproveProcessRunnerFromProfile, runnerIsLlm } from "../../integrations/agent/runner";
import { chatCompletion } from "../../llm/client";
import { cosineSimilarity, embedBatch, resolveEmbeddingModelId } from "../../llm/embedder";
import { isLlmFeatureEnabled, tryLlmFeature } from "../../llm/feature-gate";
import type { Database } from "../../storage/database";
import {
  type ConsolidationJudgedRow,
  getConsolidationJudgedMap,
  upsertConsolidationJudged,
} from "../../storage/repositories/consolidation-repository";
import { getBodyEmbeddings, upsertBodyEmbeddings } from "../../storage/repositories/embeddings-repository";

// ── Types ───────────────────────────────────────────────────────────────────

// Shared consolidate domain types live in ./consolidate/types (the cluster's
// dependency sink). Re-exported here so existing importers keep resolving.
import type {
  ConsolidateContradictOp,
  ConsolidateDeleteOp,
  ConsolidateMergeOp,
  ConsolidateOperation,
  ConsolidatePromoteOp,
  MemoryEntry,
  RawChunkPlan,
} from "./consolidate/types";

export type {
  ConsolidateContradictOp,
  ConsolidateDeleteOp,
  ConsolidateMergeOp,
  ConsolidateOperation,
  ConsolidatePromoteOp,
  MemoryEntry,
  RawChunkPlan,
} from "./consolidate/types";

// Chunk sizing + per-chunk prompt assembly live in ./consolidate/chunking.
// Imported for internal use by the orchestrator and re-exported for importers.
import { buildChunkPrompt, computeSafeChunkSize, DEFAULT_CONTEXT_LENGTH_TOKENS } from "./consolidate/chunking";

export { buildChunkPrompt, computeSafeChunkSize, DEFAULT_CONTEXT_LENGTH_TOKENS } from "./consolidate/chunking";

// LLM-output sanitization (pure string/frontmatter transforms) lives in
// ./consolidate/sanitize. Imported for internal use + re-exported for importers.
import { normalizeUpdatedField, sanitizeMergedContent } from "./consolidate/sanitize";

export { normalizeUpdatedField, sanitizeMergedContent, stripOuterCodeFence } from "./consolidate/sanitize";

// Eligibility / safety predicates live in ./consolidate/eligibility. Imported
// for internal guard use; the two public predicates are re-exported.
import {
  type ConsolidateGuardVerdict,
  consolidateGuardStatus,
  isConsolidationEligibleMemoryName,
  isHotCapturedMemory,
  isSessionCaptureMemoryName,
} from "./consolidate/eligibility";

export {
  isConsolidationEligibleMemoryName,
  isHotCapturedMemory,
  isSessionCaptureMemoryName,
} from "./consolidate/eligibility";

// Plan parsing / merging (pure op-reconciliation algebra) lives in
// ./consolidate/merge. Imported for internal use; mergePlans re-exported.
import { isValidOp, mergePlans } from "./consolidate/merge";

export { mergePlans } from "./consolidate/merge";

export interface ConsolidateResult {
  schemaVersion: 1;
  ok: boolean;
  shape: "consolidate-result";
  dryRun: boolean;
  previewOnly: boolean;
  target: string;
  processed: number;
  merged: number;
  deleted: number;
  promoted: string[];
  /** Number of contradiction edges written (C-3 / #382). */
  contradicted: number;
  /**
   * R5 §4.2 — merges that failed the ADVISORY merge-information floor this run
   * (provenance shrank or specificity retention below the configured floor).
   * The merges still proceeded in v1; the count feeds the collapse detector's
   * cycle metrics and the health advisory.
   */
  mergeFloorViolations?: number;
  /**
   * Number of LLM chunks that failed (HTTP error, empty/invalid plan, etc.)
   * during this run. Counterpart to {@link processed}, which counts INPUT
   * memories — `failedChunks` is the visibility signal for silent LLM
   * failures so they surface in `akm health` instead of being absorbed into
   * a misleadingly healthy `processed` count.
   *
   * Backstory: 2026-05-26 incident — 21/21 runs reported `processed: 118` /
   * `merged: 0` / `deleted: 0` while every chunk was actually being rejected
   * with `n_keep > n_ctx`. The "OK + warnings" envelope hid the fact that
   * the pass was a no-op. See
   * `/tmp/akm-health-investigations/consolidation-no-op.md`.
   */
  failedChunks?: number;
  /** Total chunks attempted this run; lets callers compute a failure rate. */
  totalChunks?: number;
  /**
   * Memories the LLM saw inside a chunk but proposed no op for. Per chunk:
   * `chunk.length − unique(ops.targetRefs)`. Pre-2026-05-26 this was a pure
   * silent drop — 66% of consolidate memories had no warning, event, or
   * counter. Without it, no consolidate prompt tuning is possible.
   * See `/tmp/akm-health-investigations/tuning-reasons-investigation.md` §Q2.
   */
  judgedNoAction?: number;
  /**
   * Structured per-op skip reasons emitted at every deterministic post-LLM
   * rejection site. Replaces the regex-on-`warnings[]` smell with a typed
   * histogram input. Codes intentionally use snake_case; see
   * `ConsolidateSkipReason` in health.ts for the vocabulary.
   */
  skipReasons?: Array<{
    ref: string;
    skips: Array<{ op: ConsolidateOpKind | "unknown"; reason: string }>;
  }>;
  /**
   * Secondary memories absorbed into successful merge operations. 2026-05-26
   * accounting-leak fix: `merged` is an OP-LEVEL counter (1 per merge op), but
   * each successful merge actions `1 + secondaries.length` memories. Without
   * `mergedSecondaries`, those secondaries are excluded from `judgedNoAction`
   * (their refs land in the chunk's `targetRefs`) and never accounted for
   * elsewhere, producing the small "processed − actioned − noAction − skips
   * = N missing" gap observed in the 2026-05-27 02:07 run (11 unaccounted)
   * and prior runs. Required for the invariant
   * `processed == promoted + merged + mergedSecondaries + deleted + contradicted
   *           + judgedNoAction + Σ(skipReasons) + failedChunkMemories`.
   */
  mergedSecondaries?: number;
  /**
   * Memories belonging to chunks whose LLM call failed (HTTP error / empty
   * response / invalid plan / consolidation-aborted by failure-rate threshold).
   * 2026-05-26 accounting-leak fix: these memories never reach the per-chunk
   * `judgedNoAction` computation (it lives after the success-path continue
   * guards) and never enter `skipReasons` either, so they were a pure silent
   * drop on every `failedChunks > 0` run. Required for the accounting
   * invariant.
   */
  failedChunkMemories?: number;
  planned?: ConsolidateOperation[];
  warnings: string[];
  durationMs: number;
  /**
   * WS-5 perf telemetry (Part V). Always emitted when consolidation runs —
   * these are health VIEWS of the pipeline, not truth sources. Omitted on the
   * early-exit paths (no memories, all judged-unchanged) to keep the envelope
   * tidy.
   */
  perfTelemetry?: ConsolidatePerfTelemetry;
}

/**
 * WS-5 per-run consolidation performance telemetry (Part V §5 of the plan).
 * All fields are optional so existing callers that spread ConsolidateResult
 * can adopt the shape incrementally.
 */
export interface ConsolidatePerfTelemetry {
  /**
   * Pool size BEFORE the judged-state cache narrowing step.
   * Measures the raw candidate set loaded from disk this run.
   */
  dedupPoolSize?: number;
  /**
   * Pool size AFTER judged-cache and limit filtering — the memories actually
   * sent to the LLM for a fresh judgment. `dedupPoolSize − llmPoolSize` is
   * the effective judgedCacheSkipped + limit-capped count.
   */
  llmPoolSize?: number;
  /**
   * Memories skipped because the judged-state cache recorded them as
   * unchanged since the last LLM judgment. 0 when judgedCache is disabled.
   * Health threshold: >95% hits on an incremental run (warm cache).
   */
  judgedCacheSkipped?: number;
  /**
   * Wall-clock milliseconds spent in the embedding stage (both cluster
   * reordering and dedup cosine path). Extracted from timing around embedBatch
   * calls so the LLM wall-clock accounts only for LLM calls.
   */
  embedMs?: number;
  /**
   * Number of body-embedding cache hits (content_hash found in body_embeddings).
   * Healthy incremental run: >95% hits once the cache is warm.
   */
  embedCacheHits?: number;
  /**
   * Number of body-embedding cache misses (content_hash not found; embedBatch
   * was called). High misses signal a cold cache or high corpus churn.
   */
  embedCacheMisses?: number;
  /**
   * Fraction of the run budget consumed by consolidation alone:
   * `consolidation.durationMs / budgetMs`. Values >1.0 mean this consolidation
   * pass alone exceeded the caller's declared budget — a SIGTERM risk signal.
   */
  estimatedBudgetFractionUsed?: number;
}

/** Op-kind discriminator used in {@link ConsolidateResult.skipReasons}. */
type ConsolidateOpKind = "merge" | "delete" | "promote" | "contradict";

export interface AkmConsolidateOptions {
  target?: string; // which source to target; defaults to primary writable stash
  dryRun?: boolean; // generate AI plan but skip all writes
  /**
   * Confidence threshold (0-100). Undefined disables auto-accept and enables
   * interactive confirmation on the HTTP consolidation path.
   */
  autoAccept?: number;
  task?: string; // extra guidance appended to the system prompt
  stashDir?: string;
  config?: AkmConfig;
  /** When true, indicates the run was triggered automatically by volume threshold rather than by the memory_consolidation feature flag. */
  autoTriggered?: boolean;
  /** How to handle stale/incomplete consolidate journals from prior interrupted runs. */
  recoveryMode?: "abort" | "clean";
  /**
   * Incremental gate (ISO timestamp). When set, consolidation considers only
   * memories modified after this time PLUS their top-k semantic neighbours from
   * the persisted vector index ({changed ∪ neighbours}) — capturing every new
   * merge/dedup/contradict opportunity (all of which require something to have
   * changed) while skipping the unchanged bulk a prior run already judged. This
   * converts cost from O(pool) to O(changed clusters). Unset (standalone
   * `akm consolidate`, bootstrap, volume-triggered) → full pool. Falls back to
   * the full pool when the index/embeddings are unavailable, preserving merge
   * correctness at the cost of speed.
   */
  incrementalSince?: string;
  /** Override the computed safe chunk size cap (1–50). */
  maxChunkSize?: number;
  /** Hard cap on memories processed per pass (applied after incremental narrowing). Absent = no cap. */
  limit?: number;
  /** Number of graph neighbours per changed memory during incremental consolidation. Default 5. */
  neighborsPerChanged?: number;
  /**
   * Deterministic near-duplicate dedup pre-pass (#617). DEFAULT OFF. When
   * `enabled`, a cheap no-LLM fast path collapses obvious duplicates
   * (`.derived` ↔ origin pairs + content twins) before the LLM consolidation.
   * Absent / disabled = byte-identical legacy behaviour.
   */
  dedup?: DedupConfig;
  /**
   * Judged-state cache (#581). DEFAULT OFF. When `enabled`, memories whose
   * current frontmatter-stripped content hash equals the hash recorded the last
   * time the consolidate LLM judged them are SKIPPED from the LLM pool
   * (judged-unchanged → no re-judge), and every memory the LLM saw in a
   * successfully-judged chunk has its judged state upserted afterwards. This
   * lets a single run sweep the FULL corpus at O(changed/new) cost instead of
   * narrowing to a recent time-window slice. Absent / disabled = byte-identical
   * legacy behaviour (the `incrementalSince` path is unaffected).
   */
  judgedCache?: { enabled?: boolean };
  /**
   * PROV-DM traceability token for proposals created by this run. When set,
   * every `createProposal` call includes it so accept-rate-per-run aggregation
   * works. When absent, a `consolidate-<timestamp>` token is generated at the
   * start of `akmConsolidate` so standalone `akm consolidate` also emits a
   * consistent token. Callers (e.g. `akmImprove`) should pass
   * `sourceRun: \`consolidate-\${startMs}\`` to tie proposals back to the
   * containing improve run.
   */
  sourceRun?: string;
  /**
   * AbortSignal from the caller's budget controller (e.g. `improve.ts`
   * `budgetAbortController`). When aborted the consolidation loop breaks cleanly
   * after completing the current chunk, commits work done, and returns with a
   * `partial_timeout` outcome note in `warnings`. The signal is also forwarded
   * to `embedBatch` and `runDeterministicDedup` so mid-embedding aborts are
   * handled gracefully. Absent = run without a budget limit.
   */
  signal?: AbortSignal;
  /**
   * Fallback p90 wall-clock time per consolidation chunk in seconds, used for
   * cold-start budget estimation when `signal` is provided. Defaults to 30 s
   * when absent. Callers (improve.ts) can pass the profile's
   * `p90ChunkSecondsDefault` config value here.
   */
  p90ChunkSecondsDefault?: number;
  /**
   * Total run budget in milliseconds (from `akmImprove`'s `timeoutMs`).
   * When provided, `perfTelemetry.estimatedBudgetFractionUsed` is populated so
   * the health report can flag >1.0 (consolidation alone exceeded the budget).
   * Absent = `estimatedBudgetFractionUsed` is omitted from perf telemetry.
   */
  runBudgetMs?: number;
}

// ── Prompts ─────────────────────────────────────────────────────────────────

const CONSOLIDATE_SYSTEM_PROMPT = consolidateSystemPrompt;

/**
 * JSON Schema for structured consolidate plans (PR 1 of the asset-writers
 * decision — see knowledge:projects/akm/asset-writers-investigation/00-synthesis).
 * Mirrors the {ops[], warnings?[]} shape currently described in
 * CONSOLIDATE_SYSTEM_PROMPT. Providers with `supportsJsonSchema: true` enforce
 * the shape upstream so the chunk-level "invalid plan from AI — skipping"
 * branch in `runConsolidate` becomes unreachable on schema-honouring providers.
 *
 * The four operation variants (merge / delete / promote / contradict) are
 * modeled as a oneOf so a structured-output provider can still tell them apart
 * by the required `op` discriminator. `parseEmbeddedJsonResponse` keeps
 * working as a fallback parser for providers that ignore the schema.
 */
export const CONSOLIDATE_PLAN_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  required: ["operations"],
  additionalProperties: false,
  properties: {
    operations: {
      type: "array",
      description: "Ordered list of consolidate operations the planner proposes.",
      items: {
        oneOf: [
          {
            type: "object",
            required: ["op", "primary", "secondaries", "mergeStrategy"],
            additionalProperties: false,
            properties: {
              op: { type: "string", enum: ["merge"] },
              primary: { type: "string", minLength: 1 },
              secondaries: {
                type: "array",
                minItems: 1,
                items: { type: "string", minLength: 1 },
              },
              mergeStrategy: { type: "string", minLength: 1 },
              confidence: { type: "number", minimum: 0, maximum: 1 },
            },
          },
          {
            type: "object",
            required: ["op", "ref", "reason"],
            additionalProperties: false,
            properties: {
              op: { type: "string", enum: ["delete"] },
              ref: { type: "string", minLength: 1 },
              reason: { type: "string", minLength: 1 },
              confidence: { type: "number", minimum: 0, maximum: 1 },
            },
          },
          {
            type: "object",
            required: ["op", "ref", "knowledgeRef", "reason"],
            additionalProperties: false,
            properties: {
              op: { type: "string", enum: ["promote"] },
              ref: { type: "string", minLength: 1 },
              knowledgeRef: { type: "string", minLength: 1 },
              reason: { type: "string", minLength: 1 },
              description: { type: "string" },
              confidence: { type: "number", minimum: 0, maximum: 1 },
            },
          },
          {
            type: "object",
            required: ["op", "ref", "contradictedByRef", "reason"],
            additionalProperties: false,
            properties: {
              op: { type: "string", enum: ["contradict"] },
              ref: { type: "string", minLength: 1 },
              contradictedByRef: { type: "string", minLength: 1 },
              reason: { type: "string", minLength: 1 },
              confidence: { type: "number", minimum: 0, maximum: 1 },
            },
          },
        ],
      },
    },
    warnings: {
      type: "array",
      description: "Optional list of human-readable concerns the planner wants to surface.",
      items: { type: "string" },
    },
  },
};

// ── Similarity clustering (C-1 / #380) ──────────────────────────────────────

/**
 * Re-order memories so that similar ones are placed adjacent to each other
 * before the memories are sliced into chunks. This ensures high-similarity
 * memories land in the same LLM context window, allowing the consolidate
 * model to detect and merge duplicates that would otherwise be split across
 * chunks and survive indefinitely.
 *
 * Algorithm: greedy nearest-neighbour chain starting from the first memory.
 * Each step selects the unused memory with the highest cosine similarity to
 * the last-placed memory. O(n²) — acceptable for the expected N < 200.
 *
 * mem0 arXiv:2504.19413 — every candidate compared against whole store.
 * A-MEM arXiv:2502.12110 — atomic notes linked by similarity.
 *
 * Returns the original order unchanged when:
 *   - The embedding config is not present.
 *   - Embedding requests fail (fail-open).
 *   - There are fewer than 3 memories (no benefit to reordering).
 */
/** WS-5 embedding telemetry returned alongside cluster results. */
interface ClusterEmbedTelemetry {
  embedMs: number;
  cacheHits: number;
  cacheMisses: number;
}

async function clusterMemoriesBySimilarity(
  memories: MemoryEntry[],
  config: AkmConfig,
  stateDb?: Database,
): Promise<{ ordered: MemoryEntry[]; embedTelemetry: ClusterEmbedTelemetry }> {
  const noTelemetry: ClusterEmbedTelemetry = { embedMs: 0, cacheHits: 0, cacheMisses: 0 };
  if (memories.length < 3 || !config.embedding) return { ordered: memories, embedTelemetry: noTelemetry };

  // WS-3a: cluster uses description+tags as the embedding input (NOT the raw
  // body) — this is intentionally different from the dedup/body cache because
  // the clustering goal is semantic grouping, not dedup twin detection.
  // The body_embeddings cache is keyed by cacheHash(body); clustering inputs
  // are keyed by cacheHash(description+tags text). Re-use the same table with
  // a distinct hash so the two lookup sets never collide.
  const modelId = resolveEmbeddingModelId(config.embedding);

  const texts = memories.map((m) => {
    const parts: string[] = [];
    if (m.description) parts.push(m.description);
    if (m.tags.length > 0) parts.push(m.tags.join(" "));
    return parts.join(". ") || m.name;
  });

  // Compute content hashes for the cluster texts (not bodies — different input).
  const contentHashes = texts.map((t) => createHash("sha256").update(t, "utf8").digest("hex"));

  // WS-5: track embed cache hits/misses for perf telemetry.
  let embedMs = 0;
  let cacheHits = 0;
  let cacheMisses = 0;

  let cachedVecs = new Map<string, number[]>();
  if (stateDb) {
    try {
      cachedVecs = getBodyEmbeddings(stateDb, contentHashes, modelId);
    } catch {
      // Fail open.
      cachedVecs = new Map();
    }
  }

  const missIndices: number[] = [];
  const missTexts: string[] = [];
  for (let i = 0; i < texts.length; i++) {
    if (!cachedVecs.has(contentHashes[i] as string)) {
      missIndices.push(i);
      missTexts.push(texts[i] as string);
      cacheMisses++;
    } else {
      cacheHits++;
    }
  }

  let missVecs: number[][] = [];
  if (missTexts.length > 0) {
    const embedStart = Date.now();
    try {
      missVecs = await embedBatch(missTexts, config.embedding);
    } catch {
      // Fail open: embedding failures degrade gracefully to original order.
      return { ordered: memories, embedTelemetry: { embedMs, cacheHits, cacheMisses } };
    } finally {
      embedMs += Date.now() - embedStart;
    }
    // Upsert newly computed vectors into the cache.
    if (stateDb && missVecs.length === missTexts.length) {
      try {
        const toUpsert = missIndices.map((idx, pos) => ({
          contentHash: contentHashes[idx] as string,
          embedding: missVecs[pos] as number[],
          modelId,
        }));
        upsertBodyEmbeddings(stateDb, toUpsert);
      } catch {
        // Fail open: cache write errors are non-fatal.
      }
    }
  }

  // Assemble the full embedding array in memories order.
  let embeddings: number[][] | null = null;
  {
    const assembled: number[][] = [];
    let ok = true;
    for (let i = 0; i < memories.length; i++) {
      const hash = contentHashes[i] as string;
      const cached = cachedVecs.get(hash);
      if (cached) {
        assembled.push(cached);
        continue;
      }
      const missPos = missIndices.indexOf(i);
      const vec = missPos >= 0 ? missVecs[missPos] : undefined;
      if (vec) {
        assembled.push(vec);
      } else {
        ok = false;
        break;
      }
    }
    if (ok && assembled.length === memories.length) {
      embeddings = assembled;
    }
  }

  const embedTelemetry: ClusterEmbedTelemetry = { embedMs, cacheHits, cacheMisses };

  if (!embeddings || embeddings.length !== memories.length) return { ordered: memories, embedTelemetry };

  // Greedy nearest-neighbour chain.
  const used = new Array<boolean>(memories.length).fill(false);
  const ordered: MemoryEntry[] = [];
  let current = 0; // start from the first memory

  ordered.push(memories[current] as MemoryEntry);
  used[current] = true;

  for (let step = 1; step < memories.length; step++) {
    const currentEmb = embeddings[current] as number[];
    let bestIdx = -1;
    let bestSim = -Infinity;
    for (let j = 0; j < memories.length; j++) {
      if (used[j]) continue;
      const sim = cosineSimilarity(currentEmb, embeddings[j] as number[]);
      if (sim > bestSim) {
        bestSim = sim;
        bestIdx = j;
      }
    }
    if (bestIdx === -1) break;
    ordered.push(memories[bestIdx] as MemoryEntry);
    used[bestIdx] = true;
    current = bestIdx;
  }

  return { ordered, embedTelemetry };
}

// ── Chunk helpers ────────────────────────────────────────────────────────────

/**
 * Precompute body-hashes of all currently-pending consolidate proposals so
 * the per-chunk prompt can annotate memories whose body would just produce
 * a deterministic `dedup_pending_proposal` skip. Uses `cacheHash` (case-
 * preserving stripped body) — the same domain used by the body-embedding
 * cache and `computeMemoryContentHash`. Empty set on any read/parse error
 * — fail-safe to "annotate nothing" so the LLM still proposes.
 */
function loadPendingConsolidateProposalHashes(stashDir: string): Set<string> {
  const hashes = new Set<string>();
  try {
    const pending = listProposals(stashDir, { status: "pending" }).filter((p) => p.source === "consolidate");
    for (const p of pending) {
      try {
        hashes.add(cacheHash(p.payload.content));
      } catch {
        // skip malformed payloads — they can't dedup anyway
      }
    }
  } catch {
    // listProposals throws on missing stash dir during tests — empty set is safe
  }
  return hashes;
}

// ── Journal helpers ──────────────────────────────────────────────────────────

interface ConsolidateJournal {
  startedAt: string;
  operations: ConsolidateOperation[];
  completed: string[];
  backupTimestamp?: string;
}

function getJournalPath(stashDir: string): string {
  return path.join(stashDir, ".akm", "consolidate-journal.json");
}

function getBackupDir(stashDir: string, timestamp: string): string {
  return path.join(stashDir, ".akm", "consolidate-backup", timestamp);
}

function removeStaleJournal(stashDir: string, journal: ConsolidateJournal, warnings: string[]): void {
  const journalPath = getJournalPath(stashDir);
  try {
    fs.unlinkSync(journalPath);
  } catch {
    warnings.push(`Failed to remove stale consolidate journal at ${journalPath}.`);
  }

  const backupTimestamp =
    typeof journal.backupTimestamp === "string" && journal.backupTimestamp.trim().length > 0
      ? journal.backupTimestamp.trim()
      : typeof journal.startedAt === "string" && journal.startedAt.trim().length > 0
        ? journal.startedAt.replace(/[:.]/g, "-")
        : "";
  if (!backupTimestamp) return;

  const backupDir = getBackupDir(stashDir, backupTimestamp);
  if (!fs.existsSync(backupDir)) return;
  try {
    fs.rmSync(backupDir, { recursive: true, force: true });
  } catch {
    warnings.push(`Failed to remove stale consolidate backup at ${backupDir}.`);
  }

  warnings.push(`Cleared stale consolidate backup at ${backupDir}.`);
}

function checkForIncompleteJournal(stashDir: string, recoveryMode: "abort" | "clean", warnings: string[]): void {
  const journalPath = getJournalPath(stashDir);
  if (!fs.existsSync(journalPath)) return;

  let journal: ConsolidateJournal;
  try {
    journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as ConsolidateJournal;
  } catch {
    if (recoveryMode === "clean") {
      try {
        fs.unlinkSync(journalPath);
        warnings.push(`Removed unreadable consolidate journal at ${journalPath}.`);
      } catch {
        warnings.push(`Failed to remove unreadable consolidate journal at ${journalPath}.`);
      }
      return;
    }
    throw new ConfigError(
      `Incomplete consolidation state detected: unreadable journal at ${journalPath}. Re-run with --consolidate-recovery clean to remove stale journal artifacts, or remove the file manually.`,
      "INVALID_CONFIG_FILE",
    );
  }

  const operationCount = Array.isArray(journal.operations) ? journal.operations.length : 0;
  const completedCount = Array.isArray(journal.completed) ? journal.completed.length : 0;
  if (completedCount >= operationCount) return;

  if (recoveryMode === "clean") {
    removeStaleJournal(stashDir, journal, warnings);
    warnings.push(
      `Removed stale consolidation journal at ${journalPath} (${completedCount}/${operationCount} operations completed).`,
    );
    return;
  }

  const backupHint =
    typeof journal.backupTimestamp === "string" && journal.backupTimestamp.trim().length > 0
      ? ` Backup dir: ${getBackupDir(stashDir, journal.backupTimestamp.trim())}.`
      : "";
  throw new ConfigError(
    `Incomplete consolidation run detected at ${journalPath} (${completedCount}/${operationCount} operations completed). Re-run with --consolidate-recovery clean to remove stale journal artifacts.${backupHint}`,
    "INVALID_CONFIG_FILE",
  );
}

function writeJournal(stashDir: string, ops: ConsolidateOperation[], backupTimestamp: string): void {
  const journalPath = getJournalPath(stashDir);
  fs.mkdirSync(path.dirname(journalPath), { recursive: true });
  const journal: ConsolidateJournal = {
    startedAt: new Date().toISOString(),
    operations: ops,
    completed: [],
    backupTimestamp,
  };
  fs.writeFileSync(journalPath, JSON.stringify(journal, null, 2), "utf8");
}

function markJournalCompleted(stashDir: string, opRef: string): void {
  const journalPath = getJournalPath(stashDir);
  if (!fs.existsSync(journalPath)) return;
  try {
    const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as ConsolidateJournal;
    journal.completed.push(opRef);
    fs.writeFileSync(journalPath, JSON.stringify(journal, null, 2), "utf8");
  } catch {
    // best-effort
  }
}

function cleanupJournal(stashDir: string, timestamp: string): void {
  const journalPath = getJournalPath(stashDir);
  try {
    fs.unlinkSync(journalPath);
  } catch {
    // ignore
  }
  const backupDir = getBackupDir(stashDir, timestamp);
  try {
    fs.rmSync(backupDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

function backupFile(filePath: string, backupDir: string, name: string): void {
  try {
    fs.mkdirSync(backupDir, { recursive: true });
    fs.copyFileSync(filePath, path.join(backupDir, `${name}.md`));
  } catch {
    // best-effort
  }
}

// ── WS-3b: Generation frontmatter injection ───────────────────────────────────

/**
 * Inject `generation` and `source_refs` into merged content.
 * generation = max(sourceGenerations) + 1.
 * source_refs = UNION of the provided provenance refs (participants + their
 * cited sources) with anything already present in the merged frontmatter —
 * R5 §4.2: the old set-if-absent behavior dropped second-generation
 * provenance whenever the LLM emitted its own (partial) source_refs.
 * Fails open — returns original content if frontmatter can't be parsed.
 */
function injectGenerationFrontmatter(
  mergedContent: string,
  sourceGenerations: number[],
  provenanceRefs: string[],
): string {
  try {
    const parsed = parseFrontmatter(mergedContent);
    const existingFm = parsed.data as Record<string, unknown>;
    const existingRefs = Array.isArray(existingFm.source_refs) ? existingFm.source_refs.map(String) : [];
    const updatedFm: Record<string, unknown> = {
      ...existingFm,
      generation: computeMergedGeneration(sourceGenerations),
      source_refs: [...new Set([...existingRefs, ...provenanceRefs])],
    };
    return assembleAssetFromString(serializeFrontmatter(updatedFm), parsed.content);
  } catch {
    return mergedContent; // fail open
  }
}

// ── Archive helper (P1-B: soft-invalidation) ─────────────────────────────────

/**
 * Move a memory asset to `.akm/archive/` with `status: superseded` frontmatter
 * instead of deleting it outright. The live stash delete still happens after
 * this call — this is belt-and-suspenders archival that survives the hard delete.
 *
 * Archive filename: `<iso-ts>-<opIndex>-<basename>.md`
 * New frontmatter fields: status, superseded_at, superseded_by (optional),
 * superseded_reason.
 */
function archiveMemory(
  filePath: string,
  stashDir: string,
  ref: string,
  reason: string,
  opIndex: number,
  supersededBy?: string,
  warnings?: string[],
): void {
  const archiveDir = path.join(stashDir, ".akm", "archive");
  fs.mkdirSync(archiveDir, { recursive: true });
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    if (warnings) warnings.push(`archiveMemory: could not read ${ref} for archiving — skipping archive write`);
    return;
  }
  let content = raw;
  try {
    const parsed = parseFrontmatter(raw);
    const newFm: Record<string, unknown> = {
      ...parsed.data,
      status: "superseded",
      superseded_at: new Date().toISOString(),
      ...(supersededBy ? { superseded_by: supersededBy } : {}),
      superseded_reason: reason,
    };
    content = assembleAssetFromString(serializeFrontmatter(newFm), parsed.content);
  } catch {
    if (warnings) warnings.push(`archiveMemory: could not parse frontmatter for ${ref} — archiving raw`);
  }
  const ts = timestampForFilename();
  const safeName = path.basename(filePath, ".md");
  const archivePath = path.join(archiveDir, `${ts}-${opIndex}-${safeName}.md`);
  try {
    fs.writeFileSync(archivePath, content, "utf8");
  } catch (e) {
    if (warnings) warnings.push(`archiveMemory: write failed for ${ref}: ${String(e)}`);
  }
}

// ── LLM resolution ──────────────────────────────────────────────────────────

/**
 * Resolve the LLM connection for the consolidate pass.
 *
 * Priority order (mirrors extract / reflect / distill — see
 * `src/commands/extract.ts:421-438` and the canonical
 * `resolveImproveProcessRunnerFromProfile` pattern):
 *
 *   1. `profiles.improve.default.processes.consolidate.profile` (or `mode`)
 *      via {@link resolveImproveProcessRunnerFromProfile}. Lets the user pin
 *      a dedicated model (e.g. `ministral-3b`) for consolidation instead of
 *      whatever `defaults.llm` happens to be.
 *   2. `getDefaultLlmConfig(config)` — the baseline default LLM profile.
 *
 * Regression guard (2026-05-26): before this resolver, `akmConsolidate`
 * called `getDefaultLlmConfig` directly and silently ignored a configured
 * `processes.consolidate.profile`, sending every chunk to the default LLM
 * (often a long-context model loaded with a smaller runtime `n_ctx`, causing
 * silent 400s from LM Studio). The investigation lives at
 * `/tmp/akm-health-investigations/consolidation-no-op.md`.
 */
function resolveConsolidateLlmConfig(config: AkmConfig) {
  const consolidateProcess = getImproveProcessConfig(config, "consolidate");
  const runnerSpec = resolveImproveProcessRunnerFromProfile(consolidateProcess, config);
  if (runnerSpec && runnerIsLlm(runnerSpec)) {
    return runnerSpec.connection;
  }
  // Non-LLM runner modes (agent/sdk) don't apply to consolidate's HTTP path;
  // fall back to the default LLM profile rather than disabling the pass.
  return getDefaultLlmConfig(config);
}

// ── Judged-state cache (#581) ────────────────────────────────────────────────

/**
 * Stable content hash for a memory file used by the judged-state cache (#581)
 * and the body-embedding cache (WS-3a). Uses `cacheHash` from dedup.ts
 * (sha256 of the case-preserving stripped body) plus the sorted `tags` list,
 * so semantic-metadata drift re-enters the judge while cosmetic frontmatter
 * touches (`updated:`, `inferenceProcessed:`) still hash identically and never
 * force a needless re-judge. Returns `undefined` on any read/parse error so
 * callers fail open (treat the memory as un-cached → it stays in the LLM pool).
 */
function computeMemoryContentHash(filePath: string): string | undefined {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    let tagSuffix = "";
    try {
      const { data } = parseFrontmatter(raw);
      const tags = Array.isArray(data?.tags) ? data.tags.map(String).sort() : [];
      if (tags.length > 0) tagSuffix = `\n\u0000tags:${tags.join(",")}`;
    } catch {
      // Unparseable frontmatter → body-only hash (prior behaviour).
    }
    return cacheHash(raw + tagSuffix);
  } catch {
    return undefined;
  }
}

/**
 * Build a {@link ConsolidateResult} from partial overrides, filling the envelope
 * defaults (schemaVersion / ok / shape + the zeroed counters). Collapses the
 * ~7 near-identical result literals that previously appeared verbatim at every
 * early-return site and the final return of `akmConsolidateInner`. Callers pass
 * only the fields that differ from the all-zero, ok, non-preview baseline.
 */
export function makeConsolidateResult(
  overrides: Partial<ConsolidateResult> & { target: string; durationMs: number },
): ConsolidateResult {
  return {
    schemaVersion: 1,
    ok: true,
    shape: "consolidate-result",
    dryRun: false,
    previewOnly: false,
    processed: 0,
    merged: 0,
    deleted: 0,
    promoted: [],
    contradicted: 0,
    warnings: [],
    ...overrides,
  };
}

// ── Main entry point ─────────────────────────────────────────────────────────

export async function akmConsolidate(opts: AkmConsolidateOptions = {}): Promise<ConsolidateResult> {
  const startMs = Date.now();
  // Derive a stable PROV-DM token for this run. Callers (e.g. akmImprove)
  // should pass opts.sourceRun to tie proposals back to the parent run;
  // standalone `akm consolidate` gets a self-contained token.
  const sourceRun = opts.sourceRun ?? `consolidate-${startMs}`;
  const config = opts.config ?? loadConfig();
  const stashDir = opts.stashDir ?? resolveStashDir();

  if (!isLlmFeatureEnabled(config, "memory_consolidation")) {
    return makeConsolidateResult({
      dryRun: opts.dryRun ?? false,
      target: opts.target ?? stashDir,
      durationMs: Date.now() - startMs,
    });
  }

  const warnings: string[] = [];
  checkForIncompleteJournal(stashDir, opts.recoveryMode ?? "abort", warnings);

  // WS-3a: open one state.db handle shared by the body-embedding cache (dedup
  // + cluster) and the judged-state cache. All callers in the function body
  // receive this handle; it is closed in the `finally` block below.
  // Fail-open: any open error leaves it `undefined` and all cache paths skip.
  let sharedStateDb: Database | undefined;
  try {
    sharedStateDb = openStateDatabase();
  } catch {
    // State DB unavailable → skip the embedding cache for this run.
  }

  try {
    return await akmConsolidateInner(opts, config, stashDir, startMs, sourceRun, warnings, sharedStateDb);
  } finally {
    sharedStateDb?.close();
  }
}

// Inner implementation — all early-return paths are here; sharedStateDb is
// closed by the outer finally in `akmConsolidate`.
/**
 * Mutable accounting accumulators shared across the plan and apply passes of a
 * single consolidate run. The chunk loop in {@link planConsolidation} populates
 * these; the op-handlers invoked by {@link applyConsolidationPlan} mutate them
 * further via {@link ConsolidateAccounting.pushSkipReason}; the final envelope
 * reads them. Bundled into one object (rather than plain locals) so the passes
 * can be separate functions while threading the same live counters.
 *
 * Invariant: `processed == actioned + judgedNoAction + Σ(skipReasons) +
 * failedChunkMemories`.
 */
interface ConsolidateAccounting {
  /** Memories the LLM saw inside a chunk but proposed no op for. */
  judgedNoAction: number;
  /** Memories in chunks whose LLM call failed or were never attempted. */
  failedChunkMemories: number;
  /** Count of LLM chunks that failed (transport error or invalid plan). */
  totalChunksFailed: number;
  /** Structured per-op skip reasons, one entry per ref. */
  skipReasons: Array<{
    ref: string;
    skips: Array<{ op: ConsolidateOpKind | "unknown"; reason: string }>;
  }>;
  /** Per-ref index into {@link skipReasons} (one accounting bucket per ref). */
  skipReasonByRef: Map<string, { ref: string; skips: Array<{ op: ConsolidateOpKind | "unknown"; reason: string }> }>;
  /** Refs that contributed to judgedNoAction in their own chunk. */
  judgedNoActionRefs: Set<string>;
  /** Record a deterministic post-LLM op rejection for `ref`. */
  pushSkipReason: (op: ConsolidateOpKind | "unknown", ref: string, reason: string) => void;
}

/** Fresh, zeroed accounting accumulators for one consolidate run. */
function createConsolidateAccounting(): ConsolidateAccounting {
  const acc: ConsolidateAccounting = {
    judgedNoAction: 0,
    failedChunkMemories: 0,
    totalChunksFailed: 0,
    skipReasons: [],
    skipReasonByRef: new Map(),
    judgedNoActionRefs: new Set(),
    pushSkipReason: () => {},
  };
  acc.pushSkipReason = (op, ref, reason) => {
    // 2026-05-27 cross-chunk double-count fix: if `ref` already contributed
    // to judgedNoAction in its own chunk (a different chunk proposed an op
    // for it that is now being rejected here), promote it from the
    // judgedNoAction bucket into the more specific skipReason bucket.
    // Preserves the invariant: processed == actioned + judgedNoAction +
    // Σ(skipReasons) + failedChunkMemories.
    if (acc.judgedNoActionRefs.delete(ref)) acc.judgedNoAction--;
    const existing = acc.skipReasonByRef.get(ref);
    if (existing) {
      // Already counted once for accounting. Append the extra skip to the
      // ref's grouped entry for observability without adding a new array
      // entry (which would break the accounting invariant).
      existing.skips.push({ op, reason });
      return;
    }
    const entry = { ref, skips: [{ op, reason }] };
    acc.skipReasonByRef.set(ref, entry);
    acc.skipReasons.push(entry);
  };
  return acc;
}

/**
 * Result of the narrowing pass. Either the run is already decided (an early
 * envelope — empty pool, no incremental candidates, or judged-cache emptied the
 * pool) and `done` carries the finished {@link ConsolidateResult}, or the pool
 * survived narrowing and the pass hands back the filtered memories plus the
 * state the later passes need.
 */
type NarrowPoolResult =
  | { done: true; result: ConsolidateResult }
  | {
      done: false;
      memories: MemoryEntry[];
      dedupCollapsed: number;
      perfMs: { dedupPoolSize: number; judgedCacheSkipped: number };
      judgedCacheEnabled: boolean;
      currentHashByName: Map<string, string>;
    };

/**
 * Pass 1 — narrow the memory pool before any LLM work: drop stale DB entries,
 * partition hot-probation assets, run the deterministic dedup pre-pass, apply
 * incremental-since and judged-state-cache narrowing, and cap to `opts.limit`
 * (oldest-modified first). Returns an early envelope when the pool empties at
 * any stage; otherwise returns the narrowed pool and the state the plan/apply
 * passes consume. Behavior-identical to the former inlined narrowing block.
 */
async function narrowConsolidationPool(
  opts: AkmConsolidateOptions,
  config: AkmConfig,
  stashDir: string,
  startMs: number,
  warnings: string[],
  sharedStateDb: Database | undefined,
): Promise<NarrowPoolResult> {
  let memories = loadMemoriesForSource(opts.target, stashDir, warnings);

  // Pre-flight: filter out stale DB entries whose files no longer exist on
  // disk. Without this, memories deleted by a prior run (but not yet
  // reindexed) appear in chunk prompts, causing the LLM to generate plans
  // against ghost refs and wasting tokens. Filtering here ensures the chunk
  // pool and memoryByRef are authoritative against the actual filesystem state.
  const staleCount = memories.filter((m) => !fs.existsSync(m.filePath)).length;
  if (staleCount > 0) {
    warnings.push(
      `Pre-flight: filtered ${staleCount} stale DB entr${staleCount === 1 ? "y" : "ies"} (file absent on disk) from memory pool before chunking.`,
    );
  }
  memories = memories.filter((m) => fs.existsSync(m.filePath));

  // (The former WS-3b Step 0a homeostatic demotion pass was removed — R4:
  // it was default-off and self-undoing (the next salience recompute
  // unconditionally overwrote the demoted values). Continuous decay now lives
  // in computeSalience's recency term, whose floor decays on a long half-life.)

  // ── WS-3b Step 0c: Filter hot-probation assets from LLM merge pool ─────────
  // Hot-probation assets (system-generated, not yet graduated from intake pass)
  // are processed by the dedup pre-pass but excluded from the LLM clustering.
  // This prevents noisy extractions from polluting LLM context. The dedup pass
  // below still runs against them so they're cleaned up deterministically.
  // DEFAULT OFF — only active when `processes.extract.hotProbation.enabled === true`
  // (the flag that causes extract to tag new extractions as hot-probation).
  // Without that flag no assets will ever carry the hot-probation marker, so
  // running the filter loop would be pure unnecessary I/O over the full corpus.
  const hotProbationEnabled =
    (getImproveProcessConfig(config, "extract")?.hotProbation as { enabled?: boolean } | undefined)?.enabled === true;
  let hotProbationCount = 0;
  if (hotProbationEnabled) {
    const hotProbationMemories: typeof memories = [];
    const nonProbationMemories: typeof memories = [];
    for (const m of memories) {
      try {
        const raw = fs.readFileSync(m.filePath, "utf8");
        const parsed = parseFrontmatter(raw);
        if (shouldSkipHotProbationInLlm(parsed.data as Record<string, unknown>)) {
          hotProbationMemories.push(m);
          hotProbationCount++;
        } else {
          nonProbationMemories.push(m);
        }
      } catch {
        nonProbationMemories.push(m); // fail open
      }
    }
    if (hotProbationCount > 0) {
      warnings.push(
        `Hot-probation: ${hotProbationCount} hot-probation asset(s) routed to dedup-only pass (excluded from LLM merge pool).`,
      );
      memories = nonProbationMemories;
    }
  }

  // ── Deterministic dedup pre-pass (#617) ─────────────────────────────────────
  // Cheap, no-LLM fast path that collapses the obvious near-duplicates
  // (`.derived` ↔ origin pairs + content twins) BEFORE the embedding-clustered
  // LLM consolidation. DEFAULT OFF — when `dedup.enabled !== true` this is a
  // no-op and the pass behaves byte-identically to today. Collapsed variants
  // are pruned from the LLM pool so the model only ever sees genuinely
  // distinct-but-related memories. Each dropped variant is archived (soft
  // invalidation) before deletion, matching the LLM merge path.
  // Dry-run never mutates the filesystem, so the dedup pre-pass is skipped
  // entirely under `--dry-run` (the LLM plan preview below is unaffected).
  let dedupCollapsed = 0;
  if (opts.dedup?.enabled && !opts.dryRun) {
    const dedupTimestamp = timestampForFilename();
    const dedupResult = await runDeterministicDedup(
      stashDir,
      opts.dedup,
      config,
      (variantFilePath, variantName) => {
        archiveMemory(
          variantFilePath,
          stashDir,
          `memory:${variantName}`,
          "collapsed by deterministic dedup pre-pass",
          -1,
          undefined,
          warnings,
        );
        backupFile(variantFilePath, getBackupDir(stashDir, dedupTimestamp), variantName);
      },
      opts.signal,
      sharedStateDb,
    );
    dedupCollapsed = dedupResult.collapsed;
    warnings.push(...dedupResult.warnings);
    if (dedupResult.consumedRefs.length > 0) {
      const consumed = new Set(dedupResult.consumedRefs);
      memories = memories.filter((m) => !consumed.has(`memory:${m.name}`));
      warnings.push(
        `Deterministic dedup: collapsed ${dedupResult.collapsed} near-duplicate memor${dedupResult.collapsed === 1 ? "y" : "ies"} (no LLM) before chunking.`,
      );
    }
  }

  if (memories.length === 0) {
    return {
      done: true,
      result: makeConsolidateResult({
        dryRun: opts.dryRun ?? false,
        target: opts.target ?? stashDir,
        // #617: the deterministic dedup pre-pass may have emptied the pool by
        // collapsing every remaining memory into a canonical. Surface those
        // collapses in `deleted` so the run reports the work it actually did.
        deleted: dedupCollapsed,
        warnings,
        durationMs: Date.now() - startMs,
      }),
    };
  }

  if (opts.incrementalSince) {
    memories = narrowToIncrementalCandidates(memories, opts.incrementalSince, warnings, opts.neighborsPerChanged);
    if (memories.length === 0) {
      return {
        done: true,
        result: makeConsolidateResult({
          dryRun: opts.dryRun ?? false,
          target: opts.target ?? stashDir,
          warnings,
          durationMs: Date.now() - startMs,
        }),
      };
    }
  }

  // WS-5 perf telemetry accumulators. These are collected throughout the run and
  // merged into `perfTelemetry` on the final ConsolidateResult.
  // `dedupPoolSize` = memories entering judgedCache narrowing (after dedup+incremental+limit).
  // `judgedCacheSkipped` = memories skipped by the cache.
  // `llmPoolSize` = memories actually sent to the LLM.
  // `embedMs/cacheHits/cacheMisses` = accumulated from clusterMemoriesBySimilarity.
  const perfMs = { dedupPoolSize: memories.length, judgedCacheSkipped: 0 };

  // ── Judged-state cache narrowing (#581) ─────────────────────────────────────
  // DEFAULT OFF. When enabled, skip every memory whose current content hash
  // equals the hash recorded the last time the consolidate LLM judged it
  // (judged-unchanged → no re-judge). This converts coverage from O(window) to
  // O(changed/new) so one run can sweep the whole corpus while the LLM only
  // sees genuinely new/changed memories. `currentHashByName` is populated for
  // EVERY surviving memory (whether or not the cache is on) so the post-LLM
  // recording step can upsert judged state without re-reading the files; when
  // the cache is off it stays empty and the recording step is a no-op.
  const judgedCacheEnabled = opts.judgedCache?.enabled !== false;
  const currentHashByName = new Map<string, string>();
  if (judgedCacheEnabled) {
    for (const m of memories) {
      const h = computeMemoryContentHash(m.filePath);
      if (h !== undefined) currentHashByName.set(m.name, h);
    }
    let cachedMap = new Map<string, ConsolidationJudgedRow>();
    {
      // Use the shared state.db handle if available; open a local one otherwise.
      const dbForJudged = sharedStateDb;
      if (dbForJudged) {
        try {
          cachedMap = getConsolidationJudgedMap(
            dbForJudged,
            memories.map((m) => `memory:${m.name}`),
          );
        } catch {
          cachedMap = new Map();
        }
      } else {
        try {
          cachedMap = withStateDb((localDb) =>
            getConsolidationJudgedMap(
              localDb,
              memories.map((m) => `memory:${m.name}`),
            ),
          );
        } catch {
          // State DB unavailable → fail open: judge the full pool this run.
          cachedMap = new Map();
        }
      }
    }
    const beforeCount = memories.length;
    memories = memories.filter((m) => {
      const cur = currentHashByName.get(m.name);
      // No readable hash → keep (fail open; let the LLM judge it).
      if (cur === undefined) return true;
      const cached = cachedMap.get(`memory:${m.name}`);
      // Skip only when previously judged AND content is byte-identical since.
      return !(cached !== undefined && cached.content_hash === cur);
    });
    const skipped = beforeCount - memories.length;
    perfMs.judgedCacheSkipped = skipped; // WS-5 perf telemetry
    if (skipped > 0) {
      warnings.push(
        `Judged-state cache: skipped ${skipped} memor${skipped === 1 ? "y" : "ies"} judged-unchanged (no LLM); ${memories.length} remain for judging.`,
      );
    }
    if (memories.length === 0) {
      return {
        done: true,
        result: makeConsolidateResult({
          dryRun: opts.dryRun ?? false,
          target: opts.target ?? stashDir,
          deleted: dedupCollapsed,
          warnings,
          durationMs: Date.now() - startMs,
        }),
      };
    }
  }

  if (opts.limit === undefined && memories.length > 150) {
    warnings.push(
      `Consolidation: pool has ${memories.length} memories and no limit is set. Consider adding a limit to your consolidate config to prevent timeouts on slow LLM endpoints.`,
    );
  }

  if (opts.limit !== undefined && memories.length > opts.limit) {
    // Order oldest-modified-first before capping so the limit selects the
    // stalest memories rather than a fixed head of the (rowid-ordered) DB
    // query. Consolidation rewrites surviving files, bumping their mtime, so
    // processed memories drift to the back of the queue and the cap rotates
    // across the whole corpus over successive runs instead of revisiting the
    // same slice every time. Fail-open to 0 (front of queue) when a file can
    // no longer be stat'd.
    const mtimeOf = (m: MemoryEntry): number => {
      try {
        return fs.statSync(m.filePath).mtimeMs;
      } catch {
        return 0;
      }
    };
    const mtimeCache = new Map<string, number>(memories.map((m) => [m.filePath, mtimeOf(m)]));
    memories = [...memories].sort((a, b) => (mtimeCache.get(a.filePath) ?? 0) - (mtimeCache.get(b.filePath) ?? 0));
    warnings.push(
      `Consolidation: pool capped at ${opts.limit} of ${memories.length} memories (limit option, oldest-modified first).`,
    );
    memories = memories.slice(0, opts.limit);
  }

  return { done: false, memories, dedupCollapsed, perfMs, judgedCacheEnabled, currentHashByName };
}

/**
 * Pass 2 — turn the narrowed pool into an executable plan. Sizes chunks to the
 * model context window, clusters by embedding similarity, injects the
 * anti-collapse random fraction, applies the cold-start budget cap, runs the
 * per-chunk LLM calls (with retry + failure-rate abort), records judged-state
 * cache outcomes, and reconciles the per-chunk op arrays via {@link mergePlans}.
 * Populates `accounting` in place. Behavior-identical to the former inlined
 * plan-generation block.
 */
async function planConsolidation(
  opts: AkmConsolidateOptions,
  config: AkmConfig,
  stashDir: string,
  startMs: number,
  memories: MemoryEntry[],
  warnings: string[],
  sharedStateDb: Database | undefined,
  judgedCacheEnabled: boolean,
  currentHashByName: Map<string, string>,
  accounting: ConsolidateAccounting,
): Promise<{
  allOps: ConsolidateOperation[];
  totalChunks: number;
  llmPoolSize: number;
  embedTelemetry: ClusterEmbedTelemetry;
  isHttpPath: boolean;
  sourceName: string;
}> {
  // Consolidation always uses the HTTP LLM client directly — never the agent
  // CLI. The agent CLI is for interactive agent sessions (reflect, propose);
  // structured JSON generation works better and faster via HTTP.
  //
  // Honor `profiles.improve.default.processes.consolidate.profile` first; fall
  // back to the default LLM. See {@link resolveConsolidateLlmConfig}.
  const llmConfig = resolveConsolidateLlmConfig(config);
  const isHttpPath = !!llmConfig;

  // Chunk sizing: derive a safe chunk size from the configured model context
  // window so that the full prompt (system prompt + chunk user prompt) never
  // exceeds the model's n_ctx limit.  When no context length is configured we
  // fall back to DEFAULT_CONTEXT_LENGTH_TOKENS (8 000) which is conservative
  // enough for most 8K–16K local models.
  //
  // bodyTruncation caps the body excerpt included per memory in the prompt.
  // Reducing it further than 500 chars degrades consolidation quality, so we
  // keep it fixed and let computeSafeChunkSize vary the number of memories
  // per chunk instead.
  const bodyTruncation = 500;
  const modelContextLength = llmConfig?.contextLength ?? DEFAULT_CONTEXT_LENGTH_TOKENS;
  const chunkSize = computeSafeChunkSize(modelContextLength, bodyTruncation, opts.maxChunkSize);

  // -- Phase A: plan generation -----------------------------------------------
  const sourceName = opts.target ?? stashDir;

  // WS-5: capture llmPoolSize = memories entering the LLM (after all filtering).
  const llmPoolSize = memories.length;

  // C-1 / #380: Pre-cluster memories by embedding similarity before chunking.
  // This ensures that semantically similar memories land in the same LLM
  // context window, allowing the model to detect and merge duplicates that
  // would otherwise be split across chunks and survive indefinitely.
  // mem0 arXiv:2504.19413, A-MEM arXiv:2502.12110.
  // Fails open: if embeddings are unavailable or fail, original order is used.
  const { ordered: clusteredMemories, embedTelemetry } = await clusterMemoriesBySimilarity(
    memories,
    config,
    sharedStateDb,
  );

  // WS-3b Anti-collapse step 8c: inject random (non-similar) clusters.
  // A small fraction (default 5%) of the pool is shuffled into random positions
  // so the pipeline isn't PURELY similarity-driven. This prevents rich-get-richer
  // entrenchment where only the most-retrieved assets ever get consolidated.
  // DEFAULT ON since R5 — opt out via antiCollapse.enabled: false.
  let finalClusteredMemories = clusteredMemories;
  {
    const antiCollapseForCluster: AntiCollapseConfig =
      (getImproveProcessConfig(config, "consolidate")?.antiCollapse as AntiCollapseConfig | undefined) ?? {};
    if (antiCollapseForCluster.enabled !== false && clusteredMemories.length > 2) {
      const fraction = antiCollapseForCluster.randomClusterFraction ?? 0.05;
      const randomCount = Math.max(1, Math.floor(clusteredMemories.length * fraction));
      // Pick `randomCount` positions to inject random (un-clustered) members.
      // Use a seeded-ish shuffle: sort by hash of the name so it's deterministic
      // per run but not strictly similarity-driven.
      const shuffled = [...clusteredMemories].sort((a, b) => {
        // Deterministic shuffle: compare sha256-ish (use name hash as proxy).
        const ha = a.name.split("").reduce((acc, c) => ((acc << 5) - acc + c.charCodeAt(0)) | 0, 0);
        const hb = b.name.split("").reduce((acc, c) => ((acc << 5) - acc + c.charCodeAt(0)) | 0, 0);
        return ha - hb;
      });
      const randomSlice = shuffled.slice(0, randomCount);
      const randomSet = new Set(randomSlice.map((m) => m.name));
      // Insert random members at intervals through the clustered sequence.
      const withRandom: MemoryEntry[] = [];
      const interval = Math.max(2, Math.floor(clusteredMemories.length / randomCount));
      let randomIdx = 0;
      for (let i = 0; i < clusteredMemories.length; i++) {
        const m = clusteredMemories[i];
        if (m && !randomSet.has(m.name)) withRandom.push(m);
        if (i > 0 && i % interval === 0 && randomIdx < randomSlice.length) {
          const r = randomSlice[randomIdx++];
          if (r) withRandom.push(r);
        }
      }
      // Append any remaining random members not yet inserted.
      while (randomIdx < randomSlice.length) {
        const r = randomSlice[randomIdx++];
        if (r) withRandom.push(r);
      }
      finalClusteredMemories = withRandom;
      warnings.push(
        `Anti-collapse: injected ${randomCount} random (non-similarity-driven) cluster member(s) into consolidation pool (fraction=${fraction}).`,
      );
    }
  }

  const chunks: MemoryEntry[][] = [];
  for (let i = 0; i < finalClusteredMemories.length; i += chunkSize) {
    chunks.push(finalClusteredMemories.slice(i, i + chunkSize));
  }

  // 2026-05-27 prompt-context fix: precompute body-hashes of pending
  // consolidate proposals once, so the per-chunk prompt can annotate
  // memories whose body would just produce a deterministic
  // `dedup_pending_proposal` skip. Cuts ~110 wasted LLM proposals per
  // 4h on this user's stack. See
  // /tmp/akm-health-investigations/tuning-reasons-investigation.md §Q3.
  const pendingProposalBodyHashes = loadPendingConsolidateProposalHashes(stashDir);

  // ── Cold-start budget estimation ─────────────────────────────────────────────
  // Estimate wall-clock cost BEFORE issuing any LLM calls. When a signal is
  // provided and the estimated cost exceeds ~60% of the remaining budget we
  // auto-reduce the pool and log the reduction so the run never starts work
  // it cannot finish (avoiding SIGTERM mid-LLM-call).
  //
  // Formula: chunks.length × p90_chunk_seconds. The p90 comes from
  // `opts.p90ChunkSecondsDefault` (caller-supplied, typically from the profile
  // config); absent = 30 s (conservative default matching a medium local LLM).
  //
  // "Remaining budget" is read from a custom property on the AbortSignal if
  // the caller (improve.ts) has attached one. Without it no auto-reduction
  // fires but the check is still cheap to run.
  if (chunks.length > 10 && opts.signal) {
    const p90Chunk = opts.p90ChunkSecondsDefault ?? 30;
    const estimatedSeconds = chunks.length * p90Chunk;
    // remainingBudgetMs is a non-standard extension set by improve.ts when it
    // creates the budget AbortController. Undefined = no budget information.
    const budgetMs = (opts.signal as AbortSignal & { remainingBudgetMs?: number }).remainingBudgetMs;
    if (budgetMs !== undefined && budgetMs > 0) {
      const remainingSeconds = budgetMs / 1000;
      if (estimatedSeconds > remainingSeconds * 0.6) {
        const safeCaps = Math.max(1, Math.floor((remainingSeconds * 0.6) / p90Chunk));
        const removedChunks = chunks.length - safeCaps;
        if (removedChunks > 0) {
          const msg =
            `[consolidate] cold-start budget: estimated ${estimatedSeconds.toFixed(0)}s > 60% of remaining ${remainingSeconds.toFixed(0)}s; ` +
            `reducing pool from ${chunks.length} to ${safeCaps} chunks (${removedChunks} deferred to next run).`;
          warn(msg);
          warnings.push(msg);
          chunks.splice(safeCaps);
        }
      }
    }
  }

  warn(
    `[consolidate] ${memories.length} memories / ${chunks.length} chunk(s) / chunk_size=${chunkSize}` +
      ` / pending-proposal hashes: ${pendingProposalBodyHashes.size}`,
  );

  // Consolidate output merges memories (non-wiki) → stash authoring standards.
  // Resolved ONCE per run and passed to each chunk prompt (facts not re-read
  // per chunk).
  const standardsContext = resolveStashStandards(stashDir);

  const chunkOpsArrays: ConsolidateOperation[][] = [];
  // judgedNoAction tracks memories the LLM saw inside a chunk but proposed
  // no op for. Computed per chunk as `chunk.length − unique(targetRefs in ops)`.
  // The structured skip-reason histogram (2026-05-26) plus the cross-chunk
  // double-count fixes now live on `accounting`; every deterministic post-LLM
  // op rejection site calls `accounting.pushSkipReason`. See
  // `/tmp/akm-health-investigations/tuning-reasons-investigation.md` §Q2.
  //
  // Judged-state cache (#581): coarse outcome per memory NAME the LLM actually
  // judged in a successfully-parsed chunk this run. "actioned" = an op targeted
  // it; "no_action" = the LLM saw it and proposed nothing. Populated only when
  // the cache is enabled (otherwise it stays empty and the post-loop recording
  // step is a no-op). Memories in failed/aborted chunks are NOT recorded, so a
  // transient LLM failure never poisons the cache into skipping them next run.
  const judgedOutcomeByName = new Map<string, "actioned" | "no_action">();
  // C-6 / #392: Replace two-consecutive-failures abort with failure-rate threshold.
  // Consecutive-count policies are brittle against transient LM Studio reloads:
  // two transient failures abort the run even though the next chunk would succeed.
  // Rate-based abort (≥50% failure over ≥4 chunks) is more robust.
  // Tanenbaum, Distributed Systems §8 — rate-based policies with minimum sample sizes.
  let totalChunksProcessed = 0;
  const ABORT_MIN_CHUNKS = 4;
  const ABORT_FAILURE_RATE = 0.5;

  for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx++) {
    // Budget-signal check: break cleanly before the next LLM call if the
    // caller's budget has been exhausted. Commits work done so far.
    if (opts.signal?.aborted) {
      const skipped = chunks.length - chunkIdx;
      const msg = `[consolidate] budget signal aborted before chunk ${chunkIdx + 1}/${chunks.length}; ${skipped} chunk(s) not processed (partial_timeout — work done so far committed).`;
      warn(msg);
      warnings.push(msg);
      // Account for memories in unprocessed chunks.
      for (let i = chunkIdx; i < chunks.length; i++) {
        accounting.failedChunkMemories += (chunks[i] as MemoryEntry[]).length;
      }
      break;
    }

    // Abort if failure rate >= 50% over at least 4 processed chunks.
    if (totalChunksProcessed >= ABORT_MIN_CHUNKS) {
      const failureRate = accounting.totalChunksFailed / totalChunksProcessed;
      if (failureRate >= ABORT_FAILURE_RATE) {
        const skipped = chunks.length - chunkIdx;
        const abortMsg = `Consolidation aborted — failure rate ${(failureRate * 100).toFixed(0)}% over ${totalChunksProcessed} chunks (>= ${ABORT_FAILURE_RATE * 100}% threshold). LLM may be unavailable. ${skipped} chunk(s) skipped.`;
        warn(abortMsg);
        warnings.push(abortMsg);
        // Account for memories in chunks we never attempted: they are
        // neither judgedNoAction (no plan parsed) nor skipReason (no op
        // rejected). Without this, the accounting invariant fails by
        // `Σ(unattempted_chunk.length)` whenever the abort fires.
        for (let i = chunkIdx; i < chunks.length; i++) {
          accounting.failedChunkMemories += chunks[i].length;
        }
        break;
      }
    }

    const chunk = chunks[chunkIdx];

    // All-hot chunk early-exit. The per-prompt hot-list block (see
    // buildChunkPrompt) only *discourages* delete proposals on a mixed chunk;
    // when EVERY memory in the chunk is captureMode: hot, the only ops the LLM
    // could ever propose are deletes — all of which the downstream guard
    // refuses unconditionally. Calling the model is therefore pure token waste.
    // Skip the request entirely and bucket every memory as judgedNoAction (we
    // judged "no action" without spending an LLM call), preserving the
    // accounting invariant `processed == actioned + judgedNoAction +
    // Σ(skipReasons) + failedChunkMemories`. Not counted toward the
    // LLM-failure-rate abort policy — no request was attempted.
    if (chunk.length > 0 && chunk.every((m) => isHotCapturedMemory(m.filePath))) {
      for (const m of chunk) accounting.judgedNoActionRefs.add(`memory:${m.name}`);
      accounting.judgedNoAction += chunk.length;
      warn(
        `[consolidate] chunk ${chunkIdx + 1}/${chunks.length}: all ${chunk.length} memories are captureMode: hot — skipping LLM (judged no-action).`,
      );
      continue;
    }

    warn(`[consolidate] chunk ${chunkIdx + 1}/${chunks.length} (${chunk.length} memories) …`);
    const userPrompt = buildChunkPrompt(
      sourceName,
      chunk,
      chunkIdx,
      chunks.length,
      bodyTruncation,
      pendingProposalBodyHashes,
      standardsContext,
    );

    // Single chunk LLM call, wrapped in the feature gate. Deduplicated across
    // the first attempt and the retry below (the two blocks were byte-identical
    // apart from their fallback error string). responseSchema lift (PR 1,
    // asset-writers-investigation §5): providers with `supportsJsonSchema: true`
    // enforce the shape upstream; others fall through to
    // `parseEmbeddedJsonResponse` on the response side.
    const callChunkLlm = (fallbackError: string) =>
      tryLlmFeature(
        "memory_consolidation",
        config,
        async () => {
          if (!llmConfig) return { ok: false as const, error: "No LLM configured for consolidation" };
          try {
            const content = await chatCompletion(
              llmConfig,
              [
                { role: "system", content: CONSOLIDATE_SYSTEM_PROMPT },
                { role: "user", content: userPrompt },
              ],
              { responseSchema: CONSOLIDATE_PLAN_JSON_SCHEMA, enableThinking: false },
            );
            return { ok: true as const, content };
          } catch (e) {
            return { ok: false as const, error: String(e) };
          }
        },
        { ok: false as const, error: fallbackError },
      );

    let raw = await callChunkLlm(`chunk ${chunkIdx + 1} failed`);

    if (!raw.ok) {
      // Single retry with 2s backoff before recording chunk as lost.
      // Recovers transient Shredder LM Studio timeouts without significantly
      // extending run time. Only marks failed if both attempts fail.
      await new Promise<void>((r) => setTimeout(r, 2_000));
      const retry = await callChunkLlm(`chunk ${chunkIdx + 1} retry failed`);
      if (!retry.ok) {
        warn(retry.error ?? `chunk ${chunkIdx + 1} failed after retry`);
        warnings.push(retry.error ?? `chunk ${chunkIdx + 1} failed after retry`);
        totalChunksProcessed++;
        accounting.totalChunksFailed++;
        // Account for the chunk's memories under the failed-chunk bucket.
        // judgedNoAction does NOT run on this path (it's after the success
        // guards) so without this the accounting invariant breaks on every
        // chunk-level transport/parse failure.
        accounting.failedChunkMemories += chunk.length;
        continue;
      }
      raw = retry;
    }

    if (process.env.AKM_DEBUG_LLM) {
      const preview = (raw.content ?? "").slice(0, 500);
      warn(`[akm:consolidate] chunk ${chunkIdx + 1} raw response (first 500 chars): ${preview}`);
    }

    const parsed = parseEmbeddedJsonResponse<RawChunkPlan>(raw.content);
    if (!parsed || !Array.isArray(parsed.operations)) {
      const hint =
        raw.content !== undefined && raw.content.trim() === ""
          ? " (empty response — if using a thinking model, disable thinking mode)"
          : "";
      warn(`Chunk ${chunkIdx + 1}: invalid plan from AI — skipping.${hint}`);
      warnings.push(`Chunk ${chunkIdx + 1}: invalid plan from AI — skipping.${hint}`);
      totalChunksProcessed++;
      accounting.totalChunksFailed++;
      accounting.failedChunkMemories += chunk.length;
      continue;
    }

    totalChunksProcessed++; // success

    const ops: ConsolidateOperation[] = [];
    for (const op of parsed.operations) {
      if (isValidOp(op)) {
        ops.push(op);
      } else {
        warnings.push(`Chunk ${chunkIdx + 1}: skipping invalid operation: ${JSON.stringify(op)}`);
      }
    }
    if (Array.isArray(parsed.warnings)) {
      for (const w of parsed.warnings) {
        if (typeof w === "string") warnings.push(w);
      }
    }

    // Per-chunk judgedNoAction: count memories the LLM saw but proposed no
    // op for. Membership is by `memory:<name>` ref against the targets of
    // each op (primary + secondaries for merge; ref otherwise). 2026-05-26:
    // pre-fix this was a 78/119 (66%) silent drop in the cron run — no
    // warning, event, or counter. See tuning investigation §Q2.
    const targetRefs = new Set<string>();
    for (const op of ops) {
      if (op.op === "merge") {
        targetRefs.add(op.primary);
        for (const s of op.secondaries) targetRefs.add(s);
      } else {
        targetRefs.add(op.ref);
      }
    }
    let chunkNoAction = 0;
    for (const m of chunk) {
      const memRef = `memory:${m.name}`;
      if (!targetRefs.has(memRef)) {
        chunkNoAction++;
        accounting.judgedNoActionRefs.add(memRef);
        // Judged-state cache (#581): the LLM saw this memory and proposed
        // nothing → record judged-unchanged so the next run can skip it.
        if (judgedCacheEnabled) judgedOutcomeByName.set(m.name, "no_action");
      } else if (judgedCacheEnabled) {
        // An op targeted this memory → it was judged + actioned.
        judgedOutcomeByName.set(m.name, "actioned");
      }
    }
    accounting.judgedNoAction += chunkNoAction;

    chunkOpsArrays.push(ops);
  }

  // ── Judged-state cache recording (#581) ─────────────────────────────────────
  // Persist judged state for every memory the LLM actually judged this run so
  // the next run can skip the unchanged ones. Keyed by current content hash so
  // a later body edit (different hash) re-enters the LLM pool. DEFAULT OFF and
  // skipped under --dry-run (dry-run mutates nothing). Failed/aborted chunks
  // contributed no entries to `judgedOutcomeByName`, so a transient LLM outage
  // never caches a memory as judged.
  if (judgedCacheEnabled && !opts.dryRun && judgedOutcomeByName.size > 0) {
    // Use the shared state.db handle; open a local one as fallback.
    const doRecord = (db: ReturnType<typeof openStateDatabase>) => {
      const judgedAt = new Date(startMs).toISOString();
      for (const [name, outcome] of judgedOutcomeByName) {
        const hash = currentHashByName.get(name);
        if (hash === undefined) continue;
        upsertConsolidationJudged(db, {
          entryKey: `memory:${name}`,
          contentHash: hash,
          judgedAt,
          outcome,
        });
      }
    };
    if (sharedStateDb) {
      try {
        doRecord(sharedStateDb);
      } catch (e) {
        warnings.push(`Judged-state cache: failed to record judged state: ${String(e)}`);
      }
    } else {
      try {
        withStateDb((localDb) => doRecord(localDb));
      } catch (e) {
        warnings.push(`Judged-state cache: failed to record judged state: ${String(e)}`);
      }
    }
  }

  // Build the known-refs set from the already-filtered memory pool so
  // mergePlans() can reject LLM-hallucinated primary refs before execution.
  const knownRefs = new Set(memories.map((m) => `memory:${m.name}`));
  const { ops: allOps, warnings: mergeWarnings } = mergePlans(chunkOpsArrays, knownRefs);
  warnings.push(...mergeWarnings);

  return { allOps, totalChunks: chunks.length, llmPoolSize, embedTelemetry, isHttpPath, sourceName };
}

/**
 * Pass 3 — execute the reconciled plan against the filesystem: resolve the
 * write target, journal the batch, dispatch each op to its handler, then commit
 * the batch at the boundary and clean up the journal. Mutates `accounting` via
 * the op-handlers' `pushSkipReason`. Behavior-identical to the former inlined
 * write block. Never invoked on the dry-run or aborted-confirm paths.
 */
async function applyConsolidationPlan(
  config: AkmConfig,
  stashDir: string,
  sourceRun: string,
  memories: MemoryEntry[],
  warnings: string[],
  allOps: ConsolidateOperation[],
  accounting: ConsolidateAccounting,
  dedupCollapsed: number,
): Promise<{
  merged: number;
  deleted: number;
  contradicted: number;
  mergeFloorViolations: number;
  mergedSecondaries: number;
  promoted: string[];
}> {
  // -- Phase B + writes -------------------------------------------------------
  const target = resolveWriteTarget(config);
  const timestamp = timestampForFilename();
  const backupDir = getBackupDir(stashDir, timestamp);

  // Write journal before any mutations
  writeJournal(stashDir, allOps, timestamp);

  const counts = {
    merged: 0,
    deleted: 0,
    contradicted: 0, // C-3 / #382: count of contradiction edges written
    mergeFloorViolations: 0, // R5 §4.2: advisory merge-information-floor failures
    mergedSecondaries: 0,
  };
  const promoted: string[] = [];

  // Within-run dedup: track source refs for which a promote proposal was
  // already created this run. The LLM can return multiple promote ops for
  // different source memories that happen to have identical content (all are
  // duplicate memories), so we also need a content-hash guard below.
  const promotedSourceRefs = new Set<string>();

  // Build a lookup map: ref → MemoryEntry
  const memoryByRef = new Map<string, MemoryEntry>();
  for (const m of memories) {
    memoryByRef.set(`memory:${m.name}`, m);
  }

  const opCtx: ConsolidateOpContext = {
    config,
    stashDir,
    sourceRun,
    target,
    backupDir,
    memoryByRef,
    promoted,
    promotedSourceRefs,
    warnings,
    counts,
    pushSkipReason: accounting.pushSkipReason,
  };

  // Thin dispatch over the op discriminator — each branch is now an isolated,
  // independently-testable handler that mutates `opCtx`.
  for (let opIndex = 0; opIndex < allOps.length; opIndex++) {
    const op = allOps[opIndex];
    const opDisplayRef =
      op.op === "merge" ? op.primary : op.op === "contradict" ? `${op.ref} ↔ ${op.contradictedByRef}` : op.ref;
    warn(`[consolidate] ${opIndex + 1}/${allOps.length} ${op.op} ${opDisplayRef}`);
    switch (op.op) {
      case "merge":
        await handleMergeOp(op, opIndex, opCtx);
        break;
      case "delete":
        await handleDeleteOp(op, opIndex, opCtx);
        break;
      case "promote":
        await handlePromoteOp(op, opCtx);
        break;
      case "contradict":
        await handleContradictOp(op, opCtx);
        break;
    }
  }

  const { merged, deleted, contradicted, mergeFloorViolations, mergedSecondaries } = counts;

  // 0.9.0 (issue #507): batch-at-boundary commit. The merge/delete loop above
  // wrote one merged primary and deleted N secondaries to the resolved target
  // with NO per-asset commit. If the target is a writable git source and any
  // asset was mutated, commit the whole batch ONCE here (stages .akm/ +
  // siblings together). No-op for filesystem/primary-stash targets.
  if (merged > 0 || deleted > 0) {
    commitWriteTargetBoundary(target, `Consolidate: ${merged} merged, ${deleted} removed`);
  }

  cleanupJournal(stashDir, timestamp);

  // [signoff 2026-06-15] TTL archive cleanup machinery RETIRED (WS-3a).
  // The elaborate archiveRetentionDays / archive-dir scan existed only to satisfy
  // the old irrecoverability constraint. Stashes are now git-backed, so git
  // history is the recovery path — no bespoke archive TTL needed. Any files in
  // .akm/archive/ will stay there harmlessly until the operator prunes them with
  // `git rm` or `find .akm/archive -mtime +90 -delete`. Changed N files this
  // run; recover any via `git show <sha>:<path>` or `git restore <path>`.
  if (merged > 0 || deleted > 0 || dedupCollapsed > 0) {
    const totalChanged = merged + deleted + dedupCollapsed;
    warnings.push(
      `Changed ${totalChanged} file(s) this run. Recover any via git if needed (git history is the backstop).`,
    );
  }

  return { merged, deleted, contradicted, mergeFloorViolations, mergedSecondaries, promoted };
}

async function akmConsolidateInner(
  opts: AkmConsolidateOptions,
  config: import("../../core/config/config").AkmConfig,
  stashDir: string,
  startMs: number,
  sourceRun: string,
  warnings: string[],
  sharedStateDb: Database | undefined,
): Promise<ConsolidateResult> {
  // -- Pass 1: narrow the memory pool (may early-return an envelope) ----------
  const narrowed = await narrowConsolidationPool(opts, config, stashDir, startMs, warnings, sharedStateDb);
  if (narrowed.done) return narrowed.result;
  const { memories, dedupCollapsed, perfMs, judgedCacheEnabled, currentHashByName } = narrowed;

  // -- Pass 2: build the LLM plan (populates the shared accounting counters) ---
  const accounting = createConsolidateAccounting();
  const { allOps, totalChunks, llmPoolSize, embedTelemetry, isHttpPath, sourceName } = await planConsolidation(
    opts,
    config,
    stashDir,
    startMs,
    memories,
    warnings,
    sharedStateDb,
    judgedCacheEnabled,
    currentHashByName,
    accounting,
  );

  // -- Dry-run: show AI plan without executing any writes --------------------
  if (opts.dryRun) {
    return makeConsolidateResult({
      dryRun: true,
      previewOnly: true,
      target: sourceName,
      processed: memories.length,
      failedChunks: accounting.totalChunksFailed,
      totalChunks,
      judgedNoAction: accounting.judgedNoAction,
      skipReasons: accounting.skipReasons,
      // No merge has executed on the preview path — the per-secondary tally is
      // provably still 0 here (it only increments in the op-execution loop).
      mergedSecondaries: 0,
      failedChunkMemories: accounting.failedChunkMemories,
      planned: allOps,
      warnings,
      durationMs: Date.now() - startMs,
    });
  }

  warn(`[consolidate] plan: ${allOps.length} operation(s)`);

  // -- HTTP path: warn about quality and confirm unless auto-accepted --------
  if (isHttpPath) {
    warnings.push("Running on HTTP path — plan generated from truncated memory excerpts; quality may vary.");
    // Per-proposal confidence gating is handled by the caller (improve.ts)
    // via runAutoAcceptGate after this function returns. The gate reads
    // proposal.confidence (forwarded from op.confidence above) and applies
    // a minimumThreshold floor of 95 for consolidate's destructive ops.
    // Here we only gate the interactive-confirm path for manual/HTTP invocations.
    if (opts.autoAccept === undefined && allOps.length > 0) {
      const n = allOps.length;
      // Non-interactive contexts (CI / test runners / piped stdin) must not
      // block on an unanswerable prompt. Default to a non-destructive "no"
      // so callers in those contexts get the same "aborted, preview only"
      // shape they'd get from explicit user dismissal. AKM_NON_INTERACTIVE
      // lets callers force this path even when stdin happens to be a TTY.
      const nonInteractive = process.stdin.isTTY === false || process.env.AKM_NON_INTERACTIVE === "1";
      const answer = nonInteractive ? false : await promptConfirm(`Apply ${n} operations? [y/N] `);
      if (!answer) {
        return makeConsolidateResult({
          previewOnly: true,
          target: sourceName,
          processed: memories.length,
          failedChunks: accounting.totalChunksFailed,
          totalChunks,
          judgedNoAction: accounting.judgedNoAction,
          skipReasons: accounting.skipReasons,
          // No merge executed on the abort path — mergedSecondaries is still 0.
          mergedSecondaries: 0,
          failedChunkMemories: accounting.failedChunkMemories,
          planned: allOps,
          warnings: [...warnings, nonInteractive ? "Non-interactive context: skipped apply." : "Aborted by user."],
          durationMs: Date.now() - startMs,
        });
      }
    }
  }

  // -- Pass 3: execute the plan against the filesystem ------------------------
  const { merged, deleted, contradicted, mergeFloorViolations, mergedSecondaries, promoted } =
    await applyConsolidationPlan(config, stashDir, sourceRun, memories, warnings, allOps, accounting, dedupCollapsed);

  const runDurationMs = Date.now() - startMs;
  const budgetFraction =
    opts.runBudgetMs !== undefined && opts.runBudgetMs > 0 ? runDurationMs / opts.runBudgetMs : undefined;

  return {
    schemaVersion: 1 as const,
    ok: true,
    shape: "consolidate-result",
    dryRun: false,
    previewOnly: false,
    target: sourceName,
    processed: memories.length,
    merged,
    // #617: fold the deterministic dedup pre-pass collapses into the reported
    // deleted count. Each collapse removed exactly one variant file with NO
    // LLM call before the LLM pass ran on the pruned pool.
    deleted: deleted + dedupCollapsed,
    promoted,
    contradicted,
    mergeFloorViolations,
    failedChunks: accounting.totalChunksFailed,
    totalChunks,
    judgedNoAction: accounting.judgedNoAction,
    skipReasons: accounting.skipReasons,
    mergedSecondaries,
    failedChunkMemories: accounting.failedChunkMemories,
    warnings,
    durationMs: runDurationMs,
    perfTelemetry: {
      dedupPoolSize: perfMs.dedupPoolSize,
      llmPoolSize,
      judgedCacheSkipped: perfMs.judgedCacheSkipped,
      embedMs: embedTelemetry.embedMs,
      embedCacheHits: embedTelemetry.cacheHits,
      embedCacheMisses: embedTelemetry.cacheMisses,
      ...(budgetFraction !== undefined ? { estimatedBudgetFractionUsed: budgetFraction } : {}),
    },
  };
}

/**
 * Mutable state threaded through the four consolidate op-handlers. A plain
 * struct (NOT a DI container): it carries the resolved write-target facts plus
 * the run's accounting accumulators, exactly the locals the inlined op-branches
 * closed over. Each handler mutates `counts` / `promoted` / `promotedSourceRefs`
 * in place; `pushSkipReason` is the orchestrator's skip-histogram closure.
 */
export interface ConsolidateOpContext {
  config: AkmConfig;
  stashDir: string;
  sourceRun: string;
  target: ReturnType<typeof resolveWriteTarget>;
  backupDir: string;
  memoryByRef: Map<string, MemoryEntry>;
  promoted: string[];
  promotedSourceRefs: Set<string>;
  warnings: string[];
  counts: {
    merged: number;
    deleted: number;
    contradicted: number;
    mergeFloorViolations: number;
    mergedSecondaries: number;
  };
  pushSkipReason: (op: ConsolidateOpKind | "unknown", ref: string, reason: string) => void;
}

/** Execute one `merge` op (behavior-identical to the former inlined branch). */
export async function handleMergeOp(op: ConsolidateMergeOp, opIndex: number, ctx: ConsolidateOpContext): Promise<void> {
  const { config, stashDir, target, backupDir, memoryByRef, warnings, pushSkipReason, counts } = ctx;
  // Accounting helper: emit a per-participant skipReason for failed
  // merges so primary + every loaded-memory secondary land in the
  // structured skip histogram. Pre-2026-05-26 only the primary was
  // counted (1 skipReason per failed merge), leaving N secondaries
  // unaccounted for in the `processed == actioned + noAction + Σskips`
  // invariant — the source of the 4–11 silent leaks per run.
  const emitMergeFailureSkips = (reason: string): void => {
    if (memoryByRef.has(op.primary)) pushSkipReason("merge", op.primary, reason);
    for (const secRef of op.secondaries) {
      if (memoryByRef.has(secRef)) pushSkipReason("merge", secRef, reason);
    }
  };

  const primaryEntry = memoryByRef.get(op.primary);
  if (!primaryEntry) {
    // This fires when a prior op in the same run consumed this ref as a
    // secondary and Fix-A pruned it from memoryByRef. It should NOT fire
    // for hallucinated primaries (those are dropped by mergePlans() before
    // reaching here). If this counter is non-zero, suspect an intra-run
    // cross-chunk race, not a filter regression.
    warnings.push(
      `Merge: primary ${op.primary} not found in loaded memories (pruned by prior op this run) — skipping.`,
    );
    emitMergeFailureSkips("merge_primary_missing");
    return;
  }
  // Defense-in-depth: even if the entry is in memoryByRef (pre-flight ran
  // before this run's own ops), the file may have been deleted by a
  // concurrent process or an edge case the pre-flight filter missed.
  if (!fs.existsSync(primaryEntry.filePath)) {
    warnings.push(`Merge: primary ${op.primary} file gone at execution time (stale entry) — skipping.`);
    emitMergeFailureSkips("merge_primary_file_gone");
    return;
  }

  // Phase B: generate merged content
  const secondaryBodies: string[] = [];
  for (const secRef of op.secondaries) {
    const secEntry = memoryByRef.get(secRef);
    if (!secEntry) {
      warnings.push(`Merge: secondary ${secRef} not found — skipping merge op.`);
      // No accounting impact: a missing secondary is a phantom ref and
      // never contributed to any chunk's targetRefs reduction. We still
      // continue the loop to gather the remaining valid secondaries.
      continue;
    }
    secondaryBodies.push(secRef);
  }

  if (secondaryBodies.length === 0) {
    warnings.push(`Merge: ${op.primary} has no valid secondaries — skipping.`);
    emitMergeFailureSkips("merge_no_valid_secondaries");
    return;
  }

  // Pre-flight hot guard — skip the LLM call entirely if any participant
  // is hot or unparseable. Without this, mixed chunks still send hot merges
  // to the planner which proposes them; generateMergedContent() is then
  // called, produces output without `description`, and the skip is
  // misattributed to merge_missing_description instead of the real cause.
  const preflightParticipants: string[] = [op.primary, ...op.secondaries];
  const preflightBlocked = preflightParticipants.flatMap<{ ref: string; verdict: ConsolidateGuardVerdict }>((ref) => {
    const e = memoryByRef.get(ref);
    if (!e) return [];
    const verdict = consolidateGuardStatus(e.filePath);
    if (verdict === "hot" || verdict === "unparseable") return [{ ref, verdict }];
    return [];
  });
  if (preflightBlocked.length > 0) {
    const detail = preflightBlocked.map((p) => `${p.ref} (${p.verdict})`).join(", ");
    warnings.push(
      `Merge: refused for ${op.primary} — ${preflightBlocked.length} participant(s) blocked by hot/unparseable frontmatter guard (pre-flight): ${detail}`,
    );
    emitMergeFailureSkips("merge_participant_blocked");
    return;
  }

  let primaryBody = "";
  try {
    primaryBody = fs.readFileSync(primaryEntry.filePath, "utf8");
  } catch {
    warnings.push(`Merge: could not read primary ${op.primary} — skipping.`);
    emitMergeFailureSkips("merge_read_failed");
    return;
  }

  const mergeResult = await generateMergedContent(config, op.primary, primaryBody, op.secondaries, memoryByRef);

  if ("error" in mergeResult) {
    warnings.push(`Merge: ${mergeResult.error} for ${mergeResult.detail}.`);
    emitMergeFailureSkips(mergeResult.error);
    return;
  }
  let mergedContent = mergeResult.content;

  // Validate frontmatter of merged content — must have a `---` block
  // with at minimum a `description` field. We parse via the hand-rolled
  // parser (cheap) AND require non-empty description. This guards against
  // the historical defect where merged memories were written back with
  // empty `description` and later polluted the promote path.
  let parsedMerged: ReturnType<typeof parseFrontmatter>;
  try {
    parsedMerged = parseFrontmatter(mergedContent);
  } catch {
    warnings.push(`Merge: merged content for ${op.primary} has invalid frontmatter — skipping.`);
    emitMergeFailureSkips("merge_invalid_frontmatter");
    return;
  }
  if (parsedMerged.frontmatter === null) {
    warnings.push(`Merge: merged content for ${op.primary} has no frontmatter block — skipping.`);
    emitMergeFailureSkips("merge_invalid_frontmatter");
    return;
  }
  const mergedDesc = parsedMerged.data.description;
  if (typeof mergedDesc !== "string" || mergedDesc.trim().length === 0) {
    warnings.push(`Merge: merged content for ${op.primary} missing description — skipping.`);
    emitMergeFailureSkips("merge_missing_description");
    return;
  }
  const truncReason = detectTruncatedDescription(mergedDesc);
  if (truncReason) {
    warnings.push(`Merge: merged content for ${op.primary} has truncated description (${truncReason}) — skipping.`);
    emitMergeFailureSkips("merge_truncated_description");
    return;
  }

  // captureMode:hot guard — refuse the merge if ANY participating memory
  // (primary or secondary) was user-captured or has unparseable frontmatter
  // (could have hidden a hot flag). Hot memories are user-explicit and
  // must not be deleted/overwritten by the consolidate LLM. 14 user
  // memories were silent-deleted by consolidate before this guard landed;
  // recovery required copying from .akm/archive/ by hand.
  const mergeParticipants: string[] = [op.primary, ...op.secondaries];
  const blockedParticipants = mergeParticipants.flatMap<{ ref: string; verdict: ConsolidateGuardVerdict }>((ref) => {
    const e = memoryByRef.get(ref);
    if (!e) return [];
    const verdict = consolidateGuardStatus(e.filePath);
    if (verdict === "hot" || verdict === "unparseable") return [{ ref, verdict }];
    return [];
  });
  if (blockedParticipants.length > 0) {
    const detail = blockedParticipants.map((p) => `${p.ref} (${p.verdict})`).join(", ");
    warnings.push(
      `Merge: refused for ${op.primary} — ${blockedParticipants.length} participant(s) blocked by hot/unparseable frontmatter guard: ${detail}`,
    );
    emitMergeFailureSkips("merge_participant_blocked");
    return;
  }

  // WS-3b: Anti-collapse generation guard (step 8a).
  // DEFAULT ON since R5 (opt out via antiCollapse.enabled: false). Refuses
  // to merge two assets both above generation N (default 2) — prevents the
  // pipeline from building ever-deeper LLM-merged trees that lose the
  // source fidelity of the original episodes.
  const antiCollapseConfig: AntiCollapseConfig =
    (getImproveProcessConfig(config, "consolidate")?.antiCollapse as AntiCollapseConfig | undefined) ?? {};
  if (antiCollapseConfig.enabled !== false) {
    const allParticipants = [op.primary, ...op.secondaries];
    // One read per participant: generation counter, stripped body (for the
    // information floor), and existing source_refs (for the provenance union).
    const participantInfo = allParticipants.map((ref) => {
      const e = memoryByRef.get(ref);
      if (!e) return { ref, generation: 0, body: "", sourceRefs: [] as string[] };
      try {
        const raw = fs.readFileSync(e.filePath, "utf8");
        const parsed = parseFrontmatter(raw);
        const fm = parsed.data as Record<string, unknown>;
        const sourceRefs = Array.isArray(fm.source_refs) ? fm.source_refs.map(String) : [];
        return { ref, generation: readAssetGeneration(fm), body: stripFrontmatterBody(raw), sourceRefs };
      } catch {
        return { ref, generation: 0, body: "", sourceRefs: [] as string[] };
      }
    });
    const sourceGenerations = participantInfo.map((p) => p.generation);

    const generationCheck = checkGenerationGuard(sourceGenerations, antiCollapseConfig);
    if (generationCheck.refused) {
      warnings.push(`Merge: ${generationCheck.reason}`);
      emitMergeFailureSkips("merge_generation_guard");
      return;
    }

    // WS-3b: Lexical diversity check (step 8b).
    // Low n-gram diversity ⇒ likely correlated-extraction artifact; raise merge threshold.
    if (antiCollapseConfig.lexicalDiversityCheck !== false) {
      const bodies = participantInfo.map((p) => p.body).filter((b) => b.length > 0);

      const diversityCheck = checkLexicalDiversity(bodies, antiCollapseConfig);
      if (diversityCheck.lowDiversity) {
        // Low-diversity cluster: just warn (don't refuse merge since the dedup
        // path handles exact twins). The warning surfaces in health telemetry.
        warnings.push(
          `Merge: cluster around ${op.primary} has low lexical diversity (${diversityCheck.diversity?.toFixed(2) ?? "?"} < 0.30) — likely correlated extraction; merge proceeds but review is recommended.`,
        );
      }
    }

    // Inject generation counter into merged content frontmatter (step 8a).
    // merged.generation = max(sourceGenerations) + 1. source_refs is the
    // UNION of participants + everything they already cited (R5 §4.2 —
    // the old set-if-absent behavior dropped second-generation provenance).
    const provenanceUnion = [...new Set([...allParticipants, ...participantInfo.flatMap((p) => p.sourceRefs)])];
    mergedContent = injectGenerationFrontmatter(mergedContent, sourceGenerations, provenanceUnion);

    // R5 §4.2: merge-information floor — ADVISORY in v1. A merge that
    // shrinks provenance or genericizes below the retention floor is
    // counted + warned, never refused (promotion path: design doc §7).
    try {
      const mergedParsed = parseFrontmatter(mergedContent);
      const mergedFm = mergedParsed.data as Record<string, unknown>;
      const mergedSourceRefs = Array.isArray(mergedFm.source_refs) ? mergedFm.source_refs.map(String) : [];
      const floorCheck = checkMergeInformationFloor(
        mergedParsed.content,
        mergedSourceRefs,
        participantInfo,
        antiCollapseConfig,
      );
      if (!floorCheck.passed) {
        counts.mergeFloorViolations++;
        warnings.push(
          `Merge: information floor advisory for ${op.primary}: ${floorCheck.reason ?? "unspecified"} — merge proceeds (v1 observe-only).`,
        );
      }
    } catch {
      // Floor measurement is best-effort; never blocks the merge path.
    }
  }

  // Backup secondaries before deleting
  for (const secRef of op.secondaries) {
    const secEntry = memoryByRef.get(secRef);
    if (secEntry && fs.existsSync(secEntry.filePath)) {
      backupFile(secEntry.filePath, backupDir, secEntry.name);
    }
  }

  // Write merged primary
  try {
    const parsedPrimary = parseAssetRef(op.primary);
    await writeAssetToSource(target.source, target.config, parsedPrimary, mergedContent);
  } catch (e) {
    warnings.push(`Merge: write failed for ${op.primary}: ${String(e)}`);
    emitMergeFailureSkips("merge_write_failed");
    return;
  }

  // Archive and delete secondaries (P1-B: soft-invalidation)
  for (const secRef of op.secondaries) {
    const secEntry = memoryByRef.get(secRef);
    if (!secEntry) continue;
    if (fs.existsSync(secEntry.filePath)) {
      archiveMemory(secEntry.filePath, stashDir, secRef, "merged into primary", opIndex, op.primary, warnings);
    }
    try {
      const parsedSec = parseAssetRef(secRef);
      await deleteAssetFromSource(target.source, target.config, parsedSec);
      markJournalCompleted(stashDir, secRef);
    } catch (e) {
      warnings.push(`Merge: delete failed for ${secRef}: ${String(e)}`);
    }
  }

  markJournalCompleted(stashDir, op.primary);
  counts.merged++;
  // 2026-05-26 accounting-leak fix: `merged` is op-level, but each
  // successful merge actions `1 + secondaries.length` memories. Without
  // this counter the accounting invariant breaks by `secondaries.length`
  // per successful merge (chunk loop excluded all secondaries from
  // judgedNoAction via targetRefs, but only the primary is credited to
  // `merged`). Count only loaded-memory secondaries; phantom secondary
  // refs never affected any chunk's targetRefs in the first place.
  for (const secRef of op.secondaries) {
    if (memoryByRef.has(secRef)) counts.mergedSecondaries++;
  }
  // Prune consumed refs from memoryByRef so later ops in this run cannot
  // reference an absorbed secondary as a merge primary and proceed with a
  // stale entry. Primary is rewritten (not deleted), so we only remove
  // secondaries; the primary ref remains valid under its new content.
  for (const secRef of op.secondaries) {
    memoryByRef.delete(secRef);
  }
}

/** Execute one `delete` op (behavior-identical to the former inlined branch). */
export async function handleDeleteOp(
  op: ConsolidateDeleteOp,
  opIndex: number,
  ctx: ConsolidateOpContext,
): Promise<void> {
  const { stashDir, target, backupDir, memoryByRef, warnings, pushSkipReason, counts } = ctx;
  const entry = memoryByRef.get(op.ref);
  if (!entry) {
    warnings.push(`Delete: ${op.ref} not found in loaded memories — skipping.`);
    // Phantom ref: not in the batch so not in processed. Pushing to
    // skipReasons would inflate Σ(skipReasons) without a matching processed
    // entry, breaking the accounting invariant. Visibility is preserved via
    // the warnings array above.
    return;
  }

  // captureMode:hot guard — refuse to delete user-captured memories OR
  // memories whose frontmatter is unparseable (could have hidden the hot
  // flag). The consolidate LLM was deleting hot-captured user memos as
  // "redundant" — 14 such deletes were silently archived between
  // 2026-05-19 and 2026-05-20 before this guard. Hot memories are
  // user-explicit and may only be deleted by the user.
  const guard = consolidateGuardStatus(entry.filePath);
  if (guard === "hot" || guard === "unparseable") {
    warnings.push(
      `Delete: refused for ${op.ref} — ${guard === "hot" ? "captureMode:hot (user-explicit; never auto-delete)" : "frontmatter unparseable (cannot verify hot flag absent)"}. Reason from LLM: "${op.reason ?? "n/a"}"`,
    );
    pushSkipReason("delete", op.ref, "captureMode_hot_refused");
    return;
  }

  if (fs.existsSync(entry.filePath)) {
    backupFile(entry.filePath, backupDir, entry.name);
    // P1-B: soft-invalidation archive before hard delete
    archiveMemory(entry.filePath, stashDir, op.ref, op.reason, opIndex, undefined, warnings);
  }

  try {
    const parsedRef = parseAssetRef(op.ref);
    await deleteAssetFromSource(target.source, target.config, parsedRef);
    markJournalCompleted(stashDir, op.ref);
    counts.deleted++;
    // Prune from memoryByRef so later ops in this run cannot reference a
    // deleted memory as a merge primary or secondary.
    memoryByRef.delete(op.ref);
  } catch (e) {
    // Distinguish "file already absent" from genuine failures. A prior run
    // may have deleted the file but the DB was not yet re-indexed, so the
    // ref still appeared in memoryByRef. The delete goal is already met.
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("not found in source")) {
      warnings.push(`Delete: ${op.ref} — file already absent (stale DB entry); skipping.`);
      pushSkipReason("delete", op.ref, "delete_already_gone");
    } else {
      warnings.push(`Delete: failed for ${op.ref}: ${String(e)}`);
      pushSkipReason("delete", op.ref, "delete_failed");
    }
  }
}

/** Execute one `promote` op (behavior-identical to the former inlined branch). */
export async function handlePromoteOp(op: ConsolidatePromoteOp, ctx: ConsolidateOpContext): Promise<void> {
  const { config, stashDir, sourceRun, target, memoryByRef, warnings, pushSkipReason, promoted, promotedSourceRefs } =
    ctx;
  const entry = memoryByRef.get(op.ref);
  if (!entry) {
    warnings.push(`Promote: ${op.ref} not found in loaded memories — skipping.`);
    // Phantom ref: not in processed, so no skipReason (same rationale as
    // delete_ref_missing above).
    return;
  }

  // Within-run source-ref dedup: skip if this source memory was already
  // promoted earlier in this run (safety belt — mergePlans already
  // deduplicates promote ops by source ref via Map, but this guard also
  // catches any future code paths that bypass mergePlans).
  if (promotedSourceRefs.has(op.ref)) {
    warnings.push(`Skipping promote: ${op.ref} already promoted in this run`);
    pushSkipReason("promote", op.ref, "promote_already_promoted_this_run");
    return;
  }

  let knowledgeRef = op.knowledgeRef;
  try {
    parseAssetRef(knowledgeRef);
  } catch {
    const slug = op.knowledgeRef
      .replace(/^knowledge:/, "")
      .replace(/[^a-z0-9-]/gi, "-")
      .toLowerCase();
    knowledgeRef = `knowledge:${slug}`;
    warnings.push(`Normalized invalid ref "${op.knowledgeRef}" → "${knowledgeRef}"`);
  }

  // Idempotency: check pending proposals by target ref
  const existingProposals = listProposals(stashDir, { ref: knowledgeRef });
  if (existingProposals.some((p) => p.status === "pending")) {
    warnings.push(`Skipping promote: pending proposal already exists for ${knowledgeRef}`);
    pushSkipReason("promote", op.ref, "promote_pending_proposal_exists");
    return;
  }

  // Idempotency: check if knowledge asset already exists
  const parsedKnowledgeRef = parseAssetRef(knowledgeRef);
  const destPath = path.join(target.source.path, "knowledge", `${parsedKnowledgeRef.name}.md`);
  if (fs.existsSync(destPath)) {
    warnings.push(`Skipping promote: ${knowledgeRef} already exists in source`);
    pushSkipReason("promote", op.ref, "promote_already_exists");
    return;
  }

  let memoryContent = "";
  try {
    memoryContent = fs.readFileSync(entry.filePath, "utf8");
  } catch (e) {
    warnings.push(`Promote: could not read ${op.ref}: ${String(e)}`);
    pushSkipReason("promote", op.ref, "promote_read_failed");
    return;
  }

  // Defensive sanitization: legacy memory files written by older
  // consolidate runs may still carry outer code fences or broken YAML.
  // Strip them here so we never propose a polluted asset.
  const promoteSanitized = sanitizeMergedContent(memoryContent);
  if (!promoteSanitized.ok) {
    warnings.push(`Promote: rejected ${op.ref} — source memory failed sanitization (${promoteSanitized.reason}).`);
    pushSkipReason("promote", op.ref, "promote_sanitization_failed");
    return;
  }
  memoryContent = promoteSanitized.result.content;

  // SOURCE_SUPERSEDED guard: refuse to promote a memory whose source
  // frontmatter carries `status: superseded`. Predicate at module top
  // (`hasSupersededStatus`) so tests can exercise it directly.
  if (hasSupersededStatus(promoteSanitized.result.frontmatter as Record<string, unknown> | undefined)) {
    warnings.push(
      `Promote: refused for ${op.ref} → ${knowledgeRef} — source memory has status:superseded; superseded memories are not promotable knowledge.`,
    );
    pushSkipReason("promote", op.ref, "promote_superseded");
    return;
  }

  // Parse the source memory up-front so the body/frontmatter checks below
  // share the same parsed view.
  const parsedMemory = parseFrontmatter(memoryContent);

  // Reject sources whose body is too small to make useful knowledge.
  // Observed failure: memory files whose body is literally a tags string
  // ("discord,notification,send-notification") get promoted to knowledge
  // proposals that no reviewer would accept. Threshold is conservative —
  // 100 chars catches single-line tag dumps without rejecting genuinely
  // terse but valid notes.
  const PROMOTE_BODY_MIN_CHARS = 100;
  const sourceBody = parsedMemory.content.trim();
  if (sourceBody.length < PROMOTE_BODY_MIN_CHARS) {
    warnings.push(
      `Promote: rejected ${op.ref} → ${knowledgeRef} — source memory body is too small (${sourceBody.length} chars; need ≥${PROMOTE_BODY_MIN_CHARS}) to make useful knowledge.`,
    );
    pushSkipReason("promote", op.ref, "promote_source_too_small");
    return;
  }

  // Cross-run + within-run content dedup: if an identical body already
  // exists in ANY pending consolidate proposal (regardless of target ref),
  // skip. This prevents duplicate proposals when:
  //   (a) Multiple source memories have identical bodies but differ only
  //       in noise frontmatter (`inferenceProcessed: true` twin alongside
  //       the original; differing `updated:` timestamps; etc.) — the body
  //       is the load-bearing content, so dedup must hash on body only.
  //   (b) A prior run created a proposal for the same body under a
  //       different knowledgeRef slug.
  // Use cacheHash (case-preserving stripped body) to match the canonical
  // hash domain used by the body-embedding cache and pending-proposal set.
  const bodyHash = cacheHash(sourceBody);
  const allPendingConsolidateProposals = listProposals(stashDir, { status: "pending" }).filter(
    (p) => p.source === "consolidate",
  );
  const contentDupProposal = allPendingConsolidateProposals.find((p) => {
    return cacheHash(p.payload.content) === bodyHash;
  });
  if (contentDupProposal) {
    warnings.push(
      `Skipping promote: identical body already pending as proposal ${contentDupProposal.id} (ref: ${contentDupProposal.ref}); skipping duplicate for ${op.ref} → ${knowledgeRef}`,
    );
    pushSkipReason("promote", op.ref, "dedup_pending_proposal");
    return;
  }

  try {
    // Use LLM-provided description; fall back to memory's own description
    // (post-sanitization frontmatter is authoritative).
    const description: string =
      (typeof op.description === "string" && op.description.trim()
        ? op.description.trim()
        : (parsedMemory.data?.description as string | undefined)?.trim()) ?? "";

    // Validate the resolved frontmatter before emitting a proposal.
    // Required field: non-empty description. Reject obvious truncation
    // markers (description ends with `,`/`;`/`:`/`...`/hanging connector)
    // so the queue never sees half-formed metadata that the reviewer
    // would only reject.
    const fmCheck = validateProposalFrontmatter({ description });
    if (!fmCheck.ok) {
      warnings.push(`Promote: rejected ${op.ref} → ${knowledgeRef} — ${fmCheck.reason}.`);
      pushSkipReason("promote", op.ref, "promote_invalid_frontmatter");
      return;
    }

    // Merge `description` INTO the body's YAML frontmatter so it lands in
    // the on-disk asset when the proposal is accepted. The descriptionQuality
    // validator parses `payload.content` body (not the envelope
    // `payload.frontmatter`), and a memory's native frontmatter has
    // `captureMode`/`beliefState`/etc. but never `description` — without
    // this merge, 60+ pending proposals were blocked at accept-time with
    // MISSING_FRONTMATTER_DESCRIPTION even though the envelope had it.
    // (The body-frontmatter assumption baked into the 2026-05-20 comment
    // below was wrong: body fm and envelope fm only converge when the
    // writer explicitly merges them, which it now does.)
    const mergedBodyFm: Record<string, unknown> = {
      ...(parsedMemory.data ?? {}),
      description,
    };
    const serializedMergedFm = serializeFrontmatter(mergedBodyFm);
    const proposalContent = assembleAssetFromString(serializedMergedFm, parsedMemory.content);

    // Pre-emit dedup against pending consolidate proposals from the
    // same improve run (slug-variant match). The cross-run content-hash
    // dedup inside `mergePlans` handles duplicates against existing
    // stash assets — see commit history for the deletion of the
    // unbounded embedding + cross-type slug branches.
    const dedup = await checkPreEmitDedup({
      candidateRef: knowledgeRef,
      candidateText: `${description}. ${memoryContent}`,
      stashDir,
      config,
    });
    if (dedup.duplicate) {
      warnings.push(`Promote: skipped ${op.ref} → ${knowledgeRef} — ${dedup.reason}.`);
      pushSkipReason("promote", op.ref, "promote_dedup_window");
      return;
    }

    const proposalResult = createProposal(stashDir, {
      ref: knowledgeRef,
      source: "consolidate",
      sourceRun,
      payload: {
        content: proposalContent,
        frontmatter: { description },
      },
      ...(typeof op.confidence === "number" ? { confidence: op.confidence } : {}),
    });
    if (isProposalSkipped(proposalResult)) {
      warnings.push(`Promote: skipped proposal for ${op.ref} (${proposalResult.reason}): ${proposalResult.message}`);
      pushSkipReason("promote", op.ref, `promote_proposal_${proposalResult.reason}`);
    } else {
      promoted.push(proposalResult.id);
      promotedSourceRefs.add(op.ref);
      markJournalCompleted(stashDir, op.ref);
    }
  } catch (e) {
    warnings.push(`Promote: createProposal failed for ${op.ref}: ${String(e)}`);
    pushSkipReason("promote", op.ref, "promote_create_failed");
  }
}

/** Execute one `contradict` op (behavior-identical to the former inlined branch). */
export async function handleContradictOp(op: ConsolidateContradictOp, ctx: ConsolidateOpContext): Promise<void> {
  const { stashDir, memoryByRef, warnings, pushSkipReason, counts } = ctx;
  // Confidence gate: surface-level topic overlap causes false positives
  // (investigation 2026-06-18). Require ≥0.92 confidence before writing
  // contradiction edges. Missing confidence field defaults to 1.0 for
  // backward compatibility with responses that predate this field.
  const opConfidence =
    typeof (op as { confidence?: number }).confidence === "number" ? (op as { confidence: number }).confidence : 1.0;
  if (opConfidence < 0.92) {
    warnings.push(
      `Contradict: confidence ${opConfidence.toFixed(2)} below 0.92 threshold for ${op.ref} <-> ${op.contradictedByRef} — skipping.`,
    );
    pushSkipReason("contradict", op.ref, "contradict_low_confidence");
    return;
  }

  // C-3 / #382: Write contradictedBy edges so resolveFamilyContradictions
  // (the SCC resolver in memory-improve.ts) has edges to work on.
  // Zep arXiv:2501.13956 §3 — unified belief-revision with contradiction edges.
  const entry = memoryByRef.get(op.ref);
  const contradictorEntry = memoryByRef.get(op.contradictedByRef);

  if (!entry) {
    warnings.push(`Contradict: ${op.ref} not found in loaded memories — skipping.`);
    // Phantom ref: not in processed, so no skipReason (same rationale as
    // delete_ref_missing).
    return;
  }
  if (!contradictorEntry) {
    warnings.push(`Contradict: ${op.contradictedByRef} not found — skipping.`);
    // op.ref IS in the batch (entry found above) so the skipReason is
    // correctly charged against a real processed memory.
    pushSkipReason("contradict", op.ref, "contradict_target_missing");
    return;
  }

  try {
    // Write the contradiction edge: op.ref is contradicted by op.contradictedByRef
    writeContradictEdge(entry.filePath, op.contradictedByRef);
    counts.contradicted++;
    markJournalCompleted(stashDir, op.ref);
  } catch (e) {
    warnings.push(`Contradict: failed to write edge for ${op.ref}: ${String(e)}`);
    pushSkipReason("contradict", op.ref, "contradict_write_failed");
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Normalise a knowledge slug for variant-aware deduplication. Collapses:
 *   - date suffixes (`-may-2026`, `-2026-05-03`, `-2026`)
 *   - numeric counter suffixes (`-2`, `-3`)
 *   - trailing -patterns / -2026-05-03 styles
 *   - word reorderings via alphabetical sort of the remaining tokens.
 *
 * Two slugs that normalise to the same string are considered the same asset
 * for dedup purposes even if they don't share an exact ref.
 */
function normalizeSlugForDedup(ref: string): string {
  const slug = ref.replace(/^[^:]+:/, "");
  const monthRe = /(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i;
  const tokens = slug
    .toLowerCase()
    .split("-")
    .filter((tok) => tok.length > 0)
    // Strip purely-numeric tokens (years, dates, counter suffixes like -2 / -3).
    // Numbers carry no semantic information for our dedup purposes — every
    // observed defective slug variant differs only in dates or counters.
    .filter((tok) => !/^\d+$/.test(tok))
    .filter((tok) => !monthRe.test(tok));
  // Sort to absorb word reorderings.
  tokens.sort();
  return tokens.join("-");
}

/**
 * Pre-emit dedup check: compare the candidate ref against pending consolidate
 * proposals only. Returns a reason string if a slug-variant match is found,
 * else null.
 *
 * Historical context (REMOVED 2026-05-20): this function previously also ran
 *   (a) a normalised-slug match against existing knowledge AND memory entries
 *       in the DB, and
 *   (b) an embedding cosine-similarity check (>= 0.85) against ALL knowledge
 *       and non-derived memory entries.
 * Both branches had ZERO observed fires across 30 sampled runs in the
 * post-fix window. The 29 actual dedup catches all came from the SEPARATE
 * content-hash dedup inside `mergePlans` (the older SHA-256 helper). The
 * embedding branch in particular had unbounded cost per promote (embedded
 * every knowledge + non-derived memory entry, every time) with no observed
 * benefit. Empirical signal → deleted.
 *
 * What remains: a check against pending consolidate proposals in the SAME
 * improve run. This catches duplicates queued back-to-back within a single
 * improve invocation — a different concern from the cross-run content-hash
 * dedup, and cheap (no embeddings, no DB query).
 */
async function checkPreEmitDedup(opts: {
  candidateRef: string;
  candidateText: string;
  stashDir: string;
  config: AkmConfig;
}): Promise<{ duplicate: true; reason: string } | { duplicate: false }> {
  const normCandidate = normalizeSlugForDedup(opts.candidateRef);

  // Pending consolidate proposals (slug match) — within the same improve run.
  const pendingConsolidate = listProposals(opts.stashDir, { status: "pending" }).filter(
    (p) => p.source === "consolidate",
  );
  for (const p of pendingConsolidate) {
    if (normalizeSlugForDedup(p.ref) === normCandidate) {
      return { duplicate: true, reason: `slug-variant of pending proposal ${p.id} (${p.ref})` };
    }
  }

  return { duplicate: false };
}

/**
 * Incremental candidate set: {changed} ∪ {top-k persisted-vector neighbours of
 * each changed memory}, intersected with the loaded pool. Returns [] when
 * nothing changed (caller emits a no-op envelope), the full pool when
 * everything changed or the index can't answer (fail-open to preserve merge
 * correctness). `since` is an ISO timestamp.
 */
/**
 * Parse a human-readable duration string (e.g. "30m", "24h", "7d") to an ISO
 * timestamp representing `now - duration`. Returns the input unchanged when it
 * doesn't match the pattern (assumed to already be an ISO timestamp).
 */
function parseSinceToIso(since: string): string {
  // Case-sensitive units, matching the original local regex `/^(\d+)(m|h|d)$/`.
  // NOTE: here `m` = MINUTES (see core/time.ts parseDuration for the cross-call
  // `m` month-vs-minute discrepancy). Non-matching input is returned unchanged
  // (assumed to already be an ISO timestamp).
  const ms = parseDuration(since, { m: 60_000, h: 3_600_000, d: 86_400_000 });
  if (ms === null) return since;
  return new Date(Date.now() - ms).toISOString();
}

export function narrowToIncrementalCandidates(
  memories: MemoryEntry[],
  since: string,
  warnings: string[],
  neighborsPerChanged = 5,
): MemoryEntry[] {
  const sinceIso = parseSinceToIso(since);
  const isChanged = (m: MemoryEntry): boolean => {
    try {
      return fs.statSync(m.filePath).mtime.toISOString() > sinceIso;
    } catch {
      return true; // never silently drop a memory we cannot stat
    }
  };
  const changed = memories.filter(isChanged);
  if (changed.length === 0) return [];
  if (changed.length === memories.length) return memories;

  const byName = new Map(memories.map((m) => [m.name, m]));
  const keep = new Set<string>(changed.map((m) => m.name));
  let db: ReturnType<typeof openExistingDatabase> | undefined;
  try {
    db = openExistingDatabase();
    for (const m of changed) {
      const id = findEntryIdByRef(db, `memory:${m.name}`);
      if (id === undefined) continue;
      for (const hit of getNeighborsByEntryId(db, id, neighborsPerChanged + 1)) {
        if (hit.id === id) continue;
        const entry = getEntryById(db, hit.id);
        if (!entry) continue;
        const name = entry.entry.name;
        if (byName.has(name)) keep.add(name); // only neighbours present in the loaded pool
      }
    }
  } catch {
    warnings.push("Incremental consolidation: index unavailable — processing full pool.");
    return memories;
  } finally {
    if (db) closeDatabase(db);
  }

  const candidates = memories.filter((m) => keep.has(m.name));
  warnings.push(
    `Incremental consolidation: ${changed.length} changed + neighbours → ${candidates.length}/${memories.length} memories considered (since ${since}${sinceIso !== since ? ` = ${sinceIso}` : ""}).`,
  );
  return candidates;
}

function loadMemoriesForSource(source: string | undefined, stashDir: string, warnings: string[]): MemoryEntry[] {
  // Load from DB first
  let memories: MemoryEntry[] = [];
  let db: ReturnType<typeof openExistingDatabase> | undefined;
  try {
    db = openExistingDatabase();
    const entries: DbIndexedEntry[] = getAllEntries(db, "memory");
    memories = entries
      .filter((e) => {
        if (!source) return true;
        return path.resolve(e.stashDir) === path.resolve(source);
      })
      .filter((e) => isConsolidationEligibleMemoryName(e.entry.name))
      // #632 — exclude session-capture telemetry (checkpoints) from the
      // consolidation pool, mirroring recombine. Their bodies are pipeline
      // bookkeeping, so consolidating them burns LLM calls on pure noise.
      .filter((e) => !isSessionCaptureMemoryName(e.entry.name))
      // Skip stale DB entries whose file was deleted by a prior run but not yet
      // re-indexed. Without this guard the deleted file's ref appears in chunks
      // sent to the LLM, which then proposes a second delete → delete_failed
      // because the file is already gone. Re-indexing runs on a cron cadence so
      // several successful deletes can accumulate before the DB catches up.
      .filter((e) => fs.existsSync(e.filePath))
      .map((e) => ({
        name: e.entry.name,
        filePath: e.filePath,
        description: e.entry.description ?? "",
        tags: e.entry.tags ?? [],
        stashDir: e.stashDir,
      }));
  } catch {
    memories = [];
  } finally {
    if (db) closeDatabase(db);
  }

  if (memories.length === 0) {
    // DB fallback: walk filesystem
    const memoriesDir = path.join(source ?? stashDir, "memories");
    const fsStashDir = source ?? stashDir;
    if (fs.existsSync(memoriesDir)) {
      for (const fname of fs.readdirSync(memoriesDir)) {
        if (!fname.endsWith(".md")) continue;
        const filePath = path.join(memoriesDir, fname);
        const name = fname.replace(/\.md$/, "");
        if (!isConsolidationEligibleMemoryName(name)) continue;
        if (isSessionCaptureMemoryName(name)) continue; // #632 — skip telemetry checkpoints
        memories.push({ name, filePath, description: "", tags: [], stashDir: fsStashDir });
      }
    }
    if (memories.length > 0) {
      warnings.push("DB not found or empty — loaded memories directly from filesystem.");
    }
  }
  return memories;
}

type MergeFailureReason =
  | "merge_read_failed"
  | "merge_transport_failed"
  | "merge_fence_rejected"
  | "merge_yaml_invalid"
  | "merge_content_too_short"
  | "merge_frontmatter_keys_lost";

type MergeResult = { content: string } | { error: MergeFailureReason; detail: string };

async function generateMergedContent(
  config: AkmConfig,
  primaryRef: string,
  primaryBody: string,
  secondaryRefs: string[],
  memoryByRef: Map<string, MemoryEntry>,
): Promise<MergeResult> {
  // Only handle single-secondary merges per design (one call per merge op)
  const secRef = secondaryRefs[0];
  const secEntry = memoryByRef.get(secRef);
  if (!secEntry) return { error: "merge_read_failed", detail: `secondary ${secRef} not in memoryByRef` };

  let secBody = "";
  try {
    secBody = fs.readFileSync(secEntry.filePath, "utf8");
  } catch {
    return { error: "merge_read_failed", detail: `could not read secondary ${secRef}` };
  }

  const primaryFmKeys = Object.keys(parseFrontmatter(primaryBody).data);
  const secFmKeys = Object.keys(parseFrontmatter(secBody).data);
  const requiredFmKeys = [...new Set([...primaryFmKeys, ...secFmKeys])];

  const prompt = [
    "Merge these two memory assets into one. Output ONLY the merged markdown (with YAML frontmatter). Do not explain, do not use code fences.",
    "",
    "## OUTPUT FORMAT (MANDATORY)",
    "Return raw markdown content beginning DIRECTLY with the `---` frontmatter delimiter.",
    "DO NOT wrap your entire response in a code fence.",
    "",
    'GOOD: "---\\ndescription: ...\\n---\\nBody content."',
    'BAD:  "```markdown\\n---\\ndescription: ...\\n---\\nBody content.\\n```"',
    'BAD:  "```yaml\\n---\\ndescription: ...\\n---\\nBody content.\\n```"',
    "",
    "## FRONTMATTER RULES (MANDATORY)",
    "- The `updated:` field, if present, MUST be a real ISO date (e.g. `updated: 2026-05-20`). NEVER emit `updated: today`, `updated: now`, or `updated: {today: null}`. If you don't have a real date, OMIT the field — the post-processor will not invent one.",
    "- REQUIRED: The merged frontmatter MUST include a `description` field with a concise one-sentence summary of the merged asset's content. If neither source has a `description` field, synthesize one from the content.",
    requiredFmKeys.length > 0
      ? `- CRITICAL: The merged frontmatter MUST include ALL of these keys from both source memories: ${requiredFmKeys.join(", ")}. Do NOT drop any of them.`
      : null,
    "",
    `=== Primary memory (${primaryRef}) ===`,
    primaryBody,
    "",
    `=== Secondary memory (${secRef}) ===`,
    secBody,
  ]
    .filter((line) => line !== null)
    .join("\n");

  // Use the same per-process profile resolution as the chunk-plan call above
  // so the merge generation step doesn't silently revert to the default LLM.
  const llmConfig = resolveConsolidateLlmConfig(config);
  const result = await tryLlmFeature(
    "memory_consolidation",
    config,
    async () => {
      if (!llmConfig) return { ok: false as const, error: "No LLM configured for consolidation" };
      try {
        const content = await chatCompletion(llmConfig, [{ role: "user", content: prompt }], {
          enableThinking: false,
        });
        return { ok: true as const, content };
      } catch (e) {
        return { ok: false as const, error: String(e) };
      }
    },
    { ok: false as const, error: `merge content generation failed for ${primaryRef}` },
  );

  if (!result.ok) {
    return {
      error: "merge_transport_failed",
      detail: result.error ?? `merge content generation failed for ${primaryRef}`,
    };
  }

  // Sanitize LLM output: strip outer code fences (defends against the
  // ```markdown … ``` leak observed in production), re-serialise frontmatter
  // through the yaml lib (fixes quote-escaping mistakes), and reject empty
  // or fence-only responses.
  const sanitized = sanitizeMergedContent(result.content ?? "");
  if (!sanitized.ok) {
    const reason = sanitized.reason;
    const isFenceError =
      reason === "UNBALANCED_CODE_FENCE" ||
      reason === "MISSING_FRONTMATTER_SENTINEL" ||
      reason === "MALFORMED_FRONTMATTER_BLOCK" ||
      reason === "FRONTMATTER_NOT_OBJECT";
    const mergeReason: MergeFailureReason = isFenceError ? "merge_fence_rejected" : "merge_yaml_invalid";
    return { error: mergeReason, detail: `${primaryRef} — ${reason}` };
  }
  const mergedRaw = sanitized.result.content;

  // C-4 / #383: Content-preservation lint (mem0 §3.2, arXiv:2504.19413).
  // Guards against LLM-generated merged content that silently drops information
  // from the source assets. Two checks:
  //   1. Body size: merged body must be >= 50% of the larger source body.
  //   2. Frontmatter superset: merged frontmatter must contain all keys present
  //      in both source frontmatters.
  // Failures return a discriminated error so the call site can emit a specific
  // skip-reason key in the histogram.
  try {
    const primaryFm = parseFrontmatter(primaryBody);
    const secFm = parseFrontmatter(secBody);
    const mergedFm = parseFrontmatter(mergedRaw);

    // Check body size — blended floor: max(ratio × largerLen, absoluteFloor).
    // Deduplication is expected, so the ratio is lower than the reflect gate
    // (0.3 vs 0.5). The absolute floor protects very short memory pairs where
    // the ratio alone would produce a near-zero threshold.
    const primaryBodyLen = (primaryFm.content ?? "").trim().length;
    const secBodyLen = (secFm.content ?? "").trim().length;
    const mergedBodyLen = (mergedFm.content ?? "").trim().length;
    const largerBodyLen = Math.max(primaryBodyLen, secBodyLen);
    const mergeFloor = Math.max(MERGE_SHRINK_RATIO_MIN * largerBodyLen, MERGE_ABSOLUTE_FLOOR_CHARS);
    if (largerBodyLen > 0 && mergedBodyLen < mergeFloor) {
      return {
        error: "merge_content_too_short",
        detail: `${primaryRef} — merged body (${mergedBodyLen} chars) is less than floor (${Math.round(mergeFloor)} chars; max(${MERGE_SHRINK_RATIO_MIN}×${largerBodyLen}, ${MERGE_ABSOLUTE_FLOOR_CHARS}))`,
      };
    }

    // Check frontmatter superset — attempt repair before rejecting.
    const primaryKeys = Object.keys(primaryFm.data ?? {});
    const secKeys = Object.keys(secFm.data ?? {});
    const mergedKeys = new Set(Object.keys(mergedFm.data ?? {}));
    const missingKeys = [...new Set([...primaryKeys, ...secKeys])].filter((k) => !mergedKeys.has(k));
    if (missingKeys.length > 0) {
      // Inject missing keys from source FMs. Primary value wins on conflict.
      const repairedFmData = { ...(mergedFm.data as Record<string, unknown>) };
      for (const key of missingKeys) {
        repairedFmData[key] =
          key in (primaryFm.data as Record<string, unknown>)
            ? (primaryFm.data as Record<string, unknown>)[key]
            : (secFm.data as Record<string, unknown>)[key];
      }
      normalizeUpdatedField(repairedFmData);
      const repairedYaml = serializeFrontmatter(repairedFmData);
      const bodyPart = typeof mergedFm.content === "string" ? mergedFm.content : "";
      return { content: assembleAssetFromString(repairedYaml, bodyPart) };
    }
  } catch {
    // parseFrontmatter failures are non-fatal — allow the merge to proceed.
  }

  return { content: mergedRaw };
}

async function promptConfirm(message: string): Promise<boolean> {
  process.stdout.write(message);
  return new Promise((resolve) => {
    let settled = false;
    const done = (answer: boolean) => {
      if (settled) return;
      settled = true;
      rl.close();
      resolve(answer);
    };
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.once("line", (line: string) => done(line.trim().toLowerCase() === "y"));
    rl.once("close", () => done(false));
  });
}
