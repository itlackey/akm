#!/usr/bin/env bun
/**
 * akm-eval orchestrator.
 *
 * Usage:
 *   bun run scripts/akm-eval/src/run.ts \
 *     --suite improve-smoke \
 *     [--mode baseline|akm|paired] \
 *     [--stash <path>] \
 *     [--cases-dir <path>] \
 *     [--out <path>] \
 *     [--label <label>] \
 *     [--akm <bin>] \
 *     [--format json|md|none] \
 *     [--fail-below-score <0..1>] \
 *     [--fail-on-regression] \
 *     [--improve-args "..."] \
 *     [--sandbox | --no-sandbox | --allow-mutate] \
 *     [--keep-sandbox] \
 *     [--threshold <0..1>]
 *
 * Phase 2: --mode paired runs the suite twice (baseline → akm improve →
 * re-eval) and writes a merged envelope with delta scores. Default for
 * paired mode is --sandbox (copies the stash to a tmpdir and runs against
 * the copy); use --no-sandbox or --allow-mutate to mutate the real stash.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { compareResultsInMemory } from "./compare";
import { diffCaseResults } from "./runners/regression";
import { runMemorySafetyCase } from "./runners/memory-safety";
import { runProposalQualityCase } from "./runners/proposal-quality";
import { runRegressionCase } from "./runners/regression";
import { runRetrievalCase } from "./runners/retrieval";
import { runWorkflowComplianceCase } from "./runners/workflow-compliance";
import { renderMarkdown } from "./report";
import { aggregateScores, buildCountsByType } from "./scoring";
import { AkmCli } from "./sources/akm-cli";
import { resolveDataDir, resolveEvalsRoot, resolveStashDir } from "./sources/paths";
import { createSandbox, type Sandbox } from "./sources/sandbox";
import type { EvalCase, EvalCaseResult, EvalContext, EvalMode, EvalRunResult } from "./types";

interface CliOptions {
  suite: string;
  mode: EvalMode;
  stash?: string;
  casesDir?: string;
  out?: string;
  label?: string;
  akmBin: string;
  format: "json" | "md" | "none";
  failBelowScore?: number;
  failOnRegression: boolean;
  improveArgs: string[];
  sandbox: boolean;
  keepSandbox: boolean;
  threshold: number;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    suite: "improve-smoke",
    mode: "baseline",
    akmBin: process.env.AKM_BIN ?? "akm",
    format: "md",
    failOnRegression: false,
    improveArgs: [],
    sandbox: true,
    keepSandbox: false,
    threshold: 0.1,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`missing value for ${arg}`);
      return v;
    };
    switch (arg) {
      case "--suite":
        opts.suite = next();
        break;
      case "--mode": {
        const v = next();
        if (v !== "baseline" && v !== "akm" && v !== "paired") {
          throw new Error(`--mode must be baseline|akm|paired (got ${v})`);
        }
        opts.mode = v;
        break;
      }
      case "--stash":
        opts.stash = next();
        break;
      case "--cases-dir":
        opts.casesDir = next();
        break;
      case "--out":
        opts.out = next();
        break;
      case "--label":
        opts.label = next();
        break;
      case "--akm":
        opts.akmBin = next();
        break;
      case "--format": {
        const v = next();
        if (v !== "json" && v !== "md" && v !== "none") {
          throw new Error(`--format must be json|md|none (got ${v})`);
        }
        opts.format = v;
        break;
      }
      case "--fail-below-score":
        opts.failBelowScore = Number(next());
        break;
      case "--fail-on-regression":
        opts.failOnRegression = true;
        break;
      case "--improve-args":
        opts.improveArgs = tokenize(next());
        break;
      case "--sandbox":
        opts.sandbox = true;
        break;
      case "--no-sandbox":
      case "--allow-mutate":
        opts.sandbox = false;
        break;
      case "--keep-sandbox":
        opts.keepSandbox = true;
        break;
      case "--threshold":
        opts.threshold = Number(next());
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

/**
 * Minimal shell-style tokenizer (whitespace-split, single/double quote aware).
 * Sufficient for `--improve-args "--limit 10 --timeout-ms 600000"` plumbing.
 */
function tokenize(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur !== "") {
        out.push(cur);
        cur = "";
      }
      continue;
    }
    cur += ch;
  }
  if (cur !== "") out.push(cur);
  return out;
}

function printHelp(): void {
  process.stdout.write(`akm-eval run — Phase 2

Usage:
  bun run scripts/akm-eval/src/run.ts --suite <name> [options]

Options:
  --suite <name>             Eval suite to run (default: improve-smoke).
  --mode baseline|akm|paired Eval mode.
                              baseline: read-only single pass (default).
                              akm:      single pass after akm improve (caller-driven).
                              paired:   baseline → akm improve → re-eval, with deltas.
  --stash <path>             Stash root (default: \$AKM_STASH_DIR or ~/akm).
  --cases-dir <path>         Root containing <suite>/*.json case files
                             (default: scripts/akm-eval/cases/).
  --out <path>               Output root (default: <stash>/.akm/evals).
  --label <label>            Optional label recorded in eval-result.json.
  --akm <bin>                Path to akm binary (default: \$AKM_BIN or 'akm').
  --format json|md|none      Stdout summary format (default: md).
  --fail-below-score <0..1>  Exit non-zero if overall score is below this.
  --fail-on-regression       Exit non-zero if paired-mode produces regressions.
  --improve-args "<...>"     Args forwarded to \`akm improve\` in paired mode.
  --sandbox                  Paired mode: copy stash to tmpdir and run there (default).
  --no-sandbox               Paired mode: mutate the real stash. Implies --allow-mutate.
  --allow-mutate             Alias for --no-sandbox.
  --keep-sandbox             Don't delete the sandbox tmpdir on success.
  --threshold <0..1>         Score-drop threshold for regression diff (default: 0.1).
`);
}

function defaultCasesRoot(): string {
  return path.resolve(path.join(import.meta.dir, "..", "cases"));
}

function buildEvalRunId(now: Date = new Date()): string {
  const iso = now.toISOString().replace(/[:.]/g, "-");
  const rand = crypto.randomBytes(4).toString("hex");
  return `${iso}-${rand}`;
}

function loadCases(casesRoot: string, suite: string): EvalCase[] {
  const suiteDir = path.join(casesRoot, suite);
  if (!fs.existsSync(suiteDir)) {
    throw new Error(`suite directory not found: ${suiteDir}`);
  }
  const files = fs
    .readdirSync(suiteDir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  const cases: EvalCase[] = [];
  for (const f of files) {
    const file = path.join(suiteDir, f);
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch (err) {
      throw new Error(`failed to read ${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
    let parsed: EvalCase;
    try {
      parsed = JSON.parse(raw) as EvalCase;
    } catch (err) {
      throw new Error(`invalid JSON in ${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (parsed.schemaVersion !== 1) {
      throw new Error(`unsupported schemaVersion in ${file}: ${parsed.schemaVersion}`);
    }
    if (!parsed.id || !parsed.type) {
      throw new Error(`case ${file} is missing required id/type`);
    }
    cases.push(parsed);
  }
  return cases;
}

async function runCase(c: EvalCase, ctx: EvalContext): Promise<EvalCaseResult> {
  switch (c.type) {
    case "retrieval":
      return runRetrievalCase(c, ctx);
    case "proposal-quality":
      return runProposalQualityCase(c, ctx);
    case "regression":
      return runRegressionCase(c, ctx);
    case "memory-safety":
      return runMemorySafetyCase(c, ctx);
    case "workflow-compliance":
      return runWorkflowComplianceCase(c, ctx);
    default:
      return {
        caseId: c.id,
        type: c.type,
        score: 0,
        passed: false,
        skipped: true,
        skipReason: `runner not implemented yet (type: ${c.type})`,
        metrics: {},
        evidence: {},
        durationMs: 0,
      };
  }
}

async function runCases(cases: EvalCase[], ctx: EvalContext): Promise<EvalCaseResult[]> {
  const collected: EvalCaseResult[] = [];
  for (const c of cases) {
    const stepCtx: EvalContext = { ...ctx, currentResults: collected.slice() };
    const result = await runCase(c, stepCtx);
    collected.push(result);
  }
  return collected;
}

function writeArtifacts(
  runDir: string,
  envelope: EvalRunResult,
  results: EvalCaseResult[],
  extra?: { baselineResults?: EvalCaseResult[]; pairedComparison?: unknown },
): void {
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "eval-result.json"), `${JSON.stringify(envelope, null, 2)}\n`);
  const jsonl = results.map((r) => JSON.stringify(r)).join("\n");
  fs.writeFileSync(path.join(runDir, "case-results.jsonl"), `${jsonl}\n`);
  fs.writeFileSync(path.join(runDir, "report.md"), renderMarkdown(envelope, results));
  if (extra?.baselineResults) {
    const baselineJsonl = extra.baselineResults.map((r) => JSON.stringify(r)).join("\n");
    fs.mkdirSync(path.join(runDir, "artifacts"), { recursive: true });
    fs.writeFileSync(path.join(runDir, "artifacts", "baseline-case-results.jsonl"), `${baselineJsonl}\n`);
  }
  if (extra?.pairedComparison) {
    fs.mkdirSync(path.join(runDir, "artifacts"), { recursive: true });
    fs.writeFileSync(
      path.join(runDir, "artifacts", "paired-comparison.json"),
      `${JSON.stringify(extra.pairedComparison, null, 2)}\n`,
    );
  }
}

function updateLatestSymlink(outRoot: string, runId: string): void {
  const link = path.join(outRoot, "latest");
  try {
    fs.rmSync(link, { force: true });
  } catch {
    // ignore
  }
  try {
    fs.symlinkSync(runId, link, "dir");
  } catch {
    // Windows or no-symlink-permission environments: write a sentinel file.
    fs.writeFileSync(`${link}.txt`, runId);
  }
}

async function main(): Promise<number> {
  const opts = parseArgs(process.argv.slice(2));

  const realStashRoot = resolveStashDir(opts.stash);
  const realDataDir = resolveDataDir();
  const casesRoot = opts.casesDir ? path.resolve(opts.casesDir) : defaultCasesRoot();

  // For paired mode with --sandbox: copy stash to tmpdir and redirect env.
  let activeStashRoot = realStashRoot;
  let activeDataDir = realDataDir;
  let sandbox: Sandbox | undefined;
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };

  if (opts.mode === "paired" && opts.sandbox) {
    sandbox = createSandbox({ fixture: realStashRoot, prefix: "akm-eval-paired-" });
    activeStashRoot = sandbox.stashDir;
    activeDataDir = sandbox.dataDir;
    env.AKM_STASH_DIR = sandbox.env.AKM_STASH_DIR;
    env.AKM_DATA_DIR = sandbox.env.AKM_DATA_DIR;
    env.HOME = sandbox.env.HOME;
    // The sandbox starts without a state.db; index it so retrieval runs find content.
    const seed = new AkmCli(opts.akmBin, env).index();
    if (seed.status !== 0) {
      process.stderr.write(`[akm-eval] sandbox index failed: ${seed.stderr.trim()}\n`);
      if (!opts.keepSandbox) sandbox.cleanup();
      return 2;
    }
  }

  const outRoot = opts.out ? path.resolve(opts.out) : resolveEvalsRoot(realStashRoot);
  fs.mkdirSync(path.join(outRoot, "runs"), { recursive: true });
  const runsDir = path.join(outRoot, "runs");
  const evalRunId = buildEvalRunId();
  const runDir = path.join(runsDir, evalRunId);

  const akmCli = new AkmCli(opts.akmBin, env);
  const akmVersion = akmCli.version();

  const baseCtx: EvalContext = {
    stashRoot: activeStashRoot,
    dataDir: activeDataDir,
    akmBin: opts.akmBin,
    casesRoot,
    outRoot,
    keepSandbox: opts.keepSandbox,
    env,
    currentRunId: evalRunId,
  };

  const cases = loadCases(casesRoot, opts.suite);
  const startedAt = new Date();
  let baselineResults: EvalCaseResult[] | undefined;
  let pairedImproveSummary: Record<string, unknown> | undefined;
  let pairedComparison: ReturnType<typeof compareResultsInMemory> | undefined;

  if (opts.mode === "paired") {
    // 1) baseline pass.
    baselineResults = await runCases(cases, baseCtx);

    // 2) shell out to akm improve with forwarded args. akm improve writes
    // its envelope to <stash>/.akm/runs/<id>/improve-result.json regardless
    // of stdout formatting, so we don't force a --format flag here.
    const impArgs = [...opts.improveArgs];
    const imp = akmCli.improve(impArgs);
    pairedImproveSummary = {
      args: impArgs,
      status: imp.status,
      stderr: imp.stderr.split("\n").slice(-50).join("\n"),
      stdoutBytes: imp.stdout.length,
      sandbox: opts.sandbox ? sandbox?.root : null,
    };
    if (imp.status !== 0) {
      process.stderr.write(`[akm-eval] akm improve failed (exit ${imp.status}); continuing with re-eval\n`);
    }
  }

  // Final pass (or only pass for baseline/akm modes).
  const results = await runCases(cases, baseCtx);
  const completedAt = new Date();

  const { overall, deterministic } = aggregateScores(results);
  const countsByType = buildCountsByType(results);
  const errors = results
    .filter((r) => r.errors && r.errors.length > 0)
    .flatMap((r) => (r.errors ?? []).map((m) => ({ caseId: r.caseId, message: m })));

  const scores: EvalRunResult["scores"] = { overall, deterministic };
  let regressionsForEnvelope: EvalRunResult["regressions"] | undefined;
  if (opts.mode === "paired" && baselineResults) {
    const baselineAgg = aggregateScores(baselineResults);
    scores.baseline = baselineAgg.overall;
    scores.delta = overall - baselineAgg.overall;
    const baselineEnvelope: EvalRunResult = {
      schemaVersion: 1,
      evalRunId: `${evalRunId}-baseline`,
      suite: opts.suite,
      mode: "baseline",
      label: opts.label ? `${opts.label}:baseline` : "baseline",
      startedAt: startedAt.toISOString(),
      completedAt: startedAt.toISOString(),
      durationMs: 0,
      akm: { version: akmVersion, stashRoot: activeStashRoot, dataDir: activeDataDir },
      inputs: { caseCount: cases.length, caseDir: path.join(casesRoot, opts.suite) },
      scores: { overall: baselineAgg.overall, deterministic: baselineAgg.deterministic },
      countsByType: buildCountsByType(baselineResults),
      metrics: {},
      errors: [],
      artifacts: {},
    };
    const currentEnvelopePreview: EvalRunResult = {
      schemaVersion: 1,
      evalRunId,
      suite: opts.suite,
      mode: opts.mode,
      label: opts.label,
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs: completedAt.getTime() - startedAt.getTime(),
      akm: { version: akmVersion, stashRoot: activeStashRoot, dataDir: activeDataDir },
      inputs: { caseCount: cases.length, caseDir: path.join(casesRoot, opts.suite) },
      scores,
      countsByType,
      metrics: {},
      errors: [],
      artifacts: {},
    };
    pairedComparison = compareResultsInMemory(
      { runId: `${evalRunId}-baseline`, dir: runDir, envelope: baselineEnvelope, results: baselineResults },
      { runId: evalRunId, dir: runDir, envelope: currentEnvelopePreview, results },
      opts.threshold,
    );
    const diff = diffCaseResults(baselineResults, results, { threshold: opts.threshold });
    regressionsForEnvelope = diff.regressions.map((r) => ({
      caseId: r.caseId,
      previousScore: r.previousScore,
      currentScore: r.currentScore,
      reason: r.reason,
    }));
  }

  const envelope: EvalRunResult = {
    schemaVersion: 1,
    evalRunId,
    suite: opts.suite,
    mode: opts.mode,
    label: opts.label,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    durationMs: completedAt.getTime() - startedAt.getTime(),
    akm: { version: akmVersion, stashRoot: activeStashRoot, dataDir: activeDataDir },
    inputs: { caseCount: cases.length, caseDir: path.join(casesRoot, opts.suite) },
    scores,
    countsByType,
    metrics: pairedImproveSummary ? { pairedImprove: pairedImproveSummary } : {},
    regressions: regressionsForEnvelope,
    errors,
    artifacts: {
      evalResult: "eval-result.json",
      caseResults: "case-results.jsonl",
      markdownReport: "report.md",
      ...(baselineResults ? { baselineCaseResults: "artifacts/baseline-case-results.jsonl" } : {}),
      ...(pairedComparison ? { pairedComparison: "artifacts/paired-comparison.json" } : {}),
    },
  };

  writeArtifacts(runDir, envelope, results, {
    baselineResults,
    pairedComparison,
  });
  updateLatestSymlink(runsDir, evalRunId);

  if (opts.format === "json") {
    process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
  } else if (opts.format === "md") {
    process.stdout.write(renderMarkdown(envelope, results));
  }

  process.stderr.write(`[akm-eval] wrote ${path.join(runDir, "eval-result.json")}\n`);
  if (sandbox && !opts.keepSandbox) {
    sandbox.cleanup();
  } else if (sandbox) {
    process.stderr.write(`[akm-eval] kept sandbox at ${sandbox.root}\n`);
  }

  if (opts.failBelowScore !== undefined && overall < opts.failBelowScore) {
    process.stderr.write(
      `[akm-eval] overall ${overall.toFixed(3)} below --fail-below-score ${opts.failBelowScore}\n`,
    );
    return 1;
  }
  if (opts.failOnRegression && (regressionsForEnvelope?.length ?? 0) > 0) {
    process.stderr.write(`[akm-eval] ${regressionsForEnvelope?.length ?? 0} regression(s) and --fail-on-regression set\n`);
    return 1;
  }
  if (errors.length > 0) {
    process.stderr.write(`[akm-eval] ${errors.length} case error(s); see eval-result.json\n`);
    return 2;
  }
  return 0;
}

try {
  const code = await main();
  process.exit(code);
} catch (err) {
  process.stderr.write(`[akm-eval] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(2);
}
