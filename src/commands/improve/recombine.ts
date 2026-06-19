// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #609 — recombine / synthesize pass.
 *
 * A whole-corpus synthesis stage that runs AFTER consolidation and is OPT-IN
 * (default disabled via `IMPROVE_PROCESS_DEFAULTS.recombine`). It clusters
 * memories by RELATEDNESS (shared tags / graph entities — NEVER embedding
 * similarity), issues ONE bounded LLM call per cluster to induce a single
 * cross-episodic generalization, and emits the result as a NORMAL pending
 * proposal with frontmatter `type: hypothesis` through the existing proposal
 * queue + quality gate.
 *
 * Two-pass contract: the first pass ONLY ever emits `type: hypothesis`
 * proposals — never a `type: lesson`. Promotion to a lesson happens on a later
 * confirmation run once the same generalization has been re-induced
 * `confirmThreshold` times. (v1 enforces the hypothesis-only emission
 * invariant; the confirmation-count promotion is deferred — see the inline
 * NOTE at the proposal-emission site in `akmRecombine`.)
 *
 * A justified null (the LLM determines no defensible generalization exists) is
 * an acceptable outcome: it produces no proposal and records a
 * `recombine_invoked` event with `outcome: 'null_returned'`.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import recombineSystemPrompt from "../../assets/prompts/recombine-system.md" with { type: "text" };
import { parseFrontmatter } from "../../core/asset/frontmatter";
import { resolveStashDir } from "../../core/common";
import type { AkmConfig } from "../../core/config/config";
import { getDefaultLlmConfig, loadConfig } from "../../core/config/config";
import { appendEvent, type EventsContext } from "../../core/events";
import type { EligibilitySource, RecombineResult } from "../../core/improve-types";
import { parseEmbeddedJsonResponse } from "../../core/parse";
import { warn } from "../../core/warn";
import {
  closeDatabase,
  type DbIndexedEntry,
  getAllEntries,
  getEntitiesByEntryIds,
  openExistingDatabase,
} from "../../indexer/db/db";
import { resolveImproveProcessRunnerFromProfile, runnerIsLlm } from "../../integrations/agent/runner";
import { type ChatMessage, chatCompletion } from "../../llm/client";
import { validateProposalFrontmatter } from "../proposal/validators/proposal-quality-validators";
import { createProposal, isProposalSkipped } from "../proposal/validators/proposals";
import { isConsolidationEligibleMemoryName } from "./consolidate";

export type { RecombineResult } from "../../core/improve-types";

const RECOMBINE_SYSTEM_PROMPT = recombineSystemPrompt;

const DEFAULT_MIN_CLUSTER_SIZE = 3;
const DEFAULT_MAX_CLUSTERS_PER_RUN = 5;
const DEFAULT_RELATEDNESS_SOURCE: "tags" | "graph" | "both" = "tags";

/**
 * Single bounded LLM seam. Receives the assembled cluster prompt and returns
 * the raw model output (JSON object or explicit null), or `null` when no call
 * could be made. Injected by tests; production resolves the runner internally.
 */
export type RecombineLlmFn = (clusterPrompt: string) => Promise<string | null>;

export interface AkmRecombineOptions {
  stashDir?: string;
  config: AkmConfig;
  /** PROV-DM run token stamped on every emitted proposal. */
  sourceRun?: string;
  /** Caller budget signal; an aborted signal short-circuits before any LLM call. */
  signal?: AbortSignal;
  /** Auto-accept threshold forwarded to the proposal gate (reserved; v1 queues pending). */
  autoAccept?: number;
  /** Attribution tag persisted on emitted proposals. Defaults to `"recombine"`. */
  eligibilitySource?: EligibilitySource;
  /** Test seam — state.db path override for proposal/event writes. */
  ctx?: EventsContext;
  /** Injected LLM seam (no real network in tests). */
  recombineLlmFn?: RecombineLlmFn;
  minClusterSize?: number;
  maxClustersPerRun?: number;
  relatednessSource?: "tags" | "graph" | "both";
}

/** A relatedness cluster: a shared signal (tag / entity) + its member entries. */
interface MemoryCluster {
  /** The shared relatedness key (tag value or entity_norm). */
  signature: string;
  /** Member memory entries (size >= minClusterSize). */
  members: DbIndexedEntry[];
}

/** The parsed generalization payload produced by the recombine LLM. */
interface Generalization {
  description: string;
  when_to_use?: string;
  body: string;
}

// ── Clustering by relatedness (NOT similarity) ────────────────────────────────

/**
 * Build relatedness clusters from the memory pool. Clustering is driven purely
 * by shared tags / graph entities — it MUST NOT use embedding similarity, so
 * textually near-identical memories that share no relatedness signal never
 * cluster together.
 *
 * For `relatednessSource`:
 *   - `"tags"`  — group by each frontmatter tag.
 *   - `"graph"` — group by shared `graph_file_entities.entity_norm`; falls back
 *                 to tags when the graph table is empty (fail-open).
 *   - `"both"`  — union of the tag and entity grouping keys.
 *
 * A cluster is a signal whose member set is >= `minClusterSize`. Overlapping
 * clusters are de-duplicated by member-set identity, and the result is capped
 * to `maxClustersPerRun` by member-count descending.
 */
export function buildRelatednessClusters(
  entries: DbIndexedEntry[],
  opts: {
    minClusterSize: number;
    maxClustersPerRun: number;
    relatednessSource: "tags" | "graph" | "both";
    entityByEntryId?: Map<number, string[]>;
  },
): MemoryCluster[] {
  // Only consolidation-eligible memories participate (exclude `.derived`).
  const memories = entries.filter((e) => e.entry.type === "memory" && isConsolidationEligibleMemoryName(e.entry.name));

  // signal -> member entries
  const groups = new Map<string, DbIndexedEntry[]>();
  const add = (signal: string, entry: DbIndexedEntry): void => {
    const key = signal.trim();
    if (!key) return;
    const list = groups.get(key);
    if (list) {
      if (!list.includes(entry)) list.push(entry);
    } else {
      groups.set(key, [entry]);
    }
  };

  const useTags = opts.relatednessSource === "tags" || opts.relatednessSource === "both";
  // Graph relatedness falls open to tags when no entities are available.
  const hasEntities = !!opts.entityByEntryId && opts.entityByEntryId.size > 0;
  const useGraph = (opts.relatednessSource === "graph" || opts.relatednessSource === "both") && hasEntities;
  const tagsFallback = !useTags && opts.relatednessSource === "graph" && !hasEntities;

  for (const entry of memories) {
    if (useTags || tagsFallback) {
      for (const tag of entry.entry.tags ?? []) add(`tag:${tag}`, entry);
    }
    if (useGraph && opts.entityByEntryId) {
      for (const ent of opts.entityByEntryId.get(entry.id) ?? []) add(`entity:${ent}`, entry);
    }
  }

  // Keep only groups at or above the minimum cluster size.
  let clusters: MemoryCluster[] = [];
  for (const [signature, members] of groups) {
    if (members.length >= opts.minClusterSize) clusters.push({ signature, members });
  }

  // De-duplicate clusters that share the exact same member set (e.g. a tag and
  // an entity that co-occur on the same trio). Keep the first by signature.
  const seenMemberKeys = new Set<string>();
  clusters = clusters.filter((c) => {
    const memberKey = c.members
      .map((m) => m.id)
      .sort((a, b) => a - b)
      .join(",");
    if (seenMemberKeys.has(memberKey)) return false;
    seenMemberKeys.add(memberKey);
    return true;
  });

  // Cap to maxClustersPerRun, largest clusters first (deterministic tiebreak).
  clusters.sort((a, b) => b.members.length - a.members.length || a.signature.localeCompare(b.signature));
  return clusters.slice(0, Math.max(0, opts.maxClustersPerRun));
}

// ── Prompt + ref derivation ───────────────────────────────────────────────────

/** Read a memory body (frontmatter stripped) for the cluster prompt. */
function readBody(entry: DbIndexedEntry): string {
  try {
    const raw = fs.readFileSync(entry.filePath, "utf8");
    return parseFrontmatter(raw).content.trim();
  } catch {
    return "";
  }
}

/** Assemble the per-cluster user prompt fed to the recombine LLM. */
export function buildClusterPrompt(cluster: MemoryCluster): string {
  const lines: string[] = [
    `Shared signal: ${cluster.signature}`,
    `Cluster of ${cluster.members.length} related memories:`,
    "",
  ];
  for (const m of cluster.members) {
    lines.push(`[memory:${m.entry.name}]`);
    if (m.entry.description) lines.push(`Description: ${m.entry.description}`);
    const body = readBody(m);
    if (body) lines.push(body);
    lines.push("");
  }
  lines.push(
    "Induce ONE cross-episodic generalization these memories support, or return an explicit null if none is defensible.",
  );
  return lines.join("\n");
}

/**
 * Stable lesson ref for a cluster. The hash of the sorted member refs keeps the
 * ref deterministic across runs (so re-induction maps to the same ref + the
 * content-hash dedup in createProposal suppresses queue churn).
 */
export function deriveRecombineLessonRef(cluster: MemoryCluster): string {
  const slug = cluster.signature
    .replace(/^(tag|entity):/, "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  const memberKey = cluster.members
    .map((m) => m.entryKey)
    .sort()
    .join("|");
  const hash = createHash("sha256").update(memberKey, "utf8").digest("hex").slice(0, 8);
  return `lesson:recombined/${slug || "cluster"}-${hash}`;
}

/** Parse the raw LLM output into a generalization, or `null` for the justified-null path. */
function parseGeneralization(raw: string | null): Generalization | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.toLowerCase() === "null") return null;
  const parsed = parseEmbeddedJsonResponse<unknown>(trimmed);
  if (parsed === undefined || parsed === null) return null;
  if (typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  const description = typeof obj.description === "string" ? obj.description : "";
  const body = typeof obj.body === "string" ? obj.body : "";
  const when_to_use = typeof obj.when_to_use === "string" ? obj.when_to_use : undefined;
  // An empty object / all-empty fields is treated as a justified null.
  if (!description && !body) return null;
  return { description, body, ...(when_to_use ? { when_to_use } : {}) };
}

/**
 * Resolve the production LLM seam from the active improve profile. Returns a
 * `RecombineLlmFn` that issues one bounded chatCompletion per call, or
 * `undefined` when no LLM is configured (the pass then makes no calls).
 */
function resolveProductionLlmFn(config: AkmConfig, signal?: AbortSignal): RecombineLlmFn | undefined {
  const recombineProcess = config.profiles?.improve?.default?.processes?.recombine;
  const runnerSpec = resolveImproveProcessRunnerFromProfile(recombineProcess, config);
  const llmConfig = runnerSpec && runnerIsLlm(runnerSpec) ? runnerSpec.connection : getDefaultLlmConfig(config);
  if (!llmConfig) return undefined;
  return async (clusterPrompt: string) => {
    const messages: ChatMessage[] = [
      { role: "system", content: RECOMBINE_SYSTEM_PROMPT },
      { role: "user", content: clusterPrompt },
    ];
    try {
      return await chatCompletion(llmConfig, messages, { signal, enableThinking: false });
    } catch (e) {
      warn(`[recombine] LLM call failed: ${String(e)}`);
      return null;
    }
  };
}

// ── Main entry point ───────────────────────────────────────────────────────────

export async function akmRecombine(opts: AkmRecombineOptions): Promise<RecombineResult> {
  const startMs = Date.now();
  const config = opts.config ?? loadConfig();
  const stashDir = opts.stashDir ?? resolveStashDir();
  const sourceRun = opts.sourceRun ?? `recombine-${startMs}`;
  const eligibilitySource: EligibilitySource = opts.eligibilitySource ?? "recombine";
  const minClusterSize = opts.minClusterSize ?? DEFAULT_MIN_CLUSTER_SIZE;
  const maxClustersPerRun = opts.maxClustersPerRun ?? DEFAULT_MAX_CLUSTERS_PER_RUN;
  const relatednessSource = opts.relatednessSource ?? DEFAULT_RELATEDNESS_SOURCE;
  const warnings: string[] = [];

  const finish = (over: Partial<RecombineResult>): RecombineResult => ({
    schemaVersion: 1,
    ok: true,
    clustersFormed: 0,
    proposalsEmitted: 0,
    nullsReturned: 0,
    durationMs: Date.now() - startMs,
    warnings,
    ...over,
  });

  // Budget guard: an already-aborted signal short-circuits before any LLM call.
  if (opts.signal?.aborted) {
    return finish({ ok: false, warnings: [...warnings, "aborted-before-start"] });
  }

  // Load the memory pool + (optionally) graph entities from the index.
  let entries: DbIndexedEntry[] = [];
  let entityByEntryId: Map<number, string[]> | undefined;
  let db: ReturnType<typeof openExistingDatabase> | undefined;
  try {
    db = openExistingDatabase();
    entries = getAllEntries(db, "memory");
    if (relatednessSource === "graph" || relatednessSource === "both") {
      try {
        entityByEntryId = getEntitiesByEntryIds(
          db,
          entries.map((e) => e.id),
        );
      } catch {
        // Fail open to tag relatedness.
        entityByEntryId = undefined;
      }
    }
  } catch (e) {
    warnings.push(`recombine: failed to open index — ${String(e)}`);
    return finish({ ok: false });
  } finally {
    if (db) closeDatabase(db);
  }

  const clusters = buildRelatednessClusters(entries, {
    minClusterSize,
    maxClustersPerRun,
    relatednessSource,
    ...(entityByEntryId ? { entityByEntryId } : {}),
  });

  let clustersFormed = 0;
  let proposalsEmitted = 0;
  let nullsReturned = 0;

  const llmFn = opts.recombineLlmFn ?? resolveProductionLlmFn(config, opts.signal);
  if (!llmFn) {
    warnings.push("recombine: no LLM configured — skipping");
    return finish({ clustersFormed: 0 });
  }

  for (const cluster of clusters) {
    if (opts.signal?.aborted) {
      warnings.push("aborted-mid-run");
      break;
    }
    clustersFormed += 1;

    const prompt = buildClusterPrompt(cluster);
    const raw = await llmFn(prompt);
    const generalization = parseGeneralization(raw);

    if (!generalization) {
      nullsReturned += 1;
      appendEvent(
        {
          eventType: "recombine_invoked",
          ref: deriveRecombineLessonRef(cluster),
          metadata: {
            signal: cluster.signature,
            memberCount: cluster.members.length,
            outcome: "null_returned",
            sourceRun,
          },
        },
        opts.ctx,
      );
      continue;
    }

    const lessonRef = deriveRecombineLessonRef(cluster);
    const sourceRefs = cluster.members.map((m) => `memory:${m.entry.name}`);

    // Quality gate (always-run): the frontmatter description must be present
    // and non-truncated. This runs BEFORE createProposal — never bypassed.
    const fmCheck = validateProposalFrontmatter({ description: generalization.description });
    if (!fmCheck.ok) {
      appendEvent(
        {
          eventType: "recombine_invoked",
          ref: lessonRef,
          metadata: {
            signal: cluster.signature,
            memberCount: cluster.members.length,
            outcome: "quality_rejected",
            reason: fmCheck.reason,
            sourceRun,
          },
        },
        opts.ctx,
      );
      continue;
    }

    // Two-pass guard: the first pass ALWAYS emits `type: hypothesis` (never
    // `type: lesson`). Promotion to a lesson is a later confirmation run's job.
    //
    // NOTE (v1 deferral): confirmation-count tracking (re-induce N times before
    // promoting to `type: lesson`) is deferred. The hypothesis-only emission
    // invariant below is non-negotiable and test-locked.
    const frontmatter: Record<string, unknown> = {
      type: "hypothesis",
      description: generalization.description,
      ...(generalization.when_to_use ? { when_to_use: generalization.when_to_use } : {}),
      source_refs: sourceRefs,
    };
    const content = assembleContent(frontmatter, generalization.body);

    const proposalResult = createProposal(
      stashDir,
      {
        ref: lessonRef,
        source: "recombine",
        sourceRun,
        payload: { content, frontmatter: { description: generalization.description } },
        eligibilitySource,
      },
      opts.ctx,
    );

    if (isProposalSkipped(proposalResult)) {
      appendEvent(
        {
          eventType: "recombine_invoked",
          ref: lessonRef,
          metadata: {
            signal: cluster.signature,
            memberCount: cluster.members.length,
            outcome: "skipped",
            skipReason: proposalResult.reason,
            sourceRun,
          },
        },
        opts.ctx,
      );
      continue;
    }

    proposalsEmitted += 1;
    appendEvent(
      {
        eventType: "recombine_invoked",
        ref: lessonRef,
        metadata: {
          signal: cluster.signature,
          memberCount: cluster.members.length,
          outcome: "queued",
          proposalId: proposalResult.id,
          sourceRun,
        },
      },
      opts.ctx,
    );
  }

  return finish({ clustersFormed, proposalsEmitted, nullsReturned });
}

/** Serialize frontmatter + body into a markdown asset string. */
function assembleContent(frontmatter: Record<string, unknown>, body: string): string {
  const lines: string[] = ["---"];
  for (const [key, value] of Object.entries(frontmatter)) {
    if (Array.isArray(value)) {
      lines.push(`${key}: [${value.map((v) => JSON.stringify(v)).join(", ")}]`);
    } else {
      lines.push(`${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
    }
  }
  lines.push("---", "", body, "");
  return lines.join("\n");
}
