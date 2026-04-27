/**
 * Unit tests for the trajectory parser.
 */

import { describe, expect, test } from "bun:test";

import type { EventEnvelope } from "../../src/core/events";
import type { RunResult } from "./driver";
import { computeTrajectory } from "./trajectory";

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
