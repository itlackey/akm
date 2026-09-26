// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** Improve's run options and stage results (a type-only leaf the stages share). */

import type { AkmConfig, ImproveProfileConfig } from "../../core/config/config";
import type { EventsContext } from "../../core/events";
import type {
  AkmDistillResult,
  AkmReflectResult,
  ConsolidateResult,
  ImproveActionResult,
  ImproveEligibleRef,
  ImproveExecutionPlan,
  ImprovePlanGate,
} from "../../core/improve-types";
import type { ResolvedWriteTarget } from "../../core/write-source";
import type { EnsureIndexOptions } from "../../indexer/ensure-index";
import type { GraphExtractionResult, runGraphExtractionPass } from "../../indexer/graph/graph-extraction";
import type { MemoryInferenceResult, runMemoryInferencePass } from "../../indexer/passes/memory-inference";
import type { SessionLogHarness } from "../../integrations/session-logs/types";
import type { saveGitStash } from "../../sources/providers/git";
import type { drainProposals } from "../proposal/drain";
import type { DeadUrl, DeadUrlCoverage } from "../url-checker";
import type { akmDistill } from "./distill";
import type { collectEligibleRefs, resolveImproveScope } from "./eligibility";
import type { AkmExtractResult, countNewExtractCandidates } from "./extract";
import type { EngineProbeOutcome, ResolvedImprovePlan } from "./improve-strategies";
import type { applyMemoryCleanup } from "./memory/memory-improve";
import type { akmReflect } from "./reflect";

export type ImproveScope = ReturnType<typeof resolveImproveScope>;

type ReflectFn = (options: NonNullable<Parameters<typeof akmReflect>[0]>) => Promise<AkmReflectResult>;
type DistillFn = (options: NonNullable<Parameters<typeof akmDistill>[0]>) => Promise<AkmDistillResult>;

export interface AkmImproveOptions {
  scope?: string;
  task?: string;
  dryRun?: boolean;
  target?: string;
  /** Write target resolved once at the invocation boundary. */
  writeTarget?: ResolvedWriteTarget;
  /** Source identity for source-scoped operations. */
  sourceName?: string;
  stashDir?: string;
  config?: AkmConfig;
  /** Invocation plan the CLI preflighted before any side effect. */
  resolvedPlan?: ResolvedImprovePlan;
  /** Run id minted by the CLI, carried onto the result and the sync message (`{runId}`). */
  runId?: string;
  /** Wall-clock budget for the whole run (default 2 hours). */
  timeoutMs?: number;
  limit?: number;
  /** Skip the run quietly when another improve run holds the lock. */
  skipIfLocked?: boolean;
  /** Named improve strategy. */
  strategy?: string;
  /** Attempt LLM schema repair after structural validation (default true). */
  repairValidationFailures?: boolean;
  /** Only refs with recent feedback; disables the fallback lanes. */
  requireFeedbackSignal?: boolean;
  /** End-of-run auto-sync override (`--no-sync` / `--no-push`). */
  sync?: { enabled?: boolean; push?: boolean };
  /** `--require-engines` probe outcomes, recorded on the result. */
  engineProbe?: readonly EngineProbeOutcome[];
  // Test seams.
  collectEligibleRefsFn?: typeof collectEligibleRefs;
  runImprovePreparationStageFn?: typeof import("./preparation").runImprovePreparationStage;
  runImproveLoopStageFn?: typeof import("./loop-stages").runImproveLoopStage;
  runImprovePostLoopStageFn?: typeof import("./loop-stages").runImprovePostLoopStage;
  reflectFn?: ReflectFn;
  distillFn?: DistillFn;
  memoryInferenceFn?: typeof runMemoryInferencePass;
  graphExtractionFn?: typeof runGraphExtractionPass;
  extractCandidateCountFn?: typeof countNewExtractCandidates;
  /** Session-log harnesses for both the `minNewSessions` gate and the extract pass. */
  extractHarnesses?: SessionLogHarness[];
  ensureIndexFn?: (stashDir: string, options?: EnsureIndexOptions) => Promise<unknown>;
  reindexFn?: (options: { stashDir: string; signal?: AbortSignal }) => Promise<unknown>;
  drainProposalsFn?: typeof drainProposals;
  saveGitStashFn?: typeof saveGitStash;
}

export interface ImprovePreparationResult {
  actions: ImproveActionResult[];
  cleanupWarnings: string[];
  appliedCleanup?: ReturnType<typeof applyMemoryCleanup>;
  memoryIndexHealth?: { lineCount: number; overBudget: boolean };
  extract?: AkmExtractResult[];
  /** Refs surviving every selector and the disk check, ranked, before the limit. */
  actionableRefs: ImproveEligibleRef[];
  /** Refs with in-window feedback. */
  signalBearingSet: Set<string>;
  validationFailures: Array<{ ref: string; reason: string }>;
  schemaRepairs: Array<{
    ref: string;
    reason: string;
    outcome: "queued" | "skipped" | "error";
    proposalId?: string;
    error?: string;
  }>;
  lintSummary?: { fixed: number; flagged: number };
  /** The refs the loop processes, in order. */
  loopRefs: ImproveEligibleRef[];
  /** Refs whose distill signal delta did not pass. */
  distillCooledRefs: Set<string>;
  /** Refs that skip reflect and only distill. */
  distillOnlyRefs: ImproveEligibleRef[];
  coverageGaps: string[];
  recentErrors: Record<string, string[]>;
  consolidation: ConsolidateResult;
  proactiveMaintenance?: { selected: number; dueTotal: number; neverReflected: number; selectedRefs: string[] };
  planning: {
    gates: ImprovePlanGate[];
    proactive?: ImproveExecutionPlan["proactive"];
    consolidation: ImproveExecutionPlan["consolidation"];
    extract: { wouldRun: boolean; reason: string };
  };
}

export interface ImproveLoopResult {
  reflectsWithErrorContext: number;
  memoryRefsForInference: Set<string>;
}

export interface ImprovePostLoopResult {
  allWarnings: string[];
  deadUrls?: DeadUrl[];
  /** Present whenever the URL check ran, even with no dead links. */
  deadUrlCoverage?: DeadUrlCoverage;
  memoryInference?: MemoryInferenceResult;
  graphExtraction?: GraphExtractionResult;
  maintenanceActions?: ImproveActionResult[];
  memoryInferenceDurationMs: number;
  graphExtractionDurationMs: number;
  orphansPurged?: number;
  proposalsExpired?: number;
}

export interface ImproveMaintenanceResult {
  memoryInference?: MemoryInferenceResult;
  graphExtraction?: GraphExtractionResult;
  actions?: ImproveActionResult[];
  memoryInferenceDurationMs: number;
  graphExtractionDurationMs: number;
  orphansPurged?: number;
  proposalsExpired?: number;
}

export interface ConsolidationPassResult {
  consolidation: ConsolidateResult;
  plan: ImproveExecutionPlan["consolidation"];
}

/** What the loop stage receives. */
export interface ImproveLoopState {
  eventsCtx?: EventsContext;
  budgetSignal?: AbortSignal;
  /** The resolved primary source; unresolvable means the loop's state writes are skipped. */
  primaryStashDir: string | undefined;
  scope: ImproveScope;
  options: AkmImproveOptions;
  reflectFn: ReflectFn;
  distillFn: DistillFn;
  improveProfile: ImproveProfileConfig;
  resolvedPlan: ResolvedImprovePlan;
  startMs: number;
  budgetMs: number;
  loopRefs: ImproveEligibleRef[];
  actions: ImproveActionResult[];
  signalBearingSet: Set<string>;
  distillCooledRefs: Set<string>;
  distillOnlyRefs: ImproveEligibleRef[];
  recentErrors: Record<string, string[]>;
}
