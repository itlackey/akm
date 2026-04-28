/**
 * akm-bench report rendering (spec §13.3).
 *
 * Two report flavours coexist:
 *
 *   • `renderJsonReport` / `renderMarkdownSummary` — the simple v1 envelope
 *     introduced in #236. Kept for backward-compat with the empty-corpus
 *     skeleton path; not used by the populated `utility` flow.
 *
 *   • `renderUtilityReport` — the §13.3 shape, including per-task breakdown,
 *     per-arm and corpus-wide aggregates, akm−noakm deltas, and the
 *     trajectory subsection. This is what `bench utility` writes when the
 *     corpus has tasks.
 */

import { execSync } from "node:child_process";
import type { TaskMetadata } from "./corpus";
import type { RunResult } from "./driver";
import type {
  CompareResult,
  CompareTaskRow,
  CorpusDelta,
  CorpusMetrics,
  DeltaSign,
  FailureMode,
  FailureModeAggregate,
  FeedbackIntegrityMetrics,
  GoldRankRunRecord,
  LongitudinalMetrics,
  OutcomeAggregate,
  PerAssetAttribution,
  PerTaskMetrics,
  ProposalQualityMetrics,
  SearchBridgeMetrics,
  TrajectoryAggregate,
} from "./metrics";
import { histogramKeys } from "./metrics";

// ── Legacy envelope (#236) ─────────────────────────────────────────────────

export interface ReportInput {
  /** ISO-8601 timestamp; caller is free to inject a fixed value in tests. */
  timestamp: string;
  /** Git branch the bench was run on. */
  branch: string;
  /** Git commit SHA. */
  commit: string;
  /** Model identifier; matches the value stamped on every RunResult. */
  model: string;
  /** Track name (`utility` or `evolve`). */
  track: "utility" | "evolve";
  /** Per-arm aggregate. Caller computes via `computeOutcomeAggregate`. */
  arms: Record<string, OutcomeAggregate>;
}

/**
 * Pretty-print a 2-space-indented JSON envelope. The shape is the v1
 * contract — `bench compare` reads it and refuses to diff across mismatched
 * `model` fields.
 */
export function renderJsonReport(input: ReportInput): string {
  const envelope = {
    schemaVersion: 1 as const,
    timestamp: input.timestamp,
    branch: input.branch,
    commit: input.commit,
    track: input.track,
    agent: { harness: "opencode", model: input.model },
    aggregate: input.arms,
  };
  return JSON.stringify(envelope, null, 2);
}

/**
 * 5-ish-line markdown summary for stderr / PR descriptions. Used by the
 * empty-corpus skeleton path.
 */
export function renderMarkdownSummary(input: ReportInput): string {
  const lines: string[] = [];
  lines.push(`# akm-bench (${input.track}) — ${input.model}`);
  lines.push(`branch \`${input.branch}\` @ \`${input.commit}\` — ${input.timestamp}`);
  for (const [arm, agg] of Object.entries(input.arms)) {
    lines.push(
      `- **${arm}**: pass_rate=${agg.passRate.toFixed(2)}, tokens_per_pass=${agg.tokensPerPass.toFixed(0)}, wallclock_ms=${agg.wallclockMs.toFixed(0)}, budget_exceeded=${agg.budgetExceeded}`,
    );
  }
  return lines.join("\n");
}

// ── Utility-track report (§13.3) ───────────────────────────────────────────

/**
 * Compact serialised RunResult row persisted into the §13.3 JSON envelope
 * under the top-level `runs[]` key (#249).
 *
 * One row per `(task, arm, seed)` execution, both `noakm` and `akm`. Contains
 * enough fields to recompute every aggregate metric (per-task, trajectory,
 * failure-mode, search-bridge, attribution) plus task metadata, but
 * deliberately omits the full `events[]` and unbounded `verifierStdout` so the
 * envelope stays compact. Older artefacts that pre-date this field are still
 * valid: callers that need run-level data should fall back to the per-task
 * aggregate path.
 */
export interface RunRecordSerialized {
  task_id: string;
  arm: string;
  seed: number;
  model: string;
  outcome: string;
  /**
   * Spread of `RunResult.tokens` so future fields (e.g. `measurement` from
   * #252) flow through automatically without a renderer change. Today the
   * shape is `{input: number, output: number}`; #252 will add a sibling
   * `measurement` field. TODO(#252): keep this pass-through.
   */
  tokens: Record<string, unknown>;
  wallclock_ms: number;
  verifier_exit_code: number;
  trajectory: {
    correct_asset_loaded: boolean | null;
    feedback_recorded: boolean | null;
  };
  assets_loaded: string[];
  failure_mode: string | null;
}

/**
 * Project a RunResult onto its compact serialised form for the §13.3 JSON
 * envelope (#249). Mirrors the field list in the issue body.
 *
 * Token-shape seam: `tokens` is spread verbatim from `result.tokens` so when
 * #252 adds a `measurement` field the renderer doesn't need a code change.
 * Do NOT hardcode `{input, output}` projections here.
 */
export function serializeRunForReport(result: RunResult): RunRecordSerialized {
  return {
    task_id: result.taskId,
    arm: result.arm,
    seed: result.seed,
    model: result.model,
    outcome: result.outcome,
    // TODO(#252): when RunResult.tokens grows a `measurement` key, this spread
    // carries it forward without a renderer change.
    tokens: { ...result.tokens },
    wallclock_ms: result.wallclockMs,
    verifier_exit_code: result.verifierExitCode,
    trajectory: {
      correct_asset_loaded: result.trajectory.correctAssetLoaded,
      feedback_recorded: result.trajectory.feedbackRecorded,
    },
    assets_loaded: [...(result.assetsLoaded ?? [])],
    failure_mode: result.failureMode ?? null,
  };
}

/**
 * Per-task envelope inside `tasks[]`. Mirrors the §13.3 layout: `noakm` and
 * `akm` are PerTaskMetrics, `delta` is the akm − noakm difference.
 */
export interface UtilityReportTaskEntry {
  id: string;
  noakm: PerTaskMetrics;
  akm: PerTaskMetrics;
  delta: CorpusDelta;
  /**
   * Per-task synthetic-arm metrics (#261). Present only on reports built by
   * `runUtility({ includeSynthetic: true, ... })`. When absent the per-task
   * row in the §13.3 envelope omits the `synthetic` key entirely so the
   * default two-arm envelope is byte-identical to the pre-#261 output.
   */
  synthetic?: PerTaskMetrics;
}

/**
 * Top-level §13.3 input. The runner produces this; `renderUtilityReport`
 * stamps it into the canonical shape (snake-case keys, percentages, etc.).
 */
export interface UtilityRunReport {
  timestamp: string;
  branch: string;
  commit: string;
  model: string;
  corpus: {
    domains: number;
    tasks: number;
    slice: "all" | "train" | "eval";
    seedsPerArm: number;
    /**
     * Identity stamps used by `bench compare` to refuse cross-corpus diffs
     * (#250). All four are populated by `runUtility` at finalize time. Older
     * reports (pre-#250) lack these keys and degrade to a warning instead of
     * a refusal — see `compareReports`.
     */
    selectedTaskIds?: string[];
    taskCorpusHash?: string;
    fixtures?: Record<string, string>;
    fixtureContentHash?: string;
  };
  aggregateNoakm: CorpusMetrics;
  aggregateAkm: CorpusMetrics;
  aggregateDelta: CorpusDelta;
  /**
   * Synthetic-arm corpus aggregate (#261). Present only when `runUtility`
   * was called with `includeSynthetic: true`. Renderers gate every
   * synthetic-related output (`arms.synthetic`, `akm_over_synthetic_lift`,
   * markdown subsection) on the presence of this field so the default
   * two-arm envelope stays byte-identical to the pre-#261 shape.
   */
  aggregateSynth?: CorpusMetrics;
  trajectoryAkm: TrajectoryAggregate;
  /**
   * Failure-mode taxonomy aggregate (§6.6). Counts and per-task breakdown
   * across every failed akm-arm run in the corpus. Empty `byLabel` /
   * `byTask` when no runs failed.
   */
  failureModes: FailureModeAggregate;
  tasks: UtilityReportTaskEntry[];
  warnings: string[];
  /**
   * Per-asset attribution rows (§6.5). Populated by the runner; aggregated
   * across every akm-arm RunResult. Older artefacts without this field
   * remain valid (callers should default to an empty `{ rows: [], totalAkmRuns: 0 }`).
   */
  perAsset?: PerAssetAttribution;
  /**
   * Raw akm-arm RunResults retained on the report for in-process consumers
   * (the masked-corpus helper, attribution post-processing). NOT serialised
   * into the §13.3 JSON envelope — too large and not part of the locked
   * contract. The field is on the in-memory shape only.
   */
  akmRuns?: RunResult[];
  /**
   * Raw RunResults across both arms (`noakm` + `akm`), retained on the
   * report so `buildUtilityJson` can serialise the compact §13.3 `runs[]`
   * array (#249). Populated by the runner. When omitted, the envelope simply
   * does not gain a `runs` key — backward-compat with code paths that
   * construct a UtilityRunReport without raw runs.
   */
  allRuns?: RunResult[];
  /**
   * Task metadata for in-process consumers (the masked-corpus helper needs
   * to remap each task's stash to a tmp dir). Not serialised into the §13.3
   * envelope — the existing `tasks[]` carries the public per-task aggregates.
   */
  taskMetadata?: TaskMetadata[];
  /**
   * Per-(akm-arm, goldRef) gold-rank records. Populated by the runner; read
   * by `computeSearchBridge`. Empty when no corpus tasks carry a `goldRef`.
   */
  goldRankRecords?: GoldRankRunRecord[];
  /**
   * §6.7 search-pipeline bridge metrics. Always present on populated runs;
   * an "empty" SearchBridgeMetrics envelope renders as the N/A sentence.
   */
  searchBridge?: SearchBridgeMetrics;
}

/**
 * Stamp a utility run into both the §13.3 JSON envelope and a markdown
 * summary. Callers wire stdout/stderr separately.
 *
 * Determinism: given identical input the function is byte-stable. Markdown
 * does not embed `timestamp` in the body table (only in the header), so
 * snapshot tests are stable across reruns.
 */
export function renderUtilityReport(input: UtilityRunReport): { json: object; markdown: string } {
  const json = buildUtilityJson(input);
  const markdown = buildUtilityMarkdown(input);
  return { json, markdown };
}

function buildUtilityJson(input: UtilityRunReport): object {
  const includeSynth = input.aggregateSynth !== undefined;
  const tasks = input.tasks.map((t) => ({
    id: t.id,
    noakm: serialisePerTaskMetrics(t.noakm),
    akm: serialisePerTaskMetrics(t.akm),
    delta: serialiseDelta(t.delta),
    // #261: per-task synthetic block is emitted ONLY when the runner opted
    // into the synthetic arm AND this task carries a synthetic aggregate.
    // When the arm was not run we leave the key absent — a missing arm is
    // not a zero-pass arm.
    ...(includeSynth && t.synthetic ? { synthetic: serialisePerTaskMetrics(t.synthetic) } : {}),
  }));

  // Token-measurement coverage (issue #252). Folds the corpus-wide picture so
  // operators can tell at a glance whether token economics are reliable. The
  // warning string mirrors what we add to `warnings[]` in markdown output.
  const tokenMeasurement = summariseTokenMeasurement(input);

  const warnings = [...input.warnings];
  if (tokenMeasurement.warning) warnings.push(tokenMeasurement.warning);

  const envelope: Record<string, unknown> = {
    schemaVersion: 1,
    track: "utility",
    branch: input.branch,
    commit: input.commit,
    timestamp: input.timestamp,
    agent: { harness: "opencode", model: input.model },
    corpus: input.corpus,
    aggregate: {
      noakm: serialiseCorpus(input.aggregateNoakm),
      akm: serialiseCorpus(input.aggregateAkm),
      delta: serialiseDelta(input.aggregateDelta),
      // #261: synthetic aggregate is emitted ONLY when includeSynthetic
      // was set on the runner. Absent otherwise — byte-identical to the
      // pre-#261 envelope.
      ...(input.aggregateSynth ? { synthetic: serialiseCorpus(input.aggregateSynth) } : {}),
      // #261: akm_over_synthetic_lift = passRate(akm) - passRate(synthetic).
      // Only computed when the synthetic arm ran. Positive => AKM beats the
      // synthetic-notes baseline; non-positive flags AKM is not adding value
      // beyond what the model can synthesise on its own.
      ...(input.aggregateSynth
        ? { akm_over_synthetic_lift: input.aggregateAkm.passRate - input.aggregateSynth.passRate }
        : {}),
    },
    trajectory: {
      akm: {
        correct_asset_loaded: input.trajectoryAkm.correctAssetLoaded,
        feedback_recorded: input.trajectoryAkm.feedbackRecorded,
      },
    },
    failure_modes: {
      by_label: input.failureModes.byLabel,
      by_task: input.failureModes.byTask,
    },
    token_measurement: {
      total_runs: tokenMeasurement.totalRuns,
      runs_with_measured_tokens: tokenMeasurement.measuredRuns,
      runs_missing_measurement: tokenMeasurement.missingRuns,
      runs_unsupported_measurement: tokenMeasurement.unsupportedRuns,
      coverage: tokenMeasurement.coverage,
      reliable: tokenMeasurement.reliable,
    },
    tasks,
    warnings,
    ...(input.searchBridge ? { searchBridge: serialiseSearchBridge(input.searchBridge) } : {}),
  };

  // Compact raw runs[] — additive top-level key (#249). One row per
  // (task, arm, seed) execution; both noakm and akm. Older artefacts that
  // pre-date this field stay valid because we only emit it when the runner
  // actually populated `allRuns`.
  if (input.allRuns) {
    envelope.runs = input.allRuns.map(serializeRunForReport);
  }

  // Per-asset attribution is an additive top-level key (§6.5). Emit it only
  // when the runner populated it so older code paths (e.g. the empty-corpus
  // skeleton) don't gain the key spuriously.
  if (input.perAsset) {
    envelope.perAsset = {
      total_akm_runs: input.perAsset.totalAkmRuns,
      rows: input.perAsset.rows.map((r) => ({
        asset_ref: r.assetRef,
        load_count: r.loadCount,
        load_count_passing: r.loadCountPassing,
        load_count_failing: r.loadCountFailing,
        load_pass_rate: r.loadPassRate,
      })),
    };
  }

  return envelope;
}

/**
 * §6.7 envelope. We expose `null` for percentiles that fell into the missing
 * bucket so JSON consumers don't choke on `Infinity`.
 */
function serialiseSearchBridge(s: SearchBridgeMetrics): object {
  return {
    runs_observed: s.runsObserved,
    searches_observed: s.searchesObserved,
    gold_rank_distribution: s.goldRankDistribution,
    gold_rank_p50: percentileForJson(s.goldRankP50),
    gold_rank_p90: percentileForJson(s.goldRankP90),
    gold_at_rank_1: s.goldAtRank1,
    gold_missing: s.goldMissing,
    pass_rate_by_rank: s.passRateByRank.map((e) => ({
      rank: e.rank,
      pass_rate: e.passRate,
      run_count: e.runCount,
    })),
  };
}

function percentileForJson(value: number | null): number | string | null {
  if (value === null) return null;
  if (!Number.isFinite(value)) return "missing";
  return value;
}

function serialiseCorpus(c: CorpusMetrics): {
  pass_rate: number;
  tokens_per_pass: number | null;
  wallclock_ms: number;
} {
  return {
    pass_rate: c.passRate,
    tokens_per_pass: c.tokensPerPass,
    wallclock_ms: c.wallclockMs,
  };
}

function serialiseDelta(d: CorpusDelta): { pass_rate: number; tokens_per_pass: number | null; wallclock_ms: number } {
  return {
    pass_rate: d.passRate,
    tokens_per_pass: d.tokensPerPass,
    wallclock_ms: d.wallclockMs,
  };
}

function serialisePerTaskMetrics(m: PerTaskMetrics): {
  pass_rate: number;
  pass_at_1: 0 | 1;
  tokens_per_pass: number | null;
  wallclock_ms: number;
  pass_rate_stdev: number;
  budget_exceeded_count: number;
  harness_error_count: number;
  count: number;
  runs_with_measured_tokens: number;
} {
  return {
    pass_rate: m.passRate,
    pass_at_1: m.passAt1,
    tokens_per_pass: m.tokensPerPass,
    wallclock_ms: m.wallclockMs,
    pass_rate_stdev: m.passRateStdev,
    budget_exceeded_count: m.budgetExceededCount,
    harness_error_count: m.harnessErrorCount,
    count: m.count,
    runs_with_measured_tokens: m.runsWithMeasuredTokens,
  };
}

/**
 * Token-measurement coverage summary (issue #252). The `warning` string is
 * non-null whenever any run lacks parsed token measurement; report renderers
 * splice it into `warnings[]` so the markdown "## Warnings" section and the
 * JSON `warnings` array surface the same prose.
 *
 * `coverage` is `null` when there are no akm-arm runs (nothing to measure
 * against — distinct from "0 / 0 = NaN"). `reliable` is `true` only when
 * every akm run carried `tokenMeasurement === "parsed"`.
 */
interface TokenMeasurementSummary {
  totalRuns: number;
  measuredRuns: number;
  missingRuns: number;
  unsupportedRuns: number;
  coverage: number | null;
  reliable: boolean;
  warning: string | null;
}

function summariseTokenMeasurement(input: UtilityRunReport): TokenMeasurementSummary {
  const runs = input.akmRuns ?? [];
  let measured = 0;
  let missing = 0;
  let unsupported = 0;
  for (const r of runs) {
    const m = r.tokenMeasurement ?? "parsed";
    if (m === "parsed") measured += 1;
    else if (m === "missing") missing += 1;
    else if (m === "unsupported") unsupported += 1;
  }
  const total = runs.length;
  const coverage = total === 0 ? null : measured / total;
  const reliable = total > 0 && missing === 0 && unsupported === 0;
  let warning: string | null = null;
  if (total > 0 && !reliable) {
    const parts: string[] = [];
    if (missing > 0) parts.push(`${missing} missing`);
    if (unsupported > 0) parts.push(`${unsupported} unsupported`);
    warning =
      `token measurement unreliable: ${parts.join(", ")} of ${total} akm-arm runs lack parsed token usage; ` +
      `tokens_per_pass and token-budget signals reflect only the ${measured} measured runs.`;
  }
  return {
    totalRuns: total,
    measuredRuns: measured,
    missingRuns: missing,
    unsupportedRuns: unsupported,
    coverage,
    reliable,
    warning,
  };
}

function buildUtilityMarkdown(input: UtilityRunReport): string {
  const lines: string[] = [];
  lines.push(`# akm-bench utility — ${input.model}`);
  lines.push("");
  lines.push(`branch \`${input.branch}\` @ \`${input.commit}\` — ${input.timestamp}`);
  lines.push(
    `corpus: ${input.corpus.tasks} tasks across ${input.corpus.domains} domains (slice=${input.corpus.slice}, seedsPerArm=${input.corpus.seedsPerArm})`,
  );
  lines.push("");
  lines.push("## Aggregate");
  lines.push("");
  lines.push("| arm | pass_rate | tokens_per_pass | wallclock_ms |");
  lines.push("|-----|-----------|-----------------|--------------|");
  lines.push(corpusRow("noakm", input.aggregateNoakm));
  // #261: synthetic row sits between noakm and akm so the columns read
  // baseline → synthetic → akm in the natural progression. Only rendered
  // when the runner opted into the synthetic arm.
  if (input.aggregateSynth) {
    lines.push(corpusRow("synthetic", input.aggregateSynth));
  }
  lines.push(corpusRow("akm", input.aggregateAkm));
  lines.push(deltaRow(input.aggregateDelta));
  // #261: akm_over_synthetic_lift summary line. When AKM does not beat the
  // synthetic baseline (lift <= 0) we surface a warning marker so operators
  // cannot miss the regression. Otherwise we render the lift as an
  // informative line.
  if (input.aggregateSynth) {
    const lift = input.aggregateAkm.passRate - input.aggregateSynth.passRate;
    lines.push("");
    if (lift <= 0) {
      lines.push(
        `:warning: **akm_over_synthetic_lift = ${signedFixed(lift, 2)}** — AKM did not beat the synthetic-notes baseline.`,
      );
    } else {
      lines.push(`**akm_over_synthetic_lift: ${signedFixed(lift, 2)}**`);
    }
  }
  lines.push("");
  lines.push("## Trajectory (akm)");
  lines.push("");
  lines.push(`- correct_asset_loaded: ${formatPercent(input.trajectoryAkm.correctAssetLoaded)}`);
  lines.push(`- feedback_recorded: ${formatPercent(input.trajectoryAkm.feedbackRecorded)}`);
  lines.push("");
  lines.push("## Per-task pass rates");
  lines.push("");
  // #261: synthetic column is rendered only when the synthetic arm ran.
  // The default header/row stays identical to the pre-#261 output.
  if (input.aggregateSynth) {
    lines.push("| task | noakm | synthetic | akm | delta |");
    lines.push("|------|-------|-----------|-----|-------|");
  } else {
    lines.push("| task | noakm | akm | delta |");
    lines.push("|------|-------|-----|-------|");
  }
  // Sort tasks alphabetically for byte-stable markdown output.
  const sorted = [...input.tasks].sort((a, b) => a.id.localeCompare(b.id));
  for (const t of sorted) {
    lines.push(taskRow(t, input.aggregateSynth !== undefined));
  }
  // Failure-mode breakdown (§6.6). Appended near the bottom so the headline
  // pass-rate / trajectory tables stay visually anchored at the top.
  const failureSection = renderFailureModeBreakdown(input);
  if (failureSection.length > 0) {
    lines.push("");
    lines.push(failureSection);
  }
  if (input.searchBridge) {
    lines.push("");
    lines.push(renderSearchBridgeTable(input.searchBridge));
  }

  // Token-measurement section (issue #252). Always rendered when there are
  // akm-arm runs to report on, so operators can tell whether tokens economics
  // are trustworthy without scrolling to the warnings block.
  const tokenSummary = summariseTokenMeasurement(input);
  if (tokenSummary.totalRuns > 0) {
    lines.push("");
    lines.push("## Token measurement (akm)");
    lines.push("");
    const cov = tokenSummary.coverage === null ? "n/a" : `${(tokenSummary.coverage * 100).toFixed(1)}%`;
    lines.push(
      `- runs: ${tokenSummary.totalRuns} total, ${tokenSummary.measuredRuns} measured, ${tokenSummary.missingRuns} missing, ${tokenSummary.unsupportedRuns} unsupported`,
    );
    lines.push(`- coverage: ${cov} (${tokenSummary.reliable ? "reliable" : "unreliable — see warning below"})`);
  }

  const warnings = [...input.warnings];
  if (tokenSummary.warning) warnings.push(tokenSummary.warning);
  if (warnings.length > 0) {
    lines.push("");
    lines.push("## Warnings");
    lines.push("");
    for (const w of warnings) lines.push(`- ${w}`);
  }
  return lines.join("\n");
}

// ── Search-pipeline bridge (§6.7) markdown ─────────────────────────────────

/**
 * Render the §6.7 search-pipeline bridge as a markdown section.
 *
 * When the corpus has no gold-ref tasks (or simply no `akm search`
 * invocations), the section collapses to a single "(N/A)" sentence so the
 * report stays compact.
 */
export function renderSearchBridgeTable(metrics: SearchBridgeMetrics): string {
  const lines: string[] = [];
  lines.push("## Search → outcome bridge");
  lines.push("");

  if (metrics.searchesObserved === 0 && metrics.runsObserved === 0) {
    lines.push("(no gold-ref tasks in corpus; bridge metrics N/A)");
    return lines.join("\n");
  }

  // Histogram of gold rank.
  lines.push("| rank | count |");
  lines.push("|------|-------|");
  for (const k of histogramKeys()) {
    const count = metrics.goldRankDistribution[k] ?? 0;
    lines.push(`| ${k} | ${count} |`);
  }
  lines.push("");

  // Summary line.
  const p50 = formatRank(metrics.goldRankP50);
  const p90 = formatRank(metrics.goldRankP90);
  lines.push(
    `p50=${p50}, p90=${p90}, gold_at_rank_1=${formatPercent(metrics.goldAtRank1)}, gold_missing=${formatPercent(
      metrics.goldMissing,
    )}`,
  );
  lines.push("");

  // pass_rate_by_rank.
  lines.push("| rank | pass_rate | run_count |");
  lines.push("|------|-----------|-----------|");
  if (metrics.passRateByRank.length === 0) {
    lines.push("| (no runs with `akm search` invocations) | — | 0 |");
  } else {
    for (const entry of metrics.passRateByRank) {
      lines.push(`| ${entry.rank} | ${entry.passRate.toFixed(2)} | ${entry.runCount} |`);
    }
  }
  return lines.join("\n");
}

function formatRank(value: number | null): string {
  if (value === null) return "n/a";
  if (!Number.isFinite(value)) return "missing";
  return value.toFixed(1);
}

function corpusRow(arm: string, c: CorpusMetrics): string {
  const tpp = c.tokensPerPass === null ? "n/a" : c.tokensPerPass.toFixed(0);
  return `| ${arm} | ${c.passRate.toFixed(2)} | ${tpp} | ${c.wallclockMs.toFixed(0)} |`;
}

function deltaRow(d: CorpusDelta): string {
  const tpp = d.tokensPerPass === null ? "n/a" : signed(d.tokensPerPass.toFixed(0));
  return `| **delta** | ${signed(d.passRate.toFixed(2))} | ${tpp} | ${signed(d.wallclockMs.toFixed(0))} |`;
}

function taskRow(t: UtilityReportTaskEntry, includeSynthetic = false): string {
  if (includeSynthetic) {
    // #261: render the synthetic-arm pass-rate when present; "n/a" when the
    // arm did not run for this task. A missing arm is NOT a zero-pass arm —
    // a 0.00 cell would be misleading because the model never tried.
    const synth = t.synthetic ? t.synthetic.passRate.toFixed(2) : "n/a";
    return `| ${t.id} | ${t.noakm.passRate.toFixed(2)} | ${synth} | ${t.akm.passRate.toFixed(2)} | ${signed(t.delta.passRate.toFixed(2))} |`;
  }
  return `| ${t.id} | ${t.noakm.passRate.toFixed(2)} | ${t.akm.passRate.toFixed(2)} | ${signed(t.delta.passRate.toFixed(2))} |`;
}

function signed(text: string): string {
  if (text.startsWith("-")) return text;
  if (text === "0" || text === "0.00" || text === "0.0") return text;
  return `+${text}`;
}

function formatPercent(value: number | null): string {
  if (value === null) return "n/a";
  return `${(value * 100).toFixed(1)}%`;
}

// ── Compare rendering (§8) ─────────────────────────────────────────────────

/**
 * Render a CompareResult as a deterministic markdown diff.
 *
 * Determinism: no timestamps, no run IDs, no git SHAs in the body — the diff
 * is a pure function of the two inputs' aggregated numbers and per-task
 * tables. Per-task rows are sorted alphabetically (already done by
 * `compareReports`, but re-asserted here defensively).
 *
 * Refusal cases (model mismatch, hash mismatch, schema/track issues) render
 * as a single error block instead of a diff table — there's nothing
 * actionable to show, and the operator's recovery path is in the message.
 */
export function renderCompareMarkdown(result: CompareResult): string {
  if (!result.ok) {
    return renderCompareFailure(result);
  }
  return renderCompareSuccess(result);
}

function renderCompareFailure(result: Extract<CompareResult, { ok: false }>): string {
  const lines: string[] = [];
  lines.push(`# akm-bench compare — refused (${result.reason})`);
  lines.push("");
  lines.push(result.message);
  if (result.reason === "model_mismatch" && result.baseModel !== undefined && result.currentModel !== undefined) {
    lines.push("");
    lines.push(`- base model:    \`${result.baseModel}\``);
    lines.push(`- current model: \`${result.currentModel}\``);
  }
  if (
    result.reason === "hash_mismatch" &&
    result.baseFixtureContentHash !== undefined &&
    result.currentFixtureContentHash !== undefined
  ) {
    lines.push("");
    lines.push(`- base fixture hash:    \`${String(result.baseFixtureContentHash)}\``);
    lines.push(`- current fixture hash: \`${String(result.currentFixtureContentHash)}\``);
    if (result.affectedFixtures && result.affectedFixtures.length > 0) {
      lines.push("");
      lines.push("affected fixtures:");
      for (const f of result.affectedFixtures) lines.push(`- ${f}`);
    }
  }
  if (result.reason === "corpus_mismatch") {
    if (result.baseTaskCorpusHash !== undefined || result.currentTaskCorpusHash !== undefined) {
      lines.push("");
      lines.push(`- base taskCorpusHash:    \`${String(result.baseTaskCorpusHash ?? "n/a")}\``);
      lines.push(`- current taskCorpusHash: \`${String(result.currentTaskCorpusHash ?? "n/a")}\``);
    }
    if (result.baseSelectedTaskIds && result.currentSelectedTaskIds) {
      const baseSet = new Set(result.baseSelectedTaskIds);
      const currentSet = new Set(result.currentSelectedTaskIds);
      const addedToCurrent = result.currentSelectedTaskIds.filter((id) => !baseSet.has(id)).sort();
      const droppedFromBase = result.baseSelectedTaskIds.filter((id) => !currentSet.has(id)).sort();
      if (addedToCurrent.length > 0) {
        lines.push("");
        lines.push("only in current:");
        for (const id of addedToCurrent) lines.push(`- ${id}`);
      }
      if (droppedFromBase.length > 0) {
        lines.push("");
        lines.push("only in base:");
        for (const id of droppedFromBase) lines.push(`- ${id}`);
      }
    }
  }
  return lines.join("\n");
}

function renderCompareSuccess(result: Extract<CompareResult, { ok: true }>): string {
  const lines: string[] = [];
  lines.push(`# akm-bench compare — \`${result.currentModel}\``);
  lines.push("");
  if (result.baseFixtureContentHash !== null || result.currentFixtureContentHash !== null) {
    const b = result.baseFixtureContentHash === null ? "n/a" : `\`${result.baseFixtureContentHash}\``;
    const c = result.currentFixtureContentHash === null ? "n/a" : `\`${result.currentFixtureContentHash}\``;
    lines.push(`fixture-content hash: base=${b}, current=${c}`);
    lines.push("");
  }
  lines.push("## Aggregate (akm arm, current − base)");
  lines.push("");
  lines.push("| metric | delta | direction |");
  lines.push("|--------|-------|-----------|");
  lines.push(
    `| pass_rate | ${signedFixed(result.aggregate.passRateDelta, 2)} | ${signGlyph(result.aggregate.passRateSign)} |`,
  );
  lines.push(
    `| tokens_per_pass | ${nullableSignedFixed(result.aggregate.tokensPerPassDelta, 0)} | ${signGlyph(result.aggregate.tokensPerPassSign)} |`,
  );
  lines.push(
    `| wallclock_ms | ${signedFixed(result.aggregate.wallclockMsDelta, 0)} | ${signGlyph(result.aggregate.wallclockMsSign)} |`,
  );
  lines.push("");
  lines.push("## Per-task (akm arm)");
  lines.push("");
  lines.push("| task | base pass_rate | current pass_rate | delta | dir | base stdev | current stdev |");
  lines.push("|------|----------------|-------------------|-------|-----|------------|---------------|");
  const sorted = [...result.perTask].sort((a, b) => a.id.localeCompare(b.id));
  for (const row of sorted) lines.push(perTaskCompareRow(row));
  if (result.warnings.length > 0) {
    lines.push("");
    lines.push("## Warnings");
    lines.push("");
    for (const w of result.warnings) lines.push(`- ${w}`);
  }
  return lines.join("\n");
}

function perTaskCompareRow(row: CompareTaskRow): string {
  const baseRate = row.baseMetrics === null ? "n/a" : row.baseMetrics.pass_rate.toFixed(2);
  const currentRate = row.currentMetrics === null ? "n/a" : row.currentMetrics.pass_rate.toFixed(2);
  const delta = row.delta.passRate === null ? "n/a" : signedFixed(row.delta.passRate, 2);
  const dir = signGlyph(row.signMarker);
  const baseStdev = row.baseMetrics === null ? "n/a" : row.baseMetrics.pass_rate_stdev.toFixed(2);
  const currentStdev = row.currentMetrics === null ? "n/a" : row.currentMetrics.pass_rate_stdev.toFixed(2);
  const idCell = row.presence === "both" ? row.id : `${row.id} _(${row.presence})_`;
  return `| ${idCell} | ${baseRate} | ${currentRate} | ${delta} | ${dir} | ${baseStdev} | ${currentStdev} |`;
}

function signGlyph(sign: DeltaSign): string {
  if (sign === "improve") return "▲";
  if (sign === "regress") return "▼";
  return "▬";
}

function signedFixed(value: number, digits: number): string {
  // Treat numerical zero (or values that round to "-0.00") as "0" so we
  // never emit a misleading "+0.00" or "-0.00" in deterministic output.
  const fixed = value.toFixed(digits);
  if (fixed === "-0" || /^-0\.0+$/.test(fixed)) return (0).toFixed(digits);
  if (value === 0) return fixed;
  return value > 0 ? `+${fixed}` : fixed;
}

function nullableSignedFixed(value: number | null, digits: number): string {
  if (value === null) return "n/a";
  return signedFixed(value, digits);
}

// ── Attribution table rendering (§6.5) ─────────────────────────────────────

/**
 * Threshold for the "highly loaded" slice — assets with a load count at or
 * above this fraction of the per-table maximum get bucketed into the "well
 * used and working" / "well used and not working" callout sections.
 */
const HIGH_LOAD_THRESHOLD = 0.5;

/**
 * Threshold for "working" pass-rate. An asset is "working" if its
 * load_pass_rate is at or above this; "not working" if below.
 */
const WORKING_PASS_RATE_THRESHOLD = 0.5;

/**
 * Render a per-asset attribution table as markdown. Sort order matches
 * `computePerAssetAttribution` (load count desc, pass rate desc, ref asc).
 *
 * The output has three sections:
 *   1. Full sorted table.
 *   2. "Well-used and working" callout — high load, high pass_rate.
 *   3. "Well-used and not working" callout — high load, low pass_rate.
 *
 * The two callouts are the actionable slices: the first is what curation
 * should preserve, the second is what should be improved or removed.
 */
export function renderAttributionTable(attr: PerAssetAttribution): string {
  const lines: string[] = [];
  lines.push("## Per-asset attribution");
  lines.push("");
  lines.push(`Total akm-arm runs aggregated: ${attr.totalAkmRuns}`);
  lines.push("");

  if (attr.rows.length === 0) {
    lines.push("_No assets were loaded by the agent during akm-arm runs._");
    return lines.join("\n");
  }

  lines.push("| asset_ref | load_count | load_count_passing | load_count_failing | load_pass_rate |");
  lines.push("|-----------|------------|--------------------|--------------------|----------------|");
  for (const row of attr.rows) {
    lines.push(
      `| \`${row.assetRef}\` | ${row.loadCount} | ${row.loadCountPassing} | ${row.loadCountFailing} | ${formatRate(row.loadPassRate)} |`,
    );
  }

  // Slice callouts. We compute the high-load threshold relative to the
  // top-loaded asset's count so this scales whether the corpus has 5 or 500
  // total runs.
  const topLoad = attr.rows[0]?.loadCount ?? 0;
  const highLoadCutoff = Math.max(1, Math.ceil(topLoad * HIGH_LOAD_THRESHOLD));
  const heavilyLoaded = attr.rows.filter((r) => r.loadCount >= highLoadCutoff);

  const working = heavilyLoaded.filter((r) => (r.loadPassRate ?? 0) >= WORKING_PASS_RATE_THRESHOLD);
  const notWorking = heavilyLoaded.filter((r) => (r.loadPassRate ?? 0) < WORKING_PASS_RATE_THRESHOLD);

  lines.push("");
  lines.push("### Well-used and working");
  lines.push("");
  if (working.length === 0) {
    lines.push("_None._");
  } else {
    for (const r of working) {
      lines.push(`- \`${r.assetRef}\` (load_count=${r.loadCount}, load_pass_rate=${formatRate(r.loadPassRate)})`);
    }
  }

  lines.push("");
  lines.push("### Well-used and NOT working");
  lines.push("");
  if (notWorking.length === 0) {
    lines.push("_None._");
  } else {
    for (const r of notWorking) {
      lines.push(`- \`${r.assetRef}\` (load_count=${r.loadCount}, load_pass_rate=${formatRate(r.loadPassRate)})`);
    }
  }

  return lines.join("\n");
}

function formatRate(value: number | null): string {
  if (value === null) return "n/a";
  return `${(value * 100).toFixed(1)}%`;
}

// ── Failure-mode breakdown (§6.6) ──────────────────────────────────────────

/**
 * Render the §6.6 "Failure modes" markdown section. Lines are sorted by
 * descending count (ties broken alphabetically by label so output is
 * byte-stable). Each line:
 *
 *   `<label> — <count> (<percent>% of failed runs)`
 *
 * Returns an empty string when no failed runs exist (caller decides whether
 * to append a blank section header).
 */
export function renderFailureModeBreakdown(report: UtilityRunReport): string {
  const entries = Object.entries(report.failureModes.byLabel) as Array<[FailureMode, number]>;
  if (entries.length === 0) return "";
  const totalFailures = entries.reduce((acc, [, count]) => acc + count, 0);
  if (totalFailures === 0) return "";

  // Sort by descending count, tie-break alphabetically for determinism.
  entries.sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return a[0].localeCompare(b[0]);
  });

  const lines: string[] = ["## Failure modes", ""];
  for (const [label, count] of entries) {
    const percent = ((count / totalFailures) * 100).toFixed(1);
    lines.push(`- ${label} — ${count} (${percent}% of failed runs)`);
  }
  return lines.join("\n");
}

// ── Git helpers ────────────────────────────────────────────────────────────

/**
 * Resolve `git rev-parse --abbrev-ref HEAD`. Falls back to `"unknown"` if
 * git is unavailable or the cwd is not a repo. Tests inject `cwd` to point
 * at a tmp non-repo to exercise the fallback.
 */
export function resolveGitBranch(cwd?: string): string {
  return tryGit(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
}

/**
 * Resolve `git rev-parse --short HEAD`. Same fallback rules as
 * `resolveGitBranch`.
 */
export function resolveGitCommit(cwd?: string): string {
  return tryGit(["rev-parse", "--short", "HEAD"], cwd);
}

function tryGit(args: string[], cwd?: string): string {
  try {
    const out = execSync(`git ${args.join(" ")}`, {
      cwd: cwd ?? process.cwd(),
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    });
    return out.trim() || "unknown";
  } catch {
    return "unknown";
  }
}

// ── Evolve-track report (§6.3 + §6.4) ──────────────────────────────────────

/**
 * Top-level evolve report shape. Mirrors `EvolveRunReport` from `evolve.ts`
 * — re-declared here as a structural subtype so report.ts has no cycle on
 * evolve.ts.
 */
export interface EvolveReportInput {
  timestamp: string;
  branch: string;
  commit: string;
  model: string;
  domain: string;
  seedsPerArm: number;
  proposals: ProposalQualityMetrics;
  longitudinal: LongitudinalMetrics;
  /**
   * Feedback-signal integrity 2x2 confusion matrix (§6.8). When omitted,
   * the markdown summary surfaces the legacy `_feedback_agreement: pending_`
   * placeholder; the JSON envelope omits the `feedback_integrity` key so
   * older artefacts remain valid.
   */
  feedbackIntegrity?: FeedbackIntegrityMetrics;
  arms: { pre: UtilityRunReport; post: UtilityRunReport; synthetic: UtilityRunReport };
  warnings: string[];
}

/**
 * Threshold below which the markdown summary prepends a warning marker
 * and the JSON envelope's `warnings[]` carries a structured
 * `feedback_agreement_below_threshold` entry. Track B's headline numbers
 * (`improvement_slope`, `over_synthetic_lift`) are unreliable when
 * Phase 1 feedback disagrees with run outcomes more than 20% of the
 * time. Spec §6.8.
 */
export const FEEDBACK_AGREEMENT_WARNING_THRESHOLD = 0.8;

/**
 * Render an evolve run as the §6.3+§6.4 JSON envelope plus a markdown
 * summary. Mirrors `renderUtilityReport` — caller wires stdout/stderr.
 */
export function renderEvolveReport(input: EvolveReportInput): { json: object; markdown: string } {
  const json = buildEvolveJson(input);
  const markdown = buildEvolveMarkdown(input);
  return { json, markdown };
}

function buildEvolveJson(input: EvolveReportInput): object {
  // For each arm we re-render the §13.3 utility envelope so downstream
  // consumers can treat each arm exactly like a `bench utility` artefact.
  const armEnvelope = (r: UtilityRunReport): object => buildUtilityJson(r);

  // §6.8 — derive an additive `warnings[]` entry when the headline
  // feedback_agreement falls below the trust threshold.
  const augmentedWarnings: string[] = [...input.warnings];
  if (input.feedbackIntegrity) {
    const agreement = input.feedbackIntegrity.aggregate.feedback_agreement;
    if (agreement < FEEDBACK_AGREEMENT_WARNING_THRESHOLD) {
      augmentedWarnings.push(
        `feedback_agreement_below_threshold: ${agreement.toFixed(2)} < ${FEEDBACK_AGREEMENT_WARNING_THRESHOLD.toFixed(2)} — Track B headline numbers (improvement_slope, over_synthetic_lift) may be unreliable until AGENTS.md guidance for \`akm feedback\` is tightened.`,
      );
    }
  }

  return {
    schemaVersion: 1,
    track: "evolve",
    branch: input.branch,
    commit: input.commit,
    timestamp: input.timestamp,
    agent: { harness: "opencode", model: input.model },
    corpus: {
      domain: input.domain,
      seedsPerArm: input.seedsPerArm,
    },
    proposals: {
      total_proposals: input.proposals.totalProposals,
      total_accepted: input.proposals.totalAccepted,
      acceptance_rate: input.proposals.acceptanceRate,
      lint_pass_rate: input.proposals.lintPassRate,
      rows: input.proposals.rows.map((r) => ({
        asset_ref: r.assetRef,
        proposal_count: r.proposalCount,
        lint_pass_count: r.lintPassCount,
        accepted_count: r.acceptedCount,
      })),
    },
    longitudinal: {
      improvement_slope: input.longitudinal.improvementSlope,
      over_synthetic_lift: input.longitudinal.overSyntheticLift,
      degradation_count: input.longitudinal.degradationCount,
      pre_pass_rate: input.longitudinal.prePassRate,
      post_pass_rate: input.longitudinal.postPassRate,
      synthetic_pass_rate: input.longitudinal.syntheticPassRate,
      degradations: input.longitudinal.degradations.map((d) => ({
        task_id: d.taskId,
        pre_pass_rate: d.prePassRate,
        post_pass_rate: d.postPassRate,
        delta: d.delta,
        failure_mode: d.failureMode,
      })),
    },
    arms: {
      pre: armEnvelope(input.arms.pre),
      post: armEnvelope(input.arms.post),
      synthetic: armEnvelope(input.arms.synthetic),
    },
    perAsset: input.arms.post.perAsset
      ? {
          total_akm_runs: input.arms.post.perAsset.totalAkmRuns,
          rows: input.arms.post.perAsset.rows.map((r) => ({
            asset_ref: r.assetRef,
            load_count: r.loadCount,
            load_count_passing: r.loadCountPassing,
            load_count_failing: r.loadCountFailing,
            load_pass_rate: r.loadPassRate,
          })),
        }
      : { total_akm_runs: 0, rows: [] },
    failure_modes: {
      by_label: input.arms.post.failureModes.byLabel,
      by_task: input.arms.post.failureModes.byTask,
    },
    ...(input.arms.post.searchBridge ? { searchBridge: serialiseSearchBridge(input.arms.post.searchBridge) } : {}),
    ...(input.feedbackIntegrity ? { feedback_integrity: serialiseFeedbackIntegrity(input.feedbackIntegrity) } : {}),
    warnings: augmentedWarnings,
  };
}

/** §6.8 — flatten the FeedbackIntegrityMetrics envelope into JSON. */
function serialiseFeedbackIntegrity(metrics: FeedbackIntegrityMetrics): object {
  return {
    aggregate: {
      truePositive: metrics.aggregate.truePositive,
      falsePositive: metrics.aggregate.falsePositive,
      trueNegative: metrics.aggregate.trueNegative,
      falseNegative: metrics.aggregate.falseNegative,
      feedback_agreement: metrics.aggregate.feedback_agreement,
      false_positive_rate: metrics.aggregate.false_positive_rate,
      false_negative_rate: metrics.aggregate.false_negative_rate,
      feedback_coverage: metrics.aggregate.feedback_coverage,
    },
    perAsset: metrics.perAsset.map((row) => ({
      ref: row.ref,
      truePositive: row.truePositive,
      falsePositive: row.falsePositive,
      trueNegative: row.trueNegative,
      falseNegative: row.falseNegative,
      feedback_agreement: row.feedback_agreement,
      false_positive_rate: row.false_positive_rate,
      false_negative_rate: row.false_negative_rate,
    })),
  };
}

/**
 * Render the §6.8 confusion-matrix table — aggregate 2×2 followed by
 * per-asset breakdown. Used by `renderEvolveReport`'s markdown body and
 * exported for tests.
 */
export function renderFeedbackIntegrityTable(metrics: FeedbackIntegrityMetrics): string {
  const lines: string[] = [];
  const agg = metrics.aggregate;
  lines.push("## Feedback-signal integrity");
  lines.push("");
  lines.push("|              | run passed | run failed |");
  lines.push("|--------------|-----------:|-----------:|");
  lines.push(`| feedback +   | ${agg.truePositive} (TP) | ${agg.falsePositive} (FP) |`);
  lines.push(`| feedback -   | ${agg.falseNegative} (FN) | ${agg.trueNegative} (TN) |`);
  lines.push("");
  lines.push("| metric | value |");
  lines.push("|--------|-------|");
  lines.push(`| feedback_agreement | ${agg.feedback_agreement.toFixed(2)} |`);
  lines.push(`| false_positive_rate | ${agg.false_positive_rate.toFixed(2)} |`);
  lines.push(`| false_negative_rate | ${agg.false_negative_rate.toFixed(2)} |`);
  lines.push(`| feedback_coverage | ${agg.feedback_coverage.toFixed(2)} |`);
  lines.push("");
  if (metrics.perAsset.length > 0) {
    lines.push("| ref | TP | FP | TN | FN | agreement | FP rate | FN rate |");
    lines.push("|-----|----|----|----|----|-----------|---------|---------|");
    for (const row of metrics.perAsset) {
      lines.push(
        `| \`${row.ref}\` | ${row.truePositive} | ${row.falsePositive} | ${row.trueNegative} | ${row.falseNegative} | ${formatNullableRate(row.feedback_agreement)} | ${formatNullableRate(row.false_positive_rate)} | ${formatNullableRate(row.false_negative_rate)} |`,
      );
    }
  } else {
    lines.push("_No feedback events recorded._");
  }
  return lines.join("\n");
}

function formatNullableRate(value: number | null): string {
  if (value === null) return "n/a";
  return value.toFixed(2);
}

function buildEvolveMarkdown(input: EvolveReportInput): string {
  const lines: string[] = [];
  lines.push(`# akm-bench evolve — ${input.model}`);
  lines.push("");
  lines.push(`branch \`${input.branch}\` @ \`${input.commit}\` — ${input.timestamp}`);
  lines.push(`corpus: domain=\`${input.domain}\`, seedsPerArm=${input.seedsPerArm}`);
  lines.push("");

  // §6.8 warning marker — prepended above the headline so operators can't
  // miss it. We also still surface the structured warning in `warnings[]`.
  if (
    input.feedbackIntegrity &&
    input.feedbackIntegrity.aggregate.feedback_agreement < FEEDBACK_AGREEMENT_WARNING_THRESHOLD
  ) {
    lines.push(
      `:warning: feedback_agreement = ${input.feedbackIntegrity.aggregate.feedback_agreement.toFixed(2)} — Track B headline numbers (improvement_slope, over_synthetic_lift) may be unreliable until AGENTS.md guidance for \`akm feedback\` is tightened.`,
    );
    lines.push("");
  }

  // Headline: improvement_slope.
  lines.push(
    `**improvement_slope: ${signedFixed(input.longitudinal.improvementSlope, 2)}** (post=${input.longitudinal.postPassRate.toFixed(2)}, pre=${input.longitudinal.prePassRate.toFixed(2)})`,
  );
  // Second line: real feedback_agreement (per #244), or placeholder when
  // metrics not supplied.
  if (input.feedbackIntegrity) {
    lines.push(
      `**feedback_agreement: ${input.feedbackIntegrity.aggregate.feedback_agreement.toFixed(2)}** (coverage=${input.feedbackIntegrity.aggregate.feedback_coverage.toFixed(2)})`,
    );
  } else {
    lines.push("_feedback_agreement: pending (#244)_");
  }
  lines.push("");

  lines.push("## Longitudinal");
  lines.push("");
  lines.push("| metric | value |");
  lines.push("|--------|-------|");
  lines.push(`| improvement_slope | ${signedFixed(input.longitudinal.improvementSlope, 2)} |`);
  lines.push(`| over_synthetic_lift | ${signedFixed(input.longitudinal.overSyntheticLift, 2)} |`);
  lines.push(`| degradation_count | ${input.longitudinal.degradationCount} |`);
  lines.push(`| pre_pass_rate | ${input.longitudinal.prePassRate.toFixed(2)} |`);
  lines.push(`| post_pass_rate | ${input.longitudinal.postPassRate.toFixed(2)} |`);
  lines.push(`| synthetic_pass_rate | ${input.longitudinal.syntheticPassRate.toFixed(2)} |`);
  lines.push("");

  if (input.longitudinal.degradations.length > 0) {
    lines.push("### Degradations");
    lines.push("");
    lines.push("| task | pre | post | delta | failure_mode |");
    lines.push("|------|-----|------|-------|--------------|");
    for (const d of input.longitudinal.degradations) {
      lines.push(
        `| ${d.taskId} | ${d.prePassRate.toFixed(2)} | ${d.postPassRate.toFixed(2)} | ${signedFixed(d.delta, 2)} | ${d.failureMode ?? "n/a"} |`,
      );
    }
    lines.push("");
  }

  lines.push("## Proposals");
  lines.push("");
  lines.push(
    `acceptance_rate=${input.proposals.acceptanceRate.toFixed(2)}, lint_pass_rate=${input.proposals.lintPassRate.toFixed(2)}, total=${input.proposals.totalProposals}`,
  );
  lines.push("");
  if (input.proposals.rows.length > 0) {
    lines.push("| asset_ref | proposals | lint_pass | accepted |");
    lines.push("|-----------|-----------|-----------|----------|");
    for (const row of input.proposals.rows) {
      lines.push(`| \`${row.assetRef}\` | ${row.proposalCount} | ${row.lintPassCount} | ${row.acceptedCount} |`);
    }
    lines.push("");
  } else {
    lines.push("_No proposals generated._");
    lines.push("");
  }

  lines.push("## Per-task pre → post → synthetic");
  lines.push("");
  lines.push("| task | pre | post | synthetic | post − pre |");
  lines.push("|------|-----|------|-----------|------------|");
  const preTasks = new Map<string, UtilityReportTaskEntry>();
  for (const t of input.arms.pre.tasks) preTasks.set(t.id, t);
  const postTasks = new Map<string, UtilityReportTaskEntry>();
  for (const t of input.arms.post.tasks) postTasks.set(t.id, t);
  const synthTasks = new Map<string, UtilityReportTaskEntry>();
  for (const t of input.arms.synthetic.tasks) synthTasks.set(t.id, t);
  const allIds = new Set<string>([...preTasks.keys(), ...postTasks.keys(), ...synthTasks.keys()]);
  for (const id of [...allIds].sort()) {
    const pre = preTasks.get(id)?.akm.passRate;
    const post = postTasks.get(id)?.akm.passRate;
    const synth = synthTasks.get(id)?.akm.passRate;
    const delta = pre !== undefined && post !== undefined ? signedFixed(post - pre, 2) : "n/a";
    lines.push(
      `| ${id} | ${pre === undefined ? "n/a" : pre.toFixed(2)} | ${post === undefined ? "n/a" : post.toFixed(2)} | ${synth === undefined ? "n/a" : synth.toFixed(2)} | ${delta} |`,
    );
  }

  if (input.feedbackIntegrity) {
    lines.push("");
    lines.push(renderFeedbackIntegrityTable(input.feedbackIntegrity));
  }

  if (input.warnings.length > 0) {
    lines.push("");
    lines.push("## Warnings");
    lines.push("");
    for (const w of input.warnings) lines.push(`- ${w}`);
  }
  return lines.join("\n");
}
