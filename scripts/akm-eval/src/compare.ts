#!/usr/bin/env bun
/**
 * akm-eval-compare — diff two eval runs.
 *
 * Resolves baseline/akm run ids (each may be "latest"), reports overall
 * + per-type score deltas, regressions, newly-passing, newly-failing,
 * and writes a JSON comparison artifact next to the more recent run.
 */

import fs from "node:fs";
import path from "node:path";
import { diffCaseResults } from "./runners/regression";
import { aggregateScores } from "./scoring";
import {
  loadCaseResults,
  loadEvalRunResult,
  resolveRunDir,
  assertMatchingSuiteFingerprints,
} from "./sources/eval-runs";
import { resolveEvalsRoot, resolveStashDir } from "./sources/paths";
import type { EvalCaseResult, EvalCaseType, EvalRunResult } from "./types";

interface CliOptions {
  baseline: string;
  current: string;
  stash?: string;
  format: "json" | "md";
  threshold: number;
  out?: string;
}

export interface CompareResult {
  schemaVersion: 1;
  baseline: { runId: string; dir: string; envelope: EvalRunResult };
  current: { runId: string; dir: string; envelope: EvalRunResult };
  scores: {
    baseline: { overall: number; deterministic: number };
    current: { overall: number; deterministic: number };
    delta: { overall: number; deterministic: number };
  };
  byType: Record<
    string,
    { baseline: number; current: number; delta: number; baselineRun: number; currentRun: number }
  >;
  diff: ReturnType<typeof diffCaseResults>;
  newlyFailing: Array<{ caseId: string; type: EvalCaseType; previousScore: number; currentScore: number }>;
  newlyPassing: Array<{ caseId: string; type: EvalCaseType; previousScore: number | null; currentScore: number }>;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    baseline: "",
    current: "",
    format: "md",
    threshold: 0.1,
  };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`missing value for ${arg}`);
      return v;
    };
    switch (arg) {
      case "--stash":
        opts.stash = next();
        break;
      case "--format": {
        const v = next();
        if (v !== "json" && v !== "md") throw new Error(`--format must be json|md`);
        opts.format = v;
        break;
      }
      case "--threshold":
        opts.threshold = Number(next());
        break;
      case "--out":
        opts.out = next();
        break;
      case "-h":
      case "--help":
        printHelp();
        process.exit(0);
        break;
      default:
        if (arg.startsWith("--")) throw new Error(`unknown argument: ${arg}`);
        positional.push(arg);
    }
  }
  if (positional.length < 2) {
    throw new Error(
      `usage: akm-eval-compare <baseline-id|latest> <current-id|latest> [--stash <path>] [--format json|md] [--threshold 0.1]`,
    );
  }
  opts.baseline = positional[0];
  opts.current = positional[1];
  return opts;
}

function printHelp(): void {
  process.stdout.write(`akm-eval-compare — diff two eval runs

Usage:
  akm-eval-compare <baseline-id|latest> <current-id|latest> [options]

Options:
  --stash <path>          Stash root (default: $AKM_STASH_DIR or ~/akm).
  --format json|md        Output format (default: md).
  --threshold <0..1>      Min score drop counted as regression (default: 0.1).
  --out <path>            Write comparison JSON to this path (overrides default).
`);
}

export function buildCompareResult(
  baseline: { runId: string; dir: string },
  current: { runId: string; dir: string },
  threshold: number,
): CompareResult {
  const baselineEnvelope = loadEvalRunResult(baseline.dir);
  const currentEnvelope = loadEvalRunResult(current.dir);
  assertMatchingSuiteFingerprints(
    baselineEnvelope.inputs.suiteFingerprint,
    currentEnvelope.inputs.suiteFingerprint,
  );
  const baselineResults = loadCaseResults(baseline.dir);
  const currentResults = loadCaseResults(current.dir);

  const baselineScores = aggregateScores(baselineResults);
  const currentScores = aggregateScores(currentResults);
  const diff = diffCaseResults(baselineResults, currentResults, { threshold });

  const byType: CompareResult["byType"] = {};
  for (const type of Object.keys(baselineScores.byType) as EvalCaseType[]) {
    const b = baselineScores.byType[type];
    const c = currentScores.byType[type];
    if (b.run === 0 && c.run === 0) continue;
    byType[type] = {
      baseline: b.score,
      current: c.score,
      delta: c.score - b.score,
      baselineRun: b.run,
      currentRun: c.run,
    };
  }

  const newlyFailing = diff.regressions
    .filter((r) => r.reason === "newly-failing")
    .map((r) => ({ caseId: r.caseId, type: r.type, previousScore: r.previousScore, currentScore: r.currentScore }));

  return {
    schemaVersion: 1,
    baseline: { runId: baseline.runId, dir: baseline.dir, envelope: baselineEnvelope },
    current: { runId: current.runId, dir: current.dir, envelope: currentEnvelope },
    scores: {
      baseline: { overall: baselineScores.overall, deterministic: baselineScores.deterministic },
      current: { overall: currentScores.overall, deterministic: currentScores.deterministic },
      delta: {
        overall: currentScores.overall - baselineScores.overall,
        deterministic: currentScores.deterministic - baselineScores.deterministic,
      },
    },
    byType,
    diff,
    newlyFailing,
    newlyPassing: diff.newlyPassing,
  };
}

function fmt(n: number): string {
  return n.toFixed(3);
}

function signed(n: number): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(3)}`;
}

export function renderCompareMarkdown(c: CompareResult): string {
  const lines: string[] = [];
  lines.push(`# akm-eval-compare — \`${c.baseline.envelope.suite}\``);
  lines.push("");
  lines.push(`**Baseline:** \`${c.baseline.runId}\`${c.baseline.envelope.label ? ` (\`${c.baseline.envelope.label}\`)` : ""}`);
  lines.push(`**Current:**  \`${c.current.runId}\`${c.current.envelope.label ? ` (\`${c.current.envelope.label}\`)` : ""}`);
  lines.push("");
  lines.push("## Score deltas");
  lines.push("");
  lines.push("| Score | Baseline | Current | Delta |");
  lines.push("| --- | ---: | ---: | ---: |");
  lines.push(`| Overall | ${fmt(c.scores.baseline.overall)} | ${fmt(c.scores.current.overall)} | ${signed(c.scores.delta.overall)} |`);
  lines.push(`| Deterministic | ${fmt(c.scores.baseline.deterministic)} | ${fmt(c.scores.current.deterministic)} | ${signed(c.scores.delta.deterministic)} |`);
  lines.push("");

  const typeEntries = Object.entries(c.byType);
  if (typeEntries.length > 0) {
    lines.push("## Per-type score deltas");
    lines.push("");
    lines.push("| Type | Baseline (n) | Current (n) | Baseline | Current | Delta |");
    lines.push("| --- | ---: | ---: | ---: | ---: | ---: |");
    for (const [type, row] of typeEntries) {
      lines.push(`| ${type} | ${row.baselineRun} | ${row.currentRun} | ${fmt(row.baseline)} | ${fmt(row.current)} | ${signed(row.delta)} |`);
    }
    lines.push("");
  }

  if (c.diff.regressions.length > 0) {
    lines.push(`## Regressions (threshold ${c.diff.threshold})`);
    lines.push("");
    lines.push("| Case | Type | Previous | Current | Delta | Reason |");
    lines.push("| --- | --- | ---: | ---: | ---: | --- |");
    for (const r of c.diff.regressions) {
      lines.push(`| \`${r.caseId}\` | ${r.type} | ${fmt(r.previousScore)} | ${fmt(r.currentScore)} | ${signed(r.delta)} | ${r.reason} |`);
    }
    lines.push("");
  } else {
    lines.push("## Regressions");
    lines.push("");
    lines.push("_None._");
    lines.push("");
  }

  if (c.newlyPassing.length > 0) {
    lines.push("## Newly passing");
    lines.push("");
    lines.push("| Case | Type | Previous | Current |");
    lines.push("| --- | --- | ---: | ---: |");
    for (const r of c.newlyPassing) {
      const prev = r.previousScore === null ? "—" : fmt(r.previousScore);
      lines.push(`| \`${r.caseId}\` | ${r.type} | ${prev} | ${fmt(r.currentScore)} |`);
    }
    lines.push("");
  }

  if (c.newlyFailing.length > 0) {
    lines.push("## Newly failing");
    lines.push("");
    lines.push("| Case | Type | Previous | Current |");
    lines.push("| --- | --- | ---: | ---: |");
    for (const r of c.newlyFailing) {
      lines.push(`| \`${r.caseId}\` | ${r.type} | ${fmt(r.previousScore)} | ${fmt(r.currentScore)} |`);
    }
    lines.push("");
  }

  if (c.diff.added.length > 0) {
    lines.push("## Cases added since baseline");
    lines.push("");
    lines.push("| Case | Type | Current | Pass |");
    lines.push("| --- | --- | ---: | --- |");
    for (const r of c.diff.added) {
      lines.push(`| \`${r.caseId}\` | ${r.type} | ${fmt(r.currentScore)} | ${r.currentPassed ? "yes" : "no"} |`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

async function main(): Promise<number> {
  const opts = parseArgs(process.argv.slice(2));
  const stashRoot = resolveStashDir(opts.stash);
  const runsRoot = path.join(resolveEvalsRoot(stashRoot), "runs");
  const baseline = resolveRunDir(runsRoot, opts.baseline);
  const current = resolveRunDir(runsRoot, opts.current);

  const result = buildCompareResult(baseline, current, opts.threshold);

  const outPath = opts.out
    ? path.resolve(opts.out)
    : path.join(current.dir, `compare-vs-${baseline.runId}.json`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);

  if (opts.format === "json") {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(renderCompareMarkdown(result));
  }
  process.stderr.write(`[akm-eval-compare] wrote ${outPath}\n`);

  // Exit non-zero if regressions or missing cases.
  return result.diff.regressions.length > 0 ? 1 : 0;
}

// Helper for callers that already have results in-memory (e.g. paired mode).
export function compareResultsInMemory(
  baseline: { runId: string; dir: string; envelope: EvalRunResult; results: EvalCaseResult[] },
  current: { runId: string; dir: string; envelope: EvalRunResult; results: EvalCaseResult[] },
  threshold: number,
): CompareResult {
  assertMatchingSuiteFingerprints(
    baseline.envelope.inputs.suiteFingerprint,
    current.envelope.inputs.suiteFingerprint,
  );
  const baselineScores = aggregateScores(baseline.results);
  const currentScores = aggregateScores(current.results);
  const diff = diffCaseResults(baseline.results, current.results, { threshold });

  const byType: CompareResult["byType"] = {};
  for (const type of Object.keys(baselineScores.byType) as EvalCaseType[]) {
    const b = baselineScores.byType[type];
    const cur = currentScores.byType[type];
    if (b.run === 0 && cur.run === 0) continue;
    byType[type] = {
      baseline: b.score,
      current: cur.score,
      delta: cur.score - b.score,
      baselineRun: b.run,
      currentRun: cur.run,
    };
  }

  const newlyFailing = diff.regressions
    .filter((r) => r.reason === "newly-failing")
    .map((r) => ({ caseId: r.caseId, type: r.type, previousScore: r.previousScore, currentScore: r.currentScore }));

  return {
    schemaVersion: 1,
    baseline: { runId: baseline.runId, dir: baseline.dir, envelope: baseline.envelope },
    current: { runId: current.runId, dir: current.dir, envelope: current.envelope },
    scores: {
      baseline: { overall: baselineScores.overall, deterministic: baselineScores.deterministic },
      current: { overall: currentScores.overall, deterministic: currentScores.deterministic },
      delta: {
        overall: currentScores.overall - baselineScores.overall,
        deterministic: currentScores.deterministic - baselineScores.deterministic,
      },
    },
    byType,
    diff,
    newlyFailing,
    newlyPassing: diff.newlyPassing,
  };
}

if (import.meta.main) {
  try {
    const code = await main();
    process.exit(code);
  } catch (err) {
    process.stderr.write(`[akm-eval-compare] ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  }
}
