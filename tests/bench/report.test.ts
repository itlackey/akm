/**
 * Unit tests for the JSON + markdown report renderers.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RunResult } from "./driver";
import type { PerTaskMetrics } from "./metrics";
import {
  type ReportInput,
  renderJsonReport,
  renderMarkdownSummary,
  renderUtilityReport,
  resolveGitBranch,
  resolveGitCommit,
  serializeRunForReport,
  type UtilityRunReport,
} from "./report";

const sample: ReportInput = {
  timestamp: "2026-04-27T12:00:00Z",
  branch: "feature/akm-bench",
  commit: "deadbeef",
  model: "anthropic/claude-opus-4-7",
  track: "utility",
  arms: {
    noakm: {
      passRate: 0.4,
      tokensPerPass: 18000,
      wallclockMs: 41000,
      budgetExceeded: 0,
      runsWithMeasuredTokens: 4,
    },
    akm: {
      passRate: 0.7,
      tokensPerPass: 14000,
      wallclockMs: 36000,
      budgetExceeded: 1,
      runsWithMeasuredTokens: 7,
    },
  },
};

describe("renderJsonReport", () => {
  test("stamps timestamp, branch, commit, and model", () => {
    const json = renderJsonReport(sample);
    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.timestamp).toBe(sample.timestamp);
    expect(parsed.branch).toBe(sample.branch);
    expect(parsed.commit).toBe(sample.commit);
    expect(parsed.track).toBe("utility");
    expect((parsed.agent as { harness: string }).harness).toBe("opencode");
    expect((parsed.agent as { model: string }).model).toBe(sample.model);
  });

  test("includes arm aggregates verbatim", () => {
    const json = renderJsonReport(sample);
    const parsed = JSON.parse(json) as { aggregate: Record<string, { passRate: number }> };
    expect(parsed.aggregate.noakm.passRate).toBeCloseTo(0.4);
    expect(parsed.aggregate.akm.passRate).toBeCloseTo(0.7);
  });
});

describe("renderMarkdownSummary", () => {
  test("produces a roughly 5-line summary with the model + arm rows", () => {
    const md = renderMarkdownSummary(sample);
    const lines = md.split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(4);
    expect(lines.length).toBeLessThanOrEqual(8);
    expect(md).toContain(sample.model);
    expect(md).toContain("noakm");
    expect(md).toContain("akm");
    expect(md).toContain("pass_rate=");
  });
});

// ── Utility-track report (§13.3) ───────────────────────────────────────────

function pt(passRate: number, tokens: number | null, wall: number, count = 5): PerTaskMetrics {
  const passes = Math.round(passRate * count);
  return {
    passRate,
    passAt1: passes > 0 ? 1 : 0,
    tokensPerPass: tokens,
    wallclockMs: wall,
    passRateStdev: 0,
    budgetExceededCount: 0,
    harnessErrorCount: 0,
    count,
    runsWithMeasuredTokens: count,
  };
}

const utilSample: UtilityRunReport = {
  timestamp: "2026-04-27T12:00:00Z",
  branch: "release/1.0.0",
  commit: "deadbee",
  model: "anthropic/claude-opus-4-7",
  corpus: { domains: 3, tasks: 2, slice: "all", seedsPerArm: 5 },
  aggregateNoakm: { passRate: 0.4, tokensPerPass: 18000, wallclockMs: 41000 },
  aggregateAkm: { passRate: 0.7, tokensPerPass: 14000, wallclockMs: 36000 },
  aggregateDelta: { passRate: 0.3, tokensPerPass: -4000, wallclockMs: -5000 },
  trajectoryAkm: { correctAssetLoaded: 0.78, feedbackRecorded: 0.65 },
  failureModes: { byLabel: {}, byTask: {} },
  tasks: [
    {
      id: "domain-a/task-1",
      noakm: pt(0.4, 20000, 40000),
      akm: pt(0.8, 13000, 35000),
      delta: { passRate: 0.4, tokensPerPass: -7000, wallclockMs: -5000 },
    },
    {
      id: "domain-b/task-2",
      noakm: pt(0.4, null, 42000),
      akm: pt(0.6, 15000, 37000),
      delta: { passRate: 0.2, tokensPerPass: null, wallclockMs: -5000 },
    },
  ],
  warnings: [],
};

describe("renderUtilityReport JSON corpus identity (#250)", () => {
  test("emits selectedTaskIds, taskCorpusHash, fixtures, fixtureContentHash when present", () => {
    const stamped: UtilityRunReport = {
      ...utilSample,
      corpus: {
        ...utilSample.corpus,
        selectedTaskIds: ["domain-a/task-1", "domain-b/task-2"],
        taskCorpusHash: "deadbeef".repeat(8),
        fixtures: { "fixture-a": "aa".repeat(32), "fixture-b": "bb".repeat(32) },
        fixtureContentHash: "ff".repeat(32),
      },
    };
    const { json } = renderUtilityReport(stamped);
    const corpus = (json as { corpus: Record<string, unknown> }).corpus;
    expect(corpus.selectedTaskIds).toEqual(["domain-a/task-1", "domain-b/task-2"]);
    expect(corpus.taskCorpusHash).toBe("deadbeef".repeat(8));
    expect(corpus.fixtureContentHash).toBe("ff".repeat(32));
    expect(corpus.fixtures).toEqual({ "fixture-a": "aa".repeat(32), "fixture-b": "bb".repeat(32) });
  });

  test("legacy reports without identity stamps still render (#250 backward compat)", () => {
    const { json } = renderUtilityReport(utilSample);
    const corpus = (json as { corpus: Record<string, unknown> }).corpus;
    // The four #250 keys are absent on legacy inputs and the renderer does
    // not synthesise placeholders.
    expect(corpus.taskCorpusHash).toBeUndefined();
    expect(corpus.fixtureContentHash).toBeUndefined();
  });
});

describe("renderUtilityReport JSON", () => {
  test("conforms to the §13.3 shape", () => {
    const { json } = renderUtilityReport(utilSample);
    const obj = json as Record<string, unknown>;
    expect(obj.schemaVersion).toBe(1);
    expect(obj.track).toBe("utility");
    expect(obj.branch).toBe("release/1.0.0");
    expect(obj.commit).toBe("deadbee");
    expect(obj.timestamp).toBe("2026-04-27T12:00:00Z");
    expect((obj.agent as Record<string, unknown>).harness).toBe("opencode");
    expect((obj.agent as Record<string, unknown>).model).toBe("anthropic/claude-opus-4-7");

    const corpus = obj.corpus as Record<string, unknown>;
    expect(corpus.domains).toBe(3);
    expect(corpus.tasks).toBe(2);
    expect(corpus.slice).toBe("all");
    expect(corpus.seedsPerArm).toBe(5);

    const aggregate = obj.aggregate as Record<string, Record<string, unknown>>;
    expect(aggregate.noakm.pass_rate).toBeCloseTo(0.4);
    expect(aggregate.akm.tokens_per_pass).toBe(14000);
    expect(aggregate.delta.pass_rate).toBeCloseTo(0.3);
    expect(aggregate.delta.wallclock_ms).toBeCloseTo(-5000);

    const trajectory = obj.trajectory as Record<string, Record<string, unknown>>;
    expect(trajectory.akm.correct_asset_loaded).toBeCloseTo(0.78);
    expect(trajectory.akm.feedback_recorded).toBeCloseTo(0.65);

    const tasks = obj.tasks as Array<Record<string, unknown>>;
    expect(tasks.length).toBe(2);
    expect(tasks[0]?.id).toBe("domain-a/task-1");
    expect((tasks[0]?.akm as Record<string, unknown>).pass_rate).toBeCloseTo(0.8);
    expect((tasks[1]?.delta as Record<string, unknown>).tokens_per_pass).toBeNull();

    expect(obj.warnings).toEqual([]);
  });
});

describe("renderUtilityReport markdown", () => {
  test("contains the expected sections", () => {
    const { markdown } = renderUtilityReport(utilSample);
    expect(markdown).toContain("# akm-bench utility");
    expect(markdown).toContain("anthropic/claude-opus-4-7");
    expect(markdown).toContain("release/1.0.0");
    expect(markdown).toContain("## Aggregate");
    expect(markdown).toContain("## Trajectory (akm)");
    expect(markdown).toContain("## Per-task pass rates");
    expect(markdown).toContain("domain-a/task-1");
    expect(markdown).toContain("domain-b/task-2");
    expect(markdown).toContain("correct_asset_loaded: 78.0%");
    expect(markdown).toContain("feedback_recorded: 65.0%");
  });

  test("delta row shows signed values", () => {
    const { markdown } = renderUtilityReport(utilSample);
    expect(markdown).toContain("**delta**");
    expect(markdown).toContain("+0.30");
    expect(markdown).toContain("-4000");
    expect(markdown).toContain("-5000");
  });

  test("is byte-stable across reruns with identical input", () => {
    const a = renderUtilityReport(utilSample).markdown;
    const b = renderUtilityReport(utilSample).markdown;
    expect(a).toBe(b);
  });

  test("renders warnings section when warnings are present", () => {
    const withWarn: UtilityRunReport = { ...utilSample, warnings: ["stash xyz failed to load"] };
    const { markdown } = renderUtilityReport(withWarn);
    expect(markdown).toContain("## Warnings");
    expect(markdown).toContain("stash xyz failed to load");
  });
});

// ── Compact runs[] serialisation (#249) ───────────────────────────────────

function makeRun(overrides: Partial<RunResult> = {}): RunResult {
  const base: RunResult = {
    schemaVersion: 1,
    taskId: "domain-a/task-1",
    arm: "akm",
    seed: 0,
    model: "anthropic/claude-opus-4-7",
    outcome: "pass",
    tokens: { input: 1234, output: 5678 },
    wallclockMs: 4200,
    trajectory: { correctAssetLoaded: true, feedbackRecorded: false },
    events: [
      // events[] MUST be filtered out of the persisted row.
      { id: 0, ts: "2026-04-27T12:00:00Z", kind: "noop" } as unknown as RunResult["events"][number],
    ],
    verifierStdout: "x".repeat(1024 * 1024),
    verifierExitCode: 0,
    assetsLoaded: ["skill:foo"],
    failureMode: null,
  };
  return { ...base, ...overrides };
}

describe("serializeRunForReport", () => {
  test("omits events[] and verifierStdout, keeps the compact field set", () => {
    const row = serializeRunForReport(makeRun());
    expect(row).toEqual({
      task_id: "domain-a/task-1",
      arm: "akm",
      seed: 0,
      model: "anthropic/claude-opus-4-7",
      outcome: "pass",
      tokens: { input: 1234, output: 5678 },
      wallclock_ms: 4200,
      verifier_exit_code: 0,
      trajectory: { correct_asset_loaded: true, feedback_recorded: false },
      assets_loaded: ["skill:foo"],
      failure_mode: null,
    });
    // No events / stdout leakage even when the source carries large data.
    expect(Object.keys(row)).not.toContain("events");
    expect(Object.keys(row)).not.toContain("verifierStdout");
    expect(Object.keys(row)).not.toContain("verifier_stdout");
  });

  test("passes unknown token-shape keys through (token-shape seam for #252)", () => {
    // Simulate a future RunResult.tokens that grows a `measurement` field.
    const futureRun = makeRun({
      tokens: { input: 10, output: 20, measurement: "parsed" } as unknown as RunResult["tokens"],
    });
    const row = serializeRunForReport(futureRun);
    expect(row.tokens).toEqual({ input: 10, output: 20, measurement: "parsed" });
  });

  test("propagates failure_mode label when present", () => {
    const run = makeRun({ outcome: "fail", failureMode: "wrong_asset" as RunResult["failureMode"] });
    const row = serializeRunForReport(run);
    expect(row.outcome).toBe("fail");
    expect(row.failure_mode).toBe("wrong_asset");
  });
});

describe("renderUtilityReport runs[] persistence (#249)", () => {
  test("emits one row per (task, arm, seed) when allRuns is supplied", () => {
    const allRuns = [
      makeRun({ taskId: "domain-a/task-1", arm: "noakm", seed: 0 }),
      makeRun({ taskId: "domain-a/task-1", arm: "noakm", seed: 1 }),
      makeRun({ taskId: "domain-a/task-1", arm: "akm", seed: 0 }),
      makeRun({ taskId: "domain-a/task-1", arm: "akm", seed: 1, outcome: "fail" }),
    ];
    const report: UtilityRunReport = { ...utilSample, allRuns };
    const { json } = renderUtilityReport(report);
    const obj = json as Record<string, unknown>;
    const runs = obj.runs as Array<Record<string, unknown>>;
    expect(Array.isArray(runs)).toBe(true);
    expect(runs.length).toBe(4);
    // Order matches the runner's deterministic emission order.
    expect(runs[0]?.arm).toBe("noakm");
    expect(runs[2]?.arm).toBe("akm");
    expect(runs[3]?.outcome).toBe("fail");
    // verifier stdout / events MUST be absent.
    for (const r of runs) {
      expect(Object.keys(r)).not.toContain("events");
      expect(Object.keys(r)).not.toContain("verifierStdout");
    }
  });

  test("omits the runs key entirely when allRuns is not supplied (legacy shape)", () => {
    const { json } = renderUtilityReport(utilSample);
    const obj = json as Record<string, unknown>;
    expect("runs" in obj).toBe(false);
  });
});

describe("token-measurement surface (issue #252)", () => {
  function fakeRun(overrides: Partial<import("./driver").RunResult>): import("./driver").RunResult {
    return {
      schemaVersion: 1,
      taskId: "t",
      arm: "akm",
      seed: 0,
      model: "m",
      outcome: "pass",
      tokens: { input: 0, output: 0 },
      tokenMeasurement: "parsed",
      wallclockMs: 0,
      trajectory: { correctAssetLoaded: null, feedbackRecorded: null },
      events: [],
      verifierStdout: "",
      verifierExitCode: 0,
      assetsLoaded: [],
      ...overrides,
    };
  }

  test("JSON envelope has token_measurement coverage block + warning when any run is missing", () => {
    const akmRuns = [
      fakeRun({ seed: 0, tokenMeasurement: "parsed", tokens: { input: 100, output: 50 } }),
      fakeRun({ seed: 1, tokenMeasurement: "missing" }),
      fakeRun({ seed: 2, tokenMeasurement: "unsupported" }),
    ];
    const sampleWithRuns: UtilityRunReport = { ...utilSample, akmRuns };
    const { json, markdown } = renderUtilityReport(sampleWithRuns);
    const obj = json as Record<string, unknown>;
    const tm = obj.token_measurement as Record<string, unknown>;
    expect(tm.total_runs).toBe(3);
    expect(tm.runs_with_measured_tokens).toBe(1);
    expect(tm.runs_missing_measurement).toBe(1);
    expect(tm.runs_unsupported_measurement).toBe(1);
    expect(tm.coverage).toBeCloseTo(1 / 3);
    expect(tm.reliable).toBe(false);

    const warnings = obj.warnings as string[];
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("token measurement unreliable");

    expect(markdown).toContain("## Token measurement (akm)");
    expect(markdown).toContain("unreliable");
    expect(markdown).toContain("## Warnings");
    expect(markdown).toContain("token measurement unreliable");
  });

  test("JSON envelope marks reliable=true and emits no warning when every run is parsed", () => {
    const akmRuns = [
      fakeRun({ seed: 0, tokenMeasurement: "parsed", tokens: { input: 100, output: 50 } }),
      fakeRun({ seed: 1, tokenMeasurement: "parsed", tokens: { input: 200, output: 75 } }),
    ];
    const sampleWithRuns: UtilityRunReport = { ...utilSample, akmRuns };
    const { json, markdown } = renderUtilityReport(sampleWithRuns);
    const obj = json as Record<string, unknown>;
    const tm = obj.token_measurement as Record<string, unknown>;
    expect(tm.total_runs).toBe(2);
    expect(tm.runs_with_measured_tokens).toBe(2);
    expect(tm.coverage).toBeCloseTo(1);
    expect(tm.reliable).toBe(true);
    expect(obj.warnings).toEqual([]);
    expect(markdown).toContain("reliable");
    expect(markdown).not.toContain("token measurement unreliable");
  });

  test("coverage is null and section is skipped when no akm runs are attached", () => {
    const { json, markdown } = renderUtilityReport(utilSample);
    const obj = json as Record<string, unknown>;
    const tm = obj.token_measurement as Record<string, unknown>;
    expect(tm.total_runs).toBe(0);
    expect(tm.coverage).toBeNull();
    expect(tm.reliable).toBe(false);
    expect(markdown).not.toContain("## Token measurement");
  });
});

describe("renderUtilityReport negative-transfer (#260)", () => {
  test("JSON envelope carries zeros and empty arrays when no regressions exist", () => {
    const { json, markdown } = renderUtilityReport(utilSample);
    const obj = json as Record<string, unknown>;
    expect(obj.negative_transfer_count).toBe(0);
    expect(obj.negative_transfer_severity).toBe(0);
    expect(obj.top_regressed_tasks).toEqual([]);
    // Markdown stays QUIET — emits the literal "none" sentinel.
    expect(markdown).toContain("## Negative transfer");
    expect(markdown).toContain("none");
    expect(markdown).not.toContain("### Top regressed tasks");
  });

  test("JSON envelope groups two domains and surfaces a single regression", () => {
    const sample: UtilityRunReport = {
      ...utilSample,
      tasks: [
        {
          id: "domain-a/task-1",
          noakm: pt(0.4, 20000, 40000),
          akm: pt(0.8, 13000, 35000),
          delta: { passRate: 0.4, tokensPerPass: -7000, wallclockMs: -5000 },
        },
        {
          id: "domain-b/task-2",
          noakm: pt(0.6, 20000, 40000),
          akm: pt(0.2, 25000, 38000),
          delta: { passRate: -0.4, tokensPerPass: 5000, wallclockMs: -2000 },
        },
      ],
    };
    const { json } = renderUtilityReport(sample);
    const obj = json as Record<string, unknown>;
    expect(obj.negative_transfer_count).toBe(1);
    expect(obj.negative_transfer_severity).toBeCloseTo(0.4);
    const top = obj.top_regressed_tasks as Array<Record<string, unknown>>;
    expect(top).toHaveLength(1);
    expect(top[0]?.task_id).toBe("domain-b/task-2");
    expect(top[0]?.domain).toBe("domain-b");
    expect(top[0]?.delta).toBeCloseTo(-0.4);
    expect(top[0]?.severity).toBeCloseTo(0.4);

    const domains = obj.domain_level_deltas as Array<Record<string, unknown>>;
    expect(domains).toHaveLength(2);
    expect(domains.map((d) => d.domain)).toEqual(["domain-a", "domain-b"]);
    const domB = domains.find((d) => d.domain === "domain-b");
    expect(domB?.regression_count).toBe(1);
    expect(domB?.pass_rate_delta).toBeCloseTo(-0.4);
  });

  test("markdown renders the regressed-task table and domain table when regressions exist", () => {
    const akmRuns: RunResult[] = [
      {
        schemaVersion: 1,
        taskId: "domain-b/task-2",
        arm: "akm",
        seed: 0,
        model: "m",
        outcome: "fail",
        tokens: { input: 0, output: 0 },
        wallclockMs: 0,
        trajectory: { correctAssetLoaded: null, feedbackRecorded: null },
        events: [],
        verifierStdout: "",
        verifierExitCode: 1,
        assetsLoaded: ["skill:bad-guidance", "knowledge:context"],
      },
      {
        schemaVersion: 1,
        taskId: "domain-b/task-2",
        arm: "akm",
        seed: 1,
        model: "m",
        outcome: "fail",
        tokens: { input: 0, output: 0 },
        wallclockMs: 0,
        trajectory: { correctAssetLoaded: null, feedbackRecorded: null },
        events: [],
        verifierStdout: "",
        verifierExitCode: 1,
        assetsLoaded: ["skill:bad-guidance"],
      },
    ];
    const sample: UtilityRunReport = {
      ...utilSample,
      tasks: [
        {
          id: "domain-a/task-1",
          noakm: pt(0.4, 20000, 40000),
          akm: pt(0.8, 13000, 35000),
          delta: { passRate: 0.4, tokensPerPass: -7000, wallclockMs: -5000 },
        },
        {
          id: "domain-b/task-2",
          noakm: pt(0.6, 20000, 40000),
          akm: pt(0.2, 25000, 38000),
          delta: { passRate: -0.4, tokensPerPass: 5000, wallclockMs: -2000 },
        },
      ],
      akmRuns,
    };
    const { json, markdown } = renderUtilityReport(sample);
    expect(markdown).toContain("## Negative transfer");
    expect(markdown).toContain("count=1");
    expect(markdown).toContain("### Top regressed tasks");
    expect(markdown).toContain("domain-b/task-2");
    expect(markdown).toContain("### Domain-level deltas");
    expect(markdown).toContain("### Asset regression candidates");
    expect(markdown).toContain("skill:bad-guidance");

    const obj = json as Record<string, unknown>;
    const candidates = obj.asset_regression_candidates as Array<Record<string, unknown>>;
    expect(candidates.length).toBeGreaterThan(0);
    const bad = candidates.find((c) => c.asset_ref === "skill:bad-guidance");
    expect(bad?.regressed_task_count).toBe(1);
    expect(bad?.total_load_count).toBe(2);
  });
});

describe("git resolvers", () => {
  test("resolveGitBranch + resolveGitCommit return non-empty strings in this repo", () => {
    // The bench worktree IS a git repo; these MUST succeed.
    const branch = resolveGitBranch();
    const commit = resolveGitCommit();
    expect(typeof branch).toBe("string");
    expect(branch.length).toBeGreaterThan(0);
    expect(typeof commit).toBe("string");
    expect(commit.length).toBeGreaterThan(0);
  });

  test("falls back to 'unknown' outside a git repo", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bench-nogit-"));
    try {
      expect(resolveGitBranch(tmp)).toBe("unknown");
      expect(resolveGitCommit(tmp)).toBe("unknown");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ── Corpus-coverage block (#262) ───────────────────────────────────────────

describe("renderUtilityReport corpus_coverage (#262)", () => {
  test("JSON envelope always carries a corpus_coverage block, zero-valued when no tags", () => {
    const { json } = renderUtilityReport(utilSample);
    const obj = json as Record<string, unknown>;
    const cov = obj.corpus_coverage as Record<string, unknown>;
    expect(cov).toBeDefined();
    const coverage = cov.coverage as Record<string, unknown>;
    expect(coverage.totalTasks).toBe(0);
    expect(cov.by_memory_ability).toEqual([]);
    expect(cov.by_task_family).toEqual([]);
  });

  test("JSON envelope groups tasks by memory_ability when taskMetadata is plumbed", () => {
    const sample: UtilityRunReport = {
      ...utilSample,
      taskMetadata: [
        {
          id: "domain-a/task-1",
          title: "t1",
          domain: "domain-a",
          difficulty: "easy",
          stash: "minimal",
          verifier: "regex",
          budget: { tokens: 1, wallMs: 1 },
          taskDir: "/tmp",
          memoryAbility: "procedural_lookup",
          taskFamily: "domain-a/family-1",
        },
        {
          id: "domain-b/task-2",
          title: "t2",
          domain: "domain-b",
          difficulty: "easy",
          stash: "minimal",
          verifier: "regex",
          budget: { tokens: 1, wallMs: 1 },
          taskDir: "/tmp",
          memoryAbility: "procedural_lookup",
          taskFamily: "domain-b/family-2",
        },
      ],
    };
    const { json, markdown } = renderUtilityReport(sample);
    const obj = json as Record<string, unknown>;
    const cov = obj.corpus_coverage as Record<string, unknown>;
    const coverage = cov.coverage as { totalTasks: number; memoryAbilityCounts: Record<string, number> };
    expect(coverage.totalTasks).toBe(2);
    expect(coverage.memoryAbilityCounts.procedural_lookup).toBe(2);
    expect(coverage.memoryAbilityCounts.abstention).toBe(0);
    const byAbility = cov.by_memory_ability as Array<Record<string, unknown>>;
    expect(byAbility).toHaveLength(1);
    expect(byAbility[0]?.category).toBe("procedural_lookup");
    expect(byAbility[0]?.task_count).toBe(2);
    expect(markdown).toContain("## Corpus coverage");
    expect(markdown).toContain("procedural_lookup");
  });

  test("markdown corpus-coverage section is omitted when no tasks carry memory_ability", () => {
    const { markdown } = renderUtilityReport(utilSample);
    expect(markdown).not.toContain("## Corpus coverage");
  });
});

// ── Workflow compliance (#257) ─────────────────────────────────────────────

describe("renderUtilityReport workflow compliance (#257)", () => {
  function makeCheck(overrides: Partial<import("./workflow-evaluator").WorkflowCheckResult> = {}) {
    const base: import("./workflow-evaluator").WorkflowCheckResult = {
      schemaVersion: 1,
      workflowId: "wf-1",
      taskId: "domain-a/task-1",
      arm: "akm",
      seed: 0,
      status: "pass",
      score: 1,
      requiredPassed: 3,
      requiredTotal: 3,
      violations: [],
      evidence: {
        matchedEvents: 3,
        feedbackRecorded: true,
        goldAssetLoaded: true,
        traceTruncated: false,
      },
    };
    return { ...base, ...overrides };
  }

  test("emits an empty workflow object and skips the markdown section when no checks were collected", () => {
    const { json, markdown } = renderUtilityReport(utilSample);
    const obj = json as Record<string, unknown>;
    const wf = obj.workflow as Record<string, unknown>;
    expect(wf).toBeDefined();
    expect(wf.total_checks).toBe(0);
    expect(wf.applicable_checks).toBe(0);
    expect(wf.overall_compliance).toBe(0);
    expect(wf.violation_count).toBe(0);
    expect(wf.by_workflow).toEqual({});
    expect(wf.top_violations).toEqual([]);
    expect(wf.cross_tab).toEqual([]);
    expect(markdown).not.toContain("## Workflow compliance");
  });

  test("aggregates pass/partial/fail counts and surfaces top violations with evidence", () => {
    const checks: import("./workflow-evaluator").WorkflowCheckResult[] = [
      makeCheck({
        workflowId: "wf-1",
        taskId: "domain-a/task-1",
        seed: 0,
        status: "pass",
        score: 1,
      }),
      makeCheck({
        workflowId: "wf-1",
        taskId: "domain-a/task-1",
        seed: 1,
        status: "partial",
        score: 0.5,
        requiredPassed: 1,
        requiredTotal: 2,
        violations: [
          { code: "missing_required_event", message: "expected akm_search", expected: "akm_search x1", observed: "0" },
        ],
      }),
      makeCheck({
        workflowId: "wf-2",
        taskId: "domain-b/task-2",
        seed: 0,
        status: "fail",
        score: 0,
        requiredPassed: 0,
        requiredTotal: 1,
        violations: [
          { code: "missing_required_event", message: "expected akm_search again", observed: "0" },
          { code: "wrong_feedback_polarity", message: "negative expected", expected: "negative" },
        ],
      }),
    ];
    // Tag task outcomes so the cross-tab populates pass/fail rows.
    checks[0].taskOutcome = "pass";
    checks[1].taskOutcome = "pass";
    checks[2].taskOutcome = "fail";

    const sample: UtilityRunReport = { ...utilSample, workflowChecks: checks };
    const { json, markdown } = renderUtilityReport(sample);
    const obj = json as Record<string, unknown>;
    const wf = obj.workflow as Record<string, unknown>;
    expect(wf.total_checks).toBe(3);
    expect(wf.applicable_checks).toBe(3);
    expect(wf.strict_pass_rate).toBeCloseTo(1 / 3);
    expect(wf.partial_pass_rate).toBeCloseTo(1 / 3);
    expect(wf.fail_rate).toBeCloseTo(1 / 3);
    expect(wf.violation_count).toBe(3);
    // overall_compliance is mean(score): (1 + 0.5 + 0) / 3 ≈ 0.5
    expect(wf.overall_compliance).toBeCloseTo(0.5);

    const byWorkflow = wf.by_workflow as Record<string, Record<string, unknown>>;
    expect(byWorkflow["wf-1"]).toBeDefined();
    expect(byWorkflow["wf-1"].count).toBe(2);
    expect(byWorkflow["wf-1"].pass_rate).toBeCloseTo(0.5);
    expect(byWorkflow["wf-1"].partial_rate).toBeCloseTo(0.5);
    expect(byWorkflow["wf-2"].count).toBe(1);
    expect(byWorkflow["wf-2"].fail_rate).toBeCloseTo(1);

    const topVio = wf.top_violations as Array<Record<string, unknown>>;
    // missing_required_event appears twice → ranked first
    expect(topVio[0]?.code).toBe("missing_required_event");
    expect(topVio[0]?.count).toBe(2);
    const evidence = topVio[0]?.evidence as Array<Record<string, unknown>>;
    expect(evidence.length).toBeGreaterThan(0);
    // Evidence pointers identify (task, seed, workflow_id).
    expect(evidence[0]?.task_id).toBeDefined();
    expect(evidence[0]?.seed).toBeDefined();
    expect(evidence[0]?.workflow_id).toBeDefined();

    const crossTab = wf.cross_tab as Array<Record<string, unknown>>;
    const passRow = crossTab.find((r) => r.task_outcome === "pass");
    const failRow = crossTab.find((r) => r.task_outcome === "fail");
    expect(passRow).toBeDefined();
    expect(failRow).toBeDefined();
    // task pass run with pass + partial workflow checks → worst-status reduction = "partial"
    expect(passRow?.partial).toBe(1);
    // task fail run with fail workflow check → fail bucket
    expect(failRow?.fail).toBe(1);

    expect(markdown).toContain("## Workflow compliance");
    expect(markdown).toContain("overall_compliance=0.50");
    expect(markdown).toContain("### By workflow");
    expect(markdown).toContain("wf-1");
    expect(markdown).toContain("wf-2");
    expect(markdown).toContain("### Top violations");
    expect(markdown).toContain("missing_required_event");
    expect(markdown).toContain("### Violation evidence");
    expect(markdown).toContain("### Task outcome × workflow outcome");
  });

  test("not_applicable checks are excluded from rate denominators but show up in by_workflow.count", () => {
    const checks: import("./workflow-evaluator").WorkflowCheckResult[] = [
      makeCheck({ workflowId: "wf-applies", status: "pass", score: 1 }),
      makeCheck({ workflowId: "wf-skips", status: "not_applicable", score: 0 }),
    ];
    const sample: UtilityRunReport = { ...utilSample, workflowChecks: checks };
    const { json, markdown } = renderUtilityReport(sample);
    const obj = json as Record<string, unknown>;
    const wf = obj.workflow as Record<string, unknown>;
    expect(wf.total_checks).toBe(2);
    expect(wf.applicable_checks).toBe(1);
    expect(wf.strict_pass_rate).toBeCloseTo(1);
    const byWorkflow = wf.by_workflow as Record<string, Record<string, unknown>>;
    expect(byWorkflow["wf-skips"].count).toBe(1);
    expect(byWorkflow["wf-skips"].pass_rate).toBe(0);
    // Markdown still emits the section because at least one check is applicable.
    expect(markdown).toContain("## Workflow compliance");
  });

  test("when every check is not_applicable, markdown surfaces the loaded-but-no-match sentence", () => {
    const checks: import("./workflow-evaluator").WorkflowCheckResult[] = [
      makeCheck({ workflowId: "wf-a", status: "not_applicable", score: 0 }),
      makeCheck({ workflowId: "wf-b", status: "not_applicable", score: 0 }),
    ];
    const sample: UtilityRunReport = { ...utilSample, workflowChecks: checks };
    const { json, markdown } = renderUtilityReport(sample);
    const obj = json as Record<string, unknown>;
    const wf = obj.workflow as Record<string, unknown>;
    expect(wf.total_checks).toBe(2);
    expect(wf.applicable_checks).toBe(0);
    expect(markdown).toContain("## Workflow compliance");
    expect(markdown).toContain("No workflow specs applied");
  });

  test("harness_error checks are bucketed as fail and counted against compliance", () => {
    const checks: import("./workflow-evaluator").WorkflowCheckResult[] = [
      makeCheck({ workflowId: "wf-1", status: "harness_error", score: 0 }),
    ];
    const sample: UtilityRunReport = { ...utilSample, workflowChecks: checks };
    const { json } = renderUtilityReport(sample);
    const obj = json as Record<string, unknown>;
    const wf = obj.workflow as Record<string, unknown>;
    expect(wf.applicable_checks).toBe(1);
    expect(wf.fail_rate).toBeCloseTo(1);
  });

  test("multiple specs across multiple tasks aggregate per-spec deterministically", () => {
    const checks: import("./workflow-evaluator").WorkflowCheckResult[] = [
      makeCheck({ workflowId: "wf-a", taskId: "t1", seed: 0, status: "pass", score: 1 }),
      makeCheck({
        workflowId: "wf-a",
        taskId: "t1",
        seed: 1,
        status: "fail",
        score: 0,
        violations: [{ code: "forbidden_event", message: "x" }],
      }),
      makeCheck({
        workflowId: "wf-b",
        taskId: "t2",
        seed: 0,
        status: "partial",
        score: 0.5,
        violations: [{ code: "wrong_order", message: "y" }],
      }),
    ];
    const sample: UtilityRunReport = { ...utilSample, workflowChecks: checks };
    const { markdown } = renderUtilityReport(sample);
    // Specs are listed alphabetically.
    const aIdx = markdown.indexOf("| wf-a ");
    const bIdx = markdown.indexOf("| wf-b ");
    expect(aIdx).toBeGreaterThan(0);
    expect(bIdx).toBeGreaterThan(aIdx);
  });

  test("markdown is byte-stable across reruns for the workflow section", () => {
    const checks: import("./workflow-evaluator").WorkflowCheckResult[] = [
      makeCheck({
        workflowId: "wf-1",
        status: "partial",
        score: 0.5,
        violations: [{ code: "missing_required_event", message: "x" }],
      }),
    ];
    const sample: UtilityRunReport = { ...utilSample, workflowChecks: checks };
    const a = renderUtilityReport(sample).markdown;
    const b = renderUtilityReport(sample).markdown;
    expect(a).toBe(b);
  });

  // ── Reliability sub-block (#258) ────────────────────────────────────────

  test("workflow.reliability is present and zeroed when no checks were collected", () => {
    const { json } = renderUtilityReport(utilSample);
    const obj = json as Record<string, unknown>;
    const wf = obj.workflow as Record<string, unknown>;
    const reliability = wf.reliability as Record<string, unknown>;
    expect(reliability).toBeDefined();
    expect(reliability.by_workflow).toEqual({});
    const corpus = reliability.corpus as Record<string, unknown>;
    expect(corpus.pass_at_k).toBe(0);
    expect(corpus.pass_all_k).toBe(0);
    expect(corpus.groups).toBe(0);
  });

  test("workflow.reliability surfaces pass@k and pass^k per workflow + corpus", () => {
    // wf-flaky: t1 has 1 pass + 1 fail (anyPass=1, allPass=0)
    // wf-solid: t2 has 2 pass (anyPass=1, allPass=1)
    const checks: import("./workflow-evaluator").WorkflowCheckResult[] = [
      makeCheck({ workflowId: "wf-flaky", taskId: "t1", seed: 0, status: "pass", score: 1 }),
      makeCheck({ workflowId: "wf-flaky", taskId: "t1", seed: 1, status: "fail", score: 0 }),
      makeCheck({ workflowId: "wf-solid", taskId: "t2", seed: 0, status: "pass", score: 1 }),
      makeCheck({ workflowId: "wf-solid", taskId: "t2", seed: 1, status: "pass", score: 1 }),
    ];
    const sample: UtilityRunReport = { ...utilSample, workflowChecks: checks };
    const { json, markdown } = renderUtilityReport(sample);
    const obj = json as Record<string, unknown>;
    const wf = obj.workflow as Record<string, unknown>;
    const reliability = wf.reliability as Record<string, unknown>;
    const byWorkflow = reliability.by_workflow as Record<string, Record<string, unknown>>;
    expect(byWorkflow["wf-flaky"].pass_at_k).toBeCloseTo(1);
    expect(byWorkflow["wf-flaky"].pass_all_k).toBe(0);
    expect(byWorkflow["wf-solid"].pass_at_k).toBe(1);
    expect(byWorkflow["wf-solid"].pass_all_k).toBe(1);
    const corpus = reliability.corpus as Record<string, unknown>;
    expect(corpus.groups).toBe(2);
    expect(corpus.pass_at_k).toBeCloseTo(1);
    expect(corpus.pass_all_k).toBeCloseTo(0.5);

    expect(markdown).toContain("### Reliability (pass@k / pass^k)");
    expect(markdown).toContain("| wf-flaky |");
    expect(markdown).toContain("| wf-solid |");
    expect(markdown).toContain("Inconsistent workflows");
    // wf-flaky should be flagged: pass@k=1 vs pass^k=0 (gap=1).
    expect(markdown).toContain("`wf-flaky`");
    // wf-solid should NOT be in the inconsistent list.
    const inconsistentSection = markdown.split("Inconsistent workflows")[1] ?? "";
    expect(inconsistentSection).not.toContain("`wf-solid`");
  });

  test("reliability is omitted from markdown when no group is applicable", () => {
    const checks: import("./workflow-evaluator").WorkflowCheckResult[] = [
      makeCheck({ workflowId: "wf-skips", status: "not_applicable", score: 0 }),
    ];
    const sample: UtilityRunReport = { ...utilSample, workflowChecks: checks };
    const { markdown } = renderUtilityReport(sample);
    expect(markdown).not.toContain("### Reliability (pass@k / pass^k)");
  });

  test("reliability handles all-pass corpus without flagging inconsistency", () => {
    const checks: import("./workflow-evaluator").WorkflowCheckResult[] = [
      makeCheck({ workflowId: "wf-1", taskId: "t1", seed: 0, status: "pass", score: 1 }),
      makeCheck({ workflowId: "wf-1", taskId: "t1", seed: 1, status: "pass", score: 1 }),
    ];
    const sample: UtilityRunReport = { ...utilSample, workflowChecks: checks };
    const { json, markdown } = renderUtilityReport(sample);
    const obj = json as Record<string, unknown>;
    const wf = obj.workflow as Record<string, unknown>;
    const reliability = wf.reliability as Record<string, unknown>;
    const corpus = reliability.corpus as Record<string, unknown>;
    expect(corpus.pass_at_k).toBe(1);
    expect(corpus.pass_all_k).toBe(1);
    expect(markdown).toContain("### Reliability (pass@k / pass^k)");
    expect(markdown).not.toContain("Inconsistent workflows");
  });

  test("reliability handles none-pass corpus (zeroed but section still rendered)", () => {
    const checks: import("./workflow-evaluator").WorkflowCheckResult[] = [
      makeCheck({ workflowId: "wf-1", taskId: "t1", seed: 0, status: "fail", score: 0 }),
      makeCheck({ workflowId: "wf-1", taskId: "t1", seed: 1, status: "fail", score: 0 }),
    ];
    const sample: UtilityRunReport = { ...utilSample, workflowChecks: checks };
    const { json, markdown } = renderUtilityReport(sample);
    const obj = json as Record<string, unknown>;
    const wf = obj.workflow as Record<string, unknown>;
    const reliability = wf.reliability as Record<string, unknown>;
    const corpus = reliability.corpus as Record<string, unknown>;
    expect(corpus.pass_at_k).toBe(0);
    expect(corpus.pass_all_k).toBe(0);
    expect(corpus.groups).toBe(1);
    expect(markdown).toContain("### Reliability (pass@k / pass^k)");
    // pass@k=0 fails the floor → no inconsistency callout.
    expect(markdown).not.toContain("Inconsistent workflows");
  });

  test("reliability tolerates mixed partial/fail (partial counts as non-pass for pass^k)", () => {
    const checks: import("./workflow-evaluator").WorkflowCheckResult[] = [
      makeCheck({ workflowId: "wf-1", taskId: "t1", seed: 0, status: "pass", score: 1 }),
      makeCheck({ workflowId: "wf-1", taskId: "t1", seed: 1, status: "partial", score: 0.5 }),
      makeCheck({ workflowId: "wf-1", taskId: "t1", seed: 2, status: "fail", score: 0 }),
    ];
    const sample: UtilityRunReport = { ...utilSample, workflowChecks: checks };
    const { json } = renderUtilityReport(sample);
    const obj = json as Record<string, unknown>;
    const wf = obj.workflow as Record<string, unknown>;
    const reliability = wf.reliability as Record<string, unknown>;
    const byWorkflow = reliability.by_workflow as Record<string, Record<string, unknown>>;
    expect(byWorkflow["wf-1"].pass_at_k).toBe(1); // 1 of 1 task has any pass
    expect(byWorkflow["wf-1"].pass_all_k).toBe(0); // not all 3 seeds are pass
    expect(byWorkflow["wf-1"].k).toBe(3);
  });
});
// ── AKM overhead block (#263) ──────────────────────────────────────────────

describe("akm_overhead block (#263)", () => {
  function fakeRun(overrides: Partial<import("./driver").RunResult>): import("./driver").RunResult {
    return {
      schemaVersion: 1,
      taskId: "t",
      arm: "akm",
      seed: 0,
      model: "m",
      outcome: "pass",
      tokens: { input: 0, output: 0 },
      tokenMeasurement: "parsed",
      wallclockMs: 0,
      trajectory: { correctAssetLoaded: null, feedbackRecorded: null },
      events: [],
      verifierStdout: "",
      verifierExitCode: 0,
      assetsLoaded: [],
      ...overrides,
    };
  }

  test("emits empty/zero envelope when no akm runs are attached", () => {
    const { json, markdown } = renderUtilityReport(utilSample);
    const obj = json as Record<string, unknown>;
    expect("akm_overhead" in obj).toBe(true);
    const ov = obj.akm_overhead as Record<string, unknown>;
    expect((ov.aggregate as { total_runs: number }).total_runs).toBe(0);
    expect((ov.aggregate as { tool_calls_per_success: number | null }).tool_calls_per_success).toBeNull();
    expect((ov.aggregate as { cost_per_success: number | null }).cost_per_success).toBeNull();
    expect(ov.per_run).toEqual([]);
    // Markdown section is gated on having akm runs to summarise.
    expect(markdown).not.toContain("## AKM overhead");
  });

  test("populates per-run rows + aggregate from akmRuns + taskMetadata", () => {
    const akmRuns = [
      fakeRun({
        taskId: "domain-a/task-1",
        seed: 0,
        outcome: "pass",
        tokens: { input: 100, output: 50 },
        events: [
          {
            schemaVersion: 1,
            id: 0,
            ts: "2026-04-27T10:00:00.000Z",
            eventType: "search",
          },
          {
            schemaVersion: 1,
            id: 1,
            ts: "2026-04-27T10:00:00.500Z",
            eventType: "show",
            ref: "skill:gold",
          },
        ],
      }),
    ];
    const taskMetadata = [
      {
        id: "domain-a/task-1",
        title: "T1",
        domain: "domain-a",
        difficulty: "easy" as const,
        stash: "fixture-a",
        verifier: "regex" as const,
        budget: { tokens: 1000, wallMs: 1000 },
        taskDir: "/tmp/ignored",
        goldRef: "skill:gold",
        expectedTransferFrom: [],
      },
    ];
    const sampleWithRuns: UtilityRunReport = { ...utilSample, akmRuns, taskMetadata };
    const { json, markdown } = renderUtilityReport(sampleWithRuns);
    const obj = json as Record<string, unknown>;
    const ov = obj.akm_overhead as Record<string, unknown>;
    const perRun = ov.per_run as Array<Record<string, unknown>>;
    expect(perRun).toHaveLength(1);
    expect(perRun[0].search_count).toBe(1);
    expect(perRun[0].show_count).toBe(1);
    expect(perRun[0].assets_loaded_count).toBe(1);
    expect(perRun[0].irrelevant_assets_loaded_count).toBe(0);
    expect(perRun[0].time_to_first_correct_asset_ms).toBe(500);
    expect(perRun[0].context_bytes_loaded).toBeNull();
    expect(perRun[0].asset_bytes_loaded).toBeNull();

    const agg = ov.aggregate as Record<string, unknown>;
    expect(agg.total_runs).toBe(1);
    expect(agg.passing_runs).toBe(1);
    expect(agg.tool_calls_per_success).toBe(2);
    expect(agg.cost_per_success).toBe(150);
    expect(agg.mean_context_bytes_loaded).toBeNull();

    expect(markdown).toContain("## AKM overhead");
    expect(markdown).toContain("tool_calls_per_success");
    expect(markdown).toContain("context_bytes_loaded: n/a");
  });

  test("excessive AKM calls produce high tool_calls_per_success in markdown", () => {
    const akmRuns = [
      fakeRun({
        taskId: "domain-a/task-1",
        outcome: "fail",
        events: [
          { schemaVersion: 1, id: 0, ts: "2026-04-27T10:00:00.000Z", eventType: "search" },
          { schemaVersion: 1, id: 1, ts: "2026-04-27T10:00:00.001Z", eventType: "search" },
          { schemaVersion: 1, id: 2, ts: "2026-04-27T10:00:00.002Z", eventType: "show", ref: "skill:wrong" },
        ],
      }),
      fakeRun({
        taskId: "domain-a/task-1",
        seed: 1,
        outcome: "pass",
        tokens: { input: 1, output: 1 },
        events: [{ schemaVersion: 1, id: 0, ts: "2026-04-27T10:00:00.000Z", eventType: "search" }],
      }),
    ];
    const sampleWithRuns: UtilityRunReport = { ...utilSample, akmRuns };
    const { json } = renderUtilityReport(sampleWithRuns);
    const obj = json as Record<string, unknown>;
    const ov = obj.akm_overhead as Record<string, unknown>;
    const agg = ov.aggregate as Record<string, unknown>;
    expect(agg.total_tool_calls).toBe(4);
    expect(agg.passing_runs).toBe(1);
    expect(agg.tool_calls_per_success).toBe(4);
  });
});
