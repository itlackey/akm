#!/usr/bin/env bun
/**
 * akm-eval-trend — TSV trend across the last N eval runs.
 *
 * Walks `<stash>/.akm/evals/runs/*` oldest-first and prints one row per
 * eval-result.json with the requested metric. Pipe to `column -t` for a
 * pretty table.
 *
 * Default metric is `overall` (`scores.overall`); `--metric deterministic`
 * picks `scores.deterministic`; any other value is first looked up in
 * METRIC_ALIASES (short names like `schemaShapeRate`, `noOpRefuseRate`)
 * and then treated as a dot-separated path into the envelope (e.g.
 * `--metric countsByType.retrieval.passed`).
 */

import path from "node:path";
import {
  listRunIds,
  loadEvalRunResult,
} from "./sources/eval-runs";
import { resolveEvalsRoot, resolveStashDir } from "./sources/paths";
import type { EvalRunResult } from "./types";

interface CliOptions {
  stash?: string;
  suite?: string;
  limit: number;
  metric: string;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { limit: 20, metric: "overall" };
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
      case "--suite":
        opts.suite = next();
        break;
      case "--limit":
        opts.limit = Number(next());
        break;
      case "--metric":
        opts.metric = next();
        break;
      case "-h":
      case "--help":
        printHelp();
        process.exit(0);
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  return opts;
}

function printHelp(): void {
  process.stdout.write(`akm-eval-trend — TSV trend across eval runs

Usage:
  akm-eval-trend [options]

Options:
  --stash <path>   Stash root (default: $AKM_STASH_DIR or ~/akm).
  --suite <name>   Only include runs from this suite.
  --limit <N>      Max runs to include (default: 20). Most recent N kept.
  --metric <key>   overall | deterministic | <alias> | <dotted.path> (default: overall).
                   Reflect aliases: schemaShapeRate, contentPolicyRate,
                   reflectSuccessRate, llmTouchedReflects
                   (under metrics.reflectQuality.*).
                   Planner aliases: noOpRefuseRate, noOpRefuseRateLlmTouched,
                   plannerRefuses, plannerActions
                   (under metrics.plannerWaste.*).

Output is tab-separated: ts  suite  mode  label  <metric>
Pipe to \`column -t\` for a table.
`);
}

function getByPath(obj: unknown, dotted: string): unknown {
  let cur: unknown = obj;
  for (const segment of dotted.split(".")) {
    if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[segment];
  }
  return cur;
}

/**
 * Convenience aliases for metrics that are buried under `metrics.*` but
 * referenced often enough to deserve a short name. Keep this list small;
 * the canonical access path is still the dotted form.
 */
const METRIC_ALIASES: Record<string, string> = {
  // Reflect-quality (PR 3 gate). Hoisted into env.metrics.reflectQuality
  // by src/run.ts when a reflect-failure-breakdown case ran.
  schemaShapeRate: "metrics.reflectQuality.schemaShapeRate",
  contentPolicyRate: "metrics.reflectQuality.contentPolicyRate",
  reflectSuccessRate: "metrics.reflectQuality.successRate",
  llmTouchedReflects: "metrics.reflectQuality.counts.llmTouched",
  // Planner-waste. Hoisted into env.metrics.plannerWaste by src/run.ts
  // when a planner-waste-breakdown case ran.
  noOpRefuseRate: "metrics.plannerWaste.noOpRefuseRate",
  noOpRefuseRateLlmTouched: "metrics.plannerWaste.noOpRefuseRateLlmTouched",
  plannerRefuses: "metrics.plannerWaste.counts.noOpRefuses",
  plannerActions: "metrics.plannerWaste.counts.totalActions",
};

function resolveMetric(env: EvalRunResult, metric: string): string {
  let value: unknown;
  if (metric === "overall") value = env.scores.overall;
  else if (metric === "deterministic") value = env.scores.deterministic;
  else if (METRIC_ALIASES[metric]) value = getByPath(env, METRIC_ALIASES[metric]);
  else value = getByPath(env, metric);
  if (value === undefined || value === null) return "—";
  if (typeof value === "number") return Number.isFinite(value) ? value.toFixed(3) : String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

async function main(): Promise<number> {
  const opts = parseArgs(process.argv.slice(2));
  const stashRoot = resolveStashDir(opts.stash);
  const runsRoot = path.join(resolveEvalsRoot(stashRoot), "runs");
  const allIds = listRunIds(runsRoot);

  const candidates: Array<{ id: string; env: EvalRunResult }> = [];
  for (const id of allIds) {
    let env: EvalRunResult;
    try {
      env = loadEvalRunResult(path.join(runsRoot, id));
    } catch (error) {
      throw new Error(`failed to load eval run ${id}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (opts.suite && env.suite !== opts.suite) continue;
    candidates.push({ id, env });
  }

  const selected =
    opts.limit > 0 && candidates.length > opts.limit ? candidates.slice(candidates.length - opts.limit) : candidates;
  const rows: Array<{ ts: string; suite: string; mode: string; label: string; metric: string }> = [];
  const fingerprintsBySuite = new Map<string, string>();
  for (const { id, env } of selected) {
    const fingerprint = env.inputs.suiteFingerprint;
    if (!fingerprint) throw new Error(`suite fingerprint unavailable for eval run ${id}`);
    const prior = fingerprintsBySuite.get(env.suite);
    if (prior && prior !== fingerprint) {
      throw new Error(`mixed suite fingerprints for ${env.suite}: ${prior} and ${fingerprint}`);
    }
    fingerprintsBySuite.set(env.suite, fingerprint);
    rows.push({
      ts: env.startedAt,
      suite: env.suite,
      mode: env.mode,
      label: env.label ?? "—",
      metric: resolveMetric(env, opts.metric),
    });
  }

  process.stdout.write(`ts\tsuite\tmode\tlabel\t${opts.metric}\n`);
  for (const r of rows) {
    process.stdout.write(`${r.ts}\t${r.suite}\t${r.mode}\t${r.label}\t${r.metric}\n`);
  }
  return 0;
}

if (import.meta.main) {
  try {
    const code = await main();
    process.exit(code);
  } catch (err) {
    process.stderr.write(`[akm-eval-trend] ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  }
}
