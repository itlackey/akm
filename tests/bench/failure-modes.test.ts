/**
 * Unit tests for the §6.6 failure-mode taxonomy classifier.
 *
 * The classifier is a pure function over (TaskMetadata, RunResult). We
 * exercise each of the seven labels with a synthetic event stream / verifier
 * stdout, verify priority/tie-breaking, and assert the report renderer
 * orders bins by descending count.
 */

import { describe, expect, test } from "bun:test";

import type { EventEnvelope } from "../../src/core/events";
import type { TaskMetadata } from "./corpus";
import type { RunResult } from "./driver";
import { aggregateFailureModes, classifyFailureMode, type FailureMode } from "./metrics";
import { renderFailureModeBreakdown, type UtilityRunReport } from "./report";

function fakeTask(overrides: Partial<TaskMetadata> = {}): TaskMetadata {
  return {
    id: "domain-a/task-1",
    title: "fake",
    domain: "domain-a",
    difficulty: "easy",
    stash: "fake-stash",
    verifier: "regex",
    budget: { tokens: 1000, wallMs: 60000 },
    taskDir: "/tmp/fake",
    goldRef: "skill:docker-homelab",
    ...overrides,
  };
}

function fakeRun(overrides: Partial<RunResult> = {}): RunResult {
  return {
    schemaVersion: 1,
    taskId: "domain-a/task-1",
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
    assetsLoaded: [],
    ...overrides,
  };
}

describe("classifyFailureMode — non-failed runs", () => {
  test("returns null when outcome is 'pass'", () => {
    const out = classifyFailureMode(fakeTask(), fakeRun({ outcome: "pass" }));
    expect(out).toBeNull();
  });
  test("returns null when outcome is 'budget_exceeded'", () => {
    const out = classifyFailureMode(fakeTask(), fakeRun({ outcome: "budget_exceeded" }));
    expect(out).toBeNull();
  });
  test("returns null when outcome is 'harness_error'", () => {
    const out = classifyFailureMode(fakeTask(), fakeRun({ outcome: "harness_error" }));
    expect(out).toBeNull();
  });
});

describe("classifyFailureMode — seven labels", () => {
  test("no_search: empty trace returns no_search", () => {
    const out = classifyFailureMode(fakeTask(), fakeRun({ verifierStdout: "" }));
    expect(out).toBe("no_search");
  });

  test("no_search: trace mentions show but never search", () => {
    const out = classifyFailureMode(
      fakeTask(),
      fakeRun({ verifierStdout: "akm show skill:docker-homelab\nresult: ok" }),
    );
    expect(out).toBe("no_search");
  });

  test("search_no_gold: search ran, gold ref absent from results", () => {
    const trace = [
      "$ akm search homelab",
      "1. skill:foo",
      "2. skill:bar",
      "3. skill:baz",
      "verifier: missing required output",
    ].join("\n");
    const out = classifyFailureMode(fakeTask(), fakeRun({ verifierStdout: trace }));
    expect(out).toBe("search_no_gold");
  });

  test("search_low_rank: gold ref appears at rank 7 in numbered list", () => {
    const lines = ["$ akm search homelab"];
    for (let i = 1; i <= 6; i += 1) lines.push(`${i}. skill:filler-${i}`);
    lines.push("7. skill:docker-homelab");
    const out = classifyFailureMode(fakeTask(), fakeRun({ verifierStdout: lines.join("\n") }));
    expect(out).toBe("search_low_rank");
  });

  test("loaded_wrong: agent showed a non-gold ref and never loaded gold", () => {
    const trace = [
      "$ akm search homelab",
      "1. skill:docker-homelab",
      "2. skill:az-cli",
      "$ akm show skill:az-cli",
      "(content of az-cli)",
      "verifier: action wrong",
    ].join("\n");
    const out = classifyFailureMode(fakeTask(), fakeRun({ verifierStdout: trace }));
    expect(out).toBe("loaded_wrong");
  });

  test("loaded_ignored: gold loaded but verifier flags ignored guidance", () => {
    const trace = [
      "$ akm search homelab",
      "1. skill:docker-homelab",
      "$ akm show skill:docker-homelab",
      "(content of docker-homelab)",
      "verifier: agent did not follow loaded asset",
    ].join("\n");
    const out = classifyFailureMode(fakeTask(), fakeRun({ verifierStdout: trace }));
    expect(out).toBe("loaded_ignored");
  });

  test("followed_wrong: gold loaded, no ignored marker, verifier still failed", () => {
    const trace = [
      "$ akm search homelab",
      "1. skill:docker-homelab",
      "$ akm show skill:docker-homelab",
      "(content of docker-homelab)",
      "verifier: pattern mismatch — expected 'X' got 'Y'",
    ].join("\n");
    const out = classifyFailureMode(fakeTask(), fakeRun({ verifierStdout: trace }));
    expect(out).toBe("followed_wrong");
  });

  test("unrelated_bug: gold ref in search results, agent didn't load anything", () => {
    // Search ran (so not no_search), gold present at rank 1 (so not search_no_gold,
    // not search_low_rank), no `akm show` calls at all (so not loaded_wrong,
    // not loaded_ignored, not followed_wrong) → unrelated_bug.
    const trace = ["$ akm search homelab", "1. skill:docker-homelab", "verifier: missing config"].join("\n");
    const out = classifyFailureMode(fakeTask(), fakeRun({ verifierStdout: trace }));
    expect(out).toBe("unrelated_bug");
  });

  test("unrelated_bug: task has no goldRef and search ran", () => {
    const trace = "$ akm search foo\nresults: nothing relevant";
    const out = classifyFailureMode(fakeTask({ goldRef: undefined }), fakeRun({ verifierStdout: trace }));
    expect(out).toBe("unrelated_bug");
  });
});

describe("classifyFailureMode — tie-breaking and priority", () => {
  test("no_search beats search_no_gold when both could apply (no search call)", () => {
    // No `akm search` text, but gold is also missing. The first rule wins.
    const out = classifyFailureMode(fakeTask(), fakeRun({ verifierStdout: "verifier: nope" }));
    expect(out).toBe("no_search");
  });

  test("search_no_gold beats search_low_rank when gold absent", () => {
    const trace = ["$ akm search homelab", "1. skill:foo", "2. skill:bar"].join("\n");
    const out = classifyFailureMode(fakeTask(), fakeRun({ verifierStdout: trace }));
    expect(out).toBe("search_no_gold");
  });

  test("search_low_rank beats loaded_wrong when gold is present at rank 7 even after wrong show", () => {
    const lines = ["$ akm search homelab"];
    for (let i = 1; i <= 6; i += 1) lines.push(`${i}. skill:filler-${i}`);
    lines.push("7. skill:docker-homelab");
    lines.push("$ akm show skill:az-cli");
    lines.push("verifier: failed");
    const out = classifyFailureMode(fakeTask(), fakeRun({ verifierStdout: lines.join("\n") }));
    expect(out).toBe("search_low_rank");
  });

  test("loaded_wrong beats followed_wrong when gold never loaded but other ref shown", () => {
    const trace = [
      "$ akm search homelab",
      "1. skill:docker-homelab",
      "$ akm show skill:az-cli",
      "verifier: agent did not follow loaded asset",
    ].join("\n");
    // Note `did not follow loaded asset` would otherwise trip loaded_ignored,
    // but loaded_wrong's "gold never loaded" precondition wins first.
    const out = classifyFailureMode(fakeTask(), fakeRun({ verifierStdout: trace }));
    expect(out).toBe("loaded_wrong");
  });

  test("loaded_ignored beats followed_wrong when verifier flags ignored", () => {
    const trace = [
      "$ akm search homelab",
      "1. skill:docker-homelab",
      "$ akm show skill:docker-homelab",
      "verifier: contradicts loaded asset; agent ignored it",
    ].join("\n");
    const out = classifyFailureMode(fakeTask(), fakeRun({ verifierStdout: trace }));
    expect(out).toBe("loaded_ignored");
  });
});

describe("classifyFailureMode — input variants", () => {
  test("event-stream-only search invocation counts as a search call", () => {
    const event: EventEnvelope = {
      schemaVersion: 1,
      id: 0,
      ts: "2026-04-27T00:00:00Z",
      eventType: "search_invoked",
    };
    // No CLI marker in stdout, but the event makes hasAkmSearch return true.
    // Gold ref is absent from any result list → search_no_gold.
    const out = classifyFailureMode(fakeTask(), fakeRun({ events: [event], verifierStdout: "verifier: nope" }));
    expect(out).toBe("search_no_gold");
  });

  test("tool-call JSON form for show counts as loading the gold ref", () => {
    const trace = [
      "$ akm search homelab",
      '{"results":["skill:docker-homelab"]}',
      '{"command":"akm","args":["show","skill:docker-homelab"]}',
      "verifier: pattern mismatch",
    ].join("\n");
    const out = classifyFailureMode(fakeTask(), fakeRun({ verifierStdout: trace }));
    expect(out).toBe("followed_wrong");
  });

  test("origin-prefixed gold ref also matches", () => {
    const task = fakeTask({ goldRef: "skill:docker-homelab" });
    const trace = [
      "$ akm search homelab",
      "1. team//skill:docker-homelab",
      "$ akm show team//skill:docker-homelab",
      "verifier: pattern mismatch",
    ].join("\n");
    const out = classifyFailureMode(task, fakeRun({ verifierStdout: trace }));
    expect(out).toBe("followed_wrong");
  });
});

describe("classifyFailureMode — purity", () => {
  test("same input twice yields the same label", () => {
    const task = fakeTask();
    const run = fakeRun({
      verifierStdout: ["$ akm search homelab", "1. skill:docker-homelab", "verifier: missing config"].join("\n"),
    });
    const a = classifyFailureMode(task, run);
    const b = classifyFailureMode(task, run);
    expect(a).toBe(b);
  });

  test("classifier does not mutate its inputs", () => {
    const task = fakeTask();
    const run = fakeRun({ verifierStdout: "$ akm search foo\n1. skill:docker-homelab" });
    const taskJson = JSON.stringify(task);
    const runJson = JSON.stringify(run);
    classifyFailureMode(task, run);
    expect(JSON.stringify(task)).toBe(taskJson);
    expect(JSON.stringify(run)).toBe(runJson);
  });
});

describe("aggregateFailureModes", () => {
  test("counts per label and per task", () => {
    const agg = aggregateFailureModes([
      { taskId: "t1", mode: "no_search" },
      { taskId: "t1", mode: "no_search" },
      { taskId: "t1", mode: "followed_wrong" },
      { taskId: "t2", mode: "no_search" },
    ]);
    expect(agg.byLabel.no_search).toBe(3);
    expect(agg.byLabel.followed_wrong).toBe(1);
    expect(agg.byTask.t1?.no_search).toBe(2);
    expect(agg.byTask.t1?.followed_wrong).toBe(1);
    expect(agg.byTask.t2?.no_search).toBe(1);
  });

  test("empty input produces empty aggregate", () => {
    const agg = aggregateFailureModes([]);
    expect(agg.byLabel).toEqual({});
    expect(agg.byTask).toEqual({});
  });
});

describe("renderFailureModeBreakdown", () => {
  function makeReport(byLabel: Partial<Record<FailureMode, number>>): UtilityRunReport {
    return {
      timestamp: "2026-04-27T00:00:00Z",
      branch: "x",
      commit: "y",
      model: "m",
      corpus: { domains: 1, tasks: 1, slice: "all", seedsPerArm: 5 },
      aggregateNoakm: { passRate: 0, tokensPerPass: null, wallclockMs: 0 },
      aggregateAkm: { passRate: 0, tokensPerPass: null, wallclockMs: 0 },
      aggregateDelta: { passRate: 0, tokensPerPass: null, wallclockMs: 0 },
      trajectoryAkm: { correctAssetLoaded: null, feedbackRecorded: 0 },
      failureModes: { byLabel, byTask: {} },
      tasks: [],
      warnings: [],
    };
  }

  test("orders bins by descending count", () => {
    const md = renderFailureModeBreakdown(makeReport({ no_search: 3, followed_wrong: 5, search_no_gold: 1 }));
    const lines = md.split("\n").filter((l) => l.startsWith("- "));
    expect(lines[0]).toContain("followed_wrong");
    expect(lines[0]).toContain("5");
    expect(lines[1]).toContain("no_search");
    expect(lines[1]).toContain("3");
    expect(lines[2]).toContain("search_no_gold");
    expect(lines[2]).toContain("1");
  });

  test("ties broken alphabetically by label", () => {
    const md = renderFailureModeBreakdown(makeReport({ followed_wrong: 2, no_search: 2 }));
    const lines = md.split("\n").filter((l) => l.startsWith("- "));
    expect(lines[0]).toContain("followed_wrong");
    expect(lines[1]).toContain("no_search");
  });

  test("includes percent of failed runs", () => {
    const md = renderFailureModeBreakdown(makeReport({ no_search: 1, followed_wrong: 3 }));
    // 3/4 = 75.0%, 1/4 = 25.0%
    expect(md).toContain("75.0%");
    expect(md).toContain("25.0%");
  });

  test("returns empty string when no failures", () => {
    const md = renderFailureModeBreakdown(makeReport({}));
    expect(md).toBe("");
  });

  test("section header present when bins exist", () => {
    const md = renderFailureModeBreakdown(makeReport({ no_search: 1 }));
    expect(md).toContain("## Failure modes");
  });
});
