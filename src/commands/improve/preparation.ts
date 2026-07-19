// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import path from "node:path";
import { parseFrontmatter } from "../../core/asset/frontmatter";
import { conceptIdToLegacy } from "../../core/asset/resolve-ref";
import { daysToMs } from "../../core/common";
import { loadConfig } from "../../core/config/config";
import { ConfigError, rethrowIfTestIsolationError } from "../../core/errors";
import { appendEvent, type EventsContext, readEvents } from "../../core/events";
import type { EligibilitySource, ImproveActionResult, ImproveEligibleRef } from "../../core/improve-types";
import { openStateDatabase, withStateDb } from "../../core/state-db";
import { info, warn } from "../../core/warn";
import { countUsageEventsByType } from "../../indexer/usage/usage-events";
import { materializeLlmRunnerConnection } from "../../integrations/agent/runner";
import { getAvailableHarnesses } from "../../integrations/session-logs";
import { withLlmStage } from "../../llm/usage-telemetry";
import { closeDatabase, openExistingDatabase } from "../../storage/repositories/index-connection";
import { getZeroResultSearches } from "../../storage/repositories/index-entries-repository";
import { getRetrievalCounts } from "../../storage/repositories/index-utility-repository";
import { listStateProposals } from "../../storage/repositories/proposals-repository";
import { akmLint } from "../lint/index";
import { runSchemaRepairPass } from "../sources/schema-repair";
import { akmConsolidate, type ConsolidateResult } from "./consolidate";
// Eligibility / candidate-selection predicates live in ./eligibility.
import {
  buildLatestFeedbackTsMap,
  buildLatestProposalTsMap,
  buildUtilityMap,
  dedupeRefs,
  findAssetFilePath,
  isDistillCandidateRef,
  isLessonCandidate,
  isSignalDeltaEligible,
} from "./eligibility";
import { type AkmExtractResult, akmExtract, countNewExtractCandidates, type ResolvedExtractPlan } from "./extract";
import { computeValenceScore, FEEDBACK_WEIGHT, UTILITY_WEIGHT } from "./feedback-valence";
import type {
  AkmImproveOptions,
  ConsolidationPassResult,
  ImprovePreparationResult,
  ImproveScope,
} from "./improve-run-types";
import type { ResolvedImprovePlan } from "./improve-strategies";
import { applyMemoryCleanup, type MemoryCleanupPlan } from "./memory/memory-improve";
import {
  computeProxyAdequacy,
  getAllAssetOutcomes,
  getOutcomeScoresByRef,
  OUTCOME_SCORE_MAX,
  outcomeScoreToSalience,
  updateAssetOutcome,
} from "./outcome-loop";
import { DEFAULT_DUE_DAYS, DEFAULT_MAX_PER_RUN, selectProactiveMaintenanceRefs } from "./proactive-maintenance";
import {
  buildRankChangeReport,
  computeSalience,
  getAllRankScores,
  getAssetSalience,
  getLastUseMsByRef,
  isContentEncodingRow,
  SALIENCE_NO_OP_DAMPEN_FACTOR,
  SALIENCE_NO_OP_DAMPEN_THRESHOLD,
  upsertAssetSalience,
} from "./salience";
import { bareImproveRef, durableImproveRef, improveStateReadRefs } from "./source-identity";

function readAssetSalienceForImproveRef(
  db: Parameters<typeof getAssetSalience>[0],
  ref: string,
  sourceName?: string,
  includeLegacyBare = false,
  itemRef?: string,
): ReturnType<typeof getAssetSalience> {
  // Chunk-5 flip F5e — probe [itemRef, durable, bare] so a row written under
  // EITHER grammar is found during the transition window (source-identity.ts).
  for (const key of improveStateReadRefs(ref, sourceName, includeLegacyBare, itemRef)) {
    const row = getAssetSalience(db, key);
    if (row) return row;
  }
  return undefined;
}

function readConsecutiveNoOpsForImproveRef(
  db: Parameters<typeof getAssetSalience>[0],
  ref: string,
  sourceName?: string,
  includeLegacyBare = false,
  itemRef?: string,
): number {
  return readAssetSalienceForImproveRef(db, ref, sourceName, includeLegacyBare, itemRef)?.consecutive_no_ops ?? 0;
}

// ── Chunk-5 flip F5e — durable-state write keys ──────────────────────────────
//
// The durable improve-state writers key by the resolved index entry's
// `item_ref` (`<bundle>//<conceptId>`, D-R3) WHEN the planner resolved one
// (`ImproveEligibleRef.itemRef`), and fall back to each writer's PRE-FLIP
// spelling for a NULL-provenance (pre-flip / write-back) ref:
//   - salience (`asset_salience`)  → the SOURCE-QUALIFIED `durableImproveRef`
//     (`<source>//<type>:<name>`), matching the pre-flip upsert.
//   - outcome  (`asset_outcome`)   → the BARE `type:name`, matching the pre-flip
//     `updateAssetOutcome({ ref: r.ref })` call.
// itemRefByRef is `bare-ref → item_ref | undefined`, built once per pass from
// the candidate set. // Chunk-8: collapse both to the item_ref after the
// one-time state.db re-key.

/** `bare-ref → item_ref | undefined` for a run's candidate set. */
function buildItemRefByRef(refs: ImproveEligibleRef[]): Map<string, string | undefined> {
  const m = new Map<string, string | undefined>();
  for (const r of refs) m.set(r.ref, r.itemRef);
  return m;
}

/** Durable `asset_salience` write key: item_ref, else the source-qualified `type:name`. */
function salienceWriteKey(ref: string, itemRefByRef: Map<string, string | undefined>, sourceName?: string): string {
  return itemRefByRef.get(ref) ?? durableImproveRef(ref, sourceName);
}

/** Durable `asset_outcome` write key: item_ref, else the bare `type:name` (pre-flip outcome spelling). */
function outcomeWriteKey(ref: string, itemRefByRef: Map<string, string | undefined>): string {
  return itemRefByRef.get(ref) ?? ref;
}

/**
 * Recover the legacy asset type from a ref in EITHER grammar (Chunk-5 flip F5e):
 * the `type:` prefix of a bare/source-qualified `type:name`, or the D-R2
 * stash-subdir of a `[bundle//]conceptId`. "" when neither applies (a foreign
 * bare-name conceptId). Byte-identical to the prior `ref.slice(0, indexOf(":"))`
 * guard for the bare `type:name` refs the salience vector actually iterates.
 */
function legacyTypeOf(ref: string): string {
  const tail = ref.includes("//") ? ref.slice(ref.indexOf("//") + 2) : ref;
  if (tail.includes(":")) return tail.slice(0, tail.indexOf(":"));
  return conceptIdToLegacy(tail)?.type ?? "";
}

// ── improve preparation stage ───────────────────────
// The pre-loop preparation pipeline (consolidation, session-extract, validation/
// repair, eligibility partitioning, selectors) extracted from improve.ts.

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
 *      post-`lastConsolidateTs` mtime bump came from its OWN promotion
 *      (i.e. it was just promoted in the immediately
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
/** Whether/why the consolidation pass should run, computed with zero LLM calls. */
interface ConsolidationEligibility {
  /** Memory volume exceeded the threshold with an LLM available — forces the run. */
  volumeTriggered: boolean;
  /** Pool-delta gate: no memory changed since the last successful consolidate. */
  consolidationOnCooldown: boolean;
  /** Profile explicitly disables consolidate. */
  consolidateDisabledByProfile: boolean;
  /** #553: eligible pool below the configured minimum size. */
  poolBelowMinSize: boolean;
  eligiblePoolSize: number;
  minPoolSize: number;
  /** Timestamp of the most recent successful consolidate_completed event. */
  lastConsolidationTs?: string;
}

/**
 * Evaluate the consolidation gate flags (volume trigger, #551 pool-delta
 * cooldown, profile disable, #553 min-pool-size) up front, before any LLM call.
 * Extracted verbatim from `runConsolidationPass` — logic is byte-identical.
 */
function evaluateConsolidationEligibility(args: {
  options: AkmImproveOptions;
  primaryStashDir?: string;
  memorySummary: { eligible: number; derived: number };
  improveProfile?: import("../../core/config/config").ImproveProfileConfig;
  resolvedPlan: ResolvedImprovePlan;
}): ConsolidationEligibility {
  const { options, primaryStashDir, memorySummary, improveProfile, resolvedPlan } = args;
  const MEMORY_VOLUME_THRESHOLD = options.memoryVolumeConsolidationThreshold ?? 100;
  const hasLlm = resolvedPlan.processes.consolidate.runner !== null;
  const volumeTriggered =
    typeof memorySummary.eligible === "number" && memorySummary.eligible > MEMORY_VOLUME_THRESHOLD && hasLlm;

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
  // since the last consolidate is their OWN promotion. Those files
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

  return {
    volumeTriggered,
    consolidationOnCooldown,
    consolidateDisabledByProfile,
    poolBelowMinSize,
    eligiblePoolSize,
    minPoolSize,
    ...(lastConsolidateTs ? { lastConsolidationTs: lastConsolidateTs } : {}),
  };
}

export async function runConsolidationPass(args: {
  options: AkmImproveOptions;
  primaryStashDir?: string;
  memorySummary: { eligible: number; derived: number };
  improveProfile?: import("../../core/config/config").ImproveProfileConfig;
  resolvedPlan: ResolvedImprovePlan;
  eventsCtx?: EventsContext;
  /** Budget signal forwarded to akmConsolidate for graceful drain on timeout. */
  budgetSignal?: AbortSignal;
  /** Total run budget in ms, forwarded to akmConsolidate for WS-5 perf telemetry. */
  runBudgetMs?: number;
}): Promise<ConsolidationPassResult> {
  const {
    options,
    primaryStashDir,
    memorySummary,
    improveProfile,
    resolvedPlan,
    eventsCtx,
    budgetSignal,
    runBudgetMs,
  } = args;

  const baseConfig = options.config ?? loadConfig();
  const consolidationConfig = baseConfig;

  const {
    volumeTriggered,
    consolidationOnCooldown,
    consolidateDisabledByProfile,
    poolBelowMinSize,
    eligiblePoolSize,
    minPoolSize,
    lastConsolidationTs,
  } = evaluateConsolidationEligibility({ options, primaryStashDir, memorySummary, improveProfile, resolvedPlan });

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
    consolidation = await withLlmStage(
      "consolidate",
      () =>
        akmConsolidate({
          ...options.consolidateOptions,
          config: consolidationConfig,
          stashDir: options.stashDir,
          // Active profile for this improve run — lets consolidate's secondary
          // process-config reads honor `--profile <name>` instead of `default`.
          improveProfile,
          llmConfig: resolvedPlan.processes.consolidate.runner
            ? materializeLlmRunnerConnection(resolvedPlan.processes.consolidate.runner)
            : null,
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
          // The improve pipeline is an automated batch flow: it must never
          // block on consolidate's interactive HTTP-path confirm prompt, and
          // scheduled runs must keep APPLYING the consolidation plan (the
          // shipped tasks previously got this via `--auto-accept safe`'s
          // prompt-bypass role; the confidence gate itself died in 0.9.0).
          // An explicit caller-provided consolidateOptions.assumeYes wins.
          assumeYes: options.consolidateOptions?.assumeYes ?? true,
          // WS-3a: forward budget signal for graceful abort on timeout, and pass
          // the profile's p90 estimate for cold-start budget reduction.
          signal: budgetSignal,
          p90ChunkSecondsDefault: improveProfile?.processes?.consolidate?.p90ChunkSecondsDefault,
          // WS-5: pass total run budget so perfTelemetry.estimatedBudgetFractionUsed
          // can flag when consolidation alone exceeded the budget.
          runBudgetMs,
        }),
      { engine: resolvedPlan.processes.consolidate.runner?.engine, process: "consolidate" },
    );
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
          lastEventTs: lastConsolidationTs ?? null,
        },
      },
      eventsCtx,
    );
    info("[improve] consolidation skipped (no memory updates since last run)");
  }

  // D9: track whether consolidation wrote any data so graph extraction can reindex if needed
  const consolidationRan =
    !consolidateDisabledByProfile && !poolBelowMinSize && !consolidationOnCooldown && consolidation.processed > 0;

  // Gate counters are live result-envelope fields; always 0 since the 0.9.0
  // confidence-gate deletion.
  return { consolidation, consolidationRan, gateAutoAcceptedCount: 0, gateAutoAcceptFailedCount: 0 };
}

/**
 * Phase 0.4 — session-extract pass. Reads native session files through the
 * SessionLogHarness registry, and asks a bounded LLM for candidate proposals.
 * Failures are non-fatal (collected into `warnings`). Returns the extract
 * results + the gate counters (live result-envelope fields, seeded from the
 * consolidation pass; always 0 since the 0.9.0 confidence-gate deletion).
 */
async function runSessionExtractPass(args: {
  options: AkmImproveOptions;
  primaryStashDir?: string;
  improveProfile: import("../../core/config/config").ImproveProfileConfig;
  resolvedPlan: ResolvedImprovePlan;
  eventsCtx?: EventsContext;
  budgetSignal?: AbortSignal;
  seedGateAccepted: number;
  seedGateFailed: number;
}): Promise<{
  extractResults?: AkmExtractResult[];
  gateAutoAcceptedCount: number;
  gateAutoAcceptFailedCount: number;
  warnings: string[];
}> {
  const { options, primaryStashDir, improveProfile, resolvedPlan, eventsCtx, budgetSignal } = args;
  const warnings: string[] = [];
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
  const extractConfig = options.config ?? loadConfig();
  // #554 minNewSessions gate: skip the entire extract pass (ensureIndex was
  // already done upstream; here we elide every akmExtract/processSession call)
  // when the NEW (unseen, in-window) candidate-session pool is below a minimum.
  // 22% of improve runs produce zero memory-inference writes because extract
  // finds no new sessions, yet still burns the full extract pipeline. Default 0
  // (disabled) preserves existing always-run behaviour; only opted-in profiles
  // (e.g. `frequent`) set it. Evaluated BEFORE any LLM call so a skip costs zero
  // LLM work AND writes nothing — a skipped extract never flags work for the
  // NEXT run's consolidation mtime-gate (the downstream trigger #554 asks us
  // to suppress).
  const EXTRACT_DEFAULT_MIN_NEW_SESSIONS = 0;
  // Read from the ACTIVE resolved profile (not always `default`), matching how
  // `extract.enabled` resolves — otherwise a non-default profile (e.g.
  // `frequent`) setting `minNewSessions` was silently ignored.
  const configuredMinNewSessions = improveProfile.processes?.extract?.minNewSessions;
  const minNewSessions =
    typeof configuredMinNewSessions === "number" ? configuredMinNewSessions : EXTRACT_DEFAULT_MIN_NEW_SESSIONS;
  // #593/#594: the ACTIVE resolved improve profile is the single source of
  // truth for whether extract runs. (Previously this also ANDed in the legacy
  // `session_extraction` feature flag, which only reads
  // a retired global feature path; the selected strategy is authoritative.)
  // `akmExtract` re-checks the same active profile internally via `improveProfile`.
  if (resolvedPlan.processes.extract.enabled) {
    const extractRunner = resolvedPlan.processes.extract.runner;
    if (!extractRunner?.engine) {
      throw new ConfigError("Resolved improve plan has no runner for enabled extract process.", "LLM_NOT_CONFIGURED");
    }
    const extractPlan: ResolvedExtractPlan = Object.freeze({
      strategy: resolvedPlan.strategy.name,
      engine: extractRunner.engine,
      enabled: true,
      process: resolvedPlan.processes.extract.config,
      runner: extractRunner,
      timeoutMs: extractRunner.timeoutMs === undefined ? 600_000 : extractRunner.timeoutMs,
      embeddingConfig: Object.freeze(structuredClone(extractConfig.embedding)),
    });
    const availableHarnesses = options.extractHarnesses ?? getAvailableHarnesses();
    // The guard engages only when minNewSessions > 0; 0 disables it entirely.
    let belowMinNewSessions = false;
    if (minNewSessions > 0 && availableHarnesses.length > 0) {
      const countFn = options.extractCandidateCountFn ?? countNewExtractCandidates;
      const newCandidateCount = countFn(extractConfig, {
        ...(options.extractHarnesses ? { harnesses: options.extractHarnesses } : {}),
        improveProfile,
        // Use the ACTIVE profile's discovery window so the gate counts over the
        // same window akmExtract will scan (not always `default`).
        ...(improveProfile.processes?.extract?.defaultSince
          ? { since: improveProfile.processes.extract.defaultSince }
          : {}),
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
          const result = await withLlmStage(
            "session-extraction",
            () =>
              akmExtract({
                type: h.name,
                ...(primaryStashDir !== undefined ? { stashDir: primaryStashDir } : {}),
                config: extractConfig,
                resolvedPlan: extractPlan,
                dryRun: options.dryRun ?? false,
                signal: budgetSignal,
                ...(options.extractHarnesses ? { harnesses: options.extractHarnesses } : {}),
                // C2: pin extract's skip-tracking state.db open to the boundary path.
                ...(eventsCtx?.dbPath ? { stateDbPath: eventsCtx.dbPath } : {}),
                // R25: extract's event emits reuse the run's events context
                // (fast path when it carries the long-lived handle).
                eventsCtx,
              }),
            { engine: resolvedPlan.processes.extract.runner?.engine, process: "extract" },
          );
          extractResults.push(result);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          warnings.push(`extract(${h.name}) failed: ${msg}`);
        }
      }
      if (extractResults.length === 0) {
        // All harnesses threw — clear so the envelope's `extract` field is
        // absent rather than misleadingly empty.
        extractResults = undefined;
      }
    }
  }

  // Gate counters are live result-envelope fields; always 0 since the 0.9.0
  // confidence-gate deletion (pending extract proposals now wait for the
  // proposal queue / drain engine instead of an in-run backlog gate).
  return {
    extractResults,
    gateAutoAcceptedCount: args.seedGateAccepted,
    gateAutoAcceptFailedCount: args.seedGateFailed,
    warnings,
  };
}

/**
 * Phase 1 — validation + schema-repair pass. Scans postCleanupRefs for assets
 * with structural problems (missing file, missing lesson description), attempts
 * LLM schema repair, and returns the still-failing ref set + the repair records.
 */
export async function runValidationAndRepairPass(args: {
  postCleanupRefs: ImproveEligibleRef[];
  options: AkmImproveOptions;
  startMs: number;
  budgetMs: number;
  primaryStashDir?: string;
  resolvedPlan: ResolvedImprovePlan;
  repairValidationFailures: boolean;
  schemaRepairFn?: typeof runSchemaRepairPass;
}): Promise<{
  validationFailures: Array<{ ref: string; reason: string }>;
  validationFailureRefs: Set<string>;
  schemaRepairs: ImprovePreparationResult["schemaRepairs"];
}> {
  const {
    postCleanupRefs,
    options,
    startMs,
    budgetMs,
    primaryStashDir,
    resolvedPlan,
    repairValidationFailures,
    schemaRepairFn = runSchemaRepairPass,
  } = args;
  const validateCandidate = async (candidate: ImproveEligibleRef): Promise<string | undefined> => {
    try {
      const filePath =
        candidate.filePath && fs.existsSync(candidate.filePath)
          ? candidate.filePath
          : await findAssetFilePath(candidate.ref, options.stashDir);
      if (!filePath) return "file not found on disk";
      if (path.extname(filePath).toLowerCase() !== ".md") return undefined;
      if (isLessonCandidate(candidate.ref)) {
        const fm = parseFrontmatter(fs.readFileSync(filePath, "utf8")).data;
        if (!fm.description) return "missing description";
      }
      return undefined;
    } catch (error) {
      return String(error);
    }
  };
  const validationFailures: Array<{ ref: string; reason: string }> = [];
  for (const candidate of postCleanupRefs) {
    const reason = await validateCandidate(candidate);
    if (reason) validationFailures.push({ ref: candidate.ref, reason });
  }
  if (validationFailures.length > 0) {
    info(
      `[improve] ${validationFailures.length} assets have validation issues${repairValidationFailures ? " (will attempt schema repair)" : ""}:`,
    );
    for (const f of validationFailures) info(`  ${f.ref}: ${f.reason}`);
  }

  let schemaRepairs: ImprovePreparationResult["schemaRepairs"] = [];
  const repairedRefs = new Set<string>();

  // Schema repair pass: attempt to fix validation failures via LLM before skipping.
  if (validationFailures.length > 0) {
    const validationRunner = resolvedPlan.processes.validation.runner;
    const llmCfg = validationRunner ? materializeLlmRunnerConnection(validationRunner) : undefined;
    if (llmCfg) {
      const result = await withLlmStage(
        "validation",
        () =>
          schemaRepairFn(validationFailures, {
            startMs,
            budgetMs,
            llmConfig: llmCfg,
            // #591/#379 regression: options.stashDir is the raw, unresolved CLI
            // flag (only set when --stash-dir is passed explicitly — never true
            // for the scheduled tasks). primaryStashDir is the already-resolved
            // source path and is what runSchemaRepairPass's `stashDir` param
            // documents itself as needing ("proposal-queue writes"). Passing
            // options.stashDir here made every schema-repair attempt throw
            // `runSchemaRepairPass requires stashDir` on every cron invocation.
            stashDir: primaryStashDir,
            findFilePath: findAssetFilePath,
            isLessonCandidateFn: isLessonCandidate,
          }),
        { engine: resolvedPlan.processes.validation.runner?.engine, process: "validation" },
      );
      schemaRepairs = result.repairs;
      // A repair result is advisory. Only a fresh structural read of the live
      // asset can remove it from the failure set; queued content is not live.
      const failedRefs = new Set(validationFailures.map((failure) => failure.ref));
      const candidatesByRef = new Map(postCleanupRefs.map((candidate) => [candidate.ref, candidate]));
      for (const ref of failedRefs) {
        const candidate = candidatesByRef.get(ref);
        if (candidate && !(await validateCandidate(candidate))) repairedRefs.add(ref);
      }
    }
  }

  const validationFailureRefs = new Set(validationFailures.filter((f) => !repairedRefs.has(f.ref)).map((f) => f.ref));
  if (repairedRefs.size > 0) {
    info(
      `[improve] schema repair fixed ${repairedRefs.size}/${validationFailures.length} validation failures; ${validationFailureRefs.size} remain`,
    );
  }
  return { validationFailures, validationFailureRefs, schemaRepairs };
}

export async function runImprovePreparationStage(args: {
  scope: ImproveScope;
  options: AkmImproveOptions;
  plannedRefs: ImproveEligibleRef[];
  memoryCleanupPlan?: MemoryCleanupPlan;
  primaryStashDir?: string;
  memorySummary: { eligible: number; derived: number };
  reindexFn: (options: { stashDir: string; signal?: AbortSignal }) => Promise<unknown>;
  startMs: number;
  budgetMs: number;
  eventsCtx?: EventsContext;
  /** Warnings accumulated in akmImprove() prior to this stage (e.g. from the hoisted ensureIndex call). */
  initialCleanupWarnings?: string[];
  /** Active improve profile, resolved from profile name + config. */
  improveProfile: import("../../core/config/config").ImproveProfileConfig;
  resolvedPlan: ResolvedImprovePlan;
  /** Public strategy identity for run-level event metadata. */
  strategyName: string;
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
    resolvedPlan,
    strategyName,
    budgetSignal,
  } = args;

  const actions: ImproveActionResult[] = [];
  const cleanupWarnings: string[] = initialCleanupWarnings ? [...initialCleanupWarnings] : [];

  const memoryBudget = assessMemoryIndexBudget(primaryStashDir);
  const memoryIndexHealth = memoryBudget.memoryIndexHealth;
  if (memoryBudget.warning) cleanupWarnings.push(memoryBudget.warning);

  // Phase 0.3 — memory consolidation pass (#551).
  //
  // Consolidation runs BEFORE the session-extract pass. This is the structural
  // half of the #551 fix: extract promotions write brand-new memory .md files,
  // which previously made the consolidation pool-delta gate fire
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
    resolvedPlan,
    eventsCtx,
    budgetSignal,
    runBudgetMs: budgetMs,
  });

  // Phase 0.4 — session-extract pass (see runSessionExtractPass).
  const extractPass = await runSessionExtractPass({
    options,
    primaryStashDir,
    improveProfile,
    resolvedPlan,
    eventsCtx,
    budgetSignal,
    seedGateAccepted: consolidationPass.gateAutoAcceptedCount,
    seedGateFailed: consolidationPass.gateAutoAcceptFailedCount,
  });
  const extractResults = extractPass.extractResults;
  const gateAutoAcceptedCount = extractPass.gateAutoAcceptedCount;
  const gateAutoAcceptFailedCount = extractPass.gateAutoAcceptFailedCount;
  if (extractPass.warnings.length > 0) cleanupWarnings.push(...extractPass.warnings);

  // eligibleCount = raw pre-filter count (before cooldown/signal/cleanup filters).
  // improve_completed.plannedRefs = post-filter count of refs that actually entered the loop.
  appendEvent(
    {
      eventType: "improve_invoked",
      ref: scope.mode === "ref" ? scope.value : `improve:${scope.mode}:${scope.value ?? "all"}`,
      metadata: { strategy: strategyName, scope, dryRun: options.dryRun ?? false, eligibleCount: plannedRefs.length },
    },
    eventsCtx,
  );

  // ensureIndex now runs in akmImprove() BEFORE collectEligibleRefs so the
  // eligible-ref query sees a populated `entries` table on the very first
  // pass after a DB version upgrade (#339). Any failure messages from that
  // earlier call were threaded in via args.initialCleanupWarnings.

  const cleanup = await applyCleanupPass({ primaryStashDir, memoryCleanupPlan, plannedRefs, reindexFn, budgetSignal });
  const appliedCleanup = cleanup.appliedCleanup;
  const postCleanupRefs = cleanup.postCleanupRefs;
  actions.push(...cleanup.pruneActions);
  cleanupWarnings.push(...cleanup.warnings);

  const { validationFailures, validationFailureRefs, schemaRepairs } = await runValidationAndRepairPass({
    postCleanupRefs,
    options,
    startMs,
    budgetMs,
    primaryStashDir,
    resolvedPlan,
    repairValidationFailures: resolvedPlan.processes.validation.enabled && options.repairValidationFailures !== false,
  });

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

  const recentErrors = seedRecentErrorWindows(schemaRepairs);

  const snapshot = buildSnapshotManifest({ postCleanupRefs, validationFailureRefs, options });

  const gathered = gatherCandidates({
    scope,
    options,
    primaryStashDir,
    eventsCtx,
    improveProfile,
    resolvedPlan,
    postCleanupRefs,
    validationFailureRefs,
    snapshot,
  });
  actions.push(...gathered.actions);

  const scored = scoreSalience({
    scope,
    options,
    primaryStashDir,
    eventsCtx,
    improveProfile,
    mergedRefs: gathered.mergedRefs,
    eligibilitySourceByRef: gathered.eligibilitySourceByRef,
    feedbackSummary: gathered.feedbackSummary,
    retrievalCounts: gathered.retrievalCounts,
    signalFiltered: gathered.signalFiltered,
    proactiveRefs: gathered.proactiveRefs,
    highSalienceRefs: gathered.highSalienceRefs,
  });

  const filtered = await filterEligibility({
    scope,
    options,
    plannedRefs,
    eventsCtx,
    mergedRefs: scored.mergedRefs,
    salienceMap: scored.salienceMap,
    eligibilitySourceByRef: gathered.eligibilitySourceByRef,
    distillOnlyRefs: gathered.distillOnlyRefs,
    validationFailureRefs,
    summary: {
      fullySkippedCount: gathered.fullySkippedCount,
      preCooldownCount: gathered.preCooldownCount,
      signalAndRetrievalRefs: gathered.signalAndRetrievalRefs,
      signalFiltered: gathered.signalFiltered,
    },
  });

  return {
    actions,
    cleanupWarnings,
    appliedCleanup,
    memoryIndexHealth,
    extract: extractResults,
    actionableRefs: filtered.actionableRefs,
    signalBearingSet: gathered.signalBearingSet,
    validationFailures,
    schemaRepairs,
    lintSummary,
    loopRefs: filtered.loopRefs,
    distillCooledRefs: gathered.distillCooledRefs,
    distillOnlyRefs: filtered.distillOnlyRefs,
    coverageGaps: filtered.coverageGaps,
    recentErrors,
    utilityMap: scored.utilityMap,
    gateAutoAcceptedCount,
    gateAutoAcceptFailedCount,
    consolidation: consolidationPass.consolidation,
    consolidationRan: consolidationPass.consolidationRan,
    ...(gathered.proactiveMaintenanceSummary ? { proactiveMaintenance: gathered.proactiveMaintenanceSummary } : {}),
  };
}

// ── preparation-stage passes (WI-7.6 decomposition, R31) ────────────────────
// The six-pass split prescribed by the chunk-7 brief §WI-7.6, adapted to the
// code as it exists at HEAD (anchors re-measured; see the chunk-7 ledger):
//   snapshot-manifest  → buildSnapshotManifest
//   candidate-gather   → gatherCandidates (+ its five lane/sub-passes)
//   salience-score     → scoreSalience (+ outcome/vector/persist sub-passes)
//   valence-score      → the two computeValenceScore call sites move VERBATIM
//                        inside the salience passes (pure fn; no separate pass)
//   standards-context  → does not exist in preparation.ts (assembly lives in
//                        extract.ts — recorded in the ledger, no empty pass)
//   eligibility-filter → filterEligibility (+ replay/disk-check sub-passes)
// Every pass takes an args object and returns its results; the orchestrator
// folds them. Shared-by-reference structures (the ImproveEligibleRef objects,
// eligibilitySourceByRef, salienceMap, actions, recentErrors) keep their
// identity — attribution stamps must travel with the ref objects into the
// loop stage exactly as before.

/** Phase 0 — MEMORY.md budget check (200-line cap; warn at 180). */
function assessMemoryIndexBudget(primaryStashDir: string | undefined): {
  memoryIndexHealth?: { lineCount: number; overBudget: boolean };
  warning?: string;
} {
  let warning: string | undefined;
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
          warning = `MEMORY.md has ${lines} lines (budget: 200). Consolidation strongly recommended.`;
        }
      } catch {
        // best-effort
      }
    }
  }
  return { memoryIndexHealth, warning };
}

/**
 * Memory-cleanup apply + prune-action recording + the post-cleanup reindex.
 * Returns the surviving ref set and the prune actions/warnings for the
 * orchestrator to fold (same order as the old inline pushes).
 */
async function applyCleanupPass(args: {
  primaryStashDir?: string;
  memoryCleanupPlan?: MemoryCleanupPlan;
  plannedRefs: ImproveEligibleRef[];
  reindexFn: (options: { stashDir: string; signal?: AbortSignal }) => Promise<unknown>;
  budgetSignal?: AbortSignal;
}): Promise<{
  appliedCleanup?: Awaited<ReturnType<typeof applyMemoryCleanup>>;
  postCleanupRefs: ImproveEligibleRef[];
  pruneActions: ImproveActionResult[];
  warnings: string[];
}> {
  const { primaryStashDir, memoryCleanupPlan, plannedRefs, reindexFn, budgetSignal } = args;
  const pruneActions: ImproveActionResult[] = [];
  const warnings: string[] = [];
  let appliedCleanup: Awaited<ReturnType<typeof applyMemoryCleanup>> | undefined;
  try {
    appliedCleanup =
      primaryStashDir && memoryCleanupPlan ? applyMemoryCleanup(primaryStashDir, memoryCleanupPlan) : undefined;
  } catch (err) {
    warnings.push(`applyMemoryCleanup failed: ${err instanceof Error ? err.message : String(err)}`);
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
      pruneActions.push({
        ref: candidate.ref,
        mode: "memory-prune",
        result: { ok: true, pruned: true, reason: candidate.reason },
      });
    }
    if ((appliedCleanup.archived.length > 0 || appliedCleanup.beliefStateTransitions.length > 0) && primaryStashDir) {
      try {
        await reindexFn({ stashDir: primaryStashDir, signal: budgetSignal });
      } catch (err) {
        warnings.push(`reindex after cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  return { appliedCleanup, postCleanupRefs, pruneActions, warnings };
}

/** Seed the per-originator rolling error windows from schema-repair errors. */
function seedRecentErrorWindows(
  schemaRepairs: Awaited<ReturnType<typeof runValidationAndRepairPass>>["schemaRepairs"],
): Record<string, string[]> {
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
  return recentErrors;
}

/** The signal-delta timestamp maps built once per run (pass: snapshot-manifest). */
interface SignalDeltaSnapshot {
  feedbackSinceCutoff: string;
  latestFeedbackTs: ReturnType<typeof buildLatestFeedbackTsMap>;
  lastReflectProposalTs: ReturnType<typeof buildLatestProposalTsMap>;
  lastDistillProposalTs: ReturnType<typeof buildLatestProposalTsMap>;
}

/** Pass: snapshot-manifest — the three timestamp maps + the 30-day signal window. */
export function buildSnapshotManifest(args: {
  postCleanupRefs: ImproveEligibleRef[];
  validationFailureRefs: Set<string>;
  options: AkmImproveOptions;
}): SignalDeltaSnapshot {
  const { postCleanupRefs, validationFailureRefs, options } = args;
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
  const FEEDBACK_SIGNAL_WINDOW_DAYS = 30;
  const feedbackSinceCutoff = new Date(Date.now() - daysToMs(FEEDBACK_SIGNAL_WINDOW_DAYS)).toISOString();

  // Build the three timestamp maps once across the entire postCleanupRefs set.
  // Per-ref queries would be N+1 and the planner is already the hottest path
  // in `akm improve`.
  const candidateRefs = postCleanupRefs.filter((r) => !validationFailureRefs.has(r.ref)).map((r) => r.ref);
  const latestFeedbackTs = buildLatestFeedbackTsMap(
    candidateRefs,
    feedbackSinceCutoff,
    options.sourceName,
    options.legacyBareState,
  );
  const lastReflectProposalTs = buildLatestProposalTsMap(
    candidateRefs,
    "reflect",
    options.sourceName,
    options.legacyBareState,
  );
  const lastDistillProposalTs = buildLatestProposalTsMap(
    candidateRefs,
    "distill",
    options.sourceName,
    options.legacyBareState,
  );
  return { feedbackSinceCutoff, latestFeedbackTs, lastReflectProposalTs, lastDistillProposalTs };
}

/** Everything the candidate-gather pass hands the salience/eligibility passes. */
interface GatheredCandidates {
  /** Partition + declined-rescue skip actions, in emission order. */
  actions: ImproveActionResult[];
  distillCooledRefs: Set<string>;
  preCooldownCount: number;
  distillOnlyRefs: ImproveEligibleRef[];
  fullySkippedCount: number;
  feedbackSummary: Map<string, { hasSignal: boolean; positive: number; negative: number }>;
  signalFiltered: ImproveEligibleRef[];
  signalBearingSet: Set<string>;
  retrievalCounts: Map<string, number>;
  proactiveRefs: ImproveEligibleRef[];
  proactiveMaintenanceSummary?: { selected: number; dueTotal: number; neverReflected: number };
  highSalienceRefs: ImproveEligibleRef[];
  signalAndRetrievalRefs: ImproveEligibleRef[];
  mergedRefs: ImproveEligibleRef[];
  eligibilitySourceByRef: Map<string, EligibilitySource>;
}

/**
 * Pass: candidate-gather — the signal-delta partition, the bulk feedback
 * summary, retrieval signals, the Layer-2 proactive and Layer-3 high-salience
 * rescue lanes, the merged candidate set, and lane attribution stamping.
 */
function gatherCandidates(args: {
  scope: ImproveScope;
  options: AkmImproveOptions;
  primaryStashDir?: string;
  eventsCtx?: EventsContext;
  improveProfile: import("../../core/config/config").ImproveProfileConfig;
  resolvedPlan: ResolvedImprovePlan;
  postCleanupRefs: ImproveEligibleRef[];
  validationFailureRefs: Set<string>;
  snapshot: SignalDeltaSnapshot;
}): GatheredCandidates {
  const { scope, options, primaryStashDir, eventsCtx, improveProfile, resolvedPlan, postCleanupRefs } = args;
  const { feedbackSinceCutoff, lastReflectProposalTs, lastDistillProposalTs } = args.snapshot;

  const partition = partitionBySignalDelta({
    scope,
    options,
    eventsCtx,
    postCleanupRefs,
    validationFailureRefs: args.validationFailureRefs,
    snapshot: args.snapshot,
  });
  const actions = [...partition.actions];
  const { distillCooledRefs, preCooldownCount, eligibleRefs, distillOnlyRefs, noFeedbackPool, fullySkippedCount } =
    partition;

  // ── Phase 4: signal/feedback/utility/sort on the reduced set ──────────────
  // Everything from here works on (eligibleRefs ∪ distillOnlyRefs) plus the
  // deferred noFeedbackPool that may be rescued by the proactive-maintenance
  // (Layer 2) or high-salience (Layer 3) fallbacks below. The fully-skipped
  // bucket has already been routed and its aggregated event emitted; we
  // deliberately avoid spending DB/CPU on refs that the signal-delta gate
  // rejected with feedback already on record.
  const processableRefs: ImproveEligibleRef[] = [...eligibleRefs, ...distillOnlyRefs];

  const feedbackSummary = buildFeedbackSummaryMap({
    processableRefs,
    noFeedbackPool,
    options,
    eventsCtx,
    feedbackSinceCutoff,
  });

  const signalFiltered = processableRefs.filter((candidate) => feedbackSummary.get(candidate.ref)?.hasSignal === true);

  const signalBearingSet = new Set(signalFiltered.map((r) => r.ref));
  // Zero-feedback candidates for the proactive/high-salience fallbacks:
  // processableRefs without a recent signal, plus the deferred noFeedbackPool.
  // Dedupe by ref (the two sources are disjoint by construction, but guard
  // against overlap defensively).
  const noFeedbackSeen = new Set<string>();
  const noFeedbackCandidates: ImproveEligibleRef[] = [];
  for (const r of [...processableRefs.filter((r) => !signalBearingSet.has(r.ref)), ...noFeedbackPool]) {
    if (noFeedbackSeen.has(r.ref)) continue;
    noFeedbackSeen.add(r.ref);
    noFeedbackCandidates.push(r);
  }

  const { retrievalCounts, lastUseMsForProactive } = fetchRetrievalSignals({
    options,
    primaryStashDir,
    signalFiltered,
    noFeedbackCandidates,
  });

  const proactive = selectProactiveMaintenanceLane({
    scope,
    improveProfile,
    resolvedPlan,
    eventsCtx,
    noFeedbackCandidates,
    lastReflectProposalTs,
    lastDistillProposalTs,
    retrievalCounts,
    lastUseMsForProactive,
  });
  const proactiveRefs = proactive.proactiveRefs;
  const proactiveMaintenanceSummary = proactive.proactiveMaintenanceSummary;

  const highSalienceRefs = selectHighSalienceLane({
    options,
    improveProfile,
    eventsCtx,
    noFeedbackCandidates,
    proactiveRefs,
    lastReflectProposalTs,
  });

  // Record an in-memory skip action for every zero-feedback ref that the
  // partition loop deferred to the proactive/high-salience fallbacks but those
  // lanes then declined (not due, below threshold, or a prior reflect proposal
  // already on record). These never make it into mergedRefs, so without this
  // they would silently vanish from the run summary. No DB event is written
  // here — these refs carry no signal at all, so there is nothing for the skip
  // histogram to aggregate; the action log alone preserves the per-ref audit
  // trail (mirrors the fully-skipped action above).
  const rescuedSet = new Set([...proactiveRefs, ...highSalienceRefs].map((r) => r.ref));
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
  // or a proactive/high-salience rescue). A stash with no signals has 0
  // eligible refs — usage is the gate. Run `akm feedback <ref> --positive` or
  // retrieve assets to bring them into the eligible pool.
  // Layer-2 proactive refs join the eligible set alongside feedback-signal
  // refs. The three sources are disjoint by construction (proactive draws from
  // noFeedbackCandidates, and high-salience draws from the remainder), but
  // dedupe defensively so a ref can never enter the loop twice.
  // `requireFeedbackSignal` still suppresses all fallback sources for callers
  // that want feedback-only runs.
  const signalAndRetrievalRefs = dedupeRefs([...signalFiltered, ...proactiveRefs, ...highSalienceRefs]);
  const mergedRefs =
    scope.mode === "ref" ? processableRefs : options.requireFeedbackSignal ? signalFiltered : signalAndRetrievalRefs;

  // ── Attribution tagging: stamp each ref with the eligibility lane that
  // selected it ──────────────────────────────────────────────────────────────
  // Every reflect/distill proposal must record WHICH lane chose its source asset
  // so downstream accept/reject/revert/retrieval outcomes can be sliced by lane
  // (does the PROACTIVE lane produce value vs the reactive lanes?). We build the
  // lane map here — the one place all three lanes are known — and stamp it onto
  // each ImproveEligibleRef object. Because the ref objects are shared by
  // reference across buckets, the stamp travels with the ref through the sort,
  // disk-check, and loop stages down to the reflect/distill event emit sites and
  // createProposal calls. See EligibilitySource for the lane vocabulary.
  //
  // Precedence (prefer the most specific reactive signal):
  //   scope > signal-delta > proactive > high-salience
  // A ref with real feedback is attributed to feedback even if it was also due
  // for proactive maintenance or had high encoding salience. We apply lanes
  // weakest-first so the strongest overwrites; the explicit --scope <ref> bypass
  // wins outright (user intent).
  const eligibilitySourceByRef = new Map<string, EligibilitySource>();
  for (const r of highSalienceRefs) eligibilitySourceByRef.set(r.ref, "high-salience");
  for (const r of proactiveRefs) eligibilitySourceByRef.set(r.ref, "proactive");
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

  return {
    actions,
    distillCooledRefs,
    preCooldownCount,
    distillOnlyRefs,
    fullySkippedCount,
    feedbackSummary,
    signalFiltered,
    signalBearingSet,
    retrievalCounts,
    proactiveRefs,
    proactiveMaintenanceSummary,
    highSalienceRefs,
    signalAndRetrievalRefs,
    mergedRefs,
    eligibilitySourceByRef,
  };
}

/**
 * The signal-delta partition of postCleanupRefs into the four buckets (pass:
 * candidate-gather, phase 3). The 2026-05-26 54-ref incident semantics move
 * VERBATIM — see the phase-2/3 comments inside.
 */
export function partitionBySignalDelta(args: {
  scope: ImproveScope;
  options: AkmImproveOptions;
  eventsCtx?: EventsContext;
  postCleanupRefs: ImproveEligibleRef[];
  validationFailureRefs: Set<string>;
  snapshot: SignalDeltaSnapshot;
}): {
  actions: ImproveActionResult[];
  distillCooledRefs: Set<string>;
  preCooldownCount: number;
  eligibleRefs: ImproveEligibleRef[];
  distillOnlyRefs: ImproveEligibleRef[];
  noFeedbackPool: ImproveEligibleRef[];
  fullySkippedCount: number;
} {
  const { scope, options, eventsCtx, postCleanupRefs, validationFailureRefs } = args;
  const { latestFeedbackTs, lastReflectProposalTs, lastDistillProposalTs } = args.snapshot;
  const actions: ImproveActionResult[] = [];
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
  //                         skipped here: they are handed to the proactive
  //                         (Layer 2) and high-salience (Layer 3) fallbacks
  //                         below so never-rated assets can still be improved.
  //                         Only refs those lanes decline are fully skipped.
  //   fullySkippedCount   — has stale feedback but no signal delta → genuine
  //                         skip (counted, aggregated event emitted post-loop),
  //                         excluded from sort.
  const eligibleRefs: ImproveEligibleRef[] = [];
  const distillOnlyRefs: ImproveEligibleRef[] = [];
  // Zero-(recent-)feedback refs deferred to the proactive/high-salience fallbacks.
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
      // at all. Rather than skip outright, defer to the proactive-maintenance
      // and high-salience fallbacks below: a never-rated asset is exactly what
      // those lanes are meant to rescue. Refs those lanes decline are skipped there.
      noFeedbackPool.push(r);
    } else {
      // Has feedback on record but no signal delta since the last proposal —
      // genuinely fully skipped. Counted here; a single aggregated
      // improve_skipped event is emitted after the loop (mirrors
      // strategy_filtered_all_passes) instead of one event per ref.
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
  // strategy_filtered_all_passes above). The per-ref loop previously produced
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

  return {
    actions,
    distillCooledRefs,
    preCooldownCount,
    eligibleRefs,
    distillOnlyRefs,
    noFeedbackPool,
    fullySkippedCount,
  };
}

/** Bulk per-ref feedback summary in a SINGLE readEvents pass (candidate-gather). */
function buildFeedbackSummaryMap(args: {
  processableRefs: ImproveEligibleRef[];
  noFeedbackPool: ImproveEligibleRef[];
  options: AkmImproveOptions;
  eventsCtx?: EventsContext;
  feedbackSinceCutoff: string;
}): Map<string, { hasSignal: boolean; positive: number; negative: number }> {
  const { processableRefs, noFeedbackPool, options, eventsCtx, feedbackSinceCutoff } = args;
  // Gap 6: only surface feedback signals from the last 30 days so that
  // ancient one-off feedback events don't permanently lock an asset into
  // every improve run. Assets with only stale signals fall through to the
  // proactive/high-salience fallbacks or are skipped until new signals arrive.
  // (FEEDBACK_SIGNAL_WINDOW_DAYS / feedbackSinceCutoff are already defined in
  // Phase 2 above for the signal-delta gate; we reuse them here.)

  // Pre-compute feedback summary per ref in a SINGLE bulk read so we don't
  // open state.db once per asset (which caused 5000+ accumulated FDs and a
  // 2-hour runaway on a 13K-asset stash). Pattern mirrors buildLatestFeedbackTsMap
  // above: one readEvents() call fetches ALL feedback events, then we aggregate
  // in-memory by ref — O(1) DB opens regardless of candidate set size.
  // Cover processableRefs *and* the deferred noFeedbackPool so utility/feedback
  // ratios are available for any noFeedbackPool ref the fallback lanes rescue below.
  //
  // Behavioral note: positive/negative COUNTS are all-time (same as the old
  // per-ref readEvents call which had no `since` filter); hasSignal is bounded
  // to feedbackSinceCutoff (same as the old inline `(e.ts ?? "") >= cutoff` guard).
  const feedbackSummary = new Map<string, { hasSignal: boolean; positive: number; negative: number }>();
  {
    const feedbackCandidateRefs = [...processableRefs, ...noFeedbackPool].map((r) => r.ref);
    const feedbackCandidateSet = new Set(feedbackCandidateRefs);
    const feedbackRefByDurableKey = new Map(
      feedbackCandidateRefs.flatMap((ref) =>
        improveStateReadRefs(ref, options.sourceName, options.legacyBareState).map((key) => [key, ref]),
      ),
    );
    if (feedbackCandidateSet.size > 0) {
      // Fetch ALL feedback events in one query (no ref filter, no since filter =
      // single full table scan). Filtering per-ref in memory avoids N sequential
      // state.db opens — the dominant FD-leak path on large stashes.
      const { events: allFeedbackEvents } = readEvents({ type: "feedback" }, eventsCtx);
      for (const e of allFeedbackEvents) {
        const ref = e.ref ? feedbackRefByDurableKey.get(e.ref) : undefined;
        if (!ref) continue;
        const entry = feedbackSummary.get(ref) ?? { hasSignal: false, positive: 0, negative: 0 };
        const meta = e.metadata as { signal?: unknown; note?: unknown } | undefined;
        // hasSignal: only count feedback events within the 30-day window.
        if (
          !entry.hasSignal &&
          (e.ts ?? "") >= feedbackSinceCutoff &&
          meta !== undefined &&
          (typeof meta.signal === "string" || typeof meta.note === "string")
        ) {
          entry.hasSignal = true;
        }
        // positive/negative: all-time counts (no since filter, matching prior behaviour).
        if (meta?.signal === "positive") entry.positive++;
        else if (meta?.signal === "negative") entry.negative++;
        feedbackSummary.set(ref, entry);
      }
      // Ensure every candidate has an entry (even refs with zero feedback events).
      for (const ref of feedbackCandidateSet) {
        if (!feedbackSummary.has(ref)) {
          feedbackSummary.set(ref, { hasSignal: false, positive: 0, negative: 0 });
        }
      }
    }
  }
  return feedbackSummary;
}

/** Retrieval counts + last-use timestamps for the candidate pools (candidate-gather). */
function fetchRetrievalSignals(args: {
  options: AkmImproveOptions;
  primaryStashDir?: string;
  signalFiltered: ImproveEligibleRef[];
  noFeedbackCandidates: ImproveEligibleRef[];
}): { retrievalCounts: Map<string, number>; lastUseMsForProactive: Map<string, number> } {
  const { options, primaryStashDir, signalFiltered, noFeedbackCandidates } = args;
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
    retrievalCounts = getRetrievalCounts(dbForRetrieval, allCandidateRefs, {
      sourceName: options.sourceName,
      stashDir: primaryStashDir,
      includeLegacyBare: options.legacyBareState,
    });
    lastUseMsForProactive = getLastUseMsByRef(
      dbForRetrieval,
      noFeedbackCandidates.map((r) => r.ref),
      primaryStashDir,
    );
  } catch (err) {
    rethrowIfTestIsolationError(err);
    // best-effort: if DB unavailable, retrievalCounts/lastUseMsForProactive stay empty
  } finally {
    if (dbForRetrieval) closeDatabase(dbForRetrieval);
  }
  return { retrievalCounts, lastUseMsForProactive };
}

/** Layer 2 — the proactive-maintenance selector lane (candidate-gather). */
function selectProactiveMaintenanceLane(args: {
  scope: ImproveScope;
  improveProfile: import("../../core/config/config").ImproveProfileConfig;
  resolvedPlan: ResolvedImprovePlan;
  eventsCtx?: EventsContext;
  noFeedbackCandidates: ImproveEligibleRef[];
  lastReflectProposalTs: ReturnType<typeof buildLatestProposalTsMap>;
  lastDistillProposalTs: ReturnType<typeof buildLatestProposalTsMap>;
  retrievalCounts: Map<string, number>;
  lastUseMsForProactive: Map<string, number>;
}): {
  proactiveRefs: ImproveEligibleRef[];
  proactiveMaintenanceSummary?: { selected: number; dueTotal: number; neverReflected: number };
} {
  const {
    scope,
    improveProfile,
    resolvedPlan,
    eventsCtx,
    noFeedbackCandidates,
    lastReflectProposalTs,
    lastDistillProposalTs,
    retrievalCounts,
    lastUseMsForProactive,
  } = args;
  // ── Layer 2: PROACTIVE MAINTENANCE SELECTOR (second eligibility source) ────
  // The signal-delta gate only surfaces assets with fresh feedback. It never
  // revisits a stable, high-value asset on a schedule, so on a quiet stash
  // useful assets drift stale and are never refreshed. When the
  // `proactiveMaintenance` process is enabled (DEFAULT OFF)
  // and the run is whole-stash / type scope, this selector ranks the eligible
  // population by a composite maintenance priority, gates on staleness ("due"),
  // bounds to top-N, and folds the winners into the SAME candidate set the other
  // sources feed — so they flow through the existing #580 empty-diff /
  // cosmetic suppression and additive-distill gates. It adds no new mutation
  // logic of its own. The due gate doubles as the rotation cooldown: a freshly
  // reflected asset is excluded until it ages back past `dueDays`, so successive
  // runs rotate through the due pool rather than re-selecting the same heads.
  let proactiveRefs: ImproveEligibleRef[] = [];
  let proactiveMaintenanceSummary: { selected: number; dueTotal: number; neverReflected: number } | undefined;
  const proactiveEnabled = scope.mode !== "ref" && resolvedPlan.processes.proactiveMaintenance.enabled;
  if (proactiveEnabled) {
    const pmCfg = improveProfile.processes?.proactiveMaintenance;
    const dueDays = pmCfg?.dueDays ?? DEFAULT_DUE_DAYS;
    const maxPerRun = pmCfg?.maxPerRun ?? pmCfg?.limit ?? DEFAULT_MAX_PER_RUN;

    // Candidate population: the zero-feedback / non-signal pool — exactly the
    // assets the signal-delta gate would NOT pick this run.
    const pmCandidates = noFeedbackCandidates;

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
  return { proactiveRefs, proactiveMaintenanceSummary };
}

/** Layer 3 — the high-salience admission gate (#608/#644; candidate-gather). */
function selectHighSalienceLane(args: {
  options: AkmImproveOptions;
  improveProfile: import("../../core/config/config").ImproveProfileConfig;
  eventsCtx?: EventsContext;
  noFeedbackCandidates: ImproveEligibleRef[];
  proactiveRefs: ImproveEligibleRef[];
  lastReflectProposalTs: ReturnType<typeof buildLatestProposalTsMap>;
}): ImproveEligibleRef[] {
  const { options, improveProfile, eventsCtx, noFeedbackCandidates, proactiveRefs, lastReflectProposalTs } = args;
  // ── Layer 3: HIGH-SALIENCE ADMISSION GATE (#608) ──────────────────────────
  // Zero-feedback refs whose encoding_salience (set at distill time by
  // scoreEncodingSalience) exceeds the configured salienceThreshold are admitted
  // into the improve run even without retrieval or feedback signal. This rescues
  // newly distilled assets that the stash has not yet surfaced to users.
  //
  // Cap: at most 10% of the effective run limit so the lane cannot crowd out
  // reactive feedback. Requires state.db to have an asset_salience row — refs
  // without a row (pre-#608 assets still on the type-weight stub) are skipped.
  //
  // Cooldown: a ref qualifies at most once — when no prior reflect proposal
  // exists for it (`!lastReflectProposalTs.has`). Without this guard the lane
  // re-selects the same high-salience refs on EVERY run (promotion emits a
  // `promoted` event, not `feedback`, so the ref never leaves
  // noFeedbackCandidates), burning LLM calls and churning the asset. This
  // mirrors the same `!lastReflectProposalTs.has(r.ref)` once-per-asset
  // semantics the other "rescue" lanes share.
  //
  // Content-provenance gate (#644 follow-up): the row must ALSO carry a genuine
  // content-derived encoding score (`isContentEncodingRow`). Otherwise the lane
  // admits the per-type WEIGHT STUB (skill/agent 0.9, command/workflow 0.8,
  // lesson 0.75 from DEFAULT_TYPE_ENCODING_WEIGHTS) for every distill-unscored
  // asset — i.e. "high-salience" degenerates into "is a skill/agent/command/
  // lesson", which selected the lore-writer type-stub agent on every run. Only
  // content-scored assets earn the high-salience rescue; type-stub rows must
  // earn retrieval/feedback signal via the other lanes. This PRESERVES #608's
  // intent — distilled assets (the lane's real targets) keep their real content
  // score and still qualify — while cutting the type-stub waste. See §5 F1 of
  // docs/design/improve-salience-working-reference.md and #608/#644.
  const highSalienceRefs: ImproveEligibleRef[] = [];
  const salienceCfg = (options.config ?? loadConfig()).improve?.salience;
  const salienceThreshold = salienceCfg?.salienceThreshold ?? 0.75;
  const proactiveSelectedSet = new Set(proactiveRefs.map((r) => r.ref));
  try {
    withStateDb(
      (dbForHighSalience) => {
        // Derive the cap from the resolved reflect limit (mirrors improve.ts's
        // options.limit resolution) so an unbounded whole-stash run does not
        // collapse the lane to exactly 1 ref via the bare `?? 10` fallback.
        const effectiveLimit = options.limit ?? improveProfile?.processes?.reflect?.limit ?? improveProfile.limit ?? 10;
        const highSalienceCap = Math.max(1, Math.floor(effectiveLimit * 0.1));
        const candidates = noFeedbackCandidates.filter((r) => !proactiveSelectedSet.has(r.ref));
        // Collect ALL qualifying candidates, then take the top-N BY SCORE — the
        // previous first-N-in-scan-order break meant a higher-salience candidate
        // found later in the scan lost its slot to an earlier lower-scoring one.
        const qualifying: Array<{ ref: ImproveEligibleRef; score: number }> = [];
        for (const r of candidates) {
          const row = readAssetSalienceForImproveRef(
            dbForHighSalience,
            r.ref,
            options.sourceName,
            options.legacyBareState,
            r.itemRef,
          );
          if (
            row &&
            isContentEncodingRow(row, legacyTypeOf(r.ref)) &&
            row.encoding_salience >= salienceThreshold &&
            !lastReflectProposalTs.has(r.ref)
          ) {
            qualifying.push({ ref: r, score: row.encoding_salience });
          }
        }
        qualifying.sort((a, b) => b.score - a.score);
        for (const q of qualifying.slice(0, highSalienceCap)) {
          highSalienceRefs.push(q.ref);
        }
      },
      { path: eventsCtx?.dbPath },
    );
  } catch (err) {
    rethrowIfTestIsolationError(err);
    // best-effort: if DB unavailable, highSalienceRefs stays empty
  }
  if (highSalienceRefs.length > 0) {
    info(
      `[improve] high-salience lane admitted ${highSalienceRefs.length} content-scored ref(s) ` +
        `(threshold=${salienceThreshold}, requires content-derived encoding_source)`,
    );
  }
  return highSalienceRefs;
}

/**
 * Pass: salience-score — the WS-2 outcome loop, the WS-1 salience vector
 * computation (#644 provenance preserved), persistence + rank-change report,
 * and the forgetting-safety injection. The valence-score call sites
 * (computeValenceScore) live VERBATIM inside the outcome/persist sub-passes.
 * Mutates the shared eligibilitySourceByRef map and ref objects in place —
 * attribution identity is load-bearing (see the candidate-gather comments).
 */
function scoreSalience(args: {
  scope: ImproveScope;
  options: AkmImproveOptions;
  primaryStashDir?: string;
  eventsCtx?: EventsContext;
  improveProfile: import("../../core/config/config").ImproveProfileConfig;
  mergedRefs: ImproveEligibleRef[];
  eligibilitySourceByRef: Map<string, EligibilitySource>;
  feedbackSummary: Map<string, { hasSignal: boolean; positive: number; negative: number }>;
  retrievalCounts: Map<string, number>;
  signalFiltered: ImproveEligibleRef[];
  proactiveRefs: ImproveEligibleRef[];
  highSalienceRefs: ImproveEligibleRef[];
}): {
  mergedRefs: ImproveEligibleRef[];
  utilityMap: Map<string, number>;
  lastUseMsByRef: Map<string, number>;
  salienceMap: Map<string, ReturnType<typeof computeSalience>>;
  nowForSalience: number;
} {
  const {
    scope,
    options,
    primaryStashDir,
    eventsCtx,
    improveProfile,
    eligibilitySourceByRef,
    feedbackSummary,
    retrievalCounts,
    signalFiltered,
    proactiveRefs,
    highSalienceRefs,
  } = args;
  const mergedRefs = args.mergedRefs;
  // Chunk-5 flip F5e — resolve each candidate's durable item_ref ONCE for this
  // pass (the write/read key source for the outcome + salience state writers).
  const itemRefByRef = buildItemRefByRef(mergedRefs);

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
      primaryStashDir,
    );
  } catch (err) {
    rethrowIfTestIsolationError(err);
    // best-effort: if DB unavailable, recency term stays at floor (lastUseMs=0)
  } finally {
    if (dbForSalience) closeDatabase(dbForSalience);
  }

  const outcomeSalienceByRef = updateOutcomeScores({
    mergedRefs,
    itemRefByRef,
    feedbackSummary,
    retrievalCounts,
    lastUseMsByRef,
    utilityMap,
    primaryStashDir,
    eventsCtx,
  });

  const { salienceMap, nowForSalience } = computeSalienceVectors({
    mergedRefs,
    itemRefByRef,
    options,
    eventsCtx,
    retrievalCounts,
    lastUseMsByRef,
    utilityMap,
    outcomeSalienceByRef,
  });

  const pendingForgettingRefs = persistSalienceAndReportRanks({
    salienceMap,
    itemRefByRef,
    utilityMap,
    feedbackSummary,
    options,
    eventsCtx,
    nowForSalience,
  });

  const finalMergedRefs = applyForgettingSafety({
    pendingForgettingRefs,
    scope,
    mergedRefs,
    eligibilitySourceByRef,
    highSalienceRefs,
    proactiveRefs,
    signalFiltered,
  });

  return { mergedRefs: finalMergedRefs, utilityMap, lastUseMsByRef, salienceMap, nowForSalience };
}

/** WS-2 — update asset_outcome for the merged set; returns outcomeSalience by ref. */
function updateOutcomeScores(args: {
  mergedRefs: ImproveEligibleRef[];
  itemRefByRef: Map<string, string | undefined>;
  feedbackSummary: Map<string, { hasSignal: boolean; positive: number; negative: number }>;
  retrievalCounts: Map<string, number>;
  lastUseMsByRef: Map<string, number>;
  utilityMap: Map<string, number>;
  primaryStashDir?: string;
  eventsCtx?: EventsContext;
}): Map<string, number> {
  const {
    mergedRefs,
    itemRefByRef,
    feedbackSummary,
    retrievalCounts,
    lastUseMsByRef,
    utilityMap,
    primaryStashDir,
    eventsCtx,
  } = args;
  // ── WS-2 Outcome loop ─────────────────────────────────────────────────────
  //
  // Update asset_outcome for every ref in the merged set BEFORE computing the
  // salience vector so the updated outcome_score feeds outcomeSalience this run.
  //
  // Inputs per ref:
  //   - currentRetrievalCount: from retrievalCounts (index DB)
  //   - lastRetrievedAt: from lastUseMsByRef (utility_scores.last_used_at)
  //   - negativeFeedbackCount: cumulative negatives from feedbackSummary
  //   - acceptedChangeCount: accepted proposals for this ref (state.db)
  //   - valence: net valence from computeValenceScore(feedbackSummary.get(ref))
  //   - utilityScore: from utilityMap (for warm-start seed on new rows)
  //
  // Best-effort: outcome failures never block the salience or ranking pass.
  const outcomeSalienceByRef = new Map<string, number>();
  try {
    withStateDb(
      (outcomeDb) => {
        // Count accepted proposals per ref in one pass (avoid N separate queries).
        // Scoped to primaryStashDir when available so multi-stash installs don't
        // inflate counts with proposals from other stashes.
        const acceptedCountByRef = new Map<string, number>();
        try {
          const acceptedProposals = listStateProposals(outcomeDb, {
            status: "accepted",
            ...(primaryStashDir ? { stashDir: primaryStashDir } : {}),
          });
          for (const p of acceptedProposals) {
            acceptedCountByRef.set(p.ref, (acceptedCountByRef.get(p.ref) ?? 0) + 1);
          }
        } catch {
          // best-effort: if proposals query fails, accepted counts stay at 0
        }

        // Update each ref's outcome row and collect the resulting outcome scores.
        const rawOutcomeScores = new Map<string, number>();
        const nowForOutcome = Date.now();
        for (const r of mergedRefs) {
          const fb = feedbackSummary.get(r.ref) ?? { positive: 0, negative: 0 };
          const valenceResult = computeValenceScore(fb);
          try {
            const result = updateAssetOutcome(outcomeDb, {
              // Chunk-5 flip F5e — key by item_ref when resolved, else the bare
              // pre-flip outcome spelling. rawOutcomeScores stays keyed by the
              // bare `r.ref` (its in-memory identity for the salience vector).
              ref: outcomeWriteKey(r.ref, itemRefByRef),
              currentRetrievalCount: retrievalCounts.get(r.ref) ?? 0,
              lastRetrievedAt: lastUseMsByRef.get(r.ref) ?? 0,
              acceptedChangeCount: acceptedCountByRef.get(r.ref) ?? 0,
              negativeFeedbackCount: fb.negative,
              valence: valenceResult.valence,
              utilityScore: utilityMap.get(r.ref),
              now: nowForOutcome,
            });
            rawOutcomeScores.set(r.ref, result.outcomeScore);
          } catch {
            // best-effort per-ref: skip this ref's outcome update on failure
          }
        }

        // Compute stash-wide max outcome_score for normalisation (diversity floor).
        // Read ALL rows (not just this run's batch) so the normalisation is
        // stash-relative, not pool-relative.
        let maxOutcomeScore = 0;
        try {
          const allOutcomes = getAllAssetOutcomes(outcomeDb);
          for (const row of allOutcomes) {
            if (row.outcome_score > maxOutcomeScore) maxOutcomeScore = row.outcome_score;
          }
          // Read-clip: legacy rows written before the OUTCOME_SCORE_MAX write-clip
          // existed can sit above the ceiling (live max was 3.13). Without this
          // clip they inflate the normalisation denominator and floor everyone
          // else's outcomeSalience (#691 follow-up).
          maxOutcomeScore = Math.min(maxOutcomeScore, OUTCOME_SCORE_MAX);

          // Proxy-adequacy tripwire (two-tailed): inverted (corr < −0.3) and
          // dead (|corr| < 0.1 at n ≥ 500) both emit health events.
          const adequacy = computeProxyAdequacy(allOutcomes);
          if (adequacy.isInverted) {
            appendEvent(
              {
                eventType: "outcome_proxy_inverted",
                ref: undefined,
                metadata: {
                  correlation: adequacy.correlation,
                  n: adequacy.n,
                  note: "corr(outcome_score, accepted_change_rate) < −0.3: high-outcome_score assets have LOW accepted-change rates — the proxy's 'doing well' signal is inverted, so the coarse retrieval-delta signal is no longer trustworthy and the 0.10+ rich in-session signal is no longer deferrable. See plan §WS-2 proxy-adequacy tripwire.",
                },
              },
              eventsCtx,
            );
          }
          if (adequacy.isDead) {
            appendEvent(
              {
                eventType: "outcome_proxy_dead",
                ref: undefined,
                metadata: {
                  correlation: adequacy.correlation,
                  n: adequacy.n,
                  note: "|corr(outcome_score, accepted_change_rate)| < 0.1 at n ≥ 500: outcome_score is statistically unrelated to improvement outcomes — the proxy is noise, not signal. Rank contributions derived from it are not currently informative.",
                },
              },
              eventsCtx,
            );
          }
        } catch {
          // best-effort: tripwire failure never blocks ranking
        }

        // Convert raw outcome scores → normalised outcomeSalience values in [0,1].
        for (const [ref, score] of rawOutcomeScores) {
          const normalised = outcomeScoreToSalience(score, maxOutcomeScore);
          outcomeSalienceByRef.set(ref, normalised);
        }

        // Also fetch outcome scores for refs NOT updated this run (stale or absent)
        // so the outcomeSalience read path works for all refs in the batch.
        // Chunk-5 flip F5e — query by each missing ref's WRITE key (item_ref,
        // else bare) and map the stored-key result back to the bare `r.ref`
        // identity that outcomeSalienceByRef is keyed on.
        const missingRefs = mergedRefs.map((r) => r.ref).filter((ref) => !rawOutcomeScores.has(ref));
        if (missingRefs.length > 0) {
          const refByWriteKey = new Map<string, string>();
          for (const ref of missingRefs) refByWriteKey.set(outcomeWriteKey(ref, itemRefByRef), ref);
          const storedScores = getOutcomeScoresByRef(outcomeDb, [...refByWriteKey.keys()]);
          for (const [writeKey, score] of storedScores) {
            const bareRef = refByWriteKey.get(writeKey) ?? writeKey;
            outcomeSalienceByRef.set(bareRef, outcomeScoreToSalience(score, maxOutcomeScore));
          }
        }
      },
      { path: eventsCtx?.dbPath, borrowed: eventsCtx?.db },
    );
  } catch (err) {
    rethrowIfTestIsolationError(err);
    // best-effort: outcome failures never block salience computation
  }
  return outcomeSalienceByRef;
}

/** WS-1 — compute the salience vector per ref (#644 provenance preserved). */
function computeSalienceVectors(args: {
  mergedRefs: ImproveEligibleRef[];
  itemRefByRef: Map<string, string | undefined>;
  options: AkmImproveOptions;
  eventsCtx?: EventsContext;
  retrievalCounts: Map<string, number>;
  lastUseMsByRef: Map<string, number>;
  utilityMap: Map<string, number>;
  outcomeSalienceByRef: Map<string, number>;
}): { salienceMap: Map<string, ReturnType<typeof computeSalience>>; nowForSalience: number } {
  const {
    mergedRefs,
    itemRefByRef,
    options,
    eventsCtx,
    retrievalCounts,
    lastUseMsByRef,
    utilityMap,
    outcomeSalienceByRef,
  } = args;
  // Compute the salience vector for every ref in the merged set.
  // retrievalCounts now covers the full candidate set (feedback-bearing + zero-feedback)
  // so feedback refs get their genuine retrieval frequency, not a 0-floor fallback.
  // outcomeSalienceByRef is populated by WS-2 above (or empty on first run).
  //
  // R1 loop closure: the outcome weight is ON by default (the G2 saturation
  // cap makes it safe). Operators opt out with
  // improve.salience.outcomeWeightEnabled: false in the config.
  const salienceConfig = (options.config ?? loadConfig()).improve?.salience;
  const outcomeWeightEnabled = salienceConfig?.outcomeWeightEnabled !== false;
  const salienceMap = new Map<string, ReturnType<typeof computeSalience>>();
  const nowForSalience = Date.now();

  // #644 — preserve content-derived encoding scores across runs.
  //
  // Before computing the salience vector, load each ref's stored encoding score
  // and its provenance. When the stored row carries a genuine content-derived
  // score (written by the distill path via `scoreEncodingSalience`), pass that
  // value back in as `inputs.encodingSalience` so `computeSalience` does NOT fall
  // back to the type-weight stub — keeping both the persisted `encoding_salience`
  // AND the derived `rank_score` keyed on real novelty/magnitude/prediction-error.
  // Refs that have never been content-scored keep the type-weight stub fallback.
  const storedEncodingByRef = new Map<string, number>();
  try {
    withStateDb(
      (dbForStoredEncoding) => {
        for (const r of mergedRefs) {
          const type = legacyTypeOf(r.ref);
          const row = readAssetSalienceForImproveRef(
            dbForStoredEncoding,
            r.ref,
            options.sourceName,
            options.legacyBareState,
            itemRefByRef.get(r.ref),
          );
          if (row && isContentEncodingRow(row, type)) {
            storedEncodingByRef.set(r.ref, row.encoding_salience);
          }
        }
      },
      { path: eventsCtx?.dbPath },
    );
  } catch (err) {
    rethrowIfTestIsolationError(err);
    // best-effort: if DB unavailable, fall back to type-weight stub (prior behaviour)
  }

  for (const r of mergedRefs) {
    const type = legacyTypeOf(r.ref);
    const sizeBytes = (() => {
      const fp = r.filePath;
      if (!fp) return undefined;
      try {
        return fs.statSync(fp).size;
      } catch {
        return undefined;
      }
    })();
    const storedEncoding = storedEncodingByRef.get(r.ref);
    const vector = computeSalience({
      ref: r.ref,
      type,
      // #644: pass the stored content-derived score (if any) so the type-weight
      // stub is NOT re-asserted over a real distill-written encoding score.
      ...(storedEncoding !== undefined ? { encodingSalience: storedEncoding } : {}),
      retrievalFreq: retrievalCounts.get(r.ref) ?? 0,
      lastUseMs: lastUseMsByRef.get(r.ref),
      utilityScore: utilityMap.get(r.ref),
      outcomeSalience: outcomeSalienceByRef.get(r.ref),
      sizeBytes,
      now: nowForSalience,
      outcomeWeightEnabled,
    });
    salienceMap.set(r.ref, vector);
  }
  return { salienceMap, nowForSalience };
}

/** 1-indexed rank positions sorted by score desc (deterministic ref-asc tie-break). */
function toRankPositions(scores: Map<string, number>): Map<string, number> {
  const sorted = [...scores.entries()].sort(([refA, a], [refB, b]) =>
    b !== a ? b - a : refA < refB ? -1 : refA > refB ? 1 : 0,
  );
  return new Map(sorted.map(([ref], i) => [ref, i + 1]));
}

/**
 * Chunk-5 flip F5e — the durable salience write-key maps for one improve pass.
 * `wk(ref)` is a pool asset's write key (item_ref, else source-qualified);
 * `normalizeStoredKey` folds every stored spelling ([item_ref, durable, bare])
 * of an in-pool asset onto its write key (no stashSize double-count); and
 * `refByWriteKey` reverses a write key back to its filesystem-facing bare ref.
 */
function buildSalienceWriteKeyMaps(
  itemRefByRef: Map<string, string | undefined>,
  sourceName?: string,
): {
  wk: (ref: string) => string;
  normalizeStoredKey: Map<string, string>;
  refByWriteKey: Map<string, string>;
} {
  const wk = (ref: string): string => salienceWriteKey(ref, itemRefByRef, sourceName);
  const normalizeStoredKey = new Map<string, string>();
  const refByWriteKey = new Map<string, string>();
  for (const [ref, itemRef] of itemRefByRef) {
    const writeKey = wk(ref);
    refByWriteKey.set(writeKey, ref);
    for (const spelling of improveStateReadRefs(ref, sourceName, true, itemRef)) {
      normalizeStoredKey.set(spelling, writeKey);
    }
  }
  return { wk, normalizeStoredKey, refByWriteKey };
}

/** Persist salience vectors + the WS-1 step-7 rank-change/forgetting report. */
function persistSalienceAndReportRanks(args: {
  salienceMap: Map<string, ReturnType<typeof computeSalience>>;
  itemRefByRef: Map<string, string | undefined>;
  utilityMap: Map<string, number>;
  feedbackSummary: Map<string, { hasSignal: boolean; positive: number; negative: number }>;
  options: AkmImproveOptions;
  eventsCtx?: EventsContext;
  nowForSalience: number;
}): string[] {
  const { salienceMap, itemRefByRef, utilityMap, feedbackSummary, options, eventsCtx, nowForSalience } = args;
  // Chunk-5 flip F5e — the WRITE-key space. salienceMap stays keyed by each
  // candidate's own bare `r.ref`; the state.db boundary keys by the durable
  // salience write key (item_ref, else source-qualified `type:name`), and every
  // stored spelling of one asset folds onto that key so a seeded-legacy row and
  // a fresh item_ref write can never double-count in the rank report.
  const { wk, normalizeStoredKey, refByWriteKey } = buildSalienceWriteKeyMaps(itemRefByRef, options.sourceName);
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
  // A. First WS-1 run (table empty): the old stash-wide combinedEligibilityScore
  //    ordering was never persisted in state.db (asset_salience is a new WS-1 table).
  //    However, the old formula's inputs are available in-scope for every candidate
  //    in the current pool: utility comes from utilityMap and the attention term
  //    from feedbackSummary (positive/negative counts). We reconstruct the old
  //    combinedEligibilityScore = utility * UTILITY_WEIGHT + attention * FEEDBACK_WEIGHT
  //    for every ref in salienceMap and rank them, giving a candidate-pool-scoped
  //    old ordering. This is a partial reconstruction (only current-pool refs, not
  //    stash-wide), but it is the most faithful comparison possible at cutover and
  //    allows the top-200→below-500 forgetting guard to fire if the formula change
  //    dramatically reorders the candidate pool.
  //    See docs/archive/improve-reconciliation-plan.md §WS-1 step 7 — the stash-wide
  //    ordering was unreconstructable (no prior state.db snapshot), so this candidate-
  //    pool partial reconstruction is the documented resolution for the first-run case.
  //    Emit `improve_salience_first_run` to mark the cutover moment and include the
  //    reconstructed comparison result in the metadata.
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
  // time. salience.ts already accepts outcomeSalience directly as an input
  // (see SalienceInputs.outcomeSalience); no separate hook is needed.
  //
  // Forgetting-safety collection: populated inside scenario B below, consumed
  // after the try/catch to union candidates into mergedRefs before the sort.
  // Only refs from a real pre-existing ordering (scenario B) are collected;
  // empty on scenario A or when no candidates dropped below the threshold.
  let pendingForgettingRefs: string[] = [];
  try {
    withStateDb(
      (stateDb) => {
        // Step 7: stash-wide rank-change report BEFORE overwriting the table.
        //
        // Load ALL existing rows so rank positions are stash-relative, not pool-relative.
        // Chunk-5 flip F5e — source-scope by PREFIX (`<bundle|source>//…`, works
        // for BOTH grammars — no `parseAssetRef` throw on an item_ref row) and
        // fold each in-pool asset's stored spelling onto its single write key so
        // the merge below never double-counts one asset across two spellings.
        const allStoredScores = getAllRankScores(stateDb);
        const existingAllScores = new Map<string, number>();
        for (const [ref, score] of allStoredScores) {
          if (options.sourceName) {
            const boundary = ref.indexOf("//");
            const prefix = boundary >= 0 ? ref.slice(0, boundary) : undefined;
            const belongs = prefix === options.sourceName || (options.legacyBareState && prefix === undefined);
            if (!belongs) continue;
          }
          existingAllScores.set(normalizeStoredKey.get(ref) ?? ref, score);
        }

        if (existingAllScores.size === 0) {
          // Scenario A: first WS-1 run — table empty.
          //
          // Reconstruct the old combinedEligibilityScore ordering for the current
          // candidate pool using inputs that are already in-scope: utility from
          // utilityMap and the attention term from feedbackSummary (positive/negative
          // counts). Old formula: score = utility * UTILITY_WEIGHT + attention * FEEDBACK_WEIGHT.
          //
          // Limitation: this covers only the current-run candidate pool, not the full
          // stash. The stash-wide ordering was never persisted (asset_salience is a new
          // WS-1 table), so this is the most faithful comparison possible at cutover.
          // See docs/archive/improve-reconciliation-plan.md §WS-1 step 7.
          const reconstructedOldScores = new Map<string, number>();
          for (const ref of salienceMap.keys()) {
            const utility = utilityMap.get(ref) ?? 0;
            const fb = feedbackSummary.get(ref) ?? { positive: 0, negative: 0 };
            const attention = computeValenceScore(fb).attention;
            reconstructedOldScores.set(ref, utility * UTILITY_WEIGHT + attention * FEEDBACK_WEIGHT);
          }

          // Assign 1-indexed rank positions sorted by score desc (tie-break: ref asc).
          const oldRanks = toRankPositions(reconstructedOldScores);
          const newRanks = toRankPositions(new Map([...salienceMap.entries()].map(([ref, v]) => [ref, v.rankScore])));
          const firstRunReport = buildRankChangeReport(oldRanks, newRanks);
          if (firstRunReport.forgettingCandidates.length > 0) {
            warn(
              `[improve/salience] WS-1 first-run rank-change report: ${firstRunReport.forgettingCandidates.length} asset(s) fell from top-200 to below position 500 (cutover formula change). ` +
                `Top drops: ${firstRunReport.forgettingCandidates
                  .slice(0, 5)
                  .map((e) => `${e.ref} (#${e.oldRank}→#${e.newRank})`)
                  .join(", ")}`,
            );
            pendingForgettingRefs = firstRunReport.forgettingCandidates.map((e) => e.ref);
          }
          appendEvent(
            {
              eventType: "improve_salience_first_run",
              ref: undefined,
              metadata: {
                candidateCount: salienceMap.size,
                note: "first WS-1 salience run — partial reconstruction of old combinedEligibilityScore ordering for candidate pool (stash-wide ordering not available); see improve-reconciliation-plan.md §WS-1 step 7",
                forgettingCandidates: firstRunReport.forgettingCandidates.length,
                topDrops: firstRunReport.forgettingCandidates.slice(0, 10).map((e) => ({
                  ref: e.ref,
                  oldRank: e.oldRank,
                  newRank: e.newRank,
                })),
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
            // Chunk-5 flip F5e — key this run's fresh scores by the WRITE key so
            // they overwrite (never duplicate) the same asset's normalized stored row.
            mergedNewScores.set(wk(ref), vector.rankScore);
          }

          // Assign 1-indexed rank positions sorted by score desc (tie-break: ref asc).
          const oldRanks = toRankPositions(existingAllScores);
          const newRanks = toRankPositions(mergedNewScores);

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
            // Chunk-5 flip F5e — map an in-pool candidate's write-key spelling
            // back to its bare `r.ref` so applyForgettingSafety re-stamps the
            // existing pool ref; a genuinely stash-wide (out-of-pool) candidate
            // keeps its stored spelling and is synthesised as a fresh stub.
            pendingForgettingRefs = report.forgettingCandidates.map((e) => refByWriteKey.get(e.ref) ?? e.ref);
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
          // Chunk-5 flip F5e — persist salience under the durable WRITE key
          // (item_ref when resolved, else source-qualified `type:name`).
          upsertAssetSalience(stateDb, wk(ref), vector, nowForSalience);
        }
      },
      { path: eventsCtx?.dbPath },
    );
  } catch (err) {
    rethrowIfTestIsolationError(err);
    // best-effort: salience persistence failure never blocks ranking
  }
  return pendingForgettingRefs;
}

/**
 * The protective forgetting-safety injection (plan §WS-1 step 7). Returns the
 * (possibly extended) mergedRefs; re-stamps lane attribution in precedence
 * order on the SHARED ref objects and eligibilitySourceByRef map.
 */
export function applyForgettingSafety(args: {
  pendingForgettingRefs: string[];
  scope: ImproveScope;
  mergedRefs: ImproveEligibleRef[];
  eligibilitySourceByRef: Map<string, EligibilitySource>;
  highSalienceRefs: ImproveEligibleRef[];
  proactiveRefs: ImproveEligibleRef[];
  signalFiltered: ImproveEligibleRef[];
}): ImproveEligibleRef[] {
  const { pendingForgettingRefs, scope, eligibilitySourceByRef, highSalienceRefs, proactiveRefs, signalFiltered } =
    args;
  let mergedRefs = args.mergedRefs;
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
      // stronger reactive signals — scope/signal-delta/proactive — are written
      // after this block so they take precedence).
      eligibilitySourceByRef.set(ref, "forgetting-safety");
    }
    if (newForgettingRefs.length > 0) {
      mergedRefs = dedupeRefs([...mergedRefs, ...newForgettingRefs]);
    }
    // Re-stamp attribution for any refs whose lane needs updating.
    // Precedence (weakest → strongest, each overwrites the previous):
    //   proactive < forgetting-safety < signal-delta
    // Scope mode is already excluded by the outer guard (`scope.mode !== "ref"`).
    // forgetting-safety sits above proactive so that a ref flagged as a
    // forgetting candidate is always visible to S5/WS-5 as such, even when it
    // was also due for a proactive maintenance run. signal-delta overrides
    // forgetting-safety because a ref with fresh feedback is reactive and
    // doesn't need the protective pass label for measurement purposes.
    for (const r of highSalienceRefs) eligibilitySourceByRef.set(r.ref, "high-salience");
    for (const r of proactiveRefs) eligibilitySourceByRef.set(r.ref, "proactive");
    // Apply forgetting-safety OVER proactive and high-salience (already
    // stamped in the loop above via
    // `eligibilitySourceByRef.set(ref, "forgetting-safety")`). No-op here: the
    // set() calls above for proactive/high-salience overwrite the earlier
    // forgetting-safety stamp — so we re-apply forgetting-safety now for those
    // refs that are both forgetting candidates AND in another fallback lane.
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
  return mergedRefs;
}

/**
 * Pass: eligibility-filter — replay selection (#610), the no-op dampener sort,
 * coverage gaps, the disk-existence guard, the --limit slice, and the summary
 * info emits.
 */
async function filterEligibility(args: {
  scope: ImproveScope;
  options: AkmImproveOptions;
  plannedRefs: ImproveEligibleRef[];
  eventsCtx?: EventsContext;
  mergedRefs: ImproveEligibleRef[];
  salienceMap: Map<string, ReturnType<typeof computeSalience>>;
  eligibilitySourceByRef: Map<string, EligibilitySource>;
  distillOnlyRefs: ImproveEligibleRef[];
  validationFailureRefs: Set<string>;
  /** Pass-2 tallies consumed only by the end-of-stage summary info emits. */
  summary: {
    fullySkippedCount: number;
    preCooldownCount: number;
    signalAndRetrievalRefs: ImproveEligibleRef[];
    signalFiltered: ImproveEligibleRef[];
  };
}): Promise<{
  loopRefs: ImproveEligibleRef[];
  actionableRefs: ImproveEligibleRef[];
  distillOnlyRefs: ImproveEligibleRef[];
  coverageGaps: string[];
}> {
  const { scope, options, plannedRefs, eventsCtx, salienceMap, eligibilitySourceByRef, distillOnlyRefs } = args;
  const { fullySkippedCount, preCooldownCount, signalAndRetrievalRefs, signalFiltered } = args.summary;
  const validationFailureRefs = args.validationFailureRefs;

  const replay = applyReplaySelection({
    scope,
    options,
    plannedRefs,
    eventsCtx,
    mergedRefs: args.mergedRefs,
    salienceMap,
    eligibilitySourceByRef,
  });
  const mergedRefs = replay.mergedRefs;
  const { replayRefSet, replayBudget } = replay;

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
          noOpMap.set(
            r.ref,
            readConsecutiveNoOpsForImproveRef(noOpDb, r.ref, options.sourceName, options.legacyBareState, r.itemRef),
          );
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
  // WIRING NOTE (plan §WS-1 step 8 / "consolidation-selection" disambiguation):
  // "consolidation-selection" in the plan refers to THIS reflect/distill
  // eligibility ordering — i.e. which assets are chosen for the reflect/distill
  // LLM pass — NOT to akmConsolidate (the cluster-merge phase at ~line 1994,
  // which runs earlier and never reads noOpMap).  The no-op counter originates
  // from no-change reflect / quality-rejected distill outcomes; the dampener
  // suppresses repeated LLM attempts on those same assets without touching their
  // persisted rank_score (so they remain fully retrievable).
  //
  // This is the ONLY ranking path — negativeOnlyRatio and the legacy
  // symmetricValence branch are replaced. The eligibilitySource lanes
  // (signal-delta / proactive / high-salience) survive as labels (set above).

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

  const diskCheck = await dropRefsMissingOnDisk({ sorted, options, eventsCtx });
  const assetMissingOnDisk = diskCheck.assetMissingOnDisk;
  const actionableRefs = diskCheck.actionableRefs;

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
  //
  // #610 ADDITIVITY: replay-lane refs are budgeted SEPARATELY from the --limit
  // fresh slice. Without this split, a high-rankScore replay ref could sort above
  // a fresh ref in the single combined slice and STEAL its slot (violating AC2).
  // We partition into the replay lane vs the rest, apply --limit to the
  // non-replay (fresh) refs only, then APPEND up to `replayBudget` replay refs
  // after the fresh slice. Sort order within each partition is preserved.
  //
  // Default replayBudget=0 reduces this to the exact pre-#610 expression: with no
  // replay refs, `nonReplayLoop === allLoopRefs`, so `baseLoop === old slice` and
  // `replayLoop.slice(0, 0) === []` — byte-identical.
  const allLoopRefs = [...reflectAndDistillRefsAfterSort, ...distillOnlyRefsAfterSort];
  const replayLoop = allLoopRefs.filter((r) => r.eligibilitySource === "replay");
  const nonReplayLoop = allLoopRefs.filter((r) => r.eligibilitySource !== "replay");
  const baseLoop = options.limit ? nonReplayLoop.slice(0, options.limit) : nonReplayLoop;
  const loopRefs = [...baseLoop, ...replayLoop.slice(0, replayBudget)];

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
      `[improve] ${signalAndRetrievalRefs.length} refs with usage signals (${signalFiltered.length} feedback${replayRefSet.size > 0 ? `, ${replayRefSet.size} replay` : ""})`,
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

  return { loopRefs, actionableRefs, distillOnlyRefs: distillOnlyRefsResult, coverageGaps };
}

/** The #610 bounded, additive replay-selection lane (eligibility-filter). */
function applyReplaySelection(args: {
  scope: ImproveScope;
  options: AkmImproveOptions;
  plannedRefs: ImproveEligibleRef[];
  eventsCtx?: EventsContext;
  mergedRefs: ImproveEligibleRef[];
  salienceMap: Map<string, ReturnType<typeof computeSalience>>;
  eligibilitySourceByRef: Map<string, EligibilitySource>;
}): { mergedRefs: ImproveEligibleRef[]; replayRefSet: Set<string>; replayBudget: number } {
  const { scope, options, plannedRefs, eventsCtx, salienceMap, eligibilitySourceByRef } = args;
  let mergedRefs = args.mergedRefs;
  // ── REPLAY SELECTION layer (#610) ─────────────────────────────────────────
  // Bounded, ADDITIVE replay budget: up to `replayBudget` top-salience refs are
  // revisited even with zero reactive signal (no feedback, no retrieval) and
  // regardless of cooldown — exactly like the forgetting-safety lane, replay is
  // injected AFTER cooldown/signal-delta partitioning so it bypasses those gates.
  //
  // Strictly additive: the replay slice is appended AFTER the --limit fresh slice
  // (see the loopRefs partition below), so it can never shrink the fresh-ref set.
  // Replay is the WEAKEST lane — it only stamps refs no other lane already claimed,
  // and budget is spent only on refs not already in mergedRefs (so a stronger lane
  // never has its budget wasted or its label overwritten).
  //
  // Default replayBudget=0 ⇒ this whole block is a no-op (no DB open, no event,
  // no mergedRefs mutation), preserving byte-identical pre-#610 selection behavior.
  const replayBudget = (options.config ?? loadConfig()).improve?.salience?.replayBudget ?? 0;
  const replayRefSet = new Set<string>();
  if (replayBudget > 0 && scope.mode !== "ref" && !options.requireFeedbackSignal) {
    try {
      withStateDb(
        (replayDb) => {
          const alreadyInPool = new Set(mergedRefs.map((r) => r.ref));
          const storedRankScores = getAllRankScores(replayDb);
          // Chunk-5 flip F5e — plan reverse map so a stored item_ref row re-keys
          // back onto its filesystem-facing bare ref (the replay stub must match
          // a planned entry for its filePath / disk check).
          const itemRefByPlanned = buildItemRefByRef(plannedRefs);
          const bareRefByItemRef = new Map<string, string>();
          for (const [bareRef, itemRef] of itemRefByPlanned) if (itemRef) bareRefByItemRef.set(itemRef, bareRef);
          const allRankScores = options.sourceName
            ? (() => {
                // Source-scope by PREFIX (both grammars — no `parseAssetRef` throw
                // on an item_ref row), then re-key onto the bare ref: item_ref rows
                // via the planned reverse map, legacy rows inline via bareImproveRef.
                const m = new Map<string, number>();
                for (const [ref, score] of storedRankScores) {
                  const boundary = ref.indexOf("//");
                  const prefix = boundary >= 0 ? ref.slice(0, boundary) : undefined;
                  const belongs = prefix === options.sourceName || (options.legacyBareState && prefix === undefined);
                  if (!belongs) continue;
                  m.set(bareRefByItemRef.get(ref) ?? bareImproveRef(ref), score);
                }
                return m;
              })()
            : storedRankScores;
          // Candidate universe = every salience row NOT already in the pool, ordered by
          // rank_score desc with a deterministic ref-string tie-break (mirrors the main
          // sort). Converged refs (consecutive_no_ops >= dampener threshold) are fully
          // EXCLUDED — a stronger skip than the dampener (which only halves order).
          let convergedSkipped = 0;
          const candidates: Array<{ ref: string; rankScore: number }> = [];
          for (const [ref, rankScore] of allRankScores) {
            if (alreadyInPool.has(ref)) continue;
            const noOps = readConsecutiveNoOpsForImproveRef(
              replayDb,
              ref,
              options.sourceName,
              options.legacyBareState,
              itemRefByPlanned.get(ref),
            );
            if (noOps >= SALIENCE_NO_OP_DAMPEN_THRESHOLD) {
              convergedSkipped++;
              continue;
            }
            candidates.push({ ref, rankScore });
          }
          candidates.sort((a, b) =>
            b.rankScore !== a.rankScore ? b.rankScore - a.rankScore : a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0,
          );
          const candidatePool = candidates.length;
          const selected = candidates.slice(0, replayBudget);
          const newReplayRefs: ImproveEligibleRef[] = [];
          for (const { ref } of selected) {
            replayRefSet.add(ref);
            // Synthesise a stub (mirror the forgetting-safety stub). Resolve the
            // backing file from the planned-ref pool so the downstream existsSync
            // guard keeps the ref (a replay candidate from asset_salience whose file
            // is gone correctly drops out). Only refs present in the indexed pool can
            // be revisited — refs without a planned entry get no filePath and are
            // dropped by the disk check, which is the desired behavior.
            const planned = plannedRefs.find((p) => p.ref === ref);
            newReplayRefs.push({
              ref,
              reason: "scope-type",
              eligibilitySource: "replay",
              ...(planned?.filePath ? { filePath: planned.filePath } : {}),
            });
            // Seed the salienceMap so the sort/effectiveScore can rank the replay ref.
            if (!salienceMap.has(ref)) {
              salienceMap.set(ref, {
                encoding: 0,
                outcome: 0,
                retrieval: 0,
                rankScore: allRankScores.get(ref) ?? 0,
              });
            }
          }
          if (newReplayRefs.length > 0) {
            mergedRefs = dedupeRefs([...mergedRefs, ...newReplayRefs]);
            // Replay is the WEAKEST lane: stamp 'replay' ONLY for refs not already
            // keyed by a stronger lane.
            for (const ref of replayRefSet) {
              if (!eligibilitySourceByRef.has(ref)) eligibilitySourceByRef.set(ref, "replay");
            }
            for (const r of mergedRefs) {
              r.eligibilitySource = eligibilitySourceByRef.get(r.ref) ?? "unknown";
            }
          }
          // Aggregated observability event (never per-ref).
          appendEvent(
            {
              eventType: "improve_replay_selected",
              ref: undefined,
              metadata: {
                count: newReplayRefs.length,
                budget: replayBudget,
                convergedSkipped,
                candidatePool,
              },
            },
            eventsCtx,
          );
        },
        { path: eventsCtx?.dbPath },
      );
    } catch (err) {
      rethrowIfTestIsolationError(err);
      // best-effort: if DB unavailable, replayRefSet stays empty
    }
  }
  return { mergedRefs, replayRefSet, replayBudget };
}

/** The final disk-existence guard + its aggregated audit event (eligibility-filter). */
async function dropRefsMissingOnDisk(args: {
  sorted: ImproveEligibleRef[];
  options: AkmImproveOptions;
  eventsCtx?: EventsContext;
}): Promise<{ actionableRefs: ImproveEligibleRef[]; assetMissingOnDisk: string[] }> {
  const { sorted, options, eventsCtx } = args;
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
  return { actionableRefs: existsCheckedActionable, assetMissingOnDisk };
}
