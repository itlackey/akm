/**
 * akm-bench metrics (spec §6).
 *
 * Outcome metrics (§6.1) and trajectory metrics (§6.2). Both are pure
 * functions over `RunResult[]` slices so the runner can compose them
 * however it likes. The §6.3+ catalog (proposal-quality, longitudinal,
 * attribution, failure-mode taxonomy) lands in #239/#240/#243.
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
