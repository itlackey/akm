/**
 * akm-bench metrics (spec §6).
 *
 * Outcome metrics (§6.1) and trajectory metrics (§6.2). Both are pure
 * functions over `RunResult[]` slices so the runner can compose them
 * however it likes. The §6.3+ catalog (proposal-quality, longitudinal,
 * attribution, failure-mode taxonomy) lands in #239/#240/#243.
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
  reason: "model_mismatch" | "hash_mismatch" | "schema_mismatch" | "track_mismatch";
  message: string;
  baseModel?: string;
  currentModel?: string;
  baseFixtureContentHash?: string | null;
  currentFixtureContentHash?: string | null;
  /** When `reason === "hash_mismatch"`, the affected fixtures (best-effort). */
  affectedFixtures?: string[];
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
export function compareReports(base: ParsedReportJson, current: ParsedReportJson): CompareResult {
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
  if (baseHash !== null && currentHash !== null && baseHash !== currentHash) {
    return {
      ok: false,
      reason: "hash_mismatch",
      message: `cannot compare across different fixture-content hashes: base="${baseHash}", current="${currentHash}". Rerun against matching fixtures.`,
      baseModel,
      currentModel,
      baseFixtureContentHash: baseHash,
      currentFixtureContentHash: currentHash,
    };
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
