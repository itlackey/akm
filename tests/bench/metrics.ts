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

import type { TaskMetadata } from "./corpus";
import type { RunResult } from "./driver";
import type { UtilityRunReport } from "./report";

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

// Suppress the unused warning for the constant exposed to keep the cap
// discoverable from this module's surface (mirrors the trajectory cap).
void ASSET_REF_PATTERN;

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

  for (const row of top) {
    const maskedTasks: TaskMetadata[] = [];
    const tmpDirs: string[] = [];
    try {
      for (const baseTask of baseReport.taskMetadata ?? []) {
        const maskedStashDir = materialiseMaskedStash(fixturesRoot, baseTask.stash, row.assetRef);
        if (maskedStashDir) tmpDirs.push(maskedStashDir);
        // Forward the masked stashDir as a sibling field. Tasks already carry
        // `stash` (the fixture name), so we tunnel the masked dir through
        // `taskDir` won't work — instead we mutate `stash` to point at the
        // tmp dir and rely on the runner's `materialiseStash` flow. The
        // injected runUtility for masked runs MUST honour `stashDirOverride`.
        maskedTasks.push({ ...baseTask, stash: maskedStashDir ?? baseTask.stash });
      }

      const maskedReport = await opts.runUtility({
        ...opts.baseOptions,
        tasks: maskedTasks,
        // The masked stash already has the correct content on disk, so we
        // skip the runner's own materialisation step (which would otherwise
        // try to look up the fixture by name).
        materialiseStash: false,
      });

      const maskedPassRate = maskedReport.aggregateAkm.passRate;
      attributions.push({
        assetRef: row.assetRef,
        basePassRate: baseAkmPassRate,
        maskedPassRate,
        marginalContribution: baseAkmPassRate - maskedPassRate,
      });
    } finally {
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
