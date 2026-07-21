// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm workflow watch` (redesign addendum R2 — budget/watch/worktree batch):
 *
 *   - Backlog mode prints exactly the run's `workflow_*` / `workflow_unit_*`
 *     events (state.db events table, `metadata.runId` match) as NDJSON, in
 *     event-id order, and exits — other runs' events and non-workflow event
 *     families are never emitted.
 *   - An unknown run id is a structured WORKFLOW_NOT_FOUND, not an empty stream.
 *   - `--stream` polls from the last seen event id in a FOREGROUND loop (no
 *     daemon) and exits when the run reaches a terminal (non-active) status,
 *     draining events written before the status flip.
 *   - A run that is already terminal streams its backlog and exits without a
 *     single sleep.
 *   - The subcommand is registered (WORKFLOW_SUBCOMMANDS) and the
 *     `workflow-watch` passthrough output shape stamps the envelope.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { NotFoundError } from "../../../src/core/errors";
import { appendEvent, type EventEnvelope } from "../../../src/core/events";
import { shapeForCommand } from "../../../src/output/shapes";
import { WORKFLOW_SUBCOMMANDS } from "../../../src/workflows/cli";
import { DEFAULT_WATCH_INTERVAL_MS, isWorkflowRunEvent, watchWorkflowRun } from "../../../src/workflows/exec/watch";
import { completeWorkflowStep, startWorkflowRun } from "../../../src/workflows/runtime/runs";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeWorkflowTestConfig } from "../../_helpers/sandbox";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  writeWorkflowTestConfig();
});

afterEach(() => storage.cleanup());

function writeWorkflow(name: string): void {
  const file = path.join(storage.stashDir, "workflows", `${name}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const content = [
    "---",
    "description: Watch test workflow",
    "---",
    "",
    `# Workflow: ${name}`,
    "",
    "## Step: Only Step",
    "Step ID: only-step",
    "",
    "### Instructions",
    "Do the watched thing.",
    "",
  ].join("\n");
  fs.writeFileSync(file, content, "utf8");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseLines(lines: string[]): EventEnvelope[] {
  return lines.map((line) => JSON.parse(line) as EventEnvelope);
}

async function completeOnlyStep(runId: string): Promise<void> {
  await completeWorkflowStep({
    runId,
    stepId: "only-step",
    status: "completed",
    summary: "Watched the step to completion.",
    summaryJudge: null,
  });
}

describe("workflow watch — backlog", () => {
  test("prints only this run's workflow_* events as NDJSON, in id order, then exits", async () => {
    writeWorkflow("watch-backlog");
    const started = await startWorkflowRun("workflows/watch-backlog", {});
    const runId = started.run.id;

    // Seed journal events for this run…
    appendEvent({
      eventType: "workflow_unit_started",
      ref: "workflows/watch-backlog",
      metadata: { runId, stepId: "only-step", unitId: "only-step:solo" },
    });
    appendEvent({
      eventType: "workflow_unit_finished",
      ref: "workflows/watch-backlog",
      metadata: { runId, stepId: "only-step", unitId: "only-step:solo", status: "completed" },
    });
    // …and noise that must NOT appear: another run's workflow event, a
    // non-workflow family that happens to carry a runId, and a workflow
    // event with no metadata at all.
    appendEvent({ eventType: "workflow_unit_started", metadata: { runId: "some-other-run", unitId: "x:solo" } });
    appendEvent({ eventType: "search", metadata: { runId, query: "not a workflow event" } });
    appendEvent({ eventType: "workflow_started" });

    const lines: string[] = [];
    const result = await watchWorkflowRun({ runId, emit: (line) => lines.push(line) });

    const events = parseLines(lines);
    // `workflow_started` from startWorkflowRun + the two seeded unit events.
    expect(events.map((e) => e.eventType)).toEqual([
      "workflow_started",
      "workflow_unit_started",
      "workflow_unit_finished",
    ]);
    for (const event of events) {
      expect(event.metadata?.runId).toBe(runId);
    }
    // Emitted in ascending event-id order.
    const ids = events.map((e) => e.id);
    expect([...ids].sort((a, b) => a - b)).toEqual(ids);

    expect(result).toMatchObject({ runId, status: "active", eventCount: 3, streamed: false });
    // The cursor advanced past the noise rows too (it is a global rowid cursor).
    expect(result.lastEventId).toBeGreaterThanOrEqual(ids[ids.length - 1] ?? 0);
  });

  test("an unknown run id is a structured WORKFLOW_NOT_FOUND, not an empty stream", async () => {
    expect.assertions(3);
    try {
      await watchWorkflowRun({ runId: "00000000-0000-4000-8000-000000000000", emit: () => {} });
    } catch (err) {
      expect(err).toBeInstanceOf(NotFoundError);
      expect((err as NotFoundError).code).toBe("WORKFLOW_NOT_FOUND");
      expect((err as NotFoundError).message).toContain("not found");
    }
  });
});

describe("workflow watch — --stream", () => {
  test("polls from the last seen event id and exits when the run reaches a terminal status", async () => {
    writeWorkflow("watch-stream");
    const started = await startWorkflowRun("workflows/watch-stream", {});
    const runId = started.run.id;

    const lines: string[] = [];
    const watching = watchWorkflowRun({
      runId,
      stream: true,
      intervalMs: 15,
      emit: (line) => lines.push(line),
    });

    // Let the backlog drain and at least one poll happen, then emit a live
    // event and flip the run to a terminal status via the gate spine.
    await sleep(50);
    appendEvent({
      eventType: "workflow_unit_started",
      ref: "workflows/watch-stream",
      metadata: { runId, stepId: "only-step", unitId: "only-step:solo" },
    });
    await completeOnlyStep(runId);

    const result = await watching;

    expect(result.status).toBe("completed");
    expect(result.streamed).toBe(true);

    const types = parseLines(lines).map((e) => e.eventType);
    // Backlog line…
    expect(types[0]).toBe("workflow_started");
    // …then the streamed live event and the terminal-flip events, all drained
    // before exit (status is read BEFORE the final drain).
    expect(types).toContain("workflow_unit_started");
    expect(types).toContain("workflow_step_completed");
    expect(types).toContain("workflow_finished");
    expect(result.eventCount).toBe(lines.length);
  });

  test("a run that is already terminal prints the backlog and exits after a single idle grace poll", async () => {
    writeWorkflow("watch-terminal");
    const started = await startWorkflowRun("workflows/watch-terminal", {});
    const runId = started.run.id;
    await completeOnlyStep(runId);

    let sleeps = 0;
    const lines: string[] = [];
    const result = await watchWorkflowRun({
      runId,
      stream: true,
      emit: (line) => lines.push(line),
      sleep: async () => {
        sleeps++;
      },
    });

    // No poll loop iterations — just the one grace poll that confirms no
    // terminal events are still in flight (commit-before-append window).
    expect(sleeps).toBe(1);
    expect(result.status).toBe("completed");
    const types = parseLines(lines).map((e) => e.eventType);
    expect(types).toEqual(["workflow_started", "workflow_step_completed", "workflow_finished"]);
  });

  test("terminal events appended AFTER the status commit are still drained (grace poll regression)", async () => {
    // Peer-review regression: completeWorkflowStep commits the run-status
    // flip (workflow.db) BEFORE appending workflow_step_completed /
    // workflow_finished to state.db. A watch poll landing in that window
    // observes status='completed' while the terminal events are not yet in
    // the events table; without the grace polls the stream exited and
    // silently dropped them. Simulated here with seams: the fake engine
    // appends the terminal events only DURING the sleep that follows the
    // terminal status read.
    const runId = "race-run";
    const events: EventEnvelope[] = [];
    let nextId = 1;
    const push = (eventType: string): void => {
      events.push({ schemaVersion: 1, id: nextId++, ts: new Date().toISOString(), eventType, metadata: { runId } });
    };
    push("workflow_started");

    let statusCalls = 0;
    const lines: string[] = [];
    const result = await watchWorkflowRun({
      runId,
      stream: true,
      emit: (line) => lines.push(line),
      readEventsFn: ({ sinceOffset }) => {
        const batch = events.filter((e) => e.id > (sinceOffset ?? 0));
        return { events: batch, nextOffset: batch.length > 0 ? batch[batch.length - 1]!.id : (sinceOffset ?? 0) };
      },
      getRunStatus: async () => {
        statusCalls++;
        // Call 1 is the existence check (active); call 2 is the poll that
        // observes the committed status flip — terminal events NOT yet appended.
        return statusCalls >= 2 ? "completed" : "active";
      },
      sleep: async () => {
        // The engine's appendEvent calls land between the terminal status
        // read and the next drain — i.e. during a sleep.
        if (statusCalls >= 2 && !events.some((e) => e.eventType === "workflow_finished")) {
          push("workflow_step_completed");
          push("workflow_finished");
        }
      },
    });

    expect(result.status).toBe("completed");
    const types = parseLines(lines).map((e) => e.eventType);
    expect(types).toEqual(["workflow_started", "workflow_step_completed", "workflow_finished"]);
  });
});

describe("workflow watch — exits on every terminal status (completed/failed/blocked)", () => {
  // The `--stream` loop exits as soon as the run leaves `active`. "Terminal"
  // means ANY non-active status: the engine has stopped driving in all three,
  // so no more events arrive until a human resumes. Events written just before
  // the flip are still drained. `completed` is proven above via the gate spine;
  // `failed` and `blocked` are proven here through the status seam so all three
  // exits are pinned.
  for (const terminal of ["failed", "blocked"] as const) {
    test(`--stream drains the pre-flip event then exits when the run reaches ${terminal}`, async () => {
      const runId = `run-${terminal}`;
      const events: EventEnvelope[] = [];
      let nextId = 1;
      const push = (eventType: string): void => {
        events.push({ schemaVersion: 1, id: nextId++, ts: new Date().toISOString(), eventType, metadata: { runId } });
      };
      push("workflow_started");

      let statusCalls = 0;
      const lines: string[] = [];
      const result = await watchWorkflowRun({
        runId,
        stream: true,
        emit: (line) => lines.push(line),
        readEventsFn: ({ sinceOffset }) => {
          const batch = events.filter((e) => e.id > (sinceOffset ?? 0));
          return { events: batch, nextOffset: batch.length > 0 ? batch[batch.length - 1]!.id : (sinceOffset ?? 0) };
        },
        getRunStatus: async () => {
          statusCalls++;
          // Call 1 is the existence check (active). Call 2 appends a final event
          // AND flips terminal — proving an event written just before the status
          // commit is still emitted before the loop exits.
          if (statusCalls === 2) push("workflow_unit_finished");
          return statusCalls >= 2 ? terminal : "active";
        },
        sleep: async () => {},
      });

      expect(result.status).toBe(terminal);
      expect(result.streamed).toBe(true);
      const types = parseLines(lines).map((e) => e.eventType);
      expect(types).toEqual(["workflow_started", "workflow_unit_finished"]);
    });
  }

  test("--stream advances the cursor monotonically and emits each event exactly once across poll batches", async () => {
    // Regression net for the monotonic rowid cursor: every drain reads strictly
    // after the previous `nextOffset`, so an event appended by one batch is
    // never re-emitted by a later batch (no duplicate NDJSON lines), and the
    // read cursor never regresses even as fresh events land between polls.
    const runId = "cursor-run";
    const events: EventEnvelope[] = [];
    let nextId = 1;
    const push = (eventType: string): void => {
      events.push({ schemaVersion: 1, id: nextId++, ts: new Date().toISOString(), eventType, metadata: { runId } });
    };
    push("workflow_started");

    const cursorsRead: number[] = [];
    let statusCalls = 0;
    const lines: string[] = [];
    const result = await watchWorkflowRun({
      runId,
      stream: true,
      emit: (line) => lines.push(line),
      readEventsFn: ({ sinceOffset }) => {
        cursorsRead.push(sinceOffset ?? 0);
        const batch = events.filter((e) => e.id > (sinceOffset ?? 0));
        return { events: batch, nextOffset: batch.length > 0 ? batch[batch.length - 1]!.id : (sinceOffset ?? 0) };
      },
      getRunStatus: async () => {
        statusCalls++;
        // Two active polls each land a fresh event in a distinct batch, then the
        // run completes — so emission spans three separate drains.
        if (statusCalls === 2) push("workflow_unit_started");
        if (statusCalls === 3) push("workflow_unit_finished");
        return statusCalls >= 4 ? "completed" : "active";
      },
      sleep: async () => {},
    });

    expect(result.status).toBe("completed");
    const ids = parseLines(lines).map((e) => e.id);
    // Each event emitted exactly once — deduped array equals the raw array.
    expect(ids).toEqual([...new Set(ids)]);
    expect(ids).toEqual([1, 2, 3]);
    // The read cursor is non-decreasing across every poll batch (including the
    // backlog read at 0 and the trailing idle grace poll).
    for (let i = 1; i < cursorsRead.length; i++) {
      expect(cursorsRead[i]).toBeGreaterThanOrEqual(cursorsRead[i - 1] ?? 0);
    }
    expect(result.lastEventId).toBe(3);
    expect(result.eventCount).toBe(3);
  });
});

describe("workflow watch — registration + filter unit surface", () => {
  test("subcommand, passthrough shape, and default interval are registered", () => {
    expect(WORKFLOW_SUBCOMMANDS.has("watch")).toBe(true);
    const stamped = shapeForCommand("workflow-watch", { ok: true }, "brief") as Record<string, unknown>;
    expect(stamped.shape).toBe("workflow-watch");
    expect(stamped.schemaVersion).toBe(1);
    expect(DEFAULT_WATCH_INTERVAL_MS).toBe(1000);
  });

  test("isWorkflowRunEvent matches the workflow_* family on metadata.runId only", () => {
    const base = { schemaVersion: 1 as const, id: 1, ts: new Date().toISOString() };
    expect(isWorkflowRunEvent({ ...base, eventType: "workflow_unit_finished", metadata: { runId: "r1" } }, "r1")).toBe(
      true,
    );
    expect(isWorkflowRunEvent({ ...base, eventType: "workflow_started", metadata: { runId: "r2" } }, "r1")).toBe(false);
    expect(isWorkflowRunEvent({ ...base, eventType: "llm_usage", metadata: { runId: "r1" } }, "r1")).toBe(false);
    expect(isWorkflowRunEvent({ ...base, eventType: "workflow_finished" }, "r1")).toBe(false);
  });
});
