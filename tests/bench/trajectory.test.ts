/**
 * Unit tests for the trajectory parser.
 */

import { describe, expect, test } from "bun:test";

import type { EventEnvelope } from "../../src/core/events";
import type { RunResult } from "./driver";
import { computeTrajectory, VERIFIER_STDOUT_SCAN_CAP } from "./trajectory";

function fakeRun(overrides: Partial<RunResult> = {}): RunResult {
  return {
    schemaVersion: 1,
    taskId: "x",
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

function feedbackEvent(): EventEnvelope {
  return {
    schemaVersion: 1,
    id: 0,
    ts: "2026-04-27T00:00:00.000Z",
    eventType: "feedback",
    ref: "skill:foo",
  };
}

describe("computeTrajectory.correctAssetLoaded", () => {
  test("null when goldRef is missing on the task", () => {
    const traj = computeTrajectory({}, fakeRun({ verifierStdout: "akm show skill:irrelevant" }));
    expect(traj.correctAssetLoaded).toBeNull();
  });

  test("true when verifierStdout contains `akm show <goldRef>`", () => {
    const traj = computeTrajectory(
      { goldRef: "skill:docker-homelab" },
      fakeRun({
        verifierStdout: "tool: akm show skill:docker-homelab\nresult: ok\n",
      }),
    );
    expect(traj.correctAssetLoaded).toBe(true);
  });

  test("true when tool-call JSON form contains the ref", () => {
    const traj = computeTrajectory(
      { goldRef: "skill:docker-homelab" },
      fakeRun({
        verifierStdout: '{"command":"akm","args":["show","skill:docker-homelab"]}',
      }),
    );
    expect(traj.correctAssetLoaded).toBe(true);
  });

  test("false when verifierStdout shows a different ref", () => {
    const traj = computeTrajectory(
      { goldRef: "skill:docker-homelab" },
      fakeRun({ verifierStdout: "akm show skill:az-cli\n" }),
    );
    expect(traj.correctAssetLoaded).toBe(false);
  });

  test("false on empty trace", () => {
    const traj = computeTrajectory({ goldRef: "skill:docker-homelab" }, fakeRun({ verifierStdout: "" }));
    expect(traj.correctAssetLoaded).toBe(false);
  });

  test("true when an event metadata.ref carries the goldRef", () => {
    const event: EventEnvelope = {
      schemaVersion: 1,
      id: 1,
      ts: "2026-04-27T00:00:00.000Z",
      eventType: "tool_call",
      metadata: { ref: "skill:docker-homelab" },
    };
    const traj = computeTrajectory({ goldRef: "skill:docker-homelab" }, fakeRun({ events: [event] }));
    expect(traj.correctAssetLoaded).toBe(true);
  });
});

describe("computeTrajectory.feedbackRecorded", () => {
  test("true when events stream contains a `feedback` event", () => {
    const traj = computeTrajectory({ goldRef: "skill:foo" }, fakeRun({ events: [feedbackEvent()] }));
    expect(traj.feedbackRecorded).toBe(true);
  });

  test("false when events stream is empty", () => {
    const traj = computeTrajectory({ goldRef: "skill:foo" }, fakeRun({ events: [] }));
    expect(traj.feedbackRecorded).toBe(false);
  });

  test("false when events contain other types but no `feedback`", () => {
    const event: EventEnvelope = {
      schemaVersion: 1,
      id: 0,
      ts: "2026-04-27T00:00:00.000Z",
      eventType: "remember",
      ref: "memory:alpha",
    };
    const traj = computeTrajectory({ goldRef: "skill:foo" }, fakeRun({ events: [event] }));
    expect(traj.feedbackRecorded).toBe(false);
  });
});

describe("computeTrajectory verifierStdout cap", () => {
  test("trajectory still computes from the prefix when stdout exceeds the cap, and a warning is recorded", () => {
    // Construct a stdout: prefix has the canonical `akm show` invocation;
    // the rest is GBs-of-junk simulated as a long filler past the cap.
    const ref = "skill:docker-homelab";
    const prefix = `tool: akm show ${ref}\n`;
    const fillerSize = VERIFIER_STDOUT_SCAN_CAP + 1024;
    // Use repeated 'a' so total length comfortably exceeds the cap.
    const filler = "a".repeat(fillerSize);
    const verifierStdout = prefix + filler;
    expect(verifierStdout.length).toBeGreaterThan(VERIFIER_STDOUT_SCAN_CAP);

    const warnings: string[] = [];
    const traj = computeTrajectory({ goldRef: ref }, fakeRun({ verifierStdout }), { warnings });
    expect(traj.correctAssetLoaded).toBe(true);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("verifierStdout truncated");
    expect(warnings[0]).toContain(String(VERIFIER_STDOUT_SCAN_CAP));
  });

  test("no warning when stdout is within the cap", () => {
    const warnings: string[] = [];
    computeTrajectory({ goldRef: "skill:foo" }, fakeRun({ verifierStdout: "akm show skill:foo\n" }), { warnings });
    expect(warnings).toEqual([]);
  });

  test("match found in the prefix even though tail mentions the ref past the cap", () => {
    // Prefix has only filler; the gold ref appears only AFTER the cap.
    // The scan should miss it (correctly — the agent's effective behaviour
    // within the budgeted prefix did not include the show call).
    const ref = "skill:never-loaded";
    const filler = "x".repeat(VERIFIER_STDOUT_SCAN_CAP);
    const verifierStdout = `${filler}akm show ${ref}\n`;
    const warnings: string[] = [];
    const traj = computeTrajectory({ goldRef: ref }, fakeRun({ verifierStdout }), { warnings });
    expect(traj.correctAssetLoaded).toBe(false);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("verifierStdout truncated");
  });
});
