/**
 * akm-bench K-seed runner (spec §5 + §6).
 *
 * `runUtility(options)` is the single entry point used by both the CLI
 * dispatcher (`tests/bench/cli.ts utility`) and unit tests. It expands the
 * caller's `(tasks × arms × seeds)` cartesian product, calls `runOne` for
 * each triple, splices the trajectory record back in, and returns a
 * `UtilityRunReport` that `renderUtilityReport` can stamp into JSON +
 * markdown.
 *
 * Per-(arm, seed) isolation:
 *   • Workspace: each (task, arm, seed) gets a fresh tmp dir seeded from the
 *     task's `workspace/` template so runs cannot pollute each other.
 *   • Stash: only the `akm` arm materialises a stash via `loadFixtureStash`.
 *     We materialise once per task (the stash content is identical across
 *     the K seeds) and reuse it.
 *
 * Cleanup: every tmp resource is wrapped in `try/finally`. We never leak
 * tmp dirs even on harness exceptions.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { warn } from "../../src/core/warn";
import type { SpawnFn } from "../../src/integrations/agent/spawn";
import { computeFixtureContentHash, type LoadedFixtureStash, loadFixtureStash } from "../fixtures/stashes/load";
import { registerCleanup } from "./cleanup";
import { computeTaskCorpusHash, readTaskBody, type TaskMetadata, type TaskSlice } from "./corpus";
import { type RunOptions, type RunResult, runOne } from "./driver";
import {
  aggregateCorpus,
  aggregateFailureModes,
  aggregatePerTask,
  aggregateTrajectory,
  classifyFailureMode,
  computeCorpusDelta,
  computePerAssetAttribution,
  computePerTaskDelta,
  computeSearchBridge,
  extractAssetLoads,
  extractGoldRanks,
  type FailureMode,
  type GoldRankRunRecord,
  type PerTaskMetrics,
} from "./metrics";
import type { LoadedOpencodeProviders } from "./opencode-config";
import { resolveGitBranch, resolveGitCommit, type UtilityReportTaskEntry, type UtilityRunReport } from "./report";
import { benchMkdtemp, benchTmpRoot } from "./tmp";
import { computeTrajectory } from "./trajectory";
import {
  evaluateRunAgainstAllSpecs,
  type WorkflowCheckResult,
  type WorkflowEvalRunContext,
} from "./workflow-evaluator";
import { loadAllWorkflowSpecs, type WorkflowSpec } from "./workflow-spec";
import { normalizeRunToTrace } from "./workflow-trace";

/** Checkpoint write interval: write a partial file every N completed runs. */
const CHECKPOINT_INTERVAL = 5;

/** Partial file max age before cleanup: 24 hours in milliseconds. */
const PARTIAL_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Emit a one-line progress update to stderr after each (task, arm, seed)
 * completes. Goes to stderr even when --json is passed so operators always
 * have a heartbeat signal during long runs.
 *
 * Format: `[<completed>/<total>] <taskId> <arm> <outcome> <wallclockSeconds>s`
 */
function emitProgress(completed: number, total: number, run: RunResult): void {
  const secs = Math.round(run.wallclockMs / 1000);
  process.stderr.write(`[${completed}/${total}] ${run.taskId} ${run.arm} ${run.outcome} ${secs}s\n`);
}

/**
 * Write a partial checkpoint file under `${AKM_CACHE_DIR}/bench/`.
 * The file contains the runs completed so far plus a `partial: true` marker
 * and a `summary.total_runs_completed` counter. Old partial files (>24h)
 * are not cleaned up here — that is done at startup via `cleanupOldPartials`.
 */
function writePartialCheckpoint(runs: RunResult[], timestamp: string): void {
  try {
    const root = benchTmpRoot();
    const filename = `bench-partial-${timestamp.replace(/[:.]/g, "-")}.json`;
    const outPath = path.join(root, filename);
    const envelope = {
      partial: true,
      summary: {
        total_runs_completed: runs.length,
      },
      timestamp,
      runs: runs.map((r) => ({
        task_id: r.taskId,
        arm: r.arm,
        seed: r.seed,
        model: r.model,
        outcome: r.outcome,
        wallclock_ms: r.wallclockMs,
      })),
    };
    fs.writeFileSync(outPath, JSON.stringify(envelope, null, 2), "utf8");
  } catch {
    // Checkpoint writes are best-effort — never abort a run for a write failure.
  }
}

/**
 * Remove partial checkpoint files older than 24 hours from the bench tmp root.
 * Called once at the start of `runUtility` to reap orphans from prior crashed runs.
 */
function cleanupOldPartials(): void {
  try {
    const root = benchTmpRoot();
    const now = Date.now();
    const entries = fs.readdirSync(root);
    for (const entry of entries) {
      if (!entry.startsWith("bench-partial-")) continue;
      const fullPath = path.join(root, entry);
      try {
        const stat = fs.statSync(fullPath);
        if (now - stat.mtimeMs > PARTIAL_MAX_AGE_MS) {
          fs.unlinkSync(fullPath);
        }
      } catch {
        /* swallow per-file errors */
      }
    }
  } catch {
    /* swallow — cleanup is best-effort */
  }
}

/**
 * Default workflows directory. Can be overridden by callers (tests) via
 * `RunUtilityOptions.workflowsDir`. Specs in this directory are loaded ONCE
 * per `runUtility` call (not per run) — the evaluator filters via each spec's
 * `applies_to` so we don't I/O in the hot loop.
 */
const DEFAULT_WORKFLOWS_DIR = path.resolve(__dirname, "..", "fixtures", "bench", "workflows");

export type Arm = "noakm" | "akm" | "synthetic";

/**
 * Optional per-arm prompt-override seam (#267). The runner forwards the
 * builder's return value into `RunOptions.prompt` for each `runOne` call.
 * When the builder returns `undefined`, the driver falls back to its
 * default prompt path. The function is invoked once per (task, arm) and
 * shared across the K seeds — prompts must not depend on `seed`.
 *
 * Picked the single-builder shape (Option B in the brief) because the bench
 * already has just one synthetic-arm prompt; a per-arm map would be three
 * keys with two always undefined.
 */
export type BuildPromptFn = (task: TaskMetadata, arm: Arm) => string | undefined;

/** Caller-facing options for `runUtility`. */
export interface RunUtilityOptions {
  tasks: TaskMetadata[];
  arms: Arm[];
  model: string;
  /** K seeds per arm. Defaults to 5. */
  seedsPerArm?: number;
  /** Token budget per run. Defaults to 30000 (spec §7.1). */
  budgetTokens?: number;
  /** Wallclock budget per run in ms. Defaults to 120000. */
  budgetWallMs?: number;
  /**
   * Number of (task, arm, seed) triples to execute concurrently. Defaults to
   * 1 (sequential). Clamped to [1, 8] — values above 8 are silently capped.
   * Values above 4 trigger a stderr warning unless `forceParallel` is set.
   */
  parallel?: number;
  /**
   * Suppress the high-parallelism warning when `parallel > 4`. Tests and
   * operators who understand the resource implications may set this to avoid
   * the noisy stderr message.
   */
  forceParallel?: boolean;
  /** Slice label stamped into the report's `corpus.slice` field. */
  slice?: TaskSlice | "all";
  /** Override timestamp (tests). Defaults to `new Date().toISOString()`. */
  timestamp?: string;
  /** Override branch (tests). Defaults to `git rev-parse --abbrev-ref HEAD`. */
  branch?: string;
  /** Override commit sha (tests). Defaults to `git rev-parse --short HEAD`. */
  commit?: string;
  /** Injected spawn for unit tests. Forwarded to `runOne` for every triple. */
  spawn?: SpawnFn;
  /**
   * Whether to materialise the akm stash via `loadFixtureStash`. Tests pass
   * `false` so the runner never spawns `akm index` against a real fixture.
   * Defaults to `true`.
   */
  materialiseStash?: boolean;
  /**
   * Optional override map keyed by `task.stash` (fixture name). When provided,
   * the runner skips per-task `loadFixtureStash` and forwards the supplied
   * directory as `AKM_STASH_DIR` for the akm arm of every task whose
   * `task.stash` is in the map. Used by `runEvolve` so a single
   * pre-materialised stash persists across Phase 1 / Phase 2 / Phase 3.
   * When set, `materialiseStash` is ignored for tasks whose fixture is
   * present in this map.
   */
  stashDirByFixture?: Map<string, string>;
  /**
   * Optional per-arm prompt override (#267). When supplied and the builder
   * returns a non-undefined string, that string is forwarded as
   * `RunOptions.prompt` to `runOne` for the (task, arm) pair. When the
   * builder returns undefined, the driver's default prompt is used.
   *
   * Used by Phase 3 of `runEvolve` to thread `buildSyntheticPrompt(task)`
   * into the synthetic arm. The pre / post arms keep the default akm-arm
   * prompt by returning undefined.
   */
  buildPrompt?: BuildPromptFn;
  /**
   * Track A synthetic-arm gate (#261). When `true`, the runner adds a third
   * arm (`synthetic`) to every task in the corpus. The synthetic arm runs
   * the same tasks/seeds/model/budgets/verifiers as `noakm`/`akm` but
   * receives a scratch-notes prompt contract (the model creates and uses
   * its own procedural notes rather than consulting an AKM stash). The
   * synthetic-arm child env explicitly DELETES `AKM_STASH_DIR` so the
   * operator's real stash never leaks in (recurrence guard for the #243
   * fixup pattern).
   *
   * Default behaviour (when `false` or omitted) is byte-identical to the
   * pre-#261 two-arm output: the report carries no `synthetic` keys, the
   * markdown summary mentions no synthetic arm, and the runner skips the
   * synthetic-arm orchestration entirely.
   */
  includeSynthetic?: boolean;
  /**
   * Override the workflows-spec directory (#257). When omitted, the runner
   * loads `tests/fixtures/bench/workflows/*.yaml` once per `runUtility` call
   * and feeds the parsed specs to `evaluateRunAgainstAllSpecs` for every
   * akm-arm run. When supplied, the directory is loaded instead. Pass an
   * empty string to disable workflow evaluation entirely (tests).
   */
  workflowsDir?: string;
  /**
   * Pre-loaded opencode provider config. Loaded ONCE per `runUtility` call
   * (not per run) and forwarded into every `runOneIsolated` / `runOne` call.
   * When omitted, the per-run `OPENCODE_CONFIG` dir is left empty and
   * opencode falls back to its cloud-provider defaults.
   */
  opencodeProviders?: LoadedOpencodeProviders;
}

/** Internal: raw run records grouped by (taskId, arm). */
type GroupedRuns = Map<string, Map<Arm, RunResult[]>>;

/**
 * Internal: gold-rank records collected across all akm-arm runs in the
 * current `runUtility` call. Reduced into `searchBridge` once every run
 * lands.
 */
type GoldRankAccumulator = GoldRankRunRecord[];

/**
 * Run `items` in batches of `n` concurrently, calling `fn` for each item.
 * Batches are executed sequentially; within each batch all items run with
 * `Promise.all`. This gives bounded concurrency without a full work-queue.
 */
async function runInBatches<T>(items: T[], n: number, fn: (item: T) => Promise<void>): Promise<void> {
  for (let i = 0; i < items.length; i += n) {
    await Promise.all(items.slice(i, i + n).map(fn));
  }
}

/**
 * Run K seeds × len(arms) × len(tasks) and return the §13.3 report.
 *
 * The function is robust to per-run failures — `runOne` already captures
 * every failure path into a RunResult, so the runner only has to worry
 * about its own infrastructure (stash materialisation, workspace copy).
 * Those failures are recorded as `harness_error` runs.
 *
 * When `options.parallel > 1`, work items are batched and run concurrently
 * via `runInBatches`. The shared `warnings`, `goldRankRecords`, and
 * `workflowChecks` arrays are updated atomically at the end of each item so
 * no JS-level races occur (Node/Bun is single-threaded).
 */
export async function runUtility(options: RunUtilityOptions): Promise<UtilityRunReport> {
  const seedsPerArm = options.seedsPerArm ?? 5;
  const budgetTokens = options.budgetTokens ?? 30000;
  const budgetWallMs = options.budgetWallMs ?? 120000;
  const slice = options.slice ?? "all";
  const materialiseStash = options.materialiseStash ?? true;
  // Clamp parallel to [1, 8].
  const parallel = Math.min(8, Math.max(1, options.parallel ?? 1));

  if (parallel > 4 && !options.forceParallel) {
    process.stderr.write(
      `bench: --parallel ${parallel} exceeds 4; high concurrency may overwhelm local providers. ` +
        `Pass --force-parallel to suppress this warning.\n`,
    );
  }

  // Clean up orphaned partial files from prior crashed runs (best-effort).
  cleanupOldPartials();

  const grouped: GroupedRuns = new Map();
  const warnings: string[] = [];
  const goldRankRecords: GoldRankAccumulator = [];

  // Progress tracking: compute total run count upfront so progress lines show
  // `[7/40]` rather than an unbounded counter.
  const armsForProgress = options.includeSynthetic
    ? [...new Set([...options.arms, "synthetic" as const])]
    : options.arms;
  const totalRuns = options.tasks.length * armsForProgress.length * seedsPerArm;
  let completedRuns = 0;

  // Partial checkpoint accumulator: collects all RunResults as they land so
  // we can write a partial envelope periodically without keeping duplicates.
  const allCompletedRuns: RunResult[] = [];
  const runTimestamp = options.timestamp ?? new Date().toISOString();

  // #257: load workflow specs ONCE per runUtility call. Skipped when the
  // caller passes an empty `workflowsDir` string (test escape hatch). Errors
  // are surfaced as warnings — workflow evaluation is best-effort and a
  // missing/malformed spec must not abort the whole bench run.
  const workflowSpecs: WorkflowSpec[] = [];
  const workflowsDir = options.workflowsDir ?? DEFAULT_WORKFLOWS_DIR;
  if (workflowsDir.length > 0) {
    try {
      const loaded = loadAllWorkflowSpecs(workflowsDir);
      workflowSpecs.push(...loaded);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`workflow specs: failed to load from "${workflowsDir}": ${msg}`);
      warn(`[runUtility] workflow specs unavailable: ${msg}`);
    }
  }
  const workflowChecks: WorkflowCheckResult[] = [];

  for (const task of options.tasks) {
    const taskRuns = new Map<Arm, RunResult[]>();
    grouped.set(task.id, taskRuns);

    // Resolve a caller-supplied stash override before materialising. When
    // `stashDirByFixture` provides a directory for this task's fixture, we
    // skip `loadFixtureStash` entirely and forward the override.
    const overrideStashDir = options.stashDirByFixture?.get(task.stash);

    // Materialise the akm-arm stash once per task. We share it across the K
    // seeds because the stash content is identical and re-running `akm
    // index` for every seed is wasted work.
    let stash: LoadedFixtureStash | undefined;
    let stashError: string | undefined;
    if (options.arms.includes("akm") && materialiseStash && !overrideStashDir) {
      try {
        stash = loadFixtureStash(task.stash);
      } catch (err) {
        stashError = err instanceof Error ? err.message : String(err);
        warnings.push(`task ${task.id}: stash "${task.stash}" failed to load: ${stashError}`);
      }
    }

    // SIGINT/SIGTERM trap (#267): register the per-task stash cleanup so an
    // external signal mid-run reaps the tmp dir we just created.
    const stashSnapshot = stash;
    const deregisterStash = stashSnapshot
      ? registerCleanup(() => {
          try {
            stashSnapshot.cleanup();
          } catch {
            /* swallow */
          }
        })
      : () => {};

    // #261: when `includeSynthetic` is set, splice the synthetic arm into the
    // per-task arm iteration alongside whatever the caller asked for. We
    // dedupe so a caller that already passes `synthetic` in `arms` does not
    // see it run twice. Pre-#261 callers (no flag, no `synthetic` in arms)
    // see the old loop verbatim — that's the byte-identical default contract.
    const armsForTask: Arm[] = (() => {
      if (!options.includeSynthetic) return options.arms;
      if (options.arms.includes("synthetic")) return options.arms;
      return [...options.arms, "synthetic"];
    })();

    // Build the flat work-item list for this task: every (arm, seed) pair.
    // Initialise each arm's RunResult[] array now so parallel workers can
    // push into the correct bucket without races (JS push is atomic within
    // the single-threaded event loop).
    type WorkItem = { arm: Arm; seed: number };
    const workItems: WorkItem[] = [];
    for (const arm of armsForTask) {
      taskRuns.set(arm, []);
      for (let seed = 0; seed < seedsPerArm; seed += 1) {
        workItems.push({ arm, seed });
      }
    }

    // Per-run worker: resolves stash/prompt, executes runOneIsolated, then
    // splices the result into the shared accumulators. Because Bun/Node is
    // single-threaded these splices are race-free even across concurrent
    // awaits — only one microtask runs at a time between yield points.
    const runItem = async ({ arm, seed }: WorkItem): Promise<void> => {
      // Resolve the stashDir we'll forward to the agent. The akm arm
      // always carries a stashDir so AKM_STASH_DIR is set in the child
      // env — this is how downstream tooling (and the trajectory parser
      // event-stream lookup) distinguishes arms. When the operator opted
      // out of fixture materialisation (tests, dry-run), we still pass a
      // stable placeholder so the env keys are wired correctly.
      let stashDir: string | undefined;
      if (arm === "akm") {
        // Resolution order (must match the issue #251 acceptance criteria):
        //   1. Per-task explicit override (used by `runMaskedCorpus` to
        //      point at a tmp stash with one asset removed). Highest
        //      priority because attribution correctness depends on this
        //      branch never being shadowed by the `__no-stash__`
        //      placeholder fallback.
        //   2. Per-(task, arm)-call `stashDirByFixture` override (Phase
        //      3 evolve persistence).
        //   3. Per-task materialised fixture stash from `loadFixtureStash`.
        //   4. `materialiseStash: false` placeholder so AKM_STASH_DIR is
        //      still wired into the child env.
        if (task.stashDirOverride) stashDir = task.stashDirOverride;
        else if (overrideStashDir) stashDir = overrideStashDir;
        else if (stash) stashDir = stash.stashDir;
        else if (!materialiseStash) stashDir = path.join(task.taskDir, "__no-stash__");
      }
      // Build the prompt-override (#267). The builder is invoked once
      // per (task, arm) — seeds share a prompt. `undefined` keeps the
      // driver's default prompt in play.
      //
      // #261: the synthetic arm has a scratch-notes prompt contract —
      // the model is told no AKM stash is available and instructed to
      // write/use its own procedural notes. When the caller does not
      // supply a `buildPrompt` override for the synthetic arm we fall
      // back to a built-in scratch-notes prompt so the contract is
      // honoured by every utility-track caller, not just `runEvolve`.
      let promptOverride = options.buildPrompt?.(task, arm);
      if (promptOverride === undefined && arm === "synthetic") {
        promptOverride = buildUtilitySyntheticPrompt(task.id);
      }

      // Collect per-run warnings separately and merge after the run so
      // concurrent runs don't interleave partial warning sequences.
      const runWarnings: string[] = [];
      const run = await runOneIsolated({
        task,
        arm,
        seed,
        model: options.model,
        stashDir,
        budgetTokens,
        budgetWallMs,
        spawn: options.spawn,
        warnings: runWarnings,
        ...(promptOverride !== undefined ? { prompt: promptOverride } : {}),
        ...(options.opencodeProviders ? { opencodeProviders: options.opencodeProviders } : {}),
        ...(stash?.indexCacheHome ? { indexCacheHome: stash.indexCacheHome } : {}),
      });

      // Merge per-run warnings into the shared array.
      if (runWarnings.length > 0) warnings.push(...runWarnings);

      taskRuns.get(arm)?.push(run);

      // Emit a compact progress line to stderr (unconditional — even under
      // --json so operators have a heartbeat during long runs).
      completedRuns += 1;
      emitProgress(completedRuns, totalRuns, run);

      // Accumulate for partial checkpointing.
      allCompletedRuns.push(run);
      if (completedRuns % CHECKPOINT_INTERVAL === 0) {
        writePartialCheckpoint(allCompletedRuns, runTimestamp);
      }

      // §6.7 search-pipeline bridge: only the akm arm consults the stash,
      // and we only attribute ranks for tasks with a gold ref. Both
      // guards mean noakm and gold-less runs are silently excluded.
      if (arm === "akm" && task.goldRef) {
        const searches = extractGoldRanks(run, task.goldRef);
        goldRankRecords.push({
          taskId: task.id,
          arm,
          seed,
          outcome: run.outcome,
          goldRef: task.goldRef,
          searches,
        });
      }

      // #257: evaluate the akm-arm run against every workflow spec. The
      // evaluator's `specApplies` filter handles applicability (arm,
      // domain, gold ref, repeated-failures threshold), so we hand it the
      // entire spec list and append whatever it returns. noakm/synthetic
      // arms are not evaluated — workflow specs target the akm arm.
      if (arm === "akm" && workflowSpecs.length > 0) {
        const trace = normalizeRunToTrace(run, { warnings: runWarnings });
        const runCtx: WorkflowEvalRunContext = {
          arm: run.arm,
          taskId: run.taskId,
          seed: run.seed,
          outcome: run.outcome,
        };
        const taskMetadata = buildWorkflowTaskMetadata(task, trace);
        const checks = evaluateRunAgainstAllSpecs(trace, workflowSpecs, runCtx, taskMetadata);
        workflowChecks.push(...checks);
      }
    };

    try {
      await runInBatches(workItems, parallel, runItem);
    } finally {
      // Deregister BEFORE running cleanup so a SIGINT arriving during this
      // block doesn't double-fire the cleanup (per cleanup.ts contract).
      deregisterStash();
      stash?.cleanup();
    }
  }

  return buildReport({
    grouped,
    options,
    seedsPerArm,
    slice,
    warnings,
    goldRankRecords,
    workflowChecks,
  });
}

function buildWorkflowTaskMetadata(
  task: TaskMetadata,
  trace: ReturnType<typeof normalizeRunToTrace>,
): { goldRef?: string; flags?: Record<string, boolean> } {
  const flags: Record<string, boolean> = {
    search_has_relevant_result: searchResultIncludesGoldRef(trace, task.goldRef),
    task_has_tests: taskHasTests(task),
  };
  return {
    ...(task.goldRef !== undefined ? { goldRef: task.goldRef } : {}),
    flags,
  };
}

function searchResultIncludesGoldRef(
  trace: ReturnType<typeof normalizeRunToTrace>,
  goldRef: string | undefined,
): boolean {
  if (!goldRef) return false;
  for (const event of trace.events) {
    if (event.type !== "akm_search") continue;
    if (event.resultRefs?.includes(goldRef)) return true;
  }
  return false;
}

function taskHasTests(task: TaskMetadata): boolean {
  if (task.verifier === "pytest") return true;
  const testsDir = path.join(task.taskDir, "tests");
  if (!fs.existsSync(testsDir)) return false;
  try {
    return fs.readdirSync(testsDir).some((name) => name.endsWith(".py") || name.endsWith(".sh"));
  } catch {
    return false;
  }
}

/**
 * Set up a fresh workspace for one (task, arm, seed) triple, run `runOne`
 * against it, splice in the trajectory record, then tear everything down.
 */
async function runOneIsolated(args: {
  task: TaskMetadata;
  arm: Arm;
  seed: number;
  model: string;
  stashDir: string | undefined;
  budgetTokens: number;
  budgetWallMs: number;
  spawn?: SpawnFn;
  warnings: string[];
  prompt?: string;
  opencodeProviders?: LoadedOpencodeProviders;
  indexCacheHome?: string;
}): Promise<RunResult> {
  const workspace = benchMkdtemp(`akm-bench-ws-${args.task.domain}-`);
  // SIGINT trap: register workspace cleanup so external signals don't leak
  // tmp dirs. Deregistered in `finally` before we do the synchronous rm so
  // the handler doesn't double-fire (per cleanup.ts contract).
  const deregisterWorkspace = registerCleanup(() => {
    try {
      fs.rmSync(workspace, { recursive: true, force: true });
    } catch {
      /* swallow */
    }
  });
  try {
    seedWorkspace(args.task.taskDir, workspace);

    const runOptions: RunOptions = {
      track: "utility",
      arm: args.arm,
      taskId: args.task.id,
      taskTitle: args.task.title,
      workspace,
      model: args.model,
      seed: args.seed,
      budgetTokens: args.budgetTokens,
      budgetWallMs: args.budgetWallMs,
      verifier: args.task.verifier,
      taskDir: args.task.taskDir,
      ...(args.task.expectedMatch ? { expectedMatch: args.task.expectedMatch } : {}),
      ...(args.task.akmKeywords ? { akmKeywords: args.task.akmKeywords } : {}),
      ...(args.stashDir ? { stashDir: args.stashDir } : {}),
      ...(args.spawn ? { spawn: args.spawn } : {}),
      ...(args.prompt !== undefined ? { prompt: args.prompt } : {}),
      warnings: args.warnings,
      ...(args.opencodeProviders ? { opencodeProviders: args.opencodeProviders } : {}),
      ...(args.indexCacheHome ? { indexCacheHome: args.indexCacheHome } : {}),
    };

    const result = await runOne(runOptions);

    // Splice in the trajectory metric. The driver always returns
    // `{ null, null }` — this is where the real values get filled.
    const trajectory = computeTrajectory({ goldRef: args.task.goldRef }, result, {
      warnings: args.warnings,
    });
    // Per-asset attribution is post-processing on the trace; it's free, so we
    // run it on every (task, arm, seed) result. The driver emits an empty
    // assetsLoaded[]; this is where the real refs get filled. Spec §6.5.
    const assetsLoaded = extractAssetLoads(result);
    // Splice in the failure-mode label. Only the akm arm carries one; the
    // noakm baseline is the control and isn't part of the §6.6 to-do list.
    // `classifyFailureMode` returns null for non-failed runs.
    const failureMode =
      args.arm === "akm" ? classifyFailureMode(args.task, { ...result, trajectory, assetsLoaded }) : null;
    return { ...result, trajectory, assetsLoaded, failureMode };
  } finally {
    deregisterWorkspace();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

/**
 * Copy the task's `workspace/` template into the per-run tmp dir. If the
 * task has no `workspace/` (loader-test fixtures), the run starts with an
 * empty cwd — that is also valid for verifier-only tasks.
 */
function seedWorkspace(taskDir: string, dest: string): void {
  const src = path.join(taskDir, "workspace");
  if (!fs.existsSync(src)) return;
  copyDirRecursive(src, dest);
}

/**
 * Default synthetic-arm prompt (#261). Used by Track A `runUtility` when the
 * caller opts in via `includeSynthetic: true` and does not also supply a
 * `buildPrompt` override for the synthetic arm.
 *
 * The prompt is a clear scratch-notes contract: the model is told no AKM
 * stash is available and instructed to write/use its own procedural notes
 * before solving the task. This mirrors the prompt shape used by Track B's
 * `buildSyntheticPrompt(taskId)` but is intentionally duplicated here so
 * Track A has no module-level dependency on `evolve.ts`.
 *
 * Exported for tests.
 */
export function buildUtilitySyntheticPrompt(taskId: string): string {
  return [
    `Task: ${taskId}`,
    "Arm: synthetic (Bring Your Own Skills)",
    "No akm stash is available; AKM_STASH_DIR is intentionally absent. Before solving",
    "the task, write a short scratchpad of the skills and steps you intend to use,",
    "then proceed. Cite the scratchpad in your trace so the verifier can attribute",
    "the approach to your own reasoning rather than retrieved guidance.",
  ].join("\n");
}

function copyDirRecursive(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".gitkeep") continue;
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirRecursive(s, d);
    else if (entry.isFile()) fs.copyFileSync(s, d);
  }
}

interface BuildReportArgs {
  grouped: GroupedRuns;
  options: RunUtilityOptions;
  seedsPerArm: number;
  slice: "all" | TaskSlice;
  warnings: string[];
  goldRankRecords: GoldRankAccumulator;
  /** #257: per-(akm-arm-run, spec) workflow checks accumulated across the corpus. */
  workflowChecks: WorkflowCheckResult[];
}

function buildReport(args: BuildReportArgs): UtilityRunReport {
  const tasks: UtilityReportTaskEntry[] = [];
  const noakmPerTask: Record<string, PerTaskMetrics> = {};
  const akmPerTask: Record<string, PerTaskMetrics> = {};
  const synthPerTask: Record<string, PerTaskMetrics> = {};
  const akmRunsAll: RunResult[] = [];
  const allRuns: RunResult[] = [];
  const includeSynth = args.options.includeSynthetic === true;

  // #257: index workflow checks by taskId so we can attach a per-task
  // mean compliance to each `UtilityReportTaskEntry`. Only `pass` and
  // `partial` statuses contribute non-zero scores; `not_applicable` is
  // skipped (the spec did not target this run); `harness_error` rolls in
  // as a 0 so corrupt traces drag the per-task number down.
  const checksByTask = new Map<string, WorkflowCheckResult[]>();
  for (const c of args.workflowChecks) {
    const arr = checksByTask.get(c.taskId);
    if (arr) arr.push(c);
    else checksByTask.set(c.taskId, [c]);
  }

  for (const task of args.options.tasks) {
    const taskRuns = args.grouped.get(task.id);
    const noakmRuns = taskRuns?.get("noakm") ?? [];
    const akmRuns = taskRuns?.get("akm") ?? [];
    // #261: synthetic-arm runs are only consulted when the caller opted in.
    // A missing arm is NOT a zero-pass arm — we leave `synthPerTask[task.id]`
    // unset rather than defaulting to a zeroed PerTaskMetrics so downstream
    // consumers can distinguish "arm not run" from "arm ran with 0 passes".
    const synthRuns: RunResult[] = includeSynth ? (taskRuns?.get("synthetic") ?? []) : [];

    const noakmMetrics = aggregatePerTask(noakmRuns);
    const akmMetrics = aggregatePerTask(akmRuns);
    const delta = computePerTaskDelta(noakmMetrics, akmMetrics);

    noakmPerTask[task.id] = noakmMetrics;
    akmPerTask[task.id] = akmMetrics;
    if (includeSynth) {
      synthPerTask[task.id] = aggregatePerTask(synthRuns);
    }
    akmRunsAll.push(...akmRuns);
    // Preserve arm order (noakm, synthetic when enabled, then akm) so the
    // persisted runs[] array is deterministic across reruns. #249. The
    // synthetic block is omitted entirely when includeSynth is false so the
    // pre-#261 envelope stays byte-identical.
    if (includeSynth) {
      allRuns.push(...noakmRuns, ...synthRuns, ...akmRuns);
    } else {
      allRuns.push(...noakmRuns, ...akmRuns);
    }

    // #257: per-task workflow compliance, mean of `score` over applicable
    // checks (excludes `not_applicable`). Undefined when this task has no
    // applicable checks at all so downstream renderers can distinguish
    // "not measured" from "measured at 0".
    const taskChecks = checksByTask.get(task.id) ?? [];
    const applicableTaskChecks = taskChecks.filter((c) => c.status !== "not_applicable");
    let workflowCompliance: number | undefined;
    if (applicableTaskChecks.length > 0) {
      let sum = 0;
      for (const c of applicableTaskChecks) sum += c.score;
      workflowCompliance = sum / applicableTaskChecks.length;
    }

    tasks.push({
      id: task.id,
      noakm: noakmMetrics,
      akm: akmMetrics,
      delta,
      ...(includeSynth ? { synthetic: aggregatePerTask(synthRuns) } : {}),
      ...(workflowCompliance !== undefined ? { workflowCompliance } : {}),
    });
  }

  const aggregateNoakm = aggregateCorpus(noakmPerTask);
  const aggregateAkm = aggregateCorpus(akmPerTask);
  const aggregateDelta = computeCorpusDelta(aggregateNoakm, aggregateAkm);
  // #261: synthetic-arm aggregate is built ONLY when the caller opted in.
  // We compute it once here so the report renderer can stamp `arms.synthetic`
  // and `akm_over_synthetic_lift` without recomputing.
  const aggregateSynth = includeSynth ? aggregateCorpus(synthPerTask) : undefined;
  const trajectoryAkm = aggregateTrajectory(akmRunsAll);

  // Failure-mode aggregate (§6.6). Walks every akm-arm run; runs that are
  // not "fail" carry `failureMode: null` and are skipped here.
  const failureEntries: Array<{ taskId: string; mode: FailureMode }> = [];
  for (const r of akmRunsAll) {
    if (r.failureMode) failureEntries.push({ taskId: r.taskId, mode: r.failureMode });
  }
  const failureModes = aggregateFailureModes(failureEntries);

  const domains = new Set(args.options.tasks.map((t) => t.domain)).size;
  const branch = args.options.branch ?? resolveGitBranch();
  const commit = args.options.commit ?? resolveGitCommit();
  const timestamp = args.options.timestamp ?? new Date().toISOString();

  // §6.7 — compute the search-pipeline bridge once over the whole corpus.
  // The function tolerates an empty record list (renders the N/A sentence
  // downstream).
  const searchBridge = computeSearchBridge({ goldRankRecords: args.goldRankRecords });

  // #250 — stamp deterministic corpus + fixture identity into the report
  // so `bench compare` can refuse cross-corpus / cross-fixture diffs unless
  // the operator explicitly opts in via --allow-corpus-mismatch /
  // --allow-fixture-mismatch.
  const selectedTaskIds = [...args.options.tasks.map((t) => t.id)].sort();
  const taskBodies = new Map<string, string>();
  for (const t of args.options.tasks) taskBodies.set(t.id, readTaskBody(t.taskDir));
  const taskCorpusHash = computeTaskCorpusHash(selectedTaskIds, taskBodies);

  const fixtureNames = [...new Set(args.options.tasks.map((t) => t.stash))].sort();
  const fixtures: Record<string, string> = {};
  for (const name of fixtureNames) {
    try {
      fixtures[name] = computeFixtureContentHash(name);
    } catch (err) {
      // Loader-test tasks point at fixtures that may not exist on disk; we
      // still want to stamp identity for the present fixtures, so we record
      // the failure as a warning and continue with the remaining set.
      args.warnings.push(
        `corpus stamp: cannot hash fixture "${name}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  // Combined fixture-content hash. Hash input is the same `<name>\0<hash>\0`
  // pattern used elsewhere — order-stable because `fixtureNames` is sorted.
  const combinedHash = createHash("sha256");
  for (const name of fixtureNames) {
    combinedHash.update(name);
    combinedHash.update("\0");
    combinedHash.update(fixtures[name] ?? "");
    combinedHash.update("\0");
  }
  const fixtureContentHash = combinedHash.digest("hex");

  const baseReport: UtilityRunReport = {
    timestamp,
    branch,
    commit,
    model: args.options.model,
    corpus: {
      domains,
      tasks: args.options.tasks.length,
      slice: args.slice,
      seedsPerArm: args.seedsPerArm,
      selectedTaskIds,
      taskCorpusHash,
      fixtures,
      fixtureContentHash,
    },
    aggregateNoakm,
    aggregateAkm,
    aggregateDelta,
    ...(aggregateSynth ? { aggregateSynth } : {}),
    trajectoryAkm,
    failureModes,
    tasks,
    warnings: args.warnings,
    akmRuns: akmRunsAll,
    allRuns,
    taskMetadata: args.options.tasks,
    goldRankRecords: args.goldRankRecords,
    searchBridge,
    workflowChecks: args.workflowChecks,
  };
  // Compute per-asset attribution as post-processing on the akm-arm runs
  // we just collected. This is the §6.5 "free" diagnostic — it runs on every
  // utility invocation, no extra spawns.
  baseReport.perAsset = computePerAssetAttribution(baseReport);
  return baseReport;
}
