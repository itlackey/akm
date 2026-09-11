// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import consolidateSystemPrompt from "../../assets/prompts/consolidate-system.md" with { type: "text" };
import { detectAdapterId } from "../../core/adapter/detect-adapter";
import { assembleAssetFromString, serializeFrontmatter } from "../../core/asset/asset-serialize";
import { parseFrontmatter } from "../../core/asset/frontmatter";
import { conceptIdFromTypeName, displayRef, parseRefInput } from "../../core/asset/resolve-ref";
import type { AkmConfig, ImproveProfileConfig } from "../../core/config/config";
import { getImproveProcessConfig, loadConfig } from "../../core/config/config";
import { parseEmbeddedJsonResponse } from "../../core/parse";
import { resolveStandardsContext } from "../../core/standards/resolve-standards-context";
import { openStateDatabase } from "../../core/state-db";
import { parseSinceToIsoLenient } from "../../core/time";
import { warn, warnVerbose } from "../../core/warn";
import { type ResolvedWriteTarget, resolveWriteTarget } from "../../core/write-source";
import type { LoweringNotice } from "../../execution/resolved-request";
import { deriveInstallations } from "../../indexer/installations";
import { resolveSourceEntries } from "../../indexer/search/search-source";
import {
  disposeLoweredExecutionDispatchLease,
  type LoweredExecutionDispatchLease,
} from "../../integrations/agent/execution-lowering";
import type { RunnerSpec } from "../../integrations/agent/runner";
import { cosineSimilarity, embedBatch, resolveEmbeddingModelId } from "../../llm/embedder";
import { callStructured, preflightStructuredLlmRunner } from "../../llm/structured-call";
import type { Database } from "../../storage/database";
import { getBodyEmbeddings, upsertBodyEmbeddings } from "../../storage/repositories/embeddings-repository";
import {
  closeDatabase,
  openExistingDatabase,
  openReadonlyExistingDatabase,
} from "../../storage/repositories/index-connection";
import { findEntryIdByRef, getAllEntries, getEntryById } from "../../storage/repositories/index-entries-repository";
import type { DbIndexedEntry } from "../../storage/repositories/index-entry-types";
import { getNeighborsByEntryId } from "../../storage/repositories/units-repository";
import {
  isProposalSkipped,
  listProposals,
  listProposalsReadOnly,
  type ProposalsContext,
  proposalContent,
} from "../proposal/repository";
import { hasSupersededStatus, validateProposalFrontmatter } from "../proposal/validators/proposal-quality-validators";
import { type AntiCollapseConfig, DEFAULT_RANDOM_CLUSTER_FRACTION } from "./anti-collapse";
import { cacheHash } from "./content-hash";
import { resolveImproveLlmExecution } from "./execution";
import { resolveImproveStrategy, resolveProcessEnabled } from "./improve-strategies";
import { emitProposal } from "./proposal-envelope";
import { createRunContext, type RunContext } from "./run-context";

// ── Types ───────────────────────────────────────────────────────────────────

import type { ConsolidateOpKind, ConsolidateResult } from "../../core/improve-types";

// Chunk sizing + per-chunk prompt assembly live in ./consolidate/chunking.
import { buildChunkPrompt, computeSafeChunkSize, DEFAULT_CONTEXT_LENGTH_TOKENS } from "./consolidate/chunking";
// Eligibility / safety predicates live in ./consolidate/eligibility.
import { isConsolidationEligibleMemoryName, isHotCapturedMemory } from "./consolidate/eligibility";
// Plan parsing / merging (pure op-reconciliation algebra) lives in
// ./consolidate/merge.
import { isValidOp, mergePlans } from "./consolidate/merge";
// LLM-output sanitization (pure string/frontmatter transforms) lives in
// ./consolidate/sanitize.
import { sanitizeMergedContent } from "./consolidate/sanitize";
// Shared consolidate domain types live in ./consolidate/types.
import type { ConsolidateOperation, ConsolidatePromoteOp, MemoryEntry, RawChunkPlan } from "./consolidate/types";

export interface AkmConsolidateOptions {
  /**
   * The improve profile resolved for the current `akm improve --profile <name>`
   * run. When set, its per-process overrides win over the `default` profile at
   * the secondary process-config reads inside this pass; absent (standalone
   * `akm consolidate`) falls back to the `default` profile.
   */
  improveProfile?: ImproveProfileConfig;
  target?: string; // which source to target; defaults to primary writable stash
  /** Write target resolved by the parent improve invocation. */
  writeTarget?: ResolvedWriteTarget;
  dryRun?: boolean; // generate AI plan but skip all writes
  task?: string; // extra guidance appended to the system prompt
  stashDir?: string;
  config?: AkmConfig;
  /** Exact symbolic runner frozen by the improve plan. */
  llmRunner?: Extract<RunnerSpec, { kind: "llm" }> | null;
  /** Internal diagnostics sink for resolved/lowered dispatches. */
  onNotices?: (notices: readonly Readonly<LoweringNotice>[]) => void;
  /** When true, indicates the run was triggered automatically by volume threshold rather than by the memory_consolidation feature flag. */
  autoTriggered?: boolean;
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
   * PROV-DM traceability token for proposals created by this run. When set,
   * every `createProposal` call includes it so accept-rate-per-run aggregation
   * works. When absent, a `consolidate-<timestamp>` token is generated at the
   * start of `akmConsolidate` so standalone `akm consolidate` also emits a
   * consistent token. Callers (e.g. `akmImprove`) should pass
   * `sourceRun: \`consolidate-\${startMs}\`` to tie proposals back to the
   * containing improve run.
   */
  sourceRun?: string;
  /** Proposal persistence seam used by callers that isolate state storage. */
  proposalsCtx?: ProposalsContext;
  /**
   * AbortSignal from the caller's budget controller (e.g. `improve.ts`
   * `budgetAbortController`). When aborted the consolidation loop breaks cleanly
   * after completing the current chunk, commits work done, and returns with a
   * `partial_timeout` outcome note in `warnings`. The signal is also forwarded
   * to `embedBatch` so mid-embedding aborts are handled gracefully. Absent =
   * run without a budget limit.
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
 * decision — see knowledge/projects/akm/asset-writers-investigation/00-synthesis).
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
                maxItems: 1,
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
  signal?: AbortSignal,
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

  let missVecs: (number[] | undefined)[] = [];
  if (missTexts.length > 0) {
    const embedStart = Date.now();
    try {
      missVecs = await embedBatch(missTexts, config.embedding, signal);
    } catch {
      // Fail open: embedding failures degrade gracefully to original order.
      return { ordered: memories, embedTelemetry: { embedMs, cacheHits, cacheMisses } };
    } finally {
      embedMs += Date.now() - embedStart;
    }
    // Upsert newly computed vectors into the cache. A skipped document
    // (embedBatch reports it via `undefined` rather than throwing, #874) has
    // no vector to cache — omit it rather than writing a bogus embedding.
    if (stateDb && missVecs.length === missTexts.length) {
      try {
        const toUpsert = missIndices.flatMap((idx, pos) => {
          const embedding = missVecs[pos];
          return embedding ? [{ contentHash: contentHashes[idx] as string, embedding, modelId }] : [];
        });
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
 * cache. Empty set on any read/parse error — fail-safe to "annotate nothing"
 * so the LLM still proposes.
 */
function loadPendingConsolidateProposalHashes(stashDir: string): Set<string> {
  const hashes = new Set<string>();
  try {
    const pending = listProposalsReadOnly(stashDir, { status: "pending" }).filter(
      (proposal) => proposal.source === "consolidate",
    );
    for (const p of pending) {
      try {
        hashes.add(cacheHash(proposalContent(p)));
      } catch {
        // skip malformed payloads — they can't dedup anyway
      }
    }
  } catch {
    // listProposals throws on missing stash dir during tests — empty set is safe
  }
  return hashes;
}

/**
 * Hash the bodies of live knowledge assets once per consolidation run.
 *
 * Pending-proposal dedup prevents repeated queue entries, but accepted
 * proposals leave that set. Without a live-asset guard, the next run can copy
 * the same memory body into a new knowledge slug indefinitely. Scan the target
 * tree directly (rather than trusting the asynchronously refreshed index) so
 * an already-written asset suppresses recurrence immediately.
 */
export function loadExistingKnowledgeBodyHashes(targetRoot: string): Set<string> {
  const hashes = new Set<string>();
  const knowledgeRoot = path.join(targetRoot, "knowledge");
  if (!fs.existsSync(knowledgeRoot)) return hashes;

  const visit = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        try {
          hashes.add(cacheHash(fs.readFileSync(entryPath, "utf8")));
        } catch {
          // An unreadable asset cannot provide reliable duplicate evidence.
        }
      }
    }
  };

  visit(knowledgeRoot);
  return hashes;
}

/** Parse a stored provenance ref and emit its canonical D-R5 display spelling. */
function canonicalStoredXref(ref: string): string | undefined {
  try {
    const p = parseRefInput(ref);
    return displayRef({ type: p.type, name: p.name, bundleId: p.origin });
  } catch {
    return undefined;
  }
}

function canonicalXref(ref: string): string {
  return canonicalStoredXref(ref) ?? ref;
}

/**
 * The promoted asset's provenance xref set: existing body-frontmatter xrefs +
 * the promoted source ref, deduped after canonicalization (WI-8.5b: emitted in
 * the D-R5 new grammar via {@link canonicalXref}).
 */
function promoteProvenanceXrefs(existing: unknown, sourceRef: string): string[] {
  const priors = Array.isArray(existing) ? existing.map(String) : [];
  return [...new Set([...priors, sourceRef].map(canonicalXref))];
}

// ── LLM resolution ──────────────────────────────────────────────────────────

/**
 * Resolve the symbolic LLM runner for the consolidate pass.
 *
 * Priority order (mirrors extract / reflect / distill — see
 * `resolveExtractRunConfig` in `src/commands/improve/extract.ts` and the
 * canonical improve execution-cascade pattern):
 *
 *   1. `improve.strategies.<name>.processes.consolidate.engine`
 *      via the common execution planner. Lets the user pin
 *      a dedicated model (e.g. `ministral-3b`) for consolidation instead of
 *      whatever `defaults.llmEngine` happens to be.
 *   2. the baseline default LLM engine.
 *
 * All consolidate execution crosses the same improve engine-resolution
 * boundary as extract, reflect, and distill.
 */
function resolveConsolidateLlmRunner(
  config: AkmConfig,
  activeProfile?: ImproveProfileConfig,
): ReturnType<typeof resolveImproveLlmExecution> {
  return resolveImproveLlmExecution({
    config,
    profile: activeProfile,
    process: getImproveProcessConfig("consolidate", activeProfile),
    processName: "consolidate",
  });
}

function consolidateRunnerFromOptions(
  opts: AkmConsolidateOptions,
  config: AkmConfig,
): Extract<RunnerSpec, { kind: "llm" }> | undefined {
  if (Object.hasOwn(opts, "llmRunner")) return opts.llmRunner ?? undefined;
  const resolved = resolveConsolidateLlmRunner(config, opts.improveProfile);
  if (resolved) opts.onNotices?.(resolved.notices);
  return resolved?.runner;
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

function resolveConsolidationWriteTarget(opts: AkmConsolidateOptions, config: AkmConfig): ResolvedWriteTarget {
  if (opts.writeTarget) {
    const root = path.resolve(opts.writeTarget.source.path);
    return {
      ...opts.writeTarget,
      source: {
        ...opts.writeTarget.source,
        path: root,
        adapterId: opts.writeTarget.source.adapterId ?? detectAdapterId(root),
      },
    };
  }
  if (opts.target) {
    const target = resolveWriteTarget(config, opts.target);
    return { ...target, source: { ...target.source, path: path.resolve(target.source.path) } };
  }

  if (opts.stashDir) {
    const root = path.resolve(opts.stashDir);
    return {
      source: { kind: "filesystem", name: "stash", path: root, adapterId: detectAdapterId(root) },
      config: { type: "filesystem", name: "stash", path: root, writable: true },
    };
  }

  const target = resolveWriteTarget(config);
  return { ...target, source: { ...target.source, path: path.resolve(target.source.path) } };
}

export async function akmConsolidate(opts: AkmConsolidateOptions = {}): Promise<ConsolidateResult> {
  const startMs = Date.now();
  // Derive a stable PROV-DM token for this run. Callers (e.g. akmImprove)
  // should pass opts.sourceRun to tie proposals back to the parent run;
  // standalone `akm consolidate` gets a self-contained token.
  const sourceRun = opts.sourceRun ?? `consolidate-${startMs}`;
  const config = opts.config ?? loadConfig();
  const writeTarget = resolveConsolidationWriteTarget(opts, config);
  opts = { ...opts, target: writeTarget.source.name, writeTarget };
  const activeProfile = opts.improveProfile ?? resolveImproveStrategy(undefined, config).config;
  opts = { ...opts, improveProfile: activeProfile };
  const stashDir = writeTarget.source.path;
  const executionNotices = new Map<string, Readonly<LoweringNotice>>();
  const externalOnNotices = opts.onNotices;
  const collectNotices = (notices: readonly Readonly<LoweringNotice>[]): void => {
    for (const notice of notices) executionNotices.set(JSON.stringify(notice), notice);
    externalOnNotices?.(notices);
  };
  opts = { ...opts, onNotices: collectNotices };
  const consolidateEnabled = resolveProcessEnabled("consolidate", activeProfile);
  const frozenLlmRunner = consolidateEnabled ? consolidateRunnerFromOptions(opts, config) : undefined;
  // Own the field even when no runner exists. Every downstream reader now
  // observes this one symbolic snapshot instead of re-running config/model-map
  // selection during the same invocation.
  opts = { ...opts, llmRunner: frozenLlmRunner ?? null };
  const withNotices = (result: ConsolidateResult): ConsolidateResult =>
    executionNotices.size > 0 ? { ...result, notices: Object.freeze([...executionNotices.values()]) } : result;

  // WI-9.10: construct this run's RunContext from values already resolved
  // above (sourceRun, config, stashDir) — no second config load, no new db
  // handle. consolidate.ts has no `eventsCtx`/proposals-`ctx` option at all
  // (WS-3a retired its only appendEvent usage; `emitProposal` here is always
  // called with the default, seam-less ProposalsContext — see
  // emitPromotionProposal below), so both get the safe empty-object default,
  // behaviorally identical to `undefined` (EventsContext/ProposalsContext
  // fields are all optional-chained by their consumers). LLM work uses the
  // already-frozen symbolic runner through the shared dispatch seam.
  const runContext: RunContext = createRunContext({
    stashDir,
    config,
    eventsCtx: {},
    proposalsCtx: {},
    getLlmRunner: () => opts.llmRunner ?? null,
    sourceRun,
    dryRun: opts.dryRun ?? false,
    signal: opts.signal,
  });

  const warnings: string[] = [];

  if (!consolidateEnabled) {
    return withNotices(
      makeConsolidateResult({
        // Sourced from runContext (identical value to `opts.dryRun ?? false`)
        // so the constructed RunContext has a genuine downstream reference —
        // consolidate's own content-read sites are out of this stage's stated
        // item-2 scope (reflect + distill only; see the WI-9.10c report).
        dryRun: runContext.dryRun,
        target: opts.target ?? stashDir,
        durationMs: Date.now() - startMs,
        warnings,
      }),
    );
  }

  // WS-3a: open one state.db handle shared by the body-embedding cache (dedup
  // + cluster) and the judged-state cache. All callers in the function body
  // receive this handle; it is closed in the `finally` block below.
  // Fail-open: any open error leaves it `undefined` and all cache paths skip.
  let sharedStateDb: Database | undefined;
  if (config.embedding) {
    try {
      sharedStateDb = openStateDatabase();
    } catch {
      // State DB unavailable → skip the embedding cache for this run.
    }
  }

  try {
    return withNotices(await akmConsolidateInner(opts, config, stashDir, startMs, warnings, sharedStateDb));
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
 * envelope — empty pool or no incremental candidates) and `done` carries the
 * finished {@link ConsolidateResult}, or the pool survived narrowing and the
 * pass hands back the filtered memories plus the state the later passes need.
 */
type NarrowPoolResult =
  | { done: true; result: ConsolidateResult }
  | {
      done: false;
      memories: MemoryEntry[];
      dedupPoolSize: number;
    };

export interface ConsolidationPoolSnapshot {
  /** Eligible on-disk memories before incremental narrowing and the limit. */
  poolSize: number;
  /** Pool after incremental narrowing and the configured limit. */
  candidatePoolSize: number;
  /** Pool after incremental narrowing but before the configured limit. */
  dedupPoolSize: number;
  memories: MemoryEntry[];
}

interface ConsolidationSourceOwner {
  bundleId: string;
  sourceRoot: string;
  excludedSourceRoots: ReadonlySet<string>;
}

function resolveConsolidationSourceOwner(
  opts: AkmConsolidateOptions,
  stashDir: string,
): ConsolidationSourceOwner | undefined {
  const targetRoot = path.resolve(opts.writeTarget?.source.path ?? stashDir);
  try {
    const sources = resolveSourceEntries(stashDir, opts.config);
    const installations = deriveInstallations(sources);
    const targetIndex = sources.findIndex((source) => path.resolve(source.path) === targetRoot);
    const target = installations[targetIndex];
    if (!target) return undefined;
    return {
      bundleId: target.id,
      sourceRoot: targetRoot,
      excludedSourceRoots: new Set(
        sources
          .filter((_, index) => index !== targetIndex)
          .map((source) => path.resolve(source.path))
          .filter((sourceRoot) => sourceRoot.startsWith(`${targetRoot}${path.sep}`)),
      ),
    };
  } catch {
    return undefined;
  }
}

/**
 * Read and narrow the exact pool the live pass consumes, without embedding,
 * LLM, proposal, event, or asset writes. Used by both preview and execution.
 */
export function inspectConsolidationPool(
  opts: AkmConsolidateOptions,
  stashDir: string,
  warnings: string[],
  access?: { readOnly?: boolean },
): ConsolidationPoolSnapshot {
  const readOnly = access?.readOnly === true;
  const sourceOwner = resolveConsolidationSourceOwner(opts, stashDir);
  let memories = loadMemoriesForSource(sourceOwner, warnings, readOnly);
  const staleCount = memories.filter((memory) => !fs.existsSync(memory.filePath)).length;
  if (staleCount > 0) {
    warnings.push(
      `Pre-flight: filtered ${staleCount} stale DB entr${staleCount === 1 ? "y" : "ies"} (file absent on disk) from memory pool before chunking.`,
    );
  }
  memories = memories.filter((memory) => fs.existsSync(memory.filePath));
  const poolSize = memories.length;

  if (opts.incrementalSince && memories.length > 0) {
    memories = narrowToIncrementalCandidates(
      memories,
      opts.incrementalSince,
      warnings,
      opts.neighborsPerChanged,
      readOnly,
    );
  }
  const dedupPoolSize = memories.length;

  if (opts.limit === undefined && memories.length > 150) {
    warnings.push(
      `Consolidation: pool has ${memories.length} memories and no limit is set. Consider adding a limit to your consolidate config to prevent timeouts on slow LLM endpoints.`,
    );
  }

  if (opts.limit !== undefined && memories.length > opts.limit) {
    const mtimeOf = (memory: MemoryEntry): number => {
      try {
        return fs.statSync(memory.filePath).mtimeMs;
      } catch {
        return 0;
      }
    };
    const mtimeCache = new Map(memories.map((memory) => [memory.filePath, mtimeOf(memory)]));
    memories = [...memories].sort((a, b) => (mtimeCache.get(a.filePath) ?? 0) - (mtimeCache.get(b.filePath) ?? 0));
    warnings.push(
      `Consolidation: pool capped at ${opts.limit} of ${memories.length} memories (limit option, oldest-modified first).`,
    );
    memories = memories.slice(0, opts.limit);
  }

  return { poolSize, candidatePoolSize: memories.length, dedupPoolSize, memories };
}

/**
 * Pass 1 — narrow the memory pool before any LLM work: drop stale DB entries,
 * apply incremental-since narrowing, and cap to `opts.limit` (oldest-modified
 * first). Returns an early envelope when the pool empties at any stage;
 * otherwise returns the narrowed pool and the state the plan/apply passes
 * consume. Behavior-identical to the former inlined narrowing block.
 */
async function narrowConsolidationPool(
  opts: AkmConsolidateOptions,
  stashDir: string,
  startMs: number,
  warnings: string[],
): Promise<NarrowPoolResult> {
  const snapshot = inspectConsolidationPool(opts, stashDir, warnings);
  const memories = snapshot.memories;

  // (The former WS-3b Step 0a homeostatic demotion pass was removed — R4:
  // it was default-off and self-undoing (the next salience recompute
  // unconditionally overwrote the demoted values). Continuous decay now lives
  // in computeSalience's recency term, whose floor decays on a long half-life.)

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

  return { done: false, memories, dedupPoolSize: snapshot.dedupPoolSize };
}

/**
 * Pass 2 — turn the narrowed pool into an executable plan. Sizes chunks to the
 * model context window, clusters by embedding similarity, injects the
 * anti-collapse random fraction, applies the cold-start budget cap, runs the
 * per-chunk LLM calls (with retry + failure-rate abort), and reconciles the
 * per-chunk op arrays via {@link mergePlans}. Populates `accounting` in place.
 * Behavior-identical to the former inlined plan-generation block.
 */
/**
 * Per-chunk judgedNoAction accounting: count memories the LLM saw inside a chunk
 * but proposed no op for. Membership is by `memory:<name>` ref against the
 * targets of each op (primary + secondaries for merge; ref otherwise). 2026-05-26:
 * pre-fix this was a 78/119 (66%) silent drop in the cron run — no warning,
 * event, or counter. See tuning investigation §Q2. Moved verbatim.
 */
function recordChunkJudgedNoAction(
  chunk: MemoryEntry[],
  ops: ConsolidateOperation[],
  accounting: ConsolidateAccounting,
): void {
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
    const memRef = conceptIdFromTypeName("memory", m.name);
    if (!targetRefs.has(memRef)) {
      chunkNoAction++;
      accounting.judgedNoActionRefs.add(memRef);
    }
  }
  accounting.judgedNoAction += chunkNoAction;
}

/**
 * Per-chunk LLM judge loop — the heart of plan generation. Iterates the sized
 * chunks, applies the budget-abort/failure-rate/all-hot guards, calls the model
 * (with one retry), validates the returned ops, and accumulates the per-chunk
 * judgedNoAction accounting. Extracted verbatim from `planConsolidation`: the
 * abort-rate policy, all-hot early-exit, and the 2026-05-26 accounting invariant
 * (`processed == actioned + judgedNoAction + Σ(skipReasons) + failedChunkMemories`)
 * are byte-identical, and every counter-increment point is unmoved.
 */
async function judgeConsolidationChunks(args: {
  chunks: MemoryEntry[][];
  opts: AkmConsolidateOptions;
  config: AkmConfig;
  llmRunner: Extract<RunnerSpec, { kind: "llm" }> | undefined;
  lease: LoweredExecutionDispatchLease | undefined;
  sourceName: string;
  bodyTruncation: number;
  pendingProposalBodyHashes: Set<string>;
  standardsContext: string;
  warnings: string[];
  accounting: ConsolidateAccounting;
}): Promise<ConsolidateOperation[][]> {
  const {
    chunks,
    opts,
    config,
    llmRunner,
    lease,
    sourceName,
    bodyTruncation,
    pendingProposalBodyHashes,
    standardsContext,
    warnings,
    accounting,
  } = args;
  const chunkOpsArrays: ConsolidateOperation[][] = [];
  // judgedNoAction tracks memories the LLM saw inside a chunk but proposed
  // no op for. Computed per chunk as `chunk.length − unique(targetRefs in ops)`.
  // The structured skip-reason histogram (2026-05-26) plus the cross-chunk
  // double-count fixes now live on `accounting`; every deterministic post-LLM
  // op rejection site calls `accounting.pushSkipReason`. See
  // `/tmp/akm-health-investigations/tuning-reasons-investigation.md` §Q2.
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
          accounting.failedChunkMemories += chunks[i]!.length;
        }
        break;
      }
    }

    const chunk = chunks[chunkIdx]!;

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
      for (const m of chunk) accounting.judgedNoActionRefs.add(conceptIdFromTypeName("memory", m.name));
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
    const callChunkLlm = async (fallbackError: string) => {
      // The gate runs with enabled:true (always open), so this guard is
      // exactly the envelope the gated fn used to return first thing.
      if (!llmRunner) return { ok: false as const, error: "No LLM configured for consolidation" };
      return callStructured<{ ok: true; content: string } | { ok: false; error: string }>({
        feature: "memory_consolidation",
        akmConfig: config,
        enabled: true,
        runner: llmRunner,
        ...(lease ? { lease } : {}),
        messages: [
          { role: "system", content: CONSOLIDATE_SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        request: {
          responseSchema: CONSOLIDATE_PLAN_JSON_SCHEMA,
          enableThinking: false,
          timeoutMs: llmRunner.timeoutMs,
          signal: opts.signal,
        },
        parse: (raw) => ({ ok: true as const, content: raw ?? "" }),
        // A transport throw was caught INSIDE the gated fn and returned as an
        // {ok:false} envelope (never reaching the gate's fallback); onError
        // reproduces that. The fallback fires only on wrapper timeout.
        onError: (_cls, e) => ({ ok: false as const, error: String(e) }),
        fallback: { ok: false as const, error: fallbackError },
        ...(opts.onNotices ? { onNotices: opts.onNotices } : {}),
      });
    };

    // callChunkLlm already retries once internally (llm/client.ts's
    // chatCompletion, jittered 200-800ms backoff) — a second, outer retry
    // here stacked an uncoordinated fixed 2s backoff on top of it. Removed;
    // only mark the chunk failed once the single retry the client already
    // performs has been exhausted.
    const raw = await callChunkLlm(`chunk ${chunkIdx + 1} failed`);

    if (!raw.ok) {
      warn(raw.error ?? `chunk ${chunkIdx + 1} failed`);
      warnings.push(raw.error ?? `chunk ${chunkIdx + 1} failed`);
      totalChunksProcessed++;
      accounting.totalChunksFailed++;
      // Account for the chunk's memories under the failed-chunk bucket.
      // judgedNoAction does NOT run on this path (it's after the success
      // guards) so without this the accounting invariant breaks on every
      // chunk-level transport/parse failure.
      accounting.failedChunkMemories += chunk.length;
      continue;
    }

    // C9 action 1: AKM_DEBUG_LLM was a separate, undocumented env var for this
    // one diagnostic; folded into the standard AKM_VERBOSE gate (warnVerbose)
    // rather than kept as its own toggle.
    {
      const preview = (raw.content ?? "").slice(0, 500);
      warnVerbose(`[akm:consolidate] chunk ${chunkIdx + 1} raw response (first 500 chars): ${preview}`);
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

    recordChunkJudgedNoAction(chunk, ops, accounting);

    chunkOpsArrays.push(ops);
  }

  return chunkOpsArrays;
}

async function planConsolidation(
  opts: AkmConsolidateOptions,
  config: AkmConfig,
  stashDir: string,
  _startMs: number,
  memories: MemoryEntry[],
  warnings: string[],
  sharedStateDb: Database | undefined,
  accounting: ConsolidateAccounting,
): Promise<{
  allOps: ConsolidateOperation[];
  totalChunks: number;
  llmPoolSize: number;
  deferredMemories: number;
  embedTelemetry: ClusterEmbedTelemetry;
  sourceName: string;
}> {
  // Consolidation always uses the HTTP LLM client directly — never the agent
  // CLI. The agent CLI is for interactive agent sessions (reflect, propose);
  // structured JSON generation works better and faster via HTTP.
  //
  // The outer invocation freezes standalone and improve-owned selection once.
  const llmRunner = opts.llmRunner ?? undefined;

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
  const modelContextLength = llmRunner?.connection.contextLength ?? DEFAULT_CONTEXT_LENGTH_TOKENS;
  const chunkSize = computeSafeChunkSize(modelContextLength, bodyTruncation, opts.maxChunkSize);

  // -- Phase A: plan generation -----------------------------------------------
  const sourceName = opts.target ?? stashDir;

  let budgetedMemories = memories;
  if (opts.signal) {
    const budgetMs = (opts.signal as AbortSignal & { remainingBudgetMs?: number }).remainingBudgetMs;
    if (budgetMs !== undefined) {
      const p90Chunk = opts.p90ChunkSecondsDefault ?? 30;
      const safeChunks = Math.max(0, Math.floor((Math.max(0, budgetMs) / 1000 / p90Chunk) * 0.6));
      const cap = safeChunks * chunkSize;
      if (cap < memories.length) {
        budgetedMemories = memories
          .map((entry) => {
            let mtimeMs = 0;
            try {
              mtimeMs = fs.statSync(entry.filePath).mtimeMs;
            } catch {
              // Missing files sort first and are filtered by the existing guards.
            }
            return { entry, mtimeMs };
          })
          .sort((a, b) => a.mtimeMs - b.mtimeMs || a.entry.name.localeCompare(b.entry.name))
          .map(({ entry }) => entry)
          .slice(0, cap);
        const msg = `[consolidate] cold-start budget: reducing pool from ${memories.length} to ${budgetedMemories.length} memories (${safeChunks} safe chunks; remainder deferred).`;
        warn(msg);
        warnings.push(msg);
      }
    }
  }

  // WS-5: capture llmPoolSize after every pre-LLM cap.
  const llmPoolSize = budgetedMemories.length;
  const dispatchingChunks: MemoryEntry[][] = [];
  for (let i = 0; i < budgetedMemories.length; i += chunkSize) {
    const chunk = budgetedMemories.slice(i, i + chunkSize);
    if (chunk.length > 0 && !chunk.every((memory) => isHotCapturedMemory(memory.filePath))) {
      dispatchingChunks.push(chunk);
    }
  }
  const dispatchLease =
    llmRunner && dispatchingChunks.length > 0 ? await preflightStructuredLlmRunner(llmRunner) : undefined;

  try {
    // C-1 / #380: Pre-cluster memories by embedding similarity before chunking.
    // This ensures that semantically similar memories land in the same LLM
    // context window, allowing the model to detect and merge duplicates that
    // would otherwise be split across chunks and survive indefinitely.
    // mem0 arXiv:2504.19413, A-MEM arXiv:2502.12110.
    // Fails open: if embeddings are unavailable or fail, original order is used.
    const { ordered: clusteredMemories, embedTelemetry } = await clusterMemoriesBySimilarity(
      budgetedMemories,
      config,
      sharedStateDb,
      opts.signal,
    );

    // WS-3b Anti-collapse step 8c: inject random (non-similar) clusters.
    // A small fraction (default 5%) of the pool is shuffled into random positions
    // so the pipeline isn't PURELY similarity-driven. This prevents rich-get-richer
    // entrenchment where only the most-retrieved assets ever get consolidated.
    // DEFAULT ON since R5 — opt out via antiCollapse.enabled: false.
    let finalClusteredMemories = clusteredMemories;
    {
      const antiCollapseForCluster: AntiCollapseConfig =
        (getImproveProcessConfig("consolidate", opts.improveProfile)?.antiCollapse as AntiCollapseConfig | undefined) ??
        {};
      if (antiCollapseForCluster.enabled !== false && clusteredMemories.length > 2) {
        const fraction = antiCollapseForCluster.randomClusterFraction ?? DEFAULT_RANDOM_CLUSTER_FRACTION;
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

    warn(
      `[consolidate] ${budgetedMemories.length} memories / ${chunks.length} chunk(s) / chunk_size=${chunkSize}` +
        ` / pending-proposal hashes: ${pendingProposalBodyHashes.size}`,
    );

    // Consolidate output merges memories (non-wiki) → stash authoring standards.
    // Resolved ONCE per run and passed to each chunk prompt (facts not re-read
    // per chunk).
    const standardsContext = resolveStandardsContext("memories/_consolidated", stashDir);

    const chunkOpsArrays = await judgeConsolidationChunks({
      chunks,
      opts,
      config,
      llmRunner,
      lease: dispatchLease,
      sourceName,
      bodyTruncation,
      pendingProposalBodyHashes,
      standardsContext,
      warnings,
      accounting,
    });

    // Build the known-refs set from the already-filtered memory pool so
    // mergePlans() can reject LLM-hallucinated primary refs before execution.
    const knownRefs = new Set(budgetedMemories.map((m) => conceptIdFromTypeName("memory", m.name)));
    const { ops: allOps, warnings: mergeWarnings } = mergePlans(chunkOpsArrays, knownRefs);
    warnings.push(...mergeWarnings);

    return {
      allOps,
      totalChunks: chunks.length,
      llmPoolSize,
      deferredMemories: memories.length - budgetedMemories.length,
      embedTelemetry,
      sourceName,
    };
  } finally {
    if (dispatchLease) disposeLoweredExecutionDispatchLease(dispatchLease);
  }
}

async function akmConsolidateInner(
  opts: AkmConsolidateOptions,
  config: import("../../core/config/config").AkmConfig,
  stashDir: string,
  startMs: number,
  warnings: string[],
  sharedStateDb: Database | undefined,
): Promise<ConsolidateResult> {
  // -- Pass 1: narrow the memory pool (may early-return an envelope) ----------
  const narrowed = await narrowConsolidationPool(opts, stashDir, startMs, warnings);
  if (narrowed.done) return narrowed.result;
  const { memories, dedupPoolSize } = narrowed;

  // -- Pass 2: build the LLM plan (populates the shared accounting counters) ---
  const accounting = createConsolidateAccounting();
  const { allOps, totalChunks, llmPoolSize, deferredMemories, embedTelemetry, sourceName } = await planConsolidation(
    opts,
    config,
    stashDir,
    startMs,
    memories,
    warnings,
    sharedStateDb,
    accounting,
  );

  // -- Dry-run: show AI plan without executing any writes --------------------
  if (opts.dryRun) {
    return makeConsolidateResult({
      dryRun: true,
      previewOnly: true,
      target: sourceName,
      processed: llmPoolSize,
      failedChunks: accounting.totalChunksFailed,
      totalChunks,
      judgedNoAction: accounting.judgedNoAction,
      skipReasons: accounting.skipReasons,
      // No merge has executed on the preview path — the per-secondary tally is
      // provably still 0 here (it only increments in the op-execution loop).
      mergedSecondaries: 0,
      failedChunkMemories: accounting.failedChunkMemories,
      deferredMemories,
      planned: allOps,
      warnings,
      durationMs: Date.now() - startMs,
    });
  }

  warn(`[consolidate] plan: ${allOps.length} operation(s)`);

  // Destructive operations remain advisory. Promote is safe to execute because
  // it emits a reviewable proposal rather than mutating an asset.
  const promoted: string[] = [];
  const promotionFailures = { count: 0 };
  const memoryByRef = new Map(memories.map((memory) => [conceptIdFromTypeName("memory", memory.name), memory]));
  const promoteContext: PromoteContext = {
    config,
    stashDir,
    sourceRun: opts.sourceRun ?? `consolidate-${startMs}`,
    proposalsCtx: opts.proposalsCtx,
    target: opts.writeTarget as ResolvedWriteTarget,
    memoryByRef,
    promoted,
    promotedSourceRefs: new Set<string>(),
    existingKnowledgeBodyHashes: loadExistingKnowledgeBodyHashes((opts.writeTarget as ResolvedWriteTarget).source.path),
    promotionFailures,
    warnings,
    pushSkipReason: accounting.pushSkipReason,
    llmRunner: opts.llmRunner ?? null,
  };
  for (const op of allOps) {
    if (op.op === "promote") await emitPromotionProposal(op, promoteContext);
  }

  return makeConsolidateResult({
    target: sourceName,
    processed: llmPoolSize,
    failedChunks: accounting.totalChunksFailed,
    totalChunks,
    judgedNoAction: accounting.judgedNoAction,
    skipReasons: accounting.skipReasons,
    mergedSecondaries: 0,
    failedChunkMemories: accounting.failedChunkMemories,
    deferredMemories,
    promoted,
    failedPromotions: promotionFailures.count,
    planned: allOps,
    warnings,
    durationMs: Date.now() - startMs,
    perfTelemetry: {
      dedupPoolSize,
      llmPoolSize,
      embedMs: embedTelemetry.embedMs,
      embedCacheHits: embedTelemetry.cacheHits,
      embedCacheMisses: embedTelemetry.cacheMisses,
    },
  });
}

/** @internal Exported for promotion-path integration tests. */
export interface PromoteContext {
  config: AkmConfig;
  stashDir: string;
  sourceRun: string;
  proposalsCtx?: ProposalsContext;
  target: ResolvedWriteTarget;
  memoryByRef: Map<string, MemoryEntry>;
  promoted: string[];
  promotedSourceRefs: Set<string>;
  existingKnowledgeBodyHashes: Set<string>;
  promotionFailures: { count: number };
  warnings: string[];
  pushSkipReason: ConsolidateAccounting["pushSkipReason"];
  llmRunner?: Extract<RunnerSpec, { kind: "llm" }> | null;
}

/** Reject a promotion when its body already exists in knowledge or the queue. */
function shouldSkipPromotionBodyDuplicate(args: {
  bodyHash: string;
  op: ConsolidatePromoteOp;
  knowledgeRef: string;
  ctx: PromoteContext;
}): boolean {
  const { bodyHash, op, knowledgeRef, ctx } = args;
  if (ctx.existingKnowledgeBodyHashes.has(bodyHash)) {
    ctx.warnings.push(
      `Skipping promote: identical body already exists in knowledge; skipping duplicate for ${op.ref} → ${knowledgeRef}`,
    );
    ctx.pushSkipReason("promote", op.ref, "dedup_existing_knowledge");
    return true;
  }

  const contentDupProposal = listProposals(ctx.stashDir, { status: "pending" })
    .filter((proposal) => proposal.source === "consolidate")
    .find((proposal) => cacheHash(proposalContent(proposal)) === bodyHash);
  if (!contentDupProposal) return false;

  ctx.warnings.push(
    `Skipping promote: identical body already pending as proposal ${contentDupProposal.id} (ref: ${contentDupProposal.ref}); skipping duplicate for ${op.ref} → ${knowledgeRef}`,
  );
  ctx.pushSkipReason("promote", op.ref, "dedup_pending_proposal");
  return true;
}

/** Execute one reconciled promotion by emitting a reviewable proposal. */
/** @internal Executes the real proposal-emission path for one promote operation. */
export async function emitPromotionProposal(op: ConsolidatePromoteOp, ctx: PromoteContext): Promise<void> {
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

  const proposedName =
    op.knowledgeRef.split("/").filter(Boolean).at(-1) ??
    entry.name.split("/").filter(Boolean).at(-1) ??
    "promoted-memory";
  const slug = proposedName
    .replace(/[^a-z0-9-]/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
  const knowledgeRef = conceptIdFromTypeName("knowledge", slug);
  parseRefInput(knowledgeRef);
  if (knowledgeRef !== op.knowledgeRef) {
    warnings.push(`Normalized generated ref "${op.knowledgeRef}" → "${knowledgeRef}"`);
  }

  // A pending proposal may carry a qualified item_ref, so compare its parsed
  // conceptId rather than exact display spelling.
  if (hasPendingProposalForConcept(stashDir, knowledgeRef)) {
    warnings.push(`Skipping promote: pending proposal already exists for ${knowledgeRef}`);
    pushSkipReason("promote", op.ref, "promote_pending_proposal_exists");
    return;
  }

  // Idempotency: check if knowledge asset already exists
  const parsedKnowledgeRef = parseRefInput(knowledgeRef);
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

  // Validate and normalize source content before proposing a promoted asset.
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
  if (shouldSkipPromotionBodyDuplicate({ bodyHash, op, knowledgeRef, ctx })) return;

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
      xrefs: promoteProvenanceXrefs(parsedMemory.data?.xrefs, op.ref),
    };
    const serializedMergedFm = serializeFrontmatter(mergedBodyFm);
    const promotedAssetContent = assembleAssetFromString(serializedMergedFm, parsedMemory.content);

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

    const proposalResult = emitProposal(
      { stashDir, proposalsCtx: ctx.proposalsCtx },
      {
        ref: knowledgeRef,
        target: { source: target.source.name, root: target.source.path },
        source: "consolidate",
        sourceRun,
        // §23.6 fingerprint model-id term (WI-6.4).
        ...(ctx.llmRunner?.connection.model ? { modelId: ctx.llmRunner.connection.model } : {}),
        payload: {
          content: promotedAssetContent,
          frontmatter: { description, xrefs: [canonicalXref(op.ref)] },
        },
        ...(typeof op.confidence === "number" ? { confidence: op.confidence } : {}),
      },
    );
    if (isProposalSkipped(proposalResult)) {
      warnings.push(`Promote: skipped proposal for ${op.ref} (${proposalResult.reason}): ${proposalResult.message}`);
      pushSkipReason("promote", op.ref, `promote_proposal_${proposalResult.reason}`);
    } else {
      promoted.push(proposalResult.id);
      promotedSourceRefs.add(op.ref);
    }
  } catch (e) {
    ctx.promotionFailures.count++;
    warnings.push(`Promote: createProposal failed for ${op.ref}: ${String(e)}`);
    pushSkipReason("promote", op.ref, "promote_create_failed");
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
/** The conceptId a proposal ref maps to, or undefined for an invalid ref. */
function conceptIdForRef(ref: string): string | undefined {
  try {
    const p = parseRefInput(ref);
    return conceptIdFromTypeName(p.type, p.name);
  } catch {
    return undefined;
  }
}

/** Is a pending proposal already queued for `conceptRef`'s concept? */
function hasPendingProposalForConcept(stashDir: string, conceptRef: string): boolean {
  const want = conceptIdForRef(conceptRef);
  return (
    want !== undefined && listProposals(stashDir, { status: "pending" }).some((p) => conceptIdForRef(p.ref) === want)
  );
}

function normalizeSlugForDedup(ref: string): string {
  const slug = parseRefInput(ref).name;
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
export function narrowToIncrementalCandidates(
  memories: MemoryEntry[],
  since: string,
  warnings: string[],
  neighborsPerChanged = 5,
  readOnly = false,
): MemoryEntry[] {
  // Lenient by design: garbage `since` passes through unchanged and the ISO
  // string comparison below then selects nothing (see core/time.ts doc).
  const sinceIso = parseSinceToIsoLenient(since);
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
    db = readOnly ? openReadonlyExistingDatabase(undefined, { isolatedSnapshot: true }) : openExistingDatabase();
    if (!db) return memories;
    for (const m of changed) {
      const id = findEntryIdByRef(db, conceptIdFromTypeName("memory", m.name));
      if (id === undefined) continue;
      // index-redesign-contract.md B5f item 4 — `getNeighborsByEntryId`
      // (units-repository.ts) already excludes the querying entry itself, so
      // `neighborsPerChanged` genuinely OTHER neighbours are requested
      // directly (no `+ 1` for self, no self-filter here).
      for (const hit of getNeighborsByEntryId(db, id, neighborsPerChanged)) {
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

function loadMemoriesForSource(
  source: ConsolidationSourceOwner | undefined,
  warnings: string[],
  readOnly: boolean,
): MemoryEntry[] {
  // Load from DB first
  let memories: MemoryEntry[] = [];
  let db: ReturnType<typeof openExistingDatabase> | undefined;
  try {
    db = readOnly ? openReadonlyExistingDatabase(undefined, { isolatedSnapshot: true }) : openExistingDatabase();
    if (!db) throw new Error("index unavailable");
    const entries: DbIndexedEntry[] = getAllEntries(db, "memory");
    memories = entries
      .filter((entry) => source !== undefined && entry.bundleId === source.bundleId)
      .filter((e) => isConsolidationEligibleMemoryName(e.entry.name))
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
        stashDir: source?.sourceRoot ?? "",
      }));
  } catch {
    memories = [];
  } finally {
    if (db) closeDatabase(db);
  }

  if (memories.length === 0 && source) {
    // DB fallback: walk filesystem
    const memoriesDir = path.join(source.sourceRoot, "memories");
    const fsStashDir = source.sourceRoot;
    if (fs.existsSync(memoriesDir)) {
      const pending = [memoriesDir];
      while (pending.length > 0) {
        const current = pending.pop() as string;
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
          const filePath = path.join(current, entry.name);
          if (entry.isDirectory()) {
            if (source.excludedSourceRoots.has(path.resolve(filePath))) continue;
            pending.push(filePath);
            continue;
          }
          if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
          const name = path.relative(memoriesDir, filePath).replace(/\.md$/, "").split(path.sep).join("/");
          if (!isConsolidationEligibleMemoryName(name)) continue;
          memories.push({ name, filePath, description: "", tags: [], stashDir: fsStashDir });
        }
      }
    }
    if (memories.length > 0) {
      warnings.push("DB not found or empty — loaded memories directly from filesystem.");
    }
  }
  return memories;
}
