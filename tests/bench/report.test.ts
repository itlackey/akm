/**
 * Unit tests for the JSON + markdown report renderers.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PerTaskMetrics } from "./metrics";
import {
  type ReportInput,
  renderJsonReport,
  renderMarkdownSummary,
  renderUtilityReport,
  resolveGitBranch,
  resolveGitCommit,
  type UtilityRunReport,
} from "./report";

const sample: ReportInput = {
  timestamp: "2026-04-27T12:00:00Z",
  branch: "feature/akm-bench",
  commit: "deadbeef",
  model: "anthropic/claude-opus-4-7",
  track: "utility",
  arms: {
    noakm: { passRate: 0.4, tokensPerPass: 18000, wallclockMs: 41000, budgetExceeded: 0 },
    akm: { passRate: 0.7, tokensPerPass: 14000, wallclockMs: 36000, budgetExceeded: 1 },
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
