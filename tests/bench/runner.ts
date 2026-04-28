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

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { SpawnFn } from "../../src/integrations/agent/spawn";
import { type LoadedFixtureStash, loadFixtureStash } from "../fixtures/stashes/load";
import type { TaskMetadata, TaskSlice } from "./corpus";
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
import { resolveGitBranch, resolveGitCommit, type UtilityReportTaskEntry, type UtilityRunReport } from "./report";
import { computeTrajectory } from "./trajectory";

export type Arm = "noakm" | "akm";

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
 * Run K seeds × len(arms) × len(tasks) and return the §13.3 report.
 *
 * The function is robust to per-run failures — `runOne` already captures
 * every failure path into a RunResult, so the runner only has to worry
 * about its own infrastructure (stash materialisation, workspace copy).
 * Those failures are recorded as `harness_error` runs.
 */
export async function runUtility(options: RunUtilityOptions): Promise<UtilityRunReport> {
  const seedsPerArm = options.seedsPerArm ?? 5;
  const budgetTokens = options.budgetTokens ?? 30000;
  const budgetWallMs = options.budgetWallMs ?? 120000;
  const slice = options.slice ?? "all";
  const materialiseStash = options.materialiseStash ?? true;

  const grouped: GroupedRuns = new Map();
  const warnings: string[] = [];
  const goldRankRecords: GoldRankAccumulator = [];

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
        stash = loadFixtureStash(task.stash, { skipIndex: true });
      } catch (err) {
        stashError = err instanceof Error ? err.message : String(err);
        warnings.push(`task ${task.id}: stash "${task.stash}" failed to load: ${stashError}`);
      }
    }

    try {
      for (const arm of options.arms) {
        const armRuns: RunResult[] = [];
        taskRuns.set(arm, armRuns);
        for (let seed = 0; seed < seedsPerArm; seed += 1) {
          // Resolve the stashDir we'll forward to the agent. The akm arm
          // always carries a stashDir so AKM_STASH_DIR is set in the child
          // env — this is how downstream tooling (and the trajectory parser
          // event-stream lookup) distinguishes arms. When the operator opted
          // out of fixture materialisation (tests, dry-run), we still pass a
          // stable placeholder so the env keys are wired correctly.
          let stashDir: string | undefined;
          if (arm === "akm") {
            if (overrideStashDir) stashDir = overrideStashDir;
            else if (stash) stashDir = stash.stashDir;
            else if (!materialiseStash) stashDir = path.join(task.taskDir, "__no-stash__");
          }
          const run = await runOneIsolated({
            task,
            arm,
            seed,
            model: options.model,
            stashDir,
            budgetTokens,
            budgetWallMs,
            spawn: options.spawn,
            warnings,
          });
          armRuns.push(run);

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
        }
      }
    } finally {
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
  });
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
}): Promise<RunResult> {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), `akm-bench-ws-${args.task.domain}-`));
  try {
    seedWorkspace(args.task.taskDir, workspace);

    const runOptions: RunOptions = {
      track: "utility",
      arm: args.arm,
      taskId: args.task.id,
      workspace,
      model: args.model,
      seed: args.seed,
      budgetTokens: args.budgetTokens,
      budgetWallMs: args.budgetWallMs,
      verifier: args.task.verifier,
      taskDir: args.task.taskDir,
      ...(args.task.expectedMatch ? { expectedMatch: args.task.expectedMatch } : {}),
      ...(args.stashDir ? { stashDir: args.stashDir } : {}),
      ...(args.spawn ? { spawn: args.spawn } : {}),
      warnings: args.warnings,
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
}

function buildReport(args: BuildReportArgs): UtilityRunReport {
  const tasks: UtilityReportTaskEntry[] = [];
  const noakmPerTask: Record<string, PerTaskMetrics> = {};
  const akmPerTask: Record<string, PerTaskMetrics> = {};
  const akmRunsAll: RunResult[] = [];

  for (const task of args.options.tasks) {
    const taskRuns = args.grouped.get(task.id);
    const noakmRuns = taskRuns?.get("noakm") ?? [];
    const akmRuns = taskRuns?.get("akm") ?? [];

    const noakmMetrics = aggregatePerTask(noakmRuns);
    const akmMetrics = aggregatePerTask(akmRuns);
    const delta = computePerTaskDelta(noakmMetrics, akmMetrics);

    noakmPerTask[task.id] = noakmMetrics;
    akmPerTask[task.id] = akmMetrics;
    akmRunsAll.push(...akmRuns);

    tasks.push({ id: task.id, noakm: noakmMetrics, akm: akmMetrics, delta });
  }

  const aggregateNoakm = aggregateCorpus(noakmPerTask);
  const aggregateAkm = aggregateCorpus(akmPerTask);
  const aggregateDelta = computeCorpusDelta(aggregateNoakm, aggregateAkm);
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
    },
    aggregateNoakm,
    aggregateAkm,
    aggregateDelta,
    trajectoryAkm,
    failureModes,
    tasks,
    warnings: args.warnings,
    akmRuns: akmRunsAll,
    taskMetadata: args.options.tasks,
    goldRankRecords: args.goldRankRecords,
    searchBridge,
  };
  // Compute per-asset attribution as post-processing on the akm-arm runs
  // we just collected. This is the §6.5 "free" diagnostic — it runs on every
  // utility invocation, no extra spawns.
  baseReport.perAsset = computePerAssetAttribution(baseReport);
  return baseReport;
}
