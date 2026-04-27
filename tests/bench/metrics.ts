/**
 * akm-bench metrics (spec §6).
 *
 * Outcome metrics (§6.1) and trajectory metrics (§6.2). Both are pure
 * functions over `RunResult[]` slices so the runner can compose them
 * however it likes. The §6.3+ catalog (proposal-quality, longitudinal,
 * attribution, failure-mode taxonomy) lands in #239/#240/#243.
 *
 * The failure-mode taxonomy classifier (§6.6) lives at the bottom of
 * this file (`classifyFailureMode`).
 */

import type { TaskMetadata } from "./corpus";
import type { RunResult } from "./driver";

// ── Outcome (§6.1) ─────────────────────────────────────────────────────────

export interface OutcomeAggregate {
  /** Fraction of runs whose outcome is `pass`. Zero when results is empty. */
  passRate: number;
  /**
   * Mean total tokens across runs that passed; `0` when there are no passes
   * (avoids `Infinity` and `NaN` polluting downstream JSON).
   */
  tokensPerPass: number;
  /** Mean wallclock ms across all runs (not just passes). */
  wallclockMs: number;
  /** Number of runs whose outcome is `budget_exceeded`. */
  budgetExceeded: number;
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
    return { passRate: 0, tokensPerPass: 0, wallclockMs: 0, budgetExceeded: 0 };
  }
  let passes = 0;
  let budgetExceeded = 0;
  let totalTokensInPasses = 0;
  let totalWallclock = 0;
  for (const r of results) {
    totalWallclock += r.wallclockMs;
    if (r.outcome === "pass") {
      passes += 1;
      totalTokensInPasses += r.tokens.input + r.tokens.output;
    } else if (r.outcome === "budget_exceeded") {
      budgetExceeded += 1;
    }
  }
  return {
    passRate: passes / results.length,
    tokensPerPass: passes === 0 ? 0 : totalTokensInPasses / passes,
    wallclockMs: totalWallclock / results.length,
    budgetExceeded,
  };
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
  /** Mean total tokens in passing runs. `null` when 0 passes. */
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
    };
  }

  let passes = 0;
  let totalTokensInPasses = 0;
  let totalWallclock = 0;
  let budgetExceeded = 0;
  let harnessError = 0;
  // For the standard deviation we need a fixed-iteration buffer of pass/fail.
  const passSamples: number[] = [];
  for (const r of results) {
    totalWallclock += r.wallclockMs;
    const isPass = r.outcome === "pass" ? 1 : 0;
    passSamples.push(isPass);
    if (isPass === 1) {
      passes += 1;
      totalTokensInPasses += r.tokens.input + r.tokens.output;
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
    tokensPerPass: passes === 0 ? null : totalTokensInPasses / passes,
    wallclockMs: totalWallclock / results.length,
    passRateStdev: stdev(passSamples),
    budgetExceededCount: budgetExceeded,
    harnessErrorCount: harnessError,
    count: results.length,
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
