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
 *
 * Sandboxing: at the start of every real run the runner materialises one
 * dedicated tmp stash per fixture (the `evolveStash`) plus a fresh sibling
 * snapshot per fixture (the `preStash`). Phase 1 + Phase 2 pin
 * `AKM_STASH_DIR` to the appropriate `evolveStash` for every spawned `akm`
 * invocation; Phase 3's pre arm uses `preStash`, the post arm uses
 * `evolveStash`, and the synthetic arm uses no stash. The operator's real
 * `process.env.AKM_STASH_DIR` is never read or written by `runEvolve`. All
 * stashes are cleaned up in a top-level try/finally.
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

  // ── Sandbox setup: per-fixture evolveStash + preStash. ───────────────────
  // We materialise one tmp stash per unique `task.stash` so Phase 1
  // accumulates feedback into the same on-disk stash that Phase 2 mutates,
  // and that Phase 3's post arm reads back. The operator's real
  // AKM_STASH_DIR is never touched. The pre arm gets a fresh snapshot of
  // the same starting fixture (no Phase 2 mutations applied).
  const fixtureNames = new Set<string>();
  for (const t of options.tasks) fixtureNames.add(t.stash);

  const evolveStashes = new Map<string, LoadedFixtureStash>();
  const preStashes = new Map<string, LoadedFixtureStash>();
  const evolveDirByFixture = new Map<string, string>();
  const preDirByFixture = new Map<string, string>();

  if (materialiseStash) {
    for (const name of fixtureNames) {
      try {
        const evolved = loadFixtureStash(name, { skipIndex: false });
        evolveStashes.set(name, evolved);
        evolveDirByFixture.set(name, evolved.stashDir);
      } catch (err) {
        warnings.push(`evolve: failed to materialise evolve stash for fixture "${name}": ${(err as Error).message}`);
      }
      try {
        const pre = loadFixtureStash(name, { skipIndex: false });
        preStashes.set(name, pre);
        preDirByFixture.set(name, pre.stashDir);
      } catch (err) {
        warnings.push(`evolve: failed to materialise pre stash for fixture "${name}": ${(err as Error).message}`);
      }
    }
  }

  // Resolve the evolveStash dir for a given asset ref. We map ref → fixture
  // by looking up which task's gold ref it matches; if no task owns it (or
  // multiple do, which is unusual), we fall back to the first available
  // evolveStash. The simple — and most common — case is a single fixture
  // per `--tasks <domain>` invocation.
  const refToFixture = new Map<string, string>();
  for (const t of options.tasks) {
    if (t.goldRef) refToFixture.set(t.goldRef, t.stash);
  }
  const fallbackEvolveDir = [...evolveDirByFixture.values()][0];
  function envForRef(ref: string | undefined): Record<string, string> {
    const baseEnv = { ...(process.env as Record<string, string>) };
    if (!materialiseStash) {
      // Tests opt out of fixture materialisation entirely; we still strip
      // the operator's AKM_STASH_DIR so the fake CLI sees a known sentinel.
      delete baseEnv.AKM_STASH_DIR;
      return baseEnv;
    }
    const fixture = ref ? refToFixture.get(ref) : undefined;
    const dir = (fixture && evolveDirByFixture.get(fixture)) ?? fallbackEvolveDir;
    if (dir) baseEnv.AKM_STASH_DIR = dir;
    else delete baseEnv.AKM_STASH_DIR;
    return baseEnv;
  }

  let preReport: UtilityRunReport;
  let postReport: UtilityRunReport;
  let syntheticReport: UtilityRunReport;
  let phase1Report: UtilityRunReport;
  const feedbackLog: FeedbackLogEntry[] = [];
  const proposalLog: ProposalLogEntry[] = [];

  try {
    // ── Phase 1: accumulate signal on the train slice (akm arm only). ─────
    phase1Report = await runUtility({
      tasks: trainTasks,
      arms: ["akm"],
      model: options.model,
      seedsPerArm,
      budgetTokens,
      budgetWallMs,
      slice: "train",
      ...(options.spawn ? { spawn: options.spawn } : {}),
      // We pre-materialised the per-fixture evolve stash above; tell the
      // runner to forward those dirs and skip its own per-task materialise.
      materialiseStash,
      ...(materialiseStash ? { stashDirByFixture: evolveDirByFixture } : {}),
      ...(options.timestamp ? { timestamp: options.timestamp } : {}),
      ...(options.branch ? { branch: options.branch } : {}),
      ...(options.commit ? { commit: options.commit } : {}),
    });

    // Issue feedback events per (task, seed) outcome on the akm arm.
    const feedbackByRef = new Map<string, FeedbackCounts>();
    const phase1Cwd = options.tasks[0]?.taskDir ?? process.cwd();
    for (const run of phase1Report.akmRuns ?? []) {
      const taskMeta = options.tasks.find((t) => t.id === run.taskId);
      const goldRef = taskMeta?.goldRef;
      if (!goldRef) continue;
      if (run.outcome === "harness_error") continue;
      const signal: "positive" | "negative" = run.outcome === "pass" ? "positive" : "negative";
      const args = ["feedback", goldRef, signal === "positive" ? "--positive" : "--negative"];
      // Wrap in try/catch so a single throwing akmCli (e.g. subprocess
      // crash) cannot leave `feedbackByRef` partially populated and let
      // Phase 2 proceed on corrupt state.
      try {
        const cliResult = await akmCli(args, phase1Cwd, envForRef(goldRef));
        feedbackLog.push({ taskId: run.taskId, seed: run.seed, goldRef, signal, ok: cliResult.exitCode === 0 });
        if (cliResult.exitCode !== 0) {
          warnings.push(`phase1: akm feedback for ${goldRef} (${signal}) failed: ${cliResult.stderr.trim()}`);
        }
      } catch (err) {
        feedbackLog.push({ taskId: run.taskId, seed: run.seed, goldRef, signal, ok: false });
        warnings.push(`phase1.feedback_dispatch_failed: ${goldRef} ${(err as Error).message}`);
      }
      const counts = feedbackByRef.get(goldRef) ?? { positive: 0, negative: 0 };
      if (signal === "positive") counts.positive += 1;
      else counts.negative += 1;
      feedbackByRef.set(goldRef, counts);
    }

    // ── Phase 2: evolve. ────────────────────────────────────────────────────
    const evalGoldRefs = new Set<string>();
    for (const t of evalTasks) {
      if (t.goldRef) evalGoldRefs.add(t.goldRef);
    }

    const refsToEvolve: string[] = [];
    for (const [ref, counts] of feedbackByRef.entries()) {
      if (crossesNegativeThreshold(counts, negativeThreshold)) refsToEvolve.push(ref);
    }
    refsToEvolve.sort();

    // Emit the generic leakage warning at most once per Phase 2 invocation;
    // per-ref skip warnings (which name the specific ref) stay in the loop.
    let leakageWarningEmitted = false;
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
      // we still warn so operators know the protection is partial — but only
      // once per phase, regardless of how many refs we evolve.
      const evolveEnv: Record<string, string> = {
        ...envForRef(ref),
        AKM_BENCH_EXCLUDE_GOLD_REFS: [...evalGoldRefs].join(","),
      };
      if (evalGoldRefs.size > 0 && !leakageWarningEmitted) {
        warnings.push(
          "phase2: distill/reflect cannot today filter their own LLM input by --exclude-gold-ref; relying on per-ref skip + env hint only.",
        );
        leakageWarningEmitted = true;
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

    // Walk the proposal queue per fixture (each evolveStash has its own
    // proposal log on disk). When we materialised stashes we iterate every
    // fixture that produced proposals; in the common single-fixture case
    // this is one pass.
    const proposalFixtures = materialiseStash ? [...evolveDirByFixture.keys()] : [undefined];
    for (const fixtureName of proposalFixtures) {
      const proposalEnv: Record<string, string> = { ...(process.env as Record<string, string>) };
      if (materialiseStash && fixtureName) {
        const dir = evolveDirByFixture.get(fixtureName);
        if (dir) proposalEnv.AKM_STASH_DIR = dir;
      } else if (!materialiseStash) {
        delete proposalEnv.AKM_STASH_DIR;
      }
      const listResult = await akmCli(["proposal", "list", "--json"], phase1Cwd, proposalEnv);
      const proposals = parseProposalList(listResult.stdout);
      for (const p of proposals) {
        const showResult = await akmCli(["proposal", "show", p.id, "--json"], phase1Cwd, proposalEnv);
        const lintInfo = parseProposalShow(showResult.stdout);
        const lintPass = lintInfo.lintPass;
        if (lintPass) {
          const acceptResult = await akmCli(["proposal", "accept", p.id], phase1Cwd, proposalEnv);
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
            proposalEnv,
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
      const indexResult = await akmCli(["index"], phase1Cwd, proposalEnv);
      if (indexResult.exitCode !== 0) {
        warnings.push(`phase2: akm index rebuild failed: ${indexResult.stderr.trim()}`);
      }
    }

    // ── Phase 3: re-evaluate (eval slice). ─────────────────────────────────
    // pre arm: fresh snapshot of the starting fixture (no Phase 2 mutations
    // applied). post arm: the mutated evolveStash so accepted lessons reach
    // the eval slice. synthetic arm: no stash.
    preReport = await runUtility({
      tasks: evalTasks,
      arms: ["akm"],
      model: options.model,
      seedsPerArm,
      budgetTokens,
      budgetWallMs,
      slice: "eval",
      ...(options.spawn ? { spawn: options.spawn } : {}),
      materialiseStash,
      ...(materialiseStash ? { stashDirByFixture: preDirByFixture } : {}),
      ...(options.timestamp ? { timestamp: options.timestamp } : {}),
      ...(options.branch ? { branch: options.branch } : {}),
      ...(options.commit ? { commit: options.commit } : {}),
    });

    postReport = await runUtility({
      tasks: evalTasks,
      arms: ["akm"],
      model: options.model,
      seedsPerArm,
      budgetTokens,
      budgetWallMs,
      slice: "eval",
      // Stamp arm metadata so spawn fakes can distinguish pre-vs-post via
      // an env probe. We thread it via a fresh `spawn` wrapper when one
      // was supplied.
      materialiseStash,
      ...(materialiseStash ? { stashDirByFixture: evolveDirByFixture } : {}),
      ...(options.timestamp ? { timestamp: options.timestamp } : {}),
      ...(options.branch ? { branch: options.branch } : {}),
      ...(options.commit ? { commit: options.commit } : {}),
      ...(options.spawn ? { spawn: wrapSpawnWithArm(options.spawn, "post") } : {}),
    });

    // synthetic: no stash. We pass a spawn wrapper that strips
    // AKM_STASH_DIR and injects the "Bring Your Own Skills" tag so test
    // fakes (and a future real harness) can branch.
    syntheticReport = await runUtility({
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
      ...(options.spawn ? { spawn: wrapSpawnWithArm(options.spawn, "synthetic", undefined, true) } : {}),
    });
  } finally {
    for (const s of evolveStashes.values()) {
      try {
        s.cleanup();
      } catch {
        /* swallow — best-effort tmp cleanup */
      }
    }
    for (const s of preStashes.values()) {
      try {
        s.cleanup();
      } catch {
        /* swallow — best-effort tmp cleanup */
      }
    }
  }

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
