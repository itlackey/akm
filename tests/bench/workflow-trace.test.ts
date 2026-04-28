/**
 * Tests for tests/bench/workflow-trace.ts (issue #254).
 */

import { describe, expect, test } from "bun:test";
import type { EventEnvelope } from "../../src/core/events";
import type { RunResult } from "./driver";
import {
  MAX_EVENT_BYTES,
  MAX_EVENT_COUNT,
  MAX_STDOUT_SCAN_BYTES,
  type WorkflowTraceEvent,
  normalizeRunToTrace,
} from "./workflow-trace";

function makeRun(overrides: Partial<RunResult> = {}): RunResult {
  return {
    schemaVersion: 1,
    taskId: "deploy-docker",
    arm: "akm",
    seed: 42,
    model: "anthropic/claude-opus-4-7",
    outcome: "pass",
    tokens: { input: 0, output: 0 },
    tokenMeasurement: "parsed",
    wallclockMs: 1234,
    trajectory: { correctAssetLoaded: null, feedbackRecorded: null },
    events: [],
    verifierStdout: "",
    verifierExitCode: 0,
    assetsLoaded: [],
    ...overrides,
  };
}

function ev(eventType: string, ts: string, extra: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    schemaVersion: 1,
    id: 0,
    ts,
    eventType,
    ...extra,
  };
}

describe("normalizeRunToTrace — AKM event input", () => {
  test("maps search/show/feedback events to typed trace events with stable order", () => {
    const run = makeRun({
      events: [
        ev("show", "2026-04-27T10:00:01.000Z", { ref: "skill:deploy" }),
        ev("search", "2026-04-27T10:00:00.000Z", { metadata: { query: "deploy docker" } }),
        ev("feedback", "2026-04-27T10:00:02.000Z", { ref: "skill:deploy", metadata: { vote: 1 } }),
      ],
    });

    const trace = normalizeRunToTrace(run);

    expect(trace.schemaVersion).toBe(1);
    expect(trace.taskId).toBe("deploy-docker");
    expect(trace.arm).toBe("akm");
    expect(trace.seed).toBe(42);
    expect(trace.truncated).toBe(false);

    // `verifier_run` is auto-derived from RunResult.verifierExitCode, so we
    // expect 4 events: search, show, feedback, verifier.
    const types = trace.events.map((e) => e.type);
    expect(types).toEqual(["akm_search", "akm_show", "akm_feedback", "verifier_run"]);

    expect(trace.events[0].source).toBe("akm_events");
    expect(trace.events[0].query).toBe("deploy docker");
    expect(trace.events[1].assetRef).toBe("skill:deploy");
    expect(trace.events[2].assetRef).toBe("skill:deploy");
    expect(trace.events[3].source).toBe("verifier");
    expect(trace.events[3].exitCode).toBe(0);

    // Ids are 0..n-1, monotonic.
    for (let i = 0; i < trace.events.length; i += 1) {
      expect(trace.events[i].id).toBe(i);
    }
  });

  test("ignores unrelated AKM event types (add/remove/update)", () => {
    const run = makeRun({
      events: [
        ev("add", "2026-04-27T10:00:00.000Z", { ref: "skill:foo" }),
        ev("remove", "2026-04-27T10:00:01.000Z", { ref: "skill:bar" }),
        ev("search", "2026-04-27T10:00:02.000Z", { metadata: { query: "x" } }),
      ],
    });
    const trace = normalizeRunToTrace(run);
    const types = trace.events.map((e) => e.type);
    expect(types).toEqual(["akm_search", "verifier_run"]);
  });

  test("records verifier_run with exitCode from the run envelope", () => {
    const run = makeRun({ verifierExitCode: 1, outcome: "fail" });
    const trace = normalizeRunToTrace(run);
    const verifier = trace.events.find((e) => e.type === "verifier_run");
    expect(verifier).toBeDefined();
    expect(verifier?.exitCode).toBe(1);
    expect(verifier?.source).toBe("verifier");
  });
});

describe("normalizeRunToTrace — stdout / tool-call input", () => {
  test("detects akm CLI invocations from agent stdout", () => {
    const stdout = [
      "tool: akm search \"deploy docker\"",
      "tool: akm show skill:deploy",
      "tool: akm feedback +1 skill:deploy",
    ].join("\n");
    const run = makeRun();
    const trace = normalizeRunToTrace(run, { agentStdout: stdout });
    const cliEvents = trace.events.filter((e) => e.source === "agent_stdout");
    expect(cliEvents.map((e) => e.type)).toEqual(["akm_search", "akm_show", "akm_feedback"]);
    expect(cliEvents[0].query).toBe("deploy docker");
    expect(cliEvents[1].assetRef).toBe("skill:deploy");
    expect(cliEvents[2].assetRef).toBe("skill:deploy");
  });

  test("detects JSON tool-call shape", () => {
    const stdout = '{"command":"akm","args":["show","skill:foo"]}';
    const run = makeRun();
    const trace = normalizeRunToTrace(run, { agentStdout: stdout });
    const showEv = trace.events.find((e) => e.type === "akm_show");
    expect(showEv).toBeDefined();
    expect(showEv?.assetRef).toBe("skill:foo");
    expect(showEv?.source).toBe("agent_stdout");
  });

  test("AKM events sort before stdout-derived events when both have the same verb", () => {
    const run = makeRun({
      events: [ev("search", "2026-04-27T10:00:00.000Z", { metadata: { query: "structured" } })],
    });
    const trace = normalizeRunToTrace(run, { agentStdout: 'akm search "stdout"' });
    const searches = trace.events.filter((e) => e.type === "akm_search");
    expect(searches.length).toBe(2);
    expect(searches[0].source).toBe("akm_events");
    expect(searches[1].source).toBe("agent_stdout");
  });
});

describe("normalizeRunToTrace — workspace-write detection", () => {
  test("first workspace path becomes first_workspace_write, rest become workspace_write", () => {
    const run = makeRun();
    const trace = normalizeRunToTrace(run, {
      workspaceWrites: ["src/a.ts", "src/b.ts", "src/c.ts"],
    });
    const writes = trace.events.filter(
      (e) => e.type === "first_workspace_write" || e.type === "workspace_write",
    );
    expect(writes.length).toBe(3);
    expect(writes[0].type).toBe("first_workspace_write");
    expect(writes[0].filePath).toBe("src/a.ts");
    expect(writes[1].type).toBe("workspace_write");
    expect(writes[1].filePath).toBe("src/b.ts");
    expect(writes[2].type).toBe("workspace_write");
    expect(writes[2].filePath).toBe("src/c.ts");
    for (const w of writes) {
      expect(w.source).toBe("filesystem_diff");
    }
  });

  test("no workspace writes => no workspace events", () => {
    const run = makeRun();
    const trace = normalizeRunToTrace(run, { workspaceWrites: [] });
    const writes = trace.events.filter(
      (e) => e.type === "first_workspace_write" || e.type === "workspace_write",
    );
    expect(writes.length).toBe(0);
  });

  test("harness lifecycle markers emit agent_started and agent_finished", () => {
    const run = makeRun();
    const trace = normalizeRunToTrace(run, {
      harness: {
        agentStartedTs: "2026-04-27T09:59:59.000Z",
        agentFinishedTs: "2026-04-27T10:00:30.000Z",
      },
    });
    const types = trace.events.map((e) => e.type);
    expect(types[0]).toBe("agent_started");
    expect(types[types.length - 1]).toBe("agent_finished");
  });
});

describe("normalizeRunToTrace — malformed/noisy input", () => {
  test("ignores malformed events instead of throwing", () => {
    const malformed = [
      null,
      undefined,
      42,
      "string-not-an-event",
      { eventType: 123 }, // eventType not a string
      { eventType: "search" }, // no ts — still valid, mapped
    ];
    const run = makeRun({
      // Cast through unknown — we explicitly want to test garbage input.
      events: malformed as unknown as EventEnvelope[],
    });
    const trace = normalizeRunToTrace(run);
    // The only valid event is the trailing { eventType: "search" } (it has no
    // ts so it sorts after the synthesised verifier_run sentinel), plus the
    // verifier_run derived from RunResult.
    const types = trace.events.map((e) => e.type).sort();
    expect(types).toEqual(["akm_search", "verifier_run"].sort());
    expect(trace.events.length).toBe(2);
  });

  test("clamps oversized fields to MAX_EVENT_BYTES and flags bytesTruncated", () => {
    const giantQuery = "x".repeat(MAX_EVENT_BYTES * 2);
    const run = makeRun({
      events: [ev("search", "2026-04-27T10:00:00.000Z", { metadata: { query: giantQuery } })],
    });
    const trace = normalizeRunToTrace(run);
    const search = trace.events.find((e) => e.type === "akm_search") as WorkflowTraceEvent;
    expect(search.query?.length).toBe(MAX_EVENT_BYTES);
    expect(search.bytesTruncated).toBe(true);
  });

  test("caps total event count at MAX_EVENT_COUNT and surfaces a warning", () => {
    const events: EventEnvelope[] = [];
    for (let i = 0; i < MAX_EVENT_COUNT + 50; i += 1) {
      events.push(
        ev(
          "search",
          // Pad timestamps so they sort lexicographically.
          `2026-04-27T${String(Math.floor(i / 60) % 24).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:00.${String(i).padStart(6, "0").slice(-3)}Z`,
          { metadata: { query: `q-${i}` } },
        ),
      );
    }
    const run = makeRun({ events });
    const warnings: string[] = [];
    const trace = normalizeRunToTrace(run, { warnings });
    expect(trace.events.length).toBe(MAX_EVENT_COUNT);
    expect(trace.truncated).toBe(true);
    expect(warnings.some((w) => w.includes("workflow trace truncated"))).toBe(true);
  });

  test("clamps oversized stdout and surfaces a warning instead of OOM", () => {
    // A pathological 1MiB single line plus a trailing real CLI invocation that
    // would be cut off if the cap weren't applied.
    const giantLine = "akm show ".concat("y".repeat(MAX_EVENT_BYTES * 4));
    const run = makeRun();
    const warnings: string[] = [];
    const stdout = giantLine; // single line, larger than MAX_EVENT_BYTES but below MAX_STDOUT_SCAN_BYTES
    const trace = normalizeRunToTrace(run, { agentStdout: stdout, warnings });
    const showEv = trace.events.find((e) => e.type === "akm_show");
    expect(showEv).toBeDefined();
    // assetRef must be clamped — it cannot be 4 * MAX_EVENT_BYTES.
    expect(showEv?.assetRef?.length ?? 0).toBeLessThanOrEqual(MAX_EVENT_BYTES);
    expect(showEv?.bytesTruncated).toBe(true);
  });

  test("stdout larger than MAX_STDOUT_SCAN_BYTES is truncated with a warning", () => {
    // Build a stdout > scan cap. We want this to actually exceed the cap so the
    // truncation branch fires, but we keep it minimally larger to keep the test fast.
    const overshoot = 1024;
    const huge = "z".repeat(MAX_STDOUT_SCAN_BYTES + overshoot);
    const run = makeRun();
    const warnings: string[] = [];
    normalizeRunToTrace(run, { agentStdout: huge, warnings });
    expect(warnings.some((w) => w.includes("workflow trace stdout truncated"))).toBe(true);
  });

  test("no events, no stdout, no writes => only verifier_run is produced", () => {
    const trace = normalizeRunToTrace(makeRun());
    expect(trace.events.length).toBe(1);
    expect(trace.events[0].type).toBe("verifier_run");
  });

  test("identical inputs produce identical traces (deterministic)", () => {
    const run = makeRun({
      events: [
        ev("show", "2026-04-27T10:00:01.000Z", { ref: "skill:a" }),
        ev("search", "2026-04-27T10:00:00.000Z", { metadata: { query: "q" } }),
      ],
    });
    const a = normalizeRunToTrace(run, { agentStdout: "akm show skill:b" });
    const b = normalizeRunToTrace(run, { agentStdout: "akm show skill:b" });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
