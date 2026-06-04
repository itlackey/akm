#!/usr/bin/env bun
/**
 * Graph A/B ablation harness — Phase 5 (R5).
 *
 * Drives a single-source, two-sandbox ablation:
 *
 *   1. Build two sandboxes from the same source stash via createSandbox().
 *      `graphOn`  — default akm config; FEATURE_DEFAULTS.graph_extraction = true.
 *      `graphOff` — writes <sandbox>/.config/akm/config.json (under the HOME
 *                   carve-out) that turns BOTH the locked v1 feature gate
 *                   (`llm.features.graph_extraction: false`) AND the per-pass
 *                   opt-out (`index.graph.llm: false`) off. This is the dual
 *                   gate documented in `src/indexer/graph-extraction.ts`.
 *   2. For each side: `akm index` + `akm improve --json-to-stdout`.
 *   3. Run the suite's retrieval cases against each sandbox (delegates to the
 *      shared `runRetrievalCase` runner — same scoring used everywhere else).
 *   4. Compute per-metric deltas:
 *        - retrieval hit@K (aggregate overall score across retrieval cases)
 *        - retrieval precision@K (mustIncludeRefs returned / topK)
 *        - contradiction-detection precision/recall (counts `contradictedBy`
 *          edges in surviving memory frontmatter; recall vs an `expected`
 *          contradiction count declared on the suite — null/skip otherwise)
 *        - staleness telemetry delta from `improveResult.stalenessDetection`
 *        - latency delta (wall-clock index+improve per side)
 *        - token-cost delta — labelled "proxy: graph telemetry counts"
 *          (sum of `graphExtraction.quality.entityCount` +
 *          `graphExtraction.quality.relationCount`)
 *   5. Supports `--seeds N` for multi-sample median + range.
 *   6. Writes outputs under `<stash>/.akm/evals/ablations/<eval-run-id>/`,
 *      NOT under `runs/` — ablations get their own namespace per plan.
 *
 * Standalone: does not modify run.ts/types.ts/scoring.ts. Only adds new files
 * and uses the existing shared modules (`AkmCli`, `createSandbox`,
 * `runRetrievalCase`, `paths.ts`).
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { runRetrievalCase } from "./runners/retrieval";
import { AkmCli } from "./sources/akm-cli";
import { resolveStashDir } from "./sources/paths";
import { createSandbox, type Sandbox } from "./sources/sandbox";
import type { EvalCase, EvalCaseResult, EvalContext } from "./types";

// ── CLI parsing ──────────────────────────────────────────────────────────────

interface CliOptions {
  suite: string;
  stash?: string;
  casesDir?: string;
  akmBin: string;
  out?: string;
  improveArgs: string[];
  seeds: number;
  format: "json" | "md";
  keepSandbox: boolean;
}

function printHelp(): void {
  process.stdout.write(`akm-eval-graph-ablation — Phase 5 (R5)

Usage:
  akm-eval-graph-ablation [--suite improve-smoke] [--stash <path>]
                          [--cases-dir <path>] [--akm <bin>] [--out <path>]
                          [--improve-args "<...>"] [--seeds N]
                          [--format json|md] [--keep-sandbox]

Options:
  --suite <name>          Eval suite (default: improve-smoke).
  --stash <path>          Source stash to fork into both sandboxes
                          (default: \$AKM_STASH_DIR or ~/akm).
  --cases-dir <path>      Root containing <suite>/*.json case files
                          (default: scripts/akm-eval/cases/).
  --akm <bin>             Path to akm binary (default: \$AKM_BIN or 'akm').
  --out <path>            Output root (default: <stash>/.akm/evals).
  --improve-args "<...>"  Args forwarded verbatim to \`akm improve\`.
  --seeds N               Independent samples per side (default: 1).
                          3–5 recommended for any decision-quality run.
  --format json|md        Stdout summary format (default: md).
  --keep-sandbox          Don't delete sandboxes after the run.
`);
}

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

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    suite: "improve-smoke",
    akmBin: process.env.AKM_BIN ?? "akm",
    improveArgs: [],
    seeds: 1,
    format: "md",
    keepSandbox: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`missing value for ${arg}`);
      return v;
    };
    switch (arg) {
      case "--suite":
        opts.suite = next();
        break;
      case "--stash":
        opts.stash = next();
        break;
      case "--cases-dir":
        opts.casesDir = next();
        break;
      case "--akm":
        opts.akmBin = next();
        break;
      case "--out":
        opts.out = next();
        break;
      case "--improve-args":
        opts.improveArgs = tokenize(next());
        break;
      case "--seeds": {
        const n = Number(next());
        if (!Number.isFinite(n) || n < 1 || !Number.isInteger(n)) {
          throw new Error(`--seeds must be a positive integer (got ${n})`);
        }
        opts.seeds = n;
        break;
      }
      case "--format": {
        const v = next();
        if (v !== "json" && v !== "md") {
          throw new Error(`--format must be json|md (got ${v})`);
        }
        opts.format = v;
        break;
      }
      case "--keep-sandbox":
        opts.keepSandbox = true;
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

// ── Helpers ──────────────────────────────────────────────────────────────────

function defaultCasesRoot(): string {
  return path.resolve(path.join(import.meta.dir, "..", "cases"));
}

/** Mirrors `buildEvalRunId` in `src/run.ts`; keep in sync. */
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
    const raw = fs.readFileSync(file, "utf8");
    let parsed: EvalCase;
    try {
      parsed = JSON.parse(raw) as EvalCase;
    } catch (err) {
      throw new Error(`invalid JSON in ${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (parsed.schemaVersion !== 1) {
      throw new Error(`unsupported schemaVersion in ${file}: ${parsed.schemaVersion}`);
    }
    cases.push(parsed);
  }
  return cases;
}

/**
 * Plant the dual-gate-off config under the sandbox's HOME carve-out, so the
 * `graphOff` side has both `llm.features.graph_extraction: false` AND
 * `index.graph.llm: false`. akm resolves config via XDG_CONFIG_HOME or HOME;
 * sandbox.env.HOME points inside the sandbox root, so this file fully shadows
 * the user's real config.
 */
function writeGraphOffConfig(sandbox: Sandbox): string {
  const configDir = path.join(sandbox.root, ".config", "akm");
  fs.mkdirSync(configDir, { recursive: true });
  const configPath = path.join(configDir, "config.json");
  const cfg = {
    llm: { features: { graph_extraction: false } },
    index: { graph: { llm: false } },
  };
  fs.writeFileSync(configPath, `${JSON.stringify(cfg, null, 2)}\n`);
  return configPath;
}

/** Count `contradictedBy` edges in surviving memory frontmatter. */
function countContradictionEdges(stashDir: string): number {
  const memoriesDir = path.join(stashDir, "memories");
  if (!fs.existsSync(memoriesDir)) return 0;
  let count = 0;
  for (const entry of fs.readdirSync(memoriesDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const file = path.join(memoriesDir, entry.name);
    const raw = fs.readFileSync(file, "utf8");
    const m = raw.match(/^---\n([\s\S]*?)\n---/);
    if (!m) continue;
    const fm = m[1];
    // Match `contradictedBy:` followed by either inline `[a, b]` or a YAML list.
    const inline = fm.match(/^contradictedBy:\s*\[([^\]]*)\]/m);
    if (inline) {
      count += inline[1]
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0).length;
      continue;
    }
    const blockHeader = fm.match(/^contradictedBy:\s*$/m);
    if (blockHeader) {
      const idx = fm.indexOf(blockHeader[0]);
      const rest = fm.slice(idx + blockHeader[0].length).split("\n");
      for (const line of rest) {
        if (/^\s*-\s+/.test(line)) count += 1;
        else if (line.trim() !== "" && !/^\s/.test(line)) break;
      }
    }
  }
  return count;
}

/**
 * Compute retrieval precision@K across cases that declared `mustIncludeRefs`.
 * Precision = (sum of must-include refs actually returned) /
 *             (sum of topK across those cases).
 *
 * Cases without `mustIncludeRefs` are skipped from the precision calculation
 * (they have no positive label to score against).
 */
function computeRetrievalPrecision(cases: EvalCase[], results: EvalCaseResult[]): number | null {
  let denom = 0;
  let numer = 0;
  for (const c of cases) {
    if (c.type !== "retrieval") continue;
    const expected = c.expected as { mustIncludeRefs?: string[] };
    const must = expected.mustIncludeRefs ?? [];
    if (must.length === 0) continue;
    const r = results.find((x) => x.caseId === c.id);
    if (!r) continue;
    const refs = ((r.evidence as { refs?: string[] }).refs) ?? [];
    const topK = Number(c.input.topK ?? 5);
    numer += must.filter((ref) => refs.includes(ref)).length;
    denom += topK;
  }
  if (denom === 0) return null;
  return numer / denom;
}

/** Aggregate retrieval scores: mean across retrieval cases. */
function aggregateRetrieval(results: EvalCaseResult[]): { overall: number; passed: number; total: number } {
  const ret = results.filter((r) => r.type === "retrieval" && !r.skipped);
  if (ret.length === 0) return { overall: 0, passed: 0, total: 0 };
  const sum = ret.reduce((a, r) => a + r.score, 0);
  return { overall: sum / ret.length, passed: ret.filter((r) => r.passed).length, total: ret.length };
}

/**
 * Per-side single-seed run: build sandbox, optionally plant the off-config,
 * index, improve, run retrieval cases, collect telemetry. Returns a per-seed
 * sample.
 */
async function runOneSide(
  side: "graphOn" | "graphOff",
  sourceStash: string,
  cases: EvalCase[],
  casesRoot: string,
  akmBin: string,
  improveArgs: string[],
  keepSandbox: boolean,
): Promise<SideSample & { sandbox: Sandbox }> {
  const sandbox = createSandbox({
    fixture: sourceStash,
    prefix: `akm-eval-graph-${side}-`,
    inheritEnv: true,
  });

  let configPath: string | null = null;
  if (side === "graphOff") {
    configPath = writeGraphOffConfig(sandbox);
  }

  const env = { ...sandbox.env };
  const cli = new AkmCli(akmBin, env);

  const startedAt = Date.now();
  const idx = cli.index();
  const indexDurationMs = Date.now() - startedAt;
  if (idx.status !== 0) {
    throw new Error(`[${side}] akm index failed (exit ${idx.status}): ${idx.stderr.trim()}`);
  }

  const improveStart = Date.now();
  const imp = cli.improve(["--json-to-stdout", ...improveArgs]);
  const improveDurationMs = Date.now() - improveStart;

  // Tolerate non-zero exit on improve — still capture telemetry where possible.
  let improveJson: Record<string, unknown> = {};
  if (imp.stdout.trim() !== "") {
    try {
      improveJson = JSON.parse(imp.stdout) as Record<string, unknown>;
    } catch {
      // Leave empty; downstream code treats missing blocks as null.
    }
  }

  // Run retrieval cases against this sandbox.
  const ctx: EvalContext = {
    stashRoot: sandbox.stashDir,
    dataDir: sandbox.dataDir,
    akmBin,
    casesRoot,
    outRoot: path.join(sandbox.stashDir, ".akm", "evals"),
    keepSandbox,
    env,
  };

  const retrievalCases = cases.filter((c) => c.type === "retrieval");
  const retrievalResults: EvalCaseResult[] = [];
  for (const c of retrievalCases) {
    const r = await runRetrievalCase(c, { ...ctx, currentResults: retrievalResults.slice() });
    retrievalResults.push(r);
  }

  const contradictionEdges = countContradictionEdges(sandbox.stashDir);
  const overall = aggregateRetrieval(retrievalResults);
  const precision = computeRetrievalPrecision(cases, retrievalResults);

  return {
    side,
    sandbox,
    sandboxRoot: sandbox.root,
    configPath,
    improveStatus: imp.status,
    improveStderr: imp.stderr.split("\n").slice(-20).join("\n"),
    indexDurationMs,
    improveDurationMs,
    improveJson,
    retrieval: {
      overall: overall.overall,
      passed: overall.passed,
      total: overall.total,
      precisionAtK: precision,
      byCase: retrievalResults.map((r) => ({
        caseId: r.caseId,
        score: r.score,
        passed: r.passed,
        hitAtK: (r.metrics as { hitAtK?: boolean }).hitAtK ?? null,
      })),
    },
    contradictionEdges,
  };
}

// ── Result shapes ────────────────────────────────────────────────────────────

interface SideSample {
  side: "graphOn" | "graphOff";
  sandboxRoot: string;
  configPath: string | null;
  improveStatus: number | null;
  improveStderr: string;
  indexDurationMs: number;
  improveDurationMs: number;
  improveJson: Record<string, unknown>;
  retrieval: {
    overall: number;
    passed: number;
    total: number;
    precisionAtK: number | null;
    byCase: Array<{ caseId: string; score: number; passed: boolean; hitAtK: boolean | null }>;
  };
  contradictionEdges: number;
}

interface SideAggregate {
  improveDurationMs: { median: number; min: number; max: number; samples: number[] };
  indexDurationMs: { median: number; min: number; max: number; samples: number[] };
  retrieval: {
    overall: { median: number; min: number; max: number; samples: number[] };
    precisionAtK: { median: number | null; min: number | null; max: number | null; samples: Array<number | null> };
    passed: number;
    total: number;
    byCase: Array<{ caseId: string; score: number; passed: boolean; hitAtK: boolean | null }>;
  };
  contradictionEdges: { median: number; min: number; max: number; samples: number[] };
  graphProxyTokens: { median: number; min: number; max: number; samples: number[] };
  improve: {
    graphExtraction?: Record<string, unknown>;
    stalenessDetection?: Record<string, unknown>;
  };
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function medianNullable(xs: Array<number | null>): number | null {
  const filtered = xs.filter((x): x is number => x !== null);
  if (filtered.length === 0) return null;
  return median(filtered);
}

/**
 * "Token-cost proxy": entities + relations observed in the graph extraction
 * telemetry. Labelled as a proxy because exact token counts depend on the
 * provider and are not surfaced by the run envelope.
 */
function graphProxyTokens(sample: SideSample): number {
  const ge = sample.improveJson.graphExtraction as { quality?: { entityCount?: number; relationCount?: number } } | undefined;
  const e = ge?.quality?.entityCount ?? 0;
  const r = ge?.quality?.relationCount ?? 0;
  return e + r;
}

function aggregateSide(samples: SideSample[]): SideAggregate {
  const improveDur = samples.map((s) => s.improveDurationMs);
  const indexDur = samples.map((s) => s.indexDurationMs);
  const overallScores = samples.map((s) => s.retrieval.overall);
  const precisions = samples.map((s) => s.retrieval.precisionAtK);
  const contras = samples.map((s) => s.contradictionEdges);
  const tokens = samples.map((s) => graphProxyTokens(s));

  // Last seed's improve envelope is representative for the telemetry blocks
  // (entity/relation counts are deterministic enough that we don't average them).
  const last = samples[samples.length - 1];
  return {
    improveDurationMs: {
      median: median(improveDur),
      min: Math.min(...improveDur),
      max: Math.max(...improveDur),
      samples: improveDur,
    },
    indexDurationMs: {
      median: median(indexDur),
      min: Math.min(...indexDur),
      max: Math.max(...indexDur),
      samples: indexDur,
    },
    retrieval: {
      overall: {
        median: median(overallScores),
        min: Math.min(...overallScores),
        max: Math.max(...overallScores),
        samples: overallScores,
      },
      precisionAtK: {
        median: medianNullable(precisions),
        min: precisions.every((p) => p === null) ? null : Math.min(...precisions.filter((p): p is number => p !== null)),
        max: precisions.every((p) => p === null) ? null : Math.max(...precisions.filter((p): p is number => p !== null)),
        samples: precisions,
      },
      passed: last.retrieval.passed,
      total: last.retrieval.total,
      byCase: last.retrieval.byCase,
    },
    contradictionEdges: {
      median: median(contras),
      min: Math.min(...contras),
      max: Math.max(...contras),
      samples: contras,
    },
    graphProxyTokens: {
      median: median(tokens),
      min: Math.min(...tokens),
      max: Math.max(...tokens),
      samples: tokens,
    },
    improve: {
      graphExtraction: last.improveJson.graphExtraction as Record<string, unknown> | undefined,
      stalenessDetection: last.improveJson.stalenessDetection as Record<string, unknown> | undefined,
    },
  };
}

interface ContradictionExpectations {
  /** Expected contradiction edge count for a fully-functional side (graphOn). */
  expectedContradictions?: number;
}

function readContradictionExpectations(cases: EvalCase[]): ContradictionExpectations {
  // Look for any case tagged `contradiction-detection` that declares
  // `expectedContradictions` in its input block. Returns the highest declared
  // value (the strongest expectation in the suite); absent → undefined → null
  // contradiction precision/recall in the envelope.
  let max = -1;
  for (const c of cases) {
    if (!c.tags?.includes("contradiction-detection")) continue;
    const n = (c.input as { expectedContradictions?: number }).expectedContradictions;
    if (typeof n === "number" && n > max) max = n;
  }
  return max >= 0 ? { expectedContradictions: max } : {};
}

/**
 * Contradiction precision/recall:
 *   - precision = (true positives) / (observed)
 *   - recall    = (true positives) / (expected)
 * where "true positives" is the count of edges actually present on this side.
 * Returns null/null when no suite-level expectation is declared (per plan
 * step 5: "If no contradictions exist in the suite, report null and skip").
 */
function contradictionMetrics(
  observed: number,
  expected: number | undefined,
): { precision: number | null; recall: number | null } {
  if (expected === undefined) return { precision: null, recall: null };
  if (observed === 0 && expected === 0) return { precision: 1, recall: 1 };
  const tp = Math.min(observed, expected);
  const precision = observed === 0 ? 0 : tp / observed;
  const recall = expected === 0 ? null : tp / expected;
  return { precision, recall };
}

// ── Output writers ───────────────────────────────────────────────────────────

interface AblationEnvelope {
  schemaVersion: 1;
  evalRunId: string;
  kind: "graph-ablation";
  suite: string;
  seeds: number;
  startedAt: string;
  completedAt: string;
  akm: { version?: string };
  sourceStash: string;
  graphOn: SideAggregate & {
    contradictionEdges: SideAggregate["contradictionEdges"];
    contradictionPrecision: number | null;
    contradictionRecall: number | null;
  };
  graphOff: SideAggregate & {
    contradictionEdges: SideAggregate["contradictionEdges"];
    contradictionPrecision: number | null;
    contradictionRecall: number | null;
  };
  deltas: {
    retrievalOverall: number;
    retrievalPrecisionAtK: number | null;
    improveDurationMs: number;
    contradictionPrecision: number | null;
    contradictionRecall: number | null;
    graphProxyTokens: number;
  };
  verdict: {
    graphEarnsItsCost: boolean | "inconclusive";
    rationale: string;
  };
  notes: string[];
}

function renderMarkdown(env: AblationEnvelope): string {
  const lines: string[] = [];
  const fmtNum = (n: number, digits = 3): string => (Number.isFinite(n) ? n.toFixed(digits) : "—");
  const fmtNullable = (n: number | null, digits = 3): string => (n === null ? "n/a" : fmtNum(n, digits));
  const fmtRange = (r: { min: number; max: number; median: number }): string =>
    `median=${fmtNum(r.median)} (range ${fmtNum(r.min)}–${fmtNum(r.max)})`;

  lines.push(`# Graph A/B ablation — \`${env.suite}\``);
  lines.push("");
  lines.push(`Eval run id: \`${env.evalRunId}\``);
  lines.push(`Source stash: \`${env.sourceStash}\``);
  lines.push(`Seeds per side: ${env.seeds}`);
  if (env.akm.version) lines.push(`akm: \`${env.akm.version}\``);
  lines.push("");
  lines.push(`## Verdict: \`${String(env.verdict.graphEarnsItsCost)}\``);
  lines.push("");
  lines.push(`> ${env.verdict.rationale}`);
  lines.push("");
  lines.push("## Per-side telemetry");
  lines.push("");
  lines.push("| Metric | graphOn | graphOff | delta (on − off) |");
  lines.push("| --- | --- | --- | --- |");
  lines.push(
    `| Retrieval overall | ${fmtRange(env.graphOn.retrieval.overall)} | ${fmtRange(env.graphOff.retrieval.overall)} | ${fmtNum(env.deltas.retrievalOverall)} |`,
  );
  lines.push(
    `| Retrieval precision@K | ${fmtNullable(env.graphOn.retrieval.precisionAtK.median)} | ${fmtNullable(env.graphOff.retrieval.precisionAtK.median)} | ${fmtNullable(env.deltas.retrievalPrecisionAtK)} |`,
  );
  lines.push(
    `| Retrieval cases passed | ${env.graphOn.retrieval.passed}/${env.graphOn.retrieval.total} | ${env.graphOff.retrieval.passed}/${env.graphOff.retrieval.total} | — |`,
  );
  lines.push(
    `| Improve duration (ms) | ${fmtRange(env.graphOn.improveDurationMs)} | ${fmtRange(env.graphOff.improveDurationMs)} | ${env.deltas.improveDurationMs.toFixed(0)} |`,
  );
  lines.push(
    `| Index duration (ms) | ${fmtRange(env.graphOn.indexDurationMs)} | ${fmtRange(env.graphOff.indexDurationMs)} | — |`,
  );
  lines.push(
    `| Contradiction edges | ${fmtRange(env.graphOn.contradictionEdges)} | ${fmtRange(env.graphOff.contradictionEdges)} | — |`,
  );
  lines.push(
    `| Contradiction precision | ${fmtNullable(env.graphOn.contradictionPrecision)} | ${fmtNullable(env.graphOff.contradictionPrecision)} | ${fmtNullable(env.deltas.contradictionPrecision)} |`,
  );
  lines.push(
    `| Contradiction recall | ${fmtNullable(env.graphOn.contradictionRecall)} | ${fmtNullable(env.graphOff.contradictionRecall)} | ${fmtNullable(env.deltas.contradictionRecall)} |`,
  );
  lines.push(
    `| Token-cost proxy (entities+relations) | ${fmtRange(env.graphOn.graphProxyTokens)} | ${fmtRange(env.graphOff.graphProxyTokens)} | ${env.deltas.graphProxyTokens.toFixed(0)} |`,
  );
  lines.push("");
  lines.push("Note: token-cost is a proxy derived from `graphExtraction.quality.{entityCount,relationCount}` — not measured token usage. Real token counts depend on the provider.");
  lines.push("");
  if (env.notes.length > 0) {
    lines.push("## Notes");
    lines.push("");
    for (const n of env.notes) lines.push(`- ${n}`);
    lines.push("");
  }
  return lines.join("\n") + "\n";
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const opts = parseArgs(process.argv.slice(2));

  const sourceStash = resolveStashDir(opts.stash);
  if (!fs.existsSync(sourceStash)) {
    process.stderr.write(`[graph-ablation] source stash not found: ${sourceStash}\n`);
    return 2;
  }
  const casesRoot = opts.casesDir ? path.resolve(opts.casesDir) : defaultCasesRoot();
  const cases = loadCases(casesRoot, opts.suite);
  if (cases.length === 0) {
    process.stderr.write(`[graph-ablation] no cases found in ${casesRoot}/${opts.suite}\n`);
    return 2;
  }
  const retrievalCount = cases.filter((c) => c.type === "retrieval").length;
  if (retrievalCount === 0) {
    process.stderr.write(`[graph-ablation] suite ${opts.suite} has no retrieval cases; nothing to compare\n`);
    return 2;
  }

  const startedAt = new Date();
  const evalRunId = buildEvalRunId(startedAt);
  const akmVersion = new AkmCli(opts.akmBin, { ...process.env } as Record<string, string>).version();

  // Per-side seed sweeps. We keep all sandboxes alive until both sides finish
  // so we can cleanup them in one finally{} block.
  const onSamples: SideSample[] = [];
  const offSamples: SideSample[] = [];
  const livesSandboxes: Sandbox[] = [];

  try {
    for (let seed = 0; seed < opts.seeds; seed++) {
      const onSide = await runOneSide("graphOn", sourceStash, cases, casesRoot, opts.akmBin, opts.improveArgs, opts.keepSandbox);
      livesSandboxes.push(onSide.sandbox);
      onSamples.push(stripSandbox(onSide));

      const offSide = await runOneSide("graphOff", sourceStash, cases, casesRoot, opts.akmBin, opts.improveArgs, opts.keepSandbox);
      livesSandboxes.push(offSide.sandbox);
      offSamples.push(stripSandbox(offSide));
    }
  } finally {
    if (!opts.keepSandbox) {
      for (const s of livesSandboxes) s.cleanup();
    } else {
      for (const s of livesSandboxes) {
        process.stderr.write(`[graph-ablation] kept sandbox at ${s.root}\n`);
      }
    }
  }

  const onAgg = aggregateSide(onSamples);
  const offAgg = aggregateSide(offSamples);

  // Contradiction precision/recall: use suite-level expectation if any.
  const cExp = readContradictionExpectations(cases);
  const onContra = contradictionMetrics(onAgg.contradictionEdges.median, cExp.expectedContradictions);
  const offContra = contradictionMetrics(offAgg.contradictionEdges.median, cExp.expectedContradictions);

  const completedAt = new Date();

  const deltaRetrievalOverall = onAgg.retrieval.overall.median - offAgg.retrieval.overall.median;
  const deltaPrecision =
    onAgg.retrieval.precisionAtK.median !== null && offAgg.retrieval.precisionAtK.median !== null
      ? onAgg.retrieval.precisionAtK.median - offAgg.retrieval.precisionAtK.median
      : null;
  const deltaImproveMs = onAgg.improveDurationMs.median - offAgg.improveDurationMs.median;
  const deltaContraPrec =
    onContra.precision !== null && offContra.precision !== null ? onContra.precision - offContra.precision : null;
  const deltaContraRecall =
    onContra.recall !== null && offContra.recall !== null ? onContra.recall - offContra.recall : null;
  const deltaTokens = onAgg.graphProxyTokens.median - offAgg.graphProxyTokens.median;

  // ── Verdict heuristic ─────────────────────────────────────────────────────
  //
  // Per plan step §4 final paragraph:
  //   graphEarnsItsCost = true when deltaRetrievalOverall >= 0.05 AND
  //     deltaImproveMs <= 5x baseline (i.e. <= 5 * offMedian).
  //   "inconclusive" when differences are within noise (re-run with more seeds).
  //   false otherwise.
  const notes: string[] = [];
  const offImproveMs = offAgg.improveDurationMs.median;
  const cheapEnough = deltaImproveMs <= 5 * Math.max(1, offImproveMs);
  const meaningfulRetrievalGain = deltaRetrievalOverall >= 0.05;
  let verdict: AblationEnvelope["verdict"];
  // "Within noise" heuristic: |delta| < 0.01 AND total improve range overlaps.
  const noisy = Math.abs(deltaRetrievalOverall) < 0.01 && opts.seeds < 3;
  if (noisy) {
    verdict = {
      graphEarnsItsCost: "inconclusive",
      rationale:
        `retrieval delta ${deltaRetrievalOverall.toFixed(4)} is within noise (|Δ| < 0.01) on ${opts.seeds} seed(s). ` +
        `Re-run with --seeds 3 (or more) for a decision-quality result.`,
    };
  } else if (meaningfulRetrievalGain && cheapEnough) {
    verdict = {
      graphEarnsItsCost: true,
      rationale:
        `retrieval delta ${deltaRetrievalOverall.toFixed(4)} ≥ 0.05 and improve-duration delta ` +
        `${deltaImproveMs.toFixed(0)}ms ≤ 5× off-baseline (${(5 * offImproveMs).toFixed(0)}ms).`,
    };
  } else {
    const reasons: string[] = [];
    if (!meaningfulRetrievalGain) reasons.push(`retrieval delta ${deltaRetrievalOverall.toFixed(4)} < 0.05`);
    if (!cheapEnough)
      reasons.push(`improve-duration delta ${deltaImproveMs.toFixed(0)}ms > 5× off-baseline (${(5 * offImproveMs).toFixed(0)}ms)`);
    verdict = {
      graphEarnsItsCost: false,
      rationale: `does not clear the heuristic — ${reasons.join("; ")}.`,
    };
  }

  if (cExp.expectedContradictions === undefined) {
    notes.push(
      "No `expectedContradictions` declared on any case in the suite; contradiction precision/recall reported as null.",
    );
  }
  if (opts.seeds === 1) {
    notes.push("Single-seed run; numbers are point estimates with no range. Re-run with `--seeds 3` (or more) for decision-quality results.");
  }
  if (deltaTokens === 0) {
    notes.push("Token-cost proxy delta is zero — likely because no LLM provider is configured (the dual-gate also blocks graph extraction at the resolver layer when no provider exists).");
  }

  const envelope: AblationEnvelope = {
    schemaVersion: 1,
    evalRunId,
    kind: "graph-ablation",
    suite: opts.suite,
    seeds: opts.seeds,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    akm: { version: akmVersion },
    sourceStash,
    graphOn: { ...onAgg, contradictionPrecision: onContra.precision, contradictionRecall: onContra.recall },
    graphOff: { ...offAgg, contradictionPrecision: offContra.precision, contradictionRecall: offContra.recall },
    deltas: {
      retrievalOverall: deltaRetrievalOverall,
      retrievalPrecisionAtK: deltaPrecision,
      improveDurationMs: deltaImproveMs,
      contradictionPrecision: deltaContraPrec,
      contradictionRecall: deltaContraRecall,
      graphProxyTokens: deltaTokens,
    },
    verdict,
    notes,
  };

  // ── Write outputs ─────────────────────────────────────────────────────────
  const outRoot = opts.out ? path.resolve(opts.out) : path.join(sourceStash, ".akm", "evals");
  const runDir = path.join(outRoot, "ablations", evalRunId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "graph-ablation-result.json"), `${JSON.stringify(envelope, null, 2)}\n`);
  fs.writeFileSync(path.join(runDir, "report.md"), renderMarkdown(envelope));

  // "latest" pointer scoped to the ablations namespace — keeps it out of
  // the runs/ symlink that the main runner manages.
  const link = path.join(outRoot, "ablations", "latest");
  try {
    fs.rmSync(link, { force: true });
  } catch {
    // ignore
  }
  try {
    fs.symlinkSync(evalRunId, link, "dir");
  } catch {
    fs.writeFileSync(`${link}.txt`, evalRunId);
  }

  if (opts.format === "json") {
    process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
  } else {
    process.stdout.write(renderMarkdown(envelope));
  }
  process.stderr.write(`[graph-ablation] wrote ${path.join(runDir, "graph-ablation-result.json")}\n`);

  return 0;
}

/** Drop the live Sandbox handle off a per-seed result; we keep it elsewhere for cleanup. */
function stripSandbox(s: SideSample & { sandbox: Sandbox }): SideSample {
  // Destructure `sandbox` off — TS-safe pattern that doesn't leave it referenced.
  const { sandbox: _sandbox, ...rest } = s;
  void _sandbox;
  return rest;
}

try {
  const code = await main();
  process.exit(code);
} catch (err) {
  process.stderr.write(`[graph-ablation] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(2);
}
