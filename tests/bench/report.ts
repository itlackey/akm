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
  OutcomeAggregate,
  PerAssetAttribution,
  PerTaskMetrics,
  TrajectoryAggregate,
} from "./metrics";

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
 * Per-task envelope inside `tasks[]`. Mirrors the §13.3 layout: `noakm` and
 * `akm` are PerTaskMetrics, `delta` is the akm − noakm difference.
 */
export interface UtilityReportTaskEntry {
  id: string;
  noakm: PerTaskMetrics;
  akm: PerTaskMetrics;
  delta: CorpusDelta;
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
  };
  aggregateNoakm: CorpusMetrics;
  aggregateAkm: CorpusMetrics;
  aggregateDelta: CorpusDelta;
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
   * Task metadata for in-process consumers (the masked-corpus helper needs
   * to remap each task's stash to a tmp dir). Not serialised into the §13.3
   * envelope — the existing `tasks[]` carries the public per-task aggregates.
   */
  taskMetadata?: TaskMetadata[];
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
  const tasks = input.tasks.map((t) => ({
    id: t.id,
    noakm: serialisePerTaskMetrics(t.noakm),
    akm: serialisePerTaskMetrics(t.akm),
    delta: serialiseDelta(t.delta),
  }));

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
    tasks,
    warnings: input.warnings,
  };

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
  lines.push(corpusRow("akm", input.aggregateAkm));
  lines.push(deltaRow(input.aggregateDelta));
  lines.push("");
  lines.push("## Trajectory (akm)");
  lines.push("");
  lines.push(`- correct_asset_loaded: ${formatPercent(input.trajectoryAkm.correctAssetLoaded)}`);
  lines.push(`- feedback_recorded: ${formatPercent(input.trajectoryAkm.feedbackRecorded)}`);
  lines.push("");
  lines.push("## Per-task pass rates");
  lines.push("");
  lines.push("| task | noakm | akm | delta |");
  lines.push("|------|-------|-----|-------|");
  // Sort tasks alphabetically for byte-stable markdown output.
  const sorted = [...input.tasks].sort((a, b) => a.id.localeCompare(b.id));
  for (const t of sorted) {
    lines.push(taskRow(t));
  }
  // Failure-mode breakdown (§6.6). Appended near the bottom so the headline
  // pass-rate / trajectory tables stay visually anchored at the top.
  const failureSection = renderFailureModeBreakdown(input);
  if (failureSection.length > 0) {
    lines.push("");
    lines.push(failureSection);
  }
  if (input.warnings.length > 0) {
    lines.push("");
    lines.push("## Warnings");
    lines.push("");
    for (const w of input.warnings) lines.push(`- ${w}`);
  }
  return lines.join("\n");
}

function corpusRow(arm: string, c: CorpusMetrics): string {
  const tpp = c.tokensPerPass === null ? "n/a" : c.tokensPerPass.toFixed(0);
  return `| ${arm} | ${c.passRate.toFixed(2)} | ${tpp} | ${c.wallclockMs.toFixed(0)} |`;
}

function deltaRow(d: CorpusDelta): string {
  const tpp = d.tokensPerPass === null ? "n/a" : signed(d.tokensPerPass.toFixed(0));
  return `| **delta** | ${signed(d.passRate.toFixed(2))} | ${tpp} | ${signed(d.wallclockMs.toFixed(0))} |`;
}

function taskRow(t: UtilityReportTaskEntry): string {
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
