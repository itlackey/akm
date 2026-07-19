// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { resolveStorageLocations } from "../../../src/storage/locations";
import { withWorkflowRunsRepo } from "../../../src/storage/repositories/workflow-runs-repository";
import { closeWorkflowDatabase, openWorkflowDatabase } from "../../../src/workflows/db";
import type { UnitDispatchRequest, UnitDispatchResult } from "../../../src/workflows/exec/native-executor";
import { runWorkflowSteps } from "../../../src/workflows/exec/run-workflow";
import type { WorkflowPlanGraph } from "../../../src/workflows/ir/schema";
import { resumeWorkflowRun, startWorkflowRun } from "../../../src/workflows/runtime/runs";
import {
  type IsolatedAkmStorage,
  withIsolatedAkmStorage,
  writeSandboxConfig,
  writeWorkflowTestConfig,
} from "../../_helpers/sandbox";

/**
 * Budget ceilings (redesign addendum R2): the YAML `budget` block travels
 * end to end — parser → compiler → FROZEN plan (`plan_json`) — and the engine
 * enforces it per run:
 *
 *   - `max_units`: total dispatched units, seeded from the journal row count;
 *     the dispatch after the ceiling is refused and the step fails hard.
 *   - `max_tokens`: total reported usage, seeded from the journal's summed
 *     `tokens` column; crossing the ceiling aborts pending/in-flight
 *     dispatches through an AbortController chained onto ctx.signal.
 *   - Either ceiling fails the step with a "budget exceeded (<which>
 *     ceiling)" summary REGARDLESS of `on_error` — a budget-capped run must
 *     never quietly pass its gate.
 *   - A workflow without a budget block behaves exactly as before.
 *
 * Every test runs the real end-to-end path: YAML asset in an isolated stash,
 * `startWorkflowRun` freezing the plan, `runWorkflowSteps` executing the
 * frozen plan with a fake dispatcher (no LLM, no agent binaries).
 */

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  writeWorkflowTestConfig();
});

afterEach(() => storage.cleanup());

function writeProgram(name: string, yamlText: string): void {
  const file = path.join(storage.stashDir, "workflows", `${name}.yaml`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, yamlText, "utf8");
}

/** Direct-SQL escape hatch for planting journaled token spend. */
function execOnWorkflowDb(sql: string, ...params: Array<string | number>): void {
  const db = openWorkflowDatabase(resolveStorageLocations().workflowDb);
  try {
    db.prepare(sql).run(...params);
  } finally {
    closeWorkflowDatabase(db);
  }
}

const FAN_OUT_3 = (budgetYaml: string, unitExtra = ""): string => `version: 2
name: budgeted
params:
  files: { type: array, items: { type: string } }
${budgetYaml}
steps:
  - id: review
    title: Review files
    map:
      over: \${{ params.files }}
      unit:
        instructions: Review \${{ item }} carefully.
${unitExtra}
`;

const TWO_STEPS = (budgetYaml: string): string => `version: 2
name: two-steps
${budgetYaml}
steps:
  - id: one
    unit:
      instructions: Do step one.
  - id: two
    unit:
      instructions: Do step two.
`;

describe("budget.max_units", () => {
  test("the budget freezes onto plan_json and dispatching stops at the ceiling with a hard step failure", async () => {
    writeProgram("units-capped", FAN_OUT_3("budget: { max_units: 2 }"));
    const started = await startWorkflowRun("workflows/units-capped", { files: ["a.ts", "b.ts", "c.ts"] });

    // End-to-end: the budget rides the FROZEN plan, not the live asset.
    const row = await withWorkflowRunsRepo((repo) => repo.getRunById(started.run.id));
    const frozen = JSON.parse(row?.plan_json ?? "") as WorkflowPlanGraph;
    expect(frozen.budget).toEqual({ maxUnits: 2 });

    let dispatches = 0;
    const result = await runWorkflowSteps({
      target: started.run.id,
      summaryJudge: null,
      dispatcher: async (): Promise<UnitDispatchResult> => {
        dispatches++;
        return { ok: true, text: "reviewed" };
      },
    });

    expect(dispatches).toBe(2); // stopped AT the ceiling, not after the full fan-out
    expect(result.run.status).toBe("failed");
    expect(result.executed[0]?.ok).toBe(false);
    expect(result.executed[0]?.summary).toContain("budget exceeded (max_units ceiling)");
    expect(result.executed[0]?.summary).toContain("max_units of 2");

    // Only the dispatched attempts journaled — the refused unit wrote no row.
    const units = await withWorkflowRunsRepo((repo) => repo.getUnitsForRun(started.run.id));
    expect(units).toHaveLength(2);
  });

  test("seeding: gate-evaluation journal rows are NOT counted as dispatches on resume", async () => {
    // Step one carries a completion gate: the engine journals the judge call
    // as a unit row (`one.gate:l1`, phase "gate"). That row is NOT a dispatch
    // — the live path never consumes DispatchBudget for it — so a resumed
    // run must not count it either. Pre-fix, the seed counted every journal
    // row: with max_units: 2 the resume below spuriously failed step two
    // with "budget exceeded" while the identical uninterrupted run passed.
    writeProgram(
      "gate-seeded",
      `version: 2
name: gate-seeded
budget: { max_units: 2 }
steps:
  - id: one
    unit:
      instructions: Do step one.
    gate:
      criteria: [step one produced output]
  - id: two
    unit:
      instructions: Do step two.
`,
    );
    const started = await startWorkflowRun("workflows/gate-seeded", {});

    // Invocation 1: step one dispatches (used = 1) and its gate judge passes,
    // journaling the extra `one.gate:l1` row. maxSteps stops the engine here
    // — the interrupted-run half of the repro.
    const first = await runWorkflowSteps({
      target: started.run.id,
      maxSteps: 1,
      summaryJudge: async () => '{"complete": true, "missing": []}',
      dispatcher: async () => ({ ok: true, text: "one done" }),
    });
    expect(first.executed).toEqual([expect.objectContaining({ stepId: "one", ok: true })]);

    // The journal really does hold TWO rows for step one: the dispatch and
    // the gate evaluation (phase "gate") — the row the seed must skip.
    const afterFirst = await withWorkflowRunsRepo((repo) => repo.getUnitsForRun(started.run.id));
    expect(afterFirst.map((u) => u.unit_id).sort()).toEqual(["one.gate:l1", "one:solo"]);
    expect(afterFirst.find((u) => u.unit_id === "one.gate:l1")?.phase).toBe("gate");

    // Invocation 2 must seed unitsDispatched = 1 (dispatches only): step two
    // dispatches (used = 2, exactly the ceiling) and the run completes —
    // identical to the uninterrupted run.
    let dispatches = 0;
    const second = await runWorkflowSteps({
      target: started.run.id,
      summaryJudge: null,
      dispatcher: async () => {
        dispatches++;
        return { ok: true, text: "two done" };
      },
    });
    expect(dispatches).toBe(1);
    expect(second.done).toBe(true);
    expect(second.run.status).toBe("completed");
    expect(second.executed).toEqual([expect.objectContaining({ stepId: "two", ok: true })]);
  });

  test("crash/resume re-dispatches of ONE unit accumulate against max_units and are refused at the ceiling", async () => {
    // PR #714 review (P2): a crash between a unit's dispatch (`running` row)
    // and its finish leaves a stale row that resume re-dispatches under the
    // SAME content-derived unit_id — `insertUnit` REPLACES the single row. The
    // budget seed used to count ROWS, so each crash/resume erased the prior
    // dispatch from `max_units` accounting and the run could spend past its
    // ceiling. Migration 008's `attempts` counter, summed by the seed, charges
    // every re-dispatch. Here max_units:2 with two crashed attempts already at
    // the ceiling: the third invocation must be REFUSED before dispatching.
    writeProgram(
      "crash-budget",
      `version: 2
name: crash-budget
budget: { max_units: 2 }
steps:
  - id: build
    unit:
      instructions: Build it.
`,
    );
    const started = await startWorkflowRun("workflows/crash-budget", {});
    const runId = started.run.id;

    // Invocation 1: the dispatch crashes → one FAILED attempt journaled (attempts=1).
    const first = await runWorkflowSteps({
      target: runId,
      summaryJudge: null,
      dispatcher: async () => {
        throw new Error("boom-1");
      },
    });
    expect(first.run.status).toBe("failed");

    await resumeWorkflowRun(runId);

    // Invocation 2: crashes again → the SAME unit_id row is REPLACED, attempts=2.
    const second = await runWorkflowSteps({
      target: runId,
      summaryJudge: null,
      dispatcher: async () => {
        throw new Error("boom-2");
      },
    });
    expect(second.run.status).toBe("failed");

    // Exactly ONE dispatch row survives, but it records TWO attempts.
    const units = await withWorkflowRunsRepo((repo) => repo.getUnitsForRun(runId));
    const dispatchRows = units.filter((u) => u.phase !== "gate");
    expect(dispatchRows).toHaveLength(1);
    expect(dispatchRows[0].attempts).toBe(2);

    await resumeWorkflowRun(runId);

    // Invocation 3: the seed is SUM(attempts) = 2 = the ceiling, so the
    // re-dispatch is REFUSED before running — no third attempt is spent. Pre-008
    // the seed counted the single row (1) and this dispatched again (over-spend).
    let dispatches = 0;
    const third = await runWorkflowSteps({
      target: runId,
      summaryJudge: null,
      dispatcher: async () => {
        dispatches++;
        return { ok: true, text: "built" };
      },
    });
    expect(dispatches).toBe(0);
    expect(third.run.status).toBe("failed");
    expect(third.executed[0]?.ok).toBe(false);
    expect(third.executed[0]?.summary).toContain("budget exceeded (max_units ceiling)");

    // The journal still holds ONE dispatch row with two accumulated attempts —
    // the refused invocation wrote no new row.
    const finalRows = (await withWorkflowRunsRepo((repo) => repo.getUnitsForRun(runId))).filter(
      (u) => u.phase !== "gate",
    );
    expect(finalRows).toHaveLength(1);
    expect(finalRows[0].attempts).toBe(2);
  });

  test("seeding: journaled dispatches from a prior invocation count against max_units", async () => {
    writeProgram("units-seeded", TWO_STEPS("budget: { max_units: 1 }"));
    const started = await startWorkflowRun("workflows/units-seeded", {});

    // Invocation 1 dispatches step one's single unit (exactly the budget).
    const first = await runWorkflowSteps({
      target: started.run.id,
      maxSteps: 1,
      summaryJudge: null,
      dispatcher: async () => ({ ok: true, text: "one done" }),
    });
    expect(first.executed).toEqual([expect.objectContaining({ stepId: "one", ok: true })]);

    // Invocation 2 seeds units=1 from the journal: step two is refused
    // before dispatching anything.
    let dispatches = 0;
    const second = await runWorkflowSteps({
      target: started.run.id,
      summaryJudge: null,
      dispatcher: async () => {
        dispatches++;
        return { ok: true, text: "must not run" };
      },
    });
    expect(dispatches).toBe(0);
    expect(second.run.status).toBe("failed");
    expect(second.executed[0]?.summary).toContain("budget exceeded (max_units ceiling)");
  });
});

describe("budget.max_tokens", () => {
  test("a usage-reporting dispatcher trips the ceiling; further dispatch is refused and the step fails hard", async () => {
    writeProgram("tokens-capped", FAN_OUT_3("budget: { max_tokens: 100 }"));
    const started = await startWorkflowRun("workflows/tokens-capped", { files: ["a.ts", "b.ts", "c.ts"] });

    let dispatches = 0;
    const result = await runWorkflowSteps({
      target: started.run.id,
      summaryJudge: null,
      dispatcher: async (): Promise<UnitDispatchResult> => {
        dispatches++;
        return { ok: true, text: "reviewed", usage: { inputTokens: 40, outputTokens: 20 } };
      },
    });

    // 60 tokens after unit 1 (under), 120 after unit 2 (ceiling crossed):
    // unit 3 never dispatches.
    expect(dispatches).toBe(2);
    expect(result.run.status).toBe("failed");
    expect(result.executed[0]?.summary).toContain("budget exceeded (max_tokens ceiling)");
    expect(result.executed[0]?.summary).toContain("max_tokens of 100");

    // The journal still carries both real attempts and their token spend.
    const units = await withWorkflowRunsRepo((repo) => repo.getUnitsForRun(started.run.id));
    expect(units).toHaveLength(2);
    expect(units.reduce((sum, u) => sum + (u.tokens ?? 0), 0)).toBe(120);
  });

  test("crossing the ceiling aborts an in-flight sibling through the chained AbortController", async () => {
    writeSandboxConfig({
      workflow: { maxConcurrency: 2 },
      engines: {
        "test-agent": { kind: "agent", platform: "opencode-sdk" },
        "test-llm": {
          kind: "llm",
          endpoint: "http://localhost:1/v1/chat/completions",
          model: "test-model",
          concurrency: 2,
        },
      },
    });
    writeProgram(
      "tokens-abort",
      `version: 2
name: tokens-abort
params:
  files: { type: array, items: { type: string } }
budget: { max_tokens: 50 }
steps:
  - id: review
    map:
      over: \${{ params.files }}
      concurrency: 2
      unit:
        instructions: Review \${{ item }} carefully.
`,
    );
    const started = await startWorkflowRun("workflows/tokens-abort", { files: ["fast.ts", "slow.ts"] });

    let sawAbort = false;
    // Handshake: the fast unit only reports its over-ceiling usage AFTER the
    // slow unit is in flight with its abort listener registered, so the test
    // deterministically exercises abort-of-in-flight-work.
    let slowRegistered!: () => void;
    const slowReady = new Promise<void>((resolve) => {
      slowRegistered = resolve;
    });
    const result = await runWorkflowSteps({
      target: started.run.id,
      summaryJudge: null,
      dispatcher: async (req: UnitDispatchRequest): Promise<UnitDispatchResult> => {
        // Match the resolved instruction line — the preamble embeds the full
        // params JSON, so a bare "fast.ts" check would match BOTH prompts.
        if (req.prompt.includes("Review fast.ts")) {
          await slowReady;
          // Crossing the ceiling must abort the still-running sibling.
          return { ok: true, text: "reviewed fast", usage: { inputTokens: 60 } };
        }
        // The slow unit only finishes when its dispatch signal aborts (with a
        // timer fallback so a broken implementation fails assertions instead
        // of hanging the test).
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 3_000);
          req.signal?.addEventListener(
            "abort",
            () => {
              sawAbort = true;
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
          slowRegistered();
        });
        return { ok: false, text: "", failureReason: "aborted", error: "aborted by budget ceiling" };
      },
    });

    expect(sawAbort).toBe(true);
    expect(result.run.status).toBe("failed");
    expect(result.executed[0]?.summary).toContain("budget exceeded (max_tokens ceiling)");
  });

  test("seeding: journaled token spend from prior invocations counts against max_tokens", async () => {
    writeProgram("tokens-seeded", TWO_STEPS("budget: { max_tokens: 100 }"));
    const started = await startWorkflowRun("workflows/tokens-seeded", {});

    const first = await runWorkflowSteps({
      target: started.run.id,
      maxSteps: 1,
      summaryJudge: null,
      dispatcher: async () => ({ ok: true, text: "one done", usage: { inputTokens: 40 } }),
    });
    expect(first.executed[0]?.ok).toBe(true);

    // Simulate a prior invocation having spent more than the ceiling.
    execOnWorkflowDb("UPDATE workflow_run_units SET tokens = 150 WHERE run_id = ?", started.run.id);

    let dispatches = 0;
    const second = await runWorkflowSteps({
      target: started.run.id,
      summaryJudge: null,
      dispatcher: async () => {
        dispatches++;
        return { ok: true, text: "must not run" };
      },
    });

    // The journal-seeded 150 tokens already exceed max_tokens: nothing
    // dispatches, and the failure names the tokens ceiling with the total.
    expect(dispatches).toBe(0);
    expect(second.run.status).toBe("failed");
    expect(second.executed[0]?.summary).toContain("budget exceeded (max_tokens ceiling)");
    expect(second.executed[0]?.summary).toContain("150 token(s)");
  });
});

describe("budget interactions", () => {
  test("a workflow without a budget block is unchanged: huge usage and full fan-out complete fine", async () => {
    writeProgram("no-budget", FAN_OUT_3(""));
    const started = await startWorkflowRun("workflows/no-budget", { files: ["a.ts", "b.ts", "c.ts"] });

    const signals: Array<AbortSignal | undefined> = [];
    const result = await runWorkflowSteps({
      target: started.run.id,
      summaryJudge: null,
      dispatcher: async (req): Promise<UnitDispatchResult> => {
        signals.push(req.signal);
        return { ok: true, text: "reviewed", usage: { inputTokens: 1_000_000_000 } };
      },
    });

    expect(result.done).toBe(true);
    expect(result.run.status).toBe("completed");
    expect(signals).toHaveLength(3);
    // No budget → no budget-chained AbortController, but a leased engine run
    // ALWAYS threads the lease-heartbeat's signal into dispatch so a lost lease
    // can abort in-flight units (P1 fix). It stays UNaborted through a healthy
    // run — the units simply never observe an abort.
    expect(signals.every((s) => s !== undefined && !s.aborted)).toBe(true);
  });

  test("budget + on_error: continue still fails the step hard, naming the ceiling", async () => {
    writeProgram("continue-capped", FAN_OUT_3("budget: { max_units: 1 }", "        on_error: continue"));
    const started = await startWorkflowRun("workflows/continue-capped", { files: ["a.ts", "b.ts"] });

    let dispatches = 0;
    const result = await runWorkflowSteps({
      target: started.run.id,
      summaryJudge: null,
      dispatcher: async () => {
        dispatches++;
        return { ok: true, text: "reviewed" };
      },
    });

    expect(dispatches).toBe(1);
    expect(result.run.status).toBe("failed");
    expect(result.executed[0]?.ok).toBe(false);
    // on_error: continue tolerates UNIT failures; a budget ceiling is a step
    // failure regardless of policy.
    expect(result.executed[0]?.summary).toContain("budget exceeded (max_units ceiling)");
  });
});

/**
 * Budget × gate loops (attempts accounting across the bounded loop): a gate
 * rejection re-executes the step subgraph, and every loop's re-dispatch is a
 * REAL dispatch that must count against `budget.max_units` / `budget.max_tokens`
 * (the engine threads `unitsDispatched` / `tokensUsed` across loops). A ceiling
 * reached DURING a gate loop fails the step HARD — it must not silently spend
 * another loop, and the budget backstop overrides both `gate.max_loops` and
 * `on_error`.
 */
describe("budget × gate loops", () => {
  const GATE_LOOP_WF = (budgetLine: string, unitExtra = ""): string => `version: 2
name: gate-budget
${budgetLine}
steps:
  - id: work
    title: Work
    unit:
      instructions: Do the work.
${unitExtra}    gate:
      criteria: [the work is thorough]
      max_loops: 3
`;

  const rejectJudge = async () =>
    JSON.stringify({ complete: false, missing: ["the work is thorough"], feedback: "Go deeper." });

  test("loop re-dispatches count against max_units; a ceiling hit DURING a gate loop fails hard, not another loop", async () => {
    writeProgram("gate-units-capped", GATE_LOOP_WF("budget: { max_units: 2 }"));
    const started = await startWorkflowRun("workflows/gate-units-capped", {});

    let dispatches = 0;
    let judgeCalls = 0;
    const result = await runWorkflowSteps({
      target: started.run.id,
      dispatcher: async (): Promise<UnitDispatchResult> => {
        dispatches++;
        return { ok: true, text: "meh" };
      },
      summaryJudge: async () => {
        judgeCalls++;
        return rejectJudge();
      },
    });

    // loop 1 dispatches (used 1), loop 2 re-dispatches (used 2 = the ceiling),
    // loop 3's re-dispatch is REFUSED before running — the step fails hard.
    expect(dispatches).toBe(2);
    expect(judgeCalls).toBe(2); // loop 3 never reached the judge
    expect(result.run.status).toBe("failed");
    // Failed via the BUDGET backstop, not gate exhaustion — no gateRejection.
    expect(result.gateRejection).toBeUndefined();
    const last = result.executed[result.executed.length - 1];
    expect(last?.ok).toBe(false);
    expect(last?.summary).toContain("budget exceeded (max_units ceiling)");

    // Only the two real dispatch rows exist (loop 1's base + loop 2's ~l2); the
    // refused loop-3 attempt journaled nothing.
    const dispatchRows = (await withWorkflowRunsRepo((repo) => repo.getUnitsForRun(started.run.id))).filter(
      (u) => u.phase !== "gate",
    );
    expect(dispatchRows).toHaveLength(2);
  });

  test("budget + on_error: continue during a gate loop STILL fails hard, naming the ceiling", async () => {
    writeProgram("gate-continue-capped", GATE_LOOP_WF("budget: { max_units: 2 }", "      on_error: continue\n"));
    const started = await startWorkflowRun("workflows/gate-continue-capped", {});

    let dispatches = 0;
    const result = await runWorkflowSteps({
      target: started.run.id,
      dispatcher: async (): Promise<UnitDispatchResult> => {
        dispatches++;
        return { ok: true, text: "meh" };
      },
      summaryJudge: rejectJudge,
    });

    expect(dispatches).toBe(2);
    expect(result.run.status).toBe("failed");
    // on_error: continue softens UNIT failures — a budget ceiling is a hard
    // STEP failure regardless, even mid-gate-loop.
    expect(result.executed[result.executed.length - 1]?.summary).toContain("budget exceeded (max_units ceiling)");
  });

  test("loop re-dispatch tokens count against max_tokens; crossing the ceiling DURING a gate loop fails hard", async () => {
    writeProgram("gate-tokens-capped", GATE_LOOP_WF("budget: { max_tokens: 100 }"));
    const started = await startWorkflowRun("workflows/gate-tokens-capped", {});

    let dispatches = 0;
    let judgeCalls = 0;
    const result = await runWorkflowSteps({
      target: started.run.id,
      dispatcher: async (): Promise<UnitDispatchResult> => {
        dispatches++;
        return { ok: true, text: "meh", usage: { inputTokens: 60 } };
      },
      summaryJudge: async () => {
        judgeCalls++;
        return rejectJudge();
      },
    });

    // loop 1: 60 tokens (< 100) → gate reject → loop 2. loop 2's dispatch pushes
    // the run total to 120, crossing max_tokens: the step fails hard before its
    // gate is even judged.
    expect(dispatches).toBe(2);
    expect(judgeCalls).toBe(1);
    expect(result.run.status).toBe("failed");
    expect(result.gateRejection).toBeUndefined();
    expect(result.executed[result.executed.length - 1]?.summary).toContain("budget exceeded (max_tokens ceiling)");
  });
});
