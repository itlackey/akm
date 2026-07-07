// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { resolveStorageLocations } from "../../src/storage/locations";
import { withWorkflowRunsRepo } from "../../src/storage/repositories/workflow-runs-repository";
import { closeWorkflowDatabase, openWorkflowDatabase } from "../../src/workflows/db";
import type { UnitDispatchRequest, UnitDispatchResult } from "../../src/workflows/exec/native-executor";
import { runWorkflowSteps } from "../../src/workflows/exec/run-workflow";
import type { WorkflowPlanGraph } from "../../src/workflows/ir/schema";
import { startWorkflowRun } from "../../src/workflows/runtime/runs";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../_helpers/sandbox";

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

const FAN_OUT_3 = (budgetYaml: string, unitExtra = ""): string => `version: 1
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

const TWO_STEPS = (budgetYaml: string): string => `version: 1
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
    const started = await startWorkflowRun("workflow:units-capped", { files: ["a.ts", "b.ts", "c.ts"] });

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

  test("seeding: journaled dispatches from a prior invocation count against max_units", async () => {
    writeProgram("units-seeded", TWO_STEPS("budget: { max_units: 1 }"));
    const started = await startWorkflowRun("workflow:units-seeded", {});

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
    const started = await startWorkflowRun("workflow:tokens-capped", { files: ["a.ts", "b.ts", "c.ts"] });

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
    writeProgram(
      "tokens-abort",
      `version: 1
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
    const started = await startWorkflowRun("workflow:tokens-abort", { files: ["fast.ts", "slow.ts"] });

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
      maxConcurrency: 2,
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
    const started = await startWorkflowRun("workflow:tokens-seeded", {});

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
    const started = await startWorkflowRun("workflow:no-budget", { files: ["a.ts", "b.ts", "c.ts"] });

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
    // No budget → no chained AbortController: the units see no signal at all
    // (none was passed into this invocation).
    expect(signals.every((s) => s === undefined)).toBe(true);
  });

  test("budget + on_error: continue still fails the step hard, naming the ceiling", async () => {
    writeProgram("continue-capped", FAN_OUT_3("budget: { max_units: 1 }", "        on_error: continue"));
    const started = await startWorkflowRun("workflow:continue-capped", { files: ["a.ts", "b.ts"] });

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
