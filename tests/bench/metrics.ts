/**
 * akm-bench metrics (spec §6).
 *
 * Outcome metrics (§6.1) and trajectory metrics (§6.2). Both are pure
 * functions over `RunResult[]` slices so the runner can compose them
 * however it likes. The §6.3+ catalog (proposal-quality, longitudinal,
 * attribution, failure-mode taxonomy) lands in #239/#240/#243.
 *
 * The failure-mode taxonomy classifier (§6.6) lives in this file
 * (`classifyFailureMode`).
 *
 * Search-pipeline bridge metrics (§6.7) are below: they tie the synthetic
 * MRR/Recall@K view in `tests/benchmark-suite.ts` to real-task pass rate
 * by logging gold-rank-of-search per `akm search` invocation and slicing
 * pass-rate by the rank of the agent's *chosen* search.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { MEMORY_ABILITY_VALUES, type MemoryAbility, type TaskMetadata } from "./corpus";
import type { RunResult } from "./driver";
import type { RunRecordSerialized, UtilityRunReport } from "./report";
import { serializeRunForReport } from "./report";
import { normalizeRunToTrace, type WorkflowTraceEvent, type WorkflowTraceEventType } from "./workflow-trace";

// ── Outcome (§6.1) ─────────────────────────────────────────────────────────

export interface OutcomeAggregate {
  /** Fraction of runs whose outcome is `pass`. Zero when results is empty. */
  passRate: number;
  /**
   * Mean total tokens across runs that passed AND have a parsed token
   * measurement; `0` when no such runs exist (avoids `Infinity` and `NaN`
   * polluting downstream JSON). Runs with `tokenMeasurement !== "parsed"`
   * are deliberately skipped so a `0` here means "no parsed passes" rather
   * than "free run" (issue #252).
   */
  tokensPerPass: number;
  /** Mean wallclock ms across all runs (not just passes). */
  wallclockMs: number;
  /** Number of runs whose outcome is `budget_exceeded`. */
  budgetExceeded: number;
  /**
   * Total runs (any outcome) with `tokenMeasurement === "parsed"`. Reports
   * use this to surface token-measurement coverage; aggregations with low
   * coverage cannot be trusted for token economics (issue #252).
   */
  runsWithMeasuredTokens: number;
}

/**
 * Aggregate outcome metrics over a flat list of RunResults.
 *
 * Aggregations across multiple arms are the caller's responsibility — pass
 * each arm's slice in separately. Backward-compatible v1 contract; the
 * richer per-task / corpus shapes below subsume this.
 */
export function computeOutcomeAggregate(results: RunResult[]): OutcomeAggregate {
  if (results.length === 0) {
    return { passRate: 0, tokensPerPass: 0, wallclockMs: 0, budgetExceeded: 0, runsWithMeasuredTokens: 0 };
  }
  let passes = 0;
  let budgetExceeded = 0;
  let totalTokensInMeasuredPasses = 0;
  let measuredPasses = 0;
  let runsWithMeasuredTokens = 0;
  let totalWallclock = 0;
  for (const r of results) {
    totalWallclock += r.wallclockMs;
    if (isMeasured(r)) {
      runsWithMeasuredTokens += 1;
    }
    if (r.outcome === "pass") {
      passes += 1;
      // Only fold tokens into the mean when we actually measured them
      // (issue #252) — otherwise a `0` would silently understate cost.
      if (isMeasured(r)) {
        measuredPasses += 1;
        totalTokensInMeasuredPasses += r.tokens.input + r.tokens.output;
      }
    } else if (r.outcome === "budget_exceeded") {
      budgetExceeded += 1;
    }
  }
  return {
    passRate: passes / results.length,
    tokensPerPass: measuredPasses === 0 ? 0 : totalTokensInMeasuredPasses / measuredPasses,
    wallclockMs: totalWallclock / results.length,
    budgetExceeded,
    runsWithMeasuredTokens,
  };
}

/**
 * Treat older artefacts without `tokenMeasurement` as `"parsed"` for backward
 * compatibility — pre-#252 reports always returned numeric zero, and rejecting
 * them entirely would break compare/attribute over historical runs.
 */
function isMeasured(r: RunResult): boolean {
  return (r.tokenMeasurement ?? "parsed") === "parsed";
}

// ── Per-task aggregation (§6.1, K seeds per arm) ───────────────────────────

/**
 * Per-(task, arm) aggregate produced by collapsing K seed runs.
 *
 * `tokensPerPass` is `null` when no run in the bag passed (NaN-safety —
 * downstream report renderers turn `null` into a sentinel rather than
 * `Infinity` polluting the JSON envelope).
 */
export interface PerTaskMetrics {
  /** Fraction of K runs that passed. */
  passRate: number;
  /** Pass-or-fail of seed 0 (or first run when seed 0 is absent). */
  passAt1: 0 | 1;
  /**
   * Mean total tokens in passing runs that also carry a parsed token
   * measurement. `null` when 0 passes OR when every passing run has missing /
   * unsupported token measurement (issue #252) — downstream renderers must
   * treat `null` as "not enough measurement to know" rather than zero cost.
   */
  tokensPerPass: number | null;
  /** Mean wallclock ms across all K runs. */
  wallclockMs: number;
  /** Sample standard deviation of pass (1) / fail (0) across the K seeds. */
  passRateStdev: number;
  /** Count of `budget_exceeded` outcomes across the K seeds. */
  budgetExceededCount: number;
  /** Count of `harness_error` outcomes across the K seeds. */
  harnessErrorCount: number;
  /** Number of runs aggregated. Useful when K varies (last seed dropped, etc.). */
  count: number;
  /**
   * Count of runs (any outcome) with `tokenMeasurement === "parsed"` (issue
   * #252). Reports use this to surface token-measurement coverage so
   * operators can tell when token economics are unreliable.
   */
  runsWithMeasuredTokens: number;
}

/**
 * Aggregate K seed runs of one (task, arm) pair into PerTaskMetrics. Returns
 * a zeroed envelope on empty input — callers decide whether to skip or render.
 */
export function aggregatePerTask(results: RunResult[]): PerTaskMetrics {
  if (results.length === 0) {
    return {
      passRate: 0,
      passAt1: 0,
      tokensPerPass: null,
      wallclockMs: 0,
      passRateStdev: 0,
      budgetExceededCount: 0,
      harnessErrorCount: 0,
      count: 0,
      runsWithMeasuredTokens: 0,
    };
  }

  let passes = 0;
  let measuredPasses = 0;
  let totalTokensInMeasuredPasses = 0;
  let totalWallclock = 0;
  let budgetExceeded = 0;
  let harnessError = 0;
  let runsWithMeasuredTokens = 0;
  // For the standard deviation we need a fixed-iteration buffer of pass/fail.
  const passSamples: number[] = [];
  for (const r of results) {
    totalWallclock += r.wallclockMs;
    if (isMeasured(r)) {
      runsWithMeasuredTokens += 1;
    }
    const isPass = r.outcome === "pass" ? 1 : 0;
    passSamples.push(isPass);
    if (isPass === 1) {
      passes += 1;
      // Only count tokens for measured passes (issue #252). A pass with
      // missing measurement contributes to `passRate` but NOT to
      // `tokensPerPass` — preserving "tokens per measured pass" semantics.
      if (isMeasured(r)) {
        measuredPasses += 1;
        totalTokensInMeasuredPasses += r.tokens.input + r.tokens.output;
      }
    } else if (r.outcome === "budget_exceeded") {
      budgetExceeded += 1;
    } else if (r.outcome === "harness_error") {
      harnessError += 1;
    }
  }

  const seed0 = results.find((r) => r.seed === 0) ?? results[0];
  const passAt1: 0 | 1 = seed0 && seed0.outcome === "pass" ? 1 : 0;

  return {
    passRate: passes / results.length,
    passAt1,
    tokensPerPass: measuredPasses === 0 ? null : totalTokensInMeasuredPasses / measuredPasses,
    wallclockMs: totalWallclock / results.length,
    passRateStdev: stdev(passSamples),
    budgetExceededCount: budgetExceeded,
    harnessErrorCount: harnessError,
    count: results.length,
    runsWithMeasuredTokens,
  };
}

/** Sample standard deviation. Returns 0 for length ≤ 1 (no spread to measure). */
function stdev(values: number[]): number {
  if (values.length <= 1) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const sumSq = values.reduce((acc, v) => acc + (v - mean) * (v - mean), 0);
  // Sample stdev (Bessel's correction) — n-1 denominator.
  return Math.sqrt(sumSq / (values.length - 1));
}

// ── Corpus aggregation (§6.1 corpus-wide row) ──────────────────────────────

/** Corpus aggregate is a mean over per-task metrics, weighting each task equally. */
export interface CorpusMetrics {
  passRate: number;
  /** Mean over per-task tokensPerPass, treating `null` as missing. `null` if all missing. */
  tokensPerPass: number | null;
  wallclockMs: number;
}

/**
 * Mean across per-task metrics. Each task contributes once, regardless of
 * how many seeds it ran (K is already collapsed in `aggregatePerTask`).
 *
 * `tokensPerPass`: tasks where `tokensPerPass` is `null` (no passes) are
 * dropped from that mean. The result is `null` if every task failed.
 */
export function aggregateCorpus(perTask: Record<string, PerTaskMetrics>): CorpusMetrics {
  const tasks = Object.values(perTask);
  if (tasks.length === 0) {
    return { passRate: 0, tokensPerPass: null, wallclockMs: 0 };
  }
  const passRate = tasks.reduce((a, t) => a + t.passRate, 0) / tasks.length;
  const wallclockMs = tasks.reduce((a, t) => a + t.wallclockMs, 0) / tasks.length;
  const tppValues = tasks.map((t) => t.tokensPerPass).filter((v): v is number => v !== null);
  const tokensPerPass = tppValues.length === 0 ? null : tppValues.reduce((a, b) => a + b, 0) / tppValues.length;
  return { passRate, tokensPerPass, wallclockMs };
}

// ── Delta (§6.1 corpus row, akm vs noakm) ──────────────────────────────────

export interface CorpusDelta {
  passRate: number;
  /** akm − noakm. `null` if either side is `null`. */
  tokensPerPass: number | null;
  wallclockMs: number;
}

/**
 * Compute the akm − noakm delta. Negative `tokensPerPass`/`wallclockMs` mean
 * akm was cheaper / faster; positive means it cost more. Pass-rate uses the
 * opposite convention (positive = akm wins).
 */
export function computeCorpusDelta(noakm: CorpusMetrics, akm: CorpusMetrics): CorpusDelta {
  return {
    passRate: akm.passRate - noakm.passRate,
    tokensPerPass:
      akm.tokensPerPass === null || noakm.tokensPerPass === null ? null : akm.tokensPerPass - noakm.tokensPerPass,
    wallclockMs: akm.wallclockMs - noakm.wallclockMs,
  };
}

/** Per-task delta with the same null-safety as the corpus delta. */
export function computePerTaskDelta(noakm: PerTaskMetrics, akm: PerTaskMetrics): CorpusDelta {
  return {
    passRate: akm.passRate - noakm.passRate,
    tokensPerPass:
      akm.tokensPerPass === null || noakm.tokensPerPass === null ? null : akm.tokensPerPass - noakm.tokensPerPass,
    wallclockMs: akm.wallclockMs - noakm.wallclockMs,
  };
}

// ── Negative-transfer + domain diagnostics (#260) ──────────────────────────

/**
 * One regressed-task row: a task where AKM hurt pass rate relative to noakm.
 * `delta` is `akm - noakm` (negative for regressions); kept identical to the
 * sign convention used everywhere else in the bench. `severity` is the
 * positive magnitude (`noakm - akm`) — convenient for sums and sorting.
 */
export interface RegressedTaskRow {
  taskId: string;
  domain: string;
  noakmPassRate: number;
  akmPassRate: number;
  /** `akm - noakm`, negative for regressions. */
  delta: number;
  /** `noakm - akm`, positive for regressions. */
  severity: number;
}

/**
 * Negative-transfer aggregate (#260). Counts and severity sum across tasks
 * where `akm.passRate < noakm.passRate`. `topRegressedTasks` is sorted by
 * largest negative AKM delta first (most-severe regressions on top), with
 * `taskId` as the deterministic tiebreaker.
 */
export interface NegativeTransferAggregate {
  count: number;
  /** Sum of `noakm_pass_rate - akm_pass_rate` over regressed tasks. ≥ 0. */
  severity: number;
  topRegressedTasks: RegressedTaskRow[];
}

/**
 * Per-domain aggregate row (#260). One entry per domain present in the
 * corpus. Pass rate, tokens-per-pass, and wallclock are means across the
 * tasks in that domain (each task contributes once, K seeds already
 * collapsed into PerTaskMetrics). `tokensPerPassDelta` is `null` when
 * either arm has no measured passes.
 */
export interface DomainAggregateRow {
  domain: string;
  taskCount: number;
  /** Tasks within this domain where akm pass rate regressed. */
  regressionCount: number;
  passRateNoakm: number;
  passRateAkm: number;
  /** `akm - noakm`. Positive when AKM helped this domain. */
  passRateDelta: number;
  /** `akm - noakm`. `null` if either arm has no measured passes for this domain. */
  tokensPerPassDelta: number | null;
  /** `akm - noakm`, ms. */
  wallclockMsDelta: number;
}

/**
 * Asset-regression-candidate row (#260). An asset that was loaded by the
 * AKM agent during one or more regressed tasks. `regressedTaskCount` is the
 * number of distinct regressed task IDs that loaded this asset (de-duped
 * across seeds) — operators care about cross-task reach, not seed-level
 * load volume.
 */
export interface AssetRegressionCandidateRow {
  assetRef: string;
  regressedTaskCount: number;
  /** Distinct regressed task IDs that loaded this asset, sorted ascending. */
  regressedTaskIds: string[];
  /** Total seed-level load count across all regressed tasks (raw volume). */
  totalLoadCount: number;
}

/**
 * Extract the domain prefix from a task ID. The corpus convention is
 * `<domain>/<task-name>`; we split on the first `/`. Tasks lacking a slash
 * fall back to the literal `unknown` bucket so they aggregate predictably
 * rather than producing per-task domains-of-one.
 */
export function domainOfTaskId(taskId: string): string {
  const idx = taskId.indexOf("/");
  if (idx <= 0) return "unknown";
  return taskId.slice(0, idx);
}

/**
 * Compute the negative-transfer aggregate over a set of per-task entries
 * (one entry per task; both arms already aggregated into PerTaskMetrics).
 *
 * A task is "regressed" when `akm.passRate < noakm.passRate`. Ties (equal
 * pass rate, including 0=0) are NOT regressions. `topRegressedTasks` is
 * sorted by `severity` descending then `taskId` ascending so output is
 * deterministic.
 */
export function computeNegativeTransfer(
  tasks: ReadonlyArray<{ id: string; noakm: PerTaskMetrics; akm: PerTaskMetrics }>,
): NegativeTransferAggregate {
  const regressed: RegressedTaskRow[] = [];
  for (const t of tasks) {
    const delta = t.akm.passRate - t.noakm.passRate;
    if (delta >= 0) continue;
    regressed.push({
      taskId: t.id,
      domain: domainOfTaskId(t.id),
      noakmPassRate: t.noakm.passRate,
      akmPassRate: t.akm.passRate,
      delta,
      severity: -delta,
    });
  }
  regressed.sort((a, b) => {
    if (b.severity !== a.severity) return b.severity - a.severity;
    return a.taskId.localeCompare(b.taskId);
  });
  const severity = regressed.reduce((acc, r) => acc + r.severity, 0);
  return { count: regressed.length, severity, topRegressedTasks: regressed };
}

/**
 * Compute per-domain aggregates over a set of per-task entries. Each task
 * contributes once to its domain (K seeds already collapsed). Output rows
 * are sorted by `domain` ascending so JSON / markdown are byte-stable.
 *
 * Domain extraction uses `domainOfTaskId` (split on first `/`).
 */
export function computeDomainAggregates(
  tasks: ReadonlyArray<{ id: string; noakm: PerTaskMetrics; akm: PerTaskMetrics }>,
): DomainAggregateRow[] {
  const buckets = new Map<string, Array<{ id: string; noakm: PerTaskMetrics; akm: PerTaskMetrics }>>();
  for (const t of tasks) {
    const d = domainOfTaskId(t.id);
    let arr = buckets.get(d);
    if (!arr) {
      arr = [];
      buckets.set(d, arr);
    }
    arr.push(t);
  }
  const rows: DomainAggregateRow[] = [];
  for (const [domain, group] of buckets) {
    const n = group.length;
    let noakmSum = 0;
    let akmSum = 0;
    let wallNoakm = 0;
    let wallAkm = 0;
    let regressionCount = 0;
    const noakmTpp: number[] = [];
    const akmTpp: number[] = [];
    for (const t of group) {
      noakmSum += t.noakm.passRate;
      akmSum += t.akm.passRate;
      wallNoakm += t.noakm.wallclockMs;
      wallAkm += t.akm.wallclockMs;
      if (t.akm.passRate < t.noakm.passRate) regressionCount += 1;
      if (t.noakm.tokensPerPass !== null) noakmTpp.push(t.noakm.tokensPerPass);
      if (t.akm.tokensPerPass !== null) akmTpp.push(t.akm.tokensPerPass);
    }
    const passRateNoakm = noakmSum / n;
    const passRateAkm = akmSum / n;
    const meanNoakmTpp = noakmTpp.length === 0 ? null : noakmTpp.reduce((a, b) => a + b, 0) / noakmTpp.length;
    const meanAkmTpp = akmTpp.length === 0 ? null : akmTpp.reduce((a, b) => a + b, 0) / akmTpp.length;
    const tokensPerPassDelta = meanNoakmTpp === null || meanAkmTpp === null ? null : meanAkmTpp - meanNoakmTpp;
    rows.push({
      domain,
      taskCount: n,
      regressionCount,
      passRateNoakm,
      passRateAkm,
      passRateDelta: passRateAkm - passRateNoakm,
      tokensPerPassDelta,
      wallclockMsDelta: wallAkm / n - wallNoakm / n,
    });
  }
  rows.sort((a, b) => a.domain.localeCompare(b.domain));
  return rows;
}

/**
 * Compute asset-regression-candidate rows (#260). Walks the AKM-arm runs,
 * keeps only those whose `taskId` is in `regressedTaskIds`, and tallies how
 * often each loaded asset shows up. `regressedTaskCount` (distinct task IDs
 * touched) is the primary sort key — assets that hurt many tasks are more
 * actionable than assets that flooded one task across seeds.
 *
 * Sort: regressedTaskCount desc, totalLoadCount desc, assetRef asc.
 */
export function computeAssetRegressionCandidates(
  regressedTaskIds: ReadonlyArray<string>,
  akmRuns: ReadonlyArray<RunResult>,
): AssetRegressionCandidateRow[] {
  const regressed = new Set(regressedTaskIds);
  if (regressed.size === 0) return [];
  const taskIdsByAsset = new Map<string, Set<string>>();
  const totalLoadByAsset = new Map<string, number>();
  for (const run of akmRuns) {
    if (!regressed.has(run.taskId)) continue;
    const assets = run.assetsLoaded ?? [];
    for (const ref of assets) {
      let bucket = taskIdsByAsset.get(ref);
      if (!bucket) {
        bucket = new Set<string>();
        taskIdsByAsset.set(ref, bucket);
      }
      bucket.add(run.taskId);
      totalLoadByAsset.set(ref, (totalLoadByAsset.get(ref) ?? 0) + 1);
    }
  }
  const rows: AssetRegressionCandidateRow[] = [];
  for (const [assetRef, taskIds] of taskIdsByAsset) {
    rows.push({
      assetRef,
      regressedTaskCount: taskIds.size,
      regressedTaskIds: [...taskIds].sort(),
      totalLoadCount: totalLoadByAsset.get(assetRef) ?? 0,
    });
  }
  rows.sort((a, b) => {
    if (b.regressedTaskCount !== a.regressedTaskCount) return b.regressedTaskCount - a.regressedTaskCount;
    if (b.totalLoadCount !== a.totalLoadCount) return b.totalLoadCount - a.totalLoadCount;
    return a.assetRef.localeCompare(b.assetRef);
  });
  return rows;
}

// ── Trajectory (§6.2) ──────────────────────────────────────────────────────

export interface TrajectoryAggregate {
  /**
   * Fraction of runs (with a known goldRef) where the agent loaded the
   * correct asset. `null` when no run had a goldRef.
   */
  correctAssetLoaded: number | null;
  /** Fraction of runs that emitted a `feedback` event. `0..1`. */
  feedbackRecorded: number;
}

// ── Per-asset attribution (§6.5) ───────────────────────────────────────────

/**
 * Extract the unique asset refs an agent loaded during a run by scanning
 * `events[]` and `verifierStdout` for `akm show <ref>` invocations.
 *
 * Detection strategy (all heuristic, all conservative):
 *   1. `event.eventType === "show"` with `event.ref` (forward-compat — akm
 *      itself does not currently emit `show` events).
 *   2. Substring match on `akm show <ref>` in stdout. The ref shape is
 *      `[origin//]type:name` per the v1 contract; we accept word-boundary
 *      terminators after the name.
 *   3. Tool-call JSON `{"args":["show","<ref>"]}` — the form opencode logs
 *      when the agent invokes the akm CLI as a tool. We extract refs that
 *      look like asset refs from the args array entries adjacent to "show".
 *
 * Returns refs in first-seen order, deduplicated. Bounded scan: stdout is
 * truncated at 16 MiB (the same cap the trajectory parser uses) to keep
 * runaway agents from OOMing the bench.
 */
const ASSET_LOAD_STDOUT_SCAN_CAP = 16 * 1024 * 1024;
// Asset ref grammar: optional `origin//` prefix, type:name, where type and
// name are lowercase letters, digits, `_`, `-`. We deliberately do NOT match
// `://` schemes (those are install locators, not asset refs). The character
// class is intentionally tight so we don't mis-pickup arbitrary words after
// `akm show`. The `name` segment is restricted to `[A-Za-z0-9_-]+` (no `/`,
// no `.`) — the v1 grammar in src/core/asset-ref.ts permits `/` and `.` in
// names (e.g. `script:db/migrate/run.sh`), but the masker treats names as
// untrusted input and rejects any traversal-shaped value, so the bench-side
// scanner does not need (or want) to extract such refs from agent stdout.
// Limiting the regex here is defense-in-depth against a prompt-injected
// agent emitting `akm show "skill:../../etc"` and us pulling that ref into
// the masking flow.
const ASSET_REF_PATTERN = /(?:[a-z0-9_-]+\/\/)?[a-z][a-z0-9_-]*:[A-Za-z0-9_-]+/g;

export function extractAssetLoads(runResult: RunResult): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (ref: string): void => {
    if (!ref) return;
    if (seen.has(ref)) return;
    seen.add(ref);
    out.push(ref);
  };

  // 1. Events stream.
  for (const event of runResult.events) {
    if (event.eventType === "show" && typeof event.ref === "string") {
      push(event.ref);
    }
    const meta = event.metadata;
    if (meta && typeof meta === "object" && event.eventType === "show") {
      const candidate = (meta as Record<string, unknown>).ref;
      if (typeof candidate === "string") push(candidate);
    }
  }

  // 2 & 3. Stdout scanning. Bound the scan so a runaway agent stdout cannot
  // OOM the bench. Truncation is silent — the trajectory parser already
  // surfaces a warning for the same data on its own scan.
  let haystack = runResult.verifierStdout || "";
  if (haystack.length > ASSET_LOAD_STDOUT_SCAN_CAP) {
    haystack = haystack.slice(0, ASSET_LOAD_STDOUT_SCAN_CAP);
  }

  // `akm show <ref>` literal form. Accept optional quoting around the ref so
  // shell traces like `akm show "skill:foo"` work too.
  const literalRe = /akm\s+show\s+["']?((?:[a-z0-9_-]+\/\/)?[a-z][a-z0-9_-]*:[A-Za-z0-9_-]+)["']?/g;
  for (const literalMatch of haystack.matchAll(literalRe)) {
    push(literalMatch[1] as string);
  }

  // Tool-call JSON form. `"args":[..., "show", "<ref>", ...]`. We extract
  // every refish token in the haystack that follows a "show" arg in JSON-y
  // form. A second cheap pass keeps the pattern simple.
  const toolCallRe = /"show"\s*,\s*"((?:[a-z0-9_-]+\/\/)?[a-z][a-z0-9_-]*:[A-Za-z0-9_-]+)"/g;
  for (const toolCallMatch of haystack.matchAll(toolCallRe)) {
    push(toolCallMatch[1] as string);
  }

  return out;
}

// Suppress the unused warning for `ASSET_REF_PATTERN` above. The constant is
// retained as the documentation seam called out by the #251 review addenda,
// even though `extractAssetLoads` uses inline regexes for its two scan forms.
void ASSET_REF_PATTERN;

/**
 * Anchored variant of `ASSET_REF_PATTERN` for whole-string validation.
 *
 * Used by `materialiseMaskedStash` (#251) to gate every asset ref BEFORE we
 * touch the filesystem. The base `ASSET_REF_PATTERN` is `/g`-flagged for
 * scanning agent stdout; we re-anchor here so a hostile string like
 * `skill:foo/../../etc` is rejected as a whole even though the regex would
 * happily match a `skill:foo` substring under `/g`.
 *
 * Rejects `..`, absolute paths, drive letters, null bytes, `/`, `\`, and
 * anything else outside the v1 ref grammar (mirrors src/core/asset-ref.ts).
 */
const ASSET_REF_ANCHORED = /^(?:[a-z0-9_-]+\/\/)?[a-z][a-z0-9_-]*:[A-Za-z0-9_-]+$/;

/**
 * Reject hostile asset refs before they reach any `fs.rmSync` call. The ref
 * comes from agent stdout (untrusted; the agent could be prompt-injected) so
 * we apply the anchored grammar pattern first, then the per-segment shape
 * check after the colon-split. Defense in depth — each layer is sufficient
 * on its own; the layered structure makes a future grammar relax safe.
 */
function isSafeAssetRef(ref: string): boolean {
  if (!ref) return false;
  if (ref.includes("\0")) return false;
  return ASSET_REF_ANCHORED.test(ref);
}

/** Per-asset attribution row (§6.5). */
export interface PerAssetAttributionRow {
  /** Asset ref, e.g. `skill:docker-homelab`. */
  assetRef: string;
  /** Number of akm-arm runs that loaded this asset AND passed. */
  loadCountPassing: number;
  /** Number of akm-arm runs that loaded this asset AND failed (or budget/harness). */
  loadCountFailing: number;
  /** Total akm-arm runs that loaded this asset (passing + failing). */
  loadCount: number;
  /**
   * Among runs that loaded the asset, the fraction that passed. `null` when
   * load_count is zero (defensive — that asset would not appear in the table
   * at all in normal flow, but a future caller might construct one manually).
   */
  loadPassRate: number | null;
}

/** Per-asset attribution table (§6.5). */
export interface PerAssetAttribution {
  rows: PerAssetAttributionRow[];
  /** Total akm-arm runs aggregated. Sample size for the table as a whole. */
  totalAkmRuns: number;
}

/**
 * Aggregate per-asset load + pass counts across all akm-arm runs in a report.
 *
 * Sort order (stable, deterministic):
 *   1. loadCount descending (most-used first)
 *   2. loadPassRate descending (working assets above broken ones at the same load count)
 *   3. assetRef ascending (alphabetical tiebreak)
 *
 * Only `arm === "akm"` runs contribute. The `noakm` arm has no stash and
 * cannot load assets, so including it would zero-bias the rates.
 */
export function computePerAssetAttribution(report: UtilityRunReport): PerAssetAttribution {
  const passing = new Map<string, number>();
  const failing = new Map<string, number>();
  let totalAkmRuns = 0;

  // The §13.3 task entry doesn't carry RunResults — we read them from the
  // shared akm-arm runs collection that the runner stamps onto `report.akmRuns`.
  const akmRuns = collectAkmRuns(report);
  for (const r of akmRuns) {
    totalAkmRuns += 1;
    const isPass = r.outcome === "pass";
    for (const ref of r.assetsLoaded ?? []) {
      const bucket = isPass ? passing : failing;
      bucket.set(ref, (bucket.get(ref) ?? 0) + 1);
    }
  }

  const refs = new Set<string>([...passing.keys(), ...failing.keys()]);
  const rows: PerAssetAttributionRow[] = [];
  for (const ref of refs) {
    const p = passing.get(ref) ?? 0;
    const f = failing.get(ref) ?? 0;
    const total = p + f;
    rows.push({
      assetRef: ref,
      loadCountPassing: p,
      loadCountFailing: f,
      loadCount: total,
      loadPassRate: total === 0 ? null : p / total,
    });
  }

  rows.sort((a, b) => {
    if (b.loadCount !== a.loadCount) return b.loadCount - a.loadCount;
    const ar = a.loadPassRate ?? -1;
    const br = b.loadPassRate ?? -1;
    if (br !== ar) return br - ar;
    return a.assetRef.localeCompare(b.assetRef);
  });

  return { rows, totalAkmRuns };
}

/**
 * Pull the akm-arm RunResults out of a UtilityRunReport. The runner stamps
 * them into the optional `akmRuns` field on the report so attribution can
 * post-process them without re-running.
 */
function collectAkmRuns(report: UtilityRunReport): RunResult[] {
  if (Array.isArray(report.akmRuns)) return report.akmRuns;
  return [];
}

// ── runs[] serialisation (#249) ────────────────────────────────────────────

/**
 * Project a list of RunResults onto the compact `runs[]` rows persisted
 * inside the §13.3 JSON envelope (#249). One row per (task, arm, seed)
 * triple; the renderer walks the input order verbatim, which the runner
 * already builds deterministically (per-task block, noakm before akm,
 * seeds in ascending order).
 *
 * Aggregate metrics (per-task, trajectory, failure-mode, search-bridge,
 * attribution) MUST be recomputable from these rows + task metadata. This
 * helper is the canonical projection — keep it in lockstep with the field
 * list in the issue body.
 */
export function aggregateRunsForReport(runs: RunResult[]): RunRecordSerialized[] {
  return runs.map(serializeRunForReport);
}

/**
 * Hydrate a persisted `runs[]` row back into the `RunResult` shape that
 * downstream metrics helpers (`computePerAssetAttribution`, `aggregateCorpus`,
 * etc.) expect. Used by `bench attribute` / `bench compare` when they read a
 * §13.3 envelope from disk: the persisted row carries a compact subset, but
 * it carries everything those helpers need.
 *
 * Fields the row deliberately does NOT carry are filled with safe defaults:
 *   • `events: []` — events.jsonl is not persisted; downstream attribution
 *     only consults `assetsLoaded` and `verifierStdout`.
 *   • `verifierStdout: ""` — full stdout is intentionally omitted from the
 *     envelope (#249 acceptance criterion). `assetsLoaded` already carries
 *     the post-hoc extraction the agent run produced.
 *   • `schemaVersion: 1` — the report schema implies it.
 *
 * Tokens are passed through as-is so a future `measurement` field added by
 * #252 lands on the rehydrated row automatically. TODO(#252): keep this
 * spread.
 */
export function rehydrateRunFromSerialized(row: RunRecordSerialized): RunResult {
  // The compact row uses a permissive Record shape for tokens (see
  // RunRecordSerialized). Coerce defensively so older artefacts with only
  // {input, output} hydrate cleanly.
  const tok = row.tokens as { input?: number; output?: number } & Record<string, unknown>;
  return {
    schemaVersion: 1,
    taskId: row.task_id,
    arm: row.arm,
    seed: row.seed,
    model: row.model,
    outcome: row.outcome as RunResult["outcome"],
    tokens: {
      ...tok,
      input: typeof tok.input === "number" ? tok.input : 0,
      output: typeof tok.output === "number" ? tok.output : 0,
    } as RunResult["tokens"],
    wallclockMs: row.wallclock_ms,
    trajectory: {
      correctAssetLoaded: row.trajectory.correct_asset_loaded,
      feedbackRecorded: row.trajectory.feedback_recorded,
    },
    events: [],
    verifierStdout: "",
    verifierExitCode: row.verifier_exit_code,
    assetsLoaded: [...row.assets_loaded],
    failureMode: (row.failure_mode ?? null) as RunResult["failureMode"],
  };
}

// ── runMaskedCorpus (§6.5 leave-one-out) ──────────────────────────────────

/**
 * Marginal-contribution row for one masked asset.
 *
 * `marginalContribution = basePassRate − maskedPassRate`. Positive means the
 * asset *helped* — masking it hurt pass rate. Negative means the asset hurt
 * — masking it improved pass rate (a candidate for deletion / rewrite).
 */
export interface MaskedAttributionRow {
  assetRef: string;
  basePassRate: number;
  maskedPassRate: number;
  marginalContribution: number;
}

/** `runMaskedCorpus` result envelope. */
export interface MaskedCorpusResult {
  baseReport: UtilityRunReport;
  attributions: MaskedAttributionRow[];
  /**
   * Number of masked-corpus runs actually performed. Equals `min(topN,
   * unique-loaded-asset count)`. Operators reading the JSON envelope use this
   * to verify cost accounting.
   */
  runsPerformed: number;
  /**
   * Strategy used to construct each masked stash. Currently always
   * `"leave-one-out"`: every re-run masks exactly one asset ref from the
   * source fixture stash. Recorded in the JSON envelope so operators can
   * tell at a glance whether a future strategy (e.g. `"leave-pair-out"`)
   * was used.
   */
  maskingStrategy: "leave-one-out";
  /**
   * The exact asset refs masked, one per masked re-run. Order matches
   * `attributions[]`. Recorded in the JSON envelope so the operator can
   * audit which assets contributed to the marginal-contribution numbers.
   */
  maskedRefs: string[];
}

/** Caller-facing options for `runMaskedCorpus`. */
export interface RunMaskedCorpusOptions {
  /** Base report from a prior `bench utility` run. Required. */
  baseReport: UtilityRunReport;
  /** Top N most-loaded assets to mask. Defaults to 5; clamped to asset count. */
  topN?: number;
  /**
   * Re-runner. Tests inject a fake; production wires to `runUtility`. Receives
   * options identical to the original run but with each task's stash already
   * remapped to a tmp dir that has the named asset removed.
   */
  runUtility: (
    options: Omit<RunUtilityOptionsForMask, "spawn" | "materialiseStash"> & {
      tasks: TaskMetadata[];
      spawn?: RunUtilityOptionsForMask["spawn"];
      materialiseStash?: boolean;
    },
  ) => Promise<UtilityRunReport>;
  /**
   * The original `runUtility` call's options, passed through so the masked
   * runs use the same model / arms / seedsPerArm / budgets. The caller gives
   * us this; we reuse it modulo the per-task tasks override.
   */
  baseOptions: RunUtilityOptionsForMask;
  /**
   * Root directory for the source fixture stashes. Defaults to
   * `tests/fixtures/stashes/` relative to the repo. Tests inject a tmp dir.
   */
  fixturesRoot?: string;
}

/**
 * Subset of RunUtilityOptions we need for masked re-runs. We avoid importing
 * the runner module directly so metrics.ts has no cycle.
 */
export interface RunUtilityOptionsForMask {
  arms: Arm[];
  model: string;
  seedsPerArm?: number;
  budgetTokens?: number;
  budgetWallMs?: number;
  slice?: "all" | "train" | "eval";
  branch?: string;
  commit?: string;
  timestamp?: string;
  /**
   * Test-only injection seam for the child-process spawn function. The
   * masked re-runner forwards this verbatim to `runUtility`, which uses it
   * to launch the agent harness for each masked task. SECURITY: a non-test
   * caller MUST NOT set this — production code paths leave it `undefined`
   * so the runner falls back to the vetted default `SpawnFn`. The field is
   * typed `any` only to keep metrics.ts independent of `src/integrations/agent/spawn`.
   */
  // biome-ignore lint/suspicious/noExplicitAny: Test-injection seam (see JSDoc above). SpawnFn lives in src/integrations/agent/spawn; importing it would pull node-specific types into metrics.ts. Production callers leave this undefined.
  spawn?: any;
  materialiseStash?: boolean;
}

/** The two arm names. Duplicated here so metrics.ts has no runner.ts import. */
export type Arm = "noakm" | "akm";

/**
 * Pick the top-N most-loaded assets from a base report and re-run the corpus
 * with each one masked from its source stash. Returns a marginal-contribution
 * row per masked asset.
 *
 * Cost: N * (tasks × arms × seedsPerArm) re-runs. Operators clamp N before
 * calling — but we also clamp internally if `topN` exceeds the unique-asset
 * count to avoid surprising no-op runs.
 *
 * Source-fixture safety: every masked re-run materialises a fresh tmp copy
 * of the fixture stash, deletes the masked asset's files there, and points
 * the re-run at the tmp dir. The shipped fixture in `tests/fixtures/stashes/`
 * is NEVER mutated.
 */
export async function runMaskedCorpus(opts: RunMaskedCorpusOptions): Promise<MaskedCorpusResult> {
  const baseReport = opts.baseReport;
  const fixturesRoot = opts.fixturesRoot ?? path.resolve(__dirname, "..", "fixtures", "stashes");

  const attribution = computePerAssetAttribution(baseReport);
  const desired = Math.max(1, opts.topN ?? 5);
  const clamped = Math.min(desired, attribution.rows.length);

  const baseAkmPassRate = baseReport.aggregateAkm.passRate;
  const top = attribution.rows.slice(0, clamped);
  const attributions: MaskedAttributionRow[] = [];
  const maskedRefs: string[] = [];

  for (const row of top) {
    const maskedTasks: TaskMetadata[] = [];
    const tmpDirs: string[] = [];
    try {
      for (const baseTask of baseReport.taskMetadata ?? []) {
        const maskedStashDir = materialiseMaskedStash(fixturesRoot, baseTask.stash, row.assetRef);
        if (maskedStashDir) tmpDirs.push(maskedStashDir);
        // Issue #251: forward the masked stashDir via the explicit
        // `stashDirOverride` field on the cloned TaskMetadata. We MUST NOT
        // mutate `baseTask.stash` (the fixture name) — the runner uses that
        // to call `loadFixtureStash`, and overloading it breaks the
        // `__no-stash__` resolution branch in runner.ts. The runner's AKM-arm
        // branch checks `task.stashDirOverride` first.
        //
        // When `materialiseMaskedStash` returned `null` (asset not present in
        // this fixture, or hostile ref shape rejected by the validator), we
        // intentionally leave both fields untouched. The runner falls back to
        // the normal materialisation flow against the unchanged source
        // fixture — so the re-run still happens, but the result mirrors the
        // base. This is a meaningful diagnostic (the ref didn't bind in this
        // fixture) and is the same accounting `cost-accounting`-style tests
        // assert against.
        if (maskedStashDir) {
          maskedTasks.push({ ...baseTask, stashDirOverride: maskedStashDir });
        } else {
          maskedTasks.push({ ...baseTask });
        }
      }

      const maskedReport = await opts.runUtility({
        ...opts.baseOptions,
        tasks: maskedTasks,
        // The masked stash already has the correct content on disk, and the
        // runner now resolves it via `task.stashDirOverride`. We still pass
        // `materialiseStash: false` so the runner does not call
        // `loadFixtureStash` against the (unmasked) named fixture — that
        // would waste work and risk re-indexing the source dir.
        materialiseStash: false,
      });

      const maskedPassRate = maskedReport.aggregateAkm.passRate;
      attributions.push({
        assetRef: row.assetRef,
        basePassRate: baseAkmPassRate,
        maskedPassRate,
        marginalContribution: baseAkmPassRate - maskedPassRate,
      });
      maskedRefs.push(row.assetRef);
    } finally {
      // Cleanup runs in BOTH success and failure paths (acceptance criterion).
      // Best-effort: a tmpfs failure here is logged via the `try/catch` below
      // and the host OS reaps the tmp dir on reboot.
      for (const dir of tmpDirs) {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
        } catch {
          // Best-effort cleanup; tmpfs cleanup will handle leaks.
        }
      }
    }
  }

  return {
    baseReport,
    attributions,
    runsPerformed: clamped,
    maskingStrategy: "leave-one-out",
    maskedRefs,
  };
}

/**
 * Copy a fixture stash into a fresh tmp dir, delete every file matching the
 * masked asset ref, and return the tmp dir path. Returns `null` if the named
 * asset is not present in the fixture (we still re-run, but the result will
 * mirror the base — which is itself a meaningful diagnostic).
 *
 * The masking heuristic:
 *   1. Walk `<stash>/*<...>/.stash.json` files.
 *   2. For each entry whose `name` + `type` matches the asset ref, drop the
 *      entry and delete its `filename` if present.
 *   3. Rewrite the `.stash.json` with the trimmed entries (or remove it if
 *      it is now empty).
 */
function materialiseMaskedStash(fixturesRoot: string, stashName: string, assetRef: string): string | null {
  const sourceDir = path.join(fixturesRoot, stashName);
  if (!fs.existsSync(path.join(sourceDir, "MANIFEST.json"))) return null;

  // Issue #251 review addendum: validate the WHOLE ref against the anchored
  // grammar before we touch the filesystem. The downstream `isSafeAssetNameSegment`
  // + `isPathContained` checks are still applied — this is defense in depth.
  if (!isSafeAssetRef(assetRef)) return null;

  const colonIdx = assetRef.indexOf(":");
  if (colonIdx < 0) {
    // Malformed ref: still produce a tmp copy with no edits so the caller's
    // re-run sees the unmodified fixture.
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), `akm-bench-masked-${stashName}-`));
    copyDirRecursive(sourceDir, tmpRoot);
    return tmpRoot;
  }
  const typeWithOrigin = assetRef.slice(0, colonIdx);
  const name = assetRef.slice(colonIdx + 1);
  const type = typeWithOrigin.includes("//") ? (typeWithOrigin.split("//")[1] ?? typeWithOrigin) : typeWithOrigin;

  // SECURITY: the asset ref originates from agent stdout (untrusted; the
  // agent could be prompt-injected). The masking heuristic below will
  // `fs.rmSync` files under the tmp stash dir whose names are derived from
  // `name`. A traversal-shaped name (`../etc`, `/abs/path`, `..\\..`) would
  // escape the tmp root and delete arbitrary disk content. Reject those
  // shapes BEFORE we materialise — and re-validate after path-resolving
  // each candidate. Mirrors src/core/asset-ref.ts validateName().
  if (!isSafeAssetNameSegment(name)) return null;

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), `akm-bench-masked-${stashName}-`));
  copyDirRecursive(sourceDir, tmpRoot);

  // Walk every .stash.json under the tmp root and edit in place.
  walkStashJsonFiles(tmpRoot, (jsonPath) => {
    let raw: string;
    try {
      raw = fs.readFileSync(jsonPath, "utf8");
    } catch {
      return;
    }
    let parsed: { entries?: Array<Record<string, unknown>> };
    try {
      parsed = JSON.parse(raw) as { entries?: Array<Record<string, unknown>> };
    } catch {
      return;
    }
    const entries = parsed.entries ?? [];
    const kept: Array<Record<string, unknown>> = [];
    const jsonDir = path.dirname(jsonPath);
    for (const entry of entries) {
      if (entry.type === type && entry.name === name) {
        // Remove the entry's content file(s). The on-disk `filename` is read
        // from the fixture .stash.json (trusted) but the value still passes
        // through path.relative containment so a malicious fixture can't use
        // this path to escape either.
        const filename = entry.filename;
        if (typeof filename === "string" && isSafeAssetNameSegment(filename)) {
          const target = path.resolve(jsonDir, filename);
          if (isPathContained(tmpRoot, target)) {
            try {
              fs.rmSync(target, { force: true });
            } catch {
              // ignore
            }
          }
        }
        // Some fixtures keep a per-asset directory (e.g. skills/<name>/SKILL.md).
        const dirCandidate = path.resolve(jsonDir, name);
        if (
          isPathContained(tmpRoot, dirCandidate) &&
          fs.existsSync(dirCandidate) &&
          fs.statSync(dirCandidate).isDirectory()
        ) {
          try {
            fs.rmSync(dirCandidate, { recursive: true, force: true });
          } catch {
            // ignore
          }
        }
        continue;
      }
      kept.push(entry);
    }
    if (kept.length === entries.length) return; // nothing changed
    if (kept.length === 0) {
      try {
        fs.rmSync(jsonPath, { force: true });
      } catch {
        // ignore
      }
    } else {
      fs.writeFileSync(jsonPath, `${JSON.stringify({ ...parsed, entries: kept }, null, 2)}\n`);
    }
  });

  return tmpRoot;
}

/**
 * Reject any segment that could escape the tmp stash root when used as a
 * relative path component:
 *   - empty string
 *   - any `/` or `\\` (path separators)
 *   - a `..` segment in any form
 *   - a leading `/` (POSIX absolute) or `C:` (Windows drive)
 *   - any null byte
 *
 * Mirrors src/core/asset-ref.ts validateName(), but returns a boolean
 * (callers map this to "skip" rather than "throw").
 */
function isSafeAssetNameSegment(value: string): boolean {
  if (!value) return false;
  if (value.includes("\0")) return false;
  if (value.includes("/") || value.includes("\\")) return false;
  if (value === ".." || value === ".") return false;
  if (/^[A-Za-z]:/.test(value)) return false;
  return true;
}

/**
 * After resolving a target path, confirm it lives under `root`. Defense in
 * depth: even if a traversal-shaped name slipped past the segment check,
 * this catches escapes via symlinks or odd `path.join` semantics.
 */
function isPathContained(root: string, target: string): boolean {
  const rootResolved = path.resolve(root);
  const targetResolved = path.resolve(target);
  const rel = path.relative(rootResolved, targetResolved);
  if (rel === "") return true;
  if (rel.startsWith("..")) return false;
  if (path.isAbsolute(rel)) return false;
  return true;
}

function walkStashJsonFiles(root: string, visit: (jsonPath: string) => void): void {
  const stack: string[] = [root];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (!cur) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const abs = path.join(cur, entry.name);
      if (entry.isDirectory()) stack.push(abs);
      else if (entry.isFile() && entry.name === ".stash.json") visit(abs);
    }
  }
}

function copyDirRecursive(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirRecursive(s, d);
    else if (entry.isFile()) fs.copyFileSync(s, d);
  }
}

/** Aggregate trajectory booleans across a bag of runs. */
export function aggregateTrajectory(results: RunResult[]): TrajectoryAggregate {
  if (results.length === 0) {
    return { correctAssetLoaded: null, feedbackRecorded: 0 };
  }
  let knownAsset = 0;
  let assetLoaded = 0;
  let feedback = 0;
  for (const r of results) {
    if (r.trajectory.correctAssetLoaded !== null) {
      knownAsset += 1;
      if (r.trajectory.correctAssetLoaded) assetLoaded += 1;
    }
    if (r.trajectory.feedbackRecorded === true) feedback += 1;
  }
  return {
    correctAssetLoaded: knownAsset === 0 ? null : assetLoaded / knownAsset,
    feedbackRecorded: feedback / results.length,
  };
}

// ── Compare (§8, two-run diff) ─────────────────────────────────────────────

/**
 * Sign marker for delta rendering. `improve` / `regress` / `flat` are
 * direction labels; the markdown layer turns them into ▲ / ▼ / ▬. Kept as
 * a tagged label rather than the literal glyphs so JSON consumers don't have
 * to deal with non-ASCII.
 */
export type DeltaSign = "improve" | "regress" | "flat";

/**
 * One row of the per-task compare table. `baseMetrics` and `currentMetrics`
 * carry through the §13.3 per-task envelopes verbatim (snake-case keys
 * preserved) so the JSON consumer can read seed-stdev, budget-exceeded
 * counts, etc., without re-parsing the source reports.
 *
 * `id` may be present in only one side — `presence` distinguishes
 * "regression" rows (in both) from "added" / "removed" rows.
 */
export interface CompareTaskRow {
  id: string;
  /** Where this task appears: in both reports, only the base, or only the current. */
  presence: "both" | "base-only" | "current-only";
  /** Per-task metrics from the base report. `null` when the task is current-only. */
  baseMetrics: PerTaskJson | null;
  /** Per-task metrics from the current report. `null` when the task is base-only. */
  currentMetrics: PerTaskJson | null;
  /** akm pass_rate delta, current − base. `null` when one side is missing. */
  delta: { passRate: number | null; tokensPerPass: number | null; wallclockMs: number | null };
  /** Direction marker for `passRate`: `flat` when within tolerance or unmeasured. */
  signMarker: DeltaSign;
}

/** Snake-case per-task envelope as serialised by `renderUtilityReport`. */
export interface PerTaskJson {
  pass_rate: number;
  pass_at_1: 0 | 1;
  tokens_per_pass: number | null;
  wallclock_ms: number;
  pass_rate_stdev: number;
  budget_exceeded_count: number;
  harness_error_count: number;
  count: number;
}

/**
 * Aggregate (corpus-wide) compare row. Same null-safety as `CorpusDelta`:
 * `tokensPerPassDelta` is `null` when either side lacks a measurement.
 */
export interface CompareAggregate {
  passRateDelta: number;
  passRateSign: DeltaSign;
  tokensPerPassDelta: number | null;
  tokensPerPassSign: DeltaSign;
  wallclockMsDelta: number;
  wallclockMsSign: DeltaSign;
}

/**
 * Successful compare envelope. The CLI renders this as JSON when `--json` is
 * passed and as markdown otherwise.
 */
export interface CompareReportSuccess {
  ok: true;
  baseModel: string;
  currentModel: string;
  baseFixtureContentHash: string | null;
  currentFixtureContentHash: string | null;
  /** Warnings collected during compare (e.g. missing fixtureContentHash on a side). */
  warnings: string[];
  aggregate: CompareAggregate;
  perTask: CompareTaskRow[];
}

/** Failure envelope. `reason` is the discrete refusal cause; `message` is human-readable. */
export interface CompareReportFailure {
  ok: false;
  reason: "model_mismatch" | "hash_mismatch" | "corpus_mismatch" | "schema_mismatch" | "track_mismatch";
  message: string;
  baseModel?: string;
  currentModel?: string;
  baseFixtureContentHash?: string | null;
  currentFixtureContentHash?: string | null;
  /** When `reason === "hash_mismatch"`, the affected fixtures (best-effort). */
  affectedFixtures?: string[];
  /** #250 — task corpus hashes when `reason === "corpus_mismatch"`. */
  baseTaskCorpusHash?: string | null;
  currentTaskCorpusHash?: string | null;
  /** #250 — selected task IDs that diverge between base and current. */
  baseSelectedTaskIds?: string[];
  currentSelectedTaskIds?: string[];
}

/**
 * Caller-controlled overrides for `compareReports` (#250). When both flags
 * are false (the default), the comparator refuses mismatched corpora /
 * fixtures. Setting a flag converts the corresponding refusal into a
 * warning so an operator can still inspect a cross-corpus or cross-fixture
 * diff when they explicitly opt in.
 */
export interface CompareOptions {
  /** When true, accept mismatched task IDs / `taskCorpusHash`; emit a warning instead. */
  allowCorpusMismatch?: boolean;
  /** When true, accept mismatched `fixtureContentHash`; emit a warning instead. */
  allowFixtureMismatch?: boolean;
}

export type CompareResult = CompareReportSuccess | CompareReportFailure;

/**
 * Sign threshold below which a delta is rendered as `flat`. `pass_rate` is
 * normalised to `[0, 1]`, so a 0.005 (0.5pp) tolerance keeps tiny K-seed
 * sampling jitter from looking like a regression.
 */
const PASS_RATE_FLAT_TOLERANCE = 0.005;
/** `tokens_per_pass` and `wallclock_ms` use raw counts; 0 is the only "flat". */
const COUNT_FLAT_TOLERANCE = 0;

function classifyPassRate(delta: number | null): DeltaSign {
  if (delta === null) return "flat";
  if (Math.abs(delta) <= PASS_RATE_FLAT_TOLERANCE) return "flat";
  return delta > 0 ? "improve" : "regress";
}

function classifyCount(delta: number | null, lowerIsBetter: boolean): DeltaSign {
  if (delta === null) return "flat";
  if (Math.abs(delta) <= COUNT_FLAT_TOLERANCE) return "flat";
  if (lowerIsBetter) return delta < 0 ? "improve" : "regress";
  return delta > 0 ? "improve" : "regress";
}

/**
 * Minimal structural shape we read out of a parsed UtilityRunReport JSON.
 * We deliberately don't import the renderer's own types — the compare layer
 * consumes JSON envelopes from disk, so it needs to be tolerant of small
 * shape drift (e.g. the optional `fixtureContentHash` Wave A may add).
 */
export interface ParsedReportJson {
  schemaVersion?: number;
  track?: string;
  agent?: { harness?: string; model?: string };
  corpus?: {
    domains?: number;
    tasks?: number;
    slice?: string;
    seedsPerArm?: number;
    fixtureContentHash?: string | null;
    /** #250 — stable-sorted list of task IDs the run selected. */
    selectedTaskIds?: string[];
    /** #250 — deterministic hash over `selectedTaskIds` + per-task body bytes. */
    taskCorpusHash?: string | null;
    /** #250 — per-fixture content hash (fixture name → sha256 hex). */
    fixtures?: Record<string, string>;
  };
  aggregate?: {
    noakm?: { pass_rate?: number; tokens_per_pass?: number | null; wallclock_ms?: number };
    akm?: { pass_rate?: number; tokens_per_pass?: number | null; wallclock_ms?: number };
    delta?: { pass_rate?: number; tokens_per_pass?: number | null; wallclock_ms?: number };
  };
  tasks?: Array<{
    id: string;
    noakm?: PerTaskJson;
    akm?: PerTaskJson;
    delta?: { pass_rate?: number; tokens_per_pass?: number | null; wallclock_ms?: number };
  }>;
  warnings?: string[];
}

function readModel(r: ParsedReportJson): string {
  return r.agent?.model ?? "<unknown>";
}

function readFixtureHash(r: ParsedReportJson): string | null {
  const v = r.corpus?.fixtureContentHash;
  return v === undefined || v === null ? null : v;
}

function readTaskCorpusHash(r: ParsedReportJson): string | null {
  const v = r.corpus?.taskCorpusHash;
  return v === undefined || v === null ? null : v;
}

function readSelectedTaskIds(r: ParsedReportJson): string[] | null {
  const v = r.corpus?.selectedTaskIds;
  return Array.isArray(v) ? v : null;
}

function arraysEqualIgnoringOrder(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  for (let i = 0; i < sa.length; i += 1) if (sa[i] !== sb[i]) return false;
  return true;
}

function akmAgg(r: ParsedReportJson): { pass_rate: number; tokens_per_pass: number | null; wallclock_ms: number } {
  const a = r.aggregate?.akm ?? {};
  return {
    pass_rate: a.pass_rate ?? 0,
    tokens_per_pass: a.tokens_per_pass ?? null,
    wallclock_ms: a.wallclock_ms ?? 0,
  };
}

/**
 * Diff two parsed UtilityRunReport JSONs.
 *
 * Refusal cases:
 *   • Either side missing `schemaVersion: 1` or `track: "utility"` →
 *     `schema_mismatch` / `track_mismatch`.
 *   • `agent.model` differs → `model_mismatch`.
 *   • Both sides report a `corpus.fixtureContentHash` and they differ →
 *     `hash_mismatch`. Missing hash on either side proceeds with a warning
 *     (Wave A may add it; older reports won't have it).
 *
 * On success the per-task table includes rows for every task in either side,
 * plus aggregate deltas computed against the akm arm only (the noakm arm is
 * the control — its delta is meaningless). `pass_rate` is in `[0, 1]`,
 * higher is better; `tokens_per_pass` and `wallclock_ms` are counts, lower
 * is better.
 */
export function compareReports(
  base: ParsedReportJson,
  current: ParsedReportJson,
  options: CompareOptions = {},
): CompareResult {
  // Schema-version gate.
  if (base.schemaVersion !== 1 || current.schemaVersion !== 1) {
    return {
      ok: false,
      reason: "schema_mismatch",
      message: `compare requires schemaVersion=1 on both sides; got base=${String(
        base.schemaVersion,
      )}, current=${String(current.schemaVersion)}`,
    };
  }
  // Track gate. Cross-track diffs are nonsensical.
  if (base.track !== "utility" || current.track !== "utility") {
    return {
      ok: false,
      reason: "track_mismatch",
      message: `compare only supports track="utility"; got base="${String(base.track)}", current="${String(
        current.track,
      )}"`,
    };
  }

  const baseModel = readModel(base);
  const currentModel = readModel(current);
  if (baseModel !== currentModel) {
    return {
      ok: false,
      reason: "model_mismatch",
      message: `cannot compare across different models: base="${baseModel}", current="${currentModel}". Rerun on the same model.`,
      baseModel,
      currentModel,
    };
  }

  const baseHash = readFixtureHash(base);
  const currentHash = readFixtureHash(current);
  const warnings: string[] = [];

  // #250 — task corpus hash + selected task IDs. Refused unless either side
  // is legacy (missing the hash) or the operator passed
  // `allowCorpusMismatch`. Legacy reports (no taskCorpusHash) degrade to a
  // warning so older artefacts can still be diffed.
  const baseTaskHash = readTaskCorpusHash(base);
  const currentTaskHash = readTaskCorpusHash(current);
  const baseIds = readSelectedTaskIds(base);
  const currentIds = readSelectedTaskIds(current);
  if (baseTaskHash !== null && currentTaskHash !== null && baseTaskHash !== currentTaskHash) {
    if (!options.allowCorpusMismatch) {
      return {
        ok: false,
        reason: "corpus_mismatch",
        message: `cannot compare across different task corpora: base taskCorpusHash="${baseTaskHash}", current="${currentTaskHash}". Rerun against the same task selection or pass --allow-corpus-mismatch to override.`,
        baseModel,
        currentModel,
        baseTaskCorpusHash: baseTaskHash,
        currentTaskCorpusHash: currentTaskHash,
        ...(baseIds ? { baseSelectedTaskIds: baseIds } : {}),
        ...(currentIds ? { currentSelectedTaskIds: currentIds } : {}),
      };
    }
    warnings.push(
      `task corpus hashes differ (base="${baseTaskHash}", current="${currentTaskHash}") — diff requested via --allow-corpus-mismatch`,
    );
  } else if (
    baseTaskHash === null &&
    currentTaskHash === null &&
    baseIds !== null &&
    currentIds !== null &&
    !arraysEqualIgnoringOrder(baseIds, currentIds)
  ) {
    // Both sides legacy (no taskCorpusHash) but both expose selectedTaskIds
    // and they differ. We can still detect a mismatched corpus from the ID
    // list alone — refuse unless the operator opted in.
    if (!options.allowCorpusMismatch) {
      return {
        ok: false,
        reason: "corpus_mismatch",
        message: `cannot compare across different selected task IDs. Rerun against the same task selection or pass --allow-corpus-mismatch to override.`,
        baseModel,
        currentModel,
        baseSelectedTaskIds: baseIds,
        currentSelectedTaskIds: currentIds,
      };
    }
    warnings.push("selected task IDs differ — diff requested via --allow-corpus-mismatch");
  }
  if (baseTaskHash === null)
    warnings.push("base report has no corpus.taskCorpusHash; proceeding without task-corpus-pin check");
  if (currentTaskHash === null)
    warnings.push("current report has no corpus.taskCorpusHash; proceeding without task-corpus-pin check");

  if (baseHash !== null && currentHash !== null && baseHash !== currentHash) {
    if (!options.allowFixtureMismatch) {
      return {
        ok: false,
        reason: "hash_mismatch",
        message: `cannot compare across different fixture-content hashes: base="${baseHash}", current="${currentHash}". Rerun against matching fixtures or pass --allow-fixture-mismatch to override.`,
        baseModel,
        currentModel,
        baseFixtureContentHash: baseHash,
        currentFixtureContentHash: currentHash,
      };
    }
    warnings.push(
      `fixture-content hashes differ (base="${baseHash}", current="${currentHash}") — diff requested via --allow-fixture-mismatch`,
    );
  }
  if (baseHash === null)
    warnings.push("base report has no corpus.fixtureContentHash; proceeding without fixture-pin check");
  if (currentHash === null)
    warnings.push("current report has no corpus.fixtureContentHash; proceeding without fixture-pin check");

  // Aggregate (akm arm is the one that matters — noakm is the control).
  const ba = akmAgg(base);
  const ca = akmAgg(current);
  const passRateDelta = ca.pass_rate - ba.pass_rate;
  const tokensPerPassDelta =
    ba.tokens_per_pass === null || ca.tokens_per_pass === null ? null : ca.tokens_per_pass - ba.tokens_per_pass;
  const wallclockMsDelta = ca.wallclock_ms - ba.wallclock_ms;

  const aggregate: CompareAggregate = {
    passRateDelta,
    passRateSign: classifyPassRate(passRateDelta),
    tokensPerPassDelta,
    tokensPerPassSign: classifyCount(tokensPerPassDelta, true),
    wallclockMsDelta,
    wallclockMsSign: classifyCount(wallclockMsDelta, true),
  };

  // Per-task rows. Outer-join on task id.
  const baseTasks = new Map<string, NonNullable<ParsedReportJson["tasks"]>[number]>();
  for (const t of base.tasks ?? []) baseTasks.set(t.id, t);
  const currentTasks = new Map<string, NonNullable<ParsedReportJson["tasks"]>[number]>();
  for (const t of current.tasks ?? []) currentTasks.set(t.id, t);

  const allIds = new Set<string>();
  for (const id of baseTasks.keys()) allIds.add(id);
  for (const id of currentTasks.keys()) allIds.add(id);

  const perTask: CompareTaskRow[] = [];
  for (const id of [...allIds].sort()) {
    const b = baseTasks.get(id);
    const c = currentTasks.get(id);
    const bM = b?.akm ?? null;
    const cM = c?.akm ?? null;
    const presence: CompareTaskRow["presence"] =
      b !== undefined && c !== undefined ? "both" : b !== undefined ? "base-only" : "current-only";

    const passRateDelta_ = bM !== null && cM !== null ? cM.pass_rate - bM.pass_rate : null;
    const tokensPerPassDelta_ =
      bM !== null && cM !== null && bM.tokens_per_pass !== null && cM.tokens_per_pass !== null
        ? cM.tokens_per_pass - bM.tokens_per_pass
        : null;
    const wallclockMsDelta_ = bM !== null && cM !== null ? cM.wallclock_ms - bM.wallclock_ms : null;

    perTask.push({
      id,
      presence,
      baseMetrics: bM,
      currentMetrics: cM,
      delta: { passRate: passRateDelta_, tokensPerPass: tokensPerPassDelta_, wallclockMs: wallclockMsDelta_ },
      signMarker: classifyPassRate(passRateDelta_),
    });
  }

  return {
    ok: true,
    baseModel,
    currentModel,
    baseFixtureContentHash: baseHash,
    currentFixtureContentHash: currentHash,
    warnings,
    aggregate,
    perTask,
  };
}

// ── Failure-mode taxonomy (§6.6) ───────────────────────────────────────────

/**
 * The seven failure-mode labels defined by spec §6.6. Exactly one applies
 * to every failed run; `unrelated_bug` is the catch-all when nothing more
 * specific matches.
 *
 *   no_search       — agent never invoked `akm search`. AGENTS.md problem.
 *   search_no_gold  — search ran but gold ref absent from result list.
 *   search_low_rank — gold ref present at rank > 5.
 *   loaded_wrong    — `akm show` on a non-gold ref before the action AND
 *                     the gold ref was never loaded.
 *   loaded_ignored  — gold ref loaded; action contradicts its content.
 *   followed_wrong  — gold ref loaded and apparently followed; verifier
 *                     still failed (asset itself is wrong).
 *   unrelated_bug   — none of the above; not an akm problem.
 */
export type FailureMode =
  | "no_search"
  | "search_no_gold"
  | "search_low_rank"
  | "loaded_wrong"
  | "loaded_ignored"
  | "followed_wrong"
  | "unrelated_bug";

/** Maximum rank at which the gold ref still counts as "found"; > this is `search_low_rank`. */
const SEARCH_RANK_CUTOFF = 5;

/** Cap on the number of characters of `verifierStdout` we substring-scan. Mirrors trajectory.ts. */
const FAILURE_MODE_STDOUT_SCAN_CAP = 16 * 1024 * 1024;

/**
 * Classify a single failed run into one of the seven §6.6 labels. Pure
 * function — string-matches `runResult.events[]` and `runResult.verifierStdout`,
 * never calls an LLM, never touches the filesystem.
 *
 * Decision tree (priority order — first match wins):
 *   1. Run not failed (`pass`, `budget_exceeded`, `harness_error`) → `null`.
 *   2. No `akm search` call in the trace → `no_search`.
 *   3. Search ran; gold ref absent from search results → `search_no_gold`.
 *   4. Gold ref present in search results at rank > 5 → `search_low_rank`.
 *   5. `akm show` invoked on a non-gold ref AND gold ref never loaded → `loaded_wrong`.
 *   6. Gold ref loaded; verifier output suggests the action contradicts the
 *      asset's guidance (heuristic: verifier mentions the gold pattern was
 *      explicitly NOT followed) → `loaded_ignored`.
 *   7. Gold ref loaded and apparently followed → `followed_wrong`.
 *   8. Default → `unrelated_bug`.
 *
 * Tasks without `goldRef`: rules that depend on the gold ref (3-7) are
 * skipped; only `no_search` and `unrelated_bug` are reachable.
 */
export function classifyFailureMode(taskMeta: TaskMetadata, runResult: RunResult): FailureMode | null {
  if (runResult.outcome !== "fail") return null;

  const trace = collectTrace(runResult);
  const goldRef = taskMeta.goldRef;

  // 1. no_search — no `akm search` invocation anywhere in the trace.
  if (!hasAkmSearch(trace, runResult)) {
    return "no_search";
  }

  // Without a gold ref the search-based and load-based checks are undefined.
  // We can only distinguish "no_search" from everything else.
  if (!goldRef) {
    return "unrelated_bug";
  }

  const searchRank = findGoldSearchRank(trace, goldRef);
  // 2. search_no_gold — search ran (precondition above) but gold ref absent.
  if (searchRank === null) {
    return "search_no_gold";
  }
  // 3. search_low_rank — present but below the cutoff.
  if (searchRank > SEARCH_RANK_CUTOFF) {
    return "search_low_rank";
  }

  const goldLoaded = hasAkmShow(trace, runResult, goldRef);
  const otherRefLoaded = hasAkmShowOtherRef(trace, runResult, goldRef);

  // 4. loaded_wrong — agent showed a non-gold ref AND never loaded the gold.
  if (otherRefLoaded && !goldLoaded) {
    return "loaded_wrong";
  }

  // The remaining branches all assume the gold was loaded.
  if (!goldLoaded) {
    // Gold ref was found in search at an acceptable rank, but the agent
    // never loaded anything (gold or otherwise) before failing. The taxonomy
    // table has no row for "found but never opened" — treat as unrelated_bug.
    return "unrelated_bug";
  }

  // 5. loaded_ignored — verifier diagnostic indicates the action contradicts
  //    the loaded asset. Conservative heuristic: look for explicit "ignored"
  //    or "not applied" markers in the verifier stdout. Without an LLM we
  //    cannot detect subtler contradictions, so this branch only fires when
  //    the verifier itself flagged the contradiction.
  if (verifierIndicatesIgnored(runResult.verifierStdout)) {
    return "loaded_ignored";
  }

  // 6. followed_wrong — gold loaded, apparently followed, verifier still
  //    failed. The §6.6 spec maps this to "the asset itself is wrong".
  return "followed_wrong";
}

/**
 * Aggregate per-label counts plus a per-task breakdown. Produced once per
 * `runUtility` call; embedded in `UtilityRunReport.failureModes`.
 */
export interface FailureModeAggregate {
  /** Total count per label across the entire corpus. Missing labels are absent. */
  byLabel: Partial<Record<FailureMode, number>>;
  /** Per-task breakdown, keyed by `taskId` then label. */
  byTask: Record<string, Partial<Record<FailureMode, number>>>;
}

/** Build a `FailureModeAggregate` from a list of (taskId, label) pairs. */
export function aggregateFailureModes(entries: Array<{ taskId: string; mode: FailureMode }>): FailureModeAggregate {
  const byLabel: Partial<Record<FailureMode, number>> = {};
  const byTask: Record<string, Partial<Record<FailureMode, number>>> = {};
  for (const { taskId, mode } of entries) {
    byLabel[mode] = (byLabel[mode] ?? 0) + 1;
    if (!byTask[taskId]) byTask[taskId] = {};
    byTask[taskId][mode] = (byTask[taskId][mode] ?? 0) + 1;
  }
  return { byLabel, byTask };
}

// ── Failure-mode classifier helpers ────────────────────────────────────────

/**
 * Concatenated string used for substring scans. We pre-build this once per
 * classify call so the helper functions can share it. Stdout is capped per
 * the trajectory parser convention to keep runaway agents from OOMing the
 * bench.
 */
function collectTrace(runResult: RunResult): string {
  const stdout = runResult.verifierStdout ?? "";
  const capped = stdout.length > FAILURE_MODE_STDOUT_SCAN_CAP ? stdout.slice(0, FAILURE_MODE_STDOUT_SCAN_CAP) : stdout;
  return capped;
}

/** Does the trace contain any `akm search` invocation (CLI form OR event)? */
function hasAkmSearch(trace: string, runResult: RunResult): boolean {
  // Tool-call CLI form, e.g. `akm search "deploy homelab"`.
  if (/\bakm\s+search\b/.test(trace)) return true;
  // Tool-call JSON form, e.g. `"args":["search","..."]`.
  if (trace.includes(`"search"`) && /["']search["']/.test(trace)) return true;
  // Event-stream form (search verbs aren't currently emitted but the field
  // is forward-compatible — see core/events.ts).
  for (const event of runResult.events) {
    if (event.eventType === "search" || event.eventType === "search_invoked") return true;
  }
  return false;
}

/**
 * Find the 1-based rank of `goldRef` in the search results captured in the
 * trace, or `null` if not present. Best-effort heuristics:
 *   1. Look for an `akm search` block followed by a numbered list (`1. skill:foo`).
 *   2. Look for a JSON-ish results array containing the ref.
 *   3. Fall back to substring presence — if the ref appears anywhere after
 *      a search invocation, treat it as rank-unknown. We err on the side of
 *      `1` (best case for the agent) so the classifier doesn't false-positive
 *      on `search_low_rank`.
 */
function findGoldSearchRank(trace: string, goldRef: string): number | null {
  // Locate the first `akm search` invocation; restrict the rank search to
  // text after it so we don't pick up `akm show` output.
  const searchMatch = trace.match(/\bakm\s+search\b/);
  if (!searchMatch || searchMatch.index === undefined) {
    // Caller already verified search ran; if our regex disagrees, fall back
    // to scanning the full trace.
    return findRefRankInText(trace, goldRef);
  }
  const after = trace.slice(searchMatch.index);
  return findRefRankInText(after, goldRef);
}

function findRefRankInText(text: string, goldRef: string): number | null {
  const escaped = goldRef.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Numbered list: lines of the form `<rank>. <ref>` or `<rank>) <ref>`.
  const numberedRe = /^\s*(\d{1,3})[.)]\s+([^\s]+)/gm;
  let match: RegExpExecArray | null;
  while (true) {
    match = numberedRe.exec(text);
    if (match === null) break;
    const ref = match[2];
    if (refsMatch(ref, goldRef)) {
      return Number.parseInt(match[1], 10);
    }
  }
  // JSON array form: `"results":["a","b","skill:foo"]`. Estimate rank by
  // splitting on commas after the bracket. Best-effort.
  const jsonRe = /"results"\s*:\s*\[([^\]]+)\]/;
  const jsonMatch = text.match(jsonRe);
  if (jsonMatch) {
    const items = jsonMatch[1].split(",").map((s) => s.trim().replace(/^["']|["']$/g, ""));
    const idx = items.findIndex((item) => refsMatch(item, goldRef));
    if (idx >= 0) return idx + 1;
  }
  // Substring presence — assume rank 1 (best case for the agent, conservative
  // for the `search_low_rank` rule).
  const refRe = new RegExp(`\\b${escaped}\\b`);
  if (refRe.test(text)) return 1;
  return null;
}

/** True when `candidate` is `goldRef` or a strict ref-extension thereof. */
function refsMatch(candidate: string, goldRef: string): boolean {
  if (candidate === goldRef) return true;
  if (candidate.endsWith(`//${goldRef}`)) return true;
  if (candidate.startsWith(`${goldRef}/`)) return true;
  return false;
}

/** Did the agent invoke `akm show <goldRef>` at any point? */
function hasAkmShow(trace: string, runResult: RunResult, goldRef: string): boolean {
  const escaped = goldRef.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // CLI form, exact ref. Also matches origin-prefixed variants like
  // `akm show team//skill:foo` because the `[\w/]*//` prefix is optional.
  const cliRe = new RegExp(`\\bakm\\s+show\\s+["']?(?:[\\w-]+//)?${escaped}(?:\\b|\\W)`);
  if (cliRe.test(trace)) return true;
  // Tool-call JSON form: `"args":["show","skill:foo"]`.
  if (trace.includes(`"show"`) && trace.includes(goldRef)) return true;
  // Event-stream metadata.ref.
  for (const event of runResult.events) {
    if (typeof event.ref === "string" && refsMatch(event.ref, goldRef)) {
      // Only count "show" or "load" eventTypes; a `feedback` event mentioning
      // the ref doesn't mean the agent loaded it during this run.
      if (event.eventType === "show" || event.eventType === "load" || event.eventType === "tool_call") return true;
    }
    const meta = event.metadata;
    if (meta && typeof meta === "object") {
      const candidate = (meta as Record<string, unknown>).ref;
      if (typeof candidate === "string" && refsMatch(candidate, goldRef)) {
        if (event.eventType === "show" || event.eventType === "load" || event.eventType === "tool_call") return true;
      }
    }
  }
  return false;
}

/** Did the agent invoke `akm show <ref>` for some ref OTHER than `goldRef`? */
function hasAkmShowOtherRef(trace: string, runResult: RunResult, goldRef: string): boolean {
  // CLI form: capture the ref argument and reject when it matches the gold.
  const cliRe = /\bakm\s+show\s+["']?([^\s"'`]+)/g;
  let match: RegExpExecArray | null;
  while (true) {
    match = cliRe.exec(trace);
    if (match === null) break;
    if (!refsMatch(match[1], goldRef)) return true;
  }
  // Tool-call JSON form: `"args":["show","..."]`. Best-effort scan.
  const jsonRe = /\["show",\s*"([^"]+)"/g;
  while (true) {
    match = jsonRe.exec(trace);
    if (match === null) break;
    if (!refsMatch(match[1], goldRef)) return true;
  }
  // Event-stream form.
  for (const event of runResult.events) {
    if (event.eventType !== "show" && event.eventType !== "load" && event.eventType !== "tool_call") continue;
    if (typeof event.ref === "string" && !refsMatch(event.ref, goldRef)) return true;
    const meta = event.metadata;
    if (meta && typeof meta === "object") {
      const candidate = (meta as Record<string, unknown>).ref;
      if (typeof candidate === "string" && !refsMatch(candidate, goldRef)) return true;
    }
  }
  return false;
}

/**
 * Conservative heuristic for the `loaded_ignored` branch. Without an LLM we
 * cannot reliably decide whether an arbitrary action contradicts arbitrary
 * asset content; we only fire when the verifier's own diagnostic explicitly
 * flags the gold-asset guidance as ignored.
 *
 * The verifier stdout strings are deterministic — they come from
 * `runVerifier` and the per-task `verify.sh` scripts. Tasks that want to
 * surface this label should emit one of the agreed-upon markers below.
 */
function verifierIndicatesIgnored(verifierStdout: string): boolean {
  if (!verifierStdout) return false;
  const lower = verifierStdout.toLowerCase();
  return (
    lower.includes("ignored gold guidance") ||
    lower.includes("guidance ignored") ||
    lower.includes("did not follow loaded asset") ||
    lower.includes("contradicts loaded asset")
  );
}
// ── Search-pipeline bridge (§6.7) ──────────────────────────────────────────

/**
 * One observed `akm search` invocation in a real run.
 *
 * `rankOfGold` is 1-based (rank 1 = first hit). It is `null` when the gold
 * ref was not present in the top 10 results — that bucket is rendered as
 * `missing` in the histogram and treated as `Infinity` for percentile math.
 */
export interface GoldRankEvent {
  query: string;
  /** Result refs in rank order (most relevant first). May be empty. */
  results: string[];
  /** 1-based rank of the gold ref in `results`, capped at 10. `null` if absent. */
  rankOfGold: number | null;
}

/**
 * Per-run gold-rank record carried on the report so `computeSearchBridge`
 * can aggregate without seeing the full RunResult bag again. Owned by the
 * runner: it stamps one of these per akm-arm run with a goldRef, then we
 * reduce them at the end of `runUtility`.
 */
export interface GoldRankRunRecord {
  taskId: string;
  arm: string;
  seed: number;
  outcome: RunResult["outcome"];
  goldRef: string;
  /** All `akm search` invocations the agent made during this run, in order. */
  searches: GoldRankEvent[];
}

/** Histogram of gold rank: keys are `"1".."10"` plus `"missing"`. */
export type GoldRankHistogram = Record<string, number>;

/** Pass-rate slice keyed by the rank of gold in the agent's *chosen* search. */
export interface PassRateByRankEntry {
  /** Rank as a string ("1".."10") or the literal "missing". */
  rank: string;
  passRate: number;
  runCount: number;
}

export interface SearchBridgeMetrics {
  /** Histogram across every observed `akm search` (rank 1..10 + missing). */
  goldRankDistribution: GoldRankHistogram;
  /** Median rank across observed searches. `null` if no searches. */
  goldRankP50: number | null;
  /** 90th-percentile rank. `null` if no searches. */
  goldRankP90: number | null;
  /** Fraction of searches where gold was at rank 1. `0` when no searches. */
  goldAtRank1: number;
  /** Fraction of searches where gold was missing (not in top 10). */
  goldMissing: number;
  /** Pass rate of *runs* split by the rank in their chosen (last) search. */
  passRateByRank: PassRateByRankEntry[];
  /** Number of (akm-arm, goldRef) runs aggregated. */
  runsObserved: number;
  /** Number of `akm search` invocations aggregated. */
  searchesObserved: number;
}

/** Cap on the number of result refs we extract per `akm search` invocation. */
const TOP_K = 10;

/**
 * Extract the gold rank for every `akm search` invocation in a run.
 *
 * The parser scans `runResult.verifierStdout` (which carries the captured
 * agent stdout including its tool-call trace) for `akm search` commands
 * and the result lists that follow them. The first 10 hits are considered;
 * if the gold ref appears, `rankOfGold` is its 1-based position, else
 * `null`.
 *
 * Pure function: never reads from disk and never mutates inputs. When
 * `goldRef` is undefined the function returns `[]` — we only attribute
 * ranks for tasks that actually have a gold asset.
 */
export function extractGoldRanks(runResult: RunResult, goldRef: string | undefined): GoldRankEvent[] {
  if (!goldRef) return [];
  const haystack = runResult.verifierStdout;
  if (!haystack) return [];

  const events: GoldRankEvent[] = [];

  // Walk the stdout linearly. A search invocation looks like
  //   `akm search "<query>"` or `akm search <query>`
  // and the subsequent block carries the result list. A new `akm` command
  // (or end of stdout) terminates the previous search's result block.
  const lines = haystack.split(/\r?\n/);
  let active: GoldRankEvent | null = null;

  // Regex for an `akm search` invocation. Captures the rest of the line
  // after `search ` so we can pick up the query whether it's quoted or not.
  const searchInvocationRe = /\bakm\s+search\s+(.+?)(?:\s+--|$)/;
  // A different `akm <verb>` (not `search`) terminates the active block.
  const akmInvocationRe = /\bakm\s+(\w+)/;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const searchMatch = line.match(searchInvocationRe);
    if (searchMatch) {
      // Flush any active block before starting a new one.
      if (active) {
        active.rankOfGold = computeRank(active.results, goldRef);
        events.push(active);
      }
      const query = stripQuotes(searchMatch[1].trim());
      active = { query, results: [], rankOfGold: null };
      // Some traces inline the JSON result on the same line — try to extract.
      collectRefsFromLine(line, active.results);
      continue;
    }

    if (!active) continue;

    // A non-search akm invocation closes the active search block.
    const akmMatch = line.match(akmInvocationRe);
    if (akmMatch && akmMatch[1] !== "search") {
      active.rankOfGold = computeRank(active.results, goldRef);
      events.push(active);
      active = null;
      continue;
    }

    collectRefsFromLine(line, active.results);
  }

  if (active) {
    active.rankOfGold = computeRank(active.results, goldRef);
    events.push(active);
  }

  return events;
}

/** Trim leading/trailing single or double quotes from a query string. */
function stripQuotes(s: string): string {
  if (s.length >= 2) {
    const first = s[0];
    const last = s[s.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return s.slice(1, -1);
    }
  }
  return s;
}

/**
 * Pull asset refs from a single line into `out`. Matches both plain
 * `ref: <ref>` lines (text mode) and `"ref":"<ref>"` (JSON mode). We
 * stop at TOP_K results to mirror the spec's top-10 cutoff.
 */
function collectRefsFromLine(line: string, out: string[]): void {
  if (out.length >= TOP_K) return;

  // JSON form: `"ref":"skill:foo"` or `"ref": "skill:foo"`. Multiple per line possible.
  const jsonRe = /"ref"\s*:\s*"([^"]+)"/g;
  let m: RegExpExecArray | null;
  m = jsonRe.exec(line);
  while (m !== null) {
    if (out.length >= TOP_K) return;
    out.push(m[1]);
    m = jsonRe.exec(line);
  }

  // Plain text form: `  ref: skill:foo`. Only treat the line as a ref-bearing
  // line if it starts with `ref:` (after whitespace). Avoids picking up
  // every `:` in arbitrary stdout.
  const textRe = /^ref:\s*([^\s,]+)/;
  const tm = line.match(textRe);
  if (tm && out.length < TOP_K) {
    out.push(tm[1]);
  }
}

/**
 * 1-based rank of `goldRef` in `results`, or `null` if absent within the
 * top 10. We use `matchesGold` for prefix-tolerant matching so
 * `team//skill:foo` counts as `skill:foo` (mirrors trajectory parser).
 */
function computeRank(results: string[], goldRef: string): number | null {
  const cap = Math.min(results.length, TOP_K);
  for (let i = 0; i < cap; i += 1) {
    if (matchesGold(results[i], goldRef)) return i + 1;
  }
  return null;
}

function matchesGold(candidate: string, gold: string): boolean {
  if (candidate === gold) return true;
  if (candidate.endsWith(`//${gold}`)) return true;
  if (candidate.startsWith(`${gold}/`)) return true;
  return false;
}

/**
 * Aggregate gold-rank records across all akm-arm runs in the corpus.
 *
 * The function operates on `report.goldRankRecords`, which the runner
 * populates per (task, arm, seed). When the corpus has no gold-ref tasks
 * at all (every record list is empty), every metric collapses to a zero
 * envelope and the `passRateByRank` table is empty — the renderer turns
 * that into a single "(N/A)" sentence.
 */
export function computeSearchBridge(report: { goldRankRecords?: GoldRankRunRecord[] }): SearchBridgeMetrics {
  const records = report.goldRankRecords ?? [];

  // Histogram + percentile inputs across every search.
  const histogram: GoldRankHistogram = emptyHistogram();
  const allRanks: Array<number | null> = [];
  let totalSearches = 0;

  for (const rec of records) {
    for (const ev of rec.searches) {
      totalSearches += 1;
      allRanks.push(ev.rankOfGold);
      const bucket = ev.rankOfGold === null ? "missing" : String(ev.rankOfGold);
      histogram[bucket] = (histogram[bucket] ?? 0) + 1;
    }
  }

  const goldAtRank1 = totalSearches === 0 ? 0 : (histogram["1"] ?? 0) / totalSearches;
  const goldMissing = totalSearches === 0 ? 0 : (histogram.missing ?? 0) / totalSearches;
  const goldRankP50 = totalSearches === 0 ? null : percentile(allRanks, 50);
  const goldRankP90 = totalSearches === 0 ? null : percentile(allRanks, 90);

  // pass_rate_by_rank — split runs by the rank in *the search the agent
  // actually ran*. We use the last `akm search` of the run (or "missing"
  // when no search at all happened, or "missing" when the agent searched
  // but gold wasn't in the top 10 in that final search). Runs without any
  // `akm search` invocation are dropped from this slice — `pass_rate_by_rank`
  // only describes what happened given a search.
  const passRateBuckets = new Map<string, { passes: number; total: number }>();
  for (const rec of records) {
    if (rec.searches.length === 0) continue;
    const chosen = rec.searches[rec.searches.length - 1];
    const bucket = chosen.rankOfGold === null ? "missing" : String(chosen.rankOfGold);
    const slot = passRateBuckets.get(bucket) ?? { passes: 0, total: 0 };
    slot.total += 1;
    if (rec.outcome === "pass") slot.passes += 1;
    passRateBuckets.set(bucket, slot);
  }

  const passRateByRank: PassRateByRankEntry[] = [];
  for (const rank of histogramKeys()) {
    const slot = passRateBuckets.get(rank);
    if (!slot) continue;
    passRateByRank.push({
      rank,
      passRate: slot.total === 0 ? 0 : slot.passes / slot.total,
      runCount: slot.total,
    });
  }

  return {
    goldRankDistribution: histogram,
    goldRankP50,
    goldRankP90,
    goldAtRank1,
    goldMissing,
    passRateByRank,
    runsObserved: records.length,
    searchesObserved: totalSearches,
  };
}

/** Ordered keys used for both the histogram and the pass_rate_by_rank table. */
export function histogramKeys(): string[] {
  return ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "missing"];
}

function emptyHistogram(): GoldRankHistogram {
  const out: GoldRankHistogram = {};
  for (const k of histogramKeys()) out[k] = 0;
  return out;
}

/**
 * Linear-interpolated percentile over a list of ranks. `null` ranks are
 * treated as `Infinity` so the missing bucket pushes percentiles up
 * correctly. Returns `Infinity` when the percentile lands in the missing
 * region; the renderer surfaces that as the literal `"missing"` token so
 * downstream JSON consumers don't choke on `Infinity`.
 */
function percentile(ranks: Array<number | null>, p: number): number {
  if (ranks.length === 0) return Number.NaN;
  const sorted = ranks.map((r) => (r === null ? Number.POSITIVE_INFINITY : r)).sort((a, b) => a - b);
  // Nearest-rank method (avoids interpolation between Infinity and a finite).
  // index = ceil(p/100 * N) - 1, clamped to [0, N-1].
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

// ── Proposal-quality metrics (§6.3) ────────────────────────────────────────

/**
 * One proposal-lifecycle entry recorded by the evolve runner. The runner
 * collects these as it walks the queue produced by `akm distill` and `akm
 * reflect`. Each event captures the proposal id, its source asset ref, the
 * proposal kind (lesson vs revision), the lint outcome, and whether it was
 * accepted or rejected.
 */
export interface ProposalLogEntry {
  proposalId: string;
  /** Asset ref the proposal targets (the ref passed to distill/reflect). */
  assetRef: string;
  kind: "lesson" | "revision" | "unknown";
  /** Whether `akm proposal show --json` reported `lint_pass: true`. */
  lintPass: boolean;
  /** Terminal state. `accept` if the runner ran `proposal accept`; `reject` otherwise. */
  decision: "accept" | "reject";
  /** Reason recorded on rejection (lint failure detail, etc.). Empty on accept. */
  rejectReason?: string;
}

/** Per-asset row in the proposal-quality table (§6.3). */
export interface ProposalQualityRow {
  assetRef: string;
  proposalCount: number;
  lintPassCount: number;
  acceptedCount: number;
}

/** Aggregate proposal-quality metrics (§6.3). */
export interface ProposalQualityMetrics {
  rows: ProposalQualityRow[];
  totalProposals: number;
  totalAccepted: number;
  /** `accepted / proposals`. `0` when there are no proposals. */
  acceptanceRate: number;
  /** `lint_pass / proposals`. `0` when there are no proposals. */
  lintPassRate: number;
}

/**
 * Aggregate proposal-quality metrics from the evolve runner's proposal log.
 * Pure function — does not touch disk and does not invoke any subprocess.
 */
export function computeProposalQualityMetrics(proposalLog: ProposalLogEntry[]): ProposalQualityMetrics {
  const byRef = new Map<string, ProposalQualityRow>();
  let totalAccepted = 0;
  let totalLintPass = 0;
  for (const entry of proposalLog) {
    let row = byRef.get(entry.assetRef);
    if (!row) {
      row = { assetRef: entry.assetRef, proposalCount: 0, lintPassCount: 0, acceptedCount: 0 };
      byRef.set(entry.assetRef, row);
    }
    row.proposalCount += 1;
    if (entry.lintPass) {
      row.lintPassCount += 1;
      totalLintPass += 1;
    }
    if (entry.decision === "accept") {
      row.acceptedCount += 1;
      totalAccepted += 1;
    }
  }
  const rows = [...byRef.values()].sort((a, b) => a.assetRef.localeCompare(b.assetRef));
  const totalProposals = proposalLog.length;
  return {
    rows,
    totalProposals,
    totalAccepted,
    acceptanceRate: totalProposals === 0 ? 0 : totalAccepted / totalProposals,
    lintPassRate: totalProposals === 0 ? 0 : totalLintPass / totalProposals,
  };
}

// ── Longitudinal metrics (§6.4) ────────────────────────────────────────────

/** Per-task longitudinal degradation row. */
export interface DegradationRow {
  taskId: string;
  prePassRate: number;
  postPassRate: number;
  delta: number;
  /** Failure-mode label for the post arm if the task failed (for §6.6 cross-link). */
  failureMode: FailureMode | null;
}

/** Longitudinal metrics envelope (§6.4). */
export interface LongitudinalMetrics {
  /** `pass_rate(post) - pass_rate(pre)`, akm arm of each report. */
  improvementSlope: number;
  /** `pass_rate(post) - pass_rate(synthetic)`. */
  overSyntheticLift: number;
  /**
   * Number of eval tasks where pass_rate(post) < pass_rate(pre) by more than
   * 1 seed (i.e. `pre - post > 1 / seedsPerArm`). Lists the offending tasks
   * with their post-arm failureMode label.
   */
  degradationCount: number;
  degradations: DegradationRow[];
  /** Echo of the pre / post / synthetic akm pass rates for the report header. */
  prePassRate: number;
  postPassRate: number;
  syntheticPassRate: number;
}

/**
 * Compute longitudinal metrics from three §13.3 utility-shaped reports. Each
 * input report is expected to share the same eval-slice corpus, with one arm
 * driving the akm side: `pre` = pre-evolve stash, `post` = evolved stash,
 * `synthetic` = no-stash scratchpad arm.
 *
 * The "arm" we read off each report is `aggregateAkm.passRate` — the runners
 * produce the akm arm for all three (synthetic is just the akm arm with a
 * stripped stashDir; pre/post differ by stash content). `seedsPerArm` for
 * the degradation threshold is taken from the post report's corpus envelope.
 */
export function computeLongitudinalMetrics(
  preReport: UtilityRunReport,
  postReport: UtilityRunReport,
  syntheticReport: UtilityRunReport,
): LongitudinalMetrics {
  const prePassRate = preReport.aggregateAkm.passRate;
  const postPassRate = postReport.aggregateAkm.passRate;
  const syntheticPassRate = syntheticReport.aggregateAkm.passRate;

  const seedsPerArm = Math.max(1, postReport.corpus.seedsPerArm);
  const oneSeedFraction = 1 / seedsPerArm;

  // Per-task degradation: outer-join pre and post on task id.
  const preTasks = new Map<string, UtilityRunReport["tasks"][number]>();
  for (const t of preReport.tasks) preTasks.set(t.id, t);
  const postTasks = new Map<string, UtilityRunReport["tasks"][number]>();
  for (const t of postReport.tasks) postTasks.set(t.id, t);

  // Index post failure-mode labels by task id (one mode per task — first
  // failed run wins; matches the §6.6 by-task aggregate's natural ordering).
  const postFailureByTask: Record<string, FailureMode | undefined> = {};
  const postFailureByTaskMap = postReport.failureModes?.byTask ?? {};
  for (const [taskId, byMode] of Object.entries(postFailureByTaskMap)) {
    const labels = Object.keys(byMode) as FailureMode[];
    if (labels.length > 0) postFailureByTask[taskId] = labels[0];
  }

  const degradations: DegradationRow[] = [];
  const allIds = new Set<string>();
  for (const id of preTasks.keys()) allIds.add(id);
  for (const id of postTasks.keys()) allIds.add(id);
  for (const id of [...allIds].sort()) {
    const pre = preTasks.get(id);
    const post = postTasks.get(id);
    if (!pre || !post) continue;
    const preRate = pre.akm.passRate;
    const postRate = post.akm.passRate;
    const dropped = preRate - postRate;
    if (dropped > oneSeedFraction) {
      degradations.push({
        taskId: id,
        prePassRate: preRate,
        postPassRate: postRate,
        delta: postRate - preRate,
        failureMode: postFailureByTask[id] ?? null,
      });
    }
  }

  return {
    improvementSlope: postPassRate - prePassRate,
    overSyntheticLift: postPassRate - syntheticPassRate,
    degradationCount: degradations.length,
    degradations,
    prePassRate,
    postPassRate,
    syntheticPassRate,
  };
}

// ── Feedback-signal integrity (§6.8) ───────────────────────────────────────

/**
 * Per-asset 2×2 confusion matrix row.
 *
 * `feedback_agreement`, `false_positive_rate`, and `false_negative_rate`
 * are `null` (NaN-safe sentinel) when the relevant denominator is 0 — i.e.
 * an asset with zero feedback events emits all rates as `null`, never `0`
 * or `NaN`.
 */
export interface FeedbackIntegrityPerAssetRow {
  ref: string;
  /** Feedback `+`, run passed. */
  truePositive: number;
  /** Feedback `+`, run failed (agent was wrong). */
  falsePositive: number;
  /** Feedback `−`, run failed. */
  trueNegative: number;
  /** Feedback `−`, run passed. */
  falseNegative: number;
  /** `(TP+TN) / total`, or `null` when no feedback events. */
  feedback_agreement: number | null;
  /** `FP / (FP+TN)`, or `null` when `FP+TN === 0`. */
  false_positive_rate: number | null;
  /** `FN / (FN+TP)`, or `null` when `FN+TP === 0`. */
  false_negative_rate: number | null;
}

/**
 * Aggregate confusion-matrix envelope. The aggregate fields use the same
 * NaN-safe rules as per-asset, except `feedback_coverage` which is always
 * a finite number in `[0, 1]` (denominator is total Phase 1 runs; a
 * caller with zero runs gets `0`).
 */
export interface FeedbackIntegrityAggregate {
  truePositive: number;
  falsePositive: number;
  trueNegative: number;
  falseNegative: number;
  feedback_agreement: number;
  false_positive_rate: number;
  false_negative_rate: number;
  /** (Phase-1 runs with any feedback dispatched) / (total Phase 1 runs). */
  feedback_coverage: number;
}

/** §6.8 envelope: aggregate matrix + per-asset breakdown. */
export interface FeedbackIntegrityMetrics {
  aggregate: FeedbackIntegrityAggregate;
  perAsset: FeedbackIntegrityPerAssetRow[];
}

/**
 * Inputs to `computeFeedbackIntegrity`.
 *
 * `phase1` is the Phase 1 utility report (akm arm, train slice). Each
 * `phase1.akmRuns[i]` carries `taskId`, `seed`, and `outcome`. The bench's
 * Phase 1 dispatches at most one feedback event per run (positive on pass,
 * negative on fail; harness_error runs are skipped). `feedbackLog[i]` is
 * the dispatched record carrying `taskId`, `seed`, `goldRef`, and the
 * dispatched `signal`.
 *
 * Attribution rule (§6.8): each `feedbackLog` entry is joined to the run
 * with the matching `(taskId, seed)`. The run's `outcome` (NOT the asset's
 * later state) decides the matrix cell. Runs whose feedback failed to
 * dispatch (`feedbackLog[i].ok === false`) are excluded from the matrix
 * but still count toward `feedback_coverage` denominators only when they
 * appear in `phase1.akmRuns`. Specifically, a feedback event that the
 * runner *attempted* to dispatch counts against `feedback_coverage` — but
 * if it failed (ok=false) it is not labelled into TP/FP/TN/FN. This
 * mirrors how the runner treats the dispatch as best-effort.
 */
export interface FeedbackIntegrityInput {
  /**
   * Phase 1 utility report. Only `akmRuns` is consulted (each carries
   * `taskId`, `seed`, `outcome`).
   */
  phase1: { akmRuns?: RunResult[] };
  /**
   * Phase 1 feedback dispatch log produced by the runner. Each entry
   * carries `taskId`, `seed`, `goldRef`, the dispatched `signal`, and a
   * boolean `ok` (true iff the akm CLI exited 0).
   */
  feedbackLog: Array<{
    taskId: string;
    seed: number;
    goldRef: string;
    signal: "positive" | "negative";
    ok: boolean;
  }>;
}

/**
 * Compute the §6.8 feedback-signal integrity confusion matrix.
 *
 * Pure function — does not touch disk and does not invoke any subprocess.
 * The join is by `(taskId, seed)` so that a feedback event is attributed
 * to the run that produced it, NOT to a later run that happens to touch
 * the same gold ref. This matters when the same gold ref appears across
 * multiple Phase 1 runs (e.g. multiple seeds, or two tasks sharing a
 * skill); the per-asset row aggregates across all runs that referenced it
 * in feedback, but each individual feedback event's matrix cell is
 * decided by its own run's outcome.
 *
 * NaN-safety: a per-asset row with zero feedback events (cannot happen via
 * this function — every row is derived from at least one feedback entry —
 * but defensive against future callers passing curated subsets) emits all
 * three rates as `null`. `false_positive_rate` is `null` when `FP+TN===0`
 * even if the row has `FN+TP>0`, and vice versa.
 */
export function computeFeedbackIntegrity(input: FeedbackIntegrityInput): FeedbackIntegrityMetrics {
  const akmRuns = input.phase1.akmRuns ?? [];
  // Build a (taskId, seed) → outcome lookup so every feedback event
  // resolves in O(1). When two runs share the same key (shouldn't happen
  // — runner emits unique seeds per task — but defensive) the first
  // wins.
  const runOutcomeByKey = new Map<string, RunResult["outcome"]>();
  for (const r of akmRuns) {
    const key = `${r.taskId}::${r.seed}`;
    if (!runOutcomeByKey.has(key)) runOutcomeByKey.set(key, r.outcome);
  }

  // Per-asset accumulator. We key on goldRef.
  interface AssetCounts {
    truePositive: number;
    falsePositive: number;
    trueNegative: number;
    falseNegative: number;
  }
  const perRef = new Map<string, AssetCounts>();
  let aggTP = 0;
  let aggFP = 0;
  let aggTN = 0;
  let aggFN = 0;

  // Track which (taskId, seed) keys had any feedback dispatched (ok or
  // not), for the coverage denominator. We count an attempted dispatch as
  // covered — if `ok===false`, the operator wanted feedback but the CLI
  // failed; that's still a covered run for the purpose of §6.8 (and is
  // surfaced in the warnings list elsewhere).
  const coveredKeys = new Set<string>();

  for (const fb of input.feedbackLog) {
    const key = `${fb.taskId}::${fb.seed}`;
    coveredKeys.add(key);
    if (!fb.ok) continue; // failed dispatches don't label a matrix cell.
    const outcome = runOutcomeByKey.get(key);
    if (outcome === undefined) continue; // run not found — defensive, drop.
    // harness_error runs are not labelled (the bench skips dispatching
    // feedback for them; if a fake test injects one, we drop it from the
    // matrix to avoid mislabelling).
    if (outcome === "harness_error") continue;
    const passed = outcome === "pass";

    let row = perRef.get(fb.goldRef);
    if (!row) {
      row = { truePositive: 0, falsePositive: 0, trueNegative: 0, falseNegative: 0 };
      perRef.set(fb.goldRef, row);
    }
    if (fb.signal === "positive" && passed) {
      row.truePositive += 1;
      aggTP += 1;
    } else if (fb.signal === "positive" && !passed) {
      row.falsePositive += 1;
      aggFP += 1;
    } else if (fb.signal === "negative" && !passed) {
      row.trueNegative += 1;
      aggTN += 1;
    } else if (fb.signal === "negative" && passed) {
      row.falseNegative += 1;
      aggFN += 1;
    }
  }

  const aggTotal = aggTP + aggFP + aggTN + aggFN;
  const totalPhase1Runs = akmRuns.length;

  const aggregate: FeedbackIntegrityAggregate = {
    truePositive: aggTP,
    falsePositive: aggFP,
    trueNegative: aggTN,
    falseNegative: aggFN,
    feedback_agreement: aggTotal === 0 ? 0 : (aggTP + aggTN) / aggTotal,
    false_positive_rate: aggFP + aggTN === 0 ? 0 : aggFP / (aggFP + aggTN),
    false_negative_rate: aggFN + aggTP === 0 ? 0 : aggFN / (aggFN + aggTP),
    feedback_coverage: totalPhase1Runs === 0 ? 0 : coveredKeys.size / totalPhase1Runs,
  };

  const perAsset: FeedbackIntegrityPerAssetRow[] = [];
  for (const [ref, row] of [...perRef.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const total = row.truePositive + row.falsePositive + row.trueNegative + row.falseNegative;
    const fpDenom = row.falsePositive + row.trueNegative;
    const fnDenom = row.falseNegative + row.truePositive;
    perAsset.push({
      ref,
      truePositive: row.truePositive,
      falsePositive: row.falsePositive,
      trueNegative: row.trueNegative,
      falseNegative: row.falseNegative,
      feedback_agreement: total === 0 ? null : (row.truePositive + row.trueNegative) / total,
      false_positive_rate: fpDenom === 0 ? null : row.falsePositive / fpDenom,
      false_negative_rate: fnDenom === 0 ? null : row.falseNegative / fnDenom,
    });
  }

  return { aggregate, perAsset };
}

// ── Memory-operation tag aggregations (#262) ───────────────────────────────

/**
 * One per-task entry as consumed by `aggregateByMemoryAbility` /
 * `aggregateByTaskFamily`. Mirrors the runner's per-task envelope plus the
 * bag of optional memory-operation tags from `task.yaml`. Tasks may carry
 * arbitrary subsets of tags — aggregations skip rows where the keying tag
 * is undefined.
 */
export interface PerTaskTagEntry {
  id: string;
  noakm: PerTaskMetrics;
  akm: PerTaskMetrics;
  /** Optional memory-operation ability tag (#262). */
  memoryAbility?: MemoryAbility;
  /** Optional cross-task family identifier (#262). */
  taskFamily?: string;
  /** Optional declarative-workflow focus tag (#255 / #262). */
  workflowFocus?: string;
  /**
   * Optional workflow-compliance fraction `[0, 1]` for the akm arm. When
   * undefined the row is skipped from the workflow-compliance mean for the
   * group. The runner populates this from #255's per-task workflow trace.
   */
  workflowCompliance?: number;
}

/**
 * Per-category aggregate emitted by `aggregateByMemoryAbility` and
 * `aggregateByTaskFamily`. Each row carries:
 * - `taskCount`: number of tasks that fell into this category.
 * - `passRateNoakm` / `passRateAkm`: mean pass rate per arm.
 * - `passRateDelta`: `akm - noakm`. Positive = akm helped this category.
 * - `negativeTransferCount`: count of tasks where akm pass rate regressed.
 * - `workflowCompliance`: mean of `workflowCompliance` over rows where it
 *   was supplied; `null` when no rows in the category provided one.
 */
export interface CategoryAggregateRow {
  category: string;
  taskCount: number;
  passRateNoakm: number;
  passRateAkm: number;
  passRateDelta: number;
  negativeTransferCount: number;
  workflowCompliance: number | null;
}

function aggregateByKey(
  entries: ReadonlyArray<PerTaskTagEntry>,
  pickKey: (e: PerTaskTagEntry) => string | undefined,
): CategoryAggregateRow[] {
  const buckets = new Map<string, PerTaskTagEntry[]>();
  for (const entry of entries) {
    const key = pickKey(entry);
    if (!key) continue;
    let arr = buckets.get(key);
    if (!arr) {
      arr = [];
      buckets.set(key, arr);
    }
    arr.push(entry);
  }
  const rows: CategoryAggregateRow[] = [];
  for (const [category, group] of buckets) {
    const n = group.length;
    let noakmSum = 0;
    let akmSum = 0;
    let regressionCount = 0;
    let complianceSum = 0;
    let complianceCount = 0;
    for (const t of group) {
      noakmSum += t.noakm.passRate;
      akmSum += t.akm.passRate;
      if (t.akm.passRate < t.noakm.passRate) regressionCount += 1;
      if (typeof t.workflowCompliance === "number" && Number.isFinite(t.workflowCompliance)) {
        complianceSum += t.workflowCompliance;
        complianceCount += 1;
      }
    }
    rows.push({
      category,
      taskCount: n,
      passRateNoakm: noakmSum / n,
      passRateAkm: akmSum / n,
      passRateDelta: akmSum / n - noakmSum / n,
      negativeTransferCount: regressionCount,
      workflowCompliance: complianceCount === 0 ? null : complianceSum / complianceCount,
    });
  }
  rows.sort((a, b) => a.category.localeCompare(b.category));
  return rows;
}

/**
 * Aggregate per-task entries by `memoryAbility` (#262). Tasks lacking a tag
 * are skipped so the report only surfaces categories with explicit
 * coverage. Output rows are sorted by category for byte-stable JSON.
 *
 * The closed set of memory-ability values is exported as
 * {@link MEMORY_ABILITY_VALUES} from `corpus.ts`.
 */
export function aggregateByMemoryAbility(entries: ReadonlyArray<PerTaskTagEntry>): CategoryAggregateRow[] {
  return aggregateByKey(entries, (e) => e.memoryAbility);
}

/**
 * Aggregate per-task entries by `taskFamily` (#262). Tasks lacking a tag
 * are skipped. `taskFamily` follows the `<domain>/<short-name>` grammar —
 * tasks sharing a family are expected to transfer knowledge between each
 * other. Output rows are sorted by category for byte-stable JSON.
 */
export function aggregateByTaskFamily(entries: ReadonlyArray<PerTaskTagEntry>): CategoryAggregateRow[] {
  return aggregateByKey(entries, (e) => e.taskFamily);
}

/**
 * Build the corpus-coverage block for the §13.3 utility report (#262).
 *
 * Returns:
 * - `memoryAbilityCounts`: count of tagged tasks per memory-ability label
 *   across every value in {@link MEMORY_ABILITY_VALUES}. Untagged tasks are
 *   summed into `untagged`. Missing categories render as 0 — operators want
 *   to know which abilities the corpus does NOT cover.
 * - `taskFamilyCounts`: count of tagged tasks per family. Untagged tasks
 *   summed into `untagged`. Sorted for stable JSON output.
 * - `totalTasks`: total tasks supplied to the aggregator.
 */
export interface CorpusCoverage {
  totalTasks: number;
  memoryAbilityCounts: Record<MemoryAbility | "untagged", number>;
  taskFamilyCounts: Record<string, number>;
}

export function computeCorpusCoverage(
  tasks: ReadonlyArray<Pick<TaskMetadata, "memoryAbility" | "taskFamily">>,
): CorpusCoverage {
  const memoryAbilityCounts = {
    untagged: 0,
  } as Record<MemoryAbility | "untagged", number>;
  for (const ability of MEMORY_ABILITY_VALUES) {
    memoryAbilityCounts[ability] = 0;
  }
  const taskFamilyCounts: Record<string, number> = {};
  let untaggedFamily = 0;
  for (const task of tasks) {
    if (task.memoryAbility) {
      memoryAbilityCounts[task.memoryAbility] = (memoryAbilityCounts[task.memoryAbility] ?? 0) + 1;
    } else {
      memoryAbilityCounts.untagged += 1;
    }
    if (task.taskFamily) {
      taskFamilyCounts[task.taskFamily] = (taskFamilyCounts[task.taskFamily] ?? 0) + 1;
    } else {
      untaggedFamily += 1;
    }
  }
  if (untaggedFamily > 0) taskFamilyCounts.untagged = untaggedFamily;
  return {
    totalTasks: tasks.length,
    memoryAbilityCounts,
    taskFamilyCounts,
  };
}

// ── AKM overhead + tool-use efficiency (#263) ──────────────────────────────

/**
 * Per-run AKM overhead record (#263).
 *
 * Counts and timings derived from a single RunResult by reusing #254's
 * `normalizeRunToTrace`. Counts are always numeric (≥ 0). Timings and byte
 * sizes are `null` when the run did not provide enough evidence to compute
 * them — they are NEVER zero-filled, because zero is a meaningful value
 * (e.g. "first search at t=0ms") that would silently mask missing data.
 *
 * Definitions:
 * - `searchCount` / `showCount` / `feedbackCount`: count of `akm_search`,
 *   `akm_show`, and `akm_feedback` events in the normalised trace.
 * - `totalToolCalls`: sum of the three counts above. The minimal
 *   "AKM tool-use" footprint we surface today; if/when we recognise more
 *   verbs as tool-calls (`akm_reflect`, `akm_distill`, `akm_propose`,
 *   `akm_proposal_accept`) they will be folded in here additively.
 * - `assetsLoadedCount`: count of UNIQUE assetRefs from `akm_show` events.
 * - `irrelevantAssetsLoadedCount`: count of unique `akm_show` assetRefs that
 *   are NOT the task's `goldRef` AND NOT in `expectedTransferFrom`. When the
 *   task has neither metadata field, every loaded asset is considered
 *   irrelevant for accounting — there is no way to know what was relevant.
 *   When the task is unknown to the caller (no metadata supplied) the count
 *   is `null` rather than zero, since we cannot judge relevance.
 * - `timeToFirstSearchMs`: `(ts of first akm_search) - (run start ts)`. Run
 *   start is the earliest parseable `ts` in the trace. `null` when no
 *   `akm_search` event has a parseable ts, or when no run-start anchor
 *   exists.
 * - `timeToFirstCorrectAssetMs`: `(ts of first akm_show whose assetRef
 *   matches goldRef) - (run start ts)`. `null` when the task has no
 *   `goldRef`, no matching show event was found, or timestamps are missing.
 * - `contextBytesLoaded` / `assetBytesLoaded`: byte sizes of context /
 *   loaded assets. Not currently captured by the trace; always `null` until
 *   evidence is wired through. Documented here as a contract: callers MUST
 *   treat `null` as "unavailable" and never assume zero.
 */
export interface AkmOverheadPerRun {
  taskId: string;
  arm: string;
  seed: number;
  outcome: RunResult["outcome"];
  searchCount: number;
  showCount: number;
  feedbackCount: number;
  totalToolCalls: number;
  assetsLoadedCount: number;
  /** `null` when relevance cannot be judged (no task metadata supplied). */
  irrelevantAssetsLoadedCount: number | null;
  /** ms; `null` when unavailable (NOT zero). */
  timeToFirstSearchMs: number | null;
  /** ms; `null` when unavailable (NOT zero). */
  timeToFirstCorrectAssetMs: number | null;
  /** Bytes; `null` when unavailable (NOT zero). */
  contextBytesLoaded: number | null;
  /** Bytes; `null` when unavailable (NOT zero). */
  assetBytesLoaded: number | null;
}

/**
 * Aggregate AKM overhead block emitted into the §13.3 utility envelope (#263).
 *
 * `meanAssetsLoaded` etc. are means over `runs.length` (not "runs that loaded
 * something"); zero-call runs contribute zeros to the numerator. This keeps
 * the aggregate comparable across arms regardless of how many runs actually
 * touched AKM.
 *
 * Cross-run timings (`meanTimeToFirstSearchMs`, etc.) skip per-run `null`s
 * — a missing timing must not silently pull the mean toward zero. When NO
 * run provided a timing the aggregate value is `null`.
 *
 * `toolCallsPerSuccess` = `totalToolCalls / passingRuns`. `null` when no
 * runs passed (avoids `Infinity`). `costPerSuccess` is `null` unless every
 * passing run has parsed token measurement — partial coverage yields
 * `null` because mixed measurement statuses cannot be averaged honestly.
 */
export interface AkmOverheadAggregate {
  totalRuns: number;
  passingRuns: number;
  meanSearchCount: number;
  meanShowCount: number;
  meanFeedbackCount: number;
  meanToolCalls: number;
  meanAssetsLoaded: number;
  meanIrrelevantAssetsLoaded: number | null;
  meanTimeToFirstSearchMs: number | null;
  meanTimeToFirstCorrectAssetMs: number | null;
  meanContextBytesLoaded: number | null;
  meanAssetBytesLoaded: number | null;
  /** `totalToolCalls` summed across runs. */
  totalToolCalls: number;
  /** `totalToolCalls / passingRuns`. `null` when `passingRuns === 0`. */
  toolCallsPerSuccess: number | null;
  /**
   * Mean (input+output) tokens across passing runs whose `tokenMeasurement`
   * is `"parsed"`. `null` when:
   * - `passingRuns === 0`, OR
   * - any passing run lacks parsed token measurement (mixing parsed with
   *   missing/unsupported is dishonest), OR
   * - none of the passing runs has `tokenMeasurement === "parsed"`.
   */
  costPerSuccess: number | null;
}

/**
 * Optional inputs for `computeAkmOverhead`.
 *
 * `taskMetadata` is consulted to compute `irrelevantAssetsLoadedCount` and
 * `timeToFirstCorrectAssetMs`. Callers that do not have task metadata to
 * hand can omit it; the per-run record will degrade gracefully (relevant
 * fields become `null`). The map is keyed by `taskId`.
 */
export interface AkmOverheadOptions {
  /** Lookup of task metadata used for relevance / gold-ref scoring. */
  taskMetadata?: ReadonlyMap<string, Pick<TaskMetadata, "goldRef" | "expectedTransferFrom">>;
}

/**
 * Verb counts considered "AKM tool calls" for `totalToolCalls`. We
 * deliberately keep this list small — each verb folded in MUST be a
 * user-initiated CLI invocation, not a background bookkeeping event.
 * Adding new verbs here is additive and changes only `totalToolCalls`.
 */
export const AKM_TOOL_CALL_TYPES: ReadonlySet<WorkflowTraceEventType> = new Set<WorkflowTraceEventType>([
  "akm_search",
  "akm_show",
  "akm_feedback",
]);

/**
 * Compute per-run AKM overhead records by replaying #254's normalised trace.
 *
 * Pure function: never mutates `runs` and never reads disk. The optional
 * `taskMetadata` lookup is used only to label loads as relevant / irrelevant
 * and to compute `timeToFirstCorrectAssetMs`.
 *
 * Returned array length matches `runs.length`; element order matches input
 * order. Runs whose trace contains no AKM events still produce a record
 * with all counts at zero and timings at `null`.
 */
export function computeAkmOverhead(
  runs: ReadonlyArray<RunResult>,
  options: AkmOverheadOptions = {},
): AkmOverheadPerRun[] {
  const out: AkmOverheadPerRun[] = [];
  for (const run of runs) {
    out.push(perRun(run, options.taskMetadata));
  }
  return out;
}

function perRun(run: RunResult, taskMetadata: AkmOverheadOptions["taskMetadata"]): AkmOverheadPerRun {
  const trace = normalizeRunToTrace(run);
  const events = trace.events;

  let searchCount = 0;
  let showCount = 0;
  let feedbackCount = 0;
  const uniqueShowRefs = new Set<string>();

  for (const ev of events) {
    if (ev.type === "akm_search") searchCount += 1;
    else if (ev.type === "akm_show") {
      showCount += 1;
      if (typeof ev.assetRef === "string" && ev.assetRef.length > 0) {
        uniqueShowRefs.add(ev.assetRef);
      }
    } else if (ev.type === "akm_feedback") feedbackCount += 1;
  }
  const totalToolCalls = searchCount + showCount + feedbackCount;

  // Run-start anchor: earliest parseable ts in the trace. We use the trace
  // (not RunResult.events directly) so harness lifecycle markers, when
  // supplied, can serve as the anchor for stdout-derived events that lack a
  // native ts.
  const runStartMs = earliestEventMs(events);

  const timeToFirstSearchMs = computeFirstEventOffsetMs(events, runStartMs, (ev) => ev.type === "akm_search");

  // Resolve task metadata once. Missing metadata means we can't judge
  // relevance — emit null counts rather than zero.
  const meta = taskMetadata?.get(run.taskId);
  const goldRef = meta?.goldRef;
  const transferFrom = meta?.expectedTransferFrom ?? [];
  const knownRelevant = new Set<string>();
  if (typeof goldRef === "string" && goldRef.length > 0) knownRelevant.add(goldRef);
  for (const r of transferFrom) {
    if (typeof r === "string" && r.length > 0) knownRelevant.add(r);
  }

  let irrelevantAssetsLoadedCount: number | null;
  if (!meta) {
    // No metadata: cannot tell relevant from irrelevant. Surface null.
    irrelevantAssetsLoadedCount = null;
  } else {
    let count = 0;
    for (const ref of uniqueShowRefs) {
      if (!knownRelevant.has(ref)) count += 1;
    }
    irrelevantAssetsLoadedCount = count;
  }

  let timeToFirstCorrectAssetMs: number | null = null;
  if (typeof goldRef === "string" && goldRef.length > 0) {
    timeToFirstCorrectAssetMs = computeFirstEventOffsetMs(
      events,
      runStartMs,
      (ev) => ev.type === "akm_show" && ev.assetRef === goldRef,
    );
  }

  return {
    taskId: run.taskId,
    arm: run.arm,
    seed: run.seed,
    outcome: run.outcome,
    searchCount,
    showCount,
    feedbackCount,
    totalToolCalls,
    assetsLoadedCount: uniqueShowRefs.size,
    irrelevantAssetsLoadedCount,
    timeToFirstSearchMs,
    timeToFirstCorrectAssetMs,
    // Byte sizes are not yet wired through the trace (#254 does not capture
    // payload sizes). Callers MUST treat null as "unavailable", not zero.
    contextBytesLoaded: null,
    assetBytesLoaded: null,
  };
}

/**
 * Aggregate per-run AKM overhead records into the corpus-wide block (#263).
 *
 * Pure: never mutates `perRun`. When `perRun` is empty, returns a zero/null
 * envelope so callers can render a "no AKM activity" section without
 * branching. `passingRuns === 0` always implies `toolCallsPerSuccess === null`
 * and `costPerSuccess === null`.
 */
export function aggregateAkmOverhead(
  perRun: ReadonlyArray<AkmOverheadPerRun>,
  rawRuns: ReadonlyArray<RunResult> = [],
): AkmOverheadAggregate {
  const n = perRun.length;
  if (n === 0) {
    return {
      totalRuns: 0,
      passingRuns: 0,
      meanSearchCount: 0,
      meanShowCount: 0,
      meanFeedbackCount: 0,
      meanToolCalls: 0,
      meanAssetsLoaded: 0,
      meanIrrelevantAssetsLoaded: null,
      meanTimeToFirstSearchMs: null,
      meanTimeToFirstCorrectAssetMs: null,
      meanContextBytesLoaded: null,
      meanAssetBytesLoaded: null,
      totalToolCalls: 0,
      toolCallsPerSuccess: null,
      costPerSuccess: null,
    };
  }

  let searchSum = 0;
  let showSum = 0;
  let feedbackSum = 0;
  let toolCallsSum = 0;
  let assetsSum = 0;

  let irrelevantSum = 0;
  let irrelevantCount = 0;

  let firstSearchSum = 0;
  let firstSearchCount = 0;
  let firstCorrectSum = 0;
  let firstCorrectCount = 0;

  let contextBytesSum = 0;
  let contextBytesCount = 0;
  let assetBytesSum = 0;
  let assetBytesCount = 0;

  // Build a quick lookup for token measurement off `rawRuns` so the cost-
  // per-success calc can honour the parsed/missing/unsupported distinction
  // without forcing the caller to project tokens onto AkmOverheadPerRun.
  const rawByKey = new Map<string, RunResult>();
  for (const r of rawRuns) {
    rawByKey.set(`${r.taskId} ${r.arm} ${r.seed}`, r);
  }

  let passingRuns = 0;
  let parsedPassTokenSum = 0;
  let parsedPassCount = 0;
  let anyPassMissingMeasurement = false;

  for (const row of perRun) {
    searchSum += row.searchCount;
    showSum += row.showCount;
    feedbackSum += row.feedbackCount;
    toolCallsSum += row.totalToolCalls;
    assetsSum += row.assetsLoadedCount;

    if (row.irrelevantAssetsLoadedCount !== null) {
      irrelevantSum += row.irrelevantAssetsLoadedCount;
      irrelevantCount += 1;
    }
    if (row.timeToFirstSearchMs !== null) {
      firstSearchSum += row.timeToFirstSearchMs;
      firstSearchCount += 1;
    }
    if (row.timeToFirstCorrectAssetMs !== null) {
      firstCorrectSum += row.timeToFirstCorrectAssetMs;
      firstCorrectCount += 1;
    }
    if (row.contextBytesLoaded !== null) {
      contextBytesSum += row.contextBytesLoaded;
      contextBytesCount += 1;
    }
    if (row.assetBytesLoaded !== null) {
      assetBytesSum += row.assetBytesLoaded;
      assetBytesCount += 1;
    }

    if (row.outcome === "pass") {
      passingRuns += 1;
      const raw = rawByKey.get(`${row.taskId} ${row.arm} ${row.seed}`);
      // Treat absent tokenMeasurement as `parsed` for backward compat with
      // older artefacts (mirrors `isMeasured` behaviour above).
      const measurement = raw?.tokenMeasurement ?? "parsed";
      if (raw && measurement === "parsed") {
        parsedPassTokenSum += raw.tokens.input + raw.tokens.output;
        parsedPassCount += 1;
      } else if (raw) {
        anyPassMissingMeasurement = true;
      } else {
        // No matching raw run supplied — cannot honour cost-per-success.
        anyPassMissingMeasurement = true;
      }
    }
  }

  const toolCallsPerSuccess = passingRuns === 0 ? null : toolCallsSum / passingRuns;
  // Cost-per-success: null unless EVERY passing run has parsed measurement.
  // Mixed measurement statuses cannot be averaged honestly (issue #252).
  const costPerSuccess =
    passingRuns === 0 || anyPassMissingMeasurement || parsedPassCount === 0
      ? null
      : parsedPassTokenSum / parsedPassCount;

  return {
    totalRuns: n,
    passingRuns,
    meanSearchCount: searchSum / n,
    meanShowCount: showSum / n,
    meanFeedbackCount: feedbackSum / n,
    meanToolCalls: toolCallsSum / n,
    meanAssetsLoaded: assetsSum / n,
    meanIrrelevantAssetsLoaded: irrelevantCount === 0 ? null : irrelevantSum / irrelevantCount,
    meanTimeToFirstSearchMs: firstSearchCount === 0 ? null : firstSearchSum / firstSearchCount,
    meanTimeToFirstCorrectAssetMs: firstCorrectCount === 0 ? null : firstCorrectSum / firstCorrectCount,
    meanContextBytesLoaded: contextBytesCount === 0 ? null : contextBytesSum / contextBytesCount,
    meanAssetBytesLoaded: assetBytesCount === 0 ? null : assetBytesSum / assetBytesCount,
    totalToolCalls: toolCallsSum,
    toolCallsPerSuccess,
    costPerSuccess,
  };
}

/** Earliest parseable ts (ms epoch) among events; null when none. */
function earliestEventMs(events: ReadonlyArray<WorkflowTraceEvent>): number | null {
  let earliest: number | null = null;
  for (const ev of events) {
    const ms = parseTsToMs(ev.ts);
    if (ms === null) continue;
    if (earliest === null || ms < earliest) earliest = ms;
  }
  return earliest;
}

/**
 * Find the first event matching `predicate`, parse its ts, and return
 * `(ts - runStartMs)`. Returns `null` if no matching event has a parseable
 * ts, if `runStartMs` is null, or if the offset would be negative (a clock
 * inversion we refuse to silently coerce to zero).
 */
function computeFirstEventOffsetMs(
  events: ReadonlyArray<WorkflowTraceEvent>,
  runStartMs: number | null,
  predicate: (ev: WorkflowTraceEvent) => boolean,
): number | null {
  if (runStartMs === null) return null;
  for (const ev of events) {
    if (!predicate(ev)) continue;
    const ms = parseTsToMs(ev.ts);
    if (ms === null) continue;
    const offset = ms - runStartMs;
    if (offset < 0) return null;
    return offset;
  }
  return null;
}

/** Parse an ISO ts to ms-epoch; null when missing or unparseable. */
function parseTsToMs(ts: string | undefined): number | null {
  if (typeof ts !== "string" || ts.length === 0) return null;
  const ms = Date.parse(ts);
  if (Number.isNaN(ms)) return null;
  return ms;
}
