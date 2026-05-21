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
import { runJudgeCalibrationCase } from "./runners/judge-calibration";
import { runMemorySafetyCase } from "./runners/memory-safety";
import { runProposalQualityCase } from "./runners/proposal-quality";
import { runRegressionCase } from "./runners/regression";
import { runRetrievalCase } from "./runners/retrieval";
import { runWorkflowComplianceCase } from "./runners/workflow-compliance";
import { renderMarkdown } from "./report";
import { aggregateScores, buildCountsByType } from "./scoring";
import { AkmCli } from "./sources/akm-cli";
import {
  DEFAULT_JUDGE_MODEL,
  llmJudge,
  resolveJudgeApiKey,
  resolveJudgeEndpoint,
} from "./sources/llm-judge";
import { resolveDataDir, resolveEvalsRoot, resolveStashDir } from "./sources/paths";
import { createSandbox, type Sandbox } from "./sources/sandbox";
import type {
  EvalCase,
  EvalCaseResult,
  EvalContext,
  EvalMode,
  EvalRunResult,
  LlmJudgeContext,
} from "./types";

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
  /** Phase 7: opt-in LLM judging. */
  llmJudge: boolean;
  judgeModel?: string;
  judgeProvider?: string;
  judgeTemperature: number;
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
    llmJudge: false,
    judgeTemperature: 0.0,
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
      case "--llm-judge":
        opts.llmJudge = true;
        break;
      case "--judge-model":
        opts.judgeModel = next();
        break;
      case "--judge-provider":
        opts.judgeProvider = next();
        break;
      case "--judge-temperature": {
        const v = Number(next());
        if (!Number.isFinite(v) || v < 0 || v > 1) {
          throw new Error(`--judge-temperature must be in [0,1] (got ${v})`);
        }
        opts.judgeTemperature = v;
        break;
      }
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
  --llm-judge                Phase 7: opt in to LLM judging. Cases declaring
                              \`scoring.llmJudge\` will be graded and recorded
                              separately. NEVER folded into deterministic scores.
  --judge-model <name>       Judge model (default: \$AKM_EVAL_JUDGE_MODEL or
                              "${DEFAULT_JUDGE_MODEL}").
  --judge-provider <name>    Judge provider (default: \$AKM_EVAL_JUDGE_PROVIDER or
                              "openai"). Supported: openai, openrouter, ollama,
                              llamacpp, lmstudio. Endpoint override: \$AKM_EVAL_JUDGE_ENDPOINT.
  --judge-temperature <0..1> Judge temperature (default: 0.0 — deterministic-as-possible).
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

/**
 * Phase 7: build a judge context from CLI options + env. Throws with an
 * actionable message when `--llm-judge` is on but the user hasn't given
 * us enough to call an endpoint. We refuse to silently degrade — the
 * user asked for LLM judging, so failing fast surfaces misconfiguration.
 */
function buildJudgeContext(opts: CliOptions, env: Record<string, string | undefined>): LlmJudgeContext {
  const provider =
    opts.judgeProvider ?? env.AKM_EVAL_JUDGE_PROVIDER ?? "openai";
  const model = opts.judgeModel ?? env.AKM_EVAL_JUDGE_MODEL ?? DEFAULT_JUDGE_MODEL;
  const endpoint = resolveJudgeEndpoint(env);
  const apiKey = resolveJudgeApiKey(provider, env);

  if (!endpoint && !apiKey) {
    throw new Error(
      [
        "--llm-judge requires either AKM_EVAL_JUDGE_ENDPOINT or an API key.",
        `  provider = ${provider}; model = ${model}`,
        "  set one of:",
        "    AKM_EVAL_JUDGE_ENDPOINT=http://... (local OpenAI-compatible server)",
        "    AKM_EVAL_JUDGE_API_KEY=...         (explicit override, all providers)",
        "    OPENAI_API_KEY / OPENROUTER_API_KEY / ...  (per-provider default)",
        "  also accepted: --judge-model, --judge-provider, --judge-temperature,",
        "                 AKM_EVAL_JUDGE_MODEL, AKM_EVAL_JUDGE_PROVIDER.",
      ].join("\n"),
    );
  }
  return {
    enabled: true,
    model,
    provider,
    temperature: opts.judgeTemperature,
    endpoint,
    apiKey,
  };
}

/**
 * Phase 7: if the case declares LLM judging and the judge is enabled,
 * grade the case's artifact and attach the result. Pure side-channel:
 * never mutates `r.score` / `r.passed`.
 */
async function maybeAttachJudgement(
  c: EvalCase,
  r: EvalCaseResult,
  judge: LlmJudgeContext | undefined,
): Promise<EvalCaseResult> {
  const spec = c.scoring?.llmJudge;
  if (!judge?.enabled || !spec || r.skipped) return r;

  // Pull the artifact text from evidence first, then metrics. Anything
  // not already a string is JSON-stringified so the judge always sees text.
  const fromEvidence = r.evidence?.[spec.artifactField];
  const fromMetrics = r.metrics?.[spec.artifactField];
  const raw = fromEvidence !== undefined ? fromEvidence : fromMetrics;
  if (raw === undefined || raw === null) {
    return {
      ...r,
      llmJudgement: {
        score: 0,
        band: "low",
        rationale: "",
        provenance: {
          model: judge.model,
          provider: judge.provider,
          temperature: judge.temperature,
          promptHash: "",
          artifactHash: "",
          durationMs: 0,
          ts: new Date().toISOString(),
        },
        error: `case has no value for evidence/metrics field '${spec.artifactField}'`,
      },
    };
  }
  const artifact = typeof raw === "string" ? raw : JSON.stringify(raw);

  try {
    const verdict = await llmJudge(judge, {
      artifact,
      rubric: spec.rubric,
      maxArtifactBytes: spec.maxArtifactBytes,
    });
    if (!verdict) {
      return {
        ...r,
        llmJudgement: {
          score: 0,
          band: "low",
          rationale: "",
          provenance: {
            model: judge.model,
            provider: judge.provider,
            temperature: judge.temperature,
            promptHash: "",
            artifactHash: "",
            durationMs: 0,
            ts: new Date().toISOString(),
          },
          error: "rubric exceeded 4 KB cap (judge skipped)",
        },
      };
    }
    return { ...r, llmJudgement: verdict };
  } catch (err) {
    // Defensive: llmJudge() promises not to throw, but if a host-level
    // crash sneaks through, we still don't break deterministic scoring.
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ...r,
      llmJudgement: {
        score: 0,
        band: "low",
        rationale: "",
        provenance: {
          model: judge.model,
          provider: judge.provider,
          temperature: judge.temperature,
          promptHash: "",
          artifactHash: "",
          durationMs: 0,
          ts: new Date().toISOString(),
        },
        error: msg,
      },
    };
  }
}

async function runCase(c: EvalCase, ctx: EvalContext): Promise<EvalCaseResult> {
  switch (c.type) {
    case "retrieval":
      return runRetrievalCase(c, ctx);
    case "proposal-quality":
      return runProposalQualityCase(c, ctx);
    case "regression":
      return runRegressionCase(c, ctx);
    case "judge-calibration":
      return runJudgeCalibrationCase(c, ctx);
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
    // Phase 7: optional, side-channel judging. Deterministic score on
    // `result` is finalised before we touch the judge.
    const withJudge = await maybeAttachJudgement(c, result, ctx.judge);
    collected.push(withJudge);
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
  // Phase 7: judge-provenance jsonl. One line per judged case (errors
  // included so misconfiguration is auditable). Skip the file entirely
  // when no case carried a judgement.
  const judged = results.filter((r) => r.llmJudgement !== undefined);
  if (judged.length > 0) {
    fs.mkdirSync(path.join(runDir, "artifacts"), { recursive: true });
    const lines = judged.map((r) => {
      const j = r.llmJudgement!;
      const rec = {
        caseId: r.caseId,
        ts: j.provenance.ts,
        model: j.provenance.model,
        provider: j.provenance.provider,
        temperature: j.provenance.temperature,
        promptHash: j.provenance.promptHash,
        artifactHash: j.provenance.artifactHash,
        score: j.score,
        band: j.band,
        rationale: j.rationale,
        durationMs: j.provenance.durationMs,
        ...(j.error ? { error: j.error } : {}),
      };
      return JSON.stringify(rec);
    });
    fs.writeFileSync(path.join(runDir, "artifacts", "llm-judgements.jsonl"), `${lines.join("\n")}\n`);
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

  // Phase 7: resolve the judge context up-front so misconfiguration
  // fails before we do any work. `buildJudgeContext` throws with an
  // actionable message when --llm-judge is on without endpoint/key.
  let judgeCtx: LlmJudgeContext | undefined;
  if (opts.llmJudge) {
    judgeCtx = buildJudgeContext(opts, process.env);
  }

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
    judge: judgeCtx,
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

  const { overall, deterministic, llmJudged } = aggregateScores(results);
  const countsByType = buildCountsByType(results);
  const errors = results
    .filter((r) => r.errors && r.errors.length > 0)
    .flatMap((r) => (r.errors ?? []).map((m) => ({ caseId: r.caseId, message: m })));

  const scores: EvalRunResult["scores"] = { overall, deterministic };
  // Phase 7: surface llmJudged only when at least one case produced a
  // judge result. Never folded into `overall` / `deterministic`.
  if (llmJudged !== undefined) {
    scores.llmJudged = llmJudged;
  }
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

  // Phase 4 (R3): hoist any judge-calibration case's `metrics.judgeCalibration`
  // block into the run envelope's top-level metrics so external consumers
  // (CI dashboards, trend command) don't have to inspect case-results.jsonl.
  // When multiple judge-calibration cases ran, the most recent wins; suites
  // are expected to ship at most one aggregator case per run.
  const judgeCalibrationMetrics = results
    .filter((r) => r.type === "judge-calibration" && !r.skipped)
    .map((r) => (r.metrics as { judgeCalibration?: unknown }).judgeCalibration)
    .filter((v): v is Record<string, unknown> => v !== undefined && typeof v === "object")
    .pop();

  const envelopeMetrics: Record<string, unknown> = {};
  if (pairedImproveSummary) envelopeMetrics.pairedImprove = pairedImproveSummary;
  if (judgeCalibrationMetrics) envelopeMetrics.judgeCalibration = judgeCalibrationMetrics;

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
    metrics: envelopeMetrics,
    regressions: regressionsForEnvelope,
    errors,
    artifacts: {
      evalResult: "eval-result.json",
      caseResults: "case-results.jsonl",
      markdownReport: "report.md",
      ...(baselineResults ? { baselineCaseResults: "artifacts/baseline-case-results.jsonl" } : {}),
      ...(pairedComparison ? { pairedComparison: "artifacts/paired-comparison.json" } : {}),
      ...(results.some((r) => r.llmJudgement !== undefined)
        ? { llmJudgements: "artifacts/llm-judgements.jsonl" }
        : {}),
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
