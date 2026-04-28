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
import os from "node:os";
import path from "node:path";

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
import { resolveGitBranch, resolveGitCommit, type UtilityReportTaskEntry, type UtilityRunReport } from "./report";
import { computeTrajectory } from "./trajectory";

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

    try {
      for (const arm of armsForTask) {
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
            ...(promptOverride !== undefined ? { prompt: promptOverride } : {}),
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
  prompt?: string;
}): Promise<RunResult> {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), `akm-bench-ws-${args.task.domain}-`));
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
      ...(args.prompt !== undefined ? { prompt: args.prompt } : {}),
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
}

function buildReport(args: BuildReportArgs): UtilityRunReport {
  const tasks: UtilityReportTaskEntry[] = [];
  const noakmPerTask: Record<string, PerTaskMetrics> = {};
  const akmPerTask: Record<string, PerTaskMetrics> = {};
  const synthPerTask: Record<string, PerTaskMetrics> = {};
  const akmRunsAll: RunResult[] = [];
  const allRuns: RunResult[] = [];
  const includeSynth = args.options.includeSynthetic === true;

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

    tasks.push({
      id: task.id,
      noakm: noakmMetrics,
      akm: akmMetrics,
      delta,
      ...(includeSynth ? { synthetic: aggregatePerTask(synthRuns) } : {}),
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
  };
  // Compute per-asset attribution as post-processing on the akm-arm runs
  // we just collected. This is the §6.5 "free" diagnostic — it runs on every
  // utility invocation, no extra spawns.
  baseReport.perAsset = computePerAssetAttribution(baseReport);
  return baseReport;
}
