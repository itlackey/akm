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
 * `confirmThreshold` times (#625). The confirmation count is persisted in the
 * `recombine_hypotheses` state.db table (migration 014), keyed by the
 * deterministic `deriveRecombineLessonRef` value so re-induction of the SAME
 * member-set maps back to the SAME row. When the count reaches the threshold,
 * the run emits ONE `type: lesson` promotion proposal through the SAME proposal
 * queue + quality gate (createProposal + validateProposalFrontmatter), NEVER a
 * direct stash write, then marks the row promoted (resetting its count) so it is
 * not re-promoted on every subsequent run. Hypotheses NOT re-induced in a run
 * have their consecutive streak reset (decay-to-zero).
 *
 * NAMESPACE note: the ref stays `lesson:recombined/<slug>-<hash>` for BOTH
 * passes. The ref is the promotion TARGET asset (a lesson in both the hypothesis
 * and promoted states), so re-induction must map to the same ref and the ref
 * cannot encode the proposal type. The hypothesis-vs-lesson distinction is
 * carried ONLY by the proposal frontmatter `type` field. On promotion the prior
 * pending `type: hypothesis` proposal for that ref is superseded (rejected) so
 * the queue never shows two proposals for one ref.
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
import { resolveStashStandards } from "../../core/standards/resolve-stash-standards";
import {
  decayUnseenRecombineHypotheses,
  findMatchingRecombineHypothesis,
  getRecombineHypothesis,
  getStateDbPath,
  markRecombineHypothesisPromoted,
  openStateDatabase,
  recordRecombineInduction,
} from "../../core/state-db";
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
import { archiveProposal, createProposal, isProposalSkipped, listProposals } from "../proposal/validators/proposals";
import { isConsolidationEligibleMemoryName } from "./consolidate";

export type { RecombineResult } from "../../core/improve-types";

const RECOMBINE_SYSTEM_PROMPT = recombineSystemPrompt;

const DEFAULT_MIN_CLUSTER_SIZE = 3;
const DEFAULT_MAX_CLUSTERS_PER_RUN = 5;
// #632 — default to the UNION of tag + graph-entity relatedness, with entity
// clusters PREFERRED at selection time (see the rank in buildRelatednessClusters).
// Entity clustering surfaces coherent, subject-scoped clusters (a tool/subsystem)
// that the coarse stash-wide tag buckets miss, while tags still cover memories the
// graph has no entity for. The `entity:` vs `tag:` signature namespaces are
// independent, so a pure tag cluster's confirmation streak is only re-baselined
// when its OWN membership changes — which is exactly what the session-capture pool
// exclusion intends for the telemetry-polluted buckets (re-baselining a noisy
// cluster's streak is correct, not a regression). A stash with no extracted graph
// entities falls through to tag-only.
const DEFAULT_RELATEDNESS_SOURCE: "tags" | "graph" | "both" = "both";
/** #625 — re-induction count required before a hypothesis promotes to a lesson. */
const DEFAULT_CONFIRM_THRESHOLD = 2;
/**
 * #633 — Jaccard membership-overlap threshold for matching a freshly-induced
 * hypothesis to an existing pending row under the SAME signature. A growing
 * stash drifts the exact member set every run; an overlap >= this lets the
 * confirmation streak keep accumulating under one row instead of resetting to 1.
 */
const DEFAULT_RECOMBINE_OVERLAP = 0.7;

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
  /** #632 — skip clusters larger than this. Threaded from `processes.recombine.maxClusterSize`. UNSET = no cap. */
  maxClusterSize?: number;
  /** #632 — tags excluded from tag clustering. Threaded from `processes.recombine.excludeTags`. UNSET/[] = none. */
  excludeTags?: string[];
  /** #632 — entity_norms excluded from entity clustering. Threaded from `processes.recombine.excludeEntities`. UNSET/[] = none. */
  excludeEntities?: string[];
  /**
   * #625 — re-induction count at which a hypothesis promotes to a `type: lesson`
   * proposal. Defaults to {@link DEFAULT_CONFIRM_THRESHOLD}. Threaded from
   * `processes.recombine.confirmThreshold`.
   */
  confirmThreshold?: number;
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
 * #632 — English stopwords that occasionally leak into frontmatter tags
 * (`is`, `the`, `for`, …). They carry no topical signal, so a cluster keyed on
 * one is meaningless. Lowercased; matched case-insensitively.
 */
const JUNK_STOPWORD_TAGS = new Set([
  "a",
  "an",
  "and",
  "the",
  "to",
  "of",
  "in",
  "on",
  "for",
  "is",
  "are",
  "be",
  "no",
  "not",
  "or",
  "if",
  "it",
  "as",
  "at",
  "by",
  "we",
  "us",
  "do",
  "so",
  "when",
  "then",
  "than",
  "with",
  "from",
  "this",
  "that",
  "uses",
  "use",
  "via",
]);

/**
 * #632 — a tag carries no clustering signal (and must be skipped) when it is
 * purely a number / date / hash / version string, a single char, or a common
 * stopword. Unlike `excludeTags` (a fixed project list), this catches the
 * OPEN-ENDED junk — every new date or commit hash — without config upkeep.
 */
export function isJunkTag(tag: string): boolean {
  const t = tag.trim().toLowerCase();
  if (t.length <= 1) return true;
  if (JUNK_STOPWORD_TAGS.has(t)) return true;
  if (/^\d+$/.test(t)) return true; // pure numbers + dates: 2026, 05, 23, 20260529
  if (/^v?\d+(?:\.\d+)+$/.test(t)) return true; // versions: 0.8.0, v1.2
  if (/^v\d+$/.test(t)) return true; // v0, v2
  if (/^[0-9a-f]{4,}$/.test(t) && /\d/.test(t)) return true; // short hex hashes: 002c624c, 192d
  return false;
}

/**
 * #632 — generic extraction-artefact entities the graph routinely emits: session
 * bookkeeping (`session_id`, `session_checkpoint`), structured-log field names
 * (`reason`, `harness`, `structured event log`), and the like. They are
 * stash-wide and carry no topical signal, so an `entity:<norm>` cluster keyed on
 * one is exactly the bland mega-bucket #632 aims to remove. Lowercased; matched
 * against the already-normalised `entity_norm`.
 */
const JUNK_ENTITY_NORMS = new Set([
  "session",
  "session_id",
  "session_checkpoint",
  "checkpoint",
  "reason",
  "harness",
  "event",
  "event log",
  "structured event",
  "structured event log",
  "timestamp",
  "metadata",
  "status",
]);

/**
 * #632 — AKM session-capture telemetry memories: auto-generated session-end
 * checkpoints named `<harness>-session-<YYYYMMDD>-<id>` or
 * `<harness>-checkpoint-<YYYYMMDD…>-<id>`, carrying an embedded
 * `akm_memory_kind: session_checkpoint` metadata block. Their bodies are
 * pipeline bookkeeping, so the graph extracts their metadata FIELDS
 * (`session_checkpoint`, `harness`, `buffered observations`, `tool_*_observed`,
 * …) as ENTITIES — which then dominate entity clustering as bland, stash-wide
 * mega-buckets (the #632 symptom, just under an `entity:` signature). They are
 * session telemetry, not durable knowledge to generalize, so recombine excludes
 * them from its pool. The `\d{8}` datestamp anchor is what distinguishes a
 * capture name from a durable memory that merely MENTIONS session/checkpoint
 * (e.g. `akm-plugins-session-end-extract-hook`, `session-checkpoint-lint-skips`),
 * which stay in the pool.
 */
export function isSessionCaptureMemoryName(name: string): boolean {
  return /-(session|checkpoint)-\d{8}/.test(name);
}

/**
 * #632 — an entity carries no clustering signal (and must be skipped) when it is
 * a generic extraction artefact (session / structured-log bookkeeping), a raw
 * filesystem path (absolute paths the extractor lifts verbatim), or the same
 * number / date / hash / version / stopword junk `isJunkTag` rejects. Mirrors
 * `isJunkTag` so the graph relatedness source does not reintroduce the very
 * bland buckets entity clustering is meant to replace. Unlike `excludeEntities`
 * (a fixed user list), this catches the OPEN-ENDED junk without config upkeep.
 */
export function isJunkEntity(entity: string): boolean {
  const e = entity.trim().toLowerCase();
  if (e.length <= 1) return true;
  if (JUNK_ENTITY_NORMS.has(e)) return true;
  if (JUNK_STOPWORD_TAGS.has(e)) return true;
  if (e.includes("/") || e.includes("\\")) return true; // raw file paths
  if (/^\d+$/.test(e)) return true; // pure numbers + dates
  if (/^v?\d+(?:\.\d+)+$/.test(e)) return true; // versions
  if (/^v\d+$/.test(e)) return true; // v0, v2
  if (/^[0-9a-f]{4,}$/.test(e) && /\d/.test(e)) return true; // short hex hashes
  return false;
}

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
 * clusters are de-duplicated by member-set identity, and the result is RANKED
 * by member-count descending (deterministic alphabetical tiebreak). The
 * `maxClustersPerRun` cap is NOT applied here — call {@link capClusters} on the
 * result for the processed slice; the full ranked list is retained so the
 * cap-aware decay sweep can tell cap-displacement from corpus absence (#658).
 */
export function buildRelatednessClusters(
  entries: DbIndexedEntry[],
  opts: {
    minClusterSize: number;
    relatednessSource: "tags" | "graph" | "both";
    entityByEntryId?: Map<number, string[]>;
    /**
     * #632 — clusters strictly larger than this are SKIPPED (drop bland,
     * over-broad buckets). When set, the largest-first ranking no longer
     * starves tighter clusters (oversized ones are removed before ranking).
     * UNSET = no cap = byte-identical to the pre-#632 behaviour.
     */
    maxClusterSize?: number;
    /**
     * #632 — tag values that must never form a tag cluster. UNSET/[] =
     * byte-identical to the pre-#632 behaviour.
     */
    excludeTags?: string[];
    /**
     * #632 — entity_norm values that must never form an entity cluster (the
     * user-curated counterpart to {@link isJunkEntity}'s open-ended filter).
     * UNSET/[] = entity clustering governed by the junk filter alone.
     */
    excludeEntities?: string[];
  },
): MemoryCluster[] {
  // Only consolidation-eligible memories participate (exclude `.derived`).
  // #632 — durable memories only: exclude `.derived` (via
  // `isConsolidationEligibleMemoryName`) AND session-capture telemetry dumps
  // whose embedded metadata pollutes both tag and entity clustering.
  const memories = entries.filter(
    (e) =>
      e.entry.type === "memory" &&
      isConsolidationEligibleMemoryName(e.entry.name) &&
      !isSessionCaptureMemoryName(e.entry.name),
  );

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

  // #632 — tags/entities excluded from clustering (applies regardless of
  // source). UNSET/[] leaves tag clustering byte-identical to the pre-#632 path.
  const excludeTags = new Set(opts.excludeTags ?? []);
  // `entity_norm` is always lowercased (graph-dedup.ts), so normalise the
  // user-supplied exclusion list to match — `excludeEntities: ["OpenCode"]`
  // should suppress the stored `opencode` entity (Reviewer A, #632).
  const excludeEntities = new Set((opts.excludeEntities ?? []).map((e) => e.toLowerCase()));

  for (const entry of memories) {
    if (useTags || tagsFallback) {
      for (const tag of entry.entry.tags ?? []) {
        if (excludeTags.has(tag)) continue;
        if (isJunkTag(tag)) continue; // #632 — skip numeric/date/hash/version/stopword junk
        add(`tag:${tag}`, entry);
      }
    }
    if (useGraph && opts.entityByEntryId) {
      for (const ent of opts.entityByEntryId.get(entry.id) ?? []) {
        if (excludeEntities.has(ent)) continue;
        if (isJunkEntity(ent)) continue; // #632 — skip generic extraction-artefact / path entities
        add(`entity:${ent}`, entry);
      }
    }
  }

  // Keep only groups at or above the minimum cluster size. #632 — when
  // maxClusterSize is set, also SKIP groups strictly larger than the cap so an
  // over-broad bucket never reaches (and starves) the largest-first slice.
  // UNSET = no upper bound = identical to the pre-#632 behaviour.
  let clusters: MemoryCluster[] = [];
  for (const [signature, members] of groups) {
    if (members.length < opts.minClusterSize) continue;
    if (opts.maxClusterSize != null && members.length > opts.maxClusterSize) continue;
    clusters.push({ signature, members });
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

  // #632 — rank ENTITY clusters ahead of tag clusters, then largest-first within
  // each kind (deterministic alphabetical tiebreak). A graph entity is an
  // EXTRACTED SUBJECT (a tool / subsystem / component), so it is a far
  // higher-signal cluster key than an auto-tokenized frontmatter tag, whose
  // broadest buckets (`tag:<project>` — e.g. every memory tagged `akm`) are the
  // coarse, bland clusters #632 set out to kill. Largest-first ALONE let those
  // tag mega-buckets fill the `maxClustersPerRun` slice every run and starve the
  // coherent entity clusters this pass produces. Preferring entities keeps tag
  // clustering as the fallback (a stash with no graph entities, or a topic with a
  // tag but no extracted entity, still clusters) while ensuring the better signal
  // wins the cap. The cap is applied by the caller via {@link capClusters}, NOT
  // here, so the FULL formed set stays available for the cap-aware decay sweep —
  // a cluster displaced by the cap must not be confused with a cluster that
  // vanished from the corpus (#658).
  const entityRank = (sig: string): number => (sig.startsWith("entity:") ? 0 : 1);
  clusters.sort(
    (a, b) =>
      entityRank(a.signature) - entityRank(b.signature) ||
      b.members.length - a.members.length ||
      a.signature.localeCompare(b.signature),
  );
  return clusters;
}

/**
 * #658 — apply the `maxClustersPerRun` cap to a largest-first ranked cluster
 * list. Split out from {@link buildRelatednessClusters} so callers retain the
 * full pre-cap set: the clusters BELOW the cap still re-formed this run and must
 * spare their hypotheses from decay (cap-displacement is a SCHEDULING miss, not
 * a substance miss). Callers that only need the processed slice call this; the
 * full ranked list feeds {@link decayUnseenRecombineHypotheses}.
 */
export function capClusters(ranked: MemoryCluster[], maxClustersPerRun: number): MemoryCluster[] {
  return ranked.slice(0, Math.max(0, maxClustersPerRun));
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
export function buildClusterPrompt(cluster: MemoryCluster, standardsContext = ""): string {
  const lines: string[] = [
    `Shared signal: ${cluster.signature}`,
    `Cluster of ${cluster.members.length} related memories:`,
    "",
  ];
  if (standardsContext.trim()) {
    lines.push("Standards to follow (the rulebook for this target):");
    lines.push(standardsContext.trim());
    lines.push("");
  }
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
  const memberKey = recombineMemberKey(cluster);
  const hash = createHash("sha256").update(memberKey, "utf8").digest("hex").slice(0, 8);
  return `lesson:recombined/${slug || "cluster"}-${hash}`;
}

/**
 * The membership fingerprint of a cluster: its member entryKeys sorted and
 * joined. Single source of truth shared by {@link deriveRecombineLessonRef}'s
 * hash and the `recombine_hypotheses.member_key` column, so the table key and
 * the ref hash always derive from the SAME member set. Adding/removing one
 * memory yields a different fingerprint → a different ref → a fresh row (the
 * old streak is correctly NOT inherited).
 */
export function recombineMemberKey(cluster: MemoryCluster): string {
  return cluster.members
    .map((m) => m.entryKey)
    .sort()
    .join("|");
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
  const confirmThreshold = opts.confirmThreshold ?? DEFAULT_CONFIRM_THRESHOLD;
  const warnings: string[] = [];

  const finish = (over: Partial<RecombineResult>): RecombineResult => ({
    schemaVersion: 1,
    ok: true,
    clustersFormed: 0,
    proposalsEmitted: 0,
    lessonsPromoted: 0,
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

  // #658 — `rankedClusters` is the FULL set that re-formed this run (ranked,
  // pre-cap); `clusters` is the processed top-`maxClustersPerRun` slice. The
  // decay sweep below uses the full set so a cap-displaced (but present)
  // cluster spares its hypothesis from reset.
  const rankedClusters = buildRelatednessClusters(entries, {
    minClusterSize,
    relatednessSource,
    ...(entityByEntryId ? { entityByEntryId } : {}),
    ...(opts.maxClusterSize != null ? { maxClusterSize: opts.maxClusterSize } : {}),
    ...(opts.excludeTags ? { excludeTags: opts.excludeTags } : {}),
    ...(opts.excludeEntities ? { excludeEntities: opts.excludeEntities } : {}),
  });
  const clusters = capClusters(rankedClusters, maxClustersPerRun);

  let clustersFormed = 0;
  let proposalsEmitted = 0;
  let lessonsPromoted = 0;
  let nullsReturned = 0;

  const llmFn = opts.recombineLlmFn ?? resolveProductionLlmFn(config, opts.signal);
  if (!llmFn) {
    warnings.push("recombine: no LLM configured — skipping");
    return finish({ clustersFormed: 0 });
  }

  // #625 — open the confirmation-count store once per run via the ctx seam,
  // reusing a long-lived ctx.db handle when the caller provided one (mirrors
  // proposals.ts). Only handles WE opened are closed in the finally below.
  const ownStateDb = opts.ctx?.db ? undefined : openStateDatabase(opts.ctx?.dbPath ?? getStateDbPath());
  const stateDb = opts.ctx?.db ?? ownStateDb;
  // Refs re-induced (defensible generalization passed the quality gate) THIS
  // run — everything else is decayed after the loop.
  const seenThisRun = new Set<string>();

  // Recombine output is knowledge/lesson (non-wiki) → stash authoring
  // standards. Resolved ONCE per run and passed to each cluster prompt.
  const standardsContext = resolveStashStandards(stashDir);

  try {
    for (const cluster of clusters) {
      if (opts.signal?.aborted) {
        warnings.push("aborted-mid-run");
        break;
      }
      clustersFormed += 1;

      const prompt = buildClusterPrompt(cluster, standardsContext);
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

      // #633 — the confirmation identity is decoupled from the EXACT member
      // set. We first look for an existing pending hypothesis row under the
      // SAME signature whose membership overlaps this cluster (Jaccard >=
      // threshold) and, if found, REUSE that row's stable ref so a
      // drifting-but-overlapping cluster keeps accumulating its streak under one
      // row instead of spawning a fresh row (count=1) every run. With no match
      // (first induction, or membership drifted past the overlap floor) we fall
      // back to the deterministic member-set ref exactly as before.
      const memberKey = recombineMemberKey(cluster);
      const derivedRef = deriveRecombineLessonRef(cluster);
      const matchedRow = stateDb
        ? findMatchingRecombineHypothesis(stateDb, {
            signature: cluster.signature,
            memberKey,
            minOverlap: DEFAULT_RECOMBINE_OVERLAP,
          })
        : undefined;
      const lessonRef = matchedRow?.hypothesis_ref ?? derivedRef;
      const sourceRefs = cluster.members.map((m) => `memory:${m.entry.name}`);

      // Quality gate (always-run): the frontmatter description must be present
      // and non-truncated. This runs BEFORE createProposal on BOTH the
      // hypothesis and the promotion paths — never bypassed.
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

      // A defensible generalization was produced this run — record it so it is
      // NOT decayed by the unseen sweep below.
      seenThisRun.add(lessonRef);

      // #625/#633 — record the re-induction and read the prior promotion state.
      // `lessonRef` is the matched row's ref (overlap match) or the freshly
      // derived member-set ref (first/non-overlapping induction). The induction
      // refreshes the row's `member_key` to the current membership so the
      // overlap window slides with the drifting cluster.
      const nowIso = new Date().toISOString();
      const priorRow = stateDb ? getRecombineHypothesis(stateDb, lessonRef) : undefined;
      const alreadyPromoted = priorRow?.promoted_at != null;
      const count = stateDb
        ? recordRecombineInduction(stateDb, {
            hypothesisRef: lessonRef,
            signature: cluster.signature,
            memberKey,
            seenAt: nowIso,
            run: sourceRun,
          })
        : 0;

      // Promote to a `type: lesson` proposal when the confirmation streak
      // reaches the threshold AND the hypothesis has not already been promoted.
      const promote = stateDb != null && !alreadyPromoted && count >= confirmThreshold;
      const proposalType = promote ? "lesson" : "hypothesis";

      const frontmatter: Record<string, unknown> = {
        type: proposalType,
        description: generalization.description,
        ...(generalization.when_to_use ? { when_to_use: generalization.when_to_use } : {}),
        source_refs: sourceRefs,
      };
      const content = assembleContent(frontmatter, generalization.body);

      if (promote && stateDb) {
        // Supersede the prior pending `type: hypothesis` proposal for this ref so
        // the queue never shows two proposals for one ref. The promoted lesson
        // proposal has different content (type changed), so content-hash dedup
        // would otherwise let both co-exist.
        for (const stale of listProposals(stashDir, { status: "pending", ref: lessonRef }, opts.ctx)) {
          if (stale.source === "recombine") {
            archiveProposal(stashDir, stale.id, "rejected", "superseded by recombine lesson promotion", opts.ctx);
          }
        }
      }

      const proposalResult = createProposal(
        stashDir,
        {
          ref: lessonRef,
          source: "recombine",
          sourceRun,
          payload: { content, frontmatter: { description: generalization.description } },
          eligibilitySource,
          // The promotion is a distinct asset (lesson) for the same ref; force
          // past the duplicate-pending guard (the stale hypothesis was just
          // superseded, but force keeps the path robust to ordering).
          ...(promote ? { force: true } : {}),
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

      if (promote && stateDb) {
        markRecombineHypothesisPromoted(stateDb, lessonRef, nowIso);
        lessonsPromoted += 1;
        appendEvent(
          {
            eventType: "recombine_invoked",
            ref: lessonRef,
            metadata: {
              signal: cluster.signature,
              memberCount: cluster.members.length,
              outcome: "promoted",
              proposalId: proposalResult.id,
              confirmationCount: count,
              sourceRun,
            },
          },
          opts.ctx,
        );
      } else {
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
              confirmationCount: count,
              sourceRun,
            },
          },
          opts.ctx,
        );
      }
    }

    // #625 — decay hypotheses NOT re-induced this run (reset their consecutive
    // streak) so confirmation is per-consecutive-run and conservative (AC4).
    // #658 — but a hypothesis whose cluster genuinely re-formed this run and was
    // merely cap-displaced (outside the top-`maxClustersPerRun` slice) must NOT
    // be decayed — that is a scheduling miss, not a substance miss. We pass
    // EVERY cluster that formed this run (the full pre-cap `rankedClusters`) as
    // `presentClusters`; decay spares any row that Jaccard-matches a present
    // cluster under the SAME overlap rule used for re-induction. Only rows with
    // no matching current cluster (the corpus stopped supporting them) decay.
    if (stateDb) {
      const presentClusters = rankedClusters.map((c) => ({
        signature: c.signature,
        memberKey: recombineMemberKey(c),
      }));
      const decayedCount = decayUnseenRecombineHypotheses(stateDb, sourceRun, [...seenThisRun], {
        presentClusters,
        minOverlap: DEFAULT_RECOMBINE_OVERLAP,
      });
      if (decayedCount > 0) {
        appendEvent(
          {
            eventType: "recombine_invoked",
            metadata: { outcome: "decayed", decayedCount, sourceRun },
          },
          opts.ctx,
        );
      }
    }
  } finally {
    if (ownStateDb) ownStateDb.close();
  }

  return finish({ clustersFormed, proposalsEmitted, lessonsPromoted, nullsReturned });
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
