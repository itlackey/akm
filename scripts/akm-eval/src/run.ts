#!/usr/bin/env bun
/**
 * akm-eval orchestrator (Phase 1).
 *
 * Usage:
 *   bun run scripts/akm-eval/src/run.ts \
 *     --suite improve-smoke \
 *     [--mode baseline] \
 *     [--stash <path>] \
 *     [--cases-dir <path>] \
 *     [--out <path>] \
 *     [--label <label>] \
 *     [--akm <bin>] \
 *     [--format json|md|none] \
 *     [--fail-below-score <0..1>]
 *
 * Reads case files from <cases-dir>/<suite>/*.json, runs them, writes
 *   <out>/<eval-run-id>/{eval-result.json, case-results.jsonl, report.md}
 * and updates the <out>/latest symlink.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { runProposalQualityCase } from "./runners/proposal-quality";
import { runRetrievalCase } from "./runners/retrieval";
import { renderMarkdown } from "./report";
import { aggregateScores, buildCountsByType } from "./scoring";
import { AkmCli } from "./sources/akm-cli";
import { resolveDataDir, resolveEvalsRoot, resolveStashDir } from "./sources/paths";
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
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    suite: "improve-smoke",
    mode: "baseline",
    akmBin: process.env.AKM_BIN ?? "akm",
    format: "md",
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
  process.stdout.write(`akm-eval run — Phase 1

Usage:
  bun run scripts/akm-eval/src/run.ts --suite <name> [options]

Options:
  --suite <name>             Eval suite to run (default: improve-smoke).
  --mode baseline|akm|paired Eval mode (Phase 1 supports baseline only; akm
                             and paired land in Phase 2).
  --stash <path>             Stash root (default: \$AKM_STASH_DIR or ~/akm).
  --cases-dir <path>         Root containing <suite>/*.json case files
                             (default: scripts/akm-eval/cases/).
  --out <path>               Output root (default: <stash>/.akm/evals/runs).
  --label <label>            Optional label recorded in eval-result.json.
  --akm <bin>                Path to akm binary (default: \$AKM_BIN or 'akm').
  --format json|md|none      Stdout summary format (default: md).
  --fail-below-score <0..1>  Exit non-zero if overall score is below this.
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
    default:
      return {
        caseId: c.id,
        type: c.type,
        score: 0,
        passed: false,
        skipped: true,
        skipReason: `runner not implemented in Phase 1 (type: ${c.type})`,
        metrics: {},
        evidence: {},
        durationMs: 0,
      };
  }
}

function writeArtifacts(
  runDir: string,
  envelope: EvalRunResult,
  results: EvalCaseResult[],
): void {
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "eval-result.json"), `${JSON.stringify(envelope, null, 2)}\n`);
  const jsonl = results.map((r) => JSON.stringify(r)).join("\n");
  fs.writeFileSync(path.join(runDir, "case-results.jsonl"), `${jsonl}\n`);
  fs.writeFileSync(path.join(runDir, "report.md"), renderMarkdown(envelope, results));
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
  } catch (err) {
    // Windows or no-symlink-permission environments: write a sentinel file.
    fs.writeFileSync(`${link}.txt`, runId);
  }
}

async function main(): Promise<number> {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.mode !== "baseline") {
    process.stderr.write(`[akm-eval] mode "${opts.mode}" is not implemented in Phase 1; falling back to baseline\n`);
    opts.mode = "baseline";
  }

  const stashRoot = resolveStashDir(opts.stash);
  const dataDir = resolveDataDir();
  const casesRoot = opts.casesDir ? path.resolve(opts.casesDir) : defaultCasesRoot();
  const outRoot = opts.out ? path.resolve(opts.out) : resolveEvalsRoot(stashRoot);
  fs.mkdirSync(path.join(outRoot, "runs"), { recursive: true });

  const runsDir = path.join(outRoot, "runs");
  const evalRunId = buildEvalRunId();
  const runDir = path.join(runsDir, evalRunId);

  const akmCli = new AkmCli(opts.akmBin, process.env as Record<string, string>);
  const akmVersion = akmCli.version();

  const ctx: EvalContext = {
    stashRoot,
    dataDir,
    akmBin: opts.akmBin,
    casesRoot,
    outRoot,
    keepSandbox: false,
    env: process.env as Record<string, string>,
  };

  const cases = loadCases(casesRoot, opts.suite);

  const startedAt = new Date();
  const results: EvalCaseResult[] = [];
  for (const c of cases) {
    const result = await runCase(c, ctx);
    results.push(result);
  }
  const completedAt = new Date();

  const { overall, deterministic } = aggregateScores(results);
  const countsByType = buildCountsByType(results);
  const errors = results
    .filter((r) => r.errors && r.errors.length > 0)
    .flatMap((r) => (r.errors ?? []).map((m) => ({ caseId: r.caseId, message: m })));

  const envelope: EvalRunResult = {
    schemaVersion: 1,
    evalRunId,
    suite: opts.suite,
    mode: opts.mode,
    label: opts.label,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    durationMs: completedAt.getTime() - startedAt.getTime(),
    akm: { version: akmVersion, stashRoot, dataDir },
    inputs: { caseCount: cases.length, caseDir: path.join(casesRoot, opts.suite) },
    scores: { overall, deterministic },
    countsByType,
    metrics: {},
    errors,
    artifacts: {
      evalResult: "eval-result.json",
      caseResults: "case-results.jsonl",
      markdownReport: "report.md",
    },
  };

  writeArtifacts(runDir, envelope, results);
  updateLatestSymlink(runsDir, evalRunId);

  if (opts.format === "json") {
    process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
  } else if (opts.format === "md") {
    process.stdout.write(renderMarkdown(envelope, results));
  }

  process.stderr.write(`[akm-eval] wrote ${path.join(runDir, "eval-result.json")}\n`);

  if (opts.failBelowScore !== undefined && overall < opts.failBelowScore) {
    process.stderr.write(
      `[akm-eval] overall ${overall.toFixed(3)} below --fail-below-score ${opts.failBelowScore}\n`,
    );
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
