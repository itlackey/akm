/**
 * akm-bench metrics (spec §6).
 *
 * Outcome metrics (§6.1) and trajectory metrics (§6.2). Both are pure
 * functions over `RunResult[]` slices so the runner can compose them
 * however it likes. The §6.3+ catalog (proposal-quality, longitudinal,
 * attribution, failure-mode taxonomy) lands in #239/#240/#243.
 *
 * Search-pipeline bridge metrics (§6.7) are below: they tie the synthetic
 * MRR/Recall@K view in `tests/benchmark-suite.ts` to real-task pass rate
 * by logging gold-rank-of-search per `akm search` invocation and slicing
 * pass-rate by the rank of the agent's *chosen* search.
 */

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
