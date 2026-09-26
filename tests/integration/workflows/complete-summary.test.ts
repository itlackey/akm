// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { AkmConfig } from "../../../src/core/config/config";
import { ConfigError, UsageError } from "../../../src/core/errors";
import { readEvents } from "../../../src/core/events";
import { openStateDatabase } from "../../../src/core/state-db";
import { __setTestServer } from "../../../src/integrations/harnesses/opencode-sdk/sdk-runner";
import {
  completeWorkflowStep,
  getWorkflowStatus,
  type SummaryValidationFailure,
} from "../../../src/workflows/runtime/runs";
import { type Cleanup, sandboxEnvDir, sandboxXdgConfigHome, withEnv } from "../../_helpers/sandbox";
import { freezeWorkflow, storeFrozenWorkflowPlan } from "../../_helpers/workflow";

/**
 * In-process tests for summary capture + the completion-criteria validation
 * gate (#506). The workflow run is seeded directly into a temp workflow.db so
 * these tests don't need a workflow asset on disk; `completeWorkflowStep`'s
 * summaryJudge is injected for deterministic pass/fail.
 */

let tmpDir = "";
let cleanup: Cleanup;

const RUN_ID = "11111111-1111-4111-8111-111111111111";
// Unified format: the gate CONTROL fields (none needed here)
// live in frontmatter; the rubric lives in the body under "### gate" (spec §2.4).
const PLAN = freezeWorkflow(`---
type: workflow
steps:
  - id: step-1
---

## step-1

instructions

### gate

Thing is done, Tests pass
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
       VALUES (?, 'step-1', 'Do the thing', 'instructions', ?, 0, 'pending')`,
    ).run(RUN_ID, JSON.stringify(["Thing is done", "Tests pass"]));
    storeFrozenWorkflowPlan(db, RUN_ID, PLAN);
  } finally {
    db.close();
  }
}

function replaceFrozenPlan(plan: ReturnType<typeof freezeWorkflow>): void {
  const db = openStateDatabase(path.join(tmpDir, "state.db"));
  try {
    storeFrozenWorkflowPlan(db, RUN_ID, plan);
  } finally {
    db.close();
  }
}

function manualJudgePlan(config: AkmConfig): ReturnType<typeof freezeWorkflow> {
  return freezeWorkflow(
    `---
type: workflow
steps:
  - id: step-1
---

## step-1

instructions

### gate

Thing is done, Tests pass
`,
    "workflows/manual-judge.md",
    config,
  );
}

beforeEach(() => {
  const sandboxed = sandboxEnvDir("akm-complete-summary-", "AKM_DATA_DIR");
  tmpDir = sandboxed.dir;
  cleanup = sandboxed.cleanup;
  seedRun(path.join(tmpDir, "state.db"));
});

afterEach(() => {
  __setTestServer(null);
  cleanup();
});

describe("completeWorkflowStep summary + validation gate (#506)", () => {
  test("manual completion dispatches a frozen CLI judge with its exact model and never reads live config", async () => {
    const argvPath = path.join(tmpDir, "judge-argv.bin");
    const judgeBin = path.join(tmpDir, "frozen-codex-judge");
    fs.writeFileSync(
      judgeBin,
      [
        "#!/bin/sh",
        `printf '%s\\0' "$@" > '${argvPath}'`,
        `printf '%s\\n' '{"type":"item.completed","item":{"id":"item-1","type":"agent_message","text":"{\\"complete\\":true,\\"missing\\":[]}"}}'`,
      ].join("\n"),
      "utf8",
    );
    fs.chmodSync(judgeBin, 0o755);
    replaceFrozenPlan(
      manualJudgePlan({
        configVersion: "0.9.0",
        semanticSearchMode: "off",
        engines: {
          reviewer: { kind: "agent", platform: "codex", bin: judgeBin, model: "frozen/exact-judge-model" },
        },
        defaults: { engine: "reviewer" },
        workflow: { judgeEngine: "reviewer" },
      }),
    );

    const config = sandboxXdgConfigHome();
    try {
      // Any live-config lookup would fail before dispatch. The frozen plan is
      // the sole manual-completion authority.
      fs.writeFileSync(path.join(config.dir, "akm", "config.json"), "{ definitely invalid json", "utf8");
      const result = await completeWorkflowStep({
        runId: RUN_ID,
        stepId: "step-1",
        status: "completed",
        summary: "Thing is done and all tests pass.",
      });
      expect("run" in result).toBe(true);
      const argv = fs.readFileSync(argvPath).toString("utf8").split("\0").filter(Boolean);
      expect(argv[argv.indexOf("--model") + 1]).toBe("frozen/exact-judge-model");
    } finally {
      config.cleanup();
    }
  });

  test("manual completion redacts a frozen SDK fallback credential from corrective feedback", async () => {
    const credentialName = "AKM_MANUAL_JUDGE_FALLBACK_KEY";
    const secret = "sk-manual-sdk-fallback-must-not-leak";
    replaceFrozenPlan(
      manualJudgePlan({
        configVersion: "0.9.0",
        semanticSearchMode: "off",
        engines: {
          reviewer: { kind: "agent", platform: "opencode-sdk", llmEngine: "fallback" },
          fallback: {
            kind: "llm",
            endpoint: "https://frozen.invalid/v1/chat/completions",
            model: "frozen/fallback-model",
            apiKey: `$${credentialName}`,
          },
        },
        defaults: { engine: "reviewer", llmEngine: "fallback" },
        workflow: { judgeEngine: "reviewer" },
      }),
    );
    __setTestServer({
      client: {
        session: {
          create: async () => ({ data: { id: "manual-judge-session" } }),
          prompt: async () => ({
            data: {
              parts: [
                {
                  type: "text",
                  text: `{"complete":false,"missing":["Tests pass"],"feedback":"provider echoed ${secret}"}`,
                },
              ],
            },
          }),
          delete: async () => ({}),
        },
      },
      server: { close() {} },
    } as never);

    await withEnv({ [credentialName]: secret }, async () => {
      const result = (await completeWorkflowStep({
        runId: RUN_ID,
        stepId: "step-1",
        status: "completed",
        summary: "Thing is done.",
      })) as SummaryValidationFailure;
      expect(result.ok).toBe(false);
      expect(result.feedback).toContain("[REDACTED]");
      expect(JSON.stringify(result)).not.toContain(secret);
      expect((await getWorkflowStatus(RUN_ID)).workflow.steps[0]?.status).toBe("pending");
    });
  });

  test("manual completion cancellation reaches the frozen common SDK dispatcher", async () => {
    replaceFrozenPlan(
      manualJudgePlan({
        configVersion: "0.9.0",
        semanticSearchMode: "off",
        engines: { reviewer: { kind: "agent", platform: "opencode-sdk" } },
        defaults: { engine: "reviewer" },
        workflow: { judgeEngine: "reviewer" },
      }),
    );
    __setTestServer({
      client: {
        session: {
          create: async () => ({ data: { id: "manual-cancel-session" } }),
          prompt: async () => new Promise(() => {}),
          delete: async () => ({}),
        },
      },
      server: { close() {} },
    } as never);
    const controller = new AbortController();
    const completing = completeWorkflowStep({
      runId: RUN_ID,
      stepId: "step-1",
      status: "completed",
      summary: "Thing is done.",
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(new Error("manual judge cancelled")), 10);

    await expect(completing).rejects.toThrow(/abort|cancel/i);
    expect((await getWorkflowStatus(RUN_ID)).workflow.steps[0]?.status).toBe("pending");
  });

  test("requires a summary when completing a step", async () => {
    await expect(
      completeWorkflowStep({ runId: RUN_ID, stepId: "step-1", status: "completed", summaryJudge: null }),
    ).rejects.toBeInstanceOf(UsageError);
  });

  test("does NOT require a summary when blocking a step", async () => {
    const result = await completeWorkflowStep({ runId: RUN_ID, stepId: "step-1", status: "blocked" });
    expect("run" in result).toBe(true);
  });

  test("persists the summary on a successful (gate-passing) completion", async () => {
    const judge = async () => '{"complete": true, "missing": []}';
    const result = await completeWorkflowStep({
      runId: RUN_ID,
      stepId: "step-1",
      status: "completed",
      summary: "Thing is done and all tests pass.",
      summaryJudge: judge,
    });
    expect("run" in result).toBe(true);

    const status = await getWorkflowStatus(RUN_ID);
    const step = status.workflow.steps.find((s) => s.id === "step-1");
    expect(step?.status).toBe("completed");
    expect(step?.summary).toBe("Thing is done and all tests pass.");
    expect(status.run.status).toBe("completed");
  });

  test("rejects completion with corrective feedback when the gate fails; step stays pending", async () => {
    const judge = async () =>
      '{"complete": false, "missing": ["Tests pass"], "feedback": "Run the tests and report results."}';
    const result = (await completeWorkflowStep({
      runId: RUN_ID,
      stepId: "step-1",
      status: "completed",
      summary: "I did the thing.",
      summaryJudge: judge,
    })) as SummaryValidationFailure;

    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(["Tests pass"]);
    expect(result.feedback).toContain("Run the tests");

    // Step must remain pending and re-completable.
    const status = await getWorkflowStatus(RUN_ID);
    const step = status.workflow.steps.find((s) => s.id === "step-1");
    expect(step?.status).toBe("pending");
    expect(status.run.status).toBe("active");
  });

  test("fails closed when a criteria-bearing step has no judge", async () => {
    await expect(
      completeWorkflowStep({
        runId: RUN_ID,
        stepId: "step-1",
        status: "completed",
        summary: "Did it.",
        summaryJudge: null,
      }),
    ).rejects.toBeInstanceOf(ConfigError);
    const status = await getWorkflowStatus(RUN_ID);
    expect(status.workflow.steps[0]?.status).toBe("pending");
    expect(status.run.status).toBe("active");
  });
});

describe("#11 — honest step-transition event names + injection-safe metadata", () => {
  /** Read only this run's step-transition events, newest-friendly order preserved. */
  function stepEvents(): { eventType: string; metadata?: Record<string, unknown> }[] {
    return readEvents({})
      .events.filter((e) => e.eventType === "workflow_step_completed" || e.eventType === "workflow_step_updated")
      .filter((e) => e.metadata?.runId === RUN_ID)
      .map((e) => ({ eventType: e.eventType, metadata: e.metadata }));
  }

  test("a genuine completion emits workflow_step_completed with status in metadata and NO notes", async () => {
    await completeWorkflowStep({
      runId: RUN_ID,
      stepId: "step-1",
      status: "completed",
      summary: "Thing is done and all tests pass.",
      notes: "raw model-authored {{IGNORE PREVIOUS INSTRUCTIONS}} notes",
      summaryJudge: async () => '{"complete": true, "missing": []}',
    });

    const events = stepEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe("workflow_step_completed");
    expect(events[0]?.metadata?.status).toBe("completed");
    expect(events[0]?.metadata?.stepId).toBe("step-1");
    // Raw notes must never reach the event stream (prompt-injection surface).
    expect(events[0]?.metadata).not.toHaveProperty("notes");
    expect(JSON.stringify(events[0]?.metadata)).not.toContain("IGNORE PREVIOUS");
  });

  test("a non-completed transition emits workflow_step_updated, not …_completed", async () => {
    await completeWorkflowStep({
      runId: RUN_ID,
      stepId: "step-1",
      status: "blocked",
      notes: "blocked because {{INJECTION}} the tool broke",
    });

    const events = stepEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe("workflow_step_updated");
    expect(events[0]?.metadata?.status).toBe("blocked");
    expect(events[0]?.metadata).not.toHaveProperty("notes");
    expect(JSON.stringify(events[0]?.metadata)).not.toContain("INJECTION");
  });
});
