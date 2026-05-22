#!/usr/bin/env bun
/**
 * akm-eval-replay — Phase 6 deterministic replay.
 *
 * Re-runs an eval suite against captured I/O. Loads the three replay logs
 * written by `akm-eval-run --record` (`akm-invocations.jsonl`,
 * `state-db-queries.jsonl`, `improve-results.jsonl`) under
 * `<run-dir>/artifacts/replay/`, installs the playback singletons in
 * `replay-log.ts`, re-loads the same case files, runs every case through
 * the unchanged runners, then compares the new `case-results.jsonl`
 * against the recorded one.
 *
 * Exit:
 *   0 — deterministic (all cases matched).
 *   1 — at least one divergence, OR (with --strict) missing/extra cases.
 *   2 — invocation failure (missing recording, malformed file, etc.).
 *
 * Usage:
 *   akm-eval-replay <eval-run-id|latest> [--stash <path>] [--out <path>]
 *                                         [--strict] [--format json|md]
 *
 * The orchestrator's switch on case-type is unchanged — the runners are
 * the live runners; only the I/O surfaces are swapped out under their feet.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { runMemorySafetyCase } from "./runners/memory-safety";
import { runPlannerWasteCase } from "./runners/planner-waste";
import { runProposalQualityCase } from "./runners/proposal-quality";
import { runReflectQualityCase } from "./runners/reflect-quality";
import { runRegressionCase } from "./runners/regression";
import { runRetrievalCase } from "./runners/retrieval";
import { runWorkflowComplianceCase } from "./runners/workflow-compliance";
import { makeAkmCli } from "./sources/akm-cli";
import {
  loadCaseResults,
  loadEvalRunResult,
  resolveRunDir,
} from "./sources/eval-runs";
import { resolveEvalsRoot, resolveStashDir } from "./sources/paths";
import {
  deepEqual,
  ReplayDivergenceError,
  ReplayPlayer,
  scoresClose,
  setCurrentPlayer,
} from "./sources/replay-log";
import type { EvalCase, EvalCaseResult, EvalContext } from "./types";

interface ReplayOptions {
  runRef: string;
  stash?: string;
  out?: string;
  strict: boolean;
  format: "json" | "md" | "none";
  akmBin: string;
}

interface DivergenceEntry {
  caseId: string;
  field: string;
  expected: unknown;
  actual: unknown;
}

interface ReplayResultFile {
  schemaVersion: 1;
  originalRunId: string;
  replayRunId: string;
  deterministic: boolean;
  divergentCases: DivergenceEntry[];
  missingCases: string[];
  extraCases: string[];
}

function parseArgs(argv: string[]): ReplayOptions {
  const opts: ReplayOptions = {
    runRef: "",
    strict: false,
    format: "md",
    akmBin: process.env.AKM_BIN ?? "akm",
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
      case "--out":
        opts.out = next();
        break;
      case "--strict":
        opts.strict = true;
        break;
      case "--format": {
        const v = next();
        if (v !== "json" && v !== "md" && v !== "none") {
          throw new Error(`--format must be json|md|none (got ${v})`);
        }
        opts.format = v;
        break;
      }
      case "--akm":
        opts.akmBin = next();
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
  if (positional.length === 0) {
    throw new Error("missing required <eval-run-id|latest> argument");
  }
  if (positional.length > 1) {
    throw new Error(`expected one run reference, got ${positional.length}`);
  }
  opts.runRef = positional[0];
  return opts;
}

function printHelp(): void {
  process.stdout.write(`akm-eval-replay — Phase 6 deterministic replay

Usage:
  akm-eval-replay <eval-run-id|latest> [options]

Options:
  --stash <path>     Stash root (default: \$AKM_STASH_DIR or ~/akm).
  --out <path>       Output root (default: <stash>/.akm/evals).
  --strict           Fail (exit 1) on missing or extra cases too, not just divergences.
  --format json|md|none
                     Summary format on stdout (default: md).
  --akm <bin>        Path to akm binary (default: \$AKM_BIN or 'akm').

Exit codes:
  0  deterministic (all cases matched).
  1  at least one divergence, or (with --strict) missing/extra cases.
  2  invocation failure (missing recording, malformed file, etc.).
`);
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
    const parsed = JSON.parse(raw) as EvalCase;
    if (parsed.schemaVersion !== 1) {
      throw new Error(`unsupported schemaVersion in ${file}: ${parsed.schemaVersion}`);
    }
    cases.push(parsed);
  }
  return cases;
}

async function runCase(c: EvalCase, ctx: EvalContext): Promise<EvalCaseResult> {
  switch (c.type) {
    case "retrieval":
      return runRetrievalCase(c, ctx);
    case "planner-waste":
      return runPlannerWasteCase(c, ctx);
    case "proposal-quality":
      return runProposalQualityCase(c, ctx);
    case "reflect-quality":
      return runReflectQualityCase(c, ctx);
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
    let result: EvalCaseResult;
    try {
      result = await runCase(c, stepCtx);
    } catch (err) {
      // Divergence in the middle of a case bubbles up as an errored case
      // so the comparison step still has a row to surface.
      const message = err instanceof Error ? err.message : String(err);
      result = {
        caseId: c.id,
        type: c.type,
        score: 0,
        passed: false,
        metrics: {},
        evidence: {},
        errors: [message],
        durationMs: 0,
      };
    }
    collected.push(result);
  }
  return collected;
}

function buildReplayRunId(now: Date = new Date()): string {
  const iso = now.toISOString().replace(/[:.]/g, "-");
  const rand = crypto.randomBytes(4).toString("hex");
  return `replay-${iso}-${rand}`;
}

/**
 * Compare two case-result arrays. The four fields that matter for replay
 * determinism are `score`, `passed`, `metrics`, and `evidence`. Timing
 * (`durationMs`) and `errors` are ignored — timing always differs and a
 * divergence in the underlying call is already surfaced as a score / metric
 * mismatch.
 */
function compareCases(
  expected: EvalCaseResult[],
  actual: EvalCaseResult[],
): { divergent: DivergenceEntry[]; missing: string[]; extra: string[] } {
  // Normalise both sides through JSON round-trip so `undefined` fields are
  // dropped uniformly. The recorded case-results.jsonl is JSON-serialised
  // (no undefineds survive), but the live runner returns objects that may
  // carry undefined properties (`evidence.filterSource = undefined`), which
  // would otherwise produce phantom divergences.
  const normalise = (r: EvalCaseResult): EvalCaseResult =>
    JSON.parse(JSON.stringify(r)) as EvalCaseResult;
  const expById = new Map(expected.map((r) => [r.caseId, normalise(r)]));
  const actById = new Map(actual.map((r) => [r.caseId, normalise(r)]));

  const divergent: DivergenceEntry[] = [];
  const missing: string[] = [];
  const extra: string[] = [];

  for (const [id, exp] of expById) {
    const act = actById.get(id);
    if (!act) {
      missing.push(id);
      continue;
    }
    if (!scoresClose(exp.score, act.score)) {
      divergent.push({ caseId: id, field: "score", expected: exp.score, actual: act.score });
    }
    if (exp.passed !== act.passed) {
      divergent.push({ caseId: id, field: "passed", expected: exp.passed, actual: act.passed });
    }
    if (!deepEqual(exp.metrics, act.metrics)) {
      // Surface the first differing leaf for readability; fall back to full
      // object if no leaf-level divergence is found (e.g. shape mismatch).
      const leaf = firstLeafDiff("metrics", exp.metrics, act.metrics);
      if (leaf) divergent.push({ caseId: id, ...leaf });
      else divergent.push({ caseId: id, field: "metrics", expected: exp.metrics, actual: act.metrics });
    }
    if (!deepEqual(exp.evidence, act.evidence)) {
      const leaf = firstLeafDiff("evidence", exp.evidence, act.evidence);
      if (leaf) divergent.push({ caseId: id, ...leaf });
      else divergent.push({ caseId: id, field: "evidence", expected: exp.evidence, actual: act.evidence });
    }
  }
  for (const id of actById.keys()) {
    if (!expById.has(id)) extra.push(id);
  }
  return { divergent, missing, extra };
}

/** Walk two objects in parallel, returning the first differing scalar path. */
function firstLeafDiff(
  prefix: string,
  a: unknown,
  b: unknown,
): { field: string; expected: unknown; actual: unknown } | null {
  if (deepEqual(a, b)) return null;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
    return { field: prefix, expected: a, actual: b };
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return { field: prefix, expected: a, actual: b };
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(ao), ...Object.keys(bo)]);
  for (const k of keys) {
    if (!deepEqual(ao[k], bo[k])) {
      const next = firstLeafDiff(`${prefix}.${k}`, ao[k], bo[k]);
      if (next) return next;
    }
  }
  return { field: prefix, expected: a, actual: b };
}

async function main(): Promise<number> {
  const opts = parseArgs(process.argv.slice(2));

  const stashRoot = resolveStashDir(opts.stash);
  const outRoot = opts.out ? path.resolve(opts.out) : resolveEvalsRoot(stashRoot);
  const runsRoot = path.join(outRoot, "runs");
  const original = resolveRunDir(runsRoot, opts.runRef);
  const replayDir = path.join(original.dir, "artifacts", "replay");

  if (!fs.existsSync(path.join(replayDir, "akm-invocations.jsonl"))) {
    process.stderr.write(
      `[akm-eval-replay] no replay artifacts at ${replayDir}\n` +
        `  re-run with: akm-eval-run --record --stash <path>\n`,
    );
    return 2;
  }

  let envelope;
  try {
    envelope = loadEvalRunResult(original.dir);
  } catch (err) {
    process.stderr.write(`[akm-eval-replay] failed to load eval-result.json: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
  const suite = envelope.suite;
  const casesRoot = inferCasesRoot(envelope.inputs.caseDir, suite);

  let recordedResults: EvalCaseResult[];
  try {
    recordedResults = loadCaseResults(original.dir);
  } catch (err) {
    process.stderr.write(`[akm-eval-replay] failed to load case-results.jsonl: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }

  let player: ReplayPlayer;
  try {
    player = ReplayPlayer.fromDir(replayDir);
  } catch (err) {
    process.stderr.write(`[akm-eval-replay] failed to load replay logs: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
  setCurrentPlayer(player);

  const cases = loadCases(casesRoot, suite);
  // Restore the recorded clock so runners that resolve a windowed `since`
  // (e.g. proposal-quality) recompute the EXACT same ISO timestamp the
  // record run sent to state-db. Without this, the replay's `new Date()`
  // would skew the SQL parameter and the playback would fail to match the
  // recorded query, producing a phantom divergence with no underlying
  // logic change. The envelope's `startedAt` is always present and is the
  // same instant the live runner saw via `ctx.runStartedAt`.
  const ctx: EvalContext = {
    stashRoot,
    dataDir: envelope.akm.dataDir ?? "",
    akmBin: opts.akmBin,
    casesRoot,
    outRoot,
    keepSandbox: false,
    env: { ...(process.env as Record<string, string>) },
    currentRunId: original.runId,
    recording: true,
    runStartedAt: new Date(envelope.startedAt),
  };

  // Mirror the orchestrator: src/run.ts calls `akmCli.version()` once
  // before any case runs (to populate the envelope's `akm.version` field).
  // That call is in the recording, so we must dequeue it here in the same
  // order — otherwise the first runner's first `search` call would mis-align
  // against the recorded `--version` entry.
  const replayCli = makeAkmCli(opts.akmBin, ctx.env, { record: true });
  replayCli.version();

  let actualResults: EvalCaseResult[];
  try {
    actualResults = await runCases(cases, ctx);
  } finally {
    setCurrentPlayer(undefined);
  }

  const cmp = compareCases(recordedResults, actualResults);
  const replayRunId = buildReplayRunId();
  const deterministic = cmp.divergent.length === 0 && (!opts.strict || (cmp.missing.length === 0 && cmp.extra.length === 0));

  const replayResult: ReplayResultFile = {
    schemaVersion: 1,
    originalRunId: original.runId,
    replayRunId,
    deterministic,
    divergentCases: cmp.divergent,
    missingCases: cmp.missing,
    extraCases: cmp.extra,
  };

  fs.mkdirSync(replayDir, { recursive: true });
  fs.writeFileSync(
    path.join(replayDir, "replay-result.json"),
    `${JSON.stringify(replayResult, null, 2)}\n`,
  );

  if (opts.format === "json") {
    process.stdout.write(`${JSON.stringify(replayResult, null, 2)}\n`);
  } else if (opts.format === "md") {
    process.stdout.write(renderReport(replayResult, recordedResults.length, actualResults.length));
  }

  process.stderr.write(
    `[akm-eval-replay] wrote ${path.join(replayDir, "replay-result.json")}\n`,
  );

  if (!deterministic) return 1;
  return 0;
}

function inferCasesRoot(caseDir: string, suite: string): string {
  // `caseDir` is `<casesRoot>/<suite>` from the original run; strip the
  // trailing suite segment to get back to the cases root. Fall back to the
  // shipped suite under `scripts/akm-eval/cases/` if the recorded path no
  // longer exists (e.g. replaying a run from a different worktree).
  if (fs.existsSync(caseDir)) {
    return path.dirname(caseDir);
  }
  const shipped = path.resolve(path.join(import.meta.dir, "..", "cases"));
  if (fs.existsSync(path.join(shipped, suite))) return shipped;
  throw new Error(`cases root not found (tried ${path.dirname(caseDir)} and ${shipped})`);
}

function renderReport(r: ReplayResultFile, expected: number, actual: number): string {
  const lines: string[] = [];
  lines.push(`# akm-eval-replay — ${r.deterministic ? "OK" : "DIVERGENT"}`);
  lines.push("");
  lines.push(`- originalRunId: \`${r.originalRunId}\``);
  lines.push(`- replayRunId:   \`${r.replayRunId}\``);
  lines.push(`- deterministic: ${r.deterministic ? "true" : "false"}`);
  lines.push(`- cases: ${expected} expected → ${actual} replayed`);
  if (r.divergentCases.length > 0) {
    lines.push("");
    lines.push(`## Divergent cases (${r.divergentCases.length})`);
    for (const d of r.divergentCases) {
      lines.push(
        `- \`${d.caseId}\` → ${d.field}: expected ${JSON.stringify(d.expected)}, got ${JSON.stringify(d.actual)}`,
      );
    }
  }
  if (r.missingCases.length > 0) {
    lines.push("");
    lines.push(`## Missing cases (${r.missingCases.length})`);
    for (const id of r.missingCases) lines.push(`- \`${id}\``);
  }
  if (r.extraCases.length > 0) {
    lines.push("");
    lines.push(`## Extra cases (${r.extraCases.length})`);
    for (const id of r.extraCases) lines.push(`- \`${id}\``);
  }
  lines.push("");
  return lines.join("\n");
}

try {
  const code = await main();
  process.exit(code);
} catch (err) {
  if (err instanceof ReplayDivergenceError) {
    process.stderr.write(`[akm-eval-replay] ${err.message}\n`);
    process.exit(1);
  }
  process.stderr.write(`[akm-eval-replay] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(2);
}
