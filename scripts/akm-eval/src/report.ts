/**
 * Markdown report renderer.
 *
 * Operator-readable rollup of an EvalRunResult. JSON and JSONL artifacts
 * are the durable contract; Markdown is a convenience.
 */

import type { EvalCaseResult, EvalRunResult } from "./types";

function pct(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return `${(n * 100).toFixed(1)}%`;
}

function fmtScore(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return n.toFixed(3);
}

export function renderMarkdown(run: EvalRunResult, results: EvalCaseResult[]): string {
  const lines: string[] = [];
  lines.push(`# akm-eval — ${run.suite} — \`${run.mode}\``);
  lines.push("");
  if (run.label) lines.push(`**Label:** \`${run.label}\``);
  lines.push(`**Run ID:** \`${run.evalRunId}\``);
  lines.push(`**Started:** ${run.startedAt}`);
  lines.push(`**Duration:** ${(run.durationMs / 1000).toFixed(2)}s`);
  if (run.akm.version) lines.push(`**akm version:** \`${run.akm.version}\``);
  if (run.akm.stashRoot) lines.push(`**Stash:** \`${run.akm.stashRoot}\``);
  lines.push("");

  lines.push("## Scores");
  lines.push("");
  lines.push("| Score | Value |");
  lines.push("| --- | ---: |");
  lines.push(`| Overall | ${fmtScore(run.scores.overall)} |`);
  lines.push(`| Deterministic | ${fmtScore(run.scores.deterministic)} |`);
  if (run.scores.llmJudged !== undefined) {
    lines.push(`| LLM-judged | ${fmtScore(run.scores.llmJudged)} |`);
  }
  if (run.scores.baseline !== undefined) {
    lines.push(`| Baseline | ${fmtScore(run.scores.baseline)} |`);
  }
  if (run.scores.delta !== undefined) {
    lines.push(`| Delta | ${run.scores.delta >= 0 ? "+" : ""}${fmtScore(run.scores.delta)} |`);
  }
  lines.push("");

  lines.push("## Cases by type");
  lines.push("");
  lines.push("| Type | Run | Passed | Skipped |");
  lines.push("| --- | ---: | ---: | ---: |");
  for (const [type, counts] of Object.entries(run.countsByType)) {
    if (counts.run === 0 && counts.skipped === 0) continue;
    lines.push(`| ${type} | ${counts.run} | ${counts.passed} | ${counts.skipped} |`);
  }
  lines.push("");

  if (run.errors.length > 0) {
    lines.push("## Errors");
    lines.push("");
    for (const e of run.errors) {
      lines.push(`- \`${e.caseId}\`: ${e.message}`);
    }
    lines.push("");
  }

  if (run.regressions && run.regressions.length > 0) {
    lines.push("## Regressions");
    lines.push("");
    lines.push("| Case | Previous | Current | Reason |");
    lines.push("| --- | ---: | ---: | --- |");
    for (const r of run.regressions) {
      lines.push(`| \`${r.caseId}\` | ${fmtScore(r.previousScore)} | ${fmtScore(r.currentScore)} | ${r.reason} |`);
    }
    lines.push("");
  }

  // Per-type metrics highlights
  const proposalMetrics = results.find((r) => r.type === "proposal-quality")?.metrics as
    | {
        counts?: Record<string, number>;
        validationPassRate?: number | null;
        acceptRate?: number | null;
        rejectRate?: number | null;
        bySource?: Record<string, { total: number; accepted: number; rejected: number; acceptRate: number | null }>;
      }
    | undefined;

  if (proposalMetrics?.bySource) {
    lines.push("## Accept-rate by source");
    lines.push("");
    lines.push("| Source | Total | Accepted | Rejected | Accept-rate |");
    lines.push("| --- | ---: | ---: | ---: | ---: |");
    const sources = Object.keys(proposalMetrics.bySource).sort();
    for (const s of sources) {
      const row = proposalMetrics.bySource[s];
      lines.push(`| \`${s}\` | ${row.total} | ${row.accepted} | ${row.rejected} | ${pct(row.acceptRate)} |`);
    }
    lines.push("");
  }

  lines.push("## Case results");
  lines.push("");
  lines.push("| Case | Type | Score | Status |");
  lines.push("| --- | --- | ---: | --- |");
  for (const r of results) {
    const status = r.skipped ? `skipped (${r.skipReason ?? "no reason"})` : r.passed ? "pass" : "fail";
    lines.push(`| \`${r.caseId}\` | ${r.type} | ${fmtScore(r.score)} | ${status} |`);
  }
  lines.push("");

  lines.push("## Artifacts");
  lines.push("");
  for (const [name, file] of Object.entries(run.artifacts)) {
    lines.push(`- ${name}: \`${file}\``);
  }
  lines.push("");

  return lines.join("\n");
}
