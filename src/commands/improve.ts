// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
import { makeAssetRef, parseAssetRef } from "../core/asset-ref";
import { daysToMs, isAssetType } from "../core/common";
import type { AkmConfig } from "../core/config";
import { getDefaultLlmConfig, loadConfig } from "../core/config";
import { ConfigError, NotFoundError, rethrowIfTestIsolationError, UsageError } from "../core/errors";
import { appendEvent, type EventEnvelope, type EventsContext, readEvents } from "../core/events";
import { probeLock, releaseLock, tryAcquireLockSync } from "../core/file-lock";
import { parseFrontmatter } from "../core/frontmatter";
import { detectAndWriteContradictions } from "../core/memory-contradiction-detect";
import {
  type ArchivedMemoryCleanupRecord,
  analyzeMemoryCleanup,
  applyMemoryCleanup,
  type MemoryBeliefStateTransition,
  type MemoryCleanupPlan,
  type MemoryConsolidationCandidate,
  type MemoryContradictionCandidate,
  type MemoryPruneCandidate,
  type RelativeDateCandidate,
} from "../core/memory-improve";
import { getDbPath } from "../core/paths";
import {
  createProposal,
  expireStaleProposals,
  getProposal,
  isProposalSkipped,
  listProposals,
  purgeOrphanProposals,
} from "../core/proposals";
import { openStateDatabase, purgeOldEvents, purgeOldImproveRuns } from "../core/state-db";
import { info, warn } from "../core/warn";
import {
  closeDatabase,
  getAllEntries,
  getEntryCount,
  getRetrievalCounts,
  getUtilityScoresByIds,
  getZeroResultSearches,
  openDatabase,
  openExistingDatabase,
} from "../indexer/db";
import { ensureIndex } from "../indexer/ensure-index";
import { type GraphExtractionResult, runGraphExtractionPass } from "../indexer/graph-extraction";
import { akmIndex } from "../indexer/indexer";
import {
  type MemoryInferencePassOptions,
  type MemoryInferenceResult,
  runMemoryInferencePass,
} from "../indexer/memory-inference";
import { resolveAssetPath } from "../indexer/path-resolver";
import { getWritableStashDirs, resolveSourceEntries } from "../indexer/search-source";
import { runStalenessDetectionPass, type StalenessDetectionResult } from "../indexer/staleness-detect";
import { resolveImproveProcessRunnerFromProfile } from "../integrations/agent/runner";
import { getAvailableHarnesses, getExecutionLogCandidates } from "../integrations/session-logs";
import { isLlmFeatureEnabled, isProcessEnabled } from "../llm/feature-gate";
import { type AkmConsolidateOptions, akmConsolidate, type ConsolidateResult } from "./consolidate";
import { type AkmDistillResult, akmDistill, deriveLessonRef, isDistillRefusedInputType } from "./distill";
import { deriveKnowledgeRef } from "./distill-promotion-policy";
import { countEvalCases, writeEvalCase } from "./eval-cases";
import { type AkmExtractResult, akmExtract } from "./extract";
import { makeGateConfig, resolveExtractConfidence, runAutoAcceptGate } from "./improve-auto-accept";
import type { ImproveProfileConfig } from "./improve-profiles";
import { isProfileFilteredForAllPasses, resolveImproveProfile, shouldSkipRef } from "./improve-profiles";
import { akmLint } from "./lint/index";
import { type AkmReflectResult, akmReflect } from "./reflect";
import { runSchemaRepairPass } from "./schema-repair";
import { checkDeadUrls, type DeadUrl } from "./url-checker";

export interface AkmImproveOptions {
  scope?: string;
  task?: string;
  dryRun?: boolean;
  target?: string;
  /**
   * Confidence threshold (0-100). Undefined disables auto-accept for all
   * sub-processes (consolidation will prompt interactively on HTTP paths).
   * The CLI parser supplies 90 when --auto-accept is absent, so CLI callers
   * get auto-accept on by default. Programmatic callers must pass 90 explicitly
   * to match that behaviour.
   */
  autoAccept?: number;
  stashDir?: string;
  config?: AkmConfig;
  /** Wall-clock budget for the entire improve run in milliseconds. Defaults to 2 hours. */
  timeoutMs?: number;
  limit?: number;
  /** Named improve profile from profiles.improve or built-in profile names (default, quick, thorough, memory-focus). */
  profile?: string;
  consolidateOptions?: Omit<AkmConsolidateOptions, "config" | "stashDir">;
  /** Number of eligible memory assets above which consolidation is forced even if the memory_consolidation feature flag is not set. Defaults to 100. */
  memoryVolumeConsolidationThreshold?: number;
  reflectFn?: (options: NonNullable<Parameters<typeof akmReflect>[0]>) => Promise<AkmReflectResult>;
  distillFn?: (options: NonNullable<Parameters<typeof akmDistill>[0]>) => Promise<AkmDistillResult>;
  memoryInferenceFn?: (
    config: AkmConfig,
    sources: ReturnType<typeof resolveSourceEntries>,
    signal?: AbortSignal,
    db?: Database,
    reEnrich?: boolean,
    onProgress?: Parameters<typeof runMemoryInferencePass>[5],
    options?: MemoryInferencePassOptions,
  ) => Promise<MemoryInferenceResult>;
  /**
   * Phase 4A: injectable staleness-detection pass for tests. When omitted, the
   * real `runStalenessDetectionPass` runs (which is itself a no-op unless
   * `features.index.staleness_detection` is enabled).
   */
  stalenessDetectionFn?: (
    config: AkmConfig,
    sources: ReturnType<typeof resolveSourceEntries>,
    signal?: AbortSignal,
    db?: Database,
  ) => Promise<StalenessDetectionResult>;
  graphExtractionFn?: (
    config: AkmConfig,
    sources: ReturnType<typeof resolveSourceEntries>,
    signal?: AbortSignal,
    db?: Database,
    reEnrich?: boolean,
    onProgress?: Parameters<typeof runGraphExtractionPass>[5],
    options?: Parameters<typeof runGraphExtractionPass>[6],
  ) => Promise<GraphExtractionResult>;
  ensureIndexFn?: (stashDir: string) => Promise<unknown>;
  reindexFn?: (options: { stashDir: string }) => Promise<unknown>;
  /** When true (default), attempt LLM-driven schema repair on validation failures before skipping. Requires llm config. */
  repairValidationFailures?: boolean;
  /**
   * When true, only assets with recent feedback signals are eligible.
   * Disables the high-retrieval fallback path for type/all scope runs.
   */
  requireFeedbackSignal?: boolean;
  /**
   * Minimum retrieval count required for the zero-feedback fallback path.
   * Defaults to 5.
   */
  minRetrievalCount?: number;
  /**
   * Named process key forwarded to `akmReflect` so the improve loop picks up
   * per-process agent config (e.g. `agent.processes["reflect"]`).
   * Defaults to `"reflect"`. Set to another process name to route improve's
   * reflect calls through a different profile.
   */
  agentProcess?: string;
  /**
   * Self-consistency multi-sample voting for high-utility refs (R-2 / #389).
   * When a ref's utility score is at or above this threshold, the improve loop
   * runs N reflect samples and picks the majority-vote winner by Jaccard token
   * overlap. Self-Consistency arXiv:2203.11171 — N=3 samples beat single-shot
   * quality on reasoning tasks.
   *
   * Default: 0.7. Set to 1.0 to disable (no refs qualify).
   */
  selfConsistencyThreshold?: number;
  /**
   * Number of reflect samples to generate for high-utility refs (R-2 / #389).
   * Must be >= 2 for voting to make sense. Default: 3. Capped at 5.
   */
  selfConsistencyN?: number;
}

export interface ImproveEligibleRef {
  ref: string;
  reason: "scope-ref" | "scope-type" | "memory-cleanup" | "profile_filtered_all_passes";
}

export interface ImproveActionResult {
  ref: string;
  mode:
    | "reflect"
    | "reflect-failed"
    | "reflect-cooldown"
    | "reflect-skipped"
    | "reflect-guard-rejected"
    | "distill"
    | "distill-skipped"
    | "memory-prune"
    | "memory-inference"
    | "graph-extraction"
    | "error";
  result:
    | AkmReflectResult
    | AkmDistillResult
    | MemoryInferenceResult
    | GraphExtractionResult
    | { ok: true; pruned: boolean; reason: MemoryPruneCandidate["reason"] }
    | { ok: true; reason: string }
    | { ok: false; error: string };
}

export interface ImproveMemoryCleanupResult {
  analyzedDerived: number;
  pruneCandidates: MemoryPruneCandidate[];
  contradictionCandidates: MemoryContradictionCandidate[];
  beliefStateTransitions: MemoryBeliefStateTransition[];
  consolidationCandidates: MemoryConsolidationCandidate[];
  relativeDateCandidates?: RelativeDateCandidate[];
  archived?: ArchivedMemoryCleanupRecord[];
  transitionLogPath?: string;
  transitionLogEntries?: number;
  warnings?: string[];
}

export interface AkmImproveResult {
  schemaVersion: 1;
  ok: true;
  scope: {
    mode: "all" | "type" | "ref";
    value?: string;
  };
  dryRun: boolean;
  guidance?: string;
  memorySummary: {
    eligible: number;
    derived: number;
  };
  memoryCleanup?: ImproveMemoryCleanupResult;
  plannedRefs: ImproveEligibleRef[];
  /**
   * Refs the planner considered but excluded because every per-ref pass on
   * the active profile (reflect + distill) would refuse them. Additive
   * field — pre-2026-05-27 these refs went into `plannedRefs` and produced
   * 2× synthetic skip actions per run. See
   * `/tmp/akm-health-investigations/planner-profile-metrics-deep-analysis.md`.
   *
   * Each ref has its `reason` set to `"profile_filtered_all_passes"`. The
   * audit trail is also emitted as one `improve_skipped` event per ref.
   * Omitted entirely when no refs were filtered (keeps the envelope tidy
   * for stashes whose profile accepts every indexed type).
   */
  profileFilteredRefs?: ImproveEligibleRef[];
  actions?: ImproveActionResult[];
  validationFailures?: Array<{ ref: string; reason: string }>;
  schemaRepairs?: Array<{
    ref: string;
    reason: string;
    outcome: "queued" | "written" | "skipped" | "error";
    proposalId?: string;
    error?: string;
  }>;
  consolidation?: ConsolidateResult;
  /**
   * Session-extract pass results (one entry per available harness). Present
   * when `profiles.improve.default.processes.extract.enabled` is true (default)
   * and at least one harness reports `isAvailable() === true`.
   */
  extract?: AkmExtractResult[];
  lintSummary?: { fixed: number; flagged: number };
  memoryIndexHealth?: { lineCount: number; overBudget: boolean };
  coverageGaps?: string[];
  executionLogCandidates?: string[];
  evalCasesWritten?: number;
  deadUrls?: DeadUrl[];
  /** Number of reflect calls that had at least one error in the rolling window at call time. */
  reflectsWithErrorContext?: number;
  memoryInference?: MemoryInferenceResult;
  graphExtraction?: GraphExtractionResult;
  /**
   * Wall-clock duration of the memory-inference pass (ms). Surfaced at the
   * top level (not inside `memoryInference`) because both
   * `health.ts#summarizeImproveRuns` (wallTime.byPhase aggregator) and the
   * existing `metrics.memoryInference.durationMs` rollup read it from here.
   * Omitted entirely when the pass did not run.
   */
  memoryInferenceDurationMs?: number;
  /**
   * Wall-clock duration of the graph-extraction pass (ms). Same surfacing
   * convention as `memoryInferenceDurationMs` — top-level so the
   * `wallTime.byPhase.graphExtraction` aggregator in health.ts picks it up.
   * Omitted entirely when the pass did not run.
   */
  graphExtractionDurationMs?: number;
  /** Phase 4A: result of the staleness-detection pass (only present when the feature is enabled and produced telemetry). */
  stalenessDetection?: StalenessDetectionResult;
  /** Number of pending proposals purged because their target ref no longer exists on disk. */
  orphansPurged?: number;
  /**
   * Phase 6B (Advantage D6b): pending proposals archived as expired this run
   * because they aged past `config.archiveRetentionDays`.
   */
  proposalsExpired?: number;
  /** Number of reflect actions that were skipped due to cooldown/dedup signals. */
  reflectCooldownActions?: number;
  /** Number of reflect actions skipped because the asset type is not supported by reflect. */
  reflectSkippedActions?: number;
  /**
   * Number of reflect actions where a downstream content-policy guard
   * (e.g. EXCESSIVE_SHRINKAGE/EXCESSIVE_EXPANSION size rails) blocked an
   * otherwise valid LLM response. NOT counted as LLM failure. See
   * `/tmp/akm-health-investigations/metrics-taxonomy-review.md` §1a.
   */
  reflectGuardRejectedActions?: number;
  /**
   * Total proposals auto-promoted by the unified gate across all phases
   * (reflect, extract, distill, consolidate). Populated by summing the
   * `.promoted.length` from every `runAutoAcceptGate` call in the run.
   * Omitted when zero to keep the envelope tidy.
   */
  gateAutoAcceptedCount?: number;
}

type ImproveScope = ReturnType<typeof resolveImproveScope>;

interface ImprovePreparationResult {
  actions: ImproveActionResult[];
  cleanupWarnings: string[];
  appliedCleanup?: Awaited<ReturnType<typeof applyMemoryCleanup>>;
  memoryIndexHealth?: { lineCount: number; overBudget: boolean };
  executionLogCandidates: string[];
  /** Session-extract pass results (one per available harness), when enabled. */
  extract?: AkmExtractResult[];
  /**
   * Genuinely processable refs in priority order: post-validation, post-cooldown
   * (fully reflect+distill cooled refs are excluded and their synthetic skip
   * actions/events are emitted during preparation), post-signal-filter, and
   * sorted by combined utility + feedback-negativity score. distillOnly refs
   * participate in this set so --limit selects by score. Callers consuming
   * `plannedRefs` in the result envelope and post-loop maintenance use this
   * as the canonical "what got worked on this run" view.
   */
  actionableRefs: ImproveEligibleRef[];
  signalBearingSet: Set<string>;
  validationFailures: Array<{ ref: string; reason: string }>;
  schemaRepairs: Array<{
    ref: string;
    reason: string;
    outcome: "queued" | "written" | "skipped" | "error";
    proposalId?: string;
    error?: string;
  }>;
  lintSummary?: { fixed: number; flagged: number };
  loopRefs: ImproveEligibleRef[];
  distillCooledRefs: Set<string>;
  /** Refs on reflect cooldown but eligible for distill-only processing (Bug D2). */
  distillOnlyRefs: ImproveEligibleRef[];
  coverageGaps: string[];
  /** Per-ref utility scores (R-2 / #389): used for self-consistency threshold check. */
  utilityMap: Map<string, number>;
  /**
   * Per-originator rolling error windows (O-5 / #378).
   *
   * Errors from one sub-pass must NOT be injected into unrelated sub-passes as
   * avoidPatterns — that is the cross-task contamination failure mode Reflexion
   * (arXiv:2303.11366) warns against. Each originator key ("schema-repair",
   * "reflect", "distill") maps to its own rolling window of last-N errors.
   */
  recentErrors: Record<string, string[]>;
  gateAutoAcceptedCount: number;
}

interface ImproveLoopResult {
  reflectsWithErrorContext: number;
  memoryRefsForInference: Set<string>;
  gateAutoAcceptedCount: number;
}

interface ImprovePostLoopResult {
  allWarnings: string[];
  consolidation: ConsolidateResult;
  gateAutoAcceptedCount: number;
  deadUrls?: DeadUrl[];
  memoryInference?: MemoryInferenceResult;
  graphExtraction?: GraphExtractionResult;
  maintenanceActions?: ImproveActionResult[];
  memoryInferenceDurationMs: number;
  graphExtractionDurationMs: number;
  orphansPurged?: number;
  /** Phase 6B (Advantage D6b): pending proposals archived as expired this run. */
  proposalsExpired?: number;
  /** Phase 4A: result of the staleness-detection pass, when it ran. */
  stalenessDetection?: StalenessDetectionResult;
}

interface ImproveMaintenanceResult {
  memoryInference?: MemoryInferenceResult;
  graphExtraction?: GraphExtractionResult;
  actions?: ImproveActionResult[];
  memoryInferenceDurationMs: number;
  graphExtractionDurationMs: number;
  orphansPurged?: number;
  /** Phase 6B (Advantage D6b): pending proposals archived as expired this run. */
  proposalsExpired?: number;
  /** Phase 4A: result of the staleness-detection pass, when enabled. */
  stalenessDetection?: StalenessDetectionResult;
}

function resolveImproveScope(scope: string | undefined): { mode: "all" | "type" | "ref"; value?: string } {
  const trimmed = scope?.trim();
  if (!trimmed) return { mode: "all" };
  try {
    parseAssetRef(trimmed);
    return { mode: "ref", value: trimmed };
  } catch {
    if (!isAssetType(trimmed)) {
      throw new UsageError(
        `Unknown asset type: "${trimmed}". Valid types: memory, knowledge, skill, lesson, workflow, agent, command, script, wiki, vault, task.\n` +
          `If you passed --format to akm improve, that flag is not supported — use it with akm search or akm show instead.`,
        "INVALID_FLAG_VALUE",
      );
    }
    return { mode: "type", value: trimmed };
  }
}

async function collectEligibleRefs(
  scope: { mode: "all" | "type" | "ref"; value?: string },
  stashDir?: string,
  improveProfile?: ImproveProfileConfig,
): Promise<{
  plannedRefs: ImproveEligibleRef[];
  memorySummary: { eligible: number; derived: number };
  /**
   * Refs that were considered for planning but excluded because EVERY per-ref
   * pass on the active profile (reflect + distill) would refuse them.
   *
   * Mirrors the 2026-05-21 `.derived` precedent (improve.ts:447–467) which
   * pre-filters churn-only refs. The 2026-05-27 deep analysis
   * (`/tmp/akm-health-investigations/planner-profile-metrics-deep-analysis.md`)
   * showed 18 refs/run × 24 runs/day × 2 synthetic actions each were
   * dominating the metric stream (62 539 `distill-skipped` events in 7d;
   * 99.07% of `actions[]`). Excluding them at the planner moves the audit
   * trail to a single `improve_skipped` event per ref with reason
   * `profile_filtered_all_passes`, emitted by the caller once `eventsCtx` is
   * available.
   *
   * Empty when scope.mode === "ref" (user explicitly named the ref — intent
   * overrides profile-eligibility) or when no profile was passed (legacy
   * callers).
   */
  profileFilteredRefs: ImproveEligibleRef[];
}> {
  if (scope.mode === "ref" && scope.value) {
    const parsed = parseAssetRef(scope.value);
    const writableDirs = new Set(getWritableStashDirs(stashDir).map((dir) => path.resolve(dir)));
    const filePath = await findAssetFilePath(scope.value, stashDir, writableDirs);
    if (!filePath) {
      return {
        plannedRefs: [],
        memorySummary: { eligible: 0, derived: 0 },
        profileFilteredRefs: [],
      };
    }
    return {
      plannedRefs: [{ ref: scope.value, reason: "scope-ref" }],
      memorySummary: {
        eligible: parsed.type === "memory" ? 1 : 0,
        derived: parsed.type === "memory" && parsed.name.endsWith(".derived") ? 1 : 0,
      },
      profileFilteredRefs: [],
    };
  }

  let sources: ReturnType<typeof resolveSourceEntries>;
  try {
    sources = resolveSourceEntries(stashDir);
  } catch {
    return { plannedRefs: [], memorySummary: { eligible: 0, derived: 0 }, profileFilteredRefs: [] };
  }
  if (sources.length === 0) {
    return { plannedRefs: [], memorySummary: { eligible: 0, derived: 0 }, profileFilteredRefs: [] };
  }

  // Only operate on writable sources — never mutate read-only registry caches
  // or remote stashes that the user did not mark writable.
  let writableDirs: string[];
  try {
    writableDirs = getWritableStashDirs(stashDir);
  } catch {
    writableDirs = sources.slice(0, 1).map((s) => s.path); // fallback: primary only
  }
  const writableDirSet = new Set(writableDirs.map((d) => path.resolve(d)));

  let db: Database | undefined;
  try {
    db = openExistingDatabase();
    const entries = getAllEntries(db, scope.mode === "type" ? scope.value : undefined).filter((indexed) => {
      // First apply the existing stashDir-scope filter (no-op when stashDir is unset).
      if (!isEntryInScope(indexed.stashDir, indexed.filePath, stashDir)) return false;
      // Then restrict to writable sources only.
      return isEntryInWritableSource(indexed.stashDir, indexed.filePath, writableDirSet);
    });
    const planned = new Map<string, ImproveEligibleRef>();
    const profileFiltered = new Map<string, ImproveEligibleRef>();
    let memoryEligible = 0;
    let memoryDerived = 0;
    for (const indexed of entries) {
      const ref = makeAssetRef(indexed.entry.type, indexed.entry.name);
      const isDerived = indexed.entry.name.endsWith(".derived");
      // `.derived` memories are LLM-inferred and intentionally skip reflect
      // (see the synthetic `derived-memory-reflect-skipped` branch in the
      // improve loop). Enqueueing them here just produced one synthetic skip
      // per derived memory per hour with no real work — pure churn observed
      // 2026-05-21: 11 derived refs re-planned every hour during idle periods.
      // The cleanup phase (analyzeMemoryCleanup) inspects derived memories
      // independently of `plannedRefs`, so dropping them here loses nothing.
      if (!isDerived && !planned.has(ref) && !profileFiltered.has(ref)) {
        // 2026-05-27: extend the .derived precedent to profile-incompatible
        // refs. If every per-ref pass (reflect + distill) on the active
        // profile would refuse this ref, drop it from `plannedRefs`. The
        // caller emits `improve_skipped { reason: profile_filtered_all_passes }`
        // once `eventsCtx` is available so the audit trail is preserved in a
        // single event per ref instead of 2× synthetic actions per run.
        // Background: see /tmp/akm-health-investigations/planner-profile-metrics-deep-analysis.md
        if (improveProfile && isProfileFilteredForAllPasses(ref, improveProfile)) {
          profileFiltered.set(ref, {
            ref,
            reason: "profile_filtered_all_passes",
          });
        } else {
          planned.set(ref, {
            ref,
            reason:
              scope.mode === "type" ? "scope-type" : indexed.entry.type === "memory" ? "memory-cleanup" : "scope-type",
          });
        }
      }
      if (indexed.entry.type === "memory") {
        memoryEligible += 1;
        if (isDerived) memoryDerived += 1;
      }
    }
    return {
      plannedRefs: [...planned.values()],
      memorySummary: { eligible: memoryEligible, derived: memoryDerived },
      profileFilteredRefs: [...profileFiltered.values()],
    };
  } catch (error) {
    // The bun-test isolation guard must never be downgraded to "empty plan".
    rethrowIfTestIsolationError(error);
    if (error instanceof NotFoundError || error instanceof Error) {
      return { plannedRefs: [], memorySummary: { eligible: 0, derived: 0 }, profileFilteredRefs: [] };
    }
    throw error;
  } finally {
    if (db) closeDatabase(db);
  }
}

function isEntryInScope(entryStashDir: string, filePath: string, stashDir?: string): boolean {
  if (!stashDir) return true;
  const resolvedEntryStashDir = path.resolve(entryStashDir);
  const resolvedFilePath = path.resolve(filePath);
  const resolvedScopeStashDir = path.resolve(stashDir);
  return (
    resolvedEntryStashDir === resolvedScopeStashDir ||
    resolvedEntryStashDir.startsWith(`${resolvedScopeStashDir}${path.sep}`) ||
    resolvedFilePath.startsWith(`${resolvedScopeStashDir}${path.sep}`)
  );
}

/**
 * Return true when the indexed entry belongs to one of the writable source
 * directories. Entries from read-only registry caches or remote stashes that
 * the user has not marked writable must never enter the improve/distill loop.
 */
function isEntryInWritableSource(entryStashDir: string, filePath: string, writableDirSet: Set<string>): boolean {
  const resolvedEntryStashDir = path.resolve(entryStashDir);
  const resolvedFilePath = path.resolve(filePath);
  for (const writableDir of writableDirSet) {
    if (
      resolvedEntryStashDir === writableDir ||
      resolvedEntryStashDir.startsWith(`${writableDir}${path.sep}`) ||
      resolvedFilePath.startsWith(`${writableDir}${path.sep}`)
    ) {
      return true;
    }
  }
  return false;
}

function memoryCleanupParentRef(
  scope: { mode: "all" | "type" | "ref"; value?: string },
  stashDir?: string,
): string | undefined {
  if (scope.mode !== "ref" || !scope.value) return undefined;
  const parsed = parseAssetRef(scope.value);
  if (parsed.type !== "memory") return undefined;
  if (!parsed.name.endsWith(".derived")) return scope.value;

  const sources = resolveSourceEntries(stashDir);
  for (const source of sources) {
    const candidate = path.join(source.path, "memories", `${parsed.name}.md`);
    if (!fs.existsSync(candidate)) continue;
    const raw = fs.readFileSync(candidate, "utf8");
    const fm = parseFrontmatter(raw).data;
    const sourceRef = typeof fm.source === "string" ? fm.source : undefined;
    if (sourceRef) {
      try {
        const parent = parseAssetRef(sourceRef.trim());
        if (parent.type === "memory") return makeAssetRef(parent.type, parent.name);
      } catch {}
    }
  }

  return makeAssetRef("memory", parsed.name.slice(0, -".derived".length));
}

function isLessonCandidate(ref: string): boolean {
  // Only lesson assets need lesson-schema validation (description + when_to_use).
  // Memories have their own distill path via shouldDistillMemoryRef.
  // All other types go through reflect, not distill.
  return parseAssetRef(ref).type === "lesson";
}

/**
 * Planner-side check: should this ref enter the distill queue?
 *
 * Distill produces lessons from non-lesson sources. Two cases are eligible:
 *
 *   1. Memory refs that pass {@link shouldDistillMemoryRef} (the existing
 *      memory→lesson/knowledge promotion path).
 *
 * Refs whose `type` is in {@link DISTILL_REFUSED_INPUT_TYPES} (currently
 * `lesson:*`) are explicitly excluded — distill refuses them at runtime and
 * queuing them just produces a no-op `skipped` outcome per ref per hour. That
 * planner waste was the bug fixed in commit
 * fix(improve): drop distill-refused types from planner.
 *
 * Note: prior to this fix the gate used `isLessonCandidate(ref)` directly,
 * which was true *only* for `lesson:*` refs — exactly the set distill refuses.
 * The result: every hourly run re-queued the same lesson refs, the same skip
 * message returned, and no work was ever done. See
 * `tests/commands/improve-distill-planner-skip-lessons.test.ts`.
 */
function isDistillCandidateRef(ref: string, stashDir?: string): boolean {
  const parsed = parseAssetRef(ref);
  if (isDistillRefusedInputType(parsed.type)) return false;
  return shouldDistillMemoryRef(ref, stashDir);
}

function shouldDistillMemoryRef(ref: string, stashDir?: string): boolean {
  const parsed = parseAssetRef(ref);
  if (parsed.type !== "memory") return false;
  const sources = resolveSourceEntries(stashDir);
  for (const source of sources) {
    const candidate = `${source.path}/memories/${parsed.name}.md`;
    if (!fs.existsSync(candidate)) continue;
    const raw = fs.readFileSync(candidate, "utf8");
    const fm = parseFrontmatter(raw).data;
    const quality = typeof fm.quality === "string" ? fm.quality : undefined;
    if (quality === "proposed") return false;
    return !parsed.name.endsWith(".derived");
  }
  return !parsed.name.endsWith(".derived");
}

// ── Signal-delta eligibility helpers (0.8.0) ────────────────────────────────
//
// The 0.8.0 redesign replaced flat time-based cooldowns for reflect/distill
// with a *signal-delta* gate: a ref is re-eligible iff new feedback has
// landed since the last proposal was generated for it. These helpers build
// the two timestamp maps the gate needs in bulk, so the planner avoids
// N+1 queries across the full postCleanupRefs set.

/**
 * Latest feedback event timestamp per ref in the active window. Reads all
 * `feedback` events newer than `sinceIso` in one query and indexes by ref,
 * keeping the maximum `ts` per ref.
 *
 * Only events with a meaningful payload count as "signal" — `metadata.signal`
 * (positive/negative) OR `metadata.note` (a free-form annotation). Empty
 * metadata events are ignored so a stray `akm feedback <ref>` invocation
 * without a flag doesn't trigger downstream re-processing.
 */
function buildLatestFeedbackTsMap(refs: ReadonlyArray<string>, sinceIso: string): Map<string, string> {
  const out = new Map<string, string>();
  if (refs.length === 0) return out;
  const refSet = new Set(refs);
  const { events } = readEvents({ type: "feedback", since: sinceIso });
  for (const e of events) {
    const ref = e.ref;
    if (!ref || !refSet.has(ref)) continue;
    const meta = e.metadata as { signal?: unknown; note?: unknown } | undefined;
    const hasSignal = meta !== undefined && (typeof meta.signal === "string" || typeof meta.note === "string");
    if (!hasSignal) continue;
    const ts = e.ts ?? "";
    if (ts > (out.get(ref) ?? "")) out.set(ref, ts);
  }
  return out;
}

/**
 * Latest proposal timestamp per input-ref, filtered by source ('reflect' or
 * 'distill'). Reads the corresponding `*_invoked` events from state.db —
 * these events are emitted at proposal creation time and carry the *input*
 * asset ref (memory:foo, skill:bar, etc.) directly. We use them rather than
 * `listProposals` because distill proposals are keyed by the derived
 * lesson/knowledge ref, not the source memory — joining back through the
 * payload would be fragile.
 */
function buildLatestProposalTsMap(refs: ReadonlyArray<string>, source: "reflect" | "distill"): Map<string, string> {
  const out = new Map<string, string>();
  if (refs.length === 0) return out;
  const refSet = new Set(refs);
  const eventType = source === "reflect" ? "reflect_invoked" : "distill_invoked";
  const { events } = readEvents({ type: eventType });
  for (const e of events) {
    const ref = e.ref;
    if (!ref || !refSet.has(ref)) continue;
    // For distill_invoked we only count attempts that produced (or attempted
    // to produce) a real proposal — config_disabled / parse-error outcomes
    // should not move the signal-delta cursor forward.
    if (eventType === "distill_invoked") {
      const outcome = (e.metadata as { outcome?: unknown } | undefined)?.outcome;
      if (outcome !== "queued" && outcome !== "skipped" && outcome !== "validation_failed") continue;
    }
    const ts = e.ts ?? "";
    if (ts > (out.get(ref) ?? "")) out.set(ref, ts);
  }
  return out;
}

/**
 * Signal-delta eligibility predicate.
 *
 * True iff `latestFeedback[ref]` is defined AND either no prior proposal
 * exists for this (ref, source) OR `latestFeedback[ref] > lastProposal[ref]`.
 *
 * Refs with no feedback signal at all are ineligible by definition — the
 * high-retrieval fallback path (see `noFeedbackCandidates` later in the
 * planner) handles never-touched-but-frequently-read assets separately.
 */
function isSignalDeltaEligible(
  ref: string,
  latestFeedback: Map<string, string>,
  lastProposal: Map<string, string>,
): boolean {
  const fb = latestFeedback.get(ref);
  if (!fb) return false;
  const lp = lastProposal.get(ref);
  if (!lp) return true;
  return fb > lp;
}

export async function akmImprove(options: AkmImproveOptions = {}): Promise<AkmImproveResult> {
  const scope: ImproveScope = resolveImproveScope(options.scope);
  const reflectFn = options.reflectFn ?? akmReflect;
  const distillFn = options.distillFn ?? akmDistill;
  const ensureIndexFn = options.ensureIndexFn ?? ensureIndex;
  const reindexFn = options.reindexFn ?? akmIndex;
  // Resolve the improve profile for this run. Profile drives type filtering,
  // process gating, and default autoAccept/limit values.
  const _earlyConfig = options.config ?? loadConfig();
  const improveProfile = resolveImproveProfile(options.profile, _earlyConfig);
  // Apply profile defaults — CLI flags take precedence over profile defaults.
  // Rebuild options with effective values so all downstream stage functions
  // automatically pick up the profile-driven defaults.
  options = {
    ...options,
    autoAccept: options.autoAccept ?? improveProfile.autoAccept,
    limit: options.limit ?? improveProfile.limit,
  };
  let primaryStashDir: string | undefined;
  try {
    primaryStashDir = resolveSourceEntries(options.stashDir)[0]?.path;
  } catch {
    primaryStashDir = undefined;
  }

  // #339 fix: ensureIndex MUST run BEFORE collectEligibleRefs. The eligible-ref
  // query reads the `entries` table; if a DB version upgrade just dropped that
  // table (or the index is otherwise empty), the prior run order silently
  // returned plannedRefs=[] and the improve loop no-op'd. Hoisting the call
  // here repopulates the index first so the subsequent query sees fresh data.
  const preEnsureCleanupWarnings: string[] = [];
  if (primaryStashDir) {
    // Probe pre-ensureIndex entry count to drive the loud-fail warning below.
    // Best-effort: a missing DB / unreadable schema is the fresh-install case
    // and not a bug — we silently skip the probe.
    let preEnsureEntryCount: number | undefined;
    try {
      const dbPath = getDbPath();
      if (fs.existsSync(dbPath)) {
        const probeDb = openExistingDatabase();
        try {
          preEnsureEntryCount = getEntryCount(probeDb);
        } finally {
          closeDatabase(probeDb);
        }
      }
    } catch (err) {
      rethrowIfTestIsolationError(err);
      // best-effort; leave preEnsureEntryCount undefined
    }

    try {
      await ensureIndexFn(primaryStashDir);
    } catch (err) {
      preEnsureCleanupWarnings.push(`ensureIndex failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // #339 loud-fail: if the index was empty pre-ensureIndex but is now
    // populated, a version-upgrade-triggered rebuild just happened. Surface
    // that on stderr so the improve run is not silently masked by stale
    // index state. Zero-before AND zero-after is the empty-stash case and
    // is intentionally not warned (not a bug).
    if (preEnsureEntryCount === 0) {
      try {
        const probeDb = openExistingDatabase();
        let postCount = 0;
        try {
          postCount = getEntryCount(probeDb);
        } finally {
          closeDatabase(probeDb);
        }
        if (postCount > 0) {
          warn("[improve] index was empty after DB version upgrade — repopulating before continuing");
        }
      } catch (err) {
        rethrowIfTestIsolationError(err);
        // best-effort
      }
    }
  }

  const { plannedRefs, memorySummary, profileFilteredRefs } = await collectEligibleRefs(
    scope,
    options.stashDir,
    improveProfile,
  );
  const cleanupParentRef = memoryCleanupParentRef(scope, options.stashDir);

  // M-1 (#367): Run contradiction-detection BEFORE analyzeMemoryCleanup so
  // the SCC resolver in resolveFamilyContradictions has edges to work on.
  // Best-effort: failures are warnings, never fatal.
  if (primaryStashDir && shouldAnalyzeMemoryCleanup(scope, memorySummary.eligible, primaryStashDir)) {
    try {
      const config = options.config ?? loadConfig();
      await detectAndWriteContradictions(primaryStashDir, config);
    } catch (err) {
      // Non-fatal: contradiction detection is a best-effort pass.
      warn(`[improve] contradiction detection failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const memoryCleanupPlan = shouldAnalyzeMemoryCleanup(scope, memorySummary.eligible, primaryStashDir)
    ? analyzeMemoryCleanup(primaryStashDir as string, cleanupParentRef ? { parentRef: cleanupParentRef } : undefined)
    : undefined;
  const guidance =
    memorySummary.eligible > 0
      ? "Improve folds memory cleanup into the same proposal queue: speculative promotions still go through reflect/distill proposals, while high-confidence redundant derived memories are moved into a recoverable cleanup archive instead of being left active in the stash."
      : undefined;

  if (options.dryRun) {
    const result: AkmImproveResult = {
      schemaVersion: 1,
      ok: true,
      scope,
      dryRun: true,
      ...(guidance ? { guidance } : {}),
      memorySummary,
      ...(memoryCleanupPlan ? { memoryCleanup: shapeMemoryCleanup(memoryCleanupPlan) } : {}),
      plannedRefs,
      ...(profileFilteredRefs.length > 0 ? { profileFilteredRefs } : {}),
    };
    return result;
  }

  const resolvedLockPath = primaryStashDir
    ? path.join(primaryStashDir, ".akm", "improve.lock")
    : path.join(options.stashDir ?? ".", ".akm", "improve.lock");
  const MAX_LOCK_AGE_MS = 4 * 60 * 60 * 1000; // 4 hours

  fs.mkdirSync(path.dirname(resolvedLockPath), { recursive: true });

  const lockPayload = () => JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });
  const acquireLock = (): void => {
    if (tryAcquireLockSync(resolvedLockPath, lockPayload())) return;

    // Lock file already exists — probe to determine whether it's still held
    // or whether the prior run died without cleaning up.
    const probe = probeLock(resolvedLockPath, { staleAfterMs: MAX_LOCK_AGE_MS });
    const rawContent = probe.state === "absent" ? undefined : probe.rawContent;
    const lock = rawContent
      ? (() => {
          try {
            return JSON.parse(rawContent) as { pid: number; startedAt: string };
          } catch {
            return null;
          }
        })()
      : null;

    if (probe.state === "stale") {
      // O-7 / #394: Emit improve_lock_recovered event before recovery so the
      // audit trail records the abnormal prior-run exit (Temporal/Airflow pattern).
      try {
        appendEvent({
          eventType: "improve_lock_recovered",
          metadata: {
            stalePid: lock?.pid ?? null,
            lockedAt: lock?.startedAt ?? null,
            recoveredAt: new Date().toISOString(),
            lockAgeMs: probe.ageMs ?? null,
            reason: probe.reason === "pid_dead" ? "pid_not_alive" : probe.reason,
          },
        });
      } catch {
        /* event emission is best-effort; never block lock recovery */
      }
      releaseLock(resolvedLockPath);
      if (tryAcquireLockSync(resolvedLockPath, lockPayload())) return;
      throw new ConfigError(
        `akm improve is already running. Delete ${resolvedLockPath} to force.`,
        "INVALID_CONFIG_FILE",
      );
    }

    throw new ConfigError(
      `akm improve is already running (PID ${lock?.pid}, started ${lock?.startedAt}). Delete ${resolvedLockPath} to force.`,
      "INVALID_CONFIG_FILE",
    );
  };
  acquireLock();

  const budgetMs = options.timeoutMs ?? 2 * 60 * 60 * 1000; // default 2 hours
  const startMs = Date.now();

  // O-1 (#364): Create a shared AbortController derived from startMs + budgetMs.
  // Every async seam receives this signal so a hung sub-call cannot extend the
  // run past the declared budget.
  // References: Anthropic *Building Effective Agents* (2024); CoALA §5 (arXiv:2309.02427).
  const budgetAbortController = new AbortController();
  const budgetTimer = setTimeout(() => budgetAbortController.abort("improve budget exhausted"), budgetMs);
  // Clear the timer when the run ends to avoid keeping the event loop alive.
  const clearBudgetTimer = () => clearTimeout(budgetTimer);

  // I1: open a single state.db connection for the entire improve run so all
  // appendEvent calls reuse one handle instead of open/migrate/close per call.
  let eventsDb: import("bun:sqlite").Database | undefined;
  let eventsCtx: EventsContext;
  try {
    eventsDb = openStateDatabase();
    eventsCtx = { db: eventsDb };
  } catch (err) {
    rethrowIfTestIsolationError(err);
    // If we cannot open state.db up-front, fall back to per-call opens.
    eventsCtx = {};
  }

  // 2026-05-27: emit `improve_skipped` audit events for refs the planner
  // pre-filtered (reflect AND distill both refuse them under the active
  // profile). One event per ref so the existing improve_skipped histogram in
  // `health.ts#improveSummary.skipReasons` accumulates the right count under
  // the new `profile_filtered_all_passes` reason code. See
  // `/tmp/akm-health-investigations/planner-profile-metrics-deep-analysis.md`.
  for (const filtered of profileFilteredRefs) {
    appendEvent(
      {
        eventType: "improve_skipped",
        ref: filtered.ref,
        metadata: { reason: "profile_filtered_all_passes" },
      },
      eventsCtx,
    );
  }

  try {
    const preparation = await runImprovePreparationStage({
      scope,
      options,
      plannedRefs,
      memoryCleanupPlan,
      primaryStashDir,
      memorySummary,
      reindexFn,
      startMs,
      budgetMs,
      eventsCtx,
      initialCleanupWarnings: preEnsureCleanupWarnings,
      improveProfile,
    });

    // D6: pre-load all proposal_rejected events from the last 30 days once,
    // so the per-asset loop can use a Map lookup instead of N DB round trips.
    const REJECTED_PROPOSAL_WINDOW_MS = daysToMs(30);
    const rejectedProposalSince = new Date(Date.now() - REJECTED_PROPOSAL_WINDOW_MS).toISOString();
    const allRejectedProposalEvents = readEvents({ type: "proposal_rejected", since: rejectedProposalSince }).events;
    const rejectedProposalsByRef = new Map<string, EventEnvelope>();
    for (const e of allRejectedProposalEvents) {
      if (e.ref && (!rejectedProposalsByRef.has(e.ref) || e.ts > (rejectedProposalsByRef.get(e.ref)?.ts ?? ""))) {
        rejectedProposalsByRef.set(e.ref, e);
      }
    }

    const {
      reflectsWithErrorContext,
      memoryRefsForInference,
      gateAutoAcceptedCount: loopGateCount,
    } = await runImproveLoopStage({
      scope,
      options,
      primaryStashDir,
      reflectFn,
      distillFn,
      loopRefs: preparation.loopRefs,
      actions: preparation.actions,
      signalBearingSet: preparation.signalBearingSet,
      distillCooledRefs: preparation.distillCooledRefs,
      distillOnlyRefs: preparation.distillOnlyRefs,
      recentErrors: preparation.recentErrors,
      rejectedProposalsByRef,
      utilityMap: preparation.utilityMap,
      startMs,
      budgetMs,
      eventsCtx,
      improveProfile,
    });

    const {
      allWarnings,
      consolidation,
      deadUrls,
      memoryInference,
      graphExtraction,
      stalenessDetection,
      maintenanceActions,
      memoryInferenceDurationMs,
      graphExtractionDurationMs,
      orphansPurged,
      proposalsExpired,
      gateAutoAcceptedCount: postLoopGateCount,
    } = await runImprovePostLoopStage({
      scope,
      options,
      primaryStashDir,
      actionableRefs: preparation.actionableRefs,
      appliedCleanup: preparation.appliedCleanup,
      cleanupWarnings: preparation.cleanupWarnings,
      memorySummary,
      memoryRefsForInference,
      reindexFn,
      eventsCtx,
      // O-1 (#364): propagate wall-clock budget signal to post-loop maintenance.
      budgetSignal: budgetAbortController.signal,
      improveProfile,
    });

    const finalActions =
      maintenanceActions && maintenanceActions.length > 0
        ? [...preparation.actions, ...maintenanceActions]
        : preparation.actions;

    const result: AkmImproveResult = {
      schemaVersion: 1,
      ok: true,
      scope,
      dryRun: false,
      ...(guidance ? { guidance } : {}),
      memorySummary,
      ...(memoryCleanupPlan
        ? {
            memoryCleanup: {
              ...shapeMemoryCleanup(memoryCleanupPlan),
              ...(preparation.appliedCleanup
                ? {
                    archived: preparation.appliedCleanup.archived,
                    ...(preparation.appliedCleanup.transitionLogPath
                      ? { transitionLogPath: preparation.appliedCleanup.transitionLogPath }
                      : {}),
                    ...(preparation.appliedCleanup.transitionLogEntries !== undefined
                      ? { transitionLogEntries: preparation.appliedCleanup.transitionLogEntries }
                      : {}),
                    ...(allWarnings.length > 0 ? { warnings: allWarnings } : {}),
                  }
                : preparation.cleanupWarnings.length > 0
                  ? { warnings: preparation.cleanupWarnings }
                  : {}),
            },
          }
        : {}),
      plannedRefs: preparation.actionableRefs,
      ...(profileFilteredRefs.length > 0 ? { profileFilteredRefs } : {}),
      actions: finalActions,
      ...(preparation.validationFailures.length > 0 ? { validationFailures: preparation.validationFailures } : {}),
      ...(preparation.schemaRepairs.length > 0 ? { schemaRepairs: preparation.schemaRepairs } : {}),
      ...(consolidation.processed > 0 || consolidation.warnings.length > 0 ? { consolidation } : {}),
      ...(preparation.lintSummary !== undefined ? { lintSummary: preparation.lintSummary } : {}),
      ...(preparation.memoryIndexHealth !== undefined ? { memoryIndexHealth: preparation.memoryIndexHealth } : {}),
      ...(preparation.coverageGaps.length > 0 ? { coverageGaps: preparation.coverageGaps } : {}),
      ...(preparation.executionLogCandidates.length > 0
        ? { executionLogCandidates: preparation.executionLogCandidates }
        : {}),
      ...(preparation.extract && preparation.extract.length > 0 ? { extract: preparation.extract } : {}),
      ...(primaryStashDir !== undefined ? { evalCasesWritten: countEvalCases(primaryStashDir) } : {}),
      ...(deadUrls !== undefined && deadUrls.length > 0 ? { deadUrls } : {}),
      ...(reflectsWithErrorContext > 0 ? { reflectsWithErrorContext } : {}),
      ...(memoryInference ? { memoryInference } : {}),
      ...(graphExtraction ? { graphExtraction } : {}),
      // Per-phase wall-clock durations. Surfaced at the top level of the
      // envelope (not nested) because `health.ts`'s `wallTime.byPhase`
      // aggregator and the existing `memoryInference.durationMs` /
      // `graphExtraction.durationMs` health buckets all read
      // `result.{memoryInferenceDurationMs,graphExtractionDurationMs}`
      // directly. Mirrors how `consolidation.durationMs` is surfaced inside
      // the consolidation sub-object (different convention because the
      // consolidation result type already owns that field). Phases that did
      // not run (zero duration) are omitted so the aggregator's
      // "phase actually ran" filter (`> 0`) excludes them from the median/p95
      // sample. Plumbed in d1273d0's follow-up — see
      // `/tmp/akm-health-investigations/metrics-taxonomy-review.md` §1k / §3.
      ...(memoryInferenceDurationMs > 0 ? { memoryInferenceDurationMs } : {}),
      ...(graphExtractionDurationMs > 0 ? { graphExtractionDurationMs } : {}),
      ...(stalenessDetection ? { stalenessDetection } : {}),
      ...(orphansPurged !== undefined ? { orphansPurged } : {}),
      ...(proposalsExpired !== undefined && proposalsExpired > 0 ? { proposalsExpired } : {}),
      reflectCooldownActions: finalActions.filter((a) => a.mode === "reflect-cooldown").length,
      reflectSkippedActions: finalActions.filter((a) => a.mode === "reflect-skipped").length,
      reflectGuardRejectedActions: finalActions.filter((a) => a.mode === "reflect-guard-rejected").length,
      ...(() => {
        const t = preparation.gateAutoAcceptedCount + loopGateCount + postLoopGateCount;
        return t > 0 ? { gateAutoAcceptedCount: t } : {};
      })(),
    };
    if (!result.dryRun)
      emitImproveCompletedEvent(
        result,
        {
          memoryInferenceDurationMs,
          graphExtractionDurationMs,
          totalDurationMs: Date.now() - startMs,
          warningCount: allWarnings.length,
          orphansPurged: orphansPurged ?? 0,
        },
        eventsCtx,
      );
    return result;
  } catch (err) {
    // D3: emit improve_failed on unexpected crash so dashboards can detect failures.
    appendEvent(
      {
        eventType: "improve_failed",
        ref: scope.mode === "ref" ? scope.value : `improve:${scope.mode}:${scope.value ?? "all"}`,
        metadata: {
          error: err instanceof Error ? err.message : String(err),
          durationMs: Date.now() - startMs,
        },
      },
      eventsCtx,
    );
    throw err;
  } finally {
    // O-1 (#364): Clear the budget abort timer so it does not keep the event
    // loop alive after the run completes.
    clearBudgetTimer();
    try {
      fs.unlinkSync(resolvedLockPath);
    } catch {
      // ignore
    }
    // I1: close the long-lived state.db connection opened at the top of the run.
    try {
      eventsDb?.close();
    } catch {
      // ignore — DB may already be closed
    }
  }
}

function emitImproveCompletedEvent(
  result: AkmImproveResult,
  durations: {
    memoryInferenceDurationMs: number;
    graphExtractionDurationMs: number;
    totalDurationMs?: number;
    warningCount?: number;
    orphansPurged?: number;
  },
  eventsCtx?: EventsContext,
): void {
  const actionCounts = {
    reflect: 0,
    reflectFailed: 0,
    reflectCooldown: 0,
    reflectSkipped: 0,
    distill: 0,
    distillSkipped: 0,
    memoryPrune: 0,
    memoryInference: 0,
    graphExtraction: 0,
    error: 0,
  };
  for (const action of result.actions ?? []) {
    switch (action.mode) {
      case "reflect":
        actionCounts.reflect += 1;
        break;
      case "reflect-failed":
        actionCounts.reflectFailed += 1;
        break;
      case "reflect-cooldown":
        actionCounts.reflectCooldown += 1;
        break;
      case "reflect-skipped":
        actionCounts.reflectSkipped += 1;
        break;
      case "distill":
        actionCounts.distill += 1;
        break;
      case "distill-skipped":
        actionCounts.distillSkipped += 1;
        break;
      case "memory-prune":
        actionCounts.memoryPrune += 1;
        break;
      case "memory-inference":
        actionCounts.memoryInference += 1;
        break;
      case "graph-extraction":
        actionCounts.graphExtraction += 1;
        break;
      case "error":
        actionCounts.error += 1;
        break;
    }
  }

  appendEvent(
    {
      eventType: "improve_completed",
      ref:
        result.scope.mode === "ref"
          ? result.scope.value
          : `improve:${result.scope.mode}:${result.scope.value ?? "all"}`,
      metadata: {
        plannedRefs: result.plannedRefs.length,
        reflectActions: actionCounts.reflect,
        distillActions: actionCounts.distill,
        distillSkippedActions: actionCounts.distillSkipped,
        memoryPruneActions: actionCounts.memoryPrune,
        memoryInferenceActions: actionCounts.memoryInference,
        graphExtractionActions: actionCounts.graphExtraction,
        errorActions: actionCounts.error,
        reflectFailedActions: actionCounts.reflectFailed,
        reflectCooldownActions: actionCounts.reflectCooldown,
        reflectSkippedActions: actionCounts.reflectSkipped,
        reflectsWithErrorContext: result.reflectsWithErrorContext ?? 0,
        coverageGapCount: result.coverageGaps?.length ?? 0,
        executionLogCandidateCount: result.executionLogCandidates?.length ?? 0,
        evalCasesWritten: result.evalCasesWritten ?? 0,
        deadUrlCount: result.deadUrls?.length ?? 0,
        memoryEligible: result.memorySummary.eligible,
        memoryDerived: result.memorySummary.derived,
        memoryCleanupPruneCandidates: result.memoryCleanup?.pruneCandidates.length ?? 0,
        memoryCleanupContradictionCandidates: result.memoryCleanup?.contradictionCandidates.length ?? 0,
        memoryCleanupBeliefStateTransitions: result.memoryCleanup?.beliefStateTransitions.length ?? 0,
        memoryCleanupConsolidationCandidates: result.memoryCleanup?.consolidationCandidates.length ?? 0,
        memoryCleanupArchived: result.memoryCleanup?.archived?.length ?? 0,
        memoryCleanupWarnings: result.memoryCleanup?.warnings?.length ?? 0,
        consolidationProcessed: result.consolidation?.processed ?? 0,
        consolidationDurationMs: result.consolidation?.durationMs ?? 0,
        memoryInferenceWrites: result.memoryInference?.writtenFacts ?? 0,
        memoryInferenceDurationMs: durations.memoryInferenceDurationMs,
        graphExtractionExtractedFiles: result.graphExtraction?.quality.extractedFiles ?? 0,
        graphExtractionDurationMs: durations.graphExtractionDurationMs,
        // New metrics for tuning the improve loop.
        ...(durations.totalDurationMs !== undefined ? { durationMs: durations.totalDurationMs } : {}),
        ...(durations.warningCount !== undefined ? { warningCount: durations.warningCount } : {}),
        ...(durations.orphansPurged !== undefined ? { orphansPurged: durations.orphansPurged } : {}),
        ...(result.graphExtraction?.quality
          ? {
              graphCoverage: result.graphExtraction.quality.extractionCoverage,
              graphDensity: result.graphExtraction.quality.density,
              graphEntities: result.graphExtraction.quality.entityCount,
            }
          : {}),
      },
    },
    eventsCtx,
  );
}

async function runImprovePreparationStage(args: {
  scope: ImproveScope;
  options: AkmImproveOptions;
  plannedRefs: ImproveEligibleRef[];
  memoryCleanupPlan?: MemoryCleanupPlan;
  primaryStashDir?: string;
  memorySummary: { eligible: number; derived: number };
  reindexFn: (options: { stashDir: string }) => Promise<unknown>;
  startMs: number;
  budgetMs: number;
  eventsCtx?: EventsContext;
  /** Warnings accumulated in akmImprove() prior to this stage (e.g. from the hoisted ensureIndex call). */
  initialCleanupWarnings?: string[];
  /** Active improve profile, resolved from profile name + config. */
  improveProfile: import("./improve-profiles").ImproveProfileConfig;
}): Promise<ImprovePreparationResult> {
  const {
    scope,
    options,
    plannedRefs,
    memoryCleanupPlan,
    primaryStashDir,
    reindexFn,
    startMs,
    budgetMs,
    eventsCtx,
    initialCleanupWarnings,
    // improveProfile is part of the preparation-stage signature for future use
    // (per-process gating moved into the in-loop stage). Kept here so the
    // signature does not drift away from the rest of the planner stack.
    improveProfile: _improveProfile,
  } = args;

  const actions: ImproveActionResult[] = [];
  const cleanupWarnings: string[] = initialCleanupWarnings ? [...initialCleanupWarnings] : [];

  // Phase 0 — MEMORY.md budget check (200-line cap; warn at 180)
  let memoryIndexHealth: { lineCount: number; overBudget: boolean } | undefined;
  if (primaryStashDir) {
    const memoryMdPath = path.join(primaryStashDir, "memories", "MEMORY.md");
    if (fs.existsSync(memoryMdPath)) {
      try {
        const lines = fs.readFileSync(memoryMdPath, "utf8").split("\n").length;
        const overBudget = lines >= 180;
        memoryIndexHealth = { lineCount: lines, overBudget };
        if (overBudget) {
          cleanupWarnings.push(`MEMORY.md has ${lines} lines (budget: 200). Consolidation strongly recommended.`);
        }
      } catch {
        // best-effort
      }
    }
  }

  // Phase 0 — execution log synthesis
  let executionLogCandidates: string[] = [];
  try {
    const logEntries = getExecutionLogCandidates(7);
    executionLogCandidates = logEntries.filter((e) => e.isFailurePattern).map((e) => e.topic);
  } catch {
    // best-effort
  }

  // Phase 0.4 — session-extract pass.
  //
  // Reads native session files (claude-code JSONL, opencode storage tree)
  // through the SessionLogHarness registry, pre-filters noise, and asks a
  // bounded in-tree LLM to produce candidate memory/lesson/knowledge
  // proposals for content the agent did NOT preserve via inline `akm remember`
  // / `akm feedback` invocations. Replaces the akm-plugin session-checkpoint
  // hook with an on-demand pull pipeline.
  //
  // Default-on; opt out via `profiles.improve.default.processes.extract.enabled: false`.
  // Each available harness gets one call with the default --since window;
  // already-seen sessions (tracked in state.db.extract_sessions_seen) are
  // skipped automatically so re-runs don't burn LLM calls on unchanged data.
  //
  // Failures are non-fatal — one harness throwing doesn't abort improve.
  // The extract envelope's own `warnings` field surfaces what went wrong.
  let extractResults: AkmExtractResult[] | undefined;
  let gateAutoAcceptedCount = 0;
  const extractConfig = options.config ?? loadConfig();
  const extractGateCfg = makeGateConfig("extract", {
    globalThreshold: options.autoAccept,
    dryRun: options.dryRun ?? false,
    stashDir: primaryStashDir,
    config: extractConfig,
    eventsCtx,
  });
  if (isLlmFeatureEnabled(extractConfig, "session_extraction")) {
    const availableHarnesses = getAvailableHarnesses();
    if (availableHarnesses.length > 0) {
      extractResults = [];
      for (const h of availableHarnesses) {
        try {
          const result = await akmExtract({
            type: h.name,
            ...(primaryStashDir !== undefined ? { stashDir: primaryStashDir } : {}),
            config: extractConfig,
            dryRun: options.dryRun ?? false,
          });
          extractResults.push(result);

          gateAutoAcceptedCount += (
            await runAutoAcceptGate(
              primaryStashDir
                ? result.proposals.map((proposalId) => {
                    const proposal = getProposal(primaryStashDir, proposalId);
                    return { proposalId, confidence: resolveExtractConfidence(proposal) };
                  })
                : [],
              extractGateCfg,
            )
          ).promoted.length;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          cleanupWarnings.push(`extract(${h.name}) failed: ${msg}`);
        }
      }
      if (extractResults.length === 0) {
        // All harnesses threw — clear so the envelope's `extract` field is
        // absent rather than misleadingly empty.
        extractResults = undefined;
      }
    }
  }

  // Backlog drain: gate any pending extract proposals that weren't created in
  // this run (i.e. pre-date the gate or were produced by a run that timed out
  // before the gate fired). Without this, eligible proposals accumulate
  // indefinitely — the fresh-gate only covers the current run's output.
  if (primaryStashDir && !options.dryRun && options.autoAccept !== undefined) {
    const freshIds = new Set((extractResults ?? []).flatMap((r) => r.proposals));
    const backlog = listProposals(primaryStashDir, { status: "pending" }).filter(
      (p) => p.source === "extract" && !freshIds.has(p.id),
    );
    if (backlog.length > 0) {
      const backlogCandidates = backlog.map((p) => ({
        proposalId: p.id,
        confidence: resolveExtractConfidence(p),
      }));
      gateAutoAcceptedCount += (await runAutoAcceptGate(backlogCandidates, extractGateCfg)).promoted.length;
    }
  }

  // eligibleCount = raw pre-filter count (before cooldown/signal/cleanup filters).
  // improve_completed.plannedRefs = post-filter count of refs that actually entered the loop.
  appendEvent(
    {
      eventType: "improve_invoked",
      ref: scope.mode === "ref" ? scope.value : `improve:${scope.mode}:${scope.value ?? "all"}`,
      metadata: { scope, dryRun: options.dryRun ?? false, eligibleCount: plannedRefs.length },
    },
    eventsCtx,
  );

  // ensureIndex now runs in akmImprove() BEFORE collectEligibleRefs so the
  // eligible-ref query sees a populated `entries` table on the very first
  // pass after a DB version upgrade (#339). Any failure messages from that
  // earlier call were threaded in via args.initialCleanupWarnings.

  let appliedCleanup: Awaited<ReturnType<typeof applyMemoryCleanup>> | undefined;
  try {
    appliedCleanup =
      primaryStashDir && memoryCleanupPlan ? applyMemoryCleanup(primaryStashDir, memoryCleanupPlan) : undefined;
  } catch (err) {
    cleanupWarnings.push(`applyMemoryCleanup failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const archivedRefs = appliedCleanup?.archived.map((record) => record.ref) ?? [];
  const removed = new Set(archivedRefs);
  const postCleanupRefs = archivedRefs.length === 0 ? plannedRefs : plannedRefs.filter((r) => !removed.has(r.ref));

  // ── Phase 1: validation pass + schema repair (run on full postCleanupRefs) ──
  // Identifies refs whose on-disk asset has structural problems. Validation
  // failures are excluded from every downstream bucket. Run early so the
  // cooldown partition operates on a clean set.
  if (appliedCleanup) {
    for (const candidate of memoryCleanupPlan?.pruneCandidates ?? []) {
      const archived = appliedCleanup.archived.find((record) => record.ref === candidate.ref);
      if (!archived) continue;
      actions.push({
        ref: candidate.ref,
        mode: "memory-prune",
        result: { ok: true, pruned: true, reason: candidate.reason },
      });
    }
    if ((appliedCleanup.archived.length > 0 || appliedCleanup.beliefStateTransitions.length > 0) && primaryStashDir) {
      try {
        await reindexFn({ stashDir: primaryStashDir });
      } catch (err) {
        cleanupWarnings.push(`reindex after cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  const validationFailures: Array<{ ref: string; reason: string }> = [];
  for (const candidate of postCleanupRefs) {
    try {
      const filePath = await findAssetFilePath(candidate.ref, options.stashDir);
      if (!filePath) {
        validationFailures.push({ ref: candidate.ref, reason: "file not found on disk" });
        continue;
      }
      if (path.extname(filePath).toLowerCase() !== ".md") {
        continue;
      }
      if (isLessonCandidate(candidate.ref)) {
        const raw = fs.readFileSync(filePath, "utf8");
        const fm = parseFrontmatter(raw).data;
        if (!fm.description) validationFailures.push({ ref: candidate.ref, reason: "missing description" });
      }
    } catch (e) {
      validationFailures.push({ ref: candidate.ref, reason: String(e) });
    }
  }
  if (validationFailures.length > 0) {
    info(`[improve] ${validationFailures.length} assets have validation issues (will attempt schema repair):`);
    for (const f of validationFailures) info(`  ${f.ref}: ${f.reason}`);
  }

  let schemaRepairs: ImprovePreparationResult["schemaRepairs"] = [];
  let repairedRefs = new Set<string>();

  // Schema repair pass: attempt to fix validation failures via LLM before skipping.
  if (validationFailures.length > 0 && options.repairValidationFailures !== false) {
    const baseConfigForRepair = options.config ?? loadConfig();
    const llmCfg = getDefaultLlmConfig(baseConfigForRepair);
    if (llmCfg) {
      const result = await runSchemaRepairPass(validationFailures, {
        startMs,
        budgetMs,
        llmConfig: llmCfg,
        stashDir: options.stashDir,
        findFilePath: findAssetFilePath,
        isLessonCandidateFn: isLessonCandidate,
      });
      schemaRepairs = result.repairs;
      repairedRefs = result.repairedRefs;
    }
  }

  const validationFailureRefs = new Set(validationFailures.filter((f) => !repairedRefs.has(f.ref)).map((f) => f.ref));
  if (repairedRefs.size > 0) {
    info(
      `[improve] schema repair fixed ${repairedRefs.size}/${validationFailures.length} validation failures; ${validationFailureRefs.size} remain`,
    );
  }

  // Phase 0.5 — structural hygiene pass
  let lintSummary: { fixed: number; flagged: number } | undefined;
  if (primaryStashDir) {
    try {
      const lintResult = akmLint({ fix: true, dir: primaryStashDir });
      lintSummary = { fixed: lintResult.summary.fixed, flagged: lintResult.summary.flagged };
    } catch {
      // lint is best-effort; never block improve
    }
  }

  // O-5 / #378: Per-originator rolling error windows.
  // Reflexion (arXiv:2303.11366) warns that cross-task verbal critique
  // contamination degrades below single-shot baseline. Each originator key
  // ("schema-repair", "reflect") maintains its own rolling window so that
  // schema-repair failures are not injected as avoidPatterns into reflect calls.
  const recentErrors: Record<string, string[]> = {};
  const RECENT_ERRORS_CAP = 3;

  // Helper: push an error onto an originator's rolling window.
  function pushRecentError(originator: string, msg: string): void {
    if (!recentErrors[originator]) recentErrors[originator] = [];
    recentErrors[originator].push(msg);
    if (recentErrors[originator].length > RECENT_ERRORS_CAP) recentErrors[originator].shift();
  }

  // Seed schema-repair originator window from any schema-repair errors.
  for (const repair of schemaRepairs) {
    if (repair.outcome === "error") {
      const errMsg = repair.error ?? `schema repair error: ${repair.reason}`;
      pushRecentError("schema-repair", errMsg);
    }
  }

  // ── Phase 2: signal-delta eligibility sets built EARLY ────────────────────
  // 0.8.0 replaces the flat time-based cooldowns (which produced synchronised
  // waves whenever many refs cooled at the same instant — see the 2026-05-26
  // 54-ref simultaneous-reflect incident) with a *signal-delta* gate:
  //
  //   reflectEligible(ref) ≡ latestFeedbackTs(ref) > lastReflectProposalTs(ref)
  //   distillEligible(ref) ≡ latestFeedbackTs(ref) > lastDistillProposalTs(ref)
  //
  // i.e. a ref is re-eligible iff new feedback has landed since the last
  // proposal was generated for it. Stable content with no new signal stays
  // out of the queue regardless of clock time; a sudden burst of feedback
  // surfaces only the refs that the burst actually touches.
  //
  // The 30-day FEEDBACK_SIGNAL_WINDOW_DAYS bound still applies — only feedback
  // events newer than that count as "current signal". Ancient one-off
  // negatives don't permanently lock a ref into every run.
  //
  // High-retrieval refs (P0-A path) use a simpler "eligible once" rule: a
  // ref with no feedback signal but retrievalCount ≥ threshold is eligible
  // exactly once (no prior reflect proposal). Subsequent re-eligibility for
  // those refs requires either a new feedback event (then the normal
  // signal-delta gate applies) or human action. Documented limitation: this
  // path does not re-fire on retrieval-count growth alone in 0.8.0; storing
  // the retrieval count in proposal metadata for proper delta-tracking is
  // captured as future work.
  const FEEDBACK_SIGNAL_WINDOW_DAYS = 30;
  const feedbackSinceCutoff = new Date(Date.now() - daysToMs(FEEDBACK_SIGNAL_WINDOW_DAYS)).toISOString();

  // Build the three timestamp maps once across the entire postCleanupRefs set.
  // Per-ref queries would be N+1 and the planner is already the hottest path
  // in `akm improve`.
  const candidateRefs = postCleanupRefs.filter((r) => !validationFailureRefs.has(r.ref)).map((r) => r.ref);
  const latestFeedbackTs = buildLatestFeedbackTsMap(candidateRefs, feedbackSinceCutoff);
  const lastReflectProposalTs = buildLatestProposalTsMap(candidateRefs, "reflect");
  const lastDistillProposalTs = buildLatestProposalTsMap(candidateRefs, "distill");

  // Refs the distill signal-delta gate rejected at planning time. The main
  // loop reads this to skip distill for these refs without re-checking
  // eligibility per iteration.
  const distillCooledRefs = new Set<string>();
  const preCooldownCount = postCleanupRefs.length;

  // ── Phase 3: partition postCleanupRefs by signal-delta eligibility ────────
  // Three buckets (validation failures are excluded entirely):
  //   eligibleRefs        — reflect signal-delta passes (full reflect+distill
  //                         loop path; distill guard remains in the loop for
  //                         refs that fail the distill signal-delta gate).
  //   distillOnlyRefs     — reflect blocked but distill signal-delta passes
  //                         AND ref is a distill candidate.
  //   fullySkippedCount   — neither gate passes → synthetic skip action
  //                         + improve_skipped event, excluded from sort.
  const eligibleRefs: ImproveEligibleRef[] = [];
  const distillOnlyRefs: ImproveEligibleRef[] = [];
  let fullySkippedCount = 0;

  // O-2 (#365): explicit --scope <ref> bypasses every gate (user intent wins).
  const scopeRefBypass = scope.mode === "ref";

  for (const r of postCleanupRefs) {
    if (validationFailureRefs.has(r.ref)) continue;

    if (scopeRefBypass) {
      eligibleRefs.push(r);
      continue;
    }

    const reflectOk = isSignalDeltaEligible(r.ref, latestFeedbackTs, lastReflectProposalTs);
    const distillOk = isSignalDeltaEligible(r.ref, latestFeedbackTs, lastDistillProposalTs);
    const isDistillCandidate = isDistillCandidateRef(r.ref, options.stashDir);

    if (reflectOk) {
      if (!distillOk && isDistillCandidate) {
        // Reflect passes the gate, distill does not — emit the synthetic
        // distill-skipped action and event up-front so the in-loop guard
        // does not have to re-derive eligibility.
        distillCooledRefs.add(r.ref);
        actions.push({ ref: r.ref, mode: "distill-skipped", result: { ok: true, reason: "distill signal-delta" } });
        appendEvent(
          {
            eventType: "improve_skipped",
            ref: r.ref,
            metadata: { reason: "distill_no_new_signal" },
          },
          eventsCtx,
        );
      } else if (!distillOk) {
        // Not a distill candidate AND distill gate doesn't pass — just mark
        // distillCooled so the loop's distill section is a no-op.
        distillCooledRefs.add(r.ref);
      }
      eligibleRefs.push(r);
    } else if (distillOk && isDistillCandidate) {
      // Reflect blocked but distill passes → distill-only bucket.
      distillOnlyRefs.push(r);
    } else {
      // Neither gate passes — fully skipped.
      fullySkippedCount++;
      actions.push({
        ref: r.ref,
        mode: "distill-skipped",
        result: { ok: true, reason: "no new signal since last proposal" },
      });
      appendEvent({ eventType: "improve_skipped", ref: r.ref, metadata: { reason: "no_new_signal" } }, eventsCtx);
    }
  }

  // ── Phase 4: signal/feedback/utility/sort on the reduced set ──────────────
  // Everything from here works only on (eligibleRefs ∪ distillOnlyRefs). The
  // fully-skipped bucket has already been routed and emitted; we deliberately
  // avoid spending DB/CPU on refs that cannot enter the loop.
  const processableRefs: ImproveEligibleRef[] = [...eligibleRefs, ...distillOnlyRefs];

  // Gap 6: only surface feedback signals from the last 30 days so that
  // ancient one-off feedback events don't permanently lock an asset into
  // every improve run. Assets with only stale signals fall through to the
  // high-retrieval path (P0-A) or are skipped until new signals arrive.
  // (FEEDBACK_SIGNAL_WINDOW_DAYS / feedbackSinceCutoff are already defined in
  // Phase 2 above for the signal-delta gate; we reuse them here.)

  // Pre-compute feedback summary per ref in a single pass so we don't issue
  // two readEvents({type:"feedback", ref}) per asset (one for signal filtering,
  // one for ratio computation).
  const feedbackSummary = new Map<string, { hasSignal: boolean; positive: number; negative: number }>();
  for (const candidate of processableRefs) {
    const { events } = readEvents({ type: "feedback", ref: candidate.ref });
    let hasSignal = false;
    let positive = 0;
    let negative = 0;
    for (const e of events) {
      if (
        !hasSignal &&
        (e.ts ?? "") >= feedbackSinceCutoff &&
        e.metadata !== undefined &&
        (typeof e.metadata.signal === "string" || typeof e.metadata.note === "string")
      ) {
        hasSignal = true;
      }
      if (e.metadata?.signal === "positive") positive++;
      else if (e.metadata?.signal === "negative") negative++;
    }
    feedbackSummary.set(candidate.ref, { hasSignal, positive, negative });
  }

  const signalFiltered = processableRefs.filter((candidate) => feedbackSummary.get(candidate.ref)?.hasSignal === true);

  // P0-A: also surface zero-feedback assets that have been retrieved many times.
  const RETRIEVAL_COUNT_THRESHOLD = options.minRetrievalCount ?? 5;

  const signalBearingSet = new Set(signalFiltered.map((r) => r.ref));
  const noFeedbackCandidates = processableRefs.filter((r) => !signalBearingSet.has(r.ref));

  let highRetrievalRefs: ImproveEligibleRef[] = [];
  let dbForRetrieval: import("bun:sqlite").Database | undefined;
  try {
    dbForRetrieval = openExistingDatabase();
    const showEventCount = (
      dbForRetrieval.prepare("SELECT COUNT(*) AS cnt FROM usage_events WHERE event_type = 'show'").get() as {
        cnt: number;
      }
    ).cnt;
    if (showEventCount === 0) {
      warn(
        "Warning: show events not yet in usage_events — zero-feedback fallback will match only search-retrieved assets.",
      );
    }
    const retrievalCounts = getRetrievalCounts(
      dbForRetrieval,
      noFeedbackCandidates.map((r) => r.ref),
    );
    // High-retrieval signal-delta (simplified rule, 0.8.0): a no-feedback
    // ref qualifies exactly once — when retrievalCount ≥ threshold AND no
    // prior reflect proposal exists for it. Once a reflect proposal is on
    // record, subsequent re-eligibility requires explicit feedback (which
    // flows through the normal signal-delta gate above). Tracking growth in
    // retrieval count would require persisting the count in proposal
    // metadata; deferred to a follow-up.
    highRetrievalRefs = noFeedbackCandidates.filter(
      (r) => (retrievalCounts.get(r.ref) ?? 0) >= RETRIEVAL_COUNT_THRESHOLD && !lastReflectProposalTs.has(r.ref),
    );
  } catch (err) {
    rethrowIfTestIsolationError(err);
    // best-effort: if DB unavailable, highRetrievalRefs stays empty
  } finally {
    if (dbForRetrieval) closeDatabase(dbForRetrieval);
  }

  // If the user explicitly scoped to a single ref, always act on it —
  // skip the signal/retrieval filter entirely. The filter exists to avoid
  // noisy "improve everything" runs; it should not gate an intentional
  // per-ref invocation where the user's explicit choice is the signal.
  //
  // For type/all scope: only process refs with usage signals (recent feedback
  // or sufficient retrievals). A stash with no signals has 0 eligible refs —
  // usage is the gate. Run `akm feedback <ref> --positive` or retrieve assets
  // to bring them into the eligible pool.
  const signalAndRetrievalRefs = [...signalFiltered, ...highRetrievalRefs];
  const mergedRefs =
    scope.mode === "ref" ? processableRefs : options.requireFeedbackSignal ? signalFiltered : signalAndRetrievalRefs;

  const utilityMap = buildUtilityMap(mergedRefs);

  // Load feedback ratio per ref from the pre-computed summary (no extra DB pass).
  const feedbackRatios = new Map<string, number>();
  for (const ref of mergedRefs) {
    const summary = feedbackSummary.get(ref.ref);
    const positive = summary?.positive ?? 0;
    const negative = summary?.negative ?? 0;
    const total = positive + negative;
    // ratio = negative proportion (high = needs more improvement)
    feedbackRatios.set(ref.ref, total > 0 ? negative / total : 0);
  }

  // Sort: combine utility (desc) with feedback negativity (desc) — high-negative assets rank higher
  const sorted = [...mergedRefs].sort((a, b) => {
    const utilA = utilityMap.get(a.ref) ?? 0;
    const utilB = utilityMap.get(b.ref) ?? 0;
    const ratioA = feedbackRatios.get(a.ref) ?? 0;
    const ratioB = feedbackRatios.get(b.ref) ?? 0;
    // Combined score: 70% utility, 30% negative ratio
    const scoreA = utilA * 0.7 + ratioA * 0.3;
    const scoreB = utilB * 0.7 + ratioB * 0.3;
    return scoreB - scoreA;
  });

  // Phase 0: surface coverage gaps from zero-result search queries
  let coverageGaps: string[] = [];
  try {
    const dbForGaps = openExistingDatabase();
    try {
      coverageGaps = getZeroResultSearches(dbForGaps);
    } finally {
      closeDatabase(dbForGaps);
    }
  } catch (err) {
    rethrowIfTestIsolationError(err);
    // best-effort
  }

  // actionableRefs is the post-cooldown, post-validation, post-signal, post-sort
  // set — i.e. the genuinely processable refs in priority order. Note: this is
  // a semantic shift from earlier code where actionableRefs was the pre-cooldown
  // sorted set; the new meaning matches reality and is documented on
  // ImprovePreparationResult.actionableRefs.
  //
  // Final guard: drop any candidate whose backing file is no longer on disk.
  // Phase 1 validation captures missing files at the start of preparation, but
  // the gap between that check and dispatch can be minutes on large stashes —
  // long enough for a checkpoint / git checkout / external cleanup to delete
  // the asset. Empirically (improve-critical-review 2026-05-20) the single
  // biggest reject category was "Asset no longer exists on disk" (604/1407 =
  // 43%), meaning reflect/distill was producing proposals against deleted refs.
  // A cheap existsSync per surviving candidate eliminates that wasted work.
  const assetMissingOnDisk: string[] = [];
  const existsCheckedActionable: ImproveEligibleRef[] = [];
  for (const candidate of sorted) {
    const filePath = await findAssetFilePath(candidate.ref, options.stashDir);
    if (filePath && fs.existsSync(filePath)) {
      existsCheckedActionable.push(candidate);
    } else {
      assetMissingOnDisk.push(candidate.ref);
      appendEvent(
        { eventType: "improve_skipped", ref: candidate.ref, metadata: { reason: "asset_missing_on_disk" } },
        eventsCtx,
      );
    }
  }
  const actionableRefs = existsCheckedActionable;

  // Re-split actionableRefs (sorted) into reflect-path vs distill-only-path while
  // preserving sort order. distillOnlyRefs participate in the sort so --limit
  // picks them by score, not by arbitrary position.
  const distillOnlyRefSetForSort = new Set(distillOnlyRefs.map((r) => r.ref));
  const reflectAndDistillRefsAfterSort: ImproveEligibleRef[] = [];
  const distillOnlyRefsAfterSort: ImproveEligibleRef[] = [];
  for (const r of actionableRefs) {
    if (distillOnlyRefSetForSort.has(r.ref)) {
      distillOnlyRefsAfterSort.push(r);
    } else {
      reflectAndDistillRefsAfterSort.push(r);
    }
  }

  // ── Phase 5: --limit applies to the post-cooldown actionable set ──────────
  const allLoopRefs = [...reflectAndDistillRefsAfterSort, ...distillOnlyRefsAfterSort];
  const loopRefs = options.limit ? allLoopRefs.slice(0, options.limit) : allLoopRefs;

  // Update the returned distillOnlyRefs to the sorted order so callers see the
  // ranked view (loop stage uses it as a Set so order is irrelevant, but the
  // shape change keeps downstream consumers consistent).
  const distillOnlyRefsResult = distillOnlyRefsAfterSort;

  const totalReflectBlocked = fullySkippedCount + distillOnlyRefs.length;
  if (totalReflectBlocked > 0) {
    info(
      `[improve] ${totalReflectBlocked} of ${preCooldownCount} indexed refs blocked by reflect signal-delta ` +
        `(${fullySkippedCount} fully skipped, ${distillOnlyRefs.length} routed to distill-only)`,
    );
  }
  if (signalAndRetrievalRefs.length > 0) {
    info(
      `[improve] ${signalAndRetrievalRefs.length} refs with usage signals (${signalFiltered.length} feedback, ${highRetrievalRefs.length} high-retrieval)`,
    );
  }
  if (validationFailureRefs.size > 0) {
    info(`[improve] ${validationFailureRefs.size} with validation failures excluded`);
  }
  if (assetMissingOnDisk.length > 0) {
    info(`[improve] ${assetMissingOnDisk.length} candidates dropped — file not on disk`);
  }
  const deferredCount = actionableRefs.length - loopRefs.length;
  info(
    `[improve] ${actionableRefs.length} actionable; ${loopRefs.length} will be processed` +
      (options.limit && deferredCount > 0 ? ` (--limit ${options.limit} applied; ${deferredCount} deferred)` : ""),
  );

  return {
    actions,
    cleanupWarnings,
    appliedCleanup,
    memoryIndexHealth,
    executionLogCandidates,
    extract: extractResults,
    actionableRefs,
    signalBearingSet,
    validationFailures,
    schemaRepairs,
    lintSummary,
    loopRefs,
    distillCooledRefs,
    distillOnlyRefs: distillOnlyRefsResult,
    coverageGaps,
    recentErrors,
    utilityMap,
    gateAutoAcceptedCount,
  };
}

// TODO(refactor): 13 args including `actions`/`recentErrors` mutation channels. Restructure into immutable plan + mutable context objects — deferred to dedicated refactor with isolated testing.
async function runImproveLoopStage(args: {
  scope: ImproveScope;
  options: AkmImproveOptions;
  primaryStashDir?: string;
  reflectFn: (options: NonNullable<Parameters<typeof akmReflect>[0]>) => Promise<AkmReflectResult>;
  distillFn: (options: NonNullable<Parameters<typeof akmDistill>[0]>) => Promise<AkmDistillResult>;
  loopRefs: ImproveEligibleRef[];
  actions: ImproveActionResult[];
  signalBearingSet: Set<string>;
  distillCooledRefs: Set<string>;
  /** Refs that should only run the distill path (reflect-cooled but distill expired, Bug D2). */
  distillOnlyRefs: ImproveEligibleRef[];
  /** Per-originator rolling error windows (O-5 / #378). */
  recentErrors: Record<string, string[]>;
  /** D6: pre-loaded map of most-recent proposal_rejected event per ref (last 30d). */
  rejectedProposalsByRef: Map<string, EventEnvelope>;
  /** R-2 / #389: per-ref utility scores for self-consistency threshold check. */
  utilityMap: Map<string, number>;
  startMs: number;
  budgetMs: number;
  eventsCtx?: EventsContext;
  /** Active improve profile, resolved from profile name + config. */
  improveProfile: import("./improve-profiles").ImproveProfileConfig;
}): Promise<ImproveLoopResult> {
  const {
    scope,
    options,
    primaryStashDir,
    reflectFn,
    distillFn,
    loopRefs,
    actions,
    signalBearingSet,
    distillCooledRefs,
    distillOnlyRefs,
    recentErrors,
    rejectedProposalsByRef,
    utilityMap,
    startMs,
    budgetMs,
    eventsCtx,
    improveProfile,
  } = args;

  // O-1 (#364): compute remaining budget at call time so each sub-call
  // receives only its fair share of the wall-clock budget.
  const remainingBudgetMs = () => Math.max(0, budgetMs - (Date.now() - startMs));

  const RECENT_ERRORS_CAP = 3;

  // R-2 / #389: Self-Consistency multi-sample voting helpers.
  // Wang et al. arXiv:2203.11171 — N=3 samples beat single-shot on reasoning tasks.
  const SC_THRESHOLD = options.selfConsistencyThreshold ?? 0.7;
  const SC_N = Math.min(Math.max(2, options.selfConsistencyN ?? 3), 5);

  /**
   * Compute Jaccard token overlap between two strings.
   * Tokenizes by whitespace; returns 0 when both are empty.
   */
  function jaccardSimilarity(a: string, b: string): number {
    const tokensA = new Set(a.split(/\s+/).filter(Boolean));
    const tokensB = new Set(b.split(/\s+/).filter(Boolean));
    if (tokensA.size === 0 && tokensB.size === 0) return 1;
    let intersection = 0;
    for (const t of tokensA) {
      if (tokensB.has(t)) intersection++;
    }
    const union = tokensA.size + tokensB.size - intersection;
    return union > 0 ? intersection / union : 0;
  }

  /**
   * Given N reflect results, return the one with the highest average Jaccard
   * similarity to all other successful results (majority-vote winner).
   * Falls back to the first successful result when N < 2.
   */
  function pickMajorityVote(results: AkmReflectResult[]): AkmReflectResult {
    const successful = results.filter((r): r is Extract<AkmReflectResult, { ok: true }> => r.ok);
    if (successful.length === 0)
      return (
        results[0] ?? {
          schemaVersion: 1,
          ok: false,
          reason: "non_zero_exit",
          error: "all samples failed",
          exitCode: null,
        }
      );
    if (successful.length === 1) return successful[0];
    let bestIdx = 0;
    let bestScore = -1;
    for (let i = 0; i < successful.length; i++) {
      let totalSim = 0;
      for (let j = 0; j < successful.length; j++) {
        if (i === j) continue;
        totalSim += jaccardSimilarity(
          successful[i].proposal.payload.content ?? "",
          successful[j].proposal.payload.content ?? "",
        );
      }
      const avgSim = totalSim / (successful.length - 1);
      if (avgSim > bestScore) {
        bestScore = avgSim;
        bestIdx = i;
      }
    }
    return successful[bestIdx] ?? successful[0];
  }

  // O-5 / #378: helper to push per-originator errors into the rolling window.
  function pushRecentError(originator: string, msg: string): void {
    if (!recentErrors[originator]) recentErrors[originator] = [];
    recentErrors[originator].push(msg);
    if (recentErrors[originator].length > RECENT_ERRORS_CAP) recentErrors[originator].shift();
  }
  // Build a Set for O(1) membership test — these refs skip the reflect call (Bug D2).
  const distillOnlyRefSet = new Set(distillOnlyRefs.map((r) => r.ref));
  let completedCount = 0;
  let reflectsWithErrorContext = 0;
  const memoryRefsForInference = new Set<string>();

  // Pre-load all pending proposals once instead of querying per asset in the loop.
  const dedupeStashDirForProposals = primaryStashDir ?? options.stashDir;
  const pendingProposalRefSet = new Set<string>(
    dedupeStashDirForProposals
      ? listProposals(dedupeStashDirForProposals, { status: "pending" }).map((p) => p.ref)
      : [],
  );

  let gateAutoAcceptedCount = 0;
  const reflectGateCfg = makeGateConfig("reflect", {
    globalThreshold: options.autoAccept,
    dryRun: options.dryRun ?? false,
    stashDir: primaryStashDir,
    config: options.config ?? loadConfig(),
    eventsCtx,
  });

  const distillGateCfg = makeGateConfig("distill", {
    globalThreshold: options.autoAccept,
    dryRun: options.dryRun ?? false,
    stashDir: primaryStashDir,
    config: options.config ?? loadConfig(),
    eventsCtx,
  });

  for (const planned of loopRefs) {
    if (Date.now() - startMs >= budgetMs) {
      const remaining = loopRefs.length - completedCount;
      info(
        `[improve] budget exhausted after ${Math.round((Date.now() - startMs) / 60000)}min — ${remaining} assets skipped`,
      );
      appendEvent(
        {
          eventType: "improve_skipped",
          ref: planned.ref,
          metadata: {
            reason: "budget_exhausted",
            remaining,
          },
        },
        eventsCtx,
      );
      // B11: Emit improve_skipped for all remaining assets that will not be processed.
      for (const remainingRef of loopRefs.slice(completedCount + 1)) {
        appendEvent(
          {
            eventType: "improve_skipped",
            ref: remainingRef.ref,
            metadata: { reason: "budget_exhausted_batch", remaining: loopRefs.length - completedCount - 1 },
          },
          eventsCtx,
        );
      }
      actions.push({
        ref: planned.ref,
        mode: "error",
        result: { ok: false, error: "timeout: improve wall-clock budget exhausted" },
      });
      break;
    }
    try {
      // Bug D2: distillOnlyRefs skip the reflect call but still run the distill path.
      // Bug D1: in-loop distill-cooldown check removed — distill-cooled candidates
      //         have their synthetic actions emitted in runImprovePreparationStage.
      const isDistillOnly = distillOnlyRefSet.has(planned.ref);

      const parsedPlannedRef = parseAssetRef(planned.ref);
      // B6: derived memories are machine-generated; skip reflect to avoid noisy proposals.
      // shouldDistillMemoryRef already returns false for .derived refs, so the distill
      // path is also a no-op for them — we just avoid unnecessary agent spawns.
      // D2: distillOnlyRefs also skip the reflect call (reflect-cooled, distill path only).
      if (!isDistillOnly && !planned.ref.endsWith(".derived")) {
        // Type guard: skip reflect for unsupported types (script, vault, task, etc.)
        // and raw wiki directories, driven by the active improve profile.
        const reflectSkip = shouldSkipRef(planned.ref, "reflect", improveProfile);
        if (reflectSkip.skip) {
          actions.push({
            ref: planned.ref,
            mode: "reflect-skipped",
            result: { ok: true, reason: reflectSkip.reason },
          });
        } else {
          // O-5 / #378: only inject reflect-originator errors into the reflect call.
          // Cross-task errors (e.g. schema-repair) must NOT contaminate reflect prompts.
          const reflectErrors = recentErrors.reflect ?? [];
          if (reflectErrors.length > 0) reflectsWithErrorContext++;
          // O-1 (#364): pass remaining budget as timeoutMs so the agent spawn is
          // bounded by the wall-clock deadline rather than the default per-profile timeout.
          const reflectBudgetMs = remainingBudgetMs();
          // Wire profile.processes.reflect.{mode, profile, timeoutMs} into the reflect
          // dispatch when present. Falls back to akmReflect's own config-based resolution
          // (profiles.improve.<name>.processes.reflect → defaults.llm) when the profile
          // does not specify.
          const reflectProfileRunner = resolveImproveProcessRunnerFromProfile(
            improveProfile.processes?.reflect,
            options.config ?? loadConfig(),
          );
          const reflectCallArgs = {
            ref: planned.ref,
            task: options.task,
            ...(options.stashDir ? { stashDir: options.stashDir } : {}),
            ...(reflectErrors.length > 0 ? { avoidPatterns: [...reflectErrors] } : {}),
            agentProcess: options.agentProcess ?? "reflect",
            eventSource: "improve" as const,
            ...(reflectBudgetMs > 0 ? { timeoutMs: reflectBudgetMs } : {}),
            ...(reflectProfileRunner ? { runner: reflectProfileRunner } : {}),
          };
          // R-2 / #389: Self-consistency multi-sample voting for high-utility refs.
          // Self-Consistency arXiv:2203.11171 — N=3 samples beat single-shot quality.
          const refUtility = utilityMap.get(planned.ref) ?? 0;
          const useConsistency = refUtility >= SC_THRESHOLD && SC_N >= 2;
          let reflectResult: AkmReflectResult;
          if (useConsistency) {
            const samples: AkmReflectResult[] = [];
            for (let s = 0; s < SC_N; s++) {
              if (remainingBudgetMs() <= 0) break;
              // draftMode: skip DB write so each sample doesn't create a proposal.
              samples.push(await reflectFn({ ...reflectCallArgs, draftMode: true }));
            }
            const winner = pickMajorityVote(
              samples.length > 0 ? samples : [await reflectFn({ ...reflectCallArgs, draftMode: true })],
            );
            // Persist only the majority-vote winner as a single real proposal.
            if (winner.ok && primaryStashDir) {
              const persistResult = createProposal(primaryStashDir, {
                ref: winner.proposal.ref,
                source: "reflect",
                sourceRun: `reflect-sc-${Date.now()}`,
                payload: winner.proposal.payload,
              });
              reflectResult = isProposalSkipped(persistResult)
                ? {
                    schemaVersion: 1,
                    ok: false,
                    reason: "cooldown" as const,
                    error: `SC proposal skipped: ${persistResult.message}`,
                    ref: winner.ref,
                    exitCode: null,
                  }
                : { ...winner, proposal: persistResult };
            } else {
              reflectResult = winner;
            }
          } else {
            reflectResult = await reflectFn(reflectCallArgs);
          }
          const isCooldown = !reflectResult.ok && reflectResult.reason === "cooldown";
          // Content-policy guard hits (reflect size-rail rejections) are NOT
          // LLM faults — the agent responded fine, the downstream guard
          // blocked the output. Route them to a distinct `reflect-guard-rejected`
          // mode so health metrics can split deterministic guard hits out of
          // true LLM failures. See
          // `/tmp/akm-health-investigations/metrics-taxonomy-review.md` §1a.
          const isGuardReject = !reflectResult.ok && reflectResult.reason === "content_policy_reject";
          // Type-guard rejection (reflect refused a script/vault/task ref) is
          // also NOT an LLM failure — the LLM is never invoked. Route to the
          // existing `reflect-skipped` bucket so it does not inflate the
          // failure-rate numerator. ~9% of `reflect-failed` events in the
          // user's stack were this case; see review §1a row "Reflect refused
          // asset type".
          const isTypeRefused = !reflectResult.ok && reflectResult.reason === "unsupported_type";
          actions.push({
            ref: planned.ref,
            mode: reflectResult.ok
              ? "reflect"
              : isCooldown
                ? "reflect-cooldown"
                : isGuardReject
                  ? "reflect-guard-rejected"
                  : isTypeRefused
                    ? "reflect-skipped"
                    : "reflect-failed",
            result: reflectResult,
          });
          // Cooldown skips, guard rejects, and type-refused skips are not
          // failures — do not pollute recentErrors with them (those get
          // injected as `avoidPatterns` into the next reflect prompt). Guard
          // rejects ARE worth showing the LLM as a learn-signal so the next
          // iteration sees "your last expansion was too large"; type-refused
          // is deterministic and adds no learning signal.
          if (!reflectResult.ok && !isCooldown && !isTypeRefused) {
            const errMsg = reflectResult.error ?? reflectResult.reason ?? "unknown reflect error";
            pushRecentError("reflect", errMsg);
          }
          // improve_reflect_outcome — per-asset metric for tuning the reflect path.
          appendEvent(
            {
              eventType: "improve_reflect_outcome",
              ref: planned.ref,
              metadata: {
                ok: reflectResult.ok,
                durationMs: reflectResult.ok ? reflectResult.durationMs : undefined,
                agentProfile: reflectResult.ok ? reflectResult.agentProfile : undefined,
                reason: reflectResult.ok ? undefined : reflectResult.reason,
              },
            },
            eventsCtx,
          );

          if (reflectResult.ok) {
            gateAutoAcceptedCount += (
              await runAutoAcceptGate(
                [{ proposalId: reflectResult.proposal.id, confidence: reflectResult.proposal.confidence }],
                reflectGateCfg,
              )
            ).promoted.length;
          }
        } // end else (reflect type/profile check)
      } else if (!isDistillOnly && planned.ref.endsWith(".derived")) {
        // B6: .derived refs skip reflect; record synthetic skip action.
        actions.push({
          ref: planned.ref,
          mode: "distill-skipped",
          result: { ok: true, reason: "derived-memory-reflect-skipped" },
        });
        appendEvent(
          {
            eventType: "improve_skipped",
            ref: planned.ref,
            metadata: { reason: "derived_memory_reflect_skipped" },
          },
          eventsCtx,
        );
      }
      // isDistillOnly refs: no reflect action emitted — proceed directly to distill path below.
      const hasRecentFeedbackSignal = signalBearingSet.has(planned.ref);
      const explicitRefScope = scope.mode === "ref";
      // Profile gate: apply the full type-filter / raw-wiki / disabled rules to
      // distill so callers who configure `profile.processes.distill.allowedTypes`
      // or land on raw-wiki refs get a recorded skip action instead of silently
      // proceeding.
      const distillSkip = shouldSkipRef(planned.ref, "distill", improveProfile);
      if (distillSkip.skip) {
        actions.push({
          ref: planned.ref,
          mode: "distill-skipped",
          result: { ok: true, reason: distillSkip.reason },
        });
        completedCount++;
        info(`[improve] ${completedCount}/${loopRefs.length} ${planned.ref}`);
        continue;
      }
      // See `isDistillCandidateRef` — excludes `lesson:*` (and anything else in
      // DISTILL_REFUSED_INPUT_TYPES) so distill never gets queued for an input
      // it will refuse.
      const shouldAttemptDistill = isDistillCandidateRef(planned.ref, options.stashDir);
      const skipMemoryDistillForWeakSignal =
        !isDistillOnly && parsedPlannedRef.type === "memory" && !hasRecentFeedbackSignal && !explicitRefScope;

      // distillCooledRefs guard: pre-filter emitted synthetic actions for distill-candidate
      // refs; non-candidate refs in the set are blocked here.
      // O-2 (#365): bypass the distill cooldown when the user explicitly targeted
      // this ref via --scope — their intent overrides unattended-run policies.
      if (
        shouldAttemptDistill &&
        !skipMemoryDistillForWeakSignal &&
        (!distillCooledRefs.has(planned.ref) || explicitRefScope)
      ) {
        // TODO(refactor): single call site needs both lesson+knowledge refs for proposal dedup. If a third target ref type is added, extract deriveAllTargetRefs(inputRef): string[].
        const lessonRef = deriveLessonRef(planned.ref);
        const knowledgeRef = deriveKnowledgeRef(planned.ref);
        const dedupeStashDir = primaryStashDir ?? options.stashDir;
        if (dedupeStashDir) {
          // B2: check both lesson ref and knowledge ref since auto-promoted memories
          // create knowledge: proposals, not lesson: proposals.
          const hasExistingPending = pendingProposalRefSet.has(lessonRef) || pendingProposalRefSet.has(knowledgeRef);
          if (hasExistingPending) {
            actions.push({
              ref: planned.ref,
              mode: "distill-skipped",
              result: { ok: true, reason: "pending proposal exists" },
            });
            appendEvent(
              {
                eventType: "improve_skipped",
                ref: planned.ref,
                metadata: { reason: "pending_proposal_exists" },
              },
              eventsCtx,
            );
            completedCount++;
            info(`[improve] ${completedCount}/${loopRefs.length} ${planned.ref}`);
            continue;
          }

          // D-2 (#370): reject-aware cooldown for distill. When the reviewer
          // recently rejected a distilled lesson or knowledge proposal for this
          // asset, skip re-distillation for a 1-day grace window. Prevents the
          // same rejected proposal from being regenerated immediately. The
          // window is fixed (the 0.8.0 redesign moved per-ref cooldowns to
          // signal-delta gates and dropped --distill-cooldown-days; a short
          // reject grace is preserved here so a fresh rejection isn't
          // overridden by the same run).
          // References: ExpeL arXiv:2308.10144, STaR arXiv:2203.14465.
          const DISTILL_REJECT_COOLDOWN_MS = daysToMs(1);
          const recentlyRejectedLesson =
            !explicitRefScope && // O-2: bypass when --scope <ref> is explicit
            (rejectedProposalsByRef.has(lessonRef) || rejectedProposalsByRef.has(knowledgeRef));
          if (recentlyRejectedLesson) {
            const rejectedEntry = rejectedProposalsByRef.get(lessonRef) ?? rejectedProposalsByRef.get(knowledgeRef);
            const rejectedAgeMs = rejectedEntry ? Date.now() - new Date(rejectedEntry.ts).getTime() : 0;
            if (rejectedAgeMs < DISTILL_REJECT_COOLDOWN_MS) {
              actions.push({
                ref: planned.ref,
                mode: "distill-skipped",
                result: { ok: true, reason: "distill reject grace window" },
              });
              appendEvent(
                {
                  eventType: "improve_skipped",
                  ref: planned.ref,
                  metadata: {
                    reason: "distill_reject_grace_window",
                  },
                },
                eventsCtx,
              );
              completedCount++;
              info(`[improve] ${completedCount}/${loopRefs.length} ${planned.ref}`);
              continue;
            }
          }
        }

        const distillResult = await distillFn({
          ref: planned.ref,
          ...(parsedPlannedRef.type === "memory" ? { proposalKind: "auto" as const } : {}),
          ...(options.stashDir ? { stashDir: options.stashDir } : {}),
        });
        actions.push({ ref: planned.ref, mode: "distill", result: distillResult });
        if (distillResult.outcome === "queued" && distillResult.proposal) {
          gateAutoAcceptedCount += (
            await runAutoAcceptGate(
              [{ proposalId: distillResult.proposal.id, confidence: distillResult.proposal.confidence }],
              distillGateCfg,
            )
          ).promoted.length;
        }
        if (parsedPlannedRef.type === "memory") {
          const promotedToKnowledge = distillResult.outcome === "queued" && distillResult.proposalKind === "knowledge";
          if (!promotedToKnowledge) memoryRefsForInference.add(planned.ref);
        }
        if (distillResult.outcome === "quality_rejected" && primaryStashDir) {
          const slug = planned.ref
            .replace(/[^a-z0-9]/gi, "-")
            .toLowerCase()
            .slice(0, 60);
          writeEvalCase(primaryStashDir, {
            ref: planned.ref,
            failureReason: distillResult.reason ?? "quality gate rejected",
            assetType: parseAssetRef(planned.ref).type ?? "unknown",
            rejectedAt: Date.now(),
            source: "distill_quality_rejected",
            slug: `${slug}-${Date.now()}`,
          });
        }
        // D6: use pre-loaded map instead of per-iteration DB query
        const rejectedProposalEvent = rejectedProposalsByRef.get(planned.ref);
        if (rejectedProposalEvent && primaryStashDir) {
          const slug = planned.ref
            .replace(/[^a-z0-9]/gi, "-")
            .toLowerCase()
            .slice(0, 60);
          writeEvalCase(primaryStashDir, {
            ref: planned.ref,
            failureReason: (rejectedProposalEvent.metadata?.reason as string | undefined) ?? "proposal rejected",
            assetType: parseAssetRef(planned.ref).type ?? "unknown",
            rejectedAt: new Date(rejectedProposalEvent.ts).getTime(),
            source: "proposal_rejected",
            slug: `${slug}-rejected`,
          });
        }
      } else if (skipMemoryDistillForWeakSignal) {
        actions.push({
          ref: planned.ref,
          mode: "distill-skipped",
          result: { ok: true, reason: "memory requires recent feedback signal" },
        });
        appendEvent(
          {
            eventType: "improve_skipped",
            ref: planned.ref,
            metadata: { reason: "memory_distill_requires_feedback" },
          },
          eventsCtx,
        );
      }
    } catch (err) {
      // B7: UsageError thrown by akmDistill on validation_failed should be recorded
      // as mode:"distill" with outcome:"validation_failed", NOT as a generic error.
      // The distill_invoked event was already emitted inside akmDistill before the throw.
      if (err instanceof UsageError) {
        actions.push({
          ref: planned.ref,
          mode: "distill",
          result: { ok: false, outcome: "validation_failed", error: err.message } as unknown as AkmDistillResult,
        });
      } else {
        actions.push({
          ref: planned.ref,
          mode: "error",
          result: { ok: false, error: err instanceof Error ? err.message : String(err) },
        });
      }
    }
    completedCount++;
    info(`[improve] ${completedCount}/${loopRefs.length} ${planned.ref}`);
  }

  return { reflectsWithErrorContext, memoryRefsForInference, gateAutoAcceptedCount };
}

async function runImprovePostLoopStage(args: {
  scope: ImproveScope;
  options: AkmImproveOptions;
  primaryStashDir?: string;
  actionableRefs: ImproveEligibleRef[];
  appliedCleanup?: Awaited<ReturnType<typeof applyMemoryCleanup>>;
  cleanupWarnings: string[];
  memorySummary: { eligible: number; derived: number };
  memoryRefsForInference: Set<string>;
  reindexFn: (options: { stashDir: string }) => Promise<unknown>;
  eventsCtx?: EventsContext;
  /** O-1 (#364): shared wall-clock AbortSignal; forwarded to maintenance passes. */
  budgetSignal?: AbortSignal;
  /** Active improve profile, resolved from profile name + config. */
  improveProfile?: import("./improve-profiles").ImproveProfileConfig;
}): Promise<ImprovePostLoopResult> {
  const {
    scope,
    options,
    primaryStashDir,
    actionableRefs,
    appliedCleanup,
    cleanupWarnings,
    memorySummary,
    memoryRefsForInference,
    reindexFn,
    eventsCtx,
    budgetSignal,
    improveProfile,
  } = args;
  const allWarnings = [...cleanupWarnings, ...(appliedCleanup?.warnings ?? [])];

  const baseConfig = options.config ?? loadConfig();
  const MEMORY_VOLUME_THRESHOLD = options.memoryVolumeConsolidationThreshold ?? 100;
  const hasLlm = !!(baseConfig.defaults?.llm || baseConfig.defaults?.agent);
  const volumeTriggered =
    typeof memorySummary.eligible === "number" && memorySummary.eligible > MEMORY_VOLUME_THRESHOLD && hasLlm;
  // When volume triggers a consolidation pass, force-enable the consolidate
  // process on the default improve profile so the gate accepts the run even
  // if the user's config disabled it. We synthesise a new profile override
  // rather than mutating connection settings.
  const consolidationConfig: AkmConfig = volumeTriggered
    ? {
        ...baseConfig,
        profiles: {
          ...(baseConfig.profiles ?? {}),
          improve: {
            ...(baseConfig.profiles?.improve ?? {}),
            default: {
              ...(baseConfig.profiles?.improve?.default ?? {}),
              processes: {
                ...(baseConfig.profiles?.improve?.default?.processes ?? {}),
                consolidate: {
                  ...(baseConfig.profiles?.improve?.default?.processes?.consolidate ?? {}),
                  enabled: true,
                },
              },
            },
          },
        },
      }
    : baseConfig;

  // 0.8.0 pool-delta gate for consolidate: re-eligible iff at least one
  // memory file has been updated since the most recent successful
  // consolidate_completed event. Time-based cooldowns produced the same
  // synchronised-wave failure mode the reflect/distill cooldowns did; the
  // pool-delta gate ties consolidation to actual work-to-do.
  const recentConsolidations = readEvents({ type: "consolidate_completed" });
  const lastConsolidation = recentConsolidations.events
    .filter((e) => e.metadata?.processed && Number(e.metadata.processed) > 0)
    .sort((a, b) => new Date(b.ts ?? 0).getTime() - new Date(a.ts ?? 0).getTime())[0];
  const lastConsolidateTs = lastConsolidation?.ts;

  // Pool-delta: any memory file with mtime > lastConsolidateTs flags work to do.
  // Using file mtime keeps this query DB-free and matches what the indexer
  // already uses as the canonical `memory.updated_at` proxy.
  //
  // Bootstrap: when no successful consolidate_completed event has ever been
  // recorded, we cannot evaluate the pool-delta — treat as eligible so a
  // fresh stash runs consolidate once before the steady-state gate kicks in.
  const memoryUpdatedAfterLastConsolidate = (() => {
    if (volumeTriggered) return true; // volume override forces the run regardless.
    if (!lastConsolidateTs) return true; // bootstrap path: never consolidated.
    if (!primaryStashDir) return false;
    const memoriesDir = path.join(primaryStashDir, "memories");
    if (!fs.existsSync(memoriesDir)) return false;
    try {
      return fs.readdirSync(memoriesDir).some((f) => {
        if (!f.endsWith(".md")) return false;
        try {
          return fs.statSync(path.join(memoriesDir, f)).mtime.toISOString() > lastConsolidateTs;
        } catch {
          return false;
        }
      });
    } catch {
      return false;
    }
  })();

  const consolidationOnCooldown = !volumeTriggered && !memoryUpdatedAfterLastConsolidate;

  // Profile gate: if profile explicitly disables consolidate, skip the entire pass.
  const consolidateDisabledByProfile = improveProfile?.processes?.consolidate?.enabled === false;

  let consolidation: ConsolidateResult = {
    schemaVersion: 1,
    ok: true,
    shape: "consolidate-result",
    dryRun: false,
    previewOnly: false,
    target: "",
    processed: 0,
    merged: 0,
    deleted: 0,
    promoted: [],
    contradicted: 0,
    warnings: [],
    durationMs: 0,
  };
  let gateAutoAcceptedCount = 0;
  const consolidateGateCfg = makeGateConfig(
    "consolidate",
    {
      globalThreshold: options.autoAccept,
      dryRun: options.dryRun ?? false,
      stashDir: primaryStashDir,
      config: consolidationConfig,
      eventsCtx,
    },
    { minimumThreshold: 95 },
  );

  if (consolidateDisabledByProfile) {
    info("[improve] consolidation skipped (disabled by improve profile)");
  } else if (!consolidationOnCooldown) {
    consolidation = await akmConsolidate({
      ...options.consolidateOptions,
      config: consolidationConfig,
      stashDir: options.stashDir,
      autoTriggered: volumeTriggered,
      // Incremental consolidation: in steady state (not bootstrap, not volume-
      // triggered) pass the last-consolidation timestamp so akmConsolidate skips
      // chunks with no memory changed since then. Converts consolidation cost
      // from O(pool) to O(changed clusters) — the fix for the rising p95 tail
      // where full-pool re-judging produced 5–10 min runs that promoted ~0.
      // undefined → full pass (bootstrap, or volume-triggered large-pool sweep).
      incrementalSince: volumeTriggered ? undefined : lastConsolidateTs,
      // Honor profile.autoAccept (already merged into options.autoAccept at the
      // top of akmImprove). The CLI parser always supplies 90 when --auto-accept
      // is absent, so ?? 90 is not needed here and would prevent --auto-accept=false
      // (which maps to undefined) from disabling consolidation auto-accept.
      // options.consolidateOptions.autoAccept (if explicitly provided by caller)
      // still wins because the spread above runs first.
      autoAccept: options.consolidateOptions?.autoAccept ?? options.autoAccept,
    });
    gateAutoAcceptedCount += (
      await runAutoAcceptGate(
        consolidation.promoted.map((proposalId) => {
          try {
            if (!primaryStashDir) return { proposalId, confidence: undefined };
            const proposal = getProposal(primaryStashDir, proposalId);
            return { proposalId, confidence: proposal.confidence };
          } catch {
            return { proposalId, confidence: undefined };
          }
        }),
        consolidateGateCfg,
      )
    ).promoted.length;
    if (consolidation.processed > 0) {
      appendEvent(
        {
          eventType: "consolidate_completed",
          ref: "memory:_consolidation",
          metadata: { processed: consolidation.processed, merged: consolidation.merged },
        },
        eventsCtx,
      );
    }
  } else {
    appendEvent(
      {
        eventType: "improve_skipped",
        ref: "memory:_consolidation",
        metadata: {
          reason: "consolidation_no_memory_updates",
          lastEventTs: lastConsolidation?.ts ?? null,
        },
      },
      eventsCtx,
    );
    info("[improve] consolidation skipped (no memory updates since last run)");
  }

  // D9: track whether consolidation wrote any data so graph extraction can reindex if needed
  const consolidationRan = !consolidateDisabledByProfile && !consolidationOnCooldown && consolidation.processed > 0;

  info("[improve] post-loop maintenance starting");
  const maintenanceResult = await runImproveMaintenancePasses({
    options,
    primaryStashDir,
    actionableRefs,
    memoryRefsForInference,
    allWarnings,
    reindexFn,
    consolidationRan,
    // O-1 (#364): forward the budget signal to memory inference + graph extraction.
    budgetSignal,
    eventsCtx,
    improveProfile,
  });

  let deadUrls: DeadUrl[] | undefined;
  if (scope.mode === "all" && primaryStashDir && actionableRefs.length > 0) {
    try {
      const knowledgeEntries = actionableRefs
        .filter((r) => {
          try {
            return parseAssetRef(r.ref).type === "knowledge";
          } catch {
            return false;
          }
        })
        .slice(0, 10)
        .map((r) => ({ ref: r.ref, body: "" }));
      if (knowledgeEntries.length > 0) {
        info(`[improve] checking URLs in ${knowledgeEntries.length} knowledge refs`);
        deadUrls = await checkDeadUrls(primaryStashDir, knowledgeEntries);
        info(`[improve] URL check complete (${deadUrls.length} dead/timeout URLs)`);
      }
    } catch {
      // best-effort
    }
  }

  return {
    allWarnings,
    consolidation,
    deadUrls,
    ...(maintenanceResult.memoryInference ? { memoryInference: maintenanceResult.memoryInference } : {}),
    ...(maintenanceResult.graphExtraction ? { graphExtraction: maintenanceResult.graphExtraction } : {}),
    ...(maintenanceResult.stalenessDetection ? { stalenessDetection: maintenanceResult.stalenessDetection } : {}),
    ...(maintenanceResult.actions && maintenanceResult.actions.length > 0
      ? { maintenanceActions: maintenanceResult.actions }
      : {}),
    memoryInferenceDurationMs: maintenanceResult.memoryInferenceDurationMs,
    graphExtractionDurationMs: maintenanceResult.graphExtractionDurationMs,
    orphansPurged: maintenanceResult.orphansPurged,
    proposalsExpired: maintenanceResult.proposalsExpired,
    gateAutoAcceptedCount,
  };
}

// TODO(refactor): mutates the passed-in `allWarnings` array as a hidden side channel. Return warnings in ImproveMaintenanceResult and merge in caller — invasive signature change deferred to next refactor pass.
async function runImproveMaintenancePasses(args: {
  options: AkmImproveOptions;
  primaryStashDir?: string;
  actionableRefs: ImproveEligibleRef[];
  memoryRefsForInference: Set<string>;
  allWarnings: string[];
  reindexFn: (options: { stashDir: string }) => Promise<unknown>;
  /** D9: true when consolidation ran and wrote at least one record this improve run. */
  consolidationRan?: boolean;
  /** O-1 (#364): shared wall-clock AbortSignal; cancels sub-calls when budget expires. */
  budgetSignal?: AbortSignal;
  eventsCtx?: EventsContext;
  /** Active improve profile, resolved from profile name + config. */
  improveProfile?: import("./improve-profiles").ImproveProfileConfig;
}): Promise<ImproveMaintenanceResult> {
  const {
    options,
    primaryStashDir,
    memoryRefsForInference,
    allWarnings,
    reindexFn,
    consolidationRan,
    budgetSignal,
    eventsCtx,
    improveProfile,
  } = args;
  if (!primaryStashDir) return { memoryInferenceDurationMs: 0, graphExtractionDurationMs: 0 };

  const config = options.config ?? loadConfig();
  const sources = resolveSourceEntries(options.stashDir, config);
  const memoryInferenceFn = options.memoryInferenceFn ?? runMemoryInferencePass;
  const graphExtractionFn = options.graphExtractionFn ?? runGraphExtractionPass;
  const stalenessDetectionFn = options.stalenessDetectionFn ?? runStalenessDetectionPass;

  let db: Database | undefined;
  let memoryInference: MemoryInferenceResult | undefined;
  let graphExtraction: GraphExtractionResult | undefined;
  let stalenessDetection: StalenessDetectionResult | undefined;
  let reindexedAfterInference = false;
  const actions: ImproveActionResult[] = [];
  let memoryInferenceDurationMs = 0;
  let graphExtractionDurationMs = 0;
  let orphansPurged = 0;
  let proposalsExpired = 0;

  try {
    db = openDatabase(
      getDbPath(),
      config.embedding?.dimension ? { embeddingDim: config.embedding.dimension } : undefined,
    );

    // Memory inference candidate-discovery (post-Item 9 fix from
    // memory:akm-improve-critical-review-2026-05-20). Previously this pass
    // was gated on memoryRefsForInference.size > 0 AND passed those refs as a
    // candidateRefs filter. But memoryRefsForInference is populated from refs
    // distilled THIS RUN — by the time that happens, those parents are
    // already split (`inferenceProcessed: true`) and `isPendingMemory` excludes
    // them. The genuinely-pending parents in the stash never entered the
    // filter. Result: 0/0/0 for 25 consecutive runs.
    //
    // Fix: always run the pass when the feature is enabled; let the pass's
    // own `collectPendingMemories` + `isPendingMemory` predicate find
    // candidates from the filesystem-of-truth. The this-run set is still
    // logged as a hint but no longer used as a filter.
    const memoryInferenceDisabledByProfile = improveProfile?.processes?.memoryInference?.enabled === false;
    if (memoryInferenceDisabledByProfile) {
      info("[improve] memory inference skipped (disabled by improve profile)");
    } else {
      const hintRefs = memoryRefsForInference.size;
      info(
        hintRefs > 0
          ? `[improve] memory inference starting (${hintRefs} hint refs touched this run; pass discovers all pending)`
          : "[improve] memory inference starting (discovering pending parents)",
      );
      const inferenceStart = Date.now();
      try {
        // O-1 (#364): pass budget signal so a hung inference call is cancelled.
        memoryInference = await memoryInferenceFn(config, sources, budgetSignal, db, false, (event) => {
          const current = event.currentRef ? ` ${event.currentRef}` : "";
          info(
            `[improve] memory inference ${event.processed}/${event.total}${current} (written ${event.writtenFacts}, skipped ${event.skippedNoFacts})`,
          );
        });
        memoryInferenceDurationMs = Date.now() - inferenceStart;
        actions.push({ ref: "memory:_inference", mode: "memory-inference", result: memoryInference });
        info(
          `[improve] memory inference complete (${memoryInference.writtenFacts} facts written from ${memoryInference.splitParents} parents)`,
        );
      } catch (err) {
        memoryInferenceDurationMs = Date.now() - inferenceStart;
        allWarnings.push(`memory inference failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (memoryInference && (memoryInference.splitParents > 0 || memoryInference.writtenFacts > 0)) {
      info("[improve] reindexing after memory inference writes");
      try {
        await reindexFn({ stashDir: primaryStashDir });
        reindexedAfterInference = true;
        info("[improve] reindex after memory inference complete");
      } catch (err) {
        allWarnings.push(`reindex after memory inference failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const graphEnabled = isProcessEnabled("index", "graph_extraction", config);
    const graphExtractionDisabledByProfile = improveProfile?.processes?.graphExtraction?.enabled === false;
    // Build the set of refs actually touched this run.
    const touchedRefs = new Set<string>();
    for (const r of args.actionableRefs) touchedRefs.add(r.ref);
    for (const r of memoryRefsForInference) touchedRefs.add(r);

    // INVARIANT: graph extraction must never run on the full corpus from the
    // improve post-loop. Full-corpus scans belong in `akm index`. We enforce
    // this by ALWAYS passing `candidatePaths` (possibly an empty Set) to the
    // extractor — never `undefined`. With an empty Set, the extractor's
    // filter (graph-extraction.ts ~L452) rejects every file and returns the
    // empty result without scanning. The pass is still invoked so that the
    // action is recorded, the D9 post-consolidation reindex still fires, and
    // mock injection (graphExtractionFn) used by tests stays exercised.
    if (graphExtractionDisabledByProfile) {
      info("[improve] graph extraction skipped (disabled by improve profile)");
    } else if (sources.length > 0 && graphEnabled) {
      info("[improve] graph extraction starting");
      const extractionStart = Date.now();
      try {
        // D9: if consolidation ran but memory inference did not reindex, force a reindex
        // so graph extraction sees current DB state after consolidation writes.
        if (consolidationRan && !reindexedAfterInference) {
          info("[improve] reindexing after consolidation (graph extraction needs current state)");
          try {
            await reindexFn({ stashDir: primaryStashDir });
            reindexedAfterInference = true;
            info("[improve] reindex after consolidation complete");
          } catch (err) {
            allWarnings.push(`reindex after consolidation failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        if (db && reindexedAfterInference) {
          closeDatabase(db);
          db = openDatabase(
            getDbPath(),
            config.embedding?.dimension ? { embeddingDim: config.embedding.dimension } : undefined,
          );
        }
        // Resolve touched refs to absolute file paths. Empty Set is intentional
        // when no refs were touched — see INVARIANT above.
        const candidatePaths = new Set<string>();
        if (primaryStashDir && touchedRefs.size > 0) {
          const writableDirSet = new Set(getWritableStashDirs(primaryStashDir).map((d) => path.resolve(d)));
          const resolved = await Promise.all(
            [...touchedRefs].map((ref) => findAssetFilePath(ref, primaryStashDir, writableDirSet).catch(() => null)),
          );
          for (const p of resolved) {
            if (typeof p === "string" && p.length > 0) candidatePaths.add(p);
          }
        }
        const progressHandler = (event: {
          processed: number;
          total: number;
          extracted: number;
          totalEntities: number;
          totalRelations: number;
          currentPath?: string;
        }) => {
          const current = event.currentPath ? ` ${path.basename(event.currentPath)}` : "";
          info(
            `[improve] graph extraction ${event.processed}/${event.total}${current} (extracted ${event.extracted}, entities ${event.totalEntities}, relations ${event.totalRelations})`,
          );
        };
        // O-1 (#364): pass budget signal so a hung graph extraction call is cancelled.
        graphExtraction = await graphExtractionFn(config, sources, budgetSignal, db, false, progressHandler, {
          candidatePaths,
        });
        graphExtractionDurationMs = Date.now() - extractionStart;
        actions.push({ ref: "graph:_artifact", mode: "graph-extraction", result: graphExtraction });
        info(
          `[improve] graph extraction complete (${graphExtraction.quality.extractedFiles} files, ${graphExtraction.quality.entityCount} entities, ${graphExtraction.quality.relationCount} relations)`,
        );
      } catch (err) {
        graphExtractionDurationMs = Date.now() - extractionStart;
        allWarnings.push(`graph extraction failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else if (sources.length > 0 && !graphEnabled) {
      info("[improve] graph extraction skipped (features.index.graph_extraction is disabled)");
    }

    // Orphan proposal purge — reject pending reflect proposals whose target
    // asset no longer exists on disk. Runs after graph extraction so newly
    // promoted assets from accept flows during this run are already present.
    if (primaryStashDir) {
      try {
        const purgeResult = purgeOrphanProposals(
          primaryStashDir,
          sources.map((s) => s.path),
        );
        orphansPurged = purgeResult.rejected;
        if (purgeResult.rejected > 0) {
          info(
            `[improve] orphan purge: ${purgeResult.rejected}/${purgeResult.checked} orphaned proposals rejected (${purgeResult.durationMs}ms)`,
          );
        }
        appendEvent(
          {
            eventType: "proposal_orphan_purge",
            ref: "proposals:_orphan-purge",
            metadata: {
              checked: purgeResult.checked,
              rejected: purgeResult.rejected,
              durationMs: purgeResult.durationMs,
              byType: purgeResult.byType,
              orphans: purgeResult.orphans.map((o) => o.ref),
            },
          },
          eventsCtx,
        );
      } catch (err) {
        allWarnings.push(`orphan purge failed: ${err instanceof Error ? err.message : String(err)}`);
      }

      // Phase 6B (Advantage D6b): expire pending proposals that have aged past
      // the retention window. Runs AFTER orphan purge so we never double-archive
      // a proposal that orphan-purge already moved. `expireStaleProposals` emits
      // its own per-proposal `proposal_expired` events; we additionally emit a
      // single roll-up event here for parity with the orphan-purge surface.
      try {
        const expireResult = expireStaleProposals(primaryStashDir, config);
        proposalsExpired = expireResult.expired;
        if (expireResult.expired > 0) {
          info(
            `[improve] expiration: ${expireResult.expired}/${expireResult.checked} pending proposals expired ` +
              `(retention=${expireResult.retentionDays}d, ${expireResult.durationMs}ms)`,
          );
        }
        appendEvent(
          {
            eventType: "proposal_expiration_pass",
            ref: "proposals:_expiration",
            metadata: {
              checked: expireResult.checked,
              expired: expireResult.expired,
              durationMs: expireResult.durationMs,
              retentionDays: expireResult.retentionDays,
              expiredProposals: expireResult.expiredProposals,
            },
          },
          eventsCtx,
        );
      } catch (err) {
        allWarnings.push(`proposal expiration failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Fix #2 (observability 0.8.0): trim the events table in state.db so it
    // doesn't grow unbounded. `akm health` writes a `health_probe` row on every
    // invocation, and every command surface emits at least one event besides —
    // without this trim, state.db is a permanent append-only log. Config key
    // `improve.eventRetentionDays` (default 90, set 0 to disable) controls the
    // window. `purgeOldEvents()` opens its own state.db handle separate from
    // the index `db` above (different SQLite file).
    {
      const retentionDays =
        typeof config.improve?.eventRetentionDays === "number" ? config.improve.eventRetentionDays : 90;
      if (retentionDays > 0) {
        let stateDb: ReturnType<typeof openStateDatabase> | undefined;
        try {
          stateDb = openStateDatabase();
          const purgedCount = purgeOldEvents(stateDb, retentionDays);
          if (purgedCount > 0) {
            info(`[improve] events purge: ${purgedCount} event(s) older than ${retentionDays}d removed from state.db`);
          }
          appendEvent(
            {
              eventType: "events_purged",
              ref: "events:_purge",
              metadata: { purgedCount, retentionDays },
            },
            eventsCtx,
          );

          // improve_runs uses the same retention window as events — both are
          // observability/audit data, both grow append-only, both have a
          // dedicated purge helper. Mirroring the events purge here means a
          // single retention knob (improve.eventRetentionDays) governs both.
          const improveRunsPurged = purgeOldImproveRuns(stateDb, retentionDays);
          if (improveRunsPurged > 0) {
            info(
              `[improve] improve_runs purge: ${improveRunsPurged} run(s) older than ${retentionDays}d removed from state.db`,
            );
          }
          appendEvent(
            {
              eventType: "improve_runs_purged",
              ref: "improve_runs:_purge",
              metadata: { purgedCount: improveRunsPurged, retentionDays },
            },
            eventsCtx,
          );
        } catch (err) {
          allWarnings.push(`events purge failed: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          if (stateDb) {
            try {
              stateDb.close();
            } catch {
              // best-effort
            }
          }
        }
      }
    }

    // Phase 4A (staleness detection). Activates the `deprecated` belief-state
    // machinery shipped in Phase 1A. Default OFF — gated by
    // `features.index.staleness_detection.enabled`. Runs after orphan purge
    // and before the URL check (which lives in the outer caller).
    if (sources.length > 0) {
      try {
        stalenessDetection = await stalenessDetectionFn(config, sources, budgetSignal, db);
        if (stalenessDetection.considered > 0) {
          info(
            `[improve] staleness detection complete (considered ${stalenessDetection.considered}, ` +
              `deprecated ${stalenessDetection.deprecated}, confirmed ${stalenessDetection.confirmed}, ` +
              `skipped ${stalenessDetection.skipped}, ${stalenessDetection.durationMs}ms)`,
          );
        }
        for (const w of stalenessDetection.warnings) allWarnings.push(`[improve] staleness detection: ${w}`);
      } catch (err) {
        allWarnings.push(`staleness detection failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } finally {
    if (db) closeDatabase(db);
  }

  return {
    ...(memoryInference ? { memoryInference } : {}),
    ...(graphExtraction ? { graphExtraction } : {}),
    ...(stalenessDetection ? { stalenessDetection } : {}),
    ...(actions.length > 0 ? { actions } : {}),
    memoryInferenceDurationMs,
    graphExtractionDurationMs,
    orphansPurged,
    proposalsExpired,
  };
}

function shouldAnalyzeMemoryCleanup(
  scope: { mode: "all" | "type" | "ref"; value?: string },
  eligibleMemories: number,
  primaryStashDir: string | undefined,
): boolean {
  if (!primaryStashDir || eligibleMemories === 0) return false;
  if (scope.mode === "all") return true;
  if (scope.mode === "type") return scope.value === "memory";
  if (!scope.value) return false;
  return parseAssetRef(scope.value).type === "memory";
}

function shapeMemoryCleanup(plan: MemoryCleanupPlan): ImproveMemoryCleanupResult {
  return {
    analyzedDerived: plan.analyzedDerived,
    pruneCandidates: plan.pruneCandidates,
    contradictionCandidates: plan.contradictionCandidates,
    beliefStateTransitions: plan.beliefStateTransitions,
    consolidationCandidates: plan.consolidationCandidates,
    ...(plan.relativeDateCandidates.length > 0 ? { relativeDateCandidates: plan.relativeDateCandidates } : {}),
  };
}

function buildUtilityMap(refs: ImproveEligibleRef[]): Map<string, number> {
  const map = new Map<string, number>();
  if (refs.length === 0) return map;
  const refSet = new Set(refs.map((r) => r.ref));
  let db: Database | undefined;
  try {
    db = openExistingDatabase();
    const allDbEntries = getAllEntries(db);
    const idToRef = new Map<number, string>();
    for (const indexed of allDbEntries) {
      const ref = makeAssetRef(indexed.entry.type, indexed.entry.name);
      if (refSet.has(ref)) idToRef.set(indexed.id, ref);
    }
    const ids = [...idToRef.keys()];
    if (ids.length > 0) {
      const { global: scores } = getUtilityScoresByIds(db, ids);
      for (const [id, score] of scores) {
        const ref = idToRef.get(id);
        if (ref) map.set(ref, score.utility);
      }
    }
  } catch (err) {
    rethrowIfTestIsolationError(err);
    // best-effort: if DB unavailable, all utilities default to 0
  } finally {
    if (db) closeDatabase(db);
  }
  return map;
}

async function findAssetFilePath(ref: string, stashDir?: string, writableDirSet?: Set<string>): Promise<string | null> {
  return resolveAssetPath(ref, {
    stashDir,
    mode: "disk-only",
    writableDirSet,
    directoryIndexNames: ["SKILL.md"],
    preserveDirectNameFallback: true,
    honorOrigin: false,
  });
}
