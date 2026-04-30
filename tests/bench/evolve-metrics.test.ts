/**
 * Unit tests for `computeLessonMetrics` (#264).
 *
 * The four required scenarios are covered explicitly:
 *   1. accepted lesson reused successfully on an eval task,
 *   2. accepted lesson never reused (`first_reused_on === null`),
 *   3. rejected proposal — surfaced as a lesson row but `accepted: false`,
 *   4. accepted lesson causing regression on an eval task that previously
 *      passed (negative_transfer_count === 1).
 *
 * Plus a fifth test for the leakage-risk classifier so the verifier-source
 * 4+-token rule has a direct unit test.
 */

import { describe, expect, test } from "bun:test";

import type { RunResult } from "./driver";
import type { FeedbackLogEntry } from "./evolve";
import { classifyLeakageRisk, computeLessonMetrics } from "./evolve-metrics";
import type { ProposalLogEntry } from "./metrics";

function fakeRun(overrides: Partial<RunResult>): RunResult {
  return {
    schemaVersion: 1,
    taskId: "t",
    arm: "akm",
    seed: 0,
    model: "m",
    outcome: "pass",
    tokens: { input: 0, output: 0 },
    wallclockMs: 0,
    trajectory: { correctAssetLoaded: null, feedbackRecorded: null },
    events: [],
    verifierStdout: "",
    verifierExitCode: 0,
    assetsLoaded: [],
    ...overrides,
  };
}

describe("computeLessonMetrics", () => {
  test("accepted lesson reused successfully on an eval task", () => {
    const proposalLog: ProposalLogEntry[] = [
      { proposalId: "p1", assetRef: "lesson:docker-healthchecks", kind: "lesson", lintPass: true, decision: "accept" },
    ];
    const feedbackLog: FeedbackLogEntry[] = [
      {
        taskId: "docker-homelab/redis-healthcheck",
        seed: 0,
        goldRef: "lesson:docker-healthchecks",
        signal: "negative",
        ok: true,
      },
    ];
    const preRuns = [
      fakeRun({ taskId: "docker-homelab/named-volume", seed: 0, outcome: "fail" }),
      fakeRun({ taskId: "docker-homelab/named-volume", seed: 1, outcome: "fail" }),
    ];
    const postRuns = [
      fakeRun({
        taskId: "docker-homelab/named-volume",
        seed: 0,
        outcome: "pass",
        assetsLoaded: ["lesson:docker-healthchecks"],
      }),
      fakeRun({
        taskId: "docker-homelab/named-volume",
        seed: 1,
        outcome: "pass",
        assetsLoaded: ["lesson:docker-healthchecks"],
      }),
    ];

    const m = computeLessonMetrics({ proposalLog, feedbackLog, preRuns, postRuns });
    expect(m.lessons_created_count).toBe(1);
    expect(m.lessons_accepted_count).toBe(1);
    expect(m.proposal_lint_pass_rate).toBe(1);
    expect(m.proposal_acceptance_rate).toBe(1);
    expect(m.lesson_reuse_rate).toBe(1);
    expect(m.lesson_reuse_success_rate).toBe(1);
    expect(m.lesson_negative_transfer_count).toBe(0);

    const lesson = m.lessons[0];
    expect(lesson?.ref).toBe("lesson:docker-healthchecks");
    expect(lesson?.accepted).toBe(true);
    expect(lesson?.source_failures).toEqual(["docker-homelab/redis-healthcheck"]);
    expect(lesson?.first_reused_on).toBe("docker-homelab/named-volume");
    expect(lesson?.reuse_count).toBe(2);
    expect(lesson?.reuse_pass_rate).toBe(1);
    expect(lesson?.negative_transfer_count).toBe(0);
    expect(lesson?.leakage_risk).toBe("low");
  });

  test("accepted lesson never reused yields first_reused_on=null and reuse_count=0", () => {
    const proposalLog: ProposalLogEntry[] = [
      { proposalId: "p1", assetRef: "lesson:lonely", kind: "lesson", lintPass: true, decision: "accept" },
    ];
    const postRuns = [fakeRun({ taskId: "task-a", seed: 0, outcome: "pass", assetsLoaded: ["skill:other"] })];

    const m = computeLessonMetrics({ proposalLog, postRuns });
    expect(m.lessons_accepted_count).toBe(1);
    expect(m.lesson_reuse_rate).toBe(0);
    expect(m.lesson_reuse_success_rate).toBe(0);
    expect(m.lesson_negative_transfer_count).toBe(0);

    const lesson = m.lessons[0];
    expect(lesson?.first_reused_on).toBeNull();
    expect(lesson?.reuse_count).toBe(0);
    expect(lesson?.reuse_pass_rate).toBe(0);
  });

  test("rejected proposal surfaces row with accepted=false and no reuse stats", () => {
    const proposalLog: ProposalLogEntry[] = [
      {
        proposalId: "p1",
        assetRef: "lesson:bad",
        kind: "lesson",
        lintPass: false,
        decision: "reject",
        rejectReason: "lint failed: empty body",
      },
    ];
    // Even if a post run happened to load the same ref, a rejected proposal
    // must NOT be credited with reuse — the lesson never reached the stash.
    const postRuns = [fakeRun({ taskId: "task-a", seed: 0, outcome: "pass", assetsLoaded: ["lesson:bad"] })];

    const m = computeLessonMetrics({ proposalLog, postRuns });
    expect(m.lessons_created_count).toBe(1);
    expect(m.lessons_accepted_count).toBe(0);
    expect(m.proposal_lint_pass_rate).toBe(0);
    expect(m.proposal_acceptance_rate).toBe(0);
    expect(m.lesson_reuse_rate).toBe(0);

    const lesson = m.lessons[0];
    expect(lesson?.accepted).toBe(false);
    expect(lesson?.lint_pass).toBe(false);
    expect(lesson?.reuse_count).toBe(0);
    expect(lesson?.first_reused_on).toBeNull();
    expect(lesson?.negative_transfer_count).toBe(0);
  });

  test("accepted lesson causing regression attributes negative_transfer_count=1", () => {
    const proposalLog: ProposalLogEntry[] = [
      { proposalId: "p1", assetRef: "lesson:overfit", kind: "lesson", lintPass: true, decision: "accept" },
    ];
    // Pre-arm: task passed. Post-arm: same (taskId, seed) failed AND loaded
    // the lesson. That counts as one negative transfer attribution.
    const preRuns = [fakeRun({ taskId: "adjacent-task", seed: 0, outcome: "pass" })];
    const postRuns = [
      fakeRun({ taskId: "adjacent-task", seed: 0, outcome: "fail", assetsLoaded: ["lesson:overfit"] }),
      // Same task, different seed — also failed with the lesson loaded; the
      // attribution dedupes by taskId so the count stays at 1.
      fakeRun({ taskId: "adjacent-task", seed: 1, outcome: "fail", assetsLoaded: ["lesson:overfit"] }),
    ];

    const m = computeLessonMetrics({ proposalLog, preRuns, postRuns });
    expect(m.lesson_negative_transfer_count).toBe(1);

    const lesson = m.lessons[0];
    expect(lesson?.negative_transfer_count).toBe(1);
    expect(lesson?.reuse_count).toBe(2);
    expect(lesson?.reuse_pass_rate).toBe(0);
  });

  test("zero-proposal log yields all zeroes with empty lessons[]", () => {
    const m = computeLessonMetrics({ proposalLog: [] });
    expect(m.lessons_created_count).toBe(0);
    expect(m.lessons_accepted_count).toBe(0);
    expect(m.proposal_lint_pass_rate).toBe(0);
    expect(m.proposal_acceptance_rate).toBe(0);
    expect(m.lesson_reuse_rate).toBe(0);
    expect(m.lesson_reuse_success_rate).toBe(0);
    expect(m.lesson_negative_transfer_count).toBe(0);
    expect(m.lessons).toEqual([]);
  });

  test("revision-kind proposals are filtered out (lessons[] only)", () => {
    const proposalLog: ProposalLogEntry[] = [
      { proposalId: "p1", assetRef: "lesson:a", kind: "lesson", lintPass: true, decision: "accept" },
      { proposalId: "p2", assetRef: "skill:b", kind: "revision", lintPass: true, decision: "accept" },
    ];
    const m = computeLessonMetrics({ proposalLog });
    expect(m.lessons.map((l) => l.ref)).toEqual(["lesson:a"]);
  });
});

describe("classifyLeakageRisk", () => {
  test("returns 'low' when body or verifier sources are missing", () => {
    expect(classifyLeakageRisk(undefined, ["some text"])).toBe("low");
    expect(classifyLeakageRisk("some text", undefined)).toBe("low");
    expect(classifyLeakageRisk("some text", [])).toBe("low");
  });

  test("returns 'high' on a verbatim 4-word phrase from the verifier", () => {
    const verifier = "assert services.redis.healthcheck.test == ['CMD', 'redis-cli', 'ping']";
    const body = "Always set services redis healthcheck test to a CMD ping.";
    expect(classifyLeakageRisk(body, [verifier])).toBe("high");
  });

  test("returns 'medium' on a 3-word overlap but no 4-word overlap", () => {
    const verifier = "alpha beta gamma delta epsilon";
    const body = "alpha beta gamma is the prefix and zeta eta theta is the suffix";
    expect(classifyLeakageRisk(body, [verifier])).toBe("medium");
  });

  test("returns 'low' when overlap is at most 2 tokens", () => {
    const verifier = "alpha beta is required";
    const body = "alpha beta gamma never appears verbatim from the verifier";
    expect(classifyLeakageRisk(body, [verifier])).toBe("low");
  });
});
