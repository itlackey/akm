// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import path from "node:path";
import { assertNever } from "../../core/assert";
import { makeAssetRef, parseAssetRef } from "../../core/asset/asset-ref";
import { parseFrontmatter } from "../../core/asset/frontmatter";
import { type AkmAssetType, daysToMs, isAssetType } from "../../core/common";
import type { AkmConfig } from "../../core/config/config";
import { getDefaultLlmConfig, loadConfig } from "../../core/config/config";
import { ConfigError, NotFoundError, rethrowIfTestIsolationError, UsageError } from "../../core/errors";
import { appendEvent, type EventEnvelope, type EventsContext, readEvents } from "../../core/events";
import { probeLock, releaseLock, releaseLockIfOwned, tryAcquireLockSync } from "../../core/file-lock";
import type {
  AkmImproveResult,
  EligibilitySource,
  ImproveActionResult,
  ImproveEligibleRef,
  ImproveMemoryCleanupResult,
} from "../../core/improve-types";
import { classifyImproveAction } from "../../core/improve-types";
import { openLogsDatabase, purgeOldTaskLogs } from "../../core/logs-db";
import { getDbPath, getStateDbPathInDataDir } from "../../core/paths";
import { listProposalGateDecisions, openStateDatabase, purgeOldEvents, purgeOldImproveRuns } from "../../core/state-db";
import { info, warn } from "../../core/warn";
import {
  closeDatabase,
  getAllEntries,
  getEntryCount,
  getRetrievalCounts,
  getUtilityScoresByIds,
  getZeroResultSearches,
  openDatabase,
  openExistingDatabase,
} from "../../indexer/db/db";
import { type EnsureIndexOptions, ensureIndex } from "../../indexer/ensure-index";
import { type GraphExtractionResult, runGraphExtractionPass } from "../../indexer/graph/graph-extraction";
import { withIndexWriterLease } from "../../indexer/index-writer-lock";
import { akmIndex } from "../../indexer/indexer";
import {
  collectPendingMemories,
  type MemoryInferenceResult,
  runMemoryInferencePass,
} from "../../indexer/passes/memory-inference";
import { runStalenessDetectionPass, type StalenessDetectionResult } from "../../indexer/passes/staleness-detect";
import { getWritableStashDirs, resolveSourceEntries } from "../../indexer/search/search-source";
import { countUsageEventsByType } from "../../indexer/usage/usage-events";
import { resolveAssetPath } from "../../indexer/walk/path-resolver";
import { resolveImproveProcessRunnerFromProfile, resolveTriageJudgmentRunner } from "../../integrations/agent/runner";
import { getAvailableHarnesses } from "../../integrations/session-logs";
import type { SessionLogHarness } from "../../integrations/session-logs/types";
import { isProcessEnabled } from "../../llm/feature-gate";
import { installLlmUsagePersistence } from "../../llm/usage-persist";
import { withLlmStage } from "../../llm/usage-telemetry";
import { isGitBackedStash, resolveWritableOverride, saveGitStash } from "../../sources/providers/git";
import type { Database } from "../../storage/database";
import { akmLint } from "../lint/index";
import { type DrainResult, drainProposals } from "../proposal/drain";
import { resolveDrainPolicy } from "../proposal/drain-policies";
import {
  createProposal,
  expireStaleProposals,
  getProposal,
  isProposalSkipped,
  listProposals,
  purgeOrphanProposals,
} from "../proposal/validators/proposals";
import { runSchemaRepairPass } from "../sources/schema-repair";
import { checkDeadUrls, type DeadUrl } from "../url-checker";
import {
  type CalibrationTuneConfig,
  computeThresholdAutoTune,
  gateDecisionsToSamples,
  summarizeCalibration,
} from "./calibration";
import { type AkmConsolidateOptions, akmConsolidate, type ConsolidateResult } from "./consolidate";
import { type AkmDistillResult, akmDistill, deriveLessonRef, isDistillRefusedInputType } from "./distill";
import { deriveKnowledgeRef } from "./distill-promotion-policy";
import { countEvalCases, writeEvalCase } from "./eval-cases";
import { type AkmExtractResult, akmExtract, countNewExtractCandidates } from "./extract";
import { makeGateConfig, resolveExtractConfidence, runAutoAcceptGate } from "./improve-auto-accept";
import type { ImproveProfileConfig } from "./improve-profiles";
import {
  isProfileFilteredForAllPasses,
  resolveImproveProfile,
  resolveProcessEnabled,
  shouldSkipRef,
} from "./improve-profiles";
import { detectAndWriteContradictions } from "./memory/memory-contradiction-detect";
import { analyzeMemoryCleanup, applyMemoryCleanup, type MemoryCleanupPlan } from "./memory/memory-improve";
import { DEFAULT_DUE_DAYS, DEFAULT_MAX_PER_RUN, selectProactiveMaintenanceRefs } from "./proactive-maintenance";
import { type AkmReflectResult, akmReflect } from "./reflect";
import {
  buildRankChangeReport,
  computeSalience,
  getAllRankScores,
  getConsecutiveNoOps,
  getLastUseMsByRef,
  recordNoOp,
  resetConsecutiveNoOps,
  SALIENCE_NO_OP_DAMPEN_FACTOR,
  SALIENCE_NO_OP_DAMPEN_THRESHOLD,
  upsertAssetSalience,
} from "./salience";

// #607 Lock Decomposition: fine-grained per-process locks replace the single
// `improve.lock`. Three independent locks allow concurrent improve runs when
// they touch different subsystems (e.g. quick-shredder consolidate can run
// alongside daily reflect+distill).
//
//   consolidate.lock   — protects consolidate + memoryInference (both write index.db)
//   reflect-distill.lock — protects reflect + distill (both write state.db proposals)
//   triage.lock         — protects triage (writes proposal promotions)
//
// Stale timeouts are per-lock, tuned to the expected runtime of the protected
// processes: consolidate is disk-bound (1h), reflect+distill is GPU-bound (2h),
// triage is fast (30min).

const PROCESS_LOCK_DEFS = {
  consolidate: { fileName: "consolidate.lock", staleAfterMs: 60 * 60 * 1000 },
  reflectDistill: { fileName: "reflect-distill.lock", staleAfterMs: 2 * 60 * 60 * 1000 },
  triage: { fileName: "triage.lock", staleAfterMs: 30 * 60 * 1000 },
} as const;

const heldProcessLocks = new Set<string>();

export function resetHeldProcessLocks(): void {
  heldProcessLocks.clear();
}

function processLockPath(lockBaseDir: string, lockName: keyof typeof PROCESS_LOCK_DEFS): string {
  return path.join(lockBaseDir, PROCESS_LOCK_DEFS[lockName].fileName);
}

function tryAcquireProcessLock(
  lockPath: string,
  staleAfterMs: number,
  skipIfLocked: boolean | undefined,
  lockLabel: string,
): "acquired" | "skipped" {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const lockPayload = () => JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });
  if (tryAcquireLockSync(lockPath, lockPayload())) {
    heldProcessLocks.add(lockPath);
    return "acquired";
  }

  const probe = probeLock(lockPath, { staleAfterMs });
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
    try {
      appendEvent({
        eventType: "improve_lock_recovered",
        metadata: {
          lockName: lockLabel,
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
    releaseLock(lockPath);
    if (tryAcquireLockSync(lockPath, lockPayload())) {
      heldProcessLocks.add(lockPath);
      return "acquired";
    }
    if (skipIfLocked) {
      warn(`[improve] ${lockLabel} lock acquired by another run during stale recovery; skipping (--skip-if-locked)`);
      return "skipped";
    }
    throw new ConfigError(
      `akm improve ${lockLabel} is already running. Delete ${lockPath} to force.`,
      "INVALID_CONFIG_FILE",
    );
  }

  if (skipIfLocked) {
    warn(
      `[improve] ${lockLabel} lock held by another run (PID ${lock?.pid}, started ${lock?.startedAt}); skipping (--skip-if-locked)`,
    );
    return "skipped";
  }

  throw new ConfigError(
    `akm improve ${lockLabel} is already running (PID ${lock?.pid}, started ${lock?.startedAt}). Delete ${lockPath} to force.`,
    "INVALID_CONFIG_FILE",
  );
}

function releaseProcessLock(lockPath: string): void {
  try {
    fs.unlinkSync(lockPath);
  } catch {
    // ignore
  }
  heldProcessLocks.delete(lockPath);
}

function releaseAllProcessLocks(): void {
  for (const p of heldProcessLocks) {
    try {
      fs.unlinkSync(p);
    } catch {
      // ignore
    }
  }
  heldProcessLocks.clear();
}

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
  /**
   * Run identifier minted by the CLI (`buildImproveRunId()`). Threaded onto the
   * result so health/run records and sync-commit templates (`{runId}`) can read
   * it. Undefined for programmatic callers that do not mint one.
   */
  runId?: string;
  /** Wall-clock budget for the entire improve run in milliseconds. Defaults to 2 hours. */
  timeoutMs?: number;
  limit?: number;
  /**
   * When another improve run already holds a per-process lock, skip that
   * specific process gracefully instead of failing with a "already running"
   * config error (exit 78). Each process (consolidate, reflect+distill, triage)
   * has its own lock; a held lock skips only that process, not the entire run.
   * Intended for high-frequency scheduled runs (e.g. the every-30-min `quick`
   * pass) that would otherwise pile up exit-78 failures whenever a longer run
   * is in progress. Default: false (preserve hard error per lock).
   */
  skipIfLocked?: boolean;
  /** Named improve profile from profiles.improve or built-in profile names (default, quick, thorough, memory-focus). */
  profile?: string;
  consolidateOptions?: Omit<AkmConsolidateOptions, "config" | "stashDir">;
  /** Number of eligible memory assets above which consolidation is forced even if the memory_consolidation feature flag is not set. Defaults to 100. */
  memoryVolumeConsolidationThreshold?: number;
  reflectFn?: (options: NonNullable<Parameters<typeof akmReflect>[0]>) => Promise<AkmReflectResult>;
  distillFn?: (options: NonNullable<Parameters<typeof akmDistill>[0]>) => Promise<AkmDistillResult>;
  memoryInferenceFn?: typeof runMemoryInferencePass;
  /**
   * Phase 4A: injectable staleness-detection pass for tests. When omitted, the
   * real `runStalenessDetectionPass` runs (which is itself a no-op unless
   * `features.index.staleness_detection` is enabled).
   */
  stalenessDetectionFn?: typeof runStalenessDetectionPass;
  graphExtractionFn?: typeof runGraphExtractionPass;
  /**
   * #554 minNewSessions gate: injectable counter for the number of NEW (unseen,
   * in-window) extract candidate sessions. Defaults to the real
   * {@link countNewExtractCandidates}. Tests inject a deterministic count to
   * exercise the below-threshold skip without touching real session logs.
   */
  extractCandidateCountFn?: typeof countNewExtractCandidates;
  /**
   * Override the session-log harness registry used by the extract phase (test
   * seam). When set, it is forwarded to both the #554 candidate counter and the
   * `akmExtract` calls so the same harness set drives the gate and the pass.
   */
  extractHarnesses?: SessionLogHarness[];
  ensureIndexFn?: (stashDir: string, options?: EnsureIndexOptions) => Promise<unknown>;
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
  /**
   * Phase 4: injectable triage drain seam for tests. When omitted, the real
   * `drainProposals` runs as the improve pre-pass (gated on the `triage`
   * process being enabled, `scope.mode !== "ref"`, and `!options.dryRun`).
   */
  drainProposalsFn?: typeof drainProposals;
  /**
   * Injectable end-of-run stash-sync seam for tests. When omitted, the real
   * `saveGitStash` runs (gated on a git-backed primary stash + sync enabled).
   */
  saveGitStashFn?: typeof saveGitStash;
  /**
   * End-of-run auto-sync override (from CLI `--no-sync`/`--no-push`). Only the
   * keys the caller passed are set; CLI overrides the resolved profile `sync`
   * block, which in turn overrides the built-in default.
   */
  sync?: { enabled?: boolean; push?: boolean };
}

export type {
  AkmImproveResult,
  EligibilitySource,
  ImproveActionResult,
  ImproveEligibleRef,
  ImproveMemoryCleanupResult,
};

type ImproveScope = ReturnType<typeof resolveImproveScope>;

interface ImprovePreparationResult {
  actions: ImproveActionResult[];
  cleanupWarnings: string[];
  appliedCleanup?: Awaited<ReturnType<typeof applyMemoryCleanup>>;
  memoryIndexHealth?: { lineCount: number; overBudget: boolean };
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
  gateAutoAcceptFailedCount: number;
  /**
   * Consolidation result (#551). Consolidation now runs in the preparation
   * stage BEFORE the session-extract pass, so it only ever judges memories
   * promoted by PRIOR runs — files written by extract auto-accept in the
   * current run do not exist yet when the pool-delta gate is evaluated.
   */
  consolidation: ConsolidateResult;
  /** Whether the consolidation pass actually ran (vs profile-disabled / pool-delta skip). Drives graph-extraction reindex. */
  consolidationRan: boolean;
  /**
   * Layer 2 proactive-maintenance selector outcome, when the process ran.
   * Undefined when the process is disabled or the run is ref-scoped.
   */
  proactiveMaintenance?: { selected: number; dueTotal: number; neverReflected: number };
}

interface ImproveLoopResult {
  reflectsWithErrorContext: number;
  memoryRefsForInference: Set<string>;
  gateAutoAcceptedCount: number;
  gateAutoAcceptFailedCount: number;
}

interface ImprovePostLoopResult {
  allWarnings: string[];
  gateAutoAcceptedCount: number;
  gateAutoAcceptFailedCount: number;
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
        `Unknown asset type: "${trimmed}". Valid types: memory, knowledge, skill, lesson, workflow, agent, command, script, wiki, env, secret, task.\n` +
          `If you passed --format to akm improve, that flag is not supported — use it with akm search or akm show instead.`,
        "INVALID_FLAG_VALUE",
      );
    }
    return { mode: "type", value: trimmed };
  }
}

/**
 * Render the end-of-run stash-sync commit message, expanding `{token}`
 * placeholders against this run's results. Unknown tokens are passed through
 * verbatim so adding new tokens later never breaks an existing template, and so
 * a literal brace in a message is harmless.
 *
 * Supported tokens (the "free" set — derived from data already on the result):
 *   {timestamp}  `YYYY-MM-DD HH:MM:SS` (UTC)
 *   {date}       `YYYY-MM-DD` (UTC)
 *   {time}       `HH:MM:SS` (UTC)
 *   {scope}      scope value (e.g. a ref/type) or the scope mode (`all`)
 *   {refs}       number of planned refs this run processed
 *   {accepted}   number of proposals auto-accepted by the confidence gate
 *   {triage_promoted}  proposals promoted by the triage pre-pass (0 if triage did not run)
 *   {triage_rejected}  proposals rejected by the triage pre-pass (0 if triage did not run)
 *   {runId}      this run's id (empty string when absent)
 *
 * The result is still passed through `sanitizeCommitMessage` downstream in
 * `saveGitStash`, so token values never widen the commit-message attack surface
 * (newlines/control chars are collapsed there).
 *
 * `nowMs` is injected (not read from `Date.now()`) so the function is pure and
 * deterministically testable.
 */
export function renderSyncCommitMessage(
  template: string,
  result: {
    scope: { mode: string; value?: string };
    plannedRefs: unknown[];
    gateAutoAcceptedCount?: number;
    triage?: { promoted: number; rejected: number; deferred: number; skippedByCap: number };
    runId?: string;
  },
  nowMs: number,
): string {
  const iso = new Date(nowMs).toISOString();
  const tokens: Record<string, string> = {
    timestamp: `${iso.slice(0, 10)} ${iso.slice(11, 19)}`,
    date: iso.slice(0, 10),
    time: iso.slice(11, 19),
    scope: result.scope.value ?? result.scope.mode,
    refs: String(result.plannedRefs.length),
    accepted: String(result.gateAutoAcceptedCount ?? 0),
    triage_promoted: String(result.triage?.promoted ?? 0),
    triage_rejected: String(result.triage?.rejected ?? 0),
    runId: result.runId ?? "",
  };
  return template.replace(/\{(\w+)\}/g, (match, key: string) => (Object.hasOwn(tokens, key) ? tokens[key] : match));
}

/**
 * Dedupe a list of eligible refs by `ref`, preserving first-seen order. Used to
 * merge the three eligibility sources (feedback-signal, P0-A high-retrieval,
 * Layer-2 proactive-maintenance) without admitting a ref into the loop twice.
 */
function dedupeRefs(refs: ImproveEligibleRef[]): ImproveEligibleRef[] {
  const seen = new Set<string>();
  const out: ImproveEligibleRef[] = [];
  for (const r of refs) {
    if (seen.has(r.ref)) continue;
    seen.add(r.ref);
    out.push(r);
  }
  return out;
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
      plannedRefs: [{ ref: scope.value, reason: "scope-ref", filePath }],
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
      const ref = makeAssetRef(indexed.entry.type as AkmAssetType, indexed.entry.name);
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
            filePath: indexed.filePath,
          });
        } else {
          planned.set(ref, {
            ref,
            reason:
              scope.mode === "type" ? "scope-type" : indexed.entry.type === "memory" ? "memory-cleanup" : "scope-type",
            filePath: indexed.filePath,
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

/**
 * H7 (#566): cooperative budget watchdog with a captured, RAII-cleared hard-kill.
 *
 * When the wall-clock budget expires, `onExhausted` (normally an
 * `AbortController.abort`) signals cooperative cancellation so the run can drain
 * its in-flight log/`state.db` flush and unwind naturally. A second hard-kill
 * timer is then armed as a watchdog: it only `exit(0)`s if the drain itself
 * overruns `hardKillGraceMs`, preventing the process from outliving the task
 * timeout window (lock-cascade fix).
 *
 * Both timers are captured; the returned dispose() clears whichever is still
 * pending. Callers invoke it from a `finally`, so a *clean* drain reaches the
 * `finally` and cancels the pending hard-kill before it can fire — the previous
 * detached `setTimeout(() => process.exit(0), 5000)` always fired, truncating a
 * clean flush. The hard-kill timer is `unref()`-ed so it never keeps the event
 * loop alive on its own: once the run drains it exits with its own code, not the
 * forced 0.
 *
 * Dependencies are injectable purely so the concurrency-sensitive timing
 * contract can be exercised deterministically in unit tests.
 */
export function armBudgetWatchdog(
  budgetMs: number,
  controller: AbortController,
  deps?: {
    setTimeoutFn?: typeof setTimeout;
    clearTimeoutFn?: typeof clearTimeout;
    exitFn?: (code: number) => void;
    hardKillGraceMs?: number;
  },
): () => void {
  const setTimeoutFn = deps?.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = deps?.clearTimeoutFn ?? clearTimeout;
  const exitFn = deps?.exitFn ?? ((code: number) => process.exit(code));
  const hardKillGraceMs = deps?.hardKillGraceMs ?? 5_000;

  let hardKillTimer: ReturnType<typeof setTimeout> | undefined;

  const budgetTimer = setTimeoutFn(() => {
    // Cooperative cancellation first: let the run drain.
    controller.abort("improve budget exhausted");
    // Watchdog: only force-exit if the drain itself overruns the grace period.
    // Exit 0: budget exhaustion is a normal scheduled-task condition, not an error.
    hardKillTimer = setTimeoutFn(() => exitFn(0), hardKillGraceMs);
    // Never keep the event loop alive solely for the watchdog.
    hardKillTimer.unref?.();
  }, budgetMs);

  // RAII dispose: clears whichever timer is still pending. Idempotent.
  return () => {
    clearTimeoutFn(budgetTimer);
    if (hardKillTimer !== undefined) {
      clearTimeoutFn(hardKillTimer);
      hardKillTimer = undefined;
    }
  };
}

/**
 * #612 — bounded, opt-in auto-accept threshold auto-tune.
 *
 * Reads `improve.calibration` from config. When `autoTune` is enabled, computes
 * the calibration of recent gate decisions, derives a bounded threshold
 * adjustment (clamped into the configured band, capped per step), logs it, and
 * records a `calibration_autotune` event. Returns the new threshold (integer
 * 0-100) when an adjustment was made, or `undefined` to leave the caller's
 * threshold unchanged.
 *
 * DEFAULT OFF: with no `improve.calibration` block (or `autoTune: false`) this
 * returns `undefined` immediately, so the gate threshold is unchanged and
 * behaviour is byte-identical to today.
 */
export function maybeAutoTuneThreshold(
  currentThreshold: number,
  config: AkmConfig,
  stateDbPath: string,
  ctx?: { now?: () => number; appendEventFn?: typeof appendEvent },
): number | undefined {
  const cal = config.improve?.calibration;
  if (!cal?.autoTune) return undefined;

  const tuneConfig: CalibrationTuneConfig = {
    autoTune: true,
    minThreshold: cal.minThreshold ?? 0,
    maxThreshold: cal.maxThreshold ?? 100,
    maxStep: cal.maxStep ?? 5,
    minSamples: cal.minSamples ?? 20,
    targetAcceptRate: cal.targetAcceptRate ?? 0.9,
  };
  // Defensive: an inverted band disables tuning rather than clamping to nonsense.
  if (tuneConfig.minThreshold > tuneConfig.maxThreshold) return undefined;

  const db = openStateDatabase(stateDbPath);
  let summary: ReturnType<typeof summarizeCalibration>;
  try {
    const decisions = listProposalGateDecisions(db);
    summary = summarizeCalibration(gateDecisionsToSamples(decisions));
  } finally {
    db.close();
  }

  const result = computeThresholdAutoTune(currentThreshold, summary, tuneConfig);
  if (!result.adjusted) return undefined;

  const appendEventFn = ctx?.appendEventFn ?? appendEvent;
  info(
    `[improve] calibration auto-tune: threshold ${result.previousThreshold} -> ${result.newThreshold} ` +
      `(${result.reason}; samples=${summary.samples}, acceptRate=${summary.overallAcceptRate}, ` +
      `gap=${summary.calibrationGap}, band=[${tuneConfig.minThreshold},${tuneConfig.maxThreshold}])`,
  );
  try {
    appendEventFn({
      eventType: "calibration_autotune",
      ref: "improve:calibration",
      metadata: {
        previousThreshold: result.previousThreshold,
        newThreshold: result.newThreshold,
        delta: result.delta,
        reason: result.reason,
        samples: summary.samples,
        overallAcceptRate: summary.overallAcceptRate,
        calibrationGap: summary.calibrationGap,
        minThreshold: tuneConfig.minThreshold,
        maxThreshold: tuneConfig.maxThreshold,
      },
    });
  } catch (err) {
    warn(`[improve] calibration auto-tune event not recorded: ${err instanceof Error ? err.message : String(err)}`);
  }
  return result.newThreshold;
}

export async function akmImprove(options: AkmImproveOptions = {}): Promise<AkmImproveResult> {
  const scope: ImproveScope = resolveImproveScope(options.scope);
  const reflectFn = options.reflectFn ?? akmReflect;
  const distillFn = options.distillFn ?? akmDistill;
  const ensureIndexFn = options.ensureIndexFn ?? ensureIndex;
  const reindexFn = options.reindexFn ?? akmIndex;
  const drainProposalsFn = options.drainProposalsFn ?? drainProposals;
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
    // Profile-level limit, then process-level reflect.limit as fallback.
    // CLI --limit takes precedence over both.
    limit: options.limit ?? improveProfile?.processes?.reflect?.limit ?? improveProfile.limit,
  };
  let primaryStashDir: string | undefined;
  try {
    primaryStashDir = resolveSourceEntries(options.stashDir)[0]?.path;
  } catch {
    primaryStashDir = undefined;
  }

  // C2 (#553/#554/#499): resolve the state.db path ONCE, synchronously, at the
  // command boundary — before the first `await` below. Every state.db open in
  // this run (`openStateDatabase`, every default-path `appendEvent`) is pinned
  // to this snapshot via `eventsCtx.dbPath`, so a parallel test file mutating
  // `process.env.XDG_DATA_HOME` across an await boundary can never redirect this
  // run's DB opens to a wrong/just-deleted tmpdir mid-flight (the parallel-load
  // timeout root cause). Because beforeEach runs synchronously, env is still the
  // calling test's own at this point; we capture it before yielding the loop.
  const resolvedStateDbPath = getStateDbPathInDataDir();

  // #612 — bounded, OPT-IN auto-accept threshold auto-tune. DEFAULT OFF: when
  // `improve.calibration.autoTune` is absent/false this is a complete no-op and
  // the resolved `options.autoAccept` is unchanged (byte-identical parity). When
  // enabled, the gate threshold is nudged within the configured [min,max] band
  // toward the target realized accept rate, based on the calibration of recent
  // gate decisions. Every adjustment is logged + recorded as an event.
  if (options.autoAccept !== undefined) {
    try {
      const tuned = maybeAutoTuneThreshold(options.autoAccept, _earlyConfig, resolvedStateDbPath);
      if (tuned !== undefined) options = { ...options, autoAccept: tuned };
    } catch (err) {
      warn(`[improve] calibration auto-tune skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // #607 Lock decomposition: three per-process locks replace the single
  // `improve.lock`. Each process acquires only the lock(s) it needs, so
  // quick-shredder consolidate can run alongside daily reflect+distill.
  //
  //   consolidate.lock     — protects consolidate + memoryInference + graphExtraction (index.db writers)
  //   reflect-distill.lock — protects reflect + distill (state.db proposal writers)
  //   triage.lock          — protects triage pre-pass (state.db proposal promotions)
  //
  // Lock base directory — same `.akm/` under the primary stash dir.
  const lockBaseDir = primaryStashDir ? path.join(primaryStashDir, ".akm") : path.join(options.stashDir ?? ".", ".akm");

  const preEnsureCleanupWarnings: string[] = [];
  let plannedRefs: Awaited<ReturnType<typeof collectEligibleRefs>>["plannedRefs"];
  let memorySummary: Awaited<ReturnType<typeof collectEligibleRefs>>["memorySummary"];
  let profileFilteredRefs: Awaited<ReturnType<typeof collectEligibleRefs>>["profileFilteredRefs"];
  let memoryCleanupPlan: ReturnType<typeof analyzeMemoryCleanup> | undefined;
  let guidance: string | undefined;
  let triageDrain: DrainResult | undefined;

  try {
    // #607: Per-process lock acquisition. Each process acquires only the lock(s)
    // it needs. The dry-run branch produces plannedRefs/memorySummary WITHOUT any
    // locks (decision: dry-run never mutates the queue).
    if (!options.dryRun) {
      // Backstop release on process.exit() (signal handler / budget watchdog),
      // which skips the finally below. Removed in that finally on the normal path.
      const releaseAllOnExit = (): void => {
        for (const p of heldProcessLocks) {
          releaseLockIfOwned(p, process.pid);
        }
      };
      process.on("exit", releaseAllOnExit);

      // #607 triage pre-pass: acquire triage.lock, drain the standing pending
      // backlog BEFORE ensureIndex so improve generates fresh proposals against
      // a cleared queue (no `duplicate_pending` collisions) and ensureIndex
      // absorbs triage's promotions for free. Release immediately after —
      // triage.lock is not needed again until the next improve run.
      if (primaryStashDir && resolveProcessEnabled("triage", improveProfile)) {
        if (scope.mode === "ref") {
          warn("[improve] triage pre-pass skipped (single-ref scope never drains the whole queue)");
        } else {
          const triageLPath = processLockPath(lockBaseDir, "triage");
          const triageResult = tryAcquireProcessLock(
            triageLPath,
            PROCESS_LOCK_DEFS.triage.staleAfterMs,
            options.skipIfLocked,
            "triage",
          );
          if (triageResult === "skipped") {
            triageDrain = undefined;
          } else {
            try {
              const triageConfig = improveProfile.processes?.triage;
              const policy = resolveDrainPolicy(triageConfig?.policy);
              const applyMode: "queue" | "promote" = triageConfig?.applyMode ?? "queue";
              const maxAccepts = triageConfig?.maxAcceptsPerRun ?? 25;
              const judgment = triageConfig?.judgment
                ? resolveTriageJudgmentRunner(triageConfig.judgment, _earlyConfig)
                : null;
              triageDrain = await drainProposalsFn({
                stashDir: primaryStashDir,
                policy,
                applyMode,
                maxAccepts,
                dryRun: false,
                excludeIds: new Set<string>(),
                ...(triageConfig?.maxDiffLines !== undefined ? { maxDiffLines: triageConfig.maxDiffLines } : {}),
                judgment,
              });
            } catch (err) {
              warn(`[improve] triage pre-pass failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
            } finally {
              releaseProcessLock(triageLPath);
            }
          }
        }
      }
    }

    // #339 fix: ensureIndex MUST run BEFORE collectEligibleRefs. The eligible-ref
    // query reads the `entries` table; if a DB version upgrade just dropped that
    // table (or the index is otherwise empty), the prior run order silently
    // returned plannedRefs=[] and the improve loop no-op'd. Hoisting the call
    // here repopulates the index first so the subsequent query sees fresh data.
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
        await ensureIndexFn(primaryStashDir, { mode: "blocking" });
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

    ({ plannedRefs, memorySummary, profileFilteredRefs } = await collectEligibleRefs(
      scope,
      options.stashDir,
      improveProfile,
    ));
    const cleanupParentRef = memoryCleanupParentRef(scope, options.stashDir);

    // M-1 (#367): Run contradiction-detection BEFORE analyzeMemoryCleanup so
    // the SCC resolver in resolveFamilyContradictions has edges to work on.
    // Best-effort: failures are warnings, never fatal.
    if (primaryStashDir && shouldAnalyzeMemoryCleanup(scope, memorySummary.eligible, primaryStashDir)) {
      try {
        // Reuse the config resolved at the top of the run instead of a second load.
        await withLlmStage("memory-contradiction", () => detectAndWriteContradictions(primaryStashDir, _earlyConfig));
      } catch (err) {
        // Non-fatal: contradiction detection is a best-effort pass.
        warn(
          `[improve] contradiction detection failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    memoryCleanupPlan = shouldAnalyzeMemoryCleanup(scope, memorySummary.eligible, primaryStashDir)
      ? analyzeMemoryCleanup(primaryStashDir as string, cleanupParentRef ? { parentRef: cleanupParentRef } : undefined)
      : undefined;
    guidance =
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
  } catch (err) {
    releaseAllProcessLocks();
    throw err;
  }

  // #607: per-process locks are acquired/released around each stage below.
  // The triage pre-pass already ran under triage.lock (released). The
  // preparation stage runs under consolidate.lock, the loop stage under
  // reflect-distill.lock, and the post-loop stage under consolidate.lock again.
  // Each stage acquires its lock just before starting and releases in finally.
  // best-effort `unlinkSync` is a no-op when no lock file exists.
  const startMs = Date.now();
  const budgetMs = options.timeoutMs ?? 2 * 60 * 60 * 1000; // default 2 hours
  // O-1 (#364): Create a shared AbortController derived from startMs + budgetMs.
  // Every async seam receives this signal so a hung sub-call cannot extend the
  // run past the declared budget.
  // References: Anthropic *Building Effective Agents* (2024); CoALA §5 (arXiv:2309.02427).
  const budgetAbortController = new AbortController();
  // Attach a live `remainingBudgetMs` getter to the signal so sub-callers
  // (e.g. consolidate.ts cold-start budget estimation) can read the remaining
  // wall-clock budget without needing an extra plumbing parameter. The property
  // is computed at access time via a getter so it always reflects the actual
  // elapsed time rather than a stale snapshot taken at arm time.
  Object.defineProperty(budgetAbortController.signal, "remainingBudgetMs", {
    get: () => Math.max(0, budgetMs - (Date.now() - startMs)),
    enumerable: false,
    configurable: true,
  });
  // Declared in the outer scope so the `finally` can clear the timer even if a
  // throw occurs before/after it is armed. Defaults to a no-op until armed.
  let clearBudgetTimer = (): void => {};
  // I1: open a single state.db connection for the entire improve run so all
  // appendEvent calls reuse one handle instead of open/migrate/close per call.
  let eventsDb: import("../../storage/database").Database | undefined;
  // `eventsCtx` is read by the main catch (improve_failed) and finally, so it
  // lives in the outer scope. It is always assigned at the top of the try.
  // Pinned to the boundary snapshot so the fallback per-call `appendEvent`
  // opens (when the long-lived handle below fails to open) never re-read env.
  let eventsCtx: EventsContext = { dbPath: resolvedStateDbPath };
  // #576: clears the per-run LLM usage sink. Defaults to a no-op until the sink
  // is installed inside the try; the `finally` always calls it.
  let disposeLlmUsageSink = (): void => {};

  try {
    // H7 (#566): arm the budget watchdog. `armBudgetWatchdog` captures both the
    // budget timer and the hard-kill timer it schedules on exhaustion, returning
    // a single dispose() that clears whichever are still pending. The `finally`
    // calls dispose() via `clearBudgetTimer` (RAII), so a clean cooperative
    // drain cancels the pending hard-kill before it can fire — the process then
    // exits naturally instead of being force-`exit(0)`-ed mid-flush, which could
    // truncate an in-flight log or `state.db` transaction.
    clearBudgetTimer = armBudgetWatchdog(budgetMs, budgetAbortController);

    try {
      eventsDb = openStateDatabase(resolvedStateDbPath);
      eventsCtx = { db: eventsDb };
    } catch (err) {
      rethrowIfTestIsolationError(err);
      // If we cannot open state.db up-front, fall back to per-call opens — but
      // still pinned to the boundary-resolved path, never a live env re-read.
      eventsCtx = { dbPath: resolvedStateDbPath };
    }

    // #576: persist per-call LLM usage telemetry for this run as `llm_usage`
    // events, reusing the same boundary-pinned events context (and long-lived
    // handle when available). Disposed in `finally` so the sink never leaks
    // across runs. Wrapping is best-effort end to end — see usage-telemetry.ts.
    disposeLlmUsageSink = installLlmUsagePersistence(eventsCtx);

    // 2026-05-27: emit an `improve_skipped` audit event for refs the planner
    // pre-filtered (reflect AND distill both refuse them under the active
    // profile). Emitted as a single summary event (count only) rather than one
    // event per ref (#592) — the per-ref loop caused O(n) sequential state.db
    // writes that consumed ~500 s on a 9 000-ref stash. No downstream consumer
    // needs the per-ref audit trail: health's skip histogram reads the
    // `profile_filtered_all_passes` counters from `improve_completed` metadata.
    if (profileFilteredRefs.length > 0) {
      appendEvent(
        {
          eventType: "improve_skipped",
          ref: undefined,
          metadata: {
            reason: "profile_filtered_all_passes",
            count: profileFilteredRefs.length,
          },
        },
        eventsCtx,
      );
    }

    // #607: acquire consolidate.lock for the preparation stage (consolidate,
    // ensureIndex, extract all write index.db). Released immediately after.
    const consolidateLPath = processLockPath(lockBaseDir, "consolidate");
    const consolidatePrepAcquired =
      tryAcquireProcessLock(
        consolidateLPath,
        PROCESS_LOCK_DEFS.consolidate.staleAfterMs,
        options.skipIfLocked,
        "consolidate",
      ) === "acquired";
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
      budgetSignal: budgetAbortController.signal,
    });
    if (consolidatePrepAcquired) releaseProcessLock(consolidateLPath);

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

    // #607: acquire reflect-distill.lock for the loop stage (reflect + distill
    // both write proposals to state.db). Released immediately after.
    const reflectDistillLPath = processLockPath(lockBaseDir, "reflectDistill");
    const reflectDistillAcquired =
      tryAcquireProcessLock(
        reflectDistillLPath,
        PROCESS_LOCK_DEFS.reflectDistill.staleAfterMs,
        options.skipIfLocked,
        "reflect-distill",
      ) === "acquired";
    const {
      reflectsWithErrorContext,
      memoryRefsForInference,
      gateAutoAcceptedCount: loopGateCount,
      gateAutoAcceptFailedCount: loopGateFailedCount,
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
    if (reflectDistillAcquired) releaseProcessLock(reflectDistillLPath);

    // #551: consolidation now runs in the preparation stage (before extract);
    // its result and run-flag are read from `preparation`, not the post-loop.
    const consolidation = preparation.consolidation;

    // #607: acquire consolidate.lock for the post-loop stage (memoryInference +
    // graphExtraction both write index.db). Released immediately after.
    const consolidatePostLPath = processLockPath(lockBaseDir, "consolidate");
    const consolidatePostAcquired =
      tryAcquireProcessLock(
        consolidatePostLPath,
        PROCESS_LOCK_DEFS.consolidate.staleAfterMs,
        options.skipIfLocked,
        "consolidate",
      ) === "acquired";
    const {
      allWarnings,
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
      gateAutoAcceptFailedCount: postLoopGateFailedCount,
    } = await runImprovePostLoopStage({
      scope,
      options,
      primaryStashDir,
      actionableRefs: preparation.actionableRefs,
      appliedCleanup: preparation.appliedCleanup,
      cleanupWarnings: preparation.cleanupWarnings,
      memoryRefsForInference,
      reindexFn,
      eventsCtx,
      budgetSignal: budgetAbortController.signal,
      improveProfile,
      consolidationRan: preparation.consolidationRan,
    });
    if (consolidatePostAcquired) releaseProcessLock(consolidatePostLPath);

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
      ...(() => {
        const f = preparation.gateAutoAcceptFailedCount + loopGateFailedCount + postLoopGateFailedCount;
        return f > 0 ? { gateAutoAcceptFailedCount: f } : {};
      })(),
      ...(triageDrain
        ? {
            triage: {
              promoted: triageDrain.promoted.length,
              rejected: triageDrain.rejected.length,
              deferred: triageDrain.deferred.length,
              skippedByCap: triageDrain.skippedByCap.length,
            },
          }
        : {}),
      ...(preparation.proactiveMaintenance ? { proactiveMaintenance: preparation.proactiveMaintenance } : {}),
      ...(options.runId !== undefined ? { runId: options.runId } : {}),
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

    // End-of-run BATCH auto-sync. Recognition is decoupled from the per-write
    // path (see write-source.ts case-3): the primary stash writes as a
    // filesystem source during the run, then is committed in one shot here via
    // the same `saveGitStash` that `akm sync` calls. Gated on a non-dry-run, a
    // git-backed primary stash (by `.git`, not by remote), and sync not
    // disabled. A sync failure is NON-FATAL — it never fails a successful run
    // (mirrors the contradiction-detection best-effort pattern).
    const effectiveSync = { ...improveProfile.sync, ...options.sync };
    if (!result.dryRun && primaryStashDir && effectiveSync.enabled !== false && isGitBackedStash(primaryStashDir)) {
      const saveGitStashFn = options.saveGitStashFn ?? saveGitStash;
      // Reuse the config resolved at the top of the run (`_earlyConfig`) instead
      // of a second loadConfig(); the writable derivation is shared with
      // `akm sync` via resolveWritableOverride().
      const writableOverride = resolveWritableOverride(_earlyConfig);
      const push = effectiveSync.push !== false;
      // `sync.message` may contain `{token}` placeholders (timestamp/date/time/
      // scope/refs/accepted) expanded against this run's results; the default
      // template has no tokens so it renders verbatim.
      const message = renderSyncCommitMessage(effectiveSync.message ?? "akm improve auto-sync", result, Date.now());
      try {
        // Pass primaryStashDir as the explicit commit target so the gate above
        // (which validated primaryStashDir via isGitBackedStash) and the commit
        // operate on the SAME directory — avoids divergence when a caller passes
        // a non-default options.stashDir (FIX 9).
        const syncResult = saveGitStashFn(undefined, message, writableOverride, { push, repoDir: primaryStashDir });
        result.sync = {
          committed: syncResult.committed,
          pushed: syncResult.pushed,
          skipped: syncResult.skipped,
          ...(syncResult.reason !== undefined ? { reason: syncResult.reason } : {}),
        };
        appendEvent(
          {
            eventType: "stash_synced",
            metadata: {
              committed: syncResult.committed,
              pushed: syncResult.pushed,
              skipped: syncResult.skipped,
              reason: syncResult.reason ?? null,
            },
          },
          eventsCtx,
        );
      } catch (syncErr) {
        const reason = syncErr instanceof Error ? syncErr.message : String(syncErr);
        warn(`improve: end-of-run stash sync failed (non-fatal): ${reason}`);
        result.sync = { committed: false, pushed: false, skipped: true, reason };
        appendEvent(
          {
            eventType: "stash_synced",
            metadata: { committed: false, pushed: false, skipped: true, reason },
          },
          eventsCtx,
        );
      }
    }

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
    // #576: clear the per-run LLM usage sink BEFORE closing `eventsDb` below, so
    // no late sink invocation can write through a closed handle.
    disposeLlmUsageSink();
    // O-1 (#364): Clear the budget abort timer so it does not keep the event
    // loop alive after the run completes.
    clearBudgetTimer();
    // #607: release any per-process locks still held (backstop for error paths;
    // the normal path already released each lock after its stage completed).
    releaseAllProcessLocks();
    // Drop the process.exit backstop so it does not fire later (or accumulate
    // across repeated in-process calls).
    process.removeAllListeners("exit");
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
    reflectGuardRejected: 0,
    distill: 0,
    distillSkipped: 0,
    memoryPrune: 0,
    memoryInference: 0,
    graphExtraction: 0,
    error: 0,
  };
  // Coarse audit buckets, derived from the SAME classifyImproveAction the
  // persisted metrics_json uses (state-db.ts#computeImproveRunMetrics) so the
  // emitted event and the stored row can never disagree.
  const classCounts = { accepted: 0, rejected: 0, error: 0, noop: 0 };
  for (const action of result.actions ?? []) {
    classCounts[classifyImproveAction(action.mode)] += 1;
    // Per-variant counters for the event metadata. The default arm makes any
    // new ImproveActionMode variant a compile error so a future variant cannot
    // be silently dropped from the improve_completed event (the `reflect-guard-
    // rejected` case below was previously missing here entirely).
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
      case "reflect-guard-rejected":
        actionCounts.reflectGuardRejected += 1;
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
      default:
        assertNever(action.mode);
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
        // Previously dropped from the event entirely; now emitted so the guard
        // rejections are visible in improve_completed telemetry.
        reflectGuardRejectedActions: actionCounts.reflectGuardRejected,
        acceptedActions: classCounts.accepted,
        rejectedActions: classCounts.rejected,
        noopActions: classCounts.noop,
        reflectsWithErrorContext: result.reflectsWithErrorContext ?? 0,
        coverageGapCount: result.coverageGaps?.length ?? 0,
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
        // Layer-2 proactive-maintenance coverage (0 when the process is disabled
        // or the run was ref-scoped) so a scheduled sweep's reach is trackable.
        proactiveSelected: result.proactiveMaintenance?.selected ?? 0,
        proactiveDueTotal: result.proactiveMaintenance?.dueTotal ?? 0,
        proactiveNeverReflected: result.proactiveMaintenance?.neverReflected ?? 0,
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

/**
 * Result of the consolidation pass (#551).
 *
 * Consolidation moved OUT of the post-loop stage and into the preparation
 * stage, where it runs BEFORE the session-extract pass. This guarantees the
 * pool-delta gate (and akmConsolidate itself) only ever observe memories that
 * existed at the start of the run — files written by extract auto-accept in
 * the CURRENT run are not on disk yet, so they cannot make the gate fire.
 */
interface ConsolidationPassResult {
  consolidation: ConsolidateResult;
  /** True iff consolidation actually processed memories this run (drives graph reindex). */
  consolidationRan: boolean;
  gateAutoAcceptedCount: number;
  gateAutoAcceptFailedCount: number;
}

/**
 * Run (or gate-skip) the memory consolidation pass.
 *
 * #551 — two coordinated changes live here:
 *
 *   1. STRUCTURAL: this runs before extract in the improve pipeline (see
 *      `runImprovePreparationStage`). Consolidation therefore only ever judges
 *      PRIOR-run memories; current-run extract promotions are invisible to it.
 *
 *   2. SMARTER POOL-DELTA GATE: even among on-disk files, a memory whose only
 *      post-`lastConsolidateTs` mtime bump came from its OWN auto-accept
 *      promotion (i.e. it was just promoted by extract in the immediately
 *      preceding run and has not had a full improve cycle to settle) does NOT
 *      count as "work to do". We exclude those paths from the pool-delta check
 *      using the `promoted` events already emitted with each promotion's
 *      `assetPath`. A genuinely-settled prior memory — one edited by feedback,
 *      reflect, manual edit, or simply older than the last consolidate — still
 *      triggers the run. This is gate-option (a) from the issue (same-run /
 *      adjacent-run promotion exclusion), chosen over option (b) because there
 *      is no `extract_completed` event in the data model to gate against;
 *      `promoted` events with `assetPath` already carry exactly the signal we
 *      need, so the fix is non-invasive and provably correct.
 */
async function runConsolidationPass(args: {
  options: AkmImproveOptions;
  primaryStashDir?: string;
  memorySummary: { eligible: number; derived: number };
  improveProfile?: import("./improve-profiles").ImproveProfileConfig;
  eventsCtx?: EventsContext;
  /** Budget signal forwarded to akmConsolidate for graceful drain on timeout. */
  budgetSignal?: AbortSignal;
}): Promise<ConsolidationPassResult> {
  const { options, primaryStashDir, memorySummary, improveProfile, eventsCtx, budgetSignal } = args;

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

  // #551 smarter gate: build the set of memory asset paths whose only delta
  // since the last consolidate is their OWN auto-accept promotion. Those files
  // have not had a full improve cycle to settle, so they offer no merge /
  // contradiction candidates yet — excluding them stops the gate firing on
  // freshly-promoted single-source memories. We read `promoted` events emitted
  // after the last consolidate; each carries the written `assetPath`.
  const promotedSinceConsolidate = (() => {
    const paths = new Set<string>();
    try {
      const promoted = readEvents({
        type: "promoted",
        ...(lastConsolidateTs ? { since: lastConsolidateTs } : {}),
      }).events;
      for (const e of promoted) {
        const ap = e.metadata?.assetPath;
        if (typeof ap === "string" && ap.length > 0) paths.add(path.resolve(ap));
      }
    } catch {
      // best-effort: if the events query fails, fall back to no exclusions
      // (preserves pre-#551 behaviour rather than over-skipping).
    }
    return paths;
  })();

  // Pool-delta: any memory file with mtime > lastConsolidateTs flags work to do,
  // EXCEPT files whose only post-consolidate change was their own promotion.
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
        const filePath = path.join(memoriesDir, f);
        // #551: skip files that were only touched by their own promotion this
        // cohort — they have no settled merge/contradiction candidates yet.
        if (promotedSinceConsolidate.has(path.resolve(filePath))) return false;
        try {
          return fs.statSync(filePath).mtime.toISOString() > lastConsolidateTs;
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

  // #553 minPoolSize guard: skip consolidation when the eligible memory pool is
  // below a minimum size, rather than spending an LLM pass on a handful of
  // memories. This is an INDEPENDENT skip condition from #551's mtime pool-delta
  // gate — either can skip. Default 500; `minPoolSize: 0` disables the guard.
  // Evaluated against the eligible-pool count BEFORE entering the LLM loop so a
  // skip costs ZERO LLM calls.
  const CONSOLIDATE_DEFAULT_MIN_POOL_SIZE = 500;
  const configuredMinPoolSize = improveProfile?.processes?.consolidate?.minPoolSize;
  const minPoolSize =
    typeof configuredMinPoolSize === "number" ? configuredMinPoolSize : CONSOLIDATE_DEFAULT_MIN_POOL_SIZE;
  const eligiblePoolSize = typeof memorySummary.eligible === "number" ? memorySummary.eligible : 0;
  // volumeTriggered means the pool already exceeds the volume threshold (100),
  // so a force-triggered run never trips the pool-size guard. The guard only
  // engages when minPoolSize > 0 and the eligible pool is strictly below it.
  const poolBelowMinSize = !volumeTriggered && minPoolSize > 0 && eligiblePoolSize < minPoolSize;

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
  let gateAutoAcceptFailedCount = 0;
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
  } else if (poolBelowMinSize) {
    // #553: eligible pool below the configured minimum — skip with zero LLM
    // calls. Reuse the #551 `improve_skipped` emission path so health surfaces
    // it via the dynamic skipReasons aggregation under `pool_below_min_size`.
    appendEvent(
      {
        eventType: "improve_skipped",
        ref: "memory:_consolidation",
        metadata: {
          reason: "pool_below_min_size",
          poolSize: eligiblePoolSize,
          minPoolSize,
        },
      },
      eventsCtx,
    );
    info(`[improve] consolidation skipped (pool ${eligiblePoolSize} < minPoolSize ${minPoolSize})`);
  } else if (!consolidationOnCooldown) {
    consolidation = await withLlmStage("consolidate", () =>
      akmConsolidate({
        ...options.consolidateOptions,
        config: consolidationConfig,
        stashDir: options.stashDir,
        autoTriggered: volumeTriggered,
        // Tie consolidate proposals back to this improve invocation so
        // accept-rate-per-run aggregation works. Mirrors reflect/propose/extract.
        sourceRun: `consolidate-${Date.now()}`,
        // Pass profile-configured options. incrementalSince narrows the pool to
        // recently-changed memories + graph neighbours — use this for frequent
        // passes (quick-shredder). Leave absent in the nightly default profile for
        // a full-pool sweep that catches stale-but-unmerged duplicates.
        incrementalSince: improveProfile?.processes?.consolidate?.incrementalSince,
        limit: improveProfile?.processes?.consolidate?.limit,
        neighborsPerChanged: improveProfile?.processes?.consolidate?.neighborsPerChanged,
        maxChunkSize: improveProfile?.processes?.consolidate?.maxChunkSize,
        // #617 — deterministic near-duplicate dedup pre-pass. DEFAULT OFF; only
        // runs when the profile explicitly sets `consolidate.dedup.enabled`.
        dedup: improveProfile?.processes?.consolidate?.dedup,
        // #581 — judged-state cache. DEFAULT OFF; only engages when the profile
        // explicitly sets `consolidate.judgedCache.enabled`. Skips memories
        // judged-unchanged since their last judge so one run sweeps the full
        // corpus instead of narrowing to a time-window slice.
        judgedCache: improveProfile?.processes?.consolidate?.judgedCache,
        // Honor profile.autoAccept (already merged into options.autoAccept at the
        // top of akmImprove). The CLI parser always supplies 90 when --auto-accept
        // is absent, so ?? 90 is not needed here and would prevent --auto-accept=false
        // (which maps to undefined) from disabling consolidation auto-accept.
        // options.consolidateOptions.autoAccept (if explicitly provided by caller)
        // still wins because the spread above runs first.
        autoAccept: options.consolidateOptions?.autoAccept ?? options.autoAccept,
        // WS-3a: forward budget signal for graceful abort on timeout, and pass
        // the profile's p90 estimate for cold-start budget reduction.
        signal: budgetSignal,
        p90ChunkSecondsDefault: improveProfile?.processes?.consolidate?.p90ChunkSecondsDefault,
      }),
    );
    {
      const consolidateGr = await runAutoAcceptGate(
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
      );
      gateAutoAcceptedCount += consolidateGr.promoted.length;
      gateAutoAcceptFailedCount += consolidateGr.failed.length;
    }
    if (consolidation.processed > 0) {
      appendEvent(
        {
          eventType: "consolidate_completed",
          ref: "memory:_consolidation",
          metadata: {
            processed: consolidation.processed,
            merged: consolidation.merged,
            deleted: consolidation.deleted,
            contradicted: consolidation.contradicted,
            failedChunks: consolidation.failedChunks ?? 0,
            durationMs: consolidation.durationMs,
          },
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
  const consolidationRan =
    !consolidateDisabledByProfile && !poolBelowMinSize && !consolidationOnCooldown && consolidation.processed > 0;

  return { consolidation, consolidationRan, gateAutoAcceptedCount, gateAutoAcceptFailedCount };
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
  /** Budget signal forwarded to the consolidation pass for graceful drain on timeout. */
  budgetSignal?: AbortSignal;
}): Promise<ImprovePreparationResult> {
  const {
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
    initialCleanupWarnings,
    improveProfile,
    budgetSignal,
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

  // Phase 0.3 — memory consolidation pass (#551).
  //
  // Consolidation runs BEFORE the session-extract pass. This is the structural
  // half of the #551 fix: extract auto-accept writes brand-new memory .md files
  // on every run, which previously made the consolidation pool-delta gate fire
  // unconditionally (any new file => "memory updated since last consolidate").
  // By running consolidation first, the gate and akmConsolidate only ever see
  // memories that existed at the start of the run — current-run extract
  // promotions are not on disk yet. The complementary smarter-gate logic
  // (excluding adjacent-run promotions) lives in `runConsolidationPass`.
  const consolidationPass = await runConsolidationPass({
    options,
    primaryStashDir,
    memorySummary,
    improveProfile,
    eventsCtx,
    budgetSignal,
  });

  // Phase 0.4 — session-extract pass.
  //
  // Reads native session files (claude-code JSONL, opencode storage tree)
  // through the SessionLogHarness registry, pre-filters noise, and asks a
  // bounded in-tree LLM to produce candidate memory/lesson/knowledge
  // proposals for content the agent did NOT preserve via inline `akm remember`
  // / `akm feedback` invocations. Replaces the akm-plugin session-checkpoint
  // hook with an on-demand pull pipeline.
  //
  // Default-on; opt out via the ACTIVE profile's `processes.extract.enabled: false`
  // (#593: the gate respects the resolved improve profile, not just the
  // hardcoded `default` profile path the legacy feature flag reads).
  // Each available harness gets one call with the default --since window;
  // already-seen sessions (tracked in state.db.extract_sessions_seen) are
  // skipped automatically so re-runs don't burn LLM calls on unchanged data.
  //
  // Failures are non-fatal — one harness throwing doesn't abort improve.
  // The extract envelope's own `warnings` field surfaces what went wrong.
  let extractResults: AkmExtractResult[] | undefined;
  // Seed the preparation-stage gate counters with consolidation's auto-accept
  // gate results (#551: consolidation now runs in this stage), then accumulate
  // extract's gate results on top.
  let gateAutoAcceptedCount = consolidationPass.gateAutoAcceptedCount;
  let gateAutoAcceptFailedCount = consolidationPass.gateAutoAcceptFailedCount;
  const extractConfig = options.config ?? loadConfig();
  const extractGateCfg = makeGateConfig("extract", {
    globalThreshold: options.autoAccept,
    dryRun: options.dryRun ?? false,
    stashDir: primaryStashDir,
    config: extractConfig,
    eventsCtx,
  });
  // #554 minNewSessions gate: skip the entire extract pass (ensureIndex was
  // already done upstream; here we elide every akmExtract/processSession call)
  // when the NEW (unseen, in-window) candidate-session pool is below a minimum.
  // 22% of improve runs produce zero memory-inference writes because extract
  // finds no new sessions, yet still burns the full extract pipeline. Default 0
  // (disabled) preserves existing always-run behaviour; only opted-in profiles
  // (e.g. `frequent`) set it. Evaluated BEFORE any LLM call so a skip costs zero
  // LLM work AND writes nothing — which also means no extract auto-accept bumps
  // memory mtimes, so a skipped extract never flags work for the NEXT run's
  // consolidation mtime-gate (the downstream trigger #554 asks us to suppress).
  const EXTRACT_DEFAULT_MIN_NEW_SESSIONS = 0;
  const configuredMinNewSessions = extractConfig.profiles?.improve?.default?.processes?.extract?.minNewSessions;
  const minNewSessions =
    typeof configuredMinNewSessions === "number" ? configuredMinNewSessions : EXTRACT_DEFAULT_MIN_NEW_SESSIONS;
  // #593/#594: the ACTIVE resolved improve profile is the single source of
  // truth for whether extract runs. (Previously this also ANDed in the legacy
  // `session_extraction` feature flag, which only reads
  // `profiles.improve.default.processes.extract.enabled`; that made the default
  // profile a global kill switch, so a non-default profile enabling extract was
  // silently overridden. The default profile is now just another profile.)
  // `akmExtract` re-checks the same active profile internally via `improveProfile`.
  if (resolveProcessEnabled("extract", improveProfile)) {
    const availableHarnesses = options.extractHarnesses ?? getAvailableHarnesses();
    // The guard engages only when minNewSessions > 0; 0 disables it entirely.
    let belowMinNewSessions = false;
    if (minNewSessions > 0 && availableHarnesses.length > 0) {
      const countFn = options.extractCandidateCountFn ?? countNewExtractCandidates;
      const newCandidateCount = countFn(extractConfig, {
        ...(options.extractHarnesses ? { harnesses: options.extractHarnesses } : {}),
        // C2: pin the candidate-count state.db open to the boundary-resolved path.
        ...(eventsCtx?.dbPath ? { stateDbPath: eventsCtx.dbPath } : {}),
      });
      if (newCandidateCount < minNewSessions) {
        belowMinNewSessions = true;
        // Reuse the #551/#553 `improve_skipped` emission path so health's dynamic
        // skipReasons aggregation surfaces this under `below_min_new_sessions`.
        appendEvent(
          {
            eventType: "improve_skipped",
            ref: "memory:_extract",
            metadata: {
              reason: "below_min_new_sessions",
              newSessions: newCandidateCount,
              minNewSessions,
            },
          },
          eventsCtx,
        );
        info(`[improve] extract skipped (new sessions ${newCandidateCount} < minNewSessions ${minNewSessions})`);
      }
    }
    if (!belowMinNewSessions && availableHarnesses.length > 0) {
      extractResults = [];
      for (const h of availableHarnesses) {
        try {
          const result = await withLlmStage("session-extraction", () =>
            akmExtract({
              type: h.name,
              ...(primaryStashDir !== undefined ? { stashDir: primaryStashDir } : {}),
              config: extractConfig,
              // Thread the ACTIVE profile so extract's internal gate + per-process
              // config read the running profile, not always `default`.
              improveProfile,
              dryRun: options.dryRun ?? false,
              ...(options.extractHarnesses ? { harnesses: options.extractHarnesses } : {}),
              // C2: pin extract's skip-tracking state.db open to the boundary path.
              ...(eventsCtx?.dbPath ? { stateDbPath: eventsCtx.dbPath } : {}),
            }),
          );
          extractResults.push(result);

          {
            const gr = await runAutoAcceptGate(
              primaryStashDir
                ? result.proposals.map((proposalId) => {
                    const proposal = getProposal(primaryStashDir, proposalId);
                    return { proposalId, confidence: resolveExtractConfidence(proposal) };
                  })
                : [],
              extractGateCfg,
            );
            gateAutoAcceptedCount += gr.promoted.length;
            gateAutoAcceptFailedCount += gr.failed.length;
          }
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
      const backlogGr = await runAutoAcceptGate(backlogCandidates, extractGateCfg);
      gateAutoAcceptedCount += backlogGr.promoted.length;
      gateAutoAcceptFailedCount += backlogGr.failed.length;
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
      // #591: use the path pre-resolved at planning time when it is still on
      // disk — a serial async DB lookup per ref cost ~500 s on a 9 000-ref
      // stash. Fall back to findAssetFilePath only for refs that bypassed
      // collectEligibleRefs' index scan or whose file moved since planning.
      const filePath =
        candidate.filePath && fs.existsSync(candidate.filePath)
          ? candidate.filePath
          : await findAssetFilePath(candidate.ref, options.stashDir);
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
  //   noFeedbackPool      — neither signal-delta gate passes *and* the ref has
  //                         no recent feedback signal at all. These are NOT
  //                         skipped here: they are handed to the high-retrieval
  //                         fallback (P0-A) below so frequently-retrieved but
  //                         never-rated assets can still be improved. Only refs
  //                         that P0-A declines are ultimately fully skipped.
  //   fullySkippedCount   — has stale feedback but no signal delta → genuine
  //                         skip (counted, aggregated event emitted post-loop),
  //                         excluded from sort.
  const eligibleRefs: ImproveEligibleRef[] = [];
  const distillOnlyRefs: ImproveEligibleRef[] = [];
  // Zero-(recent-)feedback refs deferred to the P0-A high-retrieval fallback.
  const noFeedbackPool: ImproveEligibleRef[] = [];
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
    } else if (!latestFeedbackTs.has(r.ref)) {
      // Neither signal-delta gate passes AND there is no recent feedback signal
      // at all. Rather than skip outright, defer to the high-retrieval fallback
      // (P0-A) below: a never-rated-but-frequently-retrieved asset is exactly
      // what that path is meant to rescue. Refs P0-A declines are skipped there.
      noFeedbackPool.push(r);
    } else {
      // Has feedback on record but no signal delta since the last proposal —
      // genuinely fully skipped. Counted here; a single aggregated
      // improve_skipped event is emitted after the loop (mirrors
      // profile_filtered_all_passes) instead of one event per ref.
      fullySkippedCount++;
      actions.push({
        ref: r.ref,
        mode: "distill-skipped",
        result: { ok: true, reason: "no new signal since last proposal" },
      });
    }
  }

  // Emit ONE aggregated skip event for the fully-skipped bucket rather than one
  // improve_skipped event per ref (#592 pattern, mirrors
  // profile_filtered_all_passes above). The per-ref loop previously produced
  // ~11K state.db writes per run on a large stash, the dominant contributor to
  // 900 s timeouts. The in-memory `actions` log keeps the per-ref detail for the
  // run summary; no downstream consumer needs a per-ref DB audit trail (health's
  // skip histogram reads the `no_new_signal` counter from the count field).
  if (fullySkippedCount > 0) {
    appendEvent(
      {
        eventType: "improve_skipped",
        ref: undefined,
        metadata: {
          reason: "no_new_signal",
          count: fullySkippedCount,
        },
      },
      eventsCtx,
    );
  }

  // ── Phase 4: signal/feedback/utility/sort on the reduced set ──────────────
  // Everything from here works on (eligibleRefs ∪ distillOnlyRefs) plus the
  // deferred noFeedbackPool that may be rescued by the high-retrieval fallback
  // (P0-A). The fully-skipped bucket has already been routed and its aggregated
  // event emitted; we deliberately avoid spending DB/CPU on refs that the
  // signal-delta gate rejected with feedback already on record.
  const processableRefs: ImproveEligibleRef[] = [...eligibleRefs, ...distillOnlyRefs];

  // Refs eligible for the high-retrieval fallback (P0-A): the signal-delta
  // partition above could not place these in a reflect/distill bucket, but they
  // may still qualify if they have been retrieved often enough. Two disjoint
  // sources feed this set:
  //   1. noFeedbackPool — refs with no recent feedback that the partition loop
  //      deliberately deferred here (otherwise they would never reach P0-A).
  //   2. processableRefs entries that turn out to carry no recent feedback
  //      *signal* once feedbackSummary is computed below.
  // (1) is added here; (2) is folded in after feedbackSummary is built.

  // Gap 6: only surface feedback signals from the last 30 days so that
  // ancient one-off feedback events don't permanently lock an asset into
  // every improve run. Assets with only stale signals fall through to the
  // high-retrieval path (P0-A) or are skipped until new signals arrive.
  // (FEEDBACK_SIGNAL_WINDOW_DAYS / feedbackSinceCutoff are already defined in
  // Phase 2 above for the signal-delta gate; we reuse them here.)

  // Pre-compute feedback summary per ref in a single pass so we don't issue
  // two readEvents({type:"feedback", ref}) per asset (one for signal filtering,
  // one for ratio computation).
  // Cover processableRefs *and* the deferred noFeedbackPool so utility/feedback
  // ratios are available for any noFeedbackPool ref that P0-A rescues below.
  const feedbackSummary = new Map<string, { hasSignal: boolean; positive: number; negative: number }>();
  for (const candidate of [...processableRefs, ...noFeedbackPool]) {
    if (feedbackSummary.has(candidate.ref)) continue;
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
  // Zero-feedback candidates for P0-A: processableRefs without a recent signal,
  // plus the deferred noFeedbackPool. Dedupe by ref (the two sources are
  // disjoint by construction, but guard against overlap defensively).
  const noFeedbackSeen = new Set<string>();
  const noFeedbackCandidates: ImproveEligibleRef[] = [];
  for (const r of [...processableRefs.filter((r) => !signalBearingSet.has(r.ref)), ...noFeedbackPool]) {
    if (noFeedbackSeen.has(r.ref)) continue;
    noFeedbackSeen.add(r.ref);
    noFeedbackCandidates.push(r);
  }

  let highRetrievalRefs: ImproveEligibleRef[] = [];
  // Retrieval counts for the zero-feedback pool, hoisted so the Layer-2
  // proactive-maintenance selector below can reuse them without a second DB pass.
  // Also fetch lastUseMs here for the proactive-maintenance recency term (plan §WS-1
  // step 2: recency is MANDATORY — never pinned to floor).
  let retrievalCounts = new Map<string, number>();
  let lastUseMsForProactive = new Map<string, number>();
  let dbForRetrieval: import("../../storage/database").Database | undefined;
  try {
    dbForRetrieval = openExistingDatabase();
    const showEventCount = countUsageEventsByType(dbForRetrieval, "show");
    if (showEventCount === 0) {
      warn(
        "Warning: show events not yet in usage_events — zero-feedback fallback will match only search-retrieved assets.",
      );
    }
    // Fetch retrieval counts for ALL candidates — not only the zero-feedback pool.
    // Previously only noFeedbackCandidates were looked up, so feedback-bearing refs
    // had retrievalFreq=0 in computeSalience(), collapsing their retrievalSalience
    // to 0 regardless of actual use. Two assets of the same type — one
    // heavily-retrieved, one never-touched — would receive identical rankScores.
    // Fix (WS-1 blocker 3): union the feedback pool into the lookup.
    const allCandidateRefs = [...new Set([...signalFiltered, ...noFeedbackCandidates].map((r) => r.ref))];
    retrievalCounts = getRetrievalCounts(dbForRetrieval, allCandidateRefs);
    lastUseMsForProactive = getLastUseMsByRef(
      dbForRetrieval,
      noFeedbackCandidates.map((r) => r.ref),
    );
    // High-retrieval signal-delta (simplified rule, 0.8.0): a no-feedback
    // ref qualifies exactly once — when it has actually been retrieved
    // (retrievalCount ≥ 1) AND retrievalCount ≥ threshold AND no prior reflect
    // proposal exists for it. Once a reflect proposal is on record, subsequent
    // re-eligibility requires explicit feedback (which flows through the normal
    // signal-delta gate above). The explicit `> 0` guard keeps a threshold of 0
    // from rescuing genuinely never-retrieved assets — the fallback is for
    // *retrieved* assets, not silent ones. Tracking growth in retrieval count
    // would require persisting the count in proposal metadata; deferred to a
    // follow-up.
    highRetrievalRefs = noFeedbackCandidates.filter((r) => {
      const count = retrievalCounts.get(r.ref) ?? 0;
      return count > 0 && count >= RETRIEVAL_COUNT_THRESHOLD && !lastReflectProposalTs.has(r.ref);
    });
  } catch (err) {
    rethrowIfTestIsolationError(err);
    // best-effort: if DB unavailable, highRetrievalRefs stays empty
  } finally {
    if (dbForRetrieval) closeDatabase(dbForRetrieval);
  }

  // ── Layer 2: PROACTIVE MAINTENANCE SELECTOR (third eligibility source) ─────
  // The signal-delta gate and P0-A only surface assets with fresh feedback or a
  // raw-retrieval spike. Neither revisits a stable, high-value asset on a
  // schedule, so on a quiet stash useful assets drift stale and are never
  // refreshed. When the `proactiveMaintenance` process is enabled (DEFAULT OFF)
  // and the run is whole-stash / type scope, this selector ranks the eligible
  // population by a composite maintenance priority, gates on staleness ("due"),
  // bounds to top-N, and folds the winners into the SAME candidate set the other
  // two sources feed — so they flow through the existing #580 empty-diff /
  // cosmetic suppression and additive-distill gates. It adds no new mutation
  // logic of its own. The due gate doubles as the rotation cooldown: a freshly
  // reflected asset is excluded until it ages back past `dueDays`, so successive
  // runs rotate through the due pool rather than re-selecting the same heads.
  let proactiveRefs: ImproveEligibleRef[] = [];
  let proactiveMaintenanceSummary: { selected: number; dueTotal: number; neverReflected: number } | undefined;
  const proactiveEnabled = scope.mode !== "ref" && resolveProcessEnabled("proactiveMaintenance", improveProfile);
  if (proactiveEnabled) {
    const pmCfg = improveProfile.processes?.proactiveMaintenance;
    const dueDays = pmCfg?.dueDays ?? DEFAULT_DUE_DAYS;
    const maxPerRun = pmCfg?.maxPerRun ?? pmCfg?.limit ?? DEFAULT_MAX_PER_RUN;

    // Candidate population: the zero-feedback / non-signal pool — exactly the
    // assets the other two sources would NOT pick this run. Exclude any P0-A
    // rescued this run so we never double-select the same ref.
    const alreadySelected = new Set(highRetrievalRefs.map((r) => r.ref));
    const pmCandidates = noFeedbackCandidates.filter((r) => !alreadySelected.has(r.ref));

    const selection = selectProactiveMaintenanceRefs({
      candidates: pmCandidates,
      lastReflectTs: lastReflectProposalTs,
      lastDistillTs: lastDistillProposalTs,
      retrievalCounts,
      // WS-1: wire lastUseMs so the recency decay term is genuine (plan §step 2).
      lastUseMs: lastUseMsForProactive,
      sizeBytesOf: (r) => {
        const fp = r.filePath;
        if (!fp) return undefined;
        try {
          return fs.statSync(fp).size;
        } catch {
          return undefined;
        }
      },
      dueDays,
      maxPerRun,
    });

    proactiveRefs = selection.selected;
    proactiveMaintenanceSummary = {
      selected: selection.selected.length,
      dueTotal: selection.dueTotal,
      neverReflected: selection.neverReflected,
    };

    // Aggregated observability event (never per-ref — avoids the event flood the
    // Layer-1 work eliminated). Mirrors the `no_new_signal` aggregation pattern.
    appendEvent(
      {
        eventType: "proactive_selected",
        ref: undefined,
        metadata: {
          count: selection.selected.length,
          dueTotal: selection.dueTotal,
          neverReflected: selection.neverReflected,
        },
      },
      eventsCtx,
    );
    if (selection.selected.length > 0) {
      info(
        `[improve] proactive maintenance selected ${selection.selected.length}/${selection.dueTotal} due refs ` +
          `(${selection.neverReflected} never reflected, dueDays=${dueDays}, maxPerRun=${maxPerRun})`,
      );
    }
  }

  // Record an in-memory skip action for every zero-feedback ref that the
  // partition loop deferred to P0-A but P0-A then declined (retrievalCount below
  // threshold, or a prior reflect proposal already on record). These never make
  // it into mergedRefs, so without this they would silently vanish from the run
  // summary. No DB event is written here — these refs carry no signal at all, so
  // there is nothing for the skip histogram to aggregate; the action log alone
  // preserves the per-ref audit trail (mirrors the fully-skipped action above).
  const rescuedSet = new Set([...highRetrievalRefs, ...proactiveRefs].map((r) => r.ref));
  for (const r of noFeedbackPool) {
    if (rescuedSet.has(r.ref)) continue;
    actions.push({
      ref: r.ref,
      mode: "distill-skipped",
      result: { ok: true, reason: "no new signal since last proposal" },
    });
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
  // Layer-2 proactive refs join the eligible set alongside feedback-signal and
  // high-retrieval (P0-A) refs. The three sources are disjoint by construction
  // (proactive draws from noFeedbackCandidates with the P0-A picks removed), but
  // dedupe defensively so a ref can never enter the loop twice. `requireFeedbackSignal`
  // still suppresses both fallback sources for callers that want feedback-only runs.
  const signalAndRetrievalRefs = dedupeRefs([...signalFiltered, ...highRetrievalRefs, ...proactiveRefs]);
  let mergedRefs =
    scope.mode === "ref" ? processableRefs : options.requireFeedbackSignal ? signalFiltered : signalAndRetrievalRefs;

  // ── Attribution tagging: stamp each ref with the eligibility lane that
  // selected it ──────────────────────────────────────────────────────────────
  // Every reflect/distill proposal must record WHICH lane chose its source asset
  // so downstream accept/reject/revert/retrieval outcomes can be sliced by lane
  // (does the PROACTIVE lane produce value vs the reactive lanes?). We build the
  // lane map here — the one place all four lanes are known — and stamp it onto
  // each ImproveEligibleRef object. Because the ref objects are shared by
  // reference across buckets, the stamp travels with the ref through the sort,
  // disk-check, and loop stages down to the reflect/distill event emit sites and
  // createProposal calls. See EligibilitySource for the lane vocabulary.
  //
  // Precedence (prefer the most specific reactive signal):
  //   scope > signal-delta > high-retrieval > proactive
  // A ref with real feedback is attributed to feedback even if it was also due
  // for proactive maintenance. We apply lanes weakest-first so the strongest
  // overwrites; the explicit --scope <ref> bypass wins outright (user intent).
  const eligibilitySourceByRef = new Map<string, EligibilitySource>();
  for (const r of proactiveRefs) eligibilitySourceByRef.set(r.ref, "proactive");
  for (const r of highRetrievalRefs) eligibilitySourceByRef.set(r.ref, "high-retrieval");
  for (const r of signalFiltered) eligibilitySourceByRef.set(r.ref, "signal-delta");
  if (scope.mode === "ref") {
    // O-2 (#365): explicit --scope <ref> bypass — every ref in processableRefs
    // arrived via the scopeRefBypass branch, so attribute the whole set to scope.
    for (const r of processableRefs) eligibilitySourceByRef.set(r.ref, "scope");
  }
  for (const r of mergedRefs) {
    // "unknown" is a genuine fallback, never a silent alias for signal-delta:
    // only refs we truly cannot attribute land here (none in practice, since
    // mergedRefs is always a subset of the four lanes above).
    r.eligibilitySource = eligibilitySourceByRef.get(r.ref) ?? "unknown";
  }

  // WS-1 — Unified salience vector (S1 seam).
  //
  // The legacy sort combined three independent formulas (utility EMA, negative-only
  // ratio / symmetric-valence magnitude, and the proactive-maintenance priority
  // formula). WS-1 converges them into one `computeSalience()` call per ref, with
  // three independently-stored sub-scores and one documented rankScore projection.
  //
  // Migration note: if a profile still has `symmetricValence` set, emit a one-time
  // warning — its behaviour (symmetric |valence| attention) is now always-on as
  // part of the salience vector, so the knob is a no-op and will be removed in 0.10.
  if (improveProfile.symmetricValence === true) {
    warn(
      "[improve] Profile option 'symmetricValence' is deprecated (WS-1 salience vector). " +
        "Symmetric valence is now always active; remove the option from your improve profile.",
    );
  }

  // Fetch last-use timestamps from the index DB for the full merged set so the
  // recency term in retrievalSalience is genuinely decayable (plan §WS-1 step 2).
  // This reuses the index DB opened earlier for retrieval counts; a separate
  // lightweight open is used here to avoid holding the connection longer than needed.
  let lastUseMsByRef = new Map<string, number>();
  // utilityMap is kept for backward-compatible observability (health report reads it).
  const utilityMap = buildUtilityMap(mergedRefs);
  let dbForSalience: import("../../storage/database").Database | undefined;
  try {
    dbForSalience = openExistingDatabase();
    lastUseMsByRef = getLastUseMsByRef(
      dbForSalience,
      mergedRefs.map((r) => r.ref),
    );
  } catch (err) {
    rethrowIfTestIsolationError(err);
    // best-effort: if DB unavailable, recency term stays at floor (lastUseMs=0)
  } finally {
    if (dbForSalience) closeDatabase(dbForSalience);
  }

  // Compute the salience vector for every ref in the merged set.
  // retrievalCounts now covers the full candidate set (feedback-bearing + zero-feedback)
  // so feedback refs get their genuine retrieval frequency, not a 0-floor fallback.
  const salienceMap = new Map<string, ReturnType<typeof computeSalience>>();
  const nowForSalience = Date.now();
  for (const r of mergedRefs) {
    const type = r.ref.includes(":") ? r.ref.slice(0, r.ref.indexOf(":")) : "";
    const sizeBytes = (() => {
      const fp = r.filePath;
      if (!fp) return undefined;
      try {
        return fs.statSync(fp).size;
      } catch {
        return undefined;
      }
    })();
    const vector = computeSalience({
      ref: r.ref,
      type,
      retrievalFreq: retrievalCounts.get(r.ref) ?? 0,
      lastUseMs: lastUseMsByRef.get(r.ref),
      utilityScore: utilityMap.get(r.ref),
      sizeBytes,
      now: nowForSalience,
    });
    salienceMap.set(r.ref, vector);
  }

  // Persist salience vectors to state.db (best-effort, non-blocking).
  // The canonical store enables WS-3 homeostatic demotion and WS-2 outcome reads.
  //
  // Forgetting-safety report (plan §WS-1 step 7) — stash-wide rank comparison:
  //
  // BEFORE persisting the new rankScores, read ALL existing rows from state.db
  // (not just the per-run candidate pool). This gives stash-wide rank positions so
  // the top-200/below-500 thresholds are meaningful.
  //
  // Two distinct scenarios:
  //
  // A. First WS-1 run (table empty): the old combinedEligibilityScore ordering was
  //    never captured in state.db (asset_salience is a new WS-1 table), so there is
  //    no baseline to compare against. Emit `improve_salience_first_run` to mark the
  //    cutover moment; skip the rank-change report since comparing new→new is
  //    meaningless for forgetting detection.
  //
  // B. Subsequent runs (table has rows): use ALL existing rows as old ranks, merge
  //    them with the current run's salienceMap updates for new ranks, and call
  //    buildRankChangeReport with stash-wide positions. This detects real rank drift
  //    — e.g. a retrieval-pattern shift causing a previously top-200 asset to slip
  //    below position 500.
  //
  // Measurement-protocol deferral (plan §269, Part-V):
  // The Part-V T0 baseline (scripts/akm-eval + health report) and the throughput/
  // quality gate are deferred pending owner sign-off. Full measurement requires a
  // before/after `akm health` report. Owner-acknowledged deferral: WS-2 landing
  // will re-introduce outcome salience and trigger the full re-tuning pass at that
  // time. See WS-2-HOOK in salience.ts.
  //
  // Forgetting-safety collection: populated inside scenario B below, consumed
  // after the try/catch to union candidates into mergedRefs before the sort.
  // Only refs from a real pre-existing ordering (scenario B) are collected;
  // empty on scenario A or when no candidates dropped below the threshold.
  let pendingForgettingRefs: string[] = [];
  try {
    const stateDb = openStateDatabase(eventsCtx?.dbPath);
    try {
      // Step 7: stash-wide rank-change report BEFORE overwriting the table.
      //
      // Load ALL existing rows so rank positions are stash-relative, not pool-relative.
      const existingAllScores = getAllRankScores(stateDb);

      if (existingAllScores.size === 0) {
        // Scenario A: first WS-1 run — table empty, no baseline for comparison.
        // Mark the cutover moment without emitting a false rank-change comparison.
        appendEvent(
          {
            eventType: "improve_salience_first_run",
            ref: undefined,
            metadata: {
              candidateCount: salienceMap.size,
              note: "first WS-1 salience run — no pre-existing baseline; combinedEligibilityScore ordering was not captured",
            },
          },
          eventsCtx,
        );
      } else {
        // Scenario B: subsequent run — compare stash-wide old vs. new ranks.
        //
        // Build new scores by merging the full table with this run's updates.
        // Refs in salienceMap override their stored value; refs not in this run
        // retain their stored value unchanged. This gives a complete stash-wide
        // picture of what the new ordering looks like after this run.
        const mergedNewScores = new Map<string, number>(existingAllScores);
        for (const [ref, vector] of salienceMap) {
          mergedNewScores.set(ref, vector.rankScore);
        }

        // Assign 1-indexed rank positions sorted by score desc (tie-break: ref asc).
        const toRanks = (scores: Map<string, number>): Map<string, number> => {
          const sorted = [...scores.entries()].sort(([refA, a], [refB, b]) =>
            b !== a ? b - a : refA < refB ? -1 : refA > refB ? 1 : 0,
          );
          return new Map(sorted.map(([ref], i) => [ref, i + 1]));
        };

        const oldRanks = toRanks(existingAllScores);
        const newRanks = toRanks(mergedNewScores);

        const report = buildRankChangeReport(oldRanks, newRanks);
        if (report.forgettingCandidates.length > 0) {
          warn(
            `[improve/salience] WS-1 rank-change report: ${report.forgettingCandidates.length} asset(s) fell from top-200 to below position 500. ` +
              `Top drops: ${report.forgettingCandidates
                .slice(0, 5)
                .map((e) => `${e.ref} (#${e.oldRank}→#${e.newRank})`)
                .join(", ")}`,
          );
          // Collect refs for protective consolidation pass (plan §WS-1 step 7).
          // These are force-included in the candidate pool (mergedRefs) after
          // this try block, bypassing cooldown/signal-delta gating.
          pendingForgettingRefs = report.forgettingCandidates.map((e) => e.ref);
        }
        appendEvent(
          {
            eventType: "improve_salience_rank_change",
            ref: undefined,
            metadata: {
              stashSize: existingAllScores.size,
              totalChanged: report.allChanges.length,
              forgettingCandidates: report.forgettingCandidates.length,
              topDrops: report.forgettingCandidates.slice(0, 10).map((e) => ({
                ref: e.ref,
                oldRank: e.oldRank,
                newRank: e.newRank,
              })),
            },
          },
          eventsCtx,
        );
      }

      for (const [ref, vector] of salienceMap) {
        upsertAssetSalience(stateDb, ref, vector, nowForSalience);
      }
    } finally {
      stateDb.close();
    }
  } catch (err) {
    rethrowIfTestIsolationError(err);
    // best-effort: salience persistence failure never blocks ranking
  }

  // ── Protective consolidation pass (plan §WS-1 step 7) ─────────────────────
  // Forgetting candidates detected in scenario B are force-injected into
  // mergedRefs here, BEFORE the effectiveScore sort, bypassing cooldown and
  // signal-delta gating. Any ref already present in mergedRefs keeps its
  // existing eligibilitySource (stronger reactive signals win); refs not yet in
  // the pool are synthesised as minimal ImproveEligibleRef stubs and labelled
  // 'forgetting-safety' so S5/WS-5 can slice by lane. The dedupeRefs call
  // ensures no ref can enter the loop twice.
  if (pendingForgettingRefs.length > 0 && scope.mode !== "ref") {
    const existingRefSet = new Set(mergedRefs.map((r) => r.ref));
    const newForgettingRefs: ImproveEligibleRef[] = [];
    for (const ref of pendingForgettingRefs) {
      if (!existingRefSet.has(ref)) {
        // Ref not already in the candidate pool — synthesise a stub so it
        // participates in the reflect/distill loop with proper attribution.
        newForgettingRefs.push({ ref, reason: "scope-type", eligibilitySource: "forgetting-safety" });
      }
      // Always stamp the lane in the attribution map (overwrites weaker lanes;
      // stronger reactive signals — scope/signal-delta/high-retrieval/proactive
      // — are written after this block so they take precedence).
      eligibilitySourceByRef.set(ref, "forgetting-safety");
    }
    if (newForgettingRefs.length > 0) {
      mergedRefs = dedupeRefs([...mergedRefs, ...newForgettingRefs]);
    }
    // Re-stamp attribution for any refs whose lane needs updating.
    // Precedence (weakest → strongest, each overwrites the previous):
    //   proactive < high-retrieval < forgetting-safety < signal-delta
    // Scope mode is already excluded by the outer guard (`scope.mode !== "ref"`).
    // forgetting-safety sits above proactive and high-retrieval so that a ref
    // flagged as a forgetting candidate is always visible to S5/WS-5 as such,
    // even when it was also due for a proactive maintenance run. signal-delta
    // overrides forgetting-safety because a ref with fresh feedback is reactive
    // and doesn't need the protective pass label for measurement purposes.
    for (const r of proactiveRefs) eligibilitySourceByRef.set(r.ref, "proactive");
    for (const r of highRetrievalRefs) eligibilitySourceByRef.set(r.ref, "high-retrieval");
    // Apply forgetting-safety OVER proactive and high-retrieval (already stamped
    // in the loop above via `eligibilitySourceByRef.set(ref, "forgetting-safety")`).
    // No-op here: the set() calls above for proactive/high-retrieval overwrite the
    // earlier forgetting-safety stamp — so we re-apply forgetting-safety now for
    // those refs that are both forgetting candidates AND proactive/high-retrieval.
    for (const ref of pendingForgettingRefs) {
      eligibilitySourceByRef.set(ref, "forgetting-safety");
    }
    // signal-delta is the strongest reactive signal and overrides forgetting-safety.
    for (const r of signalFiltered) eligibilitySourceByRef.set(r.ref, "signal-delta");
    // Update eligibilitySource on the ref objects themselves for any refs whose
    // lane changed (covers both new stubs and pre-existing refs).
    for (const r of mergedRefs) {
      r.eligibilitySource = eligibilitySourceByRef.get(r.ref) ?? "unknown";
    }
  }

  // Build no-op map for consolidation-selection dampener (plan §WS-1 step 8).
  // Reads consecutive_no_ops from the SAME pinned db handle used elsewhere in
  // this function.  The effective score is used ONLY for processing/selection
  // order — the persisted rank_score in asset_salience is never mutated here.
  const noOpMap = new Map<string, number>();
  try {
    const noOpDb = eventsCtx?.db ?? (eventsCtx?.dbPath ? openStateDatabase(eventsCtx.dbPath) : null);
    if (noOpDb) {
      const ownsNoOpDb = !eventsCtx?.db;
      try {
        for (const r of mergedRefs) {
          noOpMap.set(r.ref, getConsecutiveNoOps(noOpDb, r.ref));
        }
      } finally {
        if (ownsNoOpDb) noOpDb.close();
      }
    }
  } catch {
    // best-effort: dampener failure never blocks selection
  }

  // Sort by effective selection score (desc), with explicit ref-string tie-break
  // for determinism.  The effective score applies the consolidation-selection
  // dampener: assets that have been repeatedly skipped (consecutive_no_ops >=
  // THRESHOLD) are penalised by FACTOR so they sort after peers with similar
  // rankScore.  The persisted rank_score is left unchanged — this is the whole
  // point of the dampener (stable assets stay fully retrievable).
  //
  // This is the ONLY ranking path — negativeOnlyRatio and the legacy
  // symmetricValence branch are replaced. The three eligibilitySource lanes
  // (signal-delta / high-retrieval / proactive) survive as labels (set above).

  const effectiveScore = (ref: string): number => {
    const rankScore = salienceMap.get(ref)?.rankScore ?? 0;
    const noOps = noOpMap.get(ref) ?? 0;
    return noOps >= SALIENCE_NO_OP_DAMPEN_THRESHOLD ? rankScore * SALIENCE_NO_OP_DAMPEN_FACTOR : rankScore;
  };
  const sorted = [...mergedRefs].sort((a, b) => {
    const scoreA = effectiveScore(a.ref);
    const scoreB = effectiveScore(b.ref);
    if (scoreB !== scoreA) return scoreB - scoreA;
    // Stable tie-break: deterministic regardless of input ordering.
    return a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0;
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
    // #591: prefer the path pre-resolved at planning time (synchronous
    // existsSync) over a serial async DB lookup per ref.
    const filePath =
      candidate.filePath && fs.existsSync(candidate.filePath)
        ? candidate.filePath
        : await findAssetFilePath(candidate.ref, options.stashDir);
    if (filePath && fs.existsSync(filePath)) {
      existsCheckedActionable.push(candidate);
    } else {
      assetMissingOnDisk.push(candidate.ref);
    }
  }
  // #592 audit: one summary event instead of one per missing ref. Normally
  // tiny, but a stash deletion racing the run could make this O(n) sequential
  // state.db writes. `refs` is capped so the metadata row stays bounded.
  if (assetMissingOnDisk.length > 0) {
    appendEvent(
      {
        eventType: "improve_skipped",
        ref: undefined,
        metadata: {
          reason: "asset_missing_on_disk",
          count: assetMissingOnDisk.length,
          refs: assetMissingOnDisk.slice(0, 50),
        },
      },
      eventsCtx,
    );
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
    gateAutoAcceptFailedCount,
    consolidation: consolidationPass.consolidation,
    consolidationRan: consolidationPass.consolidationRan,
    ...(proactiveMaintenanceSummary ? { proactiveMaintenance: proactiveMaintenanceSummary } : {}),
  };
}

// TODO(refactor): 13 args including `actions`/`recentErrors` mutation channels. Restructure into immutable plan + mutable context objects — deferred to dedicated refactor with isolated testing.
/**
 * Parameter object for {@link runImproveLoopStage} (WS10). Pure type reshape of
 * the former inline arg struct — every field, name, and type is preserved so the
 * function body and all runtime values are byte-identical. No control-flow change.
 */
export interface ImproveRunContext {
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
}

async function runImproveLoopStage(args: ImproveRunContext): Promise<ImproveLoopResult> {
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

  // requirePlannedRefs guard: when the distill profile sets this flag, skip
  // distill for distill-only refs if the reflect phase produced no planned refs.
  // Prevents the distill loop from generating hundreds of distill-skipped events
  // on quiet passes (all refs on reflect cooldown, no new signal to distill).
  const requirePlannedRefs = improveProfile?.processes?.distill?.requirePlannedRefs === true;
  const _distillOnlyRefNames = new Set(distillOnlyRefs.map((r) => r.ref));
  const hasReflectEligibleRefs = loopRefs.some((r) => !_distillOnlyRefNames.has(r.ref));
  const skipDistillDueToRequirePlannedRefs = requirePlannedRefs && !hasReflectEligibleRefs;

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
  let gateAutoAcceptFailedCount = 0;
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
        // Type guard: skip reflect for unsupported types (script, env, task, etc.)
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
            // Attribution: carry the eligibility lane so reflect stamps it on
            // the reflect_invoked event and the persisted proposal.
            ...(planned.eligibilitySource ? { eligibilitySource: planned.eligibilitySource } : {}),
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
              samples.push(await withLlmStage("reflect", () => reflectFn({ ...reflectCallArgs, draftMode: true })));
            }
            const winner = pickMajorityVote(
              samples.length > 0
                ? samples
                : [await withLlmStage("reflect", () => reflectFn({ ...reflectCallArgs, draftMode: true }))],
            );
            // Persist only the majority-vote winner as a single real proposal.
            if (winner.ok && primaryStashDir) {
              const persistResult = createProposal(primaryStashDir, {
                ref: winner.proposal.ref,
                source: "reflect",
                sourceRun: `reflect-sc-${Date.now()}`,
                payload: winner.proposal.payload,
                // Attribution: the self-consistency path persists the winner here
                // (draftMode skips reflect's own createProposal), so stamp the lane.
                ...(planned.eligibilitySource ? { eligibilitySource: planned.eligibilitySource } : {}),
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
            reflectResult = await withLlmStage("reflect", () => reflectFn(reflectCallArgs));
          }
          const isCooldown = !reflectResult.ok && reflectResult.reason === "cooldown";
          // Content-policy guard hits (reflect size-rail rejections) are NOT
          // LLM faults — the agent responded fine, the downstream guard
          // blocked the output. Route them to a distinct `reflect-guard-rejected`
          // mode so health metrics can split deterministic guard hits out of
          // true LLM failures. See
          // `/tmp/akm-health-investigations/metrics-taxonomy-review.md` §1a.
          const isGuardReject = !reflectResult.ok && reflectResult.reason === "content_policy_reject";
          // Type-guard rejection (reflect refused a script/env/task ref) is
          // also NOT an LLM failure — the LLM is never invoked. Route to the
          // existing `reflect-skipped` bucket so it does not inflate the
          // failure-rate numerator. ~9% of `reflect-failed` events in the
          // user's stack were this case; see review §1a row "Reflect refused
          // asset type".
          const isTypeRefused = !reflectResult.ok && reflectResult.reason === "unsupported_type";
          // Noise-gate suppression (#580): the candidate edit was an empty
          // diff or a cosmetic-only reformat of the current asset. Like
          // `unsupported_type`, this is a deterministic skip — not an LLM
          // fault — so it routes to the `reflect-skipped` bucket and stays
          // out of recentErrors/avoidPatterns.
          const isNoChange = !reflectResult.ok && reflectResult.reason === "no_change";
          actions.push({
            ref: planned.ref,
            mode: reflectResult.ok
              ? "reflect"
              : isCooldown
                ? "reflect-cooldown"
                : isGuardReject
                  ? "reflect-guard-rejected"
                  : isTypeRefused || isNoChange
                    ? "reflect-skipped"
                    : "reflect-failed",
            result: reflectResult,
          });
          // Cooldown skips, guard rejects, type-refused skips, and noise-gate
          // skips are not failures — do not pollute recentErrors with them
          // (those get injected as `avoidPatterns` into the next reflect
          // prompt). Guard rejects ARE worth showing the LLM as a learn-signal
          // so the next iteration sees "your last expansion was too large";
          // type-refused and no-change are deterministic and add no learning
          // signal.
          if (!reflectResult.ok && !isCooldown && !isTypeRefused && !isNoChange) {
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

          // Plasticity counter (plan §WS-1 step 8): record no-ops so the
          // WS-1 selection comparator (effectiveScore, ~line 3073) can dampen
          // repeatedly-silent assets during consolidation-selection.
          // A no_change reflect means the LLM was invoked but found nothing to
          // improve — the asset is stable. Track it. A successful reflect means
          // the asset changed; reset the counter so the dampener lifts.
          if (isNoChange && eventsCtx?.db) {
            try {
              recordNoOp(eventsCtx.db, planned.ref);
            } catch {
              // best-effort: plasticity counter failure never blocks the run
            }
          } else if (reflectResult.ok && eventsCtx?.db) {
            try {
              resetConsecutiveNoOps(eventsCtx.db, planned.ref);
            } catch {
              // best-effort
            }
          }

          if (reflectResult.ok) {
            const reflectGr = await runAutoAcceptGate(
              [{ proposalId: reflectResult.proposal.id, confidence: reflectResult.proposal.confidence }],
              reflectGateCfg,
            );
            gateAutoAcceptedCount += reflectGr.promoted.length;
            gateAutoAcceptFailedCount += reflectGr.failed.length;
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
      // requirePlannedRefs guard: skip distill for distill-only refs when no
      // reflect-eligible refs were planned this run, preventing mass skip events.
      if (skipDistillDueToRequirePlannedRefs && isDistillOnly) {
        actions.push({
          ref: planned.ref,
          mode: "distill-skipped",
          result: { ok: true, reason: "require_planned_refs" },
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

        const distillResult = await withLlmStage("distill", () =>
          distillFn({
            ref: planned.ref,
            ...(parsedPlannedRef.type === "memory" ? { proposalKind: "auto" as const } : {}),
            ...(options.stashDir ? { stashDir: options.stashDir } : {}),
            // Attribution: carry the eligibility lane so distill stamps it on the
            // distill_invoked event and the persisted proposal.
            ...(planned.eligibilitySource ? { eligibilitySource: planned.eligibilitySource } : {}),
          }),
        );
        actions.push({ ref: planned.ref, mode: "distill", result: distillResult });
        if (distillResult.outcome === "queued" && distillResult.proposal) {
          const distillGr = await runAutoAcceptGate(
            [{ proposalId: distillResult.proposal.id, confidence: distillResult.proposal.confidence }],
            distillGateCfg,
          );
          gateAutoAcceptedCount += distillGr.promoted.length;
          gateAutoAcceptFailedCount += distillGr.failed.length;
        }
        if (parsedPlannedRef.type === "memory") {
          const promotedToKnowledge = distillResult.outcome === "queued" && distillResult.proposalKind === "knowledge";
          if (!promotedToKnowledge) memoryRefsForInference.add(planned.ref);
        }
        // Plasticity counter (plan §WS-1 step 8) for the distill path.
        // quality_rejected: the LLM ran but produced output that didn't pass the
        // quality gate — the asset is not yielding useful distill output.
        // queued: a proposal was produced; reset the no-op counter.
        if (eventsCtx?.db) {
          try {
            if (distillResult.outcome === "quality_rejected" || distillResult.outcome === "skipped") {
              recordNoOp(eventsCtx.db, planned.ref);
            } else if (distillResult.outcome === "queued") {
              resetConsecutiveNoOps(eventsCtx.db, planned.ref);
            }
          } catch {
            // best-effort: plasticity counter failure never blocks the run
          }
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

  return { reflectsWithErrorContext, memoryRefsForInference, gateAutoAcceptedCount, gateAutoAcceptFailedCount };
}

async function runImprovePostLoopStage(args: {
  scope: ImproveScope;
  options: AkmImproveOptions;
  primaryStashDir?: string;
  actionableRefs: ImproveEligibleRef[];
  appliedCleanup?: Awaited<ReturnType<typeof applyMemoryCleanup>>;
  cleanupWarnings: string[];
  memoryRefsForInference: Set<string>;
  reindexFn: (options: { stashDir: string }) => Promise<unknown>;
  eventsCtx?: EventsContext;
  /** O-1 (#364): shared wall-clock AbortSignal; forwarded to maintenance passes. */
  budgetSignal?: AbortSignal;
  /** Active improve profile, resolved from profile name + config. */
  improveProfile?: import("./improve-profiles").ImproveProfileConfig;
  /**
   * #551: whether the consolidation pass (now run in the preparation stage,
   * before extract) actually processed memories. Drives the graph-extraction
   * reindex below — graph extraction must re-read the index if consolidation
   * mutated the memory pool.
   */
  consolidationRan: boolean;
}): Promise<ImprovePostLoopResult> {
  const {
    scope,
    options,
    primaryStashDir,
    actionableRefs,
    appliedCleanup,
    cleanupWarnings,
    memoryRefsForInference,
    reindexFn,
    eventsCtx,
    budgetSignal,
    improveProfile,
    consolidationRan,
  } = args;
  const allWarnings = [...cleanupWarnings, ...(appliedCleanup?.warnings ?? [])];
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
    // Consolidation's auto-accept gate counts now accrue in the preparation
    // stage (#551); post-loop no longer runs an auto-accept gate of its own.
    gateAutoAcceptedCount: 0,
    gateAutoAcceptFailedCount: 0,
  };
}

// TODO(refactor): mutates the passed-in `allWarnings` array as a hidden side channel. Return warnings in ImproveMaintenanceResult and merge in caller — invasive signature change deferred to next refactor pass.
// Exported for tests (#584/#585 DB-locking regression coverage); production
// callers reach it only through akmImprove → runImprovePostLoopStage.
export async function runImproveMaintenancePasses(args: {
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

  const openIndexDb = () =>
    openDatabase(getDbPath(), config.embedding?.dimension ? { embeddingDim: config.embedding.dimension } : undefined);

  // #584: reindexFn opens its own write handle on the same index.db WAL file.
  // Holding our handle across that call produced SQLITE_BUSY / "database is
  // locked" failures in production, so the handle is closed BEFORE every
  // reindex and reopened after — the fresh handle also sees the post-reindex
  // state that graph extraction and staleness detection below rely on. The
  // reopen runs in `finally` so a failed reindex still leaves a usable handle.
  const reindexWithIndexDbReleased = async (stashDir: string): Promise<void> => {
    if (db) {
      closeDatabase(db);
      db = undefined;
    }
    try {
      await reindexFn({ stashDir });
    } finally {
      db = openIndexDb();
    }
  };

  await withIndexWriterLease({ purpose: "improve-maintenance", signal: budgetSignal }, async () => {
    try {
      db = openIndexDb();

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
      const minPendingCount = improveProfile?.processes?.memoryInference?.minPendingCount;
      const pendingBelowMinCount = (() => {
        if (!primaryStashDir || minPendingCount === undefined || minPendingCount <= 0) return false;
        const pending = collectPendingMemories(primaryStashDir).length;
        if (pending < minPendingCount) {
          info(`[improve] memory inference skipped (${pending} pending < minPendingCount ${minPendingCount})`);
          return true;
        }
        return false;
      })();
      if (memoryInferenceDisabledByProfile) {
        info("[improve] memory inference skipped (disabled by improve profile)");
      } else if (pendingBelowMinCount) {
        // skipped — message already emitted above
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
          memoryInference = await withLlmStage("memory-inference", () =>
            memoryInferenceFn({
              config,
              sources,
              signal: budgetSignal,
              db,
              reEnrich: false,
              onProgress: (event) => {
                const current = event.currentRef ? ` ${event.currentRef}` : "";
                info(
                  `[improve] memory inference ${event.processed}/${event.total}${current} (written ${event.writtenFacts}, skipped ${event.skippedNoFacts})`,
                );
              },
            }),
          );
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
          await reindexWithIndexDbReleased(primaryStashDir);
          reindexedAfterInference = true;
          info("[improve] reindex after memory inference complete");
        } catch (err) {
          allWarnings.push(
            `reindex after memory inference failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      const graphEnabled = isProcessEnabled("index", "graph_extraction", config);
      const graphExtractionDisabledByProfile = improveProfile?.processes?.graphExtraction?.enabled === false;
      const graphExtractionFullScan = improveProfile?.processes?.graphExtraction?.fullScan === true;
      // Build the set of refs actually touched this run.
      const touchedRefs = new Set<string>();
      for (const r of args.actionableRefs) touchedRefs.add(r.ref);
      for (const r of memoryRefsForInference) touchedRefs.add(r);

      // INVARIANT: graph extraction normally runs only on files touched by
      // actionable refs (candidatePaths). Full-corpus scans are opt-in via
      // profile.processes.graphExtraction.fullScan = true (used by the
      // `graph-refresh` built-in profile and its weekly scheduled task).
      // The empty-Set fallback is intentional when no refs were touched —
      // the extractor's filter rejects every file and returns empty, keeping
      // the pass invoked so the action is recorded and tests stay exercised.
      if (graphExtractionDisabledByProfile) {
        info("[improve] graph extraction skipped (disabled by improve profile)");
      } else if (sources.length > 0 && graphEnabled) {
        info(`[improve] graph extraction starting${graphExtractionFullScan ? " (full-corpus scan)" : ""}`);
        const extractionStart = Date.now();
        try {
          // D9: if consolidation ran but memory inference did not reindex, force a reindex
          // so graph extraction sees current DB state after consolidation writes.
          if (consolidationRan && !reindexedAfterInference) {
            info("[improve] reindexing after consolidation (graph extraction needs current state)");
            try {
              await reindexWithIndexDbReleased(primaryStashDir);
              reindexedAfterInference = true;
              info("[improve] reindex after consolidation complete");
            } catch (err) {
              allWarnings.push(
                `reindex after consolidation failed: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }
          // #584: no close/reopen needed here — reindexWithIndexDbReleased
          // already swapped in a fresh post-reindex handle.
          // Resolve touched refs to absolute file paths. Skipped for fullScan
          // (candidatePaths stays undefined → extractor processes all files).
          let candidatePaths: Set<string> | undefined;
          if (!graphExtractionFullScan) {
            candidatePaths = new Set<string>();
            if (primaryStashDir && touchedRefs.size > 0) {
              const writableDirSet = new Set(getWritableStashDirs(primaryStashDir).map((d) => path.resolve(d)));
              const resolved = await Promise.all(
                [...touchedRefs].map((ref) =>
                  findAssetFilePath(ref, primaryStashDir, writableDirSet).catch(() => null),
                ),
              );
              for (const p of resolved) {
                if (typeof p === "string" && p.length > 0) candidatePaths.add(p);
              }
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
          graphExtraction = await withLlmStage("graph-extraction", () =>
            graphExtractionFn({
              config,
              sources,
              signal: budgetSignal,
              db,
              reEnrich: false,
              onProgress: progressHandler,
              options: { candidatePaths },
            }),
          );
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
      // window. The purge runs against state.db (a different SQLite file from
      // the index `db` above).
      {
        const retentionDays =
          typeof config.improve?.eventRetentionDays === "number" ? config.improve.eventRetentionDays : 90;
        if (retentionDays > 0) {
          // #585: reuse the long-lived eventsCtx.db connection when akmImprove
          // opened one — opening a second state.db write connection while
          // eventsDb is still live made two simultaneous writers contend on the
          // same WAL file ("database is locked"). Only the eventsCtx.dbPath
          // fallback path (state.db failed to open up-front) opens — and then
          // owns and closes — its own handle. C2 still holds: the fallback uses
          // the boundary-pinned path, never a live `process.env` re-read.
          const ownsStateDb = !eventsCtx?.db;
          let stateDb: ReturnType<typeof openStateDatabase> | undefined;
          try {
            stateDb = eventsCtx?.db ?? openStateDatabase(eventsCtx?.dbPath);
            const purgedCount = purgeOldEvents(stateDb, retentionDays);
            if (purgedCount > 0) {
              info(
                `[improve] events purge: ${purgedCount} event(s) older than ${retentionDays}d removed from state.db`,
              );
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
            if (ownsStateDb && stateDb) {
              try {
                stateDb.close();
              } catch {
                // best-effort
              }
            }
          }

          // task_logs in logs.db (#579) shares the same retention window as
          // events/improve_runs — all three are observability data governed by
          // the single improve.eventRetentionDays knob. Separate try/finally
          // because logs.db is a different file: a locked/missing logs.db must
          // not block the state.db purges above.
          let logsDb: ReturnType<typeof openLogsDatabase> | undefined;
          try {
            logsDb = openLogsDatabase();
            const taskLogsPurged = purgeOldTaskLogs(logsDb, retentionDays);
            if (taskLogsPurged > 0) {
              info(
                `[improve] task_logs purge: ${taskLogsPurged} log line(s) older than ${retentionDays}d removed from logs.db`,
              );
            }
            appendEvent(
              {
                eventType: "task_logs_purged",
                ref: "task_logs:_purge",
                metadata: { purgedCount: taskLogsPurged, retentionDays },
              },
              eventsCtx,
            );
          } catch (err) {
            allWarnings.push(`task_logs purge failed: ${err instanceof Error ? err.message : String(err)}`);
          } finally {
            if (logsDb) {
              try {
                logsDb.close();
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
          stalenessDetection = await withLlmStage("staleness-detection", () =>
            stalenessDetectionFn({ config, sources, signal: budgetSignal, db }),
          );
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
  });

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
      const ref = makeAssetRef(indexed.entry.type as AkmAssetType, indexed.entry.name);
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
