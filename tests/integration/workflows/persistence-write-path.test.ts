// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getStateDbPath, openStateDatabase } from "../../../src/core/state-db";
import { borrowScopedStateDb, openScopedStateDbCount } from "../../../src/core/state-db-scope";
import {
  WorkflowRunsRepository,
  withWorkflowRunsConnection,
  withWorkflowRunsRepo,
} from "../../../src/storage/repositories/workflow-runs-repository";
import { enqueueUnitWrite } from "../../../src/workflows/exec/unit-writer";
import { WORKFLOW_MAX_EVIDENCE_JSON_BYTES } from "../../../src/workflows/resource-limits";
import {
  clipStepEvidenceForPersistence,
  completeWorkflowStep,
  getWorkflowStatus,
  WORKFLOW_EVIDENCE_TRUNCATED_MARKER,
} from "../../../src/workflows/runtime/runs";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../_helpers/sandbox";
import { freezeWorkflow, storeFrozenWorkflowPlan } from "../../_helpers/workflow";

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
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO workflow_runs
         (id, workflow_ref, scope_key, workflow_entry_id, workflow_title, status,
          params_json, current_step_id, created_at, updated_at, checkin_armed_at)
       VALUES (?, 'workflows/demo', 'dir:v1:demo', NULL, 'Demo', 'active', '{}', 'step-1', ?, ?, ?)`,
    ).run(RUN_ID, now, now, now);
    db.prepare(
      `INSERT INTO workflow_run_steps
         (run_id, step_id, step_title, instructions, completion_json, sequence_index, status)
       VALUES (?, 'step-1', 'Do the thing', 'instructions', NULL, 0, 'pending')`,
    ).run(RUN_ID);
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
        new WorkflowRunsRepository(scoped).insertUnit({
          runId: RUN_ID,
          unitId: "probe",
          stepId: "step-1",
          nodeId: "probe.unit",
          parentUnitId: null,
          phase: null,
          runner: "sdk",
          model: null,
          inputHash: "probe-hash",
          startedAt: new Date().toISOString(),
        });
        const seen = await withWorkflowRunsRepo((repo) => repo.getUnit(RUN_ID, "probe"));
        expect(seen?.status).toBe("running");
        // Many repo calls, still one handle.
        await withWorkflowRunsRepo((repo) => repo.getUnitsForRun(RUN_ID));
        await withWorkflowRunsRepo((repo) => repo.getRunById(RUN_ID));
        expect(openScopedStateDbCount()).toBe(1);
      } finally {
        scoped.exec("ROLLBACK");
      }
    });

    // Handle released with the scope, and the rolled-back probe left no trace.
    expect(openScopedStateDbCount()).toBe(0);
    const rows = await withWorkflowRunsRepo((repo) => repo.getUnitsForRun(RUN_ID));
    expect(rows).toHaveLength(0);
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
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const blocked = enqueueUnitWrite(
      async () => {
        await gate;
        order.push("a");
      },
      { key: "/tmp/does-not-exist/a.db" },
    );
    const independent = enqueueUnitWrite(
      async () => {
        order.push("b");
      },
      { key: "/tmp/does-not-exist/b.db" },
    );

    await independent;
    // "b" drained while "a" is still parked ⇒ the chains are genuinely separate.
    expect(order).toEqual(["b"]);
    release();
    await blocked;
    expect(order).toEqual(["b", "a"]);
  });

  test("writes sharing one database path stay strictly ordered", async () => {
    const order: number[] = [];
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        enqueueUnitWrite(
          async () => {
            await new Promise((resolve) => setTimeout(resolve, (12 - i) % 4));
            order.push(i);
          },
          { key: "/tmp/does-not-exist/shared.db" },
        ),
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
          // Distinct per-unit dispatch timestamps: `finishUnitFromDispatch` is
          // conditional on the row still carrying THIS dispatch's started_at.
          const startedAt = new Date(1_700_000_000_000 + i).toISOString();

          // Insert is awaited before "dispatch", exactly as
          // dispatchJournaledAttempt orders it — per-unit insert→finish
          // ordering comes from program order, not from queue position.
          await enqueueUnitWrite(() =>
            withWorkflowRunsRepo((repo) =>
              repo.insertUnit({
                runId: RUN_ID,
                unitId,
                stepId: "step-1",
                nodeId: "review.unit",
                parentUnitId: "step-1.map",
                phase: null,
                runner: "sdk",
                engine: "test-agent",
                model: null,
                inputHash: `hash-${i}`,
                startedAt,
              }),
            ),
          );
          // Interleave the units against each other on purpose.
          await new Promise((resolve) => setTimeout(resolve, i % 5));

          const finished = await enqueueUnitWrite(() =>
            withWorkflowRunsRepo((repo) =>
              repo.immediateTransaction(() =>
                repo.finishUnitFromDispatch({
                  runId: RUN_ID,
                  unitId,
                  status: "completed",
                  resultJson: JSON.stringify({ index: i }),
                  tokens: i,
                  failureReason: null,
                  finishedAt: new Date(1_700_000_100_000 + i).toISOString(),
                  dispatchStartedAt: startedAt,
                }),
              ),
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

describe("evidence_json persistence bound", () => {
  test("under-cap evidence is persisted verbatim", () => {
    const evidence = { output: ["a", "b"], units: [{ unitId: "u1", ok: true }] };
    const clipped = clipStepEvidenceForPersistence(evidence);
    expect(clipped.truncatedKeys).toEqual([]);
    expect(JSON.parse(clipped.json as string)).toEqual(evidence);
  });

  test("an over-cap promoted artifact is replaced by a marked truncation envelope under the cap", () => {
    const evidence = { output: bigOutput(4000), units: [{ unitId: "u1", ok: true }] };
    const raw = JSON.stringify(evidence);
    expect(Buffer.byteLength(raw, "utf8")).toBeGreaterThan(WORKFLOW_MAX_EVIDENCE_JSON_BYTES);

    const clipped = clipStepEvidenceForPersistence(evidence);
    expect(clipped.truncatedKeys).toEqual(["output"]);
    expect(Buffer.byteLength(clipped.json as string, "utf8")).toBeLessThanOrEqual(WORKFLOW_MAX_EVIDENCE_JSON_BYTES);

    const parsed = JSON.parse(clipped.json as string) as Record<string, Record<string, unknown>>;
    // The truncated value is unmistakable: it is NOT an array any more, it
    // carries the marker key, and it says the data is unrecoverable.
    expect(Array.isArray(parsed.output)).toBe(false);
    expect(parsed.output?.[WORKFLOW_EVIDENCE_TRUNCATED_MARKER]).toBe(true);
    expect(parsed.output?.originalBytes).toBe(Buffer.byteLength(JSON.stringify(evidence.output), "utf8"));
    expect(parsed.output?.limitBytes).toBe(WORKFLOW_MAX_EVIDENCE_JSON_BYTES);
    expect(String(parsed.output?.reason)).toContain("cannot be recovered");
    // Untouched siblings survive intact.
    expect(parsed.units).toEqual(evidence.units as never);
    // The caller's in-memory object is NOT mutated — gates and the live step
    // result keep the complete artifact.
    expect(evidence.output).toHaveLength(4000);
  });

  test("truncation is bounded even when every key is oversized", () => {
    const evidence: Record<string, unknown> = {};
    for (let i = 0; i < 8; i++) evidence[`k${i}`] = bigOutput(1000);
    const clipped = clipStepEvidenceForPersistence(evidence);
    expect(Buffer.byteLength(clipped.json as string, "utf8")).toBeLessThanOrEqual(WORKFLOW_MAX_EVIDENCE_JSON_BYTES);
    expect(clipped.truncatedKeys.length).toBeGreaterThan(0);
    const parsed = JSON.parse(clipped.json as string) as Record<string, Record<string, unknown>>;
    for (const key of clipped.truncatedKeys) {
      expect(parsed[key]?.[WORKFLOW_EVIDENCE_TRUNCATED_MARKER]).toBe(true);
    }
  });

  test("a tiny cap still yields a single whole-object marker rather than an oversized row", () => {
    const clipped = clipStepEvidenceForPersistence({ output: bigOutput(4), units: [] }, 64);
    const parsed = JSON.parse(clipped.json as string) as Record<string, unknown>;
    expect(parsed[WORKFLOW_EVIDENCE_TRUNCATED_MARKER]).toBe(true);
    expect(parsed.preview).toBeUndefined();
  });

  test("completeWorkflowStep persists the bounded form and status reads it back marked", async () => {
    const evidence = { output: bigOutput(4000), units: [{ unitId: "u1", ok: true }] };
    await completeWorkflowStep({
      runId: RUN_ID,
      stepId: "step-1",
      status: "completed",
      summary: "did the thing",
      evidence,
      summaryJudge: null,
    });

    const stored = await withWorkflowRunsRepo((repo) => repo.getStep(RUN_ID, "step-1"));
    expect(stored?.evidence_json).toBeTruthy();
    expect(Buffer.byteLength(stored?.evidence_json as string, "utf8")).toBeLessThanOrEqual(
      WORKFLOW_MAX_EVIDENCE_JSON_BYTES,
    );

    const status = await getWorkflowStatus(RUN_ID);
    const readBack = status.workflow.steps[0]?.evidence as Record<string, Record<string, unknown>> | undefined;
    expect(readBack?.output?.[WORKFLOW_EVIDENCE_TRUNCATED_MARKER]).toBe(true);
    // A downstream `${{ steps.step-1.output.<path> }}` reference now resolves
    // against a marker object, so it fails loudly instead of silently reading a
    // partial array.
    expect(Array.isArray(readBack?.output)).toBe(false);
    expect(readBack?.units).toEqual(evidence.units as never);
  });
});
