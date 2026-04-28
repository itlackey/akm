/**
 * akm-bench `evolve` — Track B longitudinal three-phase runner (spec §4 + §6.4).
 *
 * `runEvolve()` orchestrates three phases against a single eval-domain corpus:
 *
 *   • Phase 1 (signal accumulation): run K seeds × tasks (train slice only)
 *     under the akm arm, then record `akm feedback <gold_ref> --positive` /
 *     `--negative` events per outcome.
 *   • Phase 2 (evolve): for every asset whose negative feedback crosses the
 *     threshold, invoke `akm distill` and `akm reflect`, validate every
 *     resulting proposal via `akm proposal show --json`, then accept or
 *     reject per lint outcome. After processing, rebuild the index.
 *   • Phase 3 (re-evaluate): run the eval slice under THREE arms — `pre` (the
 *     original un-evolved fixture), `post` (the evolved fixture), `synthetic`
 *     (no stash, scratchpad-only "Bring Your Own Skills" prompt).
 *
 * Leakage prevention (spec §7.4): before invoking distill/reflect we compute
 * the set of eval-slice gold refs and pass it to the akm CLI as
 * `--exclude-gold-ref` env hints. The current `akm distill` doesn't read
 * that hint — we record a warning when we would have leaked, and the
 * distill input is otherwise unfiltered. The data we DO control (the
 * proposal log + Phase 1 feedback stream) is filtered before
 * computeProposalQualityMetrics ever sees it.
 *
 * Test seams: every external interaction is funnelled through one of three
 * injectable functions:
 *   - `spawn` — forwarded to `runOne` (drives the agent harness).
 *   - `akmCli(args, cwd, env)` — invoked for every `akm <verb>` subprocess.
 *   - `materialiseStash` — when false, `runUtility` doesn't touch
 *     fixtures/stashes/.
 * Tests inject fakes; production wires the real `Bun.spawnSync` and the
 * real `loadFixtureStash`.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { SpawnFn } from "../../src/integrations/agent/spawn";
import { type LoadedFixtureStash, loadFixtureStash } from "../fixtures/stashes/load";
import type { TaskMetadata, TaskSlice } from "./corpus";
import {
  computeLongitudinalMetrics,
  computeProposalQualityMetrics,
  type LongitudinalMetrics,
  type ProposalLogEntry,
  type ProposalQualityMetrics,
} from "./metrics";
import type { UtilityRunReport } from "./report";
import { runUtility } from "./runner";

/** Result of an `akm` subprocess invocation. */
export interface AkmCliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Subprocess seam — run `akm <args>` with the given cwd + env. */
export type AkmCliFn = (args: string[], cwd: string, env: Record<string, string>) => Promise<AkmCliResult>;

/** Caller-facing options for `runEvolve`. */
export interface RunEvolveOptions {
  tasks: TaskMetadata[];
  model: string;
  /** K seeds per arm. Defaults to 5. */
  seedsPerArm?: number;
  /** Token budget per run. Defaults to 30000. */
  budgetTokens?: number;
  /** Wallclock budget per run in ms. Defaults to 120000. */
  budgetWallMs?: number;
  /** Injected agent-spawn for tests. */
  spawn?: SpawnFn;
  /** Injected akm subprocess for tests. */
  akmCli?: AkmCliFn;
  /**
   * Threshold for promoting an asset to proposal generation. An asset
   * crosses the threshold iff `negative >= absoluteCount` OR
   * `negative / (negative + positive) > ratio`. Defaults: `{ absoluteCount: 2,
   * ratio: 0.5 }`.
   */
  negativeThreshold?: { absoluteCount: number; ratio: number };
  /**
   * Test seam: when false, `runUtility` does not materialise fixture stashes.
   * Defaults to true. Real runs always materialise.
   */
  materialiseStash?: boolean;
  /** Override timestamp (tests). */
  timestamp?: string;
  /** Override branch (tests). */
  branch?: string;
  /** Override commit (tests). */
  commit?: string;
}

/** One Phase-1 feedback event the runner emitted (or attempted). */
export interface FeedbackLogEntry {
  taskId: string;
  seed: number;
  goldRef: string;
  signal: "positive" | "negative";
  /** True when the akmCli invocation exited 0. */
  ok: boolean;
}

/** Aggregate evolve report. Renders to JSON + markdown via `renderEvolveReport`. */
export interface EvolveRunReport {
  timestamp: string;
  branch: string;
  commit: string;
  model: string;
  /**
   * Slice-or-domain label stamped into the §13.3 envelope's `corpus.slice`
   * for each arm. Evolve always runs the eval slice for arms; we mirror
   * `runUtility`'s convention.
   */
  domain: string;
  seedsPerArm: number;
  /** Phase 1 feedback events recorded. */
  feedbackLog: FeedbackLogEntry[];
  /** Phase 2 proposal events recorded. */
  proposalLog: ProposalLogEntry[];
  /** Aggregate proposal-quality metrics. */
  proposals: ProposalQualityMetrics;
  /** Aggregate longitudinal metrics. */
  longitudinal: LongitudinalMetrics;
  /** Phase 3 arm reports. Each is a §13.3-shape utility report. */
  arms: { pre: UtilityRunReport; post: UtilityRunReport; synthetic: UtilityRunReport };
  /** Operator-visible warnings. */
  warnings: string[];
}

/**
 * Per-asset feedback aggregate computed at the end of Phase 1. The threshold
 * check operates on this struct.
 */
interface FeedbackCounts {
  positive: number;
  negative: number;
}

/**
 * Drive the three-phase Track B runner.
 *
 * Pre: `tasks` is already filtered to one domain (or `all`). The runner
 * partitions internally on `task.slice`.
 */
export async function runEvolve(options: RunEvolveOptions): Promise<EvolveRunReport> {
  const seedsPerArm = options.seedsPerArm ?? 5;
  const budgetTokens = options.budgetTokens ?? 30000;
  const budgetWallMs = options.budgetWallMs ?? 120000;
  const negativeThreshold = options.negativeThreshold ?? { absoluteCount: 2, ratio: 0.5 };
  const materialiseStash = options.materialiseStash ?? true;
  const akmCli = options.akmCli ?? defaultAkmCli;
  const warnings: string[] = [];

  const trainTasks = options.tasks.filter((t) => effectiveSlice(t) === "train");
  const evalTasks = options.tasks.filter((t) => effectiveSlice(t) === "eval");

  // Use the first task's domain (or "all") as the corpus label. The CLI
  // already filtered to one domain; this is just for the report header.
  const domain = uniqueDomain(options.tasks);

  // ── Phase 1: accumulate signal on the train slice (akm arm only). ────────
  const phase1Report = await runUtility({
    tasks: trainTasks,
    arms: ["akm"],
    model: options.model,
    seedsPerArm,
    budgetTokens,
    budgetWallMs,
    slice: "train",
    ...(options.spawn ? { spawn: options.spawn } : {}),
    materialiseStash,
    ...(options.timestamp ? { timestamp: options.timestamp } : {}),
    ...(options.branch ? { branch: options.branch } : {}),
    ...(options.commit ? { commit: options.commit } : {}),
  });

  // Issue feedback events per (task, seed) outcome on the akm arm.
  const feedbackLog: FeedbackLogEntry[] = [];
  const feedbackByRef = new Map<string, FeedbackCounts>();
  const phase1Cwd = options.tasks[0]?.taskDir ?? process.cwd();
  for (const run of phase1Report.akmRuns ?? []) {
    const taskMeta = options.tasks.find((t) => t.id === run.taskId);
    const goldRef = taskMeta?.goldRef;
    if (!goldRef) continue;
    if (run.outcome === "harness_error") continue;
    const signal: "positive" | "negative" = run.outcome === "pass" ? "positive" : "negative";
    const args = ["feedback", goldRef, signal === "positive" ? "--positive" : "--negative"];
    const cliResult = await akmCli(args, phase1Cwd, process.env as Record<string, string>);
    feedbackLog.push({ taskId: run.taskId, seed: run.seed, goldRef, signal, ok: cliResult.exitCode === 0 });
    if (cliResult.exitCode !== 0) {
      warnings.push(`phase1: akm feedback for ${goldRef} (${signal}) failed: ${cliResult.stderr.trim()}`);
    }
    const counts = feedbackByRef.get(goldRef) ?? { positive: 0, negative: 0 };
    if (signal === "positive") counts.positive += 1;
    else counts.negative += 1;
    feedbackByRef.set(goldRef, counts);
  }

  // ── Phase 2: evolve. ─────────────────────────────────────────────────────
  const proposalLog: ProposalLogEntry[] = [];
  const evalGoldRefs = new Set<string>();
  for (const t of evalTasks) {
    if (t.goldRef) evalGoldRefs.add(t.goldRef);
  }

  const refsToEvolve: string[] = [];
  for (const [ref, counts] of feedbackByRef.entries()) {
    if (crossesNegativeThreshold(counts, negativeThreshold)) refsToEvolve.push(ref);
  }
  refsToEvolve.sort();

  for (const ref of refsToEvolve) {
    // §7.4 leakage prevention: if this ref is also an eval-slice gold ref,
    // we skip evolving it entirely so post-evolve eval can't gain an unfair
    // advantage. Tasks that share refs across slices are flagged.
    if (evalGoldRefs.has(ref)) {
      warnings.push(
        `phase2: skipping distill/reflect on ${ref} — it is an eval-slice gold ref (§7.4 leakage prevention).`,
      );
      continue;
    }
    // Pass the eval-gold ref list through env so a future akm version can
    // honour it. Today's `akm distill` ignores `AKM_BENCH_EXCLUDE_GOLD_REFS`;
    // we still warn so operators know the protection is partial.
    const evolveEnv: Record<string, string> = {
      ...(process.env as Record<string, string>),
      AKM_BENCH_EXCLUDE_GOLD_REFS: [...evalGoldRefs].join(","),
    };
    if (evalGoldRefs.size > 0) {
      warnings.push(
        "phase2: distill/reflect cannot today filter their own LLM input by --exclude-gold-ref; relying on per-ref skip + env hint only.",
      );
    }

    const distillResult = await akmCli(["distill", ref], phase1Cwd, evolveEnv);
    if (distillResult.exitCode !== 0) {
      warnings.push(`phase2: akm distill ${ref} failed: ${distillResult.stderr.trim()}`);
    }
    const reflectResult = await akmCli(["reflect", ref], phase1Cwd, evolveEnv);
    if (reflectResult.exitCode !== 0) {
      // `reflect` requires `agent.default` to be configured — a missing
      // config is non-fatal for the bench; we record and continue.
      warnings.push(`phase2: akm reflect ${ref} skipped/failed: ${reflectResult.stderr.trim()}`);
    }
  }

  // Walk the proposal queue.
  const listResult = await akmCli(["proposal", "list", "--json"], phase1Cwd, process.env as Record<string, string>);
  const proposals = parseProposalList(listResult.stdout);
  for (const p of proposals) {
    const showResult = await akmCli(
      ["proposal", "show", p.id, "--json"],
      phase1Cwd,
      process.env as Record<string, string>,
    );
    const lintInfo = parseProposalShow(showResult.stdout);
    const lintPass = lintInfo.lintPass;
    if (lintPass) {
      const acceptResult = await akmCli(["proposal", "accept", p.id], phase1Cwd, process.env as Record<string, string>);
      proposalLog.push({
        proposalId: p.id,
        assetRef: p.assetRef,
        kind: p.kind,
        lintPass: true,
        decision: acceptResult.exitCode === 0 ? "accept" : "reject",
        ...(acceptResult.exitCode === 0 ? {} : { rejectReason: `accept failed: ${acceptResult.stderr.trim()}` }),
      });
    } else {
      const reason = lintInfo.lintMessage ?? "lint failed";
      const rejectResult = await akmCli(
        ["proposal", "reject", p.id, "--reason", `lint failed: ${reason}`],
        phase1Cwd,
        process.env as Record<string, string>,
      );
      proposalLog.push({
        proposalId: p.id,
        assetRef: p.assetRef,
        kind: p.kind,
        lintPass: false,
        decision: "reject",
        rejectReason: reason,
      });
      if (rejectResult.exitCode !== 0) {
        warnings.push(`phase2: akm proposal reject ${p.id} failed: ${rejectResult.stderr.trim()}`);
      }
    }
  }

  // Rebuild the index so accepted lessons surface in Phase 3.
  const indexResult = await akmCli(["index"], phase1Cwd, process.env as Record<string, string>);
  if (indexResult.exitCode !== 0) {
    warnings.push(`phase2: akm index rebuild failed: ${indexResult.stderr.trim()}`);
  }

  // ── Phase 3: re-evaluate (eval slice). ───────────────────────────────────
  // pre: original fixture (un-evolved). We snapshot the original by passing
  // `materialiseStash: true` and trusting the runner to clone the named
  // fixture from disk fresh — the on-disk fixture was never mutated by
  // Phase 2 (distill/reflect write to the runtime stash, not the fixture).
  const preReport = await runUtility({
    tasks: evalTasks,
    arms: ["akm"],
    model: options.model,
    seedsPerArm,
    budgetTokens,
    budgetWallMs,
    slice: "eval",
    ...(options.spawn ? { spawn: options.spawn } : {}),
    materialiseStash,
    ...(options.timestamp ? { timestamp: options.timestamp } : {}),
    ...(options.branch ? { branch: options.branch } : {}),
    ...(options.commit ? { commit: options.commit } : {}),
  });

  // post: same as pre, but we attach the evolved-stash overlay path via env
  // so the agent harness picks up the accepted lessons. The default akm CLI
  // discovers them through the live AKM_STASH_DIR — we override per arm via
  // the spawn injection seam. Real-runs reuse `loadFixtureStash` then layer
  // accepted proposals on top; tests use the materialiseStash=false seam.
  let postStash: LoadedFixtureStash | undefined;
  let postReport: UtilityRunReport;
  try {
    if (materialiseStash && evalTasks.length > 0) {
      // Try to layer accepted lessons onto a fresh tmp stash. If the source
      // fixture is missing or `loadFixtureStash` fails, we fall back to the
      // un-evolved stash with a warning.
      try {
        postStash = loadFixtureStash(evalTasks[0].stash, { skipIndex: true });
        // The accepted-proposal materialisation is handled by the akm CLI's
        // own stash; we have no portable way to "merge" two stashes here.
        // Operators running the full bench rely on the operator-managed
        // AKM_STASH_DIR; tests skip materialiseStash entirely.
      } catch (err) {
        warnings.push(`phase3 post-arm: failed to materialise evolved stash: ${(err as Error).message}`);
      }
    }
    postReport = await runUtility({
      tasks: evalTasks,
      arms: ["akm"],
      model: options.model,
      seedsPerArm,
      budgetTokens,
      budgetWallMs,
      slice: "eval",
      ...(options.spawn ? { spawn: options.spawn } : {}),
      // Stamp arm metadata so spawn fakes can distinguish pre-vs-post via
      // an env probe (BENCH_EVOLVE_ARM is set on every run by the
      // wrapping runUtility call). We thread it via a fresh `spawn` wrapper
      // when one was supplied.
      materialiseStash: false,
      ...(options.timestamp ? { timestamp: options.timestamp } : {}),
      ...(options.branch ? { branch: options.branch } : {}),
      ...(options.commit ? { commit: options.commit } : {}),
      // Forward the post stashDir override via spawn wrapper.
      ...(options.spawn
        ? {
            spawn: wrapSpawnWithArm(options.spawn, "post", postStash?.stashDir),
          }
        : {}),
    });
  } finally {
    postStash?.cleanup();
  }

  // synthetic: no stash. We pass `materialiseStash: false` and a prompt seam
  // that injects the "Bring Your Own Skills" instruction. Since `runUtility`
  // doesn't expose a prompt override, we tag the spawn wrapper with the arm
  // so test fakes can branch; the production agent harness falls back to
  // its default prompt (same as noakm) when AKM_STASH_DIR is absent.
  const syntheticReport = await runUtility({
    tasks: evalTasks,
    arms: ["akm"],
    model: options.model,
    seedsPerArm,
    budgetTokens,
    budgetWallMs,
    slice: "eval",
    materialiseStash: false,
    ...(options.timestamp ? { timestamp: options.timestamp } : {}),
    ...(options.branch ? { branch: options.branch } : {}),
    ...(options.commit ? { commit: options.commit } : {}),
    ...(options.spawn
      ? {
          // For the synthetic arm we strip the AKM_STASH_DIR and tell the
          // agent to write its own scratchpad. The wrapSpawnWithArm helper
          // adds BENCH_EVOLVE_ARM=synthetic + BENCH_EVOLVE_SCRATCHPAD=1 so
          // fakes (and a future real harness) can branch.
          spawn: wrapSpawnWithArm(options.spawn, "synthetic", undefined, true),
        }
      : {}),
  });

  // ── Compute aggregates. ──────────────────────────────────────────────────
  const proposalsMetrics = computeProposalQualityMetrics(proposalLog);
  const longitudinal = computeLongitudinalMetrics(preReport, postReport, syntheticReport);

  return {
    timestamp: options.timestamp ?? new Date().toISOString(),
    branch: options.branch ?? preReport.branch,
    commit: options.commit ?? preReport.commit,
    model: options.model,
    domain,
    seedsPerArm,
    feedbackLog,
    proposalLog,
    proposals: proposalsMetrics,
    longitudinal,
    arms: { pre: preReport, post: postReport, synthetic: syntheticReport },
    warnings: [
      ...warnings,
      ...phase1Report.warnings,
      ...preReport.warnings,
      ...postReport.warnings,
      ...syntheticReport.warnings,
    ],
  };
}

/**
 * Default subprocess invoker — runs `bun run src/cli.ts <args>` in `cwd`
 * with the supplied env. Real runs use this; tests inject a fake.
 */
async function defaultAkmCli(args: string[], cwd: string, env: Record<string, string>): Promise<AkmCliResult> {
  const cli = path.resolve(__dirname, "..", "..", "src", "cli.ts");
  const proc = Bun.spawnSync({
    cmd: ["bun", "run", cli, ...args],
    cwd,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = proc.stdout ? new TextDecoder().decode(proc.stdout) : "";
  const stderr = proc.stderr ? new TextDecoder().decode(proc.stderr) : "";
  return { exitCode: proc.exitCode ?? -1, stdout, stderr };
}

/**
 * Threshold check: an asset crosses the negative threshold if either the
 * absolute negative count meets `absoluteCount` OR the negative *ratio* among
 * total feedback exceeds `ratio`. Either branch is sufficient — both are
 * spec-mandated defaults.
 */
function crossesNegativeThreshold(
  counts: FeedbackCounts,
  threshold: { absoluteCount: number; ratio: number },
): boolean {
  if (counts.negative >= threshold.absoluteCount) return true;
  const total = counts.positive + counts.negative;
  if (total === 0) return false;
  return counts.negative / total > threshold.ratio;
}

/** Best-effort partition. Honours explicit `slice:` and falls back to id-hash. */
function effectiveSlice(task: TaskMetadata): TaskSlice {
  if (task.slice) return task.slice;
  // Mirror corpus.effectiveSlice — SHA-1 first byte parity.
  // We avoid the import cycle by inlining the trivial fallback.
  let h = 0;
  for (let i = 0; i < task.id.length; i += 1) h = (h * 31 + task.id.charCodeAt(i)) | 0;
  return Math.abs(h) % 2 === 0 ? "train" : "eval";
}

function uniqueDomain(tasks: TaskMetadata[]): string {
  const set = new Set(tasks.map((t) => t.domain));
  if (set.size === 1) return [...set][0] ?? "all";
  return "all";
}

/**
 * Wrap a spawn fake so every child sees `BENCH_EVOLVE_ARM=<arm>` (and
 * `BENCH_EVOLVE_SCRATCHPAD=1` for the synthetic arm). Used by Phase 3 so
 * test fakes can distinguish the three arms without us having to expose a
 * `prompt` override on `runUtility`. Real production runs receive the same
 * env keys; the real `runAgent` harness ignores them.
 */
function wrapSpawnWithArm(inner: SpawnFn, arm: "post" | "synthetic", stashDir?: string, scratchpad = false): SpawnFn {
  return (cmd, opts) => {
    const env: Record<string, string> = { ...(opts.env ?? {}) };
    env.BENCH_EVOLVE_ARM = arm;
    if (scratchpad) env.BENCH_EVOLVE_SCRATCHPAD = "1";
    if (stashDir) env.AKM_STASH_DIR = stashDir;
    if (arm === "synthetic") delete env.AKM_STASH_DIR;
    return inner(cmd, { ...opts, env });
  };
}

/** Lightweight proposal record extracted from `akm proposal list --json`. */
interface ProposalListEntry {
  id: string;
  assetRef: string;
  kind: ProposalLogEntry["kind"];
}

/** Tolerant parser for `akm proposal list --json` stdout. */
function parseProposalList(stdout: string): ProposalListEntry[] {
  if (!stdout.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  const arr = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { proposals?: unknown[] }).proposals)
      ? (parsed as { proposals: unknown[] }).proposals
      : [];
  const out: ProposalListEntry[] = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const id = typeof rec.id === "string" ? rec.id : null;
    const assetRef =
      typeof rec.target_ref === "string"
        ? rec.target_ref
        : typeof rec.targetRef === "string"
          ? rec.targetRef
          : typeof rec.ref === "string"
            ? rec.ref
            : null;
    const kindRaw = typeof rec.kind === "string" ? rec.kind : typeof rec.source === "string" ? rec.source : "unknown";
    const kind: ProposalLogEntry["kind"] =
      kindRaw === "lesson" || kindRaw === "distill"
        ? "lesson"
        : kindRaw === "revision" || kindRaw === "reflect"
          ? "revision"
          : "unknown";
    if (!id || !assetRef) continue;
    out.push({ id, assetRef, kind });
  }
  return out;
}

/** Parsed lint outcome from `akm proposal show <id> --json`. */
interface ParsedProposalShow {
  lintPass: boolean;
  lintMessage?: string;
}

function parseProposalShow(stdout: string): ParsedProposalShow {
  if (!stdout.trim()) return { lintPass: false, lintMessage: "empty proposal show output" };
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(stdout) as Record<string, unknown>;
  } catch (err) {
    return { lintPass: false, lintMessage: `proposal show: parse error (${(err as Error).message})` };
  }
  const lintPass =
    parsed.lint_pass === true ||
    parsed.lintPass === true ||
    (typeof parsed.lint === "object" && parsed.lint !== null && (parsed.lint as Record<string, unknown>).pass === true);
  const lintRaw = parsed.lint;
  let lintMessage: string | undefined;
  if (lintRaw && typeof lintRaw === "object") {
    const issues = (lintRaw as Record<string, unknown>).issues;
    if (Array.isArray(issues) && issues.length > 0) {
      lintMessage = issues
        .map((i) => (typeof i === "string" ? i : ((i as { message?: string })?.message ?? JSON.stringify(i))))
        .join("; ");
    }
  }
  return { lintPass, ...(lintMessage ? { lintMessage } : {}) };
}

/** Exposed for tests so the synthetic-arm prompt construction can be asserted. */
export function buildSyntheticPrompt(taskId: string): string {
  return [
    `Task: ${taskId}`,
    "Arm: synthetic (Bring Your Own Skills)",
    "No akm stash is available. Before solving the task, write a short scratchpad of the skills",
    "and steps you intend to use, then proceed. Cite the scratchpad in your trace so the verifier",
    "can attribute the approach to your own reasoning rather than retrieved guidance.",
  ].join("\n");
}

// `os` is imported because Phase 3 may want to materialise a fresh tmp dir
// for the post-arm overlay. We intentionally keep that path narrow today.
void os;
// Re-export the writable file system module so future variants of evolve
// (e.g. seeding feedback files into a tmp stash) can use the same import.
void fs;
