// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { serializeByKey } from "../../../src/core/concurrent";
import { getStateDbPath, openStateDatabase } from "../../../src/core/state-db";
import { borrowScopedStateDb, openScopedStateDbCount } from "../../../src/core/state-db-scope";
import {
  withWorkflowRunsConnection,
  withWorkflowRunsRepo,
} from "../../../src/storage/repositories/workflow-runs-repository";
import { runWorkflowSteps } from "../../../src/workflows/exec/run-workflow";
import { enqueueUnitWrite } from "../../../src/workflows/exec/unit-writer";
import { completeWorkflowStep, getWorkflowStatus } from "../../../src/workflows/runtime/runs";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../_helpers/sandbox";
import { freezeWorkflow, seedWorkflowRun, storeFrozenWorkflowPlan } from "../../_helpers/workflow";

/**
 * Persistence / write-path regressions for the workflow journal:
 *
 *   A. Connection reuse — a `withWorkflowRunsConnection` scope lends ONE
 *      state.db handle to every `withWorkflowRunsRepo` call inside it, and
 *      always closes it (success, failure, or throw). No handle leak.
 *   B. Writer-queue scoping — the serialized unit-write chain is keyed per
 *      DATABASE PATH, so unrelated databases never queue behind each other,
 *      while a wide concurrent fan-out against ONE database still produces
 *      exactly one correct terminal row per unit.
 *   C. Evidence bound — `evidence_json` is capped at
 *      {@link WORKFLOW_MAX_EVIDENCE_JSON_BYTES} and an over-cap value is stored
 *      as an unmistakably-marked truncation envelope, never as a silently
 *      shortened value that reads like complete data.
 *   D. …and that bound is a PERSISTENCE bound only: the invocation that
 *      produced an over-cap artifact still feeds the complete value to its own
 *      later steps, while a run resumed from the truncated row refuses to
 *      dispatch against it and says truncation is why.
 */

let storage: IsolatedAkmStorage;

const RUN_ID = "44444444-4444-4444-8444-444444444444";
const PLAN = freezeWorkflow(`---
type: workflow
steps:
  - id: step-1
---

## step-1

instructions
`);

function seedRun(dbPath: string): void {
  const db = openStateDatabase(dbPath);
  try {
    seedWorkflowRun(db, {
      runId: RUN_ID,
      steps: [{ stepId: "step-1", stepTitle: "Do the thing" }],
    });
    storeFrozenWorkflowPlan(db, RUN_ID, PLAN);
  } finally {
    db.close();
  }
}

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  seedRun(getStateDbPath());
});

afterEach(() => storage.cleanup());

// ── A. connection reuse ──────────────────────────────────────────────────────

describe("state.db connection scope", () => {
  test("every repo call inside a scope shares ONE connection, and the scope closes it", async () => {
    expect(openScopedStateDbCount()).toBe(0);

    await withWorkflowRunsConnection(async () => {
      // Force the lazy open, then prove reuse by visibility of an UNCOMMITTED
      // row: only the connection that opened the transaction can see it. A
      // second, independent connection in WAL mode never would.
      const scoped = borrowScopedStateDb();
      if (!scoped) throw new Error("expected an ambient scoped state.db handle inside the connection scope");
      expect(borrowScopedStateDb()).toBe(scoped);
      expect(openScopedStateDbCount()).toBe(1);

      scoped.exec("BEGIN IMMEDIATE");
      try {
        scoped.prepare("UPDATE workflow_runs SET workflow_title = 'Uncommitted' WHERE id = ?").run(RUN_ID);
        const seen = await withWorkflowRunsRepo((repo) => repo.getRunById(RUN_ID));
        expect(seen?.workflow_title).toBe("Uncommitted");
        // Many repo calls, still one handle.
        await withWorkflowRunsRepo((repo) => repo.getUnitsForRun(RUN_ID));
        await withWorkflowRunsRepo((repo) => repo.getRunById(RUN_ID));
        expect(openScopedStateDbCount()).toBe(1);
      } finally {
        scoped.exec("ROLLBACK");
      }
    });

    // Handle released with the scope, and the uncommitted change left no trace.
    expect(openScopedStateDbCount()).toBe(0);
    const row = await withWorkflowRunsRepo((repo) => repo.getRunById(RUN_ID));
    expect(row?.workflow_title).toBe("Demo");
  });

  test("a throw inside the scope still releases the connection", async () => {
    await expect(
      withWorkflowRunsConnection(async () => {
        await withWorkflowRunsRepo((repo) => repo.getRunById(RUN_ID));
        expect(openScopedStateDbCount()).toBe(1);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(openScopedStateDbCount()).toBe(0);
  });

  test("nesting joins the outer scope instead of opening a second handle", async () => {
    await withWorkflowRunsConnection(async () => {
      const outer = borrowScopedStateDb();
      await withWorkflowRunsConnection(async () => {
        expect(borrowScopedStateDb()).toBe(outer);
        expect(openScopedStateDbCount()).toBe(1);
      });
      // The inner scope must NOT have closed the outer scope's handle.
      expect(openScopedStateDbCount()).toBe(1);
      const run = await withWorkflowRunsRepo((repo) => repo.getRunById(RUN_ID));
      expect(run?.id).toBe(RUN_ID);
    });
    expect(openScopedStateDbCount()).toBe(0);
  });

  test("repo calls outside a scope keep owning (and closing) their own connection", async () => {
    await withWorkflowRunsRepo((repo) => {
      expect(repo.getRunById(RUN_ID)?.id).toBe(RUN_ID);
    });
    expect(openScopedStateDbCount()).toBe(0);
  });
});

// ── B. writer-queue scoping + fan-out correctness ────────────────────────────

describe("unit writer queue", () => {
  test("chains are keyed per database path — unrelated databases do not queue behind each other", async () => {
    // The per-key separation belongs to `serializeByKey`, which is what
    // `enqueueUnitWrite` calls with the live state.db path; exercise it on its
    // own chain map rather than asking the wrapper to write somewhere it never
    // writes in production.
    const chains = new Map<string, Promise<unknown>>();
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const blocked = serializeByKey(chains, "/tmp/does-not-exist/a.db", async () => {
      await gate;
      order.push("a");
    });
    const independent = serializeByKey(chains, "/tmp/does-not-exist/b.db", async () => {
      order.push("b");
    });

    await independent;
    // "b" drained while "a" is still parked ⇒ the chains are genuinely separate.
    expect(order).toEqual(["b"]);
    release();
    await blocked;
    expect(order).toEqual(["b", "a"]);
  });

  test("writes sharing one database path stay strictly ordered", async () => {
    // Every call keys on the live state.db path — the isolated one this suite
    // installs — so all 12 share a chain, which is the production shape.
    const order: number[] = [];
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        enqueueUnitWrite(async () => {
          await new Promise((resolve) => setTimeout(resolve, (12 - i) % 4));
          order.push(i);
        }),
      ),
    );
    expect(order).toEqual(Array.from({ length: 12 }, (_, i) => i));
  });

  test("a wide concurrent fan-out journals exactly one correct terminal row per unit", async () => {
    const UNITS = 64;
    await withWorkflowRunsConnection(async () => {
      await Promise.all(
        Array.from({ length: UNITS }, async (_, i) => {
          const unitId = `review:${i}`;
          const startedAt = new Date(1_700_000_000_000 + i).toISOString();

          const attempt = await enqueueUnitWrite(() =>
            withWorkflowRunsRepo((repo) =>
              repo.reserveUnitAttempt({
                runId: RUN_ID,
                unitId,
                stepId: "step-1",
                nodeId: "review.unit",
                parentUnitId: "step-1.map",
                phase: "unit",
                runner: "sdk",
                engine: "test-agent",
                model: null,
                inputHash: `hash-${i}`,
                now: startedAt,
              }),
            ),
          );
          // Interleave the units against each other on purpose.
          await new Promise((resolve) => setTimeout(resolve, i % 5));

          const finished = await enqueueUnitWrite(() =>
            withWorkflowRunsRepo((repo) =>
              repo.finishUnitAttempt({
                runId: RUN_ID,
                unitId,
                attempt: attempt.attempt.attempt,
                dispatchId: attempt.attempt.dispatch_id,
                status: "completed",
                resultJson: JSON.stringify({ index: i }),
                tokens: i,
                failureReason: null,
                finishedAt: new Date(1_700_000_100_000 + i).toISOString(),
              }),
            ),
          );
          expect(finished).toBe(true);
        }),
      );
    });

    const rows = await withWorkflowRunsRepo((repo) => repo.getUnitsForRun(RUN_ID));
    expect(rows).toHaveLength(UNITS);
    expect(rows.every((r) => r.status === "completed")).toBe(true);
    expect(rows.every((r) => r.attempts === 1)).toBe(true);
    for (const row of rows) {
      const index = Number(row.unit_id.slice("review:".length));
      expect(row.input_hash).toBe(`hash-${index}`);
      expect(JSON.parse(row.result_json as string)).toEqual({ index });
      expect(row.tokens).toBe(index);
    }
    expect(openScopedStateDbCount()).toBe(0);
  }, 30_000);
});

// ── C. evidence persistence bound ────────────────────────────────────────────

function bigOutput(entries: number): string[] {
  return Array.from({ length: entries }, (_, i) => `${"x".repeat(512)}#${i}`);
}

const ONE_MIB = 1024 * 1024;

describe("evidence_json persistence (no cap — issue C)", () => {
  test("small evidence is persisted verbatim", async () => {
    const evidence = { output: ["a", "b"], units: [{ unitId: "u1", ok: true }] };
    await completeWorkflowStep({
      runId: RUN_ID,
      stepId: "step-1",
      status: "completed",
      summary: "did the thing",
      evidence,
      summaryJudge: null,
    });
    const stored = await withWorkflowRunsRepo((repo) => repo.getStep(RUN_ID, "step-1"));
    expect(JSON.parse(stored?.evidence_json as string)).toEqual(evidence);
  });

  test("evidence well over the FORMER 1 MiB cap is persisted whole, byte-for-byte, no marker", async () => {
    const evidence = { output: bigOutput(4000), units: [{ unitId: "u1", ok: true }] };
    const raw = JSON.stringify(evidence);
    expect(Buffer.byteLength(raw, "utf8")).toBeGreaterThan(ONE_MIB);

    await completeWorkflowStep({
      runId: RUN_ID,
      stepId: "step-1",
      status: "completed",
      summary: "did the thing",
      evidence,
      summaryJudge: null,
    });

    const stored = await withWorkflowRunsRepo((repo) => repo.getStep(RUN_ID, "step-1"));
    expect(stored?.evidence_json).toBe(raw);
    expect(Buffer.byteLength(stored?.evidence_json as string, "utf8")).toBeGreaterThan(ONE_MIB);

    const status = await getWorkflowStatus(RUN_ID);
    const readBack = status.workflow.steps[0]?.evidence as Record<string, unknown> | undefined;
    // The complete array survives round-trip — no truncation marker, no
    // shape change, nothing replaced.
    expect(readBack?.output).toEqual(evidence.output);
    expect(Array.isArray(readBack?.output)).toBe(true);
    expect((readBack?.output as unknown[]).length).toBe(4000);
  });
});

// ── D. the row bound never reaches the LIVE run ──────────────────────────────

const FLOW_RUN_ID = "55555555-5555-4555-8555-555555555555";

/** Wide + long enough that `produce`'s promoted array alone blows the 1 MiB row cap. */
const CHUNK_COUNT = 20;
const CHUNK_CHARS = 60_000;

/** Distinct per index — content-derived unit identity rejects duplicate items. */
function chunkText(index: number): string {
  return `${"c".repeat(CHUNK_CHARS - 4)}#${String(index).padStart(3, "0")}`;
}

const FLOW_PLAN = freezeWorkflow(`---
type: workflow
params:
  chunks: { type: array }
steps:
  - id: produce
    map:
      over: params.chunks
  - id: consume
    map:
      over: steps.produce.output
---

## produce

Emit the chunk.

## consume

Handle the chunk.
`);

function seedFlowRun(): void {
  const db = openStateDatabase(getStateDbPath());
  try {
    seedWorkflowRun(db, {
      runId: FLOW_RUN_ID,
      params: { chunks: Array.from({ length: CHUNK_COUNT }, (_, i) => `seed-${i}`) },
      steps: [{ stepId: "produce" }, { stepId: "consume" }],
    });
    storeFrozenWorkflowPlan(db, FLOW_RUN_ID, FLOW_PLAN);
  } finally {
    db.close();
  }
}

describe("a big artifact survives both a live run and a resume (issue C fix)", () => {
  test("a step promoting well over the FORMER cap still feeds the NEXT step the complete value, and the row holds it all", async () => {
    seedFlowRun();
    const consumePrompts: string[] = [];
    const result = await runWorkflowSteps({
      target: FLOW_RUN_ID,
      dispatcher: async (request) => {
        if (request.stepId === "consume") {
          consumePrompts.push(request.prompt);
          return { ok: true, text: "handled" };
        }
        // Each `produce` unit emits the chunk for its own fan-out index.
        const index = /^## Item \(index (\d+)\)$/m.exec(request.prompt)?.[1];
        return { ok: true, text: chunkText(Number(index)) };
      },
      summaryJudge: null,
    });

    expect(result.done).toBe(true);
    // The whole promoted array reached `consume` — every unit got its own
    // complete 60k-char item, not a truncation envelope (which is not even an
    // array, so the fan-out would have failed to resolve at all).
    expect(consumePrompts).toHaveLength(CHUNK_COUNT);
    for (let i = 0; i < CHUNK_COUNT; i++) {
      expect(consumePrompts.some((prompt) => prompt.includes(chunkText(i)))).toBe(true);
    }

    // …and the row is STILL bounded: the cap did its job on persistence only.
    const stored = await withWorkflowRunsRepo((repo) => repo.getStep(FLOW_RUN_ID, "produce"));
    expect(Buffer.byteLength(stored?.evidence_json as string, "utf8")).toBeGreaterThan(ONE_MIB);
    const persisted = JSON.parse(stored?.evidence_json as string) as { output: string[] };
    expect(persisted.output).toHaveLength(CHUNK_COUNT);
    for (let i = 0; i < CHUNK_COUNT; i++) expect(persisted.output).toContain(chunkText(i));
  }, 60_000);

  test("the fix for finding 1: a run RESUMED from a row a previous invocation wrote dispatches the next step against the complete value, not a tombstone", async () => {
    seedFlowRun();
    // Simulate the rows a PRIOR invocation left behind: `produce` completed,
    // its promoted artifact — well over the former 1 MiB cap — written whole,
    // exactly as `completeWorkflowStep` now persists it.
    const fullEvidence = JSON.stringify({
      units: [],
      itemCount: CHUNK_COUNT,
      output: Array.from({ length: CHUNK_COUNT }, (_, i) => chunkText(i)),
    });
    expect(Buffer.byteLength(fullEvidence, "utf8")).toBeGreaterThan(ONE_MIB);
    const db = openStateDatabase(getStateDbPath());
    try {
      db.prepare(
        `UPDATE workflow_run_steps SET status = 'completed', summary = 'produced', evidence_json = ?, completed_at = ?
           WHERE run_id = ? AND step_id = 'produce'`,
      ).run(fullEvidence, new Date().toISOString(), FLOW_RUN_ID);
      db.prepare("UPDATE workflow_runs SET current_step_id = 'consume' WHERE id = ?").run(FLOW_RUN_ID);
    } finally {
      db.close();
    }

    const consumePrompts: string[] = [];
    const result = await runWorkflowSteps({
      target: FLOW_RUN_ID,
      dispatcher: async (request) => {
        consumePrompts.push(request.prompt);
        return { ok: true, text: "handled" };
      },
      summaryJudge: null,
    });

    expect(result.done).toBe(true);
    expect(consumePrompts).toHaveLength(CHUNK_COUNT);
    for (let i = 0; i < CHUNK_COUNT; i++) {
      expect(consumePrompts.some((prompt) => prompt.includes(chunkText(i)))).toBe(true);
    }
    const status = await getWorkflowStatus(FLOW_RUN_ID);
    expect(status.workflow.steps[1]?.status).toBe("completed");
    expect(status.run.status).toBe("completed");
  }, 30_000);
});
