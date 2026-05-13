import type { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
import { makeAssetRef, parseAssetRef } from "../core/asset-ref";
import type { AkmConfig } from "../core/config";
import { loadConfig } from "../core/config";
import { ConfigError, NotFoundError } from "../core/errors";
import { appendEvent, readEvents } from "../core/events";
import { parseFrontmatter } from "../core/frontmatter";
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
import { listProposals } from "../core/proposals";
import { info, warn } from "../core/warn";
import {
  closeDatabase,
  getAllEntries,
  getRetrievalCounts,
  getUtilityScoresByIds,
  getZeroResultSearches,
  openExistingDatabase,
} from "../indexer/db";
import { ensureIndex } from "../indexer/ensure-index";
import { akmIndex } from "../indexer/indexer";
import { resolveAssetPath } from "../indexer/path-resolver";
import { getWritableStashDirs, resolveSourceEntries } from "../indexer/search-source";
import { getExecutionLogCandidates } from "../integrations/session-logs";
import { type AkmConsolidateOptions, akmConsolidate, type ConsolidateResult } from "./consolidate";
import { type AkmDistillResult, akmDistill, deriveLessonRef } from "./distill";
import { countEvalCases, writeEvalCase } from "./eval-cases";
import { akmLint } from "./lint/index";
import { type AkmReflectResult, akmReflect } from "./reflect";
import { runSchemaRepairPass } from "./schema-repair";
import { checkDeadUrls, type DeadUrl } from "./url-checker";

export interface AkmImproveOptions {
  scope?: string;
  task?: string;
  dryRun?: boolean;
  target?: string;
  autoAccept?: "safe";
  stashDir?: string;
  config?: AkmConfig;
  /** Wall-clock budget for the entire improve run in milliseconds. Defaults to 2 hours. */
  timeoutMs?: number;
  limit?: number;
  consolidateOptions?: Omit<AkmConsolidateOptions, "config" | "stashDir">;
  /** Number of eligible memory assets above which consolidation is forced even if the memory_consolidation feature flag is not set. Defaults to 100. */
  memoryVolumeConsolidationThreshold?: number;
  reflectFn?: (options: NonNullable<Parameters<typeof akmReflect>[0]>) => Promise<AkmReflectResult>;
  distillFn?: (options: NonNullable<Parameters<typeof akmDistill>[0]>) => Promise<AkmDistillResult>;
  ensureIndexFn?: (stashDir: string) => Promise<unknown>;
  reindexFn?: (options: { stashDir: string }) => Promise<unknown>;
  /** When true (default), attempt LLM-driven schema repair on validation failures before skipping. Requires llm config. */
  repairValidationFailures?: boolean;
  /** Cooldown in days before re-reflecting an asset that was recently reflected. Defaults to 7. Set to 0 to disable. Only for this run; does not persist to config. */
  reflectCooldownDays?: number;
  /** Cooldown in days before re-distilling an asset with a recent accepted proposal. Defaults to 30. Set to 0 to disable. Only for this run; does not persist to config. */
  distillCooldownDays?: number;
  /** Cooldown in days before re-consolidating memories. Defaults to 14. Set to 0 to disable. Only for this run; does not persist to config. */
  consolidateCooldownDays?: number;
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
}

export interface ImproveEligibleRef {
  ref: string;
  reason: "scope-ref" | "scope-type" | "memory-cleanup";
}

export interface ImproveActionResult {
  ref: string;
  mode: "reflect" | "distill" | "distill-skipped" | "memory-prune" | "error";
  result:
    | AkmReflectResult
    | AkmDistillResult
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
  actions?: ImproveActionResult[];
  validationFailures?: Array<{ ref: string; reason: string }>;
  schemaRepairs?: Array<{
    ref: string;
    reason: string;
    outcome: "written" | "skipped" | "error";
    error?: string;
  }>;
  consolidation?: ConsolidateResult;
  lintSummary?: { fixed: number; flagged: number };
  memoryIndexHealth?: { lineCount: number; overBudget: boolean };
  feedbackRatioUsed?: boolean;
  coverageGaps?: string[];
  executionLogCandidates?: string[];
  evalCasesWritten?: number;
  deadUrls?: DeadUrl[];
  /** Number of reflect calls that had at least one error in the rolling window at call time. */
  crossStepErrorsInjected?: number;
}

function resolveImproveScope(scope: string | undefined): { mode: "all" | "type" | "ref"; value?: string } {
  const trimmed = scope?.trim();
  if (!trimmed) return { mode: "all" };
  try {
    parseAssetRef(trimmed);
    return { mode: "ref", value: trimmed };
  } catch {
    return { mode: "type", value: trimmed };
  }
}

async function collectEligibleRefs(
  scope: { mode: "all" | "type" | "ref"; value?: string },
  stashDir?: string,
): Promise<{
  plannedRefs: ImproveEligibleRef[];
  memorySummary: { eligible: number; derived: number };
}> {
  if (scope.mode === "ref" && scope.value) {
    const parsed = parseAssetRef(scope.value);
    const writableDirs = new Set(getWritableStashDirs(stashDir).map((dir) => path.resolve(dir)));
    const filePath = await findAssetFilePath(scope.value, stashDir, writableDirs);
    if (!filePath) {
      return {
        plannedRefs: [],
        memorySummary: { eligible: 0, derived: 0 },
      };
    }
    return {
      plannedRefs: [{ ref: scope.value, reason: "scope-ref" }],
      memorySummary: {
        eligible: parsed.type === "memory" ? 1 : 0,
        derived: parsed.type === "memory" && parsed.name.endsWith(".derived") ? 1 : 0,
      },
    };
  }

  let sources: ReturnType<typeof resolveSourceEntries>;
  try {
    sources = resolveSourceEntries(stashDir);
  } catch {
    return { plannedRefs: [], memorySummary: { eligible: 0, derived: 0 } };
  }
  if (sources.length === 0) {
    return { plannedRefs: [], memorySummary: { eligible: 0, derived: 0 } };
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
    let memoryEligible = 0;
    let memoryDerived = 0;
    for (const indexed of entries) {
      const ref = makeAssetRef(indexed.entry.type, indexed.entry.name);
      if (!planned.has(ref)) {
        planned.set(ref, {
          ref,
          reason:
            scope.mode === "type" ? "scope-type" : indexed.entry.type === "memory" ? "memory-cleanup" : "scope-type",
        });
      }
      if (indexed.entry.type === "memory") {
        memoryEligible += 1;
        if (indexed.entry.name.endsWith(".derived")) memoryDerived += 1;
      }
    }
    return {
      plannedRefs: [...planned.values()],
      memorySummary: { eligible: memoryEligible, derived: memoryDerived },
    };
  } catch (error) {
    if (error instanceof NotFoundError || error instanceof Error) {
      return { plannedRefs: [], memorySummary: { eligible: 0, derived: 0 } };
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

function filterRemovedPlannedRefs(plannedRefs: ImproveEligibleRef[], archivedRefs: string[]): ImproveEligibleRef[] {
  if (archivedRefs.length === 0) return plannedRefs;
  const removed = new Set(archivedRefs);
  return plannedRefs.filter((planned) => !removed.has(planned.ref));
}

function isLessonCandidate(ref: string): boolean {
  const parsed = parseAssetRef(ref);
  return parsed.type !== "lesson" && parsed.type !== "memory";
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

export async function akmImprove(options: AkmImproveOptions = {}): Promise<AkmImproveResult> {
  const scope = resolveImproveScope(options.scope);
  const { plannedRefs, memorySummary } = await collectEligibleRefs(scope, options.stashDir);
  const reflectFn = options.reflectFn ?? akmReflect;
  const distillFn = options.distillFn ?? akmDistill;
  const ensureIndexFn = options.ensureIndexFn ?? ensureIndex;
  const reindexFn = options.reindexFn ?? akmIndex;
  let primaryStashDir: string | undefined;
  try {
    primaryStashDir = resolveSourceEntries(options.stashDir)[0]?.path;
  } catch {
    primaryStashDir = undefined;
  }
  const cleanupParentRef = memoryCleanupParentRef(scope, options.stashDir);
  const memoryCleanupPlan = shouldAnalyzeMemoryCleanup(scope, memorySummary.eligible, primaryStashDir)
    ? analyzeMemoryCleanup(primaryStashDir as string, cleanupParentRef ? { parentRef: cleanupParentRef } : undefined)
    : undefined;
  const guidance =
    memorySummary.eligible > 0
      ? "Improve folds memory cleanup into the same proposal queue: speculative promotions still go through reflect/distill proposals, while high-confidence redundant derived memories are moved into a recoverable cleanup archive instead of being left active in the stash."
      : undefined;

  if (options.dryRun) {
    return {
      schemaVersion: 1,
      ok: true,
      scope,
      dryRun: true,
      ...(guidance ? { guidance } : {}),
      memorySummary,
      ...(memoryCleanupPlan ? { memoryCleanup: shapeMemoryCleanup(memoryCleanupPlan) } : {}),
      plannedRefs,
    };
  }

  const resolvedLockPath = primaryStashDir
    ? path.join(primaryStashDir, ".akm", "improve.lock")
    : path.join(options.stashDir ?? ".", ".akm", "improve.lock");
  let staleLock = false;
  if (fs.existsSync(resolvedLockPath)) {
    let lock: { pid: number; startedAt: string } | null = null;
    try {
      lock = JSON.parse(fs.readFileSync(resolvedLockPath, "utf8")) as { pid: number; startedAt: string };
    } catch {
      staleLock = true;
    }
    if (lock !== null) {
      try {
        process.kill(lock.pid, 0);
        throw new ConfigError(
          `akm improve is already running (pid ${lock.pid}, started ${lock.startedAt}). Use SIGTERM to stop it.`,
          "INVALID_CONFIG_FILE",
        );
      } catch (err) {
        if (err instanceof ConfigError) throw err;
        staleLock = true;
      }
    }
    if (staleLock) {
      try {
        fs.unlinkSync(resolvedLockPath);
      } catch {
        // ignore
      }
    }
  }
  fs.mkdirSync(path.dirname(resolvedLockPath), { recursive: true });
  fs.writeFileSync(resolvedLockPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));

  const budgetMs = options.timeoutMs ?? 2 * 60 * 60 * 1000; // default 2 hours
  const startMs = Date.now();

  try {
    const actions: ImproveActionResult[] = [];
    const cleanupWarnings: string[] = [];

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

    appendEvent({
      eventType: "improve_invoked",
      ref: scope.mode === "ref" ? scope.value : `improve:${scope.mode}:${scope.value ?? "all"}`,
      metadata: { scope, dryRun: options.dryRun ?? false, assetCount: plannedRefs.length },
    });

    if (primaryStashDir) {
      try {
        await ensureIndexFn(primaryStashDir);
      } catch (err) {
        cleanupWarnings.push(`ensureIndex failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    let appliedCleanup: Awaited<ReturnType<typeof applyMemoryCleanup>> | undefined;
    try {
      appliedCleanup =
        primaryStashDir && memoryCleanupPlan ? applyMemoryCleanup(primaryStashDir, memoryCleanupPlan) : undefined;
    } catch (err) {
      cleanupWarnings.push(`applyMemoryCleanup failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    const archivedRefs = appliedCleanup?.archived.map((record) => record.ref) ?? [];
    const postCleanupRefs = filterRemovedPlannedRefs(plannedRefs, archivedRefs);

    // Gap 6: only surface feedback signals from the last 30 days so that
    // ancient one-off feedback events don't permanently lock an asset into
    // every improve run. Assets with only stale signals fall through to the
    // high-retrieval path (P0-A) or are skipped until new signals arrive.
    const FEEDBACK_SIGNAL_WINDOW_DAYS = 30;
    const feedbackSinceCutoff = new Date(Date.now() - FEEDBACK_SIGNAL_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();

    const signalFiltered = postCleanupRefs.filter((candidate) => {
      const { events } = readEvents({ type: "feedback", ref: candidate.ref });
      return events.some(
        (e) =>
          (e.ts ?? "") >= feedbackSinceCutoff &&
          ((e.metadata !== undefined && typeof e.metadata.signal === "string") ||
            (e.metadata !== undefined && typeof e.metadata.note === "string")),
      );
    });

    // P0-A: also surface zero-feedback assets that have been retrieved many times.
    const RETRIEVAL_COUNT_THRESHOLD = options.minRetrievalCount ?? 5;

    const signalBearingSet = new Set(signalFiltered.map((r) => r.ref));
    const noFeedbackCandidates = postCleanupRefs.filter((r) => !signalBearingSet.has(r.ref));

    let highRetrievalRefs: typeof postCleanupRefs = [];
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
      highRetrievalRefs = noFeedbackCandidates.filter(
        (r) => (retrievalCounts.get(r.ref) ?? 0) >= RETRIEVAL_COUNT_THRESHOLD,
      );
    } catch {
      // best-effort: if DB unavailable, highRetrievalRefs stays empty
    } finally {
      if (dbForRetrieval) closeDatabase(dbForRetrieval);
    }

    // If the user explicitly scoped to a single ref, always act on it —
    // skip the signal/retrieval filter entirely. The filter exists to avoid
    // noisy "improve everything" runs; it should not gate an intentional
    // per-ref invocation where the user's explicit choice is the signal.
    //
    // For type/all scope with no signals yet (fresh environment), fall back
    // to all postCleanupRefs so that the first improve run is not a no-op.
    const signalAndRetrievalRefs = [...signalFiltered, ...highRetrievalRefs];
    const mergedRefs =
      scope.mode === "ref"
        ? postCleanupRefs
        : options.requireFeedbackSignal
          ? signalFiltered
          : signalAndRetrievalRefs.length === 0
            ? postCleanupRefs
            : signalAndRetrievalRefs;

    const utilityMap = buildUtilityMap(mergedRefs);

    // Load feedback ratio per ref and blend into sort key
    const feedbackRatios = new Map<string, number>();
    for (const ref of mergedRefs) {
      const { events } = readEvents({ type: "feedback", ref: ref.ref });
      const positive = events.filter((e) => e.metadata?.signal === "positive").length;
      const negative = events.filter((e) => e.metadata?.signal === "negative").length;
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
    const feedbackRatioUsed = true;

    // Phase 0: surface coverage gaps from zero-result search queries
    let coverageGaps: string[] = [];
    try {
      const dbForGaps = openExistingDatabase();
      try {
        coverageGaps = getZeroResultSearches(dbForGaps);
      } finally {
        closeDatabase(dbForGaps);
      }
    } catch {
      // best-effort
    }

    const actionableRefs = options.limit ? sorted.slice(0, options.limit) : sorted;

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
    for (const candidate of actionableRefs) {
      try {
        const filePath = await findAssetFilePath(candidate.ref, options.stashDir);
        if (!filePath) {
          validationFailures.push({ ref: candidate.ref, reason: "file not found on disk" });
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
      info(`[improve] ${validationFailures.length} assets have validation issues (will be skipped):`);
      for (const f of validationFailures) info(`  ${f.ref}: ${f.reason}`);
    }
    // Schema repair pass: attempt to fix validation failures via LLM before skipping.
    let schemaRepairs: Array<{
      ref: string;
      reason: string;
      outcome: "written" | "skipped" | "error";
      error?: string;
    }> = [];
    let repairedRefs = new Set<string>();

    if (validationFailures.length > 0 && options.repairValidationFailures !== false) {
      const baseConfigForRepair = options.config ?? loadConfig();
      const llmCfg = baseConfigForRepair.llm;
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

    const recentErrors: string[] = []; // rolling window, last 3 failures
    const RECENT_ERRORS_CAP = 3;
    let crossStepErrorsInjected = 0;

    // Seed the rolling window from any schema repair errors that occurred before the main loop.
    for (const repair of schemaRepairs) {
      if (repair.outcome === "error") {
        const errMsg = repair.error ?? `schema repair error: ${repair.reason}`;
        recentErrors.push(errMsg);
        if (recentErrors.length > RECENT_ERRORS_CAP) recentErrors.shift();
      }
    }

    // ── Cooldown pre-filter ───────────────────────────────────────────────────
    // Read all cooldown-relevant events in 4 bulk queries and materialise two
    // Sets that the loop checks with O(1) Set.has() instead of N per-ref
    // readEvents() + listProposals() calls. This eliminates the N×3 DB/FS
    // round trips that caused per-asset "reflect cooldown" noise for every
    // asset in the stash.
    //
    // SM-2 tier for reflect uses promoted/rejected events (recorded by
    // `akm proposal accept/reject`) rather than the per-ref listProposals()
    // filesystem scan, giving identical tier logic without touching the disk.
    const REFLECT_COOLDOWN_DAYS = options.reflectCooldownDays ?? 7;
    const DISTILL_COOLDOWN_DAYS = options.distillCooldownDays ?? 30;

    const reflectCooledRefs = new Set<string>();
    const distillCooledRefs = new Set<string>();

    if (REFLECT_COOLDOWN_DAYS > 0 || DISTILL_COOLDOWN_DAYS > 0) {
      const bulkWindowMs = Math.max(REFLECT_COOLDOWN_DAYS, DISTILL_COOLDOWN_DAYS, 14) * 24 * 60 * 60 * 1000;
      const bulkSince = new Date(Date.now() - bulkWindowMs).toISOString();

      const bulkReflects = readEvents({ type: "reflect_invoked", since: bulkSince }).events;
      const bulkDistills = readEvents({ type: "distill_invoked", since: bulkSince }).events;
      const bulkPromoted = readEvents({ type: "promoted", since: bulkSince }).events;
      const bulkRejected = readEvents({ type: "rejected", since: bulkSince }).events;

      // Latest promoted/rejected ts per ref (for SM-2 tier computation).
      const promotedTs = new Map<string, string>();
      for (const e of bulkPromoted) {
        if (e.ref && (e.ts ?? "") > (promotedTs.get(e.ref) ?? "")) promotedTs.set(e.ref, e.ts ?? "");
      }
      const rejectedTs = new Map<string, string>();
      for (const e of bulkRejected) {
        if (e.ref && (e.ts ?? "") > (rejectedTs.get(e.ref) ?? "")) rejectedTs.set(e.ref, e.ts ?? "");
      }

      if (REFLECT_COOLDOWN_DAYS > 0) {
        // Group reflect events by ref, find most recent per ref.
        const latestReflect = new Map<string, string>(); // ref → ts
        for (const e of bulkReflects) {
          if (e.ref && (e.ts ?? "") > (latestReflect.get(e.ref) ?? "")) latestReflect.set(e.ref, e.ts ?? "");
        }
        for (const [ref, lastTs] of latestReflect) {
          if (!lastTs) continue;
          // SM-2 tier: promoted/rejected event that occurred AFTER the last reflect run.
          const hasAccepted = (promotedTs.get(ref) ?? "") > lastTs;
          const hasRejected = (rejectedTs.get(ref) ?? "") > lastTs;
          let effectiveCooldownDays = REFLECT_COOLDOWN_DAYS;
          if (hasAccepted) continue;
          else if (hasRejected) effectiveCooldownDays = Math.min(REFLECT_COOLDOWN_DAYS, 3);
          if (Date.now() - new Date(lastTs).getTime() < effectiveCooldownDays * 24 * 60 * 60 * 1000) {
            reflectCooledRefs.add(ref);
          }
        }
      }

      if (DISTILL_COOLDOWN_DAYS > 0) {
        const distillCooldownMs = DISTILL_COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
        const latestQueuedDistill = new Map<string, string>(); // ref → ts
        for (const e of bulkDistills) {
          if (e.ref && e.metadata?.outcome === "queued" && (e.ts ?? "") > (latestQueuedDistill.get(e.ref) ?? "")) {
            latestQueuedDistill.set(e.ref, e.ts ?? "");
          }
        }
        for (const [ref, lastTs] of latestQueuedDistill) {
          if (lastTs && Date.now() - new Date(lastTs).getTime() < distillCooldownMs) {
            distillCooledRefs.add(ref);
          }
        }
      }
    }

    // Separate reflect-cooled assets from the active loop — emit a single
    // summary line instead of one info() per skipped asset.
    // Also exclude validation failures upfront so the loop counter reflects
    // only assets that will actually be processed.
    const loopRefs = actionableRefs.filter((r) => !reflectCooledRefs.has(r.ref) && !validationFailureRefs.has(r.ref));
    const reflectCooledLoop = actionableRefs.filter((r) => reflectCooledRefs.has(r.ref));
    if (reflectCooledLoop.length > 0) {
      info(`[improve] ${reflectCooledLoop.length}/${actionableRefs.length} assets on reflect cooldown — skipping`);
      for (const r of reflectCooledLoop) {
        actions.push({
          ref: r.ref,
          mode: "distill-skipped",
          result: { ok: true, reason: "reflect cooldown (pre-filtered)" },
        });
        appendEvent({ eventType: "improve_skipped", ref: r.ref, metadata: { reason: "reflect_cooldown" } });
      }
    }
    if (validationFailureRefs.size > 0) {
      info(`[improve] ${validationFailureRefs.size} assets with validation failures excluded from loop`);
    }

    let completedCount = 0;
    for (const planned of loopRefs) {
      if (Date.now() - startMs >= budgetMs) {
        const remaining = loopRefs.length - completedCount;
        info(
          `[improve] budget exhausted after ${Math.round((Date.now() - startMs) / 60000)}min — ${remaining} assets skipped`,
        );
        appendEvent({
          eventType: "improve_skipped",
          ref: planned.ref,
          metadata: {
            reason: "budget_exhausted",
            remaining,
          },
        });
        actions.push({
          ref: planned.ref,
          mode: "error",
          result: { ok: false, error: "timeout: improve wall-clock budget exhausted" },
        });
        break;
      }
      try {
        // Distill cooldown pre-check: skip both reflect AND distill for assets
        // that would go through the distill path but are already on cooldown.
        // Moving this before reflectFn avoids an unnecessary LLM call.
        if (
          DISTILL_COOLDOWN_DAYS > 0 &&
          distillCooledRefs.has(planned.ref) &&
          (isLessonCandidate(planned.ref) || shouldDistillMemoryRef(planned.ref, options.stashDir))
        ) {
          actions.push({
            ref: planned.ref,
            mode: "distill-skipped",
            result: { ok: true, reason: "distill cooldown" },
          });
          completedCount++;
          appendEvent({
            eventType: "improve_skipped",
            ref: planned.ref,
            metadata: { reason: "distill_cooldown", cooldownDays: DISTILL_COOLDOWN_DAYS },
          });
          info(`[improve] ${completedCount}/${loopRefs.length} ${planned.ref} (distill cooldown)`);
          continue;
        }

        if (recentErrors.length > 0) crossStepErrorsInjected++;
        const reflectResult = await reflectFn({
          ref: planned.ref,
          task: options.task,
          ...(options.stashDir ? { stashDir: options.stashDir } : {}),
          ...(recentErrors.length > 0 ? { avoidPatterns: [...recentErrors] } : {}),
          agentProcess: options.agentProcess ?? "reflect",
        });
        actions.push({ ref: planned.ref, mode: "reflect", result: reflectResult });
        if (!reflectResult.ok) {
          const errMsg = reflectResult.error ?? reflectResult.reason ?? "unknown reflect error";
          recentErrors.push(errMsg);
          if (recentErrors.length > RECENT_ERRORS_CAP) recentErrors.shift();
        }
        const parsedPlannedRef = parseAssetRef(planned.ref);
        const hasRecentFeedbackSignal = signalBearingSet.has(planned.ref);
        const explicitRefScope = scope.mode === "ref";
        const shouldAttemptDistill =
          isLessonCandidate(planned.ref) || shouldDistillMemoryRef(planned.ref, options.stashDir);
        const skipMemoryDistillForWeakSignal =
          parsedPlannedRef.type === "memory" && !hasRecentFeedbackSignal && !explicitRefScope;

        if (shouldAttemptDistill && !skipMemoryDistillForWeakSignal) {
          const lessonRef = deriveLessonRef(planned.ref);
          const dedupeStashDir = primaryStashDir ?? options.stashDir;
          if (dedupeStashDir) {
            const existingProposals = listProposals(dedupeStashDir, { ref: lessonRef });
            if (existingProposals.some((p) => p.status === "pending")) {
              actions.push({
                ref: planned.ref,
                mode: "distill-skipped",
                result: { ok: true, reason: "pending proposal exists" },
              });
              completedCount++;
              info(`[improve] ${completedCount}/${loopRefs.length} ${planned.ref}`);
              continue;
            }
          }

          const distillResult = await distillFn({
            ref: planned.ref,
            ...(parsedPlannedRef.type === "memory" ? { proposalKind: "auto" as const } : {}),
            ...(options.stashDir ? { stashDir: options.stashDir } : {}),
          });
          actions.push({ ref: planned.ref, mode: "distill", result: distillResult });
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
          // Check for rejected proposals in the last 30 days
          const rejectedProposals = readEvents({ type: "proposal_rejected", ref: planned.ref }).events.filter(
            (e) => new Date(e.ts).getTime() >= Date.now() - 30 * 24 * 60 * 60 * 1000,
          );
          if (rejectedProposals.length > 0 && primaryStashDir) {
            const slug = planned.ref
              .replace(/[^a-z0-9]/gi, "-")
              .toLowerCase()
              .slice(0, 60);
            writeEvalCase(primaryStashDir, {
              ref: planned.ref,
              failureReason: (rejectedProposals[0].metadata?.reason as string | undefined) ?? "proposal rejected",
              assetType: parseAssetRef(planned.ref).type ?? "unknown",
              rejectedAt: new Date(rejectedProposals[0].ts).getTime(),
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
          appendEvent({
            eventType: "improve_skipped",
            ref: planned.ref,
            metadata: { reason: "memory_distill_requires_feedback" },
          });
        }
      } catch (err) {
        actions.push({
          ref: planned.ref,
          mode: "error",
          result: { ok: false, error: err instanceof Error ? err.message : String(err) },
        });
      }
      completedCount++;
      info(`[improve] ${completedCount}/${loopRefs.length} ${planned.ref}`);
    }

    const allWarnings = [...cleanupWarnings, ...(appliedCleanup?.warnings ?? [])];

    const baseConfig = options.config ?? loadConfig();
    const MEMORY_VOLUME_THRESHOLD = options.memoryVolumeConsolidationThreshold ?? 100;
    const hasLlm = !!(baseConfig.llm || baseConfig.agent);
    const volumeTriggered =
      typeof memorySummary?.eligible === "number" && memorySummary.eligible > MEMORY_VOLUME_THRESHOLD && hasLlm;
    const consolidationConfig: AkmConfig = volumeTriggered
      ? {
          ...baseConfig,
          ...(baseConfig.llm
            ? {
                llm: {
                  ...baseConfig.llm,
                  features: { ...baseConfig.llm.features, memory_consolidation: true },
                },
              }
            : {}),
        }
      : baseConfig;

    // Gap 4: skip consolidation if it ran recently (14-day cooldown) to prevent
    // the same memory cluster being churned through consolidation on every run.
    const consolidateCooldownDays = options.consolidateCooldownDays ?? 14;
    const CONSOLIDATE_COOLDOWN_MS = consolidateCooldownDays * 24 * 60 * 60 * 1000;
    const recentConsolidations = readEvents({ type: "consolidate_completed" });
    const lastConsolidation = recentConsolidations.events
      .filter((e) => e.metadata?.processed && Number(e.metadata.processed) > 0)
      .sort((a, b) => new Date(b.ts ?? 0).getTime() - new Date(a.ts ?? 0).getTime())[0];
    const consolidationOnCooldown =
      !volumeTriggered &&
      consolidateCooldownDays > 0 &&
      lastConsolidation?.ts &&
      Date.now() - new Date(lastConsolidation.ts).getTime() < CONSOLIDATE_COOLDOWN_MS;

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
      warnings: [],
      durationMs: 0,
    };
    if (!consolidationOnCooldown) {
      consolidation = await akmConsolidate({
        ...options.consolidateOptions,
        config: consolidationConfig,
        stashDir: options.stashDir,
        autoTriggered: volumeTriggered,
        // Consolidation is a sub-step of improve — the user already opted in by
        // running improve. Always skip the interactive confirmation here; it only
        // belongs in the standalone `akm consolidate` CLI path.
        autoAccept: "safe",
      });
      if (consolidation.processed > 0) {
        appendEvent({
          eventType: "consolidate_completed",
          ref: "memory:_consolidation",
          metadata: { processed: consolidation.processed, merged: consolidation.merged },
        });
      }
    } else {
      const daysAgo = Math.round((Date.now() - new Date(lastConsolidation?.ts ?? 0).getTime()) / 86400000);
      appendEvent({
        eventType: "improve_skipped",
        ref: "memory:_consolidation",
        metadata: {
          reason: "consolidation_cooldown",
          cooldownDays: 14,
          lastEventTs: lastConsolidation?.ts ?? null,
        },
      });
      info(`[improve] consolidation skipped (last ran ${daysAgo}d ago, cooldown 14d)`);
    }

    // Item 8: URL dead-link detection — weekly (mode=all) runs only, best-effort, no LLM needed.
    // Note: ImproveEligibleRef does not have a body field, so we can only pass empty bodies here.
    // A follow-up improvement would read the file contents for each ref before calling checkDeadUrls.
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
          deadUrls = await checkDeadUrls(primaryStashDir, knowledgeEntries);
        }
      } catch {
        // best-effort
      }
    }

    return {
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
              ...(appliedCleanup
                ? {
                    archived: appliedCleanup.archived,
                    ...(appliedCleanup.transitionLogPath
                      ? { transitionLogPath: appliedCleanup.transitionLogPath }
                      : {}),
                    ...(appliedCleanup.transitionLogEntries !== undefined
                      ? { transitionLogEntries: appliedCleanup.transitionLogEntries }
                      : {}),
                    ...(allWarnings.length > 0 ? { warnings: allWarnings } : {}),
                  }
                : cleanupWarnings.length > 0
                  ? { warnings: cleanupWarnings }
                  : {}),
            },
          }
        : {}),
      plannedRefs: actionableRefs,
      actions,
      ...(validationFailures.length > 0 ? { validationFailures } : {}),
      ...(schemaRepairs.length > 0 ? { schemaRepairs } : {}),
      ...(consolidation.processed > 0 || consolidation.warnings.length > 0 ? { consolidation } : {}),
      ...(lintSummary !== undefined ? { lintSummary } : {}),
      ...(memoryIndexHealth !== undefined ? { memoryIndexHealth } : {}),
      feedbackRatioUsed,
      ...(coverageGaps.length > 0 ? { coverageGaps } : {}),
      ...(executionLogCandidates.length > 0 ? { executionLogCandidates } : {}),
      ...(primaryStashDir !== undefined ? { evalCasesWritten: countEvalCases(primaryStashDir) } : {}),
      ...(deadUrls !== undefined && deadUrls.length > 0 ? { deadUrls } : {}),
      ...(crossStepErrorsInjected > 0 ? { crossStepErrorsInjected } : {}),
    };
  } finally {
    try {
      fs.unlinkSync(resolvedLockPath);
    } catch {
      // ignore
    }
  }
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
      const scores = getUtilityScoresByIds(db, ids);
      for (const [id, score] of scores) {
        const ref = idToRef.get(id);
        if (ref) map.set(ref, score.utility);
      }
    }
  } catch {
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
