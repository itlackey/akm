// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm consolidate` — show the model the memory pool in chunks of similar
 * memories and queue a knowledge proposal for each memory it says should be
 * promoted. Promotion is the only operation: it emits a reviewable proposal and
 * never touches the memory. Memories the improve ledger judged recently and
 * that have not changed since are not judged again.
 *
 * Accounting invariant: `processed == promoted + judgedNoAction +
 * Σ(skipReasons) + failedChunkMemories`.
 */

import fs from "node:fs";
import path from "node:path";
import consolidateSystemPrompt from "../../assets/prompts/consolidate-system.md" with { type: "text" };
import { detectAdapterId } from "../../core/adapter/detect-adapter";
import { assembleAssetFromString, serializeFrontmatter } from "../../core/asset/asset-serialize";
import { parseFrontmatter } from "../../core/asset/frontmatter";
import { conceptIdFromTypeName, displayRef, parseRefInput } from "../../core/asset/resolve-ref";
import type { AkmConfig, ImproveProfileConfig } from "../../core/config/config";
import { getImproveProcessConfig, loadConfig } from "../../core/config/config";
import type { ConsolidateOpKind, ConsolidateResult } from "../../core/improve-types";
import { parseEmbeddedJsonResponse } from "../../core/parse";
import { openStateDatabase } from "../../core/state-db";
import { parseSinceToIsoLenient } from "../../core/time";
import { warn, warnVerbose } from "../../core/warn";
import { type ResolvedWriteTarget, resolveWriteTarget } from "../../core/write-source";
import { deriveInstallations } from "../../indexer/installations";
import { resolveSourceEntries } from "../../indexer/search/search-source";
import { assertRunnerCredentials } from "../../integrations/agent/runner-dispatch";
import { cosineSimilarity, embedBatch, resolveEmbeddingModelId } from "../../llm/embedder";
import type { Database } from "../../storage/database";
import { getBodyEmbeddings, upsertBodyEmbeddings } from "../../storage/repositories/embeddings-repository";
import {
  closeDatabase,
  openExistingDatabase,
  openReadonlyExistingDatabase,
} from "../../storage/repositories/index-connection";
import { findEntryIdByRef, getAllEntries, getEntryById } from "../../storage/repositories/index-entries-repository";
import { getNeighborsByEntryId } from "../../storage/repositories/index-vec-repository";
import { listProposals, listProposalsReadOnly, type ProposalsContext, proposalContent } from "../proposal/repository";
import {
  hasHotCaptureMode,
  hasSupersededStatus,
  validateProposalFrontmatter,
} from "../proposal/validators/proposal-quality-validators";
import { buildChunkPrompt, computeSafeChunkSize, DEFAULT_CONTEXT_LENGTH_TOKENS } from "./consolidate/chunking";
import { sanitizeMergedContent } from "./consolidate/sanitize";
import { contentHash } from "./content-hash";
import { resolveImproveStrategy, resolveProcessEnabled } from "./improve-strategies";
import { isLedgerBlocked, ledgerKey, loadLedgerSnapshot, recordLedgerAttempt } from "./ledger";
import { callStage, type LlmRunner, mintProposal, type NoticeSink, noticeSet, stageRunner } from "./stage";

export interface MemoryEntry {
  name: string;
  filePath: string;
  description: string;
  tags: string[];
  stashDir: string;
}

/** The one actionable plan operation: queue `ref` as knowledge at `knowledgeRef`. */
export interface ConsolidatePromoteOp {
  op: "promote";
  ref: string;
  knowledgeRef: string;
  reason: string;
  description?: string;
  confidence?: number;
}

interface RawChunkPlan {
  operations?: unknown[];
  warnings?: unknown[];
}

/** A plan op worth acting on. Retired advisory ops (merge/delete/contradict) are dropped, never thrown on. */
export function isValidOp(op: unknown): op is ConsolidatePromoteOp {
  if (typeof op !== "object" || op === null) return false;
  const o = op as Record<string, unknown>;
  return o.op === "promote" && typeof o.ref === "string" && typeof o.knowledgeRef === "string";
}

/** Reconcile the per-chunk plans: one promotion per source memory, the last chunk's wins. */
export function mergePlans(chunks: ConsolidatePromoteOp[][]): ConsolidatePromoteOp[] {
  const byRef = new Map<string, ConsolidatePromoteOp>();
  for (const chunk of chunks) for (const op of chunk) byRef.set(op.ref, op);
  return [...byRef.values()];
}

export function isConsolidationEligibleMemoryName(name: string): boolean {
  return !name.endsWith(".derived");
}

/**
 * A `captureMode: hot` memory (written deliberately with `akm remember`). A
 * missing file is not hot; an unreadable one is treated as hot — the check is
 * a protection and must not fail open.
 */
export function isHotCapturedMemory(filePath: string): boolean {
  if (!fs.existsSync(filePath)) return false;
  try {
    return hasHotCaptureMode(parseFrontmatter(fs.readFileSync(filePath, "utf8")).data as Record<string, unknown>);
  } catch {
    return true;
  }
}

export interface AkmConsolidateOptions {
  /** Active improve profile; absent falls back to the default strategy. */
  improveProfile?: ImproveProfileConfig;
  /** Source to target (defaults to the primary writable stash). */
  target?: string;
  /** Write target resolved by the parent improve invocation. */
  writeTarget?: ResolvedWriteTarget;
  /** Plan with the model but write nothing. */
  dryRun?: boolean;
  stashDir?: string;
  config?: AkmConfig;
  /** Exact runner frozen by the improve plan (an own key, `null` meaning none). */
  llmRunner?: LlmRunner | null;
  onNotices?: NoticeSink;
  /**
   * Consider only memories modified after this ISO time plus their nearest
   * indexed neighbours; falls back to the full pool when the index cannot answer.
   */
  incrementalSince?: string;
  /** Chunk size cap (1–50). */
  maxChunkSize?: number;
  /** Memories processed per pass, after incremental narrowing. */
  limit?: number;
  /** Neighbours per changed memory in incremental mode (default 5). */
  neighborsPerChanged?: number;
  /** Stamped on every proposal (default `consolidate-<startMs>`). */
  sourceRun?: string;
  proposalsCtx?: ProposalsContext;
  /**
   * The caller's budget signal: the chunk loop stops cleanly before the next
   * call once it aborts, and its `remainingBudgetMs` caps the pool up front.
   */
  signal?: AbortSignal;
  /** Fallback p90 seconds per chunk for the up-front budget cap (default 30). */
  p90ChunkSecondsDefault?: number;
  /** Body hashes of live knowledge, when the caller already walked `knowledge/`. */
  existingKnowledgeBodyHashes?: Set<string>;
}

/**
 * Structured-output schema for a plan. Promote-only: merge/delete/contradict
 * were advisory, never executed, and cost thousands of completion tokens.
 */
export const CONSOLIDATE_PLAN_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  required: ["operations"],
  additionalProperties: false,
  properties: {
    operations: {
      type: "array",
      description: "Ordered list of promote operations the planner proposes.",
      items: {
        type: "object",
        required: ["op", "ref", "knowledgeRef", "reason"],
        additionalProperties: false,
        properties: {
          op: { type: "string", enum: ["promote"] },
          ref: { type: "string", minLength: 1 },
          knowledgeRef: { type: "string", minLength: 1 },
          reason: { type: "string", minLength: 1, maxLength: 200 },
          description: { type: "string" },
          confidence: { type: "number", minimum: 0, maximum: 1 },
        },
      },
    },
  },
};

interface ClusterEmbedTelemetry {
  embedMs: number;
  cacheHits: number;
  cacheMisses: number;
}

/**
 * Order memories so similar ones sit together and land in the same chunk:
 * a greedy nearest-neighbour chain over description+tag embeddings (cached in
 * `body_embeddings` under the text's hash). Keeps the original order without
 * an embedding config, for fewer than three memories, or when embedding fails.
 */
async function clusterMemoriesBySimilarity(
  memories: MemoryEntry[],
  config: AkmConfig,
  stateDb?: Database,
  signal?: AbortSignal,
): Promise<{ ordered: MemoryEntry[]; embedTelemetry: ClusterEmbedTelemetry }> {
  const telemetry: ClusterEmbedTelemetry = { embedMs: 0, cacheHits: 0, cacheMisses: 0 };
  if (memories.length < 3 || !config.embedding) return { ordered: memories, embedTelemetry: telemetry };
  const modelId = resolveEmbeddingModelId(config.embedding);
  const texts = memories.map((m) => [m.description, m.tags.join(" ")].filter(Boolean).join(". ") || m.name);
  const hashes = texts.map((t) => contentHash(t));
  let cached = new Map<string, number[]>();
  if (stateDb) {
    try {
      cached = getBodyEmbeddings(stateDb, hashes, modelId);
    } catch {
      cached = new Map();
    }
  }
  const missIndices = hashes.flatMap((hash, i) => (cached.has(hash) ? [] : [i]));
  telemetry.cacheHits = memories.length - missIndices.length;
  telemetry.cacheMisses = missIndices.length;
  const vectors = new Map(cached);
  if (missIndices.length > 0) {
    const embedStart = Date.now();
    let missVecs: (number[] | undefined)[];
    try {
      missVecs = await embedBatch(
        missIndices.map((i) => texts[i] as string),
        config.embedding,
        signal,
      );
    } catch {
      return { ordered: memories, embedTelemetry: telemetry };
    } finally {
      telemetry.embedMs += Date.now() - embedStart;
    }
    const fresh = missIndices.flatMap((idx, pos) => {
      const embedding = missVecs[pos];
      return embedding ? [{ contentHash: hashes[idx] as string, embedding, modelId }] : [];
    });
    for (const entry of fresh) vectors.set(entry.contentHash, entry.embedding);
    // A document the embedder skipped has no vector to cache.
    if (stateDb && missVecs.length === missIndices.length) {
      try {
        upsertBodyEmbeddings(stateDb, fresh);
      } catch {
        // Cache writes are best-effort.
      }
    }
  }
  const embeddings = hashes.map((hash) => vectors.get(hash));
  if (embeddings.some((vec) => !vec)) return { ordered: memories, embedTelemetry: telemetry };
  const used = new Array<boolean>(memories.length).fill(false);
  const ordered: MemoryEntry[] = [memories[0] as MemoryEntry];
  used[0] = true;
  let current = 0;
  for (let step = 1; step < memories.length; step++) {
    let bestIdx = -1;
    let bestSim = -Infinity;
    for (let j = 0; j < memories.length; j++) {
      if (used[j]) continue;
      const sim = cosineSimilarity(embeddings[current] as number[], embeddings[j] as number[]);
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
  return { ordered, embedTelemetry: telemetry };
}

/**
 * Anti-collapse (default on, `antiCollapse.enabled: false` opts out): a small
 * deterministic sample of the pool is spread through the similarity order so
 * consolidation is not purely similarity-driven.
 */
function injectRandomClusterMembers(
  memories: MemoryEntry[],
  profile: ImproveProfileConfig | undefined,
  warnings: string[],
) {
  const config =
    (getImproveProcessConfig("consolidate", profile)?.antiCollapse as
      | { enabled?: boolean; randomClusterFraction?: number }
      | undefined) ?? {};
  if (config.enabled === false || memories.length <= 2) return memories;
  const fraction = config.randomClusterFraction ?? 0.05;
  const randomCount = Math.max(1, Math.floor(memories.length * fraction));
  const sample = [...memories]
    .sort((a, b) => contentHash(a.name).localeCompare(contentHash(b.name)))
    .slice(0, randomCount);
  const sampled = new Set(sample.map((m) => m.name));
  const interval = Math.max(2, Math.floor(memories.length / randomCount));
  const out: MemoryEntry[] = [];
  let next = 0;
  for (let i = 0; i < memories.length; i++) {
    const m = memories[i];
    if (m && !sampled.has(m.name)) out.push(m);
    if (i > 0 && i % interval === 0 && next < sample.length) out.push(sample[next++] as MemoryEntry);
  }
  while (next < sample.length) out.push(sample[next++] as MemoryEntry);
  warnings.push(
    `Anti-collapse: injected ${randomCount} random (non-similarity-driven) cluster member(s) into consolidation pool (fraction=${fraction}).`,
  );
  return out;
}

/** Body hashes of pending consolidate proposals, so the prompt can mark memories already queued. */
function loadPendingConsolidateProposalHashes(stashDir: string): Set<string> {
  const hashes = new Set<string>();
  try {
    for (const p of listProposalsReadOnly(stashDir, { status: "pending" })) {
      if (p.source !== "consolidate") continue;
      try {
        hashes.add(contentHash(proposalContent(p), "body"));
      } catch {
        // A malformed payload cannot dedup anyway.
      }
    }
  } catch {
    // Annotate nothing; the model still proposes.
  }
  return hashes;
}

/**
 * Body hashes of the live knowledge assets, read from disk (the index may lag
 * a just-written asset), so an accepted promotion is not proposed again.
 */
export function loadExistingKnowledgeBodyHashes(targetRoot: string): Set<string> {
  const hashes = new Set<string>();
  const visit = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(entryPath);
      else if (entry.isFile() && entry.name.endsWith(".md")) {
        try {
          hashes.add(contentHash(fs.readFileSync(entryPath, "utf8"), "body"));
        } catch {
          // An unreadable asset is no duplicate evidence.
        }
      }
    }
  };
  visit(path.join(targetRoot, "knowledge"));
  return hashes;
}

/** A provenance ref in its canonical display spelling. */
function canonicalXref(ref: string): string {
  try {
    const p = parseRefInput(ref);
    return displayRef({ type: p.type, name: p.name, bundleId: p.origin });
  } catch {
    return ref;
  }
}

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
  if (!opts.target && opts.stashDir) {
    const root = path.resolve(opts.stashDir);
    return {
      source: { kind: "filesystem", name: "stash", path: root, adapterId: detectAdapterId(root) },
      config: { type: "filesystem", name: "stash", path: root, writable: true },
    };
  }
  const target = resolveWriteTarget(config, opts.target);
  return { ...target, source: { ...target.source, path: path.resolve(target.source.path) } };
}

export async function akmConsolidate(opts: AkmConsolidateOptions = {}): Promise<ConsolidateResult> {
  const startMs = Date.now();
  const config = opts.config ?? loadConfig();
  const writeTarget = resolveConsolidationWriteTarget(opts, config);
  const profile = opts.improveProfile ?? resolveImproveStrategy(undefined, config).config;
  const stashDir = writeTarget.source.path;
  const notices = noticeSet(opts.onNotices);
  const enabled = resolveProcessEnabled("consolidate", profile);
  const runner = enabled ? stageRunner(opts, config, profile, "consolidate", notices.add) : undefined;
  opts = {
    ...opts,
    target: writeTarget.source.name,
    writeTarget,
    improveProfile: profile,
    onNotices: notices.add,
    sourceRun: opts.sourceRun ?? `consolidate-${startMs}`,
    // Every later reader sees this one runner snapshot.
    llmRunner: runner ?? null,
  };
  if (!enabled) {
    const target = opts.target ?? stashDir;
    return {
      ...makeConsolidateResult({ dryRun: opts.dryRun ?? false, target, durationMs: Date.now() - startMs }),
      ...notices.fields(),
    };
  }
  // One state.db handle for the embedding cache; unavailable means no cache.
  let stateDb: Database | undefined;
  if (config.embedding) {
    try {
      stateDb = openStateDatabase();
    } catch {
      stateDb = undefined;
    }
  }
  try {
    return { ...(await consolidate(opts, config, stashDir, startMs, stateDb)), ...notices.fields() };
  } finally {
    stateDb?.close();
  }
}

type SkipEntry = { ref: string; skips: Array<{ op: ConsolidateOpKind | "unknown"; reason: string }> };

/** The run's live counters, shared by the chunk loop and the promotion pass. */
interface ConsolidateAccounting {
  judgedNoAction: number;
  failedChunkMemories: number;
  totalChunksFailed: number;
  skipReasons: SkipEntry[];
  skipReasonByRef: Map<string, SkipEntry>;
  /** Refs counted in judgedNoAction, so a later skip moves (never double-counts) them. */
  judgedNoActionRefs: Set<string>;
  /** Every memory in a chunk the model judged (or an all-hot chunk judged without it). */
  judgedRefs: Set<string>;
}

function pushSkipReason(acc: ConsolidateAccounting, op: ConsolidateOpKind | "unknown", ref: string, reason: string) {
  if (acc.judgedNoActionRefs.delete(ref)) acc.judgedNoAction--;
  const existing = acc.skipReasonByRef.get(ref);
  if (existing) {
    // One entry per ref keeps the invariant; the extra reason is kept for observability.
    existing.skips.push({ op, reason });
    return;
  }
  const entry: SkipEntry = { ref, skips: [{ op, reason }] };
  acc.skipReasonByRef.set(ref, entry);
  acc.skipReasons.push(entry);
}

export interface ConsolidationPoolSnapshot {
  /** Eligible on-disk memories before incremental narrowing and the limit. */
  poolSize: number;
  /** Pool after incremental narrowing and the limit. */
  candidatePoolSize: number;
  /** Pool after incremental narrowing, before the limit. */
  dedupPoolSize: number;
  memories: MemoryEntry[];
  /** Memories whose body already exists verbatim in `knowledge/`. */
  prefilteredAlreadyPromoted: number;
  /** Memories the ledger skipped: judged within their revisit window and unchanged since. */
  judgedUnchanged: number;
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
    const targetIndex = sources.findIndex((source) => path.resolve(source.path) === targetRoot);
    const target = deriveInstallations(sources)[targetIndex];
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

const mtimeMsOf = (memory: MemoryEntry): number => {
  try {
    return fs.statSync(memory.filePath).mtimeMs;
  } catch {
    return 0;
  }
};

/**
 * The exact pool the live pass consumes, with no embedding, model call or
 * write: on-disk eligible memories, minus those the ledger holds, narrowed
 * incrementally, minus bodies already in `knowledge/`, capped to `limit`
 * (oldest-modified first). Shared by preview and execution.
 */
export function inspectConsolidationPool(
  opts: AkmConsolidateOptions,
  stashDir: string,
  warnings: string[],
  existingKnowledgeBodyHashes: Set<string> = new Set(),
  access?: { readOnly?: boolean },
): ConsolidationPoolSnapshot {
  const readOnly = access?.readOnly === true;
  let memories = loadMemoriesForSource(resolveConsolidationSourceOwner(opts, stashDir), warnings, readOnly);
  const staleCount = memories.filter((memory) => !fs.existsSync(memory.filePath)).length;
  if (staleCount > 0) {
    warnings.push(
      `Pre-flight: filtered ${staleCount} stale DB entr${staleCount === 1 ? "y" : "ies"} (file absent on disk) from memory pool before chunking.`,
    );
  }
  memories = memories.filter((memory) => fs.existsSync(memory.filePath));
  const poolSize = memories.length;
  // A memory judged within its revisit window comes back once it is edited.
  const ledger = loadLedgerSnapshot({ proposalsCtx: opts.proposalsCtx, readOnly }, stashDir, ["consolidate"]);
  if (ledger.size > 0) {
    const nowIso = new Date().toISOString();
    memories = memories.filter((memory) => {
      const row = ledger.get(ledgerKey("consolidate", conceptIdFromTypeName("memory", memory.name)));
      let changedAt: string | undefined;
      try {
        changedAt = fs.statSync(memory.filePath).mtime.toISOString();
      } catch {
        changedAt = undefined;
      }
      return !row || !isLedgerBlocked(row, nowIso, changedAt);
    });
  }
  const judgedUnchanged = poolSize - memories.length;
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
  // Before the limit, so the cap picks from memories the run can act on.
  let prefilteredAlreadyPromoted = 0;
  if (existingKnowledgeBodyHashes.size > 0) {
    memories = memories.filter((memory) => {
      let raw: string;
      try {
        raw = fs.readFileSync(memory.filePath, "utf8");
      } catch {
        return true;
      }
      const duplicate = existingKnowledgeBodyHashes.has(contentHash(raw, "body"));
      if (duplicate) prefilteredAlreadyPromoted++;
      return !duplicate;
    });
  }
  if (opts.limit !== undefined && memories.length > opts.limit) {
    const mtimes = new Map(memories.map((memory) => [memory.filePath, mtimeMsOf(memory)]));
    memories = [...memories].sort((a, b) => (mtimes.get(a.filePath) ?? 0) - (mtimes.get(b.filePath) ?? 0));
    warnings.push(
      `Consolidation: pool capped at ${opts.limit} of ${memories.length} memories (limit option, oldest-modified first).`,
    );
    memories = memories.slice(0, opts.limit);
  }
  return {
    poolSize,
    candidatePoolSize: memories.length,
    dedupPoolSize,
    memories,
    prefilteredAlreadyPromoted,
    judgedUnchanged,
  };
}

const ABORT_MIN_CHUNKS = 4;
const ABORT_FAILURE_RATE = 0.5;

/**
 * The chunk loop: stop cleanly on the budget signal, abort once ≥50% of at
 * least 4 chunks failed (the model is likely down), skip an all-hot chunk
 * without a call (the only thing the model could do with it is refused), and
 * count every memory into exactly one accounting bucket.
 */
async function judgeConsolidationChunks(args: {
  chunks: MemoryEntry[][];
  opts: AkmConsolidateOptions;
  config: AkmConfig;
  sourceName: string;
  bodyTruncation: number;
  pendingProposalBodyHashes: Set<string>;
  warnings: string[];
  acc: ConsolidateAccounting;
}): Promise<ConsolidatePromoteOp[][]> {
  const { chunks, opts, config, warnings, acc } = args;
  const llmRunner = opts.llmRunner ?? undefined;
  const memRef = (m: MemoryEntry) => conceptIdFromTypeName("memory", m.name);
  const failChunk = (message: string, chunk: MemoryEntry[]) => {
    warn(message);
    warnings.push(message);
    acc.totalChunksFailed++;
    acc.failedChunkMemories += chunk.length;
  };
  const skipRemaining = (from: number) => {
    for (let i = from; i < chunks.length; i++) acc.failedChunkMemories += (chunks[i] as MemoryEntry[]).length;
  };
  const planned: ConsolidatePromoteOp[][] = [];
  let processed = 0;
  for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx++) {
    const label = `chunk ${chunkIdx + 1}`;
    if (opts.signal?.aborted) {
      const msg = `[consolidate] budget signal aborted before chunk ${chunkIdx + 1}/${chunks.length}; ${chunks.length - chunkIdx} chunk(s) not processed (partial_timeout — work done so far committed).`;
      warn(msg);
      warnings.push(msg);
      skipRemaining(chunkIdx);
      break;
    }
    if (processed >= ABORT_MIN_CHUNKS) {
      const failureRate = acc.totalChunksFailed / processed;
      if (failureRate >= ABORT_FAILURE_RATE) {
        const msg = `Consolidation aborted — failure rate ${(failureRate * 100).toFixed(0)}% over ${processed} chunks (>= ${ABORT_FAILURE_RATE * 100}% threshold). LLM may be unavailable. ${chunks.length - chunkIdx} chunk(s) skipped.`;
        warn(msg);
        warnings.push(msg);
        skipRemaining(chunkIdx);
        break;
      }
    }
    const chunk = chunks[chunkIdx] as MemoryEntry[];
    if (chunk.length > 0 && chunk.every((m) => isHotCapturedMemory(m.filePath))) {
      for (const m of chunk) {
        acc.judgedNoActionRefs.add(memRef(m));
        acc.judgedRefs.add(memRef(m));
      }
      acc.judgedNoAction += chunk.length;
      warn(
        `[consolidate] chunk ${chunkIdx + 1}/${chunks.length}: all ${chunk.length} memories are captureMode: hot — skipping LLM (judged no-action).`,
      );
      continue;
    }
    warn(`[consolidate] chunk ${chunkIdx + 1}/${chunks.length} (${chunk.length} memories) …`);
    processed++;
    if (!llmRunner) {
      failChunk("No LLM configured for consolidation", chunk);
      continue;
    }
    // The transport already retries once; a failed chunk is not retried here.
    const outcome = await callStage({
      feature: "memory_consolidation",
      runner: llmRunner,
      system: consolidateSystemPrompt,
      prompt: buildChunkPrompt(
        args.sourceName,
        chunk,
        chunkIdx,
        chunks.length,
        args.bodyTruncation,
        args.pendingProposalBodyHashes,
      ),
      gate: { config, enabled: true },
      request: {
        responseSchema: CONSOLIDATE_PLAN_JSON_SCHEMA,
        enableThinking: false,
        timeoutMs: llmRunner.timeoutMs,
        signal: opts.signal,
      },
      ...(opts.onNotices ? { onNotices: opts.onNotices } : {}),
    });
    if (!outcome.ok) {
      failChunk(outcome.reason === "error" && outcome.error ? outcome.error : `${label} failed`, chunk);
      continue;
    }
    warnVerbose(`[akm:consolidate] ${label} raw response (first 500 chars): ${outcome.raw.slice(0, 500)}`);
    const parsed = parseEmbeddedJsonResponse<RawChunkPlan>(outcome.raw);
    if (!parsed || !Array.isArray(parsed.operations)) {
      const hint =
        outcome.raw.trim() === "" ? " (empty response — if using a thinking model, disable thinking mode)" : "";
      const msg = `Chunk ${chunkIdx + 1}: invalid plan from AI — skipping.${hint}`;
      warn(msg);
      warnings.push(msg);
      acc.totalChunksFailed++;
      acc.failedChunkMemories += chunk.length;
      continue;
    }
    const ops: ConsolidatePromoteOp[] = [];
    for (const op of parsed.operations) {
      if (isValidOp(op)) ops.push(op);
      else warnings.push(`Chunk ${chunkIdx + 1}: skipping invalid operation: ${JSON.stringify(op)}`);
    }
    for (const w of Array.isArray(parsed.warnings) ? parsed.warnings : []) if (typeof w === "string") warnings.push(w);
    // Memories the model saw but proposed nothing for.
    const targeted = new Set(ops.map((op) => op.ref));
    for (const m of chunk) {
      acc.judgedRefs.add(memRef(m));
      if (targeted.has(memRef(m))) continue;
      acc.judgedNoAction++;
      acc.judgedNoActionRefs.add(memRef(m));
    }
    planned.push(ops);
  }
  return planned;
}

/**
 * The model's plan for the narrowed pool: chunk size from the context window,
 * an up-front cap when the remaining budget cannot cover every chunk (oldest
 * first, the rest deferred), similarity clustering, anti-collapse, then the
 * chunk loop.
 */
async function planConsolidation(
  opts: AkmConsolidateOptions,
  config: AkmConfig,
  stashDir: string,
  memories: MemoryEntry[],
  warnings: string[],
  stateDb: Database | undefined,
  acc: ConsolidateAccounting,
) {
  const llmRunner = opts.llmRunner ?? undefined;
  // 500 body chars per memory keep the judgement useful; chunk size varies instead.
  const bodyTruncation = 500;
  const chunkSize = computeSafeChunkSize(
    llmRunner?.connection.contextLength ?? DEFAULT_CONTEXT_LENGTH_TOKENS,
    bodyTruncation,
    opts.maxChunkSize,
  );
  const sourceName = opts.target ?? stashDir;
  let budgeted = memories;
  const budgetMs = (opts.signal as (AbortSignal & { remainingBudgetMs?: number }) | undefined)?.remainingBudgetMs;
  if (opts.signal && budgetMs !== undefined) {
    const safeChunks = Math.max(
      0,
      Math.floor((Math.max(0, budgetMs) / 1000 / (opts.p90ChunkSecondsDefault ?? 30)) * 0.6),
    );
    if (safeChunks * chunkSize < memories.length) {
      budgeted = [...memories]
        .sort((a, b) => mtimeMsOf(a) - mtimeMsOf(b) || a.name.localeCompare(b.name))
        .slice(0, safeChunks * chunkSize);
      const msg = `[consolidate] cold-start budget: reducing pool from ${memories.length} to ${budgeted.length} memories (${safeChunks} safe chunks; remainder deferred).`;
      warn(msg);
      warnings.push(msg);
    }
  }
  const slice = (list: MemoryEntry[]) =>
    Array.from({ length: Math.ceil(list.length / chunkSize) }, (_, i) =>
      list.slice(i * chunkSize, (i + 1) * chunkSize),
    );
  const willDispatch = slice(budgeted).some(
    (chunk) => chunk.length > 0 && !chunk.every((memory) => isHotCapturedMemory(memory.filePath)),
  );
  if (llmRunner && willDispatch) assertRunnerCredentials(llmRunner);
  const { ordered, embedTelemetry } = await clusterMemoriesBySimilarity(budgeted, config, stateDb, opts.signal);
  const chunks = slice(injectRandomClusterMembers(ordered, opts.improveProfile, warnings));
  const pendingProposalBodyHashes = loadPendingConsolidateProposalHashes(stashDir);
  warn(
    `[consolidate] ${budgeted.length} memories / ${chunks.length} chunk(s) / chunk_size=${chunkSize}` +
      ` / pending-proposal hashes: ${pendingProposalBodyHashes.size}`,
  );
  const planned = await judgeConsolidationChunks({
    chunks,
    opts,
    config,
    sourceName,
    bodyTruncation,
    pendingProposalBodyHashes,
    warnings,
    acc,
  });
  return {
    allOps: mergePlans(planned),
    totalChunks: chunks.length,
    llmPoolSize: budgeted.length,
    deferredMemories: memories.length - budgeted.length,
    embedTelemetry,
    sourceName,
  };
}

async function consolidate(
  opts: AkmConsolidateOptions,
  config: AkmConfig,
  stashDir: string,
  startMs: number,
  stateDb: Database | undefined,
): Promise<ConsolidateResult> {
  const warnings: string[] = [];
  const existingKnowledgeBodyHashes = opts.existingKnowledgeBodyHashes ?? loadExistingKnowledgeBodyHashes(stashDir);
  const pool = inspectConsolidationPool(opts, stashDir, warnings, existingKnowledgeBodyHashes);
  const { memories, prefilteredAlreadyPromoted } = pool;
  const plural = (n: number) => `memor${n === 1 ? "y" : "ies"}`;
  if (pool.judgedUnchanged > 0) {
    warnings.push(
      `Consolidation: skipped ${pool.judgedUnchanged} ${plural(pool.judgedUnchanged)} judged within the revisit window and unchanged since.`,
    );
  }
  if (prefilteredAlreadyPromoted > 0) {
    warnings.push(
      `Consolidation: pre-filtered ${prefilteredAlreadyPromoted} ${plural(prefilteredAlreadyPromoted)} whose body already exists verbatim in knowledge/ before chunking.`,
    );
  }
  const target = opts.target ?? stashDir;
  if (memories.length === 0) {
    return makeConsolidateResult({
      dryRun: opts.dryRun ?? false,
      target,
      warnings,
      durationMs: Date.now() - startMs,
      prefilteredAlreadyPromoted,
    });
  }
  const acc: ConsolidateAccounting = {
    judgedNoAction: 0,
    failedChunkMemories: 0,
    totalChunksFailed: 0,
    skipReasons: [],
    skipReasonByRef: new Map(),
    judgedNoActionRefs: new Set(),
    judgedRefs: new Set(),
  };
  const plan = await planConsolidation(opts, config, stashDir, memories, warnings, stateDb, acc);
  // Evaluated at return time: a promotion skip can move a ref out of judgedNoAction.
  const summary = () => ({
    target: plan.sourceName,
    processed: plan.llmPoolSize,
    failedChunks: acc.totalChunksFailed,
    totalChunks: plan.totalChunks,
    judgedNoAction: acc.judgedNoAction,
    skipReasons: acc.skipReasons,
    mergedSecondaries: 0,
    failedChunkMemories: acc.failedChunkMemories,
    deferredMemories: plan.deferredMemories,
    planned: plan.allOps,
    warnings,
    prefilteredAlreadyPromoted,
    durationMs: Date.now() - startMs,
  });
  if (opts.dryRun) return makeConsolidateResult({ ...summary(), dryRun: true, previewOnly: true });
  warn(`[consolidate] plan: ${plan.allOps.length} operation(s)`);
  const ctx: PromoteContext = {
    config,
    stashDir,
    sourceRun: opts.sourceRun ?? `consolidate-${startMs}`,
    proposalsCtx: opts.proposalsCtx,
    target: opts.writeTarget as ResolvedWriteTarget,
    memoryByRef: new Map(memories.map((memory) => [conceptIdFromTypeName("memory", memory.name), memory])),
    promoted: [],
    promotedSourceRefs: new Set<string>(),
    existingKnowledgeBodyHashes,
    promotionFailures: { count: 0 },
    warnings,
    pushSkipReason: (op, ref, reason) => pushSkipReason(acc, op, ref, reason),
  };
  for (const op of plan.allOps) await emitPromotionProposal(op, ctx);
  // Every other judged memory waits out its revisit window (or its next edit);
  // a promotion that failed to persist is retried next run.
  recordLedgerAttempt(
    { proposalsCtx: opts.proposalsCtx },
    [...acc.judgedRefs]
      .filter(
        (ref) =>
          !ctx.promotedSourceRefs.has(ref) &&
          !acc.skipReasonByRef.get(ref)?.skips.some((skip) => skip.reason === "promote_create_failed"),
      )
      .map((ref) => ({ stashDir, ref, source: "consolidate", outcome: "judged_no_action" as const })),
  );
  return makeConsolidateResult({
    ...summary(),
    promoted: ctx.promoted,
    failedPromotions: ctx.promotionFailures.count,
    perfTelemetry: {
      dedupPoolSize: pool.dedupPoolSize,
      llmPoolSize: plan.llmPoolSize,
      embedMs: plan.embedTelemetry.embedMs,
      embedCacheHits: plan.embedTelemetry.cacheHits,
      embedCacheMisses: plan.embedTelemetry.cacheMisses,
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
  pushSkipReason: (op: ConsolidateOpKind | "unknown", ref: string, reason: string) => void;
}

/** The conceptId a ref maps to, or undefined for an invalid ref. */
function conceptIdForRef(ref: string): string | undefined {
  try {
    const p = parseRefInput(ref);
    return conceptIdFromTypeName(p.type, p.name);
  } catch {
    return undefined;
  }
}

/** A slug with dates, counters and word order folded away, for spotting variants. */
function normalizeSlugForDedup(ref: string): string {
  const monthRe = /(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i;
  return parseRefInput(ref)
    .name.toLowerCase()
    .split("-")
    .filter((tok) => tok.length > 0 && !/^\d+$/.test(tok) && !monthRe.test(tok))
    .sort()
    .join("-");
}

const PROMOTE_BODY_MIN_CHARS = 100;

/**
 * Queue one promotion as a proposal. Refused (with a skip reason) when the
 * memory is unknown, already promoted this run, already pending or present
 * as knowledge (by concept, body hash or slug variant), unreadable, fails
 * sanitization, is superseded, has a body too small to be knowledge, or has
 * no valid description.
 * @internal Exported for promotion-path integration tests.
 */
export async function emitPromotionProposal(op: ConsolidatePromoteOp, ctx: PromoteContext): Promise<void> {
  const { stashDir, target, warnings, pushSkipReason } = ctx;
  const entry = ctx.memoryByRef.get(op.ref);
  if (!entry) {
    // A phantom ref was never counted as processed, so it gets no skip reason.
    warnings.push(`Promote: ${op.ref} not found in loaded memories — skipping.`);
    return;
  }
  const skip = (reason: string, message: string): void => {
    warnings.push(message);
    pushSkipReason("promote", op.ref, reason);
  };
  if (ctx.promotedSourceRefs.has(op.ref)) {
    return skip("promote_already_promoted_this_run", `Skipping promote: ${op.ref} already promoted in this run`);
  }
  const slug = (
    op.knowledgeRef.split("/").filter(Boolean).at(-1) ??
    entry.name.split("/").filter(Boolean).at(-1) ??
    "promoted-memory"
  )
    .replace(/[^a-z0-9-]/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
  const knowledgeRef = conceptIdFromTypeName("knowledge", slug);
  const parsedKnowledgeRef = parseRefInput(knowledgeRef);
  if (knowledgeRef !== op.knowledgeRef)
    warnings.push(`Normalized generated ref "${op.knowledgeRef}" → "${knowledgeRef}"`);
  const pending = listProposals(stashDir, { status: "pending" });
  const wantConcept = conceptIdForRef(knowledgeRef);
  if (wantConcept !== undefined && pending.some((p) => conceptIdForRef(p.ref) === wantConcept)) {
    return skip(
      "promote_pending_proposal_exists",
      `Skipping promote: pending proposal already exists for ${knowledgeRef}`,
    );
  }
  if (fs.existsSync(path.join(target.source.path, "knowledge", `${parsedKnowledgeRef.name}.md`))) {
    return skip("promote_already_exists", `Skipping promote: ${knowledgeRef} already exists in source`);
  }
  let memoryContent: string;
  try {
    memoryContent = fs.readFileSync(entry.filePath, "utf8");
  } catch (e) {
    return skip("promote_read_failed", `Promote: could not read ${op.ref}: ${String(e)}`);
  }
  const sanitized = sanitizeMergedContent(memoryContent);
  if (!sanitized.ok) {
    return skip(
      "promote_sanitization_failed",
      `Promote: rejected ${op.ref} — source memory failed sanitization (${sanitized.reason}).`,
    );
  }
  memoryContent = sanitized.result.content;
  if (hasSupersededStatus(sanitized.result.frontmatter as Record<string, unknown> | undefined)) {
    return skip(
      "promote_superseded",
      `Promote: refused for ${op.ref} → ${knowledgeRef} — source memory has status:superseded; superseded memories are not promotable knowledge.`,
    );
  }
  const parsedMemory = parseFrontmatter(memoryContent);
  const sourceBody = parsedMemory.content.trim();
  if (sourceBody.length < PROMOTE_BODY_MIN_CHARS) {
    return skip(
      "promote_source_too_small",
      `Promote: rejected ${op.ref} → ${knowledgeRef} — source memory body is too small (${sourceBody.length} chars; need ≥${PROMOTE_BODY_MIN_CHARS}) to make useful knowledge.`,
    );
  }
  // The body is the load-bearing content: twins that differ only in
  // bookkeeping frontmatter, or an earlier run's differently-slugged proposal,
  // are the same promotion.
  const bodyHash = contentHash(memoryContent, "body");
  if (ctx.existingKnowledgeBodyHashes.has(bodyHash)) {
    return skip(
      "dedup_existing_knowledge",
      `Skipping promote: identical body already exists in knowledge; skipping duplicate for ${op.ref} → ${knowledgeRef}`,
    );
  }
  const pendingConsolidate = listProposals(stashDir, { status: "pending" }).filter((p) => p.source === "consolidate");
  const sameBody = pendingConsolidate.find((p) => contentHash(proposalContent(p), "body") === bodyHash);
  if (sameBody) {
    return skip(
      "dedup_pending_proposal",
      `Skipping promote: identical body already pending as proposal ${sameBody.id} (ref: ${sameBody.ref}); skipping duplicate for ${op.ref} → ${knowledgeRef}`,
    );
  }
  try {
    const description =
      (typeof op.description === "string" && op.description.trim()
        ? op.description.trim()
        : (parsedMemory.data?.description as string | undefined)?.trim()) ?? "";
    const fmCheck = validateProposalFrontmatter({ description });
    if (!fmCheck.ok) {
      return skip("promote_invalid_frontmatter", `Promote: rejected ${op.ref} → ${knowledgeRef} — ${fmCheck.reason}.`);
    }
    // The description goes into the body frontmatter, which accept-time validation reads.
    const xrefs = Array.isArray(parsedMemory.data?.xrefs) ? parsedMemory.data.xrefs.map(String) : [];
    const mergedFrontmatter = {
      ...(parsedMemory.data ?? {}),
      description,
      xrefs: [...new Set([...xrefs, op.ref].map(canonicalXref))],
    };
    const normalized = normalizeSlugForDedup(knowledgeRef);
    const variant = pendingConsolidate.find((p) => normalizeSlugForDedup(p.ref) === normalized);
    if (variant) {
      return skip(
        "promote_dedup_window",
        `Promote: skipped ${op.ref} → ${knowledgeRef} — slug-variant of pending proposal ${variant.id} (${variant.ref}).`,
      );
    }
    const proposal = mintProposal(stashDir, ctx.proposalsCtx, {
      ref: knowledgeRef,
      target: { source: target.source.name, root: target.source.path },
      source: "consolidate",
      sourceRun: ctx.sourceRun,
      payload: {
        content: assembleAssetFromString(serializeFrontmatter(mergedFrontmatter), parsedMemory.content),
        frontmatter: { description, xrefs: [canonicalXref(op.ref)] },
      },
      ...(typeof op.confidence === "number" ? { confidence: op.confidence } : {}),
      // The ledger keys the attempt by the source memory.
      attemptedRefs: [op.ref],
    });
    ctx.promoted.push(proposal.id);
    ctx.promotedSourceRefs.add(op.ref);
  } catch (e) {
    ctx.promotionFailures.count++;
    skip("promote_create_failed", `Promote: createProposal failed for ${op.ref}: ${String(e)}`);
  }
}

/**
 * {changed} ∪ {top-k indexed neighbours of each changed memory}, within the
 * pool: nothing changed → []; everything changed or no index → the full pool.
 */
export function narrowToIncrementalCandidates(
  memories: MemoryEntry[],
  since: string,
  warnings: string[],
  neighborsPerChanged = 5,
  readOnly = false,
): MemoryEntry[] {
  // Lenient: a garbage `since` passes through and selects nothing.
  const sinceIso = parseSinceToIsoLenient(since);
  const changed = memories.filter((m) => {
    try {
      return fs.statSync(m.filePath).mtime.toISOString() > sinceIso;
    } catch {
      return true; // never silently drop a memory we cannot stat
    }
  });
  if (changed.length === 0) return [];
  if (changed.length === memories.length) return memories;
  const inPool = new Set(memories.map((m) => m.name));
  const keep = new Set(changed.map((m) => m.name));
  let db: ReturnType<typeof openExistingDatabase> | undefined;
  try {
    db = readOnly ? openReadonlyExistingDatabase(undefined, { isolatedSnapshot: true }) : openExistingDatabase();
    if (!db) return memories;
    for (const m of changed) {
      const id = findEntryIdByRef(db, conceptIdFromTypeName("memory", m.name));
      if (id === undefined) continue;
      for (const hit of getNeighborsByEntryId(db, id, neighborsPerChanged + 1)) {
        if (hit.id === id) continue;
        const name = getEntryById(db, hit.id)?.entry.name;
        if (name && inPool.has(name)) keep.add(name);
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

/** The target bundle's eligible memories from the index, else walked from disk. */
function loadMemoriesForSource(
  source: ConsolidationSourceOwner | undefined,
  warnings: string[],
  readOnly: boolean,
): MemoryEntry[] {
  let memories: MemoryEntry[] = [];
  let db: ReturnType<typeof openExistingDatabase> | undefined;
  try {
    db = readOnly ? openReadonlyExistingDatabase(undefined, { isolatedSnapshot: true }) : openExistingDatabase();
    if (!db) throw new Error("index unavailable");
    memories = getAllEntries(db, "memory")
      .filter((e) => source !== undefined && e.bundleId === source.bundleId)
      .filter((e) => isConsolidationEligibleMemoryName(e.entry.name) && fs.existsSync(e.filePath))
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
  if (memories.length > 0 || !source) return memories;
  const memoriesDir = path.join(source.sourceRoot, "memories");
  if (fs.existsSync(memoriesDir)) {
    const pending = [memoriesDir];
    while (pending.length > 0) {
      const current = pending.pop() as string;
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const filePath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          if (!source.excludedSourceRoots.has(path.resolve(filePath))) pending.push(filePath);
          continue;
        }
        if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
        const name = path.relative(memoriesDir, filePath).replace(/\.md$/, "").split(path.sep).join("/");
        if (isConsolidationEligibleMemoryName(name)) {
          memories.push({ name, filePath, description: "", tags: [], stashDir: source.sourceRoot });
        }
      }
    }
  }
  if (memories.length > 0) warnings.push("DB not found or empty — loaded memories directly from filesystem.");
  return memories;
}
