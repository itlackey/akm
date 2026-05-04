/**
 * Unit tests for the evolve runner (Track B, #243).
 *
 * Every external interaction is mocked via injected fakes:
 *   • `spawn` — fake SpawnFn forwarded to runOne; produces deterministic
 *     stdout per arm so the runner's outcome classification is testable.
 *   • `akmCli` — fake AkmCliFn that records every call and returns scripted
 *     stdout/stderr/exit codes for `feedback` / `distill` / `reflect` /
 *     `proposal *` / `index`.
 *   • `materialiseStash: false` — runUtility never touches the on-disk
 *     fixture directory.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import type { SpawnedSubprocess, SpawnFn } from "../../src/integrations/agent/spawn";
import type { TaskMetadata } from "./corpus";
import { type AkmCliFn, type AkmCliResult, buildSyntheticPrompt, type FeedbackLogEntry, runEvolve } from "./evolve";
import { computeLongitudinalMetrics, computeProposalQualityMetrics, type ProposalLogEntry } from "./metrics";
import type { UtilityRunReport } from "./report";
import { benchMkdtemp } from "./tmp";

function asReadableStream(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/**
 * Build a fake spawn that drives the agent harness deterministically.
 * The fake always emits `ok` on agent runs; per-task pass/fail is controlled
 * by setting `expectedMatch` on the task: `"ok"` to pass, anything else
 * (e.g. `"WONT_MATCH"`) to fail. This bypasses the verifier-spawn path
 * because our fake tasks all use `verifier: "regex"`.
 */
function buildFakeSpawn(opts: { observed?: { arms: string[]; cwd: (string | undefined)[] } }): SpawnFn {
  return (_cmd, options) => {
    if (opts.observed) {
      opts.observed.arms.push(options.env?.BENCH_EVOLVE_ARM ?? (options.env?.AKM_STASH_DIR ? "akm" : "noakm"));
      opts.observed.cwd.push(options.cwd);
    }
    const proc: SpawnedSubprocess = {
      exitCode: 0,
      exited: Promise.resolve(0),
      stdout: asReadableStream("ok"),
      stderr: asReadableStream(""),
      stdin: null,
      kill() {},
    };
    return proc;
  };
}

/**
 * Build a fake akmCli that records calls and returns scripted responses.
 * `proposalQueue` is the list of proposals returned by `proposal list`.
 * `lintByProposal` controls lint outcomes for `proposal show`.
 */
function buildFakeAkmCli(opts: {
  proposalQueue?: Array<{ id: string; targetRef: string; kind?: string }>;
  lintByProposal?: Record<string, { lintPass: boolean; message?: string }>;
  observed?: { calls: string[][]; envSeen: Record<string, string>[] };
}): AkmCliFn {
  return async (args, _cwd, env): Promise<AkmCliResult> => {
    if (opts.observed) {
      opts.observed.calls.push(args);
      opts.observed.envSeen.push({ ...env });
    }
    if (args[0] === "feedback") return { exitCode: 0, stdout: "", stderr: "" };
    if (args[0] === "distill") return { exitCode: 0, stdout: "", stderr: "" };
    if (args[0] === "reflect") return { exitCode: 0, stdout: "", stderr: "" };
    if (args[0] === "index") return { exitCode: 0, stdout: "", stderr: "" };
    if (args[0] === "proposal" && args[1] === "list") {
      const queue = opts.proposalQueue ?? [];
      return {
        exitCode: 0,
        stdout: JSON.stringify(queue.map((p) => ({ id: p.id, target_ref: p.targetRef, kind: p.kind ?? "lesson" }))),
        stderr: "",
      };
    }
    if (args[0] === "proposal" && args[1] === "show") {
      const id = args[2];
      const lint = opts.lintByProposal?.[id] ?? { lintPass: true };
      const payload = {
        id,
        lint_pass: lint.lintPass,
        lint: lint.lintPass ? { pass: true, issues: [] } : { pass: false, issues: [lint.message ?? "lint error"] },
      };
      return { exitCode: 0, stdout: JSON.stringify(payload), stderr: "" };
    }
    if (args[0] === "proposal" && args[1] === "accept") return { exitCode: 0, stdout: "", stderr: "" };
    if (args[0] === "proposal" && args[1] === "reject") return { exitCode: 0, stdout: "", stderr: "" };
    return { exitCode: 0, stdout: "", stderr: "" };
  };
}

function fakeTask(taskDir: string, overrides: Partial<TaskMetadata> = {}): TaskMetadata {
  return {
    id: "fake-d/task-a",
    title: "Fake A",
    domain: "fake-d",
    difficulty: "easy",
    stash: "minimal",
    verifier: "regex",
    expectedMatch: "ok",
    budget: { tokens: 1000, wallMs: 5000 },
    taskDir,
    slice: "train",
    goldRef: "skill:fake-a",
    ...overrides,
  };
}

describe("runEvolve — Phase 1 feedback", () => {
  let workspaceRoot: string;
  let taskDir: string;

  beforeAll(() => {
    workspaceRoot = benchMkdtemp("bench-evolve-test-");
    taskDir = path.join(workspaceRoot, "task");
    fs.mkdirSync(taskDir, { recursive: true });
  });
  afterAll(() => {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("records --positive feedback on pass and --negative on fail", async () => {
    const observed = { calls: [] as string[][], envSeen: [] as Record<string, string>[] };
    // Two train tasks: one passes (expectedMatch=ok matches "ok" stdout), one fails.
    const tasks = [
      fakeTask(taskDir, { id: "fake-d/pass", goldRef: "skill:passing", slice: "train", expectedMatch: "ok" }),
      fakeTask(taskDir, { id: "fake-d/fail", goldRef: "skill:failing", slice: "train", expectedMatch: "WONT" }),
      fakeTask(taskDir, { id: "fake-d/eval", goldRef: "skill:eval-target", slice: "eval", expectedMatch: "ok" }),
    ];
    const spawn = buildFakeSpawn({});
    const akmCli = buildFakeAkmCli({ observed });

    const report = await runEvolve({
      tasks,
      model: "test-model",
      seedsPerArm: 2,
      spawn,
      akmCli,
      materialiseStash: false,
      timestamp: "2026-04-27T00:00:00Z",
      branch: "test",
      commit: "abc",
    });

    // Verify feedback events exist.
    const feedbackCalls = observed.calls.filter((c) => c[0] === "feedback");
    expect(feedbackCalls.length).toBeGreaterThan(0);
    // Each train (passing) seed -> --positive; each train (failing) seed -> --negative.
    const positives = feedbackCalls.filter((c) => c[2] === "--positive");
    const negatives = feedbackCalls.filter((c) => c[2] === "--negative");
    expect(positives.length).toBe(2); // pass task × 2 seeds
    expect(negatives.length).toBe(2); // fail task × 2 seeds
    // The feedback log should match.
    const positiveLog = report.feedbackLog.filter((e: FeedbackLogEntry) => e.signal === "positive");
    expect(positiveLog.length).toBe(2);
    expect(positiveLog[0].goldRef).toBe("skill:passing");
  });
});

describe("runEvolve — Phase 2 threshold + proposal lifecycle", () => {
  let workspaceRoot: string;
  let taskDir: string;
  beforeAll(() => {
    workspaceRoot = benchMkdtemp("bench-evolve-phase2-");
    taskDir = path.join(workspaceRoot, "task");
    fs.mkdirSync(taskDir, { recursive: true });
  });
  afterAll(() => {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("threshold gates distill+reflect", async () => {
    const observed = { calls: [] as string[][], envSeen: [] as Record<string, string>[] };
    const tasks = [
      fakeTask(taskDir, { id: "fake-d/loser", goldRef: "skill:loser", slice: "train", expectedMatch: "WONT" }),
      fakeTask(taskDir, { id: "fake-d/winner", goldRef: "skill:winner", slice: "train", expectedMatch: "ok" }),
      fakeTask(taskDir, { id: "fake-d/eval", goldRef: "skill:eval-only", slice: "eval", expectedMatch: "ok" }),
    ];
    const spawn = buildFakeSpawn({});
    const akmCli = buildFakeAkmCli({ observed, proposalQueue: [] });
    await runEvolve({
      tasks,
      model: "test-model",
      seedsPerArm: 3,
      spawn,
      akmCli,
      materialiseStash: false,
      negativeThreshold: { absoluteCount: 2, ratio: 0.5 },
    });
    const distillCalls = observed.calls.filter((c) => c[0] === "distill");
    const reflectCalls = observed.calls.filter((c) => c[0] === "reflect");
    // Loser crosses threshold; winner does not.
    expect(distillCalls.map((c) => c[1])).toEqual(["skill:loser"]);
    expect(reflectCalls.map((c) => c[1])).toEqual(["skill:loser"]);
  });

  test("lint_pass=true → accept, lint_pass=false → reject", async () => {
    const observed = { calls: [] as string[][], envSeen: [] as Record<string, string>[] };
    const tasks = [
      fakeTask(taskDir, { id: "fake-d/loser", goldRef: "skill:loser", slice: "train", expectedMatch: "WONT" }),
      fakeTask(taskDir, { id: "fake-d/eval", goldRef: "skill:eval-only", slice: "eval", expectedMatch: "ok" }),
    ];
    const spawn = buildFakeSpawn({});
    const akmCli = buildFakeAkmCli({
      observed,
      proposalQueue: [
        { id: "p-good", targetRef: "skill:loser", kind: "lesson" },
        { id: "p-bad", targetRef: "skill:loser", kind: "revision" },
      ],
      lintByProposal: {
        "p-good": { lintPass: true },
        "p-bad": { lintPass: false, message: "missing description" },
      },
    });
    const report = await runEvolve({
      tasks,
      model: "test-model",
      seedsPerArm: 2,
      spawn,
      akmCli,
      materialiseStash: false,
    });
    const accepted = observed.calls.find((c) => c[0] === "proposal" && c[1] === "accept" && c[2] === "p-good");
    const rejected = observed.calls.find((c) => c[0] === "proposal" && c[1] === "reject" && c[2] === "p-bad");
    expect(accepted).toBeDefined();
    expect(rejected).toBeDefined();
    expect(report.proposalLog.find((e: ProposalLogEntry) => e.proposalId === "p-good")?.decision).toBe("accept");
    expect(report.proposalLog.find((e: ProposalLogEntry) => e.proposalId === "p-bad")?.decision).toBe("reject");
    expect(report.proposals.totalProposals).toBe(2);
    expect(report.proposals.totalAccepted).toBe(1);
    expect(report.proposals.acceptanceRate).toBe(0.5);
  });

  test("rebuilds index after Phase 2", async () => {
    const observed = { calls: [] as string[][], envSeen: [] as Record<string, string>[] };
    const tasks = [fakeTask(taskDir, { id: "fake-d/eval-only", slice: "eval", expectedMatch: "ok" })];
    const spawn = buildFakeSpawn({});
    const akmCli = buildFakeAkmCli({ observed });
    await runEvolve({ tasks, model: "test-model", seedsPerArm: 1, spawn, akmCli, materialiseStash: false });
    expect(observed.calls.some((c) => c[0] === "index")).toBe(true);
  });
});

describe("runEvolve — Phase 3 three-arm execution", () => {
  let workspaceRoot: string;
  let taskDir: string;
  beforeAll(() => {
    workspaceRoot = benchMkdtemp("bench-evolve-phase3-");
    taskDir = path.join(workspaceRoot, "task");
    fs.mkdirSync(taskDir, { recursive: true });
  });
  afterAll(() => {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("produces pre / post / synthetic arm reports", async () => {
    const tasks = [
      fakeTask(taskDir, { id: "fake-d/eval-task", slice: "eval", goldRef: "skill:t", expectedMatch: "ok" }),
      fakeTask(taskDir, { id: "fake-d/train-task", slice: "train", goldRef: "skill:tr", expectedMatch: "ok" }),
    ];
    const spawn = buildFakeSpawn({});
    const akmCli = buildFakeAkmCli({});
    const report = await runEvolve({
      tasks,
      model: "test-model",
      seedsPerArm: 2,
      spawn,
      akmCli,
      materialiseStash: false,
    });
    expect(report.arms.pre.tasks.length).toBe(1); // eval-only
    expect(report.arms.post.tasks.length).toBe(1);
    expect(report.arms.synthetic.tasks.length).toBe(1);
  });

  test("synthetic arm receives no AKM_STASH_DIR via spawn wrapper", async () => {
    const observed: { arms: string[]; cwd: (string | undefined)[] } = { arms: [], cwd: [] };
    const tasks = [fakeTask(taskDir, { id: "fake-d/eval-x", slice: "eval", goldRef: "skill:x", expectedMatch: "ok" })];
    const spawn = buildFakeSpawn({ observed });
    const akmCli = buildFakeAkmCli({});
    await runEvolve({
      tasks,
      model: "test-model",
      seedsPerArm: 1,
      spawn,
      akmCli,
      materialiseStash: false,
    });
    // Among the spawn arms, we expect to see the literal "synthetic" tag.
    expect(observed.arms).toContain("synthetic");
  });

  test("buildSyntheticPrompt mentions Bring Your Own Skills", () => {
    const text = buildSyntheticPrompt("docker-homelab/x");
    expect(text).toContain("Bring Your Own Skills");
    expect(text).toContain("scratchpad");
  });

  test("synthetic arm forwards buildSyntheticPrompt(task) into the agent spawn (#267)", async () => {
    // Capture every agent cmd; runAgent appends the prompt as its trailing
    // arg. Phase 3's synthetic arm should now ship the BYOS scratchpad
    // prompt instead of the driver default.
    const capturedSyntheticPrompts: string[] = [];
    const spawn: SpawnFn = (cmd, options) => {
      const isAgent = cmd[0] === "opencode";
      if (isAgent && options.env?.BENCH_EVOLVE_SCRATCHPAD === "1") {
        // Trailing token is the prompt.
        capturedSyntheticPrompts.push(cmd[cmd.length - 1] ?? "");
      }
      return {
        exitCode: 0,
        exited: Promise.resolve(0),
        stdout: asReadableStream("ok"),
        stderr: asReadableStream(""),
        stdin: null,
        kill() {},
      };
    };
    const tasks = [
      fakeTask(taskDir, { id: "fake-d/eval-a", slice: "eval", goldRef: "skill:a", expectedMatch: "ok" }),
      fakeTask(taskDir, { id: "fake-d/eval-b", slice: "eval", goldRef: "skill:b", expectedMatch: "ok" }),
    ];
    const akmCli = buildFakeAkmCli({});
    await runEvolve({
      tasks,
      model: "test-model",
      seedsPerArm: 1,
      spawn,
      akmCli,
      materialiseStash: false,
    });
    expect(capturedSyntheticPrompts.length).toBe(2);
    for (const prompt of capturedSyntheticPrompts) {
      expect(prompt).toContain("Bring Your Own Skills");
      expect(prompt).toContain("scratchpad");
    }
    // Per-task ids landed in their respective prompts.
    expect(capturedSyntheticPrompts.some((p) => p.includes("fake-d/eval-a"))).toBe(true);
    expect(capturedSyntheticPrompts.some((p) => p.includes("fake-d/eval-b"))).toBe(true);
  });
});

describe("runEvolve — leakage prevention (§7.4)", () => {
  let workspaceRoot: string;
  let taskDir: string;
  beforeAll(() => {
    workspaceRoot = benchMkdtemp("bench-evolve-leak-");
    taskDir = path.join(workspaceRoot, "task");
    fs.mkdirSync(taskDir, { recursive: true });
  });
  afterAll(() => {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("invokes distill with --exclude-feedback-from when ref is also an eval-slice gold ref (#267)", async () => {
    const observed = { calls: [] as string[][], envSeen: [] as Record<string, string>[] };
    // The same `skill:shared` is the gold ref for BOTH a failing train task
    // AND an eval task. Distill is now invoked WITH the exclusion flag;
    // distill itself filters the leaked feedback out of the prompt.
    const tasks = [
      fakeTask(taskDir, { id: "fake-d/train-shared", goldRef: "skill:shared", slice: "train", expectedMatch: "WONT" }),
      fakeTask(taskDir, { id: "fake-d/eval-shared", goldRef: "skill:shared", slice: "eval", expectedMatch: "ok" }),
    ];
    const spawn = buildFakeSpawn({});
    const akmCli = buildFakeAkmCli({ observed });
    const report = await runEvolve({
      tasks,
      model: "test-model",
      seedsPerArm: 3,
      spawn,
      akmCli,
      materialiseStash: false,
    });
    const distillCalls = observed.calls.filter((c) => c[0] === "distill");
    // Distill now runs even on shared refs — but with the exclusion flag.
    expect(distillCalls.length).toBe(1);
    const flagIdx = distillCalls[0]?.indexOf("--exclude-feedback-from") ?? -1;
    expect(flagIdx).toBeGreaterThan(-1);
    expect(distillCalls[0]?.[flagIdx + 1]).toBe("skill:shared");
    // Per-ref leakage info note replaces the old "skipped" warning.
    expect(report.warnings.some((w) => w.includes("filtered eval-slice gold-ref feedback"))).toBe(true);
    // Env var fallback is also threaded through for harnesses that drop flags.
    const distillEnv = observed.envSeen.find((env) => env.AKM_DISTILL_EXCLUDE_FEEDBACK_FROM !== undefined);
    expect(distillEnv?.AKM_DISTILL_EXCLUDE_FEEDBACK_FROM).toBe("skill:shared");
  });

  test("does not emit the deprecated '--exclude-gold-ref' generic warning (#267)", async () => {
    const observed = { calls: [] as string[][], envSeen: [] as Record<string, string>[] };
    // Three distinct failing-train refs all cross threshold. The old runner
    // would emit a generic "distill ignores the env hint" warning once;
    // with #267 the filter is real, so that line MUST NOT appear.
    const tasks = [
      fakeTask(taskDir, { id: "fake-d/loser-a", goldRef: "skill:loser-a", slice: "train", expectedMatch: "WONT" }),
      fakeTask(taskDir, { id: "fake-d/loser-b", goldRef: "skill:loser-b", slice: "train", expectedMatch: "WONT" }),
      fakeTask(taskDir, { id: "fake-d/loser-c", goldRef: "skill:loser-c", slice: "train", expectedMatch: "WONT" }),
      fakeTask(taskDir, { id: "fake-d/eval", goldRef: "skill:eval-target", slice: "eval", expectedMatch: "ok" }),
    ];
    const spawn = buildFakeSpawn({});
    const akmCli = buildFakeAkmCli({ observed });
    const report = await runEvolve({
      tasks,
      model: "test-model",
      seedsPerArm: 3,
      spawn,
      akmCli,
      materialiseStash: false,
    });
    const generic = report.warnings.filter((w) =>
      w.includes("distill/reflect cannot today filter their own LLM input"),
    );
    expect(generic.length).toBe(0);
    // We did still evolve all three refs, each carrying the exclusion flag.
    const distillCalls = observed.calls.filter((c) => c[0] === "distill");
    expect(distillCalls.length).toBe(3);
    for (const call of distillCalls) {
      const idx = call.indexOf("--exclude-feedback-from");
      expect(idx).toBeGreaterThan(-1);
      expect(call[idx + 1]).toBe("skill:eval-target");
    }
  });
});

describe("runEvolve — Phase 1 fault tolerance", () => {
  let workspaceRoot: string;
  let taskDir: string;
  beforeAll(() => {
    workspaceRoot = benchMkdtemp("bench-evolve-faulty-");
    taskDir = path.join(workspaceRoot, "task");
    fs.mkdirSync(taskDir, { recursive: true });
  });
  afterAll(() => {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("a throwing akmCli on one feedback ref does not halt Phase 2", async () => {
    const observed = { calls: [] as string[][], envSeen: [] as Record<string, string>[] };
    // Two failing train tasks. The akmCli throws on `feedback skill:bomb`
    // but otherwise behaves normally. Phase 2 should still proceed and
    // distill the surviving refs.
    const tasks = [
      fakeTask(taskDir, { id: "fake-d/bomb", goldRef: "skill:bomb", slice: "train", expectedMatch: "WONT" }),
      fakeTask(taskDir, { id: "fake-d/loser", goldRef: "skill:loser", slice: "train", expectedMatch: "WONT" }),
      fakeTask(taskDir, { id: "fake-d/eval", goldRef: "skill:eval-target", slice: "eval", expectedMatch: "ok" }),
    ];
    const spawn = buildFakeSpawn({});
    const inner = buildFakeAkmCli({ observed });
    const akmCli: AkmCliFn = async (args, cwd, env) => {
      if (args[0] === "feedback" && args[1] === "skill:bomb") {
        throw new Error("subprocess crashed");
      }
      return inner(args, cwd, env);
    };
    const report = await runEvolve({
      tasks,
      model: "test-model",
      seedsPerArm: 2,
      spawn,
      akmCli,
      materialiseStash: false,
      negativeThreshold: { absoluteCount: 2, ratio: 0.5 },
    });
    // The throwing ref produced a warning of the documented shape.
    expect(report.warnings.some((w) => w.includes("phase1.feedback_dispatch_failed: skill:bomb"))).toBe(true);
    // Phase 2 still ran for the surviving ref (skill:loser crosses threshold).
    const distillCalls = observed.calls.filter((c) => c[0] === "distill");
    expect(distillCalls.map((c) => c[1])).toContain("skill:loser");
    // The throwing entries are still in feedbackLog (with ok:false).
    const bombEntries = report.feedbackLog.filter((e) => e.goldRef === "skill:bomb");
    expect(bombEntries.length).toBe(2);
    expect(bombEntries.every((e) => e.ok === false)).toBe(true);
  });
});

describe("runEvolve — operator stash sandboxing", () => {
  let workspaceRoot: string;
  let taskDir: string;
  beforeAll(() => {
    workspaceRoot = benchMkdtemp("bench-evolve-sandbox-");
    taskDir = path.join(workspaceRoot, "task");
    fs.mkdirSync(taskDir, { recursive: true });
  });
  afterAll(() => {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("does not mutate process.env.AKM_STASH_DIR", async () => {
    const sentinel = "/tmp/sentinel-operator-stash-must-not-change";
    const before = process.env.AKM_STASH_DIR;
    process.env.AKM_STASH_DIR = sentinel;
    try {
      const tasks = [
        fakeTask(taskDir, { id: "fake-d/loser", goldRef: "skill:loser", slice: "train", expectedMatch: "WONT" }),
        fakeTask(taskDir, { id: "fake-d/eval", goldRef: "skill:eval-target", slice: "eval", expectedMatch: "ok" }),
      ];
      const spawn = buildFakeSpawn({});
      const akmCli = buildFakeAkmCli({});
      await runEvolve({
        tasks,
        model: "test-model",
        seedsPerArm: 2,
        spawn,
        akmCli,
        materialiseStash: false,
      });
      expect(process.env.AKM_STASH_DIR).toBe(sentinel);
    } finally {
      if (before === undefined) delete process.env.AKM_STASH_DIR;
      else process.env.AKM_STASH_DIR = before;
    }
  });

  test("akmCli env never carries the operator's AKM_STASH_DIR (materialiseStash:false strips it)", async () => {
    const sentinel = "/tmp/sentinel-operator-stash-leak-test";
    const before = process.env.AKM_STASH_DIR;
    process.env.AKM_STASH_DIR = sentinel;
    try {
      const observed = { calls: [] as string[][], envSeen: [] as Record<string, string>[] };
      const tasks = [
        fakeTask(taskDir, { id: "fake-d/loser", goldRef: "skill:loser", slice: "train", expectedMatch: "WONT" }),
        fakeTask(taskDir, { id: "fake-d/eval", goldRef: "skill:eval-target", slice: "eval", expectedMatch: "ok" }),
      ];
      const spawn = buildFakeSpawn({});
      const akmCli = buildFakeAkmCli({ observed });
      await runEvolve({
        tasks,
        model: "test-model",
        seedsPerArm: 2,
        spawn,
        akmCli,
        materialiseStash: false,
      });
      // Every recorded env passed to the fake akmCli must NOT carry the
      // operator's sentinel value — the runEvolve sandbox strips it.
      for (const env of observed.envSeen) {
        expect(env.AKM_STASH_DIR).not.toBe(sentinel);
      }
    } finally {
      if (before === undefined) delete process.env.AKM_STASH_DIR;
      else process.env.AKM_STASH_DIR = before;
    }
  });
});

describe("computeLongitudinalMetrics", () => {
  // Build a minimal §13.3-shape report with a single task and prescribed pass rate.
  function makeReport(
    taskId: string,
    akmPassRate: number,
    opts: { seedsPerArm?: number; failureMode?: string } = {},
  ): UtilityRunReport {
    const seedsPerArm = opts.seedsPerArm ?? 5;
    const akm = {
      passRate: akmPassRate,
      passAt1: 0 as 0 | 1,
      tokensPerPass: null,
      tokensPerRun: null,
      wallclockMs: 0,
      passRateStdev: 0,
      budgetExceededCount: 0,
      harnessErrorCount: 0,
      count: seedsPerArm,
      runsWithMeasuredTokens: 0,
    };
    const noakm = { ...akm, passRate: 0 };
    return {
      timestamp: "t",
      branch: "b",
      commit: "c",
      model: "m",
      corpus: { domains: 1, tasks: 1, slice: "eval", seedsPerArm },
      aggregateNoakm: { passRate: 0, tokensPerPass: null, tokensPerRun: null, wallclockMs: 0 },
      aggregateAkm: { passRate: akmPassRate, tokensPerPass: null, tokensPerRun: null, wallclockMs: 0 },
      aggregateDelta: { passRate: akmPassRate, tokensPerPass: null, tokensPerRun: null, wallclockMs: 0 },
      trajectoryAkm: { correctAssetLoaded: null, feedbackRecorded: 0 },
      failureModes: opts.failureMode
        ? {
            byLabel: { [opts.failureMode]: 1 } as Record<string, number>,
            byTask: { [taskId]: { [opts.failureMode]: 1 } as Record<string, number> },
          }
        : { byLabel: {}, byTask: {} },
      tasks: [
        {
          id: taskId,
          noakm,
          akm,
          delta: { passRate: akmPassRate, tokensPerPass: null, tokensPerRun: null, wallclockMs: 0 },
        },
      ],
      warnings: [],
    };
  }

  test("computes improvement_slope, over_synthetic_lift, degradation_count", () => {
    const pre = makeReport("t", 0.4);
    const post = makeReport("t", 0.7);
    const synthetic = makeReport("t", 0.2);
    const longi = computeLongitudinalMetrics(pre, post, synthetic);
    expect(longi.improvementSlope).toBeCloseTo(0.3, 2);
    expect(longi.overSyntheticLift).toBeCloseTo(0.5, 2);
    expect(longi.degradationCount).toBe(0);
  });

  test("flags degradations with > 1 seed drop", () => {
    const pre = makeReport("t", 0.8, { seedsPerArm: 5 });
    // 1/5 = 0.2 — drop of 0.4 is way above threshold.
    const post = makeReport("t", 0.4, { seedsPerArm: 5, failureMode: "search_no_gold" });
    const synthetic = makeReport("t", 0.5);
    const longi = computeLongitudinalMetrics(pre, post, synthetic);
    expect(longi.degradationCount).toBe(1);
    expect(longi.degradations[0].failureMode).toBe("search_no_gold");
  });

  test("does NOT flag a 0.1 drop with seedsPerArm=5 (within 1-seed threshold)", () => {
    const pre = makeReport("t", 0.6, { seedsPerArm: 5 });
    const post = makeReport("t", 0.5, { seedsPerArm: 5 });
    const synthetic = makeReport("t", 0.5);
    const longi = computeLongitudinalMetrics(pre, post, synthetic);
    // 1/5 = 0.2; drop of 0.1 is below threshold. No degradation.
    expect(longi.degradationCount).toBe(0);
  });
});

describe("computeProposalQualityMetrics", () => {
  test("aggregates accepted / lint_pass / total per asset", () => {
    const log: ProposalLogEntry[] = [
      { proposalId: "p1", assetRef: "skill:a", kind: "lesson", lintPass: true, decision: "accept" },
      { proposalId: "p2", assetRef: "skill:a", kind: "revision", lintPass: false, decision: "reject" },
      { proposalId: "p3", assetRef: "skill:b", kind: "lesson", lintPass: true, decision: "accept" },
    ];
    const m = computeProposalQualityMetrics(log);
    expect(m.totalProposals).toBe(3);
    expect(m.totalAccepted).toBe(2);
    expect(m.acceptanceRate).toBeCloseTo(2 / 3, 2);
    expect(m.lintPassRate).toBeCloseTo(2 / 3, 2);
    const a = m.rows.find((r) => r.assetRef === "skill:a");
    expect(a?.proposalCount).toBe(2);
    expect(a?.acceptedCount).toBe(1);
    expect(a?.lintPassCount).toBe(1);
  });

  test("zero-proposal log yields zeroes (no NaN)", () => {
    const m = computeProposalQualityMetrics([]);
    expect(m.totalProposals).toBe(0);
    expect(m.acceptanceRate).toBe(0);
    expect(m.lintPassRate).toBe(0);
    expect(m.rows.length).toBe(0);
  });
});
