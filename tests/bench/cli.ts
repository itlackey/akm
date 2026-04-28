#!/usr/bin/env bun
/**
 * akm-bench CLI dispatcher.
 *
 * Subcommands:
 *   • `utility`    — paired noakm vs akm utility benchmark (Track A).
 *   • `evolve`     — longitudinal evolution loop (Track B). Stub.
 *   • `compare`    — diff two report JSON files. Stub.
 *   • `attribute`  — per-asset marginal contribution. Stub.
 *
 * #238 wires `utility` to the K-seed runner and §13.3 report renderer. The
 * other three subcommands stay as "not yet implemented" pointers.
 *
 * NOTE: The bench binary is intentionally argv-light. citty is the project's
 * CLI framework but the bench is not part of the public CLI surface, so a
 * hand-rolled parser keeps the dependency graph tight.
 */

import fs from "node:fs";
import process from "node:process";

import { listTasks, type TaskMetadata } from "./corpus";
import { runEvolve } from "./evolve";
import {
  compareReports,
  type MaskedCorpusResult,
  type ParsedReportJson,
  type PerAssetAttribution,
  type RunUtilityOptionsForMask,
  rehydrateRunFromSerialized,
  runMaskedCorpus,
} from "./metrics";
import {
  type RunRecordSerialized,
  renderAttributionTable,
  renderCompareMarkdown,
  renderEvolveReport,
  renderUtilityReport,
  type UtilityRunReport,
} from "./report";
import { runUtility } from "./runner";

const HELP = `akm-bench — agent-plus-akm evaluation framework

Usage:
  bun run tests/bench/cli.ts <subcommand> [...flags]

Subcommands:
  utility       Track A: paired noakm vs akm utility benchmark.
  evolve        Track B: longitudinal feedback → distill → propose loop.
  compare       Diff two report JSON files (refuses cross-model diffs).
  attribute     Per-asset marginal pass-rate contribution.

utility flags:
  --tasks <slice>          train | eval | all  (default: all)
  --seeds <N>              seeds per arm  (default: 5)
  --budget-tokens <N>      per-run token cap (default: 30000)
  --budget-wall-ms <N>     per-run wallclock cap in ms (default: 120000)
  --include-synthetic      add a third 'synthetic' arm where the model writes/uses its own
                           scratch notes (no AKM stash). Reports akm_over_synthetic_lift so
                           operators can see whether AKM beats a self-notes baseline.
  --json                   suppress the markdown summary on stderr (machine-readable only).
                           Without --json, JSON still goes to stdout and the markdown
                           summary is also written to stderr for human-friendly reads.
  -h, --help               show this message.

evolve flags:
  --tasks <domain>         domain id (e.g., docker-homelab) or 'all'. REQUIRED.
  --seeds <N>              seeds per arm (default: 5)
  --budget-tokens <N>      per-run token cap (default: 30000)
  --budget-wall-ms <N>     per-run wallclock cap in ms (default: 120000)
  --negative-threshold-count <N>  absolute negative-feedback count to evolve (default: 2)
  --negative-threshold-ratio <R>  ratio of negatives to total feedback (default: 0.5)
  --json                   suppress the markdown summary on stderr.

compare flags:
  --base <path>                 path to baseline UtilityRunReport JSON file. REQUIRED.
  --current <path>              path to current  UtilityRunReport JSON file. REQUIRED.
  --json                        emit the structured CompareResult JSON to stdout instead
                                of a markdown diff.
  --allow-corpus-mismatch       proceed even when the two reports disagree on the
                                selected task IDs / taskCorpusHash. The diff is
                                rendered with a warning instead of being refused.
  --allow-fixture-mismatch      proceed even when the two reports disagree on the
                                fixtureContentHash. Renders a warning instead of
                                refusing.
  Exit codes: 0 on successful diff, 1 on refusal (model/corpus/fixture-hash/schema/track mismatch),
              2 on input errors (missing files, malformed JSON, unknown flags).

attribute flags:
  --base <path>            path to a §13.3 utility run JSON (required).
  --top <N>                number of top-loaded assets to mask (default: 5; clamped).
  --json                   suppress the markdown summary on stderr.

Environment:
  BENCH_OPENCODE_MODEL   model id stamped into every RunResult. REQUIRED for utility.

See tests/bench/BENCH.md for the operator guide.
`;

interface ParsedArgs {
  subcommand: string;
  flags: Map<string, string>;
  bool: Set<string>;
  positional: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Map<string, string>();
  const bool = new Set<string>();
  const positional: string[] = [];
  const subcommand = argv[0] ?? "";
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      bool.add("help");
      continue;
    }
    if (arg === "--json") {
      bool.add("json");
      continue;
    }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq !== -1) {
        flags.set(arg.slice(2, eq), arg.slice(eq + 1));
      } else {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith("--")) {
          bool.add(arg.slice(2));
        } else {
          flags.set(arg.slice(2), next);
          i += 1;
        }
      }
      continue;
    }
    positional.push(arg);
  }
  return { subcommand, flags, bool, positional };
}

export interface UtilityCliOptions {
  slice: "train" | "eval" | "all";
  json: boolean;
  seedsPerArm: number;
  budgetTokens: number;
  budgetWallMs: number;
  model: string;
  /**
   * Track A synthetic-arm gate (#261). Threaded into `runUtility` as
   * `includeSynthetic`. Default `false` keeps the envelope byte-identical to
   * the pre-#261 two-arm shape.
   */
  includeSynthetic?: boolean;
  branch?: string;
  commit?: string;
  timestamp?: string;
}

export interface UtilityCliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * `utility` subcommand. Walks the corpus, runs K seeds per arm per task,
 * and produces the §13.3 report.
 *
 * Returns rather than mutates process to keep this unit-testable. The
 * `main()` driver below maps the result onto the actual stdout/stderr/exit.
 */
export async function runUtilityCli(options: UtilityCliOptions): Promise<UtilityCliResult> {
  const sliceFilter = options.slice === "all" ? undefined : options.slice;
  const tasks = listTasks(sliceFilter ? { slice: sliceFilter } : {});

  const report = await runUtility({
    tasks,
    arms: ["noakm", "akm"],
    model: options.model,
    seedsPerArm: options.seedsPerArm,
    budgetTokens: options.budgetTokens,
    budgetWallMs: options.budgetWallMs,
    slice: options.slice,
    // #261: thread the synthetic-arm gate. Default off — the envelope shape
    // is byte-identical to the pre-#261 output unless the operator opts in.
    ...(options.includeSynthetic ? { includeSynthetic: true } : {}),
    ...(options.branch !== undefined ? { branch: options.branch } : {}),
    ...(options.commit !== undefined ? { commit: options.commit } : {}),
    ...(options.timestamp !== undefined ? { timestamp: options.timestamp } : {}),
  });

  const { json, markdown } = renderUtilityReport(report);
  const jsonText = `${JSON.stringify(json, null, 2)}\n`;
  const markdownText = `${markdown}\n`;

  // JSON ALWAYS goes to stdout. This is the bench's machine-readable
  // contract (matches `tests/benchmark-suite.ts` and the future `bench
  // compare`/`attribute` subcommands). The `--json` flag means
  // "suppress the human-friendly markdown summary on stderr"; without it,
  // both the JSON envelope (stdout) and the markdown summary (stderr) are
  // emitted so an operator running it interactively gets both views.
  const stdout = jsonText;
  let stderr = options.json ? "" : markdownText;
  stderr += `tasks discovered: ${tasks.length} (slice=${options.slice})\n`;
  if (tasks.length === 0) {
    stderr += "no tasks found — corpus is empty or the slice filter excluded all tasks\n";
  }

  return { exitCode: 0, stdout, stderr };
}

export interface CompareCliOptions {
  basePath: string;
  currentPath: string;
  json: boolean;
  /** #250 — accept mismatched task corpora and emit a warning instead. */
  allowCorpusMismatch?: boolean;
  /** #250 — accept mismatched fixture-content hashes and emit a warning instead. */
  allowFixtureMismatch?: boolean;
}

/**
 * `compare` subcommand. Reads two UtilityRunReport JSON files from disk,
 * dispatches to `compareReports`, and renders either markdown (default) or
 * the structured JSON envelope to stdout.
 *
 * Exit-code shape:
 *   • 0 on a successful diff (regardless of whether the diff shows wins).
 *   • 1 on a refusal (model/hash/schema/track mismatch).
 *   • 2 on input errors (file missing, malformed JSON).
 *
 * Returned `UtilityCliResult` keeps this unit-testable; the `main()` driver
 * splices the result onto the actual process.
 */
export function runCompareCli(options: CompareCliOptions): UtilityCliResult {
  let baseRaw: string;
  let currentRaw: string;
  try {
    baseRaw = fs.readFileSync(options.basePath, "utf8");
  } catch (err) {
    return {
      exitCode: 2,
      stdout: "",
      stderr: `bench compare: cannot read --base ${options.basePath}: ${(err as Error).message}\n`,
    };
  }
  try {
    currentRaw = fs.readFileSync(options.currentPath, "utf8");
  } catch (err) {
    return {
      exitCode: 2,
      stdout: "",
      stderr: `bench compare: cannot read --current ${options.currentPath}: ${(err as Error).message}\n`,
    };
  }

  let base: ParsedReportJson;
  let current: ParsedReportJson;
  try {
    base = JSON.parse(baseRaw) as ParsedReportJson;
  } catch (err) {
    return { exitCode: 2, stdout: "", stderr: `bench compare: malformed JSON in --base: ${(err as Error).message}\n` };
  }
  try {
    current = JSON.parse(currentRaw) as ParsedReportJson;
  } catch (err) {
    return {
      exitCode: 2,
      stdout: "",
      stderr: `bench compare: malformed JSON in --current: ${(err as Error).message}\n`,
    };
  }

  const result = compareReports(base, current, {
    ...(options.allowCorpusMismatch ? { allowCorpusMismatch: true } : {}),
    ...(options.allowFixtureMismatch ? { allowFixtureMismatch: true } : {}),
  });
  const stdout = options.json ? `${JSON.stringify(result, null, 2)}\n` : `${renderCompareMarkdown(result)}\n`;
  let stderr = "";
  if (!result.ok) {
    stderr = `bench compare: ${result.message}\n`;
    return { exitCode: 1, stdout, stderr };
  }
  // One-line summary on stderr so an interactive operator sees it without
  // having to scan the markdown body.
  const agg = result.aggregate;
  stderr = `bench compare: pass_rate Δ=${agg.passRateDelta.toFixed(2)} (${agg.passRateSign}); ${result.perTask.length} tasks compared.\n`;
  for (const w of result.warnings) stderr += `warning: ${w}\n`;
  return { exitCode: 0, stdout, stderr };
}

/** Caller-facing options for `runAttributeCli`. */
export interface AttributeCliOptions {
  /** Path to a §13.3 utility run JSON file. */
  basePath: string;
  /** Top N most-loaded assets to mask. Default 5; clamped to asset count. */
  topN: number;
  /** Suppress the markdown summary on stderr. */
  json: boolean;
  /**
   * Test seam: when supplied, this function is used to drive the masked
   * re-runs instead of `runUtility`. Production omits it and the helper
   * uses the real runner.
   */
  runUtility?: (
    options: Omit<RunUtilityOptionsForMask, "spawn" | "materialiseStash"> & {
      tasks: TaskMetadata[];
      spawn?: RunUtilityOptionsForMask["spawn"];
      materialiseStash?: boolean;
    },
  ) => Promise<UtilityRunReport>;
  /**
   * Test seam: override the fixtures directory the masked-stash helper
   * copies from. Defaults to `tests/fixtures/stashes/`.
   */
  fixturesRoot?: string;
  /** Test seam: override the model stamped on masked re-runs. */
  modelOverride?: string;
}

export interface AttributeCliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * `attribute` subcommand. Loads a base utility report, picks the top-N
 * most-loaded assets, masks each in turn, re-runs the corpus, and emits a
 * marginal-contribution report.
 *
 * Cost: N × (tasks × arms × seedsPerArm) re-runs. Reported to stderr up
 * front so the operator can abort if the projection is too expensive.
 */
export async function runAttributeCli(options: AttributeCliOptions): Promise<AttributeCliResult> {
  if (!fs.existsSync(options.basePath)) {
    return {
      exitCode: 2,
      stdout: "",
      stderr: `bench attribute: base report not found: ${options.basePath}\n`,
    };
  }

  let baseEnvelope: Record<string, unknown>;
  try {
    baseEnvelope = JSON.parse(fs.readFileSync(options.basePath, "utf8")) as Record<string, unknown>;
  } catch (err) {
    return {
      exitCode: 2,
      stdout: "",
      stderr: `bench attribute: failed to parse ${options.basePath}: ${err instanceof Error ? err.message : String(err)}\n`,
    };
  }

  const corpus = (baseEnvelope.corpus ?? {}) as Record<string, unknown>;
  const sliceRaw = (corpus.slice ?? "all") as string;
  const slice: "train" | "eval" | "all" = sliceRaw === "train" || sliceRaw === "eval" ? sliceRaw : "all";
  const sliceFilter = slice === "all" ? undefined : slice;
  const tasks = listTasks(sliceFilter ? { slice: sliceFilter } : {});
  const seedsPerArm = typeof corpus.seedsPerArm === "number" ? corpus.seedsPerArm : 5;
  const agent = (baseEnvelope.agent ?? {}) as Record<string, unknown>;
  const model = options.modelOverride ?? (typeof agent.model === "string" ? agent.model : "unknown");

  // The stored envelope's perAsset is in snake_case. Convert it back to the
  // PerAssetAttribution shape the metrics module expects so we can pass it
  // through to runMaskedCorpus.
  const perAssetSerialised = baseEnvelope.perAsset as
    | { total_akm_runs?: number; rows?: Array<Record<string, unknown>> }
    | undefined;
  const perAsset: PerAssetAttribution = {
    totalAkmRuns: perAssetSerialised?.total_akm_runs ?? 0,
    rows: (perAssetSerialised?.rows ?? []).map((r) => ({
      assetRef: String(r.asset_ref ?? ""),
      loadCount: Number(r.load_count ?? 0),
      loadCountPassing: Number(r.load_count_passing ?? 0),
      loadCountFailing: Number(r.load_count_failing ?? 0),
      loadPassRate: r.load_pass_rate === null ? null : Number(r.load_pass_rate),
    })),
  };

  if (perAsset.rows.length === 0) {
    return {
      exitCode: 2,
      stdout: "",
      stderr:
        "bench attribute: base report has no per-asset attribution rows (no assets loaded). Re-run `bench utility` first.\n",
    };
  }

  const desired = Math.max(1, options.topN);
  const clamped = Math.min(desired, perAsset.rows.length);

  // Prefer the persisted `runs[]` array (#249). When the report carries
  // serialised raw runs we hydrate them back into RunResult shape and feed
  // them to `runMaskedCorpus` directly — that keeps attribution faithful to
  // the original (task, arm, seed) bag instead of synthesising stubs from
  // the per-asset aggregate. Falls back to the legacy aggregate path when
  // the report pre-dates the `runs[]` field.
  const persistedRuns = readPersistedRuns(baseEnvelope);
  const akmRuns =
    persistedRuns !== null ? persistedRuns.filter((r) => r.arm === "akm") : synthesiseAkmRunsFromAttribution(perAsset);
  const baseReport: UtilityRunReport = {
    timestamp: String(baseEnvelope.timestamp ?? ""),
    branch: String(baseEnvelope.branch ?? ""),
    commit: String(baseEnvelope.commit ?? ""),
    model,
    corpus: {
      domains: typeof corpus.domains === "number" ? corpus.domains : 0,
      tasks: typeof corpus.tasks === "number" ? corpus.tasks : tasks.length,
      slice,
      seedsPerArm,
    },
    aggregateNoakm: extractCorpusMetrics(baseEnvelope, "noakm"),
    aggregateAkm: extractCorpusMetrics(baseEnvelope, "akm"),
    aggregateDelta: extractCorpusMetrics(baseEnvelope, "delta"),
    trajectoryAkm: { correctAssetLoaded: null, feedbackRecorded: 0 },
    tasks: [],
    warnings: [],
    perAsset,
    akmRuns,
    taskMetadata: tasks,
  };

  const projection = clamped * tasks.length * 2 * seedsPerArm;
  let stderr = `bench attribute: masking top ${clamped} of ${perAsset.rows.length} assets; ${clamped} × ${tasks.length} tasks × 2 arms × ${seedsPerArm} seeds = ${projection} re-runs.\n`;

  const baseOptions: RunUtilityOptionsForMask = {
    arms: ["noakm", "akm"],
    model,
    seedsPerArm,
  };

  const maskedRunner = options.runUtility ?? defaultMaskedRunner;
  let maskedResult: MaskedCorpusResult;
  try {
    maskedResult = await runMaskedCorpus({
      baseReport,
      topN: clamped,
      runUtility: maskedRunner,
      baseOptions,
      ...(options.fixturesRoot ? { fixturesRoot: options.fixturesRoot } : {}),
    });
  } catch (err) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `${stderr}bench attribute: masked-corpus run failed: ${err instanceof Error ? err.message : String(err)}\n`,
    };
  }

  const json = {
    schemaVersion: 1,
    track: "attribute",
    base: { path: options.basePath, model },
    // Issue #251: surface the masking strategy + the exact masked refs in
    // the JSON envelope so operators can audit the marginal-contribution
    // numbers without re-running the masker. The `maskedRefs` order matches
    // `attributions[]`. Strategy is currently always `"leave-one-out"`;
    // future strategies extend the union in `MaskedCorpusResult`.
    attribution: {
      maskingStrategy: maskedResult.maskingStrategy,
      maskedRefs: maskedResult.maskedRefs,
    },
    maskingStrategy: maskedResult.maskingStrategy,
    runsPerformed: maskedResult.runsPerformed,
    perAsset: {
      total_akm_runs: perAsset.totalAkmRuns,
      rows: perAsset.rows.map((r) => ({
        asset_ref: r.assetRef,
        load_count: r.loadCount,
        load_count_passing: r.loadCountPassing,
        load_count_failing: r.loadCountFailing,
        load_pass_rate: r.loadPassRate,
      })),
    },
    attributions: maskedResult.attributions.map((a) => ({
      asset_ref: a.assetRef,
      base_pass_rate: a.basePassRate,
      masked_pass_rate: a.maskedPassRate,
      marginal_contribution: a.marginalContribution,
    })),
  };

  const stdout = `${JSON.stringify(json, null, 2)}\n`;
  if (!options.json) {
    stderr += `${renderAttributionTable(perAsset)}\n`;
    stderr += `\n## Marginal contributions (leave-one-out)\n\n`;
    stderr += `| asset_ref | base_pass_rate | masked_pass_rate | marginal_contribution |\n`;
    stderr += `|-----------|----------------|------------------|-----------------------|\n`;
    for (const a of maskedResult.attributions) {
      stderr += `| \`${a.assetRef}\` | ${a.basePassRate.toFixed(2)} | ${a.maskedPassRate.toFixed(2)} | ${signed(a.marginalContribution.toFixed(2))} |\n`;
    }
  }

  return { exitCode: 0, stdout, stderr };
}

/** Default real-runner wrapper for masked re-runs. */
async function defaultMaskedRunner(
  options: Omit<RunUtilityOptionsForMask, "spawn" | "materialiseStash"> & {
    tasks: TaskMetadata[];
    spawn?: RunUtilityOptionsForMask["spawn"];
    materialiseStash?: boolean;
  },
): Promise<UtilityRunReport> {
  const arms = options.arms;
  return runUtility({
    tasks: options.tasks,
    arms,
    model: options.model,
    ...(options.seedsPerArm !== undefined ? { seedsPerArm: options.seedsPerArm } : {}),
    ...(options.budgetTokens !== undefined ? { budgetTokens: options.budgetTokens } : {}),
    ...(options.budgetWallMs !== undefined ? { budgetWallMs: options.budgetWallMs } : {}),
    ...(options.slice !== undefined ? { slice: options.slice } : {}),
    ...(options.timestamp !== undefined ? { timestamp: options.timestamp } : {}),
    ...(options.branch !== undefined ? { branch: options.branch } : {}),
    ...(options.commit !== undefined ? { commit: options.commit } : {}),
    ...(options.spawn ? { spawn: options.spawn } : {}),
    ...(options.materialiseStash !== undefined ? { materialiseStash: options.materialiseStash } : {}),
  });
}

/**
 * Best-effort extractor for `aggregate.<arm>` corpus metrics from the
 * persisted §13.3 envelope. The envelope keys are snake-cased.
 */
function extractCorpusMetrics(
  envelope: Record<string, unknown>,
  key: "noakm" | "akm" | "delta",
): { passRate: number; tokensPerPass: number | null; wallclockMs: number } {
  const aggregate = (envelope.aggregate ?? {}) as Record<string, unknown>;
  const node = (aggregate[key] ?? {}) as Record<string, unknown>;
  return {
    passRate: typeof node.pass_rate === "number" ? node.pass_rate : 0,
    tokensPerPass:
      node.tokens_per_pass === null ? null : typeof node.tokens_per_pass === "number" ? node.tokens_per_pass : null,
    wallclockMs: typeof node.wallclock_ms === "number" ? node.wallclock_ms : 0,
  };
}

/**
 * Read the persisted `runs[]` array (#249) from a §13.3 envelope and hydrate
 * each row back into the in-memory `RunResult` shape. Returns `null` when the
 * envelope pre-dates the field (legacy reports) so callers can fall back to
 * the aggregate-only path.
 *
 * Structurally validates each row: rows that don't carry the required keys
 * are skipped silently. We intentionally avoid throwing — older envelopes
 * with partial shapes still want to flow through the legacy path.
 */
function readPersistedRuns(envelope: Record<string, unknown>): import("./driver").RunResult[] | null {
  const raw = envelope.runs;
  if (!Array.isArray(raw)) return null;
  const out: import("./driver").RunResult[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const row = r as Partial<RunRecordSerialized> & Record<string, unknown>;
    if (typeof row.task_id !== "string") continue;
    if (typeof row.arm !== "string") continue;
    if (typeof row.seed !== "number") continue;
    if (typeof row.outcome !== "string") continue;
    // Trajectory shape: tolerate missing/partial sub-object so we don't
    // reject otherwise-valid rows.
    const traj = (row.trajectory ?? {}) as {
      correct_asset_loaded?: boolean | null;
      feedback_recorded?: boolean | null;
    };
    const normalised: RunRecordSerialized = {
      task_id: row.task_id,
      arm: row.arm,
      seed: row.seed,
      model: typeof row.model === "string" ? row.model : "unknown",
      outcome: row.outcome,
      tokens: (row.tokens as Record<string, unknown>) ?? { input: 0, output: 0 },
      wallclock_ms: typeof row.wallclock_ms === "number" ? row.wallclock_ms : 0,
      verifier_exit_code: typeof row.verifier_exit_code === "number" ? row.verifier_exit_code : 0,
      trajectory: {
        correct_asset_loaded: traj.correct_asset_loaded ?? null,
        feedback_recorded: traj.feedback_recorded ?? null,
      },
      assets_loaded: Array.isArray(row.assets_loaded) ? (row.assets_loaded as string[]) : [],
      failure_mode: typeof row.failure_mode === "string" ? row.failure_mode : null,
    };
    out.push(rehydrateRunFromSerialized(normalised));
  }
  return out;
}

/**
 * Build a synthetic akm-arm RunResult bag from a previously-computed
 * attribution table. Used when we load a §13.3 envelope from disk: the
 * envelope doesn't carry raw RunResults, but the attribution table is
 * lossless w.r.t. (asset, pass/fail) counts — which is all
 * `computePerAssetAttribution` needs to reproduce the top-N ranking.
 *
 * Each synthetic run loads exactly one asset. This over-counts the run
 * total but keeps the per-asset counts faithful to the original table. The
 * synthesised runs are NOT consumed by `runMaskedCorpus` for the masked
 * runs themselves — those go through the injected runner — they only seed
 * `report.akmRuns` so that recomputing the attribution gives back the
 * same top-N ordering.
 */
function synthesiseAkmRunsFromAttribution(perAsset: PerAssetAttribution): import("./driver").RunResult[] {
  const out: import("./driver").RunResult[] = [];
  for (const row of perAsset.rows) {
    for (let i = 0; i < row.loadCountPassing; i++) {
      out.push(makeSyntheticRun("pass", row.assetRef));
    }
    for (let i = 0; i < row.loadCountFailing; i++) {
      out.push(makeSyntheticRun("fail", row.assetRef));
    }
  }
  return out;
}

function makeSyntheticRun(outcome: "pass" | "fail", ref: string): import("./driver").RunResult {
  return {
    schemaVersion: 1,
    taskId: "synthetic",
    arm: "akm",
    seed: 0,
    model: "synthetic",
    outcome,
    tokens: { input: 0, output: 0 },
    wallclockMs: 0,
    trajectory: { correctAssetLoaded: null, feedbackRecorded: null },
    events: [],
    verifierStdout: "",
    verifierExitCode: outcome === "pass" ? 0 : 1,
    assetsLoaded: [ref],
  };
}

function signed(text: string): string {
  if (text.startsWith("-")) return text;
  if (text === "0" || text === "0.00" || text === "0.0") return text;
  return `+${text}`;
}

function getEnv(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

function parseInt32(text: string | undefined, fallback: number): number {
  if (text === undefined) return fallback;
  const n = Number.parseInt(text, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

function parseFloatArg(text: string | undefined, fallback: number): number {
  if (text === undefined) return fallback;
  const n = Number.parseFloat(text);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

export interface EvolveCliOptions {
  /** Domain id (e.g., `docker-homelab`) or the literal `all`. */
  domain: string;
  json: boolean;
  seedsPerArm: number;
  budgetTokens: number;
  budgetWallMs: number;
  model: string;
  negativeThreshold: { absoluteCount: number; ratio: number };
  branch?: string;
  commit?: string;
  timestamp?: string;
}

/**
 * `evolve` subcommand. Filters the corpus to one domain (or `all`), then
 * dispatches `runEvolve` and renders the §6.3+§6.4 envelope.
 */
export async function runEvolveCli(options: EvolveCliOptions): Promise<UtilityCliResult> {
  // Discover all tasks then filter on domain.
  const allTasks = listTasks();
  const tasks = options.domain === "all" ? allTasks : allTasks.filter((t) => t.domain === options.domain);

  if (tasks.length === 0) {
    return {
      exitCode: 2,
      stdout: "",
      stderr: `bench evolve: no tasks matched domain "${options.domain}".\n`,
    };
  }

  const report = await runEvolve({
    tasks,
    model: options.model,
    seedsPerArm: options.seedsPerArm,
    budgetTokens: options.budgetTokens,
    budgetWallMs: options.budgetWallMs,
    negativeThreshold: options.negativeThreshold,
    ...(options.branch !== undefined ? { branch: options.branch } : {}),
    ...(options.commit !== undefined ? { commit: options.commit } : {}),
    ...(options.timestamp !== undefined ? { timestamp: options.timestamp } : {}),
  });

  const { json, markdown } = renderEvolveReport(report);
  const stdout = `${JSON.stringify(json, null, 2)}\n`;
  let stderr = options.json ? "" : `${markdown}\n`;
  stderr += `tasks discovered: ${tasks.length} (domain=${options.domain})\n`;
  return { exitCode: 0, stdout, stderr };
}

async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);

  if (parsed.bool.has("help") || parsed.subcommand === "" || parsed.subcommand === "help") {
    process.stdout.write(HELP);
    return parsed.subcommand === "" ? 2 : 0;
  }

  switch (parsed.subcommand) {
    case "utility": {
      const sliceRaw = parsed.flags.get("tasks") ?? "all";
      if (sliceRaw !== "train" && sliceRaw !== "eval" && sliceRaw !== "all") {
        process.stderr.write(
          `bench utility: invalid --tasks value "${sliceRaw}"; expected one of: all, train, eval.\n`,
        );
        return 2;
      }
      const slice = sliceRaw as "train" | "eval" | "all";
      const model = getEnv("BENCH_OPENCODE_MODEL");
      if (!model) {
        process.stderr.write("bench utility: BENCH_OPENCODE_MODEL environment variable is required.\n");
        return 2;
      }
      const result = await runUtilityCli({
        slice,
        json: parsed.bool.has("json"),
        seedsPerArm: parseInt32(parsed.flags.get("seeds"), 5),
        budgetTokens: parseInt32(parsed.flags.get("budget-tokens"), 30000),
        budgetWallMs: parseInt32(parsed.flags.get("budget-wall-ms"), 120000),
        model,
        ...(parsed.bool.has("include-synthetic") ? { includeSynthetic: true } : {}),
      });
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      return result.exitCode;
    }
    case "evolve": {
      const domain = parsed.flags.get("tasks");
      if (!domain) {
        process.stderr.write("bench evolve: --tasks <domain> is required (use --tasks all to run the full corpus).\n");
        return 2;
      }
      const model = getEnv("BENCH_OPENCODE_MODEL");
      if (!model) {
        process.stderr.write("bench evolve: BENCH_OPENCODE_MODEL environment variable is required.\n");
        return 2;
      }
      const result = await runEvolveCli({
        domain,
        json: parsed.bool.has("json"),
        seedsPerArm: parseInt32(parsed.flags.get("seeds"), 5),
        budgetTokens: parseInt32(parsed.flags.get("budget-tokens"), 30000),
        budgetWallMs: parseInt32(parsed.flags.get("budget-wall-ms"), 120000),
        model,
        negativeThreshold: {
          absoluteCount: parseInt32(parsed.flags.get("negative-threshold-count"), 2),
          ratio: parseFloatArg(parsed.flags.get("negative-threshold-ratio"), 0.5),
        },
      });
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      return result.exitCode;
    }
    case "compare": {
      const basePath = parsed.flags.get("base");
      const currentPath = parsed.flags.get("current");
      if (!basePath || !currentPath) {
        process.stderr.write("bench compare: --base and --current are both required.\n");
        return 2;
      }
      const result = runCompareCli({
        basePath,
        currentPath,
        json: parsed.bool.has("json"),
        allowCorpusMismatch: parsed.bool.has("allow-corpus-mismatch"),
        allowFixtureMismatch: parsed.bool.has("allow-fixture-mismatch"),
      });
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      return result.exitCode;
    }
    case "attribute": {
      const basePath = parsed.flags.get("base");
      if (!basePath) {
        process.stderr.write("bench attribute: --base <path> is required.\n");
        return 2;
      }
      const topN = parseInt32(parsed.flags.get("top"), 5);
      const result = await runAttributeCli({
        basePath,
        topN,
        json: parsed.bool.has("json"),
      });
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      return result.exitCode;
    }
    default:
      process.stderr.write(`unknown subcommand: ${parsed.subcommand}\n`);
      process.stderr.write(HELP);
      return 2;
  }
}

// Only execute when invoked directly. The exported `runUtilityCli` is callable
// from tests without triggering process.exit.
if (import.meta.main) {
  const code = await main(process.argv.slice(2));
  process.exit(code);
}
