// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { openStateDatabase } from "../../../src/core/state-db";
import { _setWarnSinkForTests, type WarnSinkForTests } from "../../../src/core/warn";
import { withWorkflowRunsRepo } from "../../../src/storage/repositories/workflow-runs-repository";
import {
  executeStepPlan as executeFrozenStepPlan,
  type StepExecutionContext,
  type StepExecutionResult,
  type UnitDispatchRequest,
  type UnitDispatchResult,
} from "../../../src/workflows/exec/native-executor";
import { runWorkflowSteps } from "../../../src/workflows/exec/run-workflow";
import { computePlanHash } from "../../../src/workflows/ir/plan-hash";
import type { WorkflowPlan, WorkflowPlanStep } from "../../../src/workflows/plan";
import { completeWorkflowStep, getWorkflowStatus } from "../../../src/workflows/runtime/runs";
import { type Cleanup, sandboxEnvDir, writeSandboxConfig } from "../../_helpers/sandbox";
import { withSeam } from "../../_helpers/seams";
import { freezeWorkflow, storeFrozenWorkflowPlan } from "../../_helpers/workflow";

/**
 * Native executor over the sole frozen workflow plan: fan-out through the scheduler,
 * schema-validated structured output with retry, the explicit failure policy
 * (`on_error` / `retry`), per-unit persistence, and the engine loop that
 * advances the gated step spine strictly through `completeWorkflowStep`.
 *
 * All dispatch goes through an injected fake dispatcher — no agent binaries,
 * no LLM. The workflow DB is a sandboxed tmp dir via AKM_DATA_DIR. Plans come
 * from the shared source IR (`compileWorkflowSource` + `compileWorkflowPlan`
 * via the `freezeWorkflow` helper). Markdown and GitHub-shaped YAML are peer
 * authoring formats for that one compiler/runtime architecture.
 *
 * SEMANTIC CHANGE (workflow-format-unification, spec §2.3): instructions are
 * byte-exact prose everywhere now — there is no more `${{ item }}` / `${{
 * params.x }}` substitution INTO the instructions text. A map unit's item +
 * index reach it as ATTACHED CONTEXT instead (a "## Item (index N)" block
 * `buildUnitPrompt` appends, `src/workflows/exec/step-work.ts`), addressed by
 * its canonical JSON — never spliced into prose. Tests that used to assert a
 * SUBSTITUTED prompt string (`"Review a.ts carefully."`) now assert the
 * canonical-JSON item block instead (`'"a.ts"'`), with a comment marking the
 * change; a couple of tests whose entire premise was substitution-only are
 * replaced with the closest equivalent and reported where none exists (see
 * inline SUSPECTED SRC BEHAVIOR / DELETED notes below).
 */

let tmpDir = "";
let cleanup: Cleanup;

const RUN_ID = "44444444-4444-4444-8444-444444444444";

function seedRun(opts: { params?: Record<string, unknown>; steps: Array<{ id: string; title: string }> }): void {
  const db = openStateDatabase(path.join(tmpDir, "state.db"));
  try {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO workflow_runs
         (id, workflow_ref, scope_key, workflow_entry_id, workflow_title, status,
          params_json, current_step_id, created_at, updated_at)
       VALUES (?, 'workflows/demo', 'dir:v1:demo', NULL, 'Demo', 'active', ?, ?, ?, ?)`,
    ).run(RUN_ID, JSON.stringify(opts.params ?? {}), opts.steps[0]!.id, now, now);
    opts.steps.forEach((step, i) => {
      db.prepare(
        `INSERT INTO workflow_run_steps
           (run_id, step_id, step_title, instructions, completion_json, sequence_index, status)
         VALUES (?, ?, ?, 'instructions', NULL, ?, 'pending')`,
      ).run(RUN_ID, step.id, step.title, i);
    });
  } finally {
    db.close();
  }
}

function plan(markdown: string): WorkflowPlan {
  return freezeWorkflow(markdown);
}

function executeStepPlan(step: WorkflowPlanStep, ctx: StepExecutionContext): Promise<StepExecutionResult> {
  return executeFrozenStepPlan(step, ctx);
}

function usePlan(markdown: string): () => Promise<WorkflowPlan> {
  return useFrozenPlan(plan(markdown));
}

function useFrozenPlan(frozen: WorkflowPlan): () => Promise<WorkflowPlan> {
  const db = openStateDatabase(path.join(tmpDir, "state.db"));
  try {
    storeFrozenWorkflowPlan(db, RUN_ID, frozen);
  } finally {
    db.close();
  }
  return async () => JSON.parse(JSON.stringify(frozen)) as WorkflowPlan;
}

beforeEach(() => {
  const sandboxed = sandboxEnvDir("akm-native-exec-", "AKM_DATA_DIR");
  tmpDir = sandboxed.dir;
  cleanup = sandboxed.cleanup;
});

afterEach(() => {
  cleanup();
});

const SOLO_WF = `---
type: workflow
steps:
  - id: fetch
---

## fetch

Fetch the thing.
`;

function mutateDb(sql: string, ...params: unknown[]): void {
  const db = openStateDatabase(path.join(tmpDir, "state.db"));
  try {
    db.prepare(sql).run(...(params as never[]));
  } finally {
    db.close();
  }
}

async function captureWarns<T>(run: () => Promise<T>): Promise<{ result: T; warns: string[] }> {
  const warns: string[] = [];
  const result = await withSeam(
    _setWarnSinkForTests,
    ((level, args) => {
      if (level === "warn") warns.push(args.map(String).join(" "));
    }) as WarnSinkForTests,
    run,
  );
  return { result, warns };
}

const FAN_OUT_WF = `---
type: workflow
params:
  files: { type: array }
steps:
  - id: review
    map:
      over: params.files
      concurrency: 4
---

## review

Review the assigned item carefully.
`;

describe("executeStepPlan — fan-out", () => {
  test("caps SDK fan-out by the frozen fallback LLM engine concurrency", async () => {
    seedRun({ params: { files: ["a", "b", "c", "d"] }, steps: [{ id: "review", title: "Review files" }] });
    const stepPlan = plan(FAN_OUT_WF).steps[0]!;
    let inFlight = 0;
    let peak = 0;

    const result = await executeStepPlan(stepPlan, {
      runId: RUN_ID,
      workflowRef: "workflows/demo",
      params: { files: ["a", "b", "c", "d"] },
      evidence: {},
      maxConcurrency: 4,
      dispatcher: async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight--;
        return { ok: true, text: "reviewed" };
      },
    });

    expect(result.ok).toBe(true);
    expect(peak).toBe(1);
  });

  test("dispatches one unit per item over params.files, attaches the item as context, persists unit rows", async () => {
    seedRun({ params: { files: ["a.ts", "b.ts", "c.ts"] }, steps: [{ id: "review", title: "Review files" }] });
    const prompts: string[] = [];
    const dispatcher = async (req: UnitDispatchRequest): Promise<UnitDispatchResult> => {
      prompts.push(req.prompt);
      return { ok: true, text: `reviewed ${req.unitId}` };
    };

    const stepPlan = plan(FAN_OUT_WF).steps[0]!;
    const result = await executeStepPlan(stepPlan, {
      runId: RUN_ID,
      workflowRef: "workflows/demo",
      params: { files: ["a.ts", "b.ts", "c.ts"] },
      evidence: {},
      dispatcher,
    });

    expect(result.ok).toBe(true);
    expect(result.units).toHaveLength(3);
    // Item reaches the unit as ATTACHED CONTEXT (canonical JSON), never
    // spliced into the instructions text.
    expect(prompts.some((p) => p.includes('"a.ts"'))).toBe(true);
    expect(prompts.every((p) => p.includes(RUN_ID))).toBe(true); // preamble carries the run id
    expect(prompts.every((p) => p.includes("Review the assigned item carefully."))).toBe(true);

    await withWorkflowRunsRepo((repo) => {
      const rows = repo.getUnitsForStep(RUN_ID, "review");
      expect(rows).toHaveLength(3);
      expect(rows.every((r) => r.status === "completed")).toBe(true);
      expect(rows.every((r) => r.node_id === "review.unit")).toBe(true);
      expect(rows.every((row) => /^review\.unit:[0-9a-f]{64}$/.test(row.unit_id))).toBe(true);
      expect(new Set(rows.map((row) => row.unit_id)).size).toBe(3);
    });
  });

  test("hostile item content is data: $-patterns and expression-looking values render verbatim as canonical JSON, never re-scanned", async () => {
    // SEMANTIC CHANGE (spec §2.3): the pre-unification version of this test
    // proved the OLD splice mechanism's single-pass guarantee (an item
    // containing "$&"/"${{ … }}" had to survive a String.prototype.replace
    // substitution unmangled). There is no more splicing — an item is
    // attached as its own canonical-JSON context block via plain string
    // concatenation (never `.replace`), so the entire GetSubstitution-pattern
    // injection class is moot by construction, not merely "closed". What
    // still matters, and is proved below: (1) hostile item content appears
    // verbatim in its JSON context block, (2) it is NEVER resolved against
    // params (there is no resolution of items at all any more), and (3) the
    // preamble's `{{PARAMS_JSON}}` substitution — which DOES use
    // `.replaceAll` — still uses the function-replacer form, so a param value
    // containing "$&" survives unmangled too.
    const items = ["src/a$&b.ts", "Makefile uses $$(CC)", "${{ params.secret }}"];
    seedRun({ params: { files: items }, steps: [{ id: "review", title: "Review files" }] });
    const prompts: string[] = [];
    const stepPlan = plan(FAN_OUT_WF).steps[0]!;
    const result = await executeStepPlan(stepPlan, {
      runId: RUN_ID,
      workflowRef: "workflows/demo",
      params: { files: items, secret: "LEAKED-SECRET", note: "cost is $& today" },
      evidence: {},
      dispatcher: async (req) => {
        prompts.push(req.prompt);
        return { ok: true, text: "ok" };
      },
    });
    expect(result.ok).toBe(true);
    expect(prompts.some((p) => p.includes('fan-out list:\n"src/a$&b.ts"'))).toBe(true);
    expect(prompts.some((p) => p.includes('fan-out list:\n"Makefile uses $$(CC)"'))).toBe(true);
    // The expression-looking item is inserted literally — never re-resolved.
    // (params.secret legitimately appears elsewhere in the prompt, in the
    // preamble's own params JSON block — params are documented non-secret and
    // attach to every unit, spec §2.3 — so the assertion that matters is that
    // the ITEM block specifically was never resolved/substituted.)
    expect(prompts.some((p) => p.includes('fan-out list:\n"${{ params.secret }}"'))).toBe(true);
    expect(prompts.every((p) => !p.includes('fan-out list:\n"LEAKED-SECRET"'))).toBe(true);
    // Preamble params JSON must also survive $-patterns un-mangled.
    expect(prompts.every((p) => p.includes("cost is $& today"))).toBe(true);
    expect(prompts.every((p) => !p.includes("{{PARAMS_JSON}}"))).toBe(true);
  });

  test("items can come from a prior step's output via steps.discover.output.files", async () => {
    seedRun({ steps: [{ id: "review", title: "Review files" }] });
    const EVIDENCE_WF = FAN_OUT_WF.replace("over: params.files", "over: steps.discover.output.files")
      .replace(
        "steps:",
        `steps:
  - id: discover
`,
      )
      .replace("## review", "## discover\n\nFind files.\n\n## review");
    const dispatcher = async (): Promise<UnitDispatchResult> => ({ ok: true, text: "done" });
    const stepPlan = plan(EVIDENCE_WF).steps.find((s) => s.stepId === "review")!;
    if (!stepPlan) throw new Error("missing review step");
    const result = await executeStepPlan(stepPlan, {
      runId: RUN_ID,
      workflowRef: "workflows/demo",
      params: {},
      // Evidence WITHOUT an `output` key (e.g. a manually-completed step):
      // the recorded evidence object itself is the step output.
      evidence: { discover: { files: ["x.ts", "y.ts"] } },
      dispatcher,
    });
    expect(result.units).toHaveLength(2);
  });

  test("step-output references never resolve from Object.prototype (own properties only)", async () => {
    seedRun({ steps: [{ id: "review", title: "Review files" }] });
    const TOSTRING_WF = FAN_OUT_WF.replace("over: params.files", "over: steps.prior.output.toString")
      .replace(
        "steps:",
        `steps:
  - id: prior
`,
      )
      .replace("## review", "## prior\n\nPrior.\n\n## review");
    const stepPlan = plan(TOSTRING_WF).steps.find((s) => s.stepId === "review")!;
    if (!stepPlan) throw new Error("missing review step");
    const result = await executeStepPlan(stepPlan, {
      runId: RUN_ID,
      workflowRef: "workflows/demo",
      params: {},
      evidence: { prior: { unrelated: true } },
      dispatcher: async () => ({ ok: true, text: "must not run" }),
    });
    expect(result.ok).toBe(false);
    expect(result.summary).toContain("missing");
  });

  test("a non-array fan-out source fails the step with a clear error", async () => {
    seedRun({ params: { files: "not-a-list" }, steps: [{ id: "review", title: "Review files" }] });
    const stepPlan = plan(FAN_OUT_WF).steps[0]!;
    const result = await executeStepPlan(stepPlan, {
      runId: RUN_ID,
      workflowRef: "workflows/demo",
      params: { files: "not-a-list" },
      evidence: {},
      dispatcher: async () => ({ ok: true, text: "unused" }),
    });
    expect(result.ok).toBe(false);
    expect(result.summary).toContain("params.files");
    expect(result.summary).toContain("not an array");
  });

  test("unit failures are recorded with their failure reason and fail the step (fail-fast default)", async () => {
    seedRun({ params: { files: ["a", "b"] }, steps: [{ id: "review", title: "Review files" }] });
    const dispatcher = async (req: UnitDispatchRequest): Promise<UnitDispatchResult> =>
      req.prompt.includes('fan-out list:\n"a"')
        ? { ok: true, text: "fine" }
        : { ok: false, text: "", failureReason: "timeout", error: "timed out" };

    const stepPlan = plan(FAN_OUT_WF).steps[0]!;
    const result = await executeStepPlan(stepPlan, {
      runId: RUN_ID,
      workflowRef: "workflows/demo",
      params: { files: ["a", "b"] },
      evidence: {},
      dispatcher,
    });
    expect(result.ok).toBe(false);
    expect(result.units.filter((u) => !u.ok)).toHaveLength(1);
    await withWorkflowRunsRepo((repo) => {
      const failed = repo.getUnitsForStep(RUN_ID, "review").filter((r) => r.status === "failed");
      expect(failed).toHaveLength(1);
      expect(failed[0]!.failure_reason).toBe("timeout");
    });
  });
});

describe("executeStepPlan — fan-out item shapes (edge cases)", () => {
  test("a single-item fan-out dispatches exactly one unit and the collect artifact is a one-element array", async () => {
    seedRun({ params: { files: ["only"] }, steps: [{ id: "review", title: "Review files" }] });
    const stepPlan = plan(FAN_OUT_WF).steps[0]!;
    let dispatches = 0;
    const result = await executeStepPlan(stepPlan, {
      runId: RUN_ID,
      workflowRef: "workflows/demo",
      params: { files: ["only"] },
      evidence: {},
      dispatcher: async () => {
        dispatches++;
        return { ok: true, text: "done" };
      },
    });
    expect(result.ok).toBe(true);
    expect(dispatches).toBe(1);
    expect(result.units).toHaveLength(1);
    // A single item still reduces through `collect` — the artifact is a
    // one-element array, not the bare value.
    expect(result.evidence.output).toEqual(["done"]);
    expect(result.evidence.itemCount).toBe(1);
  });

  test("items of every JSON type each become their own unit; objects/arrays render as JSON in the item context block", async () => {
    // Numbers/booleans/strings pass through their `JSON.stringify` rendering;
    // objects/arrays render with THEIR OWN key insertion order (the item
    // context block is `JSON.stringify`, not canonically sorted — sorting is
    // reserved for content-derived unit IDENTITY, a separate concern) — one
    // distinct content-derived unit per item either way.
    const items = [1, true, "str", { b: 2, a: 1 }, [3, 4]];
    seedRun({ params: { files: items }, steps: [{ id: "review", title: "Review files" }] });
    const prompts: string[] = [];
    const stepPlan = plan(FAN_OUT_WF).steps[0]!;
    const result = await executeStepPlan(stepPlan, {
      runId: RUN_ID,
      workflowRef: "workflows/demo",
      params: { files: items },
      evidence: {},
      dispatcher: async (req) => {
        prompts.push(req.prompt);
        return { ok: true, text: "ok" };
      },
    });
    expect(result.ok).toBe(true);
    expect(result.units).toHaveLength(5);
    expect(prompts.some((p) => p.includes("fan-out list:\n1"))).toBe(true);
    expect(prompts.some((p) => p.includes("fan-out list:\ntrue"))).toBe(true);
    expect(prompts.some((p) => p.includes('fan-out list:\n"str"'))).toBe(true);
    expect(prompts.some((p) => p.includes('fan-out list:\n{"b":2,"a":1}'))).toBe(true);
    expect(prompts.some((p) => p.includes("fan-out list:\n[3,4]"))).toBe(true);
    await withWorkflowRunsRepo((repo) => {
      // Five distinct content-derived unit ids — one per item.
      expect(new Set(repo.getUnitsForStep(RUN_ID, "review").map((r) => r.unit_id)).size).toBe(5);
    });
  });

  test("a null fan-out item fails the work-list BEFORE any dispatch", async () => {
    // The pre-unification format rejected a null item incidentally (resolving
    // `${{ item }}` failed). With items attached as context instead of
    // spliced, the refactor briefly made a null item dispatch as a normal
    // unit ("Item: null") — an accidental behavioral reversal. The rejection
    // is now EXPLICIT in computeStepWorkList, same fail-before-dispatch
    // posture as the duplicate-item check: a null item is producer garbage
    // and names the producing step instead of burning an agent run on it.
    seedRun({ params: { files: [null] }, steps: [{ id: "review", title: "Review files" }] });
    const stepPlan = plan(FAN_OUT_WF).steps[0]!;
    let dispatches = 0;
    const result = await executeStepPlan(stepPlan, {
      runId: RUN_ID,
      workflowRef: "workflows/demo",
      params: { files: [null] },
      evidence: {},
      dispatcher: async () => {
        dispatches++;
        return { ok: true, text: "must never run" };
      },
    });
    expect(dispatches).toBe(0);
    expect(result.ok).toBe(false);
    expect(result.summary).toContain("null item");
    expect(result.summary).toContain("index 0");
  });

  test("duplicate fan-out items dispatch instead of failing the work-list — occurrence-suffixed unit ids (issue 6)", async () => {
    seedRun({ params: { files: ["a", "a", "b"] }, steps: [{ id: "review", title: "Review files" }] });
    const stepPlan = plan(FAN_OUT_WF).steps[0]!;
    let dispatches = 0;
    const result = await executeStepPlan(stepPlan, {
      runId: RUN_ID,
      workflowRef: "workflows/demo",
      params: { files: ["a", "a", "b"] },
      evidence: {},
      dispatcher: async () => {
        dispatches++;
        return { ok: true, text: "ok" };
      },
    });
    expect(result.ok).toBe(true);
    expect(dispatches).toBe(3);
    expect(result.units).toHaveLength(3);

    const unitIds = await withWorkflowRunsRepo((repo) => repo.getUnitsForStep(RUN_ID, "review").map((r) => r.unit_id));
    expect(new Set(unitIds).size).toBe(3);
    const suffixed = unitIds.filter((id) => id.includes("#"));
    expect(suffixed).toHaveLength(1);
    const suffixedId = suffixed[0];
    if (!suffixedId) throw new Error("expected one suffixed unit id");
    expect(suffixedId.endsWith("#2")).toBe(true);
    const base = suffixedId.slice(0, suffixedId.indexOf("#"));
    expect(unitIds).toContain(base);
  });
});

const SCHEMA_WF = `---
type: workflow
steps:
  - id: extract
    unit:
      output: { type: object, properties: { fact: { type: string } }, required: [fact] }
---

## extract

Extract facts.
`;

describe("executeStepPlan — structured output", () => {
  test("valid JSON on first attempt is parsed and stored", async () => {
    seedRun({ steps: [{ id: "extract", title: "Extract facts" }] });
    const stepPlan = plan(SCHEMA_WF).steps[0]!;
    const result = await executeStepPlan(stepPlan, {
      runId: RUN_ID,
      workflowRef: "workflows/demo",
      params: {},
      evidence: {},
      dispatcher: async () => ({ ok: true, text: '{"fact": "bun is fast"}' }),
    });
    expect(result.ok).toBe(true);
    expect(result.units[0]!.result).toEqual({ fact: "bun is fast" });
  });

  test("schema violation retries once with corrective feedback, then succeeds", async () => {
    seedRun({ steps: [{ id: "extract", title: "Extract facts" }] });
    const feedbacks: Array<string | undefined> = [];
    let call = 0;
    const dispatcher = async (_req: UnitDispatchRequest, feedback?: string): Promise<UnitDispatchResult> => {
      feedbacks.push(feedback);
      call++;
      return call === 1 ? { ok: true, text: '{"wrong": true}' } : { ok: true, text: '{"fact": "fixed"}' };
    };
    const stepPlan = plan(SCHEMA_WF).steps[0]!;
    const result = await executeStepPlan(stepPlan, {
      runId: RUN_ID,
      workflowRef: "workflows/demo",
      params: {},
      evidence: {},
      dispatcher,
    });
    expect(result.ok).toBe(true);
    expect(feedbacks[0]).toBeUndefined();
    expect(feedbacks[1]).toContain("fact");
    expect(result.units[0]!.result).toEqual({ fact: "fixed" });
  });

  test("aggregates lowering notices across corrective retries without persisting them in result_json or evidence", async () => {
    seedRun({ steps: [{ id: "extract", title: "Extract facts" }] });
    const conversationNotice = {
      code: "conversation-prompt-composed" as const,
      severity: "warning" as const,
      adapter: "codex",
      field: "conversation",
      message: "conversation was composed safely",
      details: { strategy: "system-prefix" },
    };
    const schemaNotice = {
      code: "untranslated-field" as const,
      severity: "warning" as const,
      adapter: "codex",
      field: "outputSchema",
      message: "schema was not translated",
    };
    let call = 0;
    const frozen = plan(SCHEMA_WF);
    useFrozenPlan(frozen);
    const stepPlan = frozen.steps[0]!;
    const result = await executeStepPlan(stepPlan, {
      runId: RUN_ID,
      workflowRef: "workflows/demo",
      params: {},
      evidence: {},
      dispatcher: async () => {
        call++;
        return call === 1
          ? { ok: true, text: '{"wrong":true}', notices: [conversationNotice] }
          : {
              ok: true,
              text: '{"fact":"fixed"}',
              notices: [conversationNotice, schemaNotice],
            };
      },
    });

    expect(result.ok).toBe(true);
    expect(result.units[0]!.notices).toEqual([conversationNotice, schemaNotice]);
    expect(result.notices).toEqual([conversationNotice, schemaNotice]);
    expect(JSON.stringify(result.evidence)).not.toContain("notices");

    // The durable row intentionally carries no notice field. Rehydrating a
    // completed unit therefore fabricates no live-only notice on resume.
    const resumed = await executeStepPlan(stepPlan, {
      runId: RUN_ID,
      workflowRef: "workflows/demo",
      params: {},
      evidence: {},
      dispatcher: async () => {
        throw new Error("a completed journal row must not re-dispatch");
      },
    });
    expect(resumed.ok).toBe(true);
    expect(resumed.notices).toBeUndefined();
    expect(resumed.units[0]!.notices).toBeUndefined();

    await completeWorkflowStep({
      runId: RUN_ID,
      stepId: "extract",
      status: "completed",
      evidence: result.evidence,
      summary: result.summary,
      summaryJudge: null,
    });
    await withWorkflowRunsRepo((repo) => {
      const unit = repo.getUnitsForStep(RUN_ID, "extract")[0];
      expect(unit?.result_json).toBe('{"fact":"fixed"}');
      expect(unit?.result_json).not.toContain("notices");
      const step = repo.getStep(RUN_ID, "extract");
      expect(step?.evidence_json).not.toContain("notices");
      const run = repo.getRunById(RUN_ID);
      expect(run?.plan_json).not.toContain(conversationNotice.message);
      expect(run?.plan_json).not.toContain(schemaNotice.message);
      expect(run?.plan_hash).toBe(computePlanHash(frozen));
    });
  });

  test("persistent schema violation records a validation failure", async () => {
    seedRun({ steps: [{ id: "extract", title: "Extract facts" }] });
    const stepPlan = plan(SCHEMA_WF).steps[0]!;
    const result = await executeStepPlan(stepPlan, {
      runId: RUN_ID,
      workflowRef: "workflows/demo",
      params: {},
      evidence: {},
      dispatcher: async () => ({ ok: true, text: '{"nope": 1}' }),
    });
    expect(result.ok).toBe(false);
    expect(result.units[0]!.failureReason).toBe("validation_error");
  });
});

// ── Empty free-text outputs (PR #714 comment B) ──────────────────────────────
//
// A SUCCESSFUL schemaless unit that returns "" is "no output": dispatchUnit
// drops the falsy text, finishUnitAttempt journals result_json = NULL, the promoted
// solo artifact is null, and every surface (live / resume / report) agrees
// (the EMPTY_OUTPUT driver-parity golden pins the cross-surface identity).
// These engine-side tests lock the three consequences the module doc states.

const EMPTY_WF = `---
type: workflow
steps:
  - id: build
---

## build

Build it.
`;

const EMPTY_DOWNSTREAM_WF = `---
type: workflow
steps:
  - id: build
  - id: consume
    inputs: [steps.build.output]
---

## build

Build it.

## consume

Use the previous output (declared as this step's input).
`;

describe("executeStepPlan — empty free-text output is 'no output' (PR #714 comment B)", () => {
  test("a successful empty text output journals absence (result_json NULL) and promotes a null artifact", async () => {
    seedRun({ steps: [{ id: "build", title: "Build" }] });
    const result = await executeStepPlan(plan(EMPTY_WF).steps[0]!, {
      runId: RUN_ID,
      workflowRef: "workflows/demo",
      params: {},
      evidence: {},
      dispatcher: async () => ({ ok: true, text: "" }),
    });

    expect(result.ok).toBe(true);
    // Empty == absent: no `text` on the outcome, and the promoted solo artifact is null.
    expect(result.units[0]!.ok).toBe(true);
    expect(result.units[0]!.text).toBeUndefined();
    expect((result.evidence as { output: unknown }).output).toBeNull();
    // The journal stores NULL, not '""', so durable-reuse / report rehydrate the same absence.
    await withWorkflowRunsRepo((repo) => {
      const rows = repo.getUnitsForStep(RUN_ID, "build");
      expect(rows).toHaveLength(1);
      expect(rows[0]!.status).toBe("completed");
      expect(rows[0]!.result_json).toBeNull();
    });
  });

  test("a SCHEMA unit returning an empty string fails (parse_error), never a silent null pass", async () => {
    seedRun({ steps: [{ id: "extract", title: "Extract facts" }] });
    const result = await executeStepPlan(plan(SCHEMA_WF).steps[0]!, {
      runId: RUN_ID,
      workflowRef: "workflows/demo",
      params: {},
      evidence: {},
      dispatcher: async () => ({ ok: true, text: "" }),
    });

    // Empty is not parseable JSON — it can never satisfy a declared schema as null.
    expect(result.ok).toBe(false);
    expect(result.units[0]!.ok).toBe(false);
    expect(result.units[0]!.failureReason).toBe("parse_error");
  });

  test("a downstream declared input of an empty-output step fails the WHOLE STEP deterministically (resolved to null)", async () => {
    // SEMANTIC CHANGE (spec §2.3): the pre-unification version referenced
    // `${{ steps.build.output }}` inside `consume`'s INSTRUCTIONS, which
    // failed as a PER-UNIT `expression_error` (carried on `result.units[0]`,
    // never dispatching). The unified format's equivalent surface is
    // `consume`'s declared `inputs: [steps.build.output]` — but `inputs:` is
    // resolved ONCE for the WHOLE STEP, before any unit is constructed
    // (`computeStepWorkList`, `src/workflows/exec/step-work.ts`), so an
    // unresolvable declared input is now a WHOLE-STEP failure (`result.units`
    // is empty), not a per-unit one. Reading `computeStepWorkList`'s
    // unit-construction loop confirms there is no remaining code path that
    // produces a per-unit `resolved: { ok: false }` — reported to the
    // orchestrating agent (see the identical note in `step-work.test.ts`).
    // The still-true parts of the original narrative — deterministic failure,
    // "resolved to null" in the message, zero dispatch — are preserved below.
    seedRun({
      steps: [
        { id: "build", title: "Build" },
        { id: "consume", title: "Consume" },
      ],
    });
    const wf = plan(EMPTY_DOWNSTREAM_WF);

    const build = await executeStepPlan(wf.steps[0]!, {
      runId: RUN_ID,
      workflowRef: "workflows/demo",
      params: {},
      evidence: {},
      dispatcher: async () => ({ ok: true, text: "" }),
    });
    expect(build.ok).toBe(true);
    expect((build.evidence as { output: unknown }).output).toBeNull();

    let dispatched = 0;
    const consume = await executeStepPlan(wf.steps[1]!, {
      runId: RUN_ID,
      workflowRef: "workflows/demo",
      params: {},
      // The empty step's promoted artifact (null) is the downstream scope.
      evidence: { build: build.evidence as Record<string, unknown> },
      dispatcher: async () => {
        dispatched++;
        return { ok: true, text: "must not run" };
      },
    });

    // Referencing a null artifact is a deterministic resolution failure — the
    // WHOLE STEP fails before any unit dispatches. Same on both surfaces: the
    // artifact (null) is surface-identical (EMPTY_OUTPUT golden) and the
    // work-list is the one shared pure function, so this resolution error is
    // reproduced identically.
    expect(consume.ok).toBe(false);
    expect(dispatched).toBe(0);
    expect(consume.units).toHaveLength(0);
    expect(consume.summary).toContain("resolved to null");
  });
});

const VOTE_WF = `---
type: workflow
params:
  attempts: { type: array }
steps:
  - id: judge
    map:
      over: params.attempts
      reducer: vote
      unit:
        output: { type: object, properties: { verdict: { type: string } }, required: [verdict] }
---

## judge

Judge the assigned attempt.
`;

describe("executeStepPlan — vote reducer", () => {
  test("majority verdict wins", async () => {
    seedRun({ params: { attempts: [1, 2, 3] }, steps: [{ id: "judge", title: "Judge" }] });
    let call = 0;
    const dispatcher = async (): Promise<UnitDispatchResult> => {
      call++;
      return { ok: true, text: call === 2 ? '{"verdict": "fail"}' : '{"verdict": "pass"}' };
    };
    const stepPlan = plan(VOTE_WF).steps[0]!;
    const result = await executeStepPlan(stepPlan, {
      runId: RUN_ID,
      workflowRef: "workflows/demo",
      params: { attempts: [1, 2, 3] },
      evidence: {},
      dispatcher,
      maxConcurrency: 1,
    });
    expect(result.ok).toBe(true);
    expect((result.evidence.vote as { winner: unknown }).winner).toEqual({ verdict: "pass" });
  });
});

describe("executeStepPlan — harness-native session id journaling (P2 peer review)", () => {
  test("a dispatcher-revealed sessionId is persisted on the unit row and rehydrated on reuse", async () => {
    // Peer-review regression: defaultUnitDispatcher extracts the harness
    // session id (e.g. codex `session_configured`), but it used to evaporate
    // inside dispatchUnit — never reaching workflow_run_units.session_id.
    seedRun({ steps: [{ id: "extract", title: "Extract facts" }] });
    const stepPlan = plan(SCHEMA_WF).steps[0]!;
    const ctx = { runId: RUN_ID, workflowRef: "workflows/demo", params: {}, evidence: {} };

    const first = await executeStepPlan(stepPlan, {
      ...ctx,
      dispatcher: async () => ({ ok: true, text: '{"fact": "bun is fast"}', sessionId: "codex-abc-123" }),
    });
    expect(first.ok).toBe(true);
    expect(first.units[0]!.sessionId).toBe("codex-abc-123");

    await withWorkflowRunsRepo((repo) => {
      const rows = repo.getUnitsForStep(RUN_ID, "extract");
      expect(rows).toHaveLength(1);
      expect(rows[0]!.session_id).toBe("codex-abc-123");
    });

    // Durable-row reuse rehydrates the journaled session id without re-dispatch.
    const second = await executeStepPlan(stepPlan, {
      ...ctx,
      dispatcher: async () => {
        throw new Error("must not re-dispatch");
      },
    });
    expect(second.ok).toBe(true);
    expect(second.units[0]!.sessionId).toBe("codex-abc-123");
  });

  test("a failed unit still journals the session id revealed before the failure", async () => {
    seedRun({ params: { files: ["a"] }, steps: [{ id: "review", title: "Review files" }] });
    const stepPlan = plan(FAN_OUT_WF).steps[0]!;
    const result = await executeStepPlan(stepPlan, {
      runId: RUN_ID,
      workflowRef: "workflows/demo",
      params: { files: ["a"] },
      evidence: {},
      dispatcher: async () => ({
        ok: false,
        text: "",
        failureReason: "timeout",
        error: "timed out",
        sessionId: "sess-before-crash",
      }),
    });
    expect(result.ok).toBe(false);
    await withWorkflowRunsRepo((repo) => {
      const rows = repo.getUnitsForStep(RUN_ID, "review");
      expect(rows[0]!.status).toBe("failed");
      expect(rows[0]!.session_id).toBe("sess-before-crash");
    });
  });

  test("units whose dispatch reveals no sessionId journal NULL", async () => {
    seedRun({ params: { files: ["a"] }, steps: [{ id: "review", title: "Review files" }] });
    const stepPlan = plan(FAN_OUT_WF).steps[0]!;
    await executeStepPlan(stepPlan, {
      runId: RUN_ID,
      workflowRef: "workflows/demo",
      params: { files: ["a"] },
      evidence: {},
      dispatcher: async () => ({ ok: true, text: "done" }),
    });
    await withWorkflowRunsRepo((repo) => {
      expect(repo.getUnitsForStep(RUN_ID, "review")[0]!.session_id).toBeNull();
    });
  });
});

describe("executeStepPlan — durable-row reuse (peer review)", () => {
  test("re-executing a step reuses completed units with the same input hash instead of re-dispatching", async () => {
    seedRun({ params: { files: ["a", "b"] }, steps: [{ id: "review", title: "Review files" }] });
    const stepPlan = plan(FAN_OUT_WF).steps[0]!;
    const ctx = {
      runId: RUN_ID,
      workflowRef: "workflows/demo",
      params: { files: ["a", "b"] },
      evidence: {},
    };

    let dispatches = 0;
    const first = await executeStepPlan(stepPlan, {
      ...ctx,
      dispatcher: async (req) => {
        dispatches++;
        return { ok: true, text: `run1 ${req.unitId}`, usage: { outputTokens: 7 } };
      },
    });
    expect(first.ok).toBe(true);
    expect(dispatches).toBe(2);

    const second = await executeStepPlan(stepPlan, {
      ...ctx,
      dispatcher: async () => {
        dispatches++;
        return { ok: true, text: "run2 — must not happen" };
      },
    });
    expect(dispatches).toBe(2); // no re-dispatch
    expect(second.ok).toBe(true);
    expect(second.units.every((unit) => /^run1 review\.unit:[0-9a-f]{64}$/.test(unit.text ?? ""))).toBe(true);
    expect(second.units.every((u) => u.tokens === 7)).toBe(true);

    // Journaled rows keep their original results (no OR REPLACE clobber).
    await withWorkflowRunsRepo((repo) => {
      const rows = repo.getUnitsForStep(RUN_ID, "review");
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.status === "completed")).toBe(true);
      expect(rows.every((r) => (r.result_json ?? "").includes("run1"))).toBe(true);
    });
  });

  test("a changed item is a NEW unit identity and dispatches live", async () => {
    seedRun({ params: { files: ["a"] }, steps: [{ id: "review", title: "Review files" }] });
    const stepPlan = plan(FAN_OUT_WF).steps[0]!;
    let dispatches = 0;
    const dispatcher = async () => {
      dispatches++;
      return { ok: true, text: "done" };
    };
    await executeStepPlan(stepPlan, {
      runId: RUN_ID,
      workflowRef: "workflows/demo",
      params: { files: ["a"] },
      evidence: {},
      dispatcher,
    });
    // Content-derived identity: a different item is a different unit id — it
    // never matches the journaled row, so it dispatches live (no divergence:
    // divergence is same-id-different-hash, covered in the R2 identity suite).
    await executeStepPlan(stepPlan, {
      runId: RUN_ID,
      workflowRef: "workflows/demo",
      params: { files: ["a-changed"] },
      evidence: {},
      dispatcher,
    });
    expect(dispatches).toBe(2);
  });
});

describe("executeStepPlan — durable-row reuse never counts against a declared budget", () => {
  test("durable-row reuse is free: a journal-heavy resume reuses instead of re-dispatching", async () => {
    // Peer-review regression: the old pre-batch check (`journaled +
    // items.length > cap`) plus reuse-counted-as-dispatch made any
    // partially-completed fan-out with many journaled units impossible to
    // resume. Only real dispatches ever consume a declared budget.max_units.
    const files = Array.from({ length: 20 }, (_, i) => `f${i}.ts`);
    seedRun({ params: { files }, steps: [{ id: "review", title: "Review files" }] });
    const stepPlan = plan(FAN_OUT_WF).steps[0]!;
    const ctx = { runId: RUN_ID, workflowRef: "workflows/demo", params: { files }, evidence: {} };

    // First pass: 19 units complete, one fails → 20 journaled attempt rows.
    const first = await executeStepPlan(stepPlan, {
      ...ctx,
      dispatcher: async (req) =>
        req.prompt.includes('fan-out list:\n"f7.ts"')
          ? { ok: false, text: "", failureReason: "timeout", error: "timed out" }
          : { ok: true, text: `done ${req.unitId}` },
    });
    expect(first.ok).toBe(false);
    expect(first.unitsDispatched).toBe(20);

    // Resume with a large journal-seeded unitsDispatched count: 19 reuses are
    // free, exactly ONE unit dispatches.
    let dispatches = 0;
    const second = await executeStepPlan(stepPlan, {
      ...ctx,
      unitsDispatched: 1_000_000,
      dispatcher: async (req) => {
        dispatches++;
        return { ok: true, text: `retried ${req.unitId}` };
      },
    });
    expect(second.ok).toBe(true);
    expect(dispatches).toBe(1);
    expect(second.unitsDispatched).toBe(1_000_001);
  });
});

describe("step output promotion — steps.<id>.output addresses real results (peer review R1)", () => {
  const DOCS_SHAPE_WF = `---
type: workflow
steps:
  - id: discover
    unit:
      output: { type: object, properties: { files: { type: array, items: { type: string } } }, required: [files] }
  - id: review
    map:
      over: steps.discover.output.files
  - id: summarize
    inputs: ["steps.review.output", "steps.review.output[0]"]
---

## discover

List files.

## review

Review the assigned item.

## summarize

Summarize the reviews (declared inputs above carry the full array and its first element).
`;

  test("the documented addressing works end-to-end: solo result feeds map.over, collect array feeds a later unit", async () => {
    // The flagship docs example shape (docs/reference/workflows.md): a solo
    // unit's structured result is the step output — NOT the internal
    // evidence envelope {units, itemCount} — and a collect fan-out's output
    // is the array of per-item results in item order. `summarize` addresses
    // both the whole array and its first element via TWO declared `inputs:`
    // entries (spec §2.3's sub-path support), attached as separate "###
    // <reference>" context blocks rather than spliced into prose.
    seedRun({
      steps: [
        { id: "discover", title: "Discover" },
        { id: "review", title: "Review" },
        { id: "summarize", title: "Summarize" },
      ],
    });
    const prompts: string[] = [];
    const result = await runWorkflowSteps({
      target: RUN_ID,
      dispatcher: async (req) => {
        prompts.push(req.prompt);
        if (req.nodeId === "discover") return { ok: true, text: '{"files": ["a.ts", "b.ts"]}' };
        return { ok: true, text: `verdict:${req.unitId}` };
      },
      loadPlan: usePlan(DOCS_SHAPE_WF),
    });

    expect(result.done).toBe(true);
    expect(result.executed.map((s) => s.stepId)).toEqual(["discover", "review", "summarize"]);
    // map.over resolved the solo unit's structured result — one unit per file.
    expect(prompts.filter((p) => p.includes('"a.ts"') || p.includes('"b.ts"')).length).toBe(2);
    // The collect artifact is the per-item value array; declared inputs carry
    // it (and its [0] sub-path) as separate context blocks.
    const summarizePrompt = prompts[prompts.length - 1]!;
    expect(summarizePrompt).toContain("### steps.review.output\n");
    expect(summarizePrompt).toMatch(/\["verdict:review\.unit:[0-9a-f]{64}","verdict:review\.unit:[0-9a-f]{64}"\]/);
    expect(summarizePrompt).toContain("### steps.review.output[0]\n");
    expect(summarizePrompt).toMatch(/"verdict:review\.unit:[0-9a-f]{64}"/);
  });

  const VOTE_ROUTE_WF = `---
type: workflow
params:
  attempts: { type: array }
steps:
  - id: judge
    map:
      over: params.attempts
      reducer: vote
      unit:
        output: { type: object, properties: { verdict: { type: string } }, required: [verdict] }
  - id: triage
    route:
      input: steps.judge.output.verdict
      when: [{ match: pass, step: ship }, { match: fail, step: rework }]
  - id: ship
  - id: rework
---

## judge

Judge the assigned attempt.

## triage

Triage.

## ship

Ship it.

## rework

Rework it.
`;

  test("a vote step's output is the winner — routes address it directly", async () => {
    seedRun({
      params: { attempts: [1, 2, 3] },
      steps: [
        { id: "judge", title: "Judge" },
        { id: "triage", title: "Triage" },
        { id: "ship", title: "Ship" },
        { id: "rework", title: "Rework" },
      ],
    });
    const dispatched: string[] = [];
    const result = await runWorkflowSteps({
      target: RUN_ID,
      dispatcher: async (req) => {
        dispatched.push(req.nodeId);
        return req.nodeId === "judge.unit" ? { ok: true, text: '{"verdict": "pass"}' } : { ok: true, text: "done" };
      },
      loadPlan: usePlan(VOTE_ROUTE_WF),
    });
    expect(result.done).toBe(true);
    expect(dispatched).toEqual(["judge.unit", "judge.unit", "judge.unit", "ship"]);
    const status = await getWorkflowStatus(RUN_ID);
    const byId = new Map(status.workflow.steps.map((s) => [s.id, s.status]));
    expect(byId.get("ship")).toBe("completed");
    expect(byId.get("rework")).toBe("skipped");
  });
});

describe("runWorkflowSteps — engine loop over the gated spine", () => {
  const TWO_STEP_WF = `---
type: workflow
params:
  flavor: { type: string }
steps:
  - id: first
  - id: second
---

## first

Do first.

## second

Do second.
`;

  test("executes every step through completeWorkflowStep until the run completes", async () => {
    seedRun({
      params: { flavor: "vanilla" },
      steps: [
        { id: "first", title: "First" },
        { id: "second", title: "Second" },
      ],
    });
    const prompts: string[] = [];
    const notice = {
      code: "untranslated-field",
      severity: "warning" as const,
      adapter: "codex",
      field: "tools",
      message: "tool selection was not translated",
    };
    const result = await runWorkflowSteps({
      target: RUN_ID,
      dispatcher: async (req) => {
        prompts.push(req.prompt);
        return { ok: true, text: `did ${req.nodeId}`, notices: [notice] };
      },
      loadPlan: usePlan(TWO_STEP_WF),
    });

    expect(result.executed.map((s) => s.stepId)).toEqual(["first", "second"]);
    expect(result.done).toBe(true);
    expect(result.executed.map((step) => step.notices)).toEqual([[notice], [notice]]);
    expect(result.notices).toEqual([notice]);
    // Params attach as structured JSON context to EVERY unit (spec §2.3),
    // never spliced into instructions.
    expect(prompts[1]).toContain('"flavor":"vanilla"');

    const status = await getWorkflowStatus(RUN_ID);
    expect(status.run.status).toBe("completed");
    expect(status.workflow.steps.every((s) => s.status === "completed")).toBe(true);
    // Evidence carries the unit outcomes for downstream steps/consumers.
    expect(status.workflow.steps[0]!.evidence?.units).toBeDefined();
  });

  test("a failing step marks the run failed and stops the loop", async () => {
    seedRun({
      params: { flavor: "vanilla" },
      steps: [
        { id: "first", title: "First" },
        { id: "second", title: "Second" },
      ],
    });
    const result = await runWorkflowSteps({
      target: RUN_ID,
      dispatcher: async (req) =>
        req.nodeId === "first"
          ? { ok: false, text: "", failureReason: "non_zero_exit", error: "exit 1" }
          : { ok: true, text: "unreachable" },
      loadPlan: usePlan(TWO_STEP_WF),
    });

    expect(result.executed).toHaveLength(1);
    expect(result.executed[0]!.ok).toBe(false);
    expect(result.done).toBeUndefined();
    const status = await getWorkflowStatus(RUN_ID);
    expect(status.run.status).toBe("failed");
  });

  test("refuses a non-active run BEFORE dispatching any unit (peer review #2)", async () => {
    seedRun({
      steps: [
        { id: "first", title: "First" },
        { id: "second", title: "Second" },
      ],
    });
    const db = openStateDatabase(path.join(tmpDir, "state.db"));
    try {
      db.prepare("UPDATE workflow_runs SET status = 'failed' WHERE id = ?").run(RUN_ID);
    } finally {
      db.close();
    }
    let dispatches = 0;
    await expect(
      runWorkflowSteps({
        target: RUN_ID,
        dispatcher: async () => {
          dispatches++;
          return { ok: true, text: "must not run" };
        },
        loadPlan: usePlan(TWO_STEP_WF),
      }),
    ).rejects.toThrow(/failed and cannot be executed/);
    expect(dispatches).toBe(0);
  });

  test("a stored plan carrying a key this akm does not know (the removed dependsOn) still runs in step order", async () => {
    // Readers tolerate what older releases wrote: an unknown key is kept, not
    // refused. Ordering comes from `sequenceIndex`, so `dependsOn` changes nothing.
    seedRun({
      params: { flavor: "vanilla" },
      steps: [
        { id: "first", title: "First" },
        { id: "second", title: "Second" },
      ],
    });
    const withLegacyKey = plan(TWO_STEP_WF);
    withLegacyKey.steps[0] = { ...withLegacyKey.steps[0]!, dependsOn: ["second"] } as unknown as WorkflowPlanStep;
    const dispatched: string[] = [];
    const result = await runWorkflowSteps({
      target: RUN_ID,
      dispatcher: async (request) => {
        dispatched.push(request.stepId);
        return { ok: true, text: "done" };
      },
      loadPlan: useFrozenPlan(withLegacyKey),
    });
    expect(result.run.status).toBe("completed");
    expect(dispatched).toEqual(["first", "second"]);
  });

  const ROUTED_WF = `---
type: workflow
steps:
  - id: classify
    unit:
      output: { type: object, properties: { kind: { type: string } }, required: [kind] }
  - id: triage
    route:
      input: steps.classify.output.kind
      when: [{ match: bug, step: fix-bug }, { match: feature, step: build-feature }]
  - id: fix-bug
  - id: build-feature
  - id: wrap-up
---

## classify

Classify.

## triage

Triage.

## fix-bug

Fix it.

## build-feature

Build it.

## wrap-up

Wrap up.
`;

  test("routing: the selected branch runs, unselected targets are auto-skipped", async () => {
    seedRun({
      steps: [
        { id: "classify", title: "Classify" },
        { id: "triage", title: "Triage" },
        { id: "fix-bug", title: "Fix bug" },
        { id: "build-feature", title: "Build feature" },
        { id: "wrap-up", title: "Wrap up" },
      ],
    });
    const dispatchedNodes: string[] = [];
    const result = await runWorkflowSteps({
      target: RUN_ID,
      dispatcher: async (req) => {
        dispatchedNodes.push(req.nodeId);
        return req.nodeId === "classify" ? { ok: true, text: '{"kind": "bug"}' } : { ok: true, text: "done" };
      },
      loadPlan: usePlan(ROUTED_WF),
    });

    expect(result.done).toBe(true);
    // The route step dispatches nothing; build-feature must never dispatch.
    expect(dispatchedNodes).toEqual(["classify", "fix-bug", "wrap-up"]);

    const status = await getWorkflowStatus(RUN_ID);
    const byId = new Map(status.workflow.steps.map((s) => [s.id, s]));
    expect(byId.get("classify")?.status).toBe("completed");
    expect(byId.get("triage")?.status).toBe("completed");
    expect(byId.get("fix-bug")?.status).toBe("completed");
    expect(byId.get("build-feature")?.status).toBe("skipped");
    expect(byId.get("wrap-up")?.status).toBe("completed");
    // The route step's evidence records the decision.
    expect(byId.get("triage")?.evidence?.route).toEqual({
      input: "steps.classify.output.kind",
      value: "bug",
      selected: "fix-bug",
    });
  });

  test("routing: falls back to default, and an unroutable value fails the step", async () => {
    const DEFAULTED_WF = `---
type: workflow
steps:
  - id: classify
    unit:
      output: { type: object, properties: { kind: { type: string } }, required: [kind] }
  - id: triage
    route:
      input: steps.classify.output.kind
      when: [{ match: bug, step: fix-bug }]
      default: manual-triage
  - id: fix-bug
  - id: manual-triage
---

## classify

Classify.

## triage

Triage.

## fix-bug

Fix it.

## manual-triage

Triage it.
`;

    // Default fallback: "question" matches no branch → manual-triage runs, fix-bug skipped.
    seedRun({
      steps: [
        { id: "classify", title: "Classify" },
        { id: "triage", title: "Triage" },
        { id: "fix-bug", title: "Fix bug" },
        { id: "manual-triage", title: "Manual triage" },
      ],
    });
    const result = await runWorkflowSteps({
      target: RUN_ID,
      dispatcher: async (req) =>
        req.nodeId === "classify" ? { ok: true, text: '{"kind": "question"}' } : { ok: true, text: "done" },
      loadPlan: usePlan(DEFAULTED_WF),
    });
    expect(result.done).toBe(true);
    const status = await getWorkflowStatus(RUN_ID);
    const byId = new Map(status.workflow.steps.map((s) => [s.id, s]));
    expect(byId.get("fix-bug")?.status).toBe("skipped");
    expect(byId.get("manual-triage")?.status).toBe("completed");

    // Unroutable: no matching branch and no default → the route step fails.
    const NO_DEFAULT_WF = `---
type: workflow
steps:
  - id: classify
    unit:
      output: { type: object, properties: { kind: { type: string } }, required: [kind] }
  - id: triage
    route:
      input: steps.classify.output.kind
      when: [{ match: bug, step: fix-bug }]
  - id: fix-bug
---

## classify

Classify.

## triage

Triage.

## fix-bug

Fix it.
`;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });
    seedRun({
      steps: [
        { id: "classify", title: "Classify" },
        { id: "triage", title: "Triage" },
        { id: "fix-bug", title: "Fix bug" },
      ],
    });
    const failed = await runWorkflowSteps({
      target: RUN_ID,
      dispatcher: async () => ({ ok: true, text: '{"kind": "question"}' }),
      loadPlan: usePlan(NO_DEFAULT_WF),
    });
    const triageReport = failed.executed.find((s) => s.stepId === "triage");
    expect(triageReport?.ok).toBe(false);
    expect(triageReport?.summary).toContain("question");
    expect(failed.run.status).toBe("failed");
  });

  const ROUTED_STEPS = [
    { id: "classify", title: "Classify" },
    { id: "triage", title: "Triage" },
    { id: "fix-bug", title: "Fix bug" },
    { id: "build-feature", title: "Build feature" },
    { id: "wrap-up", title: "Wrap up" },
  ];

  test("routing survives resume: the journaled decision replays, unselected targets stay skipped (peer review)", async () => {
    // Route decisions must be pure functions of (frozen plan, params,
    // journaled results) — NOT per-invocation memory. First invocation stops
    // right after the route step completed (maxSteps), simulating a crash /
    // Ctrl-C / gate stop between the decision and its targets.
    seedRun({ steps: ROUTED_STEPS });
    const firstNodes: string[] = [];
    const first = await runWorkflowSteps({
      target: RUN_ID,
      maxSteps: 2,
      dispatcher: async (req) => {
        firstNodes.push(req.nodeId);
        return req.nodeId === "classify" ? { ok: true, text: '{"kind": "bug"}' } : { ok: true, text: "done" };
      },
      loadPlan: usePlan(ROUTED_WF),
    });
    expect(first.executed.map((s) => s.stepId)).toEqual(["classify", "triage"]);
    expect(firstNodes).toEqual(["classify"]); // the route step dispatches nothing

    // Fresh invocation = fresh in-memory bookkeeping: the decision journaled
    // in the triage step's evidence must replay, or the UNSELECTED branch
    // (build-feature) would dispatch units — the wrong branch, real money.
    const resumedNodes: string[] = [];
    const resumed = await runWorkflowSteps({
      target: RUN_ID,
      dispatcher: async (req) => {
        resumedNodes.push(req.nodeId);
        return { ok: true, text: "done" };
      },
      loadPlan: usePlan(ROUTED_WF),
    });
    expect(resumed.done).toBe(true);
    expect(resumedNodes).toEqual(["fix-bug", "wrap-up"]);

    const status = await getWorkflowStatus(RUN_ID);
    const byId = new Map(status.workflow.steps.map((s) => [s.id, s]));
    expect(byId.get("fix-bug")?.status).toBe("completed");
    expect(byId.get("build-feature")?.status).toBe("skipped");
    expect(byId.get("wrap-up")?.status).toBe("completed");
  });

  test("resume re-derives the decision when the route step was completed manually (no journaled route evidence)", async () => {
    seedRun({ steps: ROUTED_STEPS });
    // classify runs through the engine, journaling its evidence.
    await runWorkflowSteps({
      target: RUN_ID,
      maxSteps: 1,
      dispatcher: async () => ({ ok: true, text: '{"kind": "bug"}' }),
      loadPlan: usePlan(ROUTED_WF),
    });
    // triage advanced by hand via the manual loop — no evidence.route written.
    await completeWorkflowStep({
      runId: RUN_ID,
      stepId: "triage",
      status: "completed",
      summary: "Routed by hand.",
      summaryJudge: null,
    });

    const resumedNodes: string[] = [];
    const resumed = await runWorkflowSteps({
      target: RUN_ID,
      dispatcher: async (req) => {
        resumedNodes.push(req.nodeId);
        return { ok: true, text: "done" };
      },
      loadPlan: usePlan(ROUTED_WF),
    });
    // Deterministic re-derivation from the frozen plan + journaled evidence:
    // classify's journaled output still says "bug", so fix-bug runs.
    expect(resumed.done).toBe(true);
    expect(resumedNodes).toEqual(["fix-bug", "wrap-up"]);
  });

  test("resume fails loudly when a completed route step's decision is unrecoverable (never runs every branch)", async () => {
    seedRun({ steps: ROUTED_STEPS });
    const loadPlan = usePlan(ROUTED_WF);
    // Both classify and triage completed manually: no journaled decision and
    // no evidence to re-derive it from.
    await completeWorkflowStep({
      runId: RUN_ID,
      stepId: "classify",
      status: "completed",
      summary: "Classified by hand.",
      summaryJudge: null,
    });
    await completeWorkflowStep({
      runId: RUN_ID,
      stepId: "triage",
      status: "completed",
      summary: "Routed by hand.",
      summaryJudge: null,
    });

    let dispatches = 0;
    await expect(
      runWorkflowSteps({
        target: RUN_ID,
        dispatcher: async () => {
          dispatches++;
          return { ok: true, text: "must not run" };
        },
        loadPlan,
      }),
    ).rejects.toThrow(/route step "triage" with no journaled route/);
    expect(dispatches).toBe(0);
  });

  const CASCADE_WF = `---
type: workflow
params:
  pick: { type: string }
  branch: { type: string }
steps:
  - id: classify
    route:
      input: params.pick
      when: [{ match: left, step: branch-router }, { match: right, step: safe }]
  - id: branch-router
    route:
      input: params.branch
      when: [{ match: m, step: c1 }, { match: n, step: c2 }]
  - id: safe
  - id: c1
  - id: c2
---

## classify

Classify.

## branch-router

Branch router.

## safe

Safe path.

## c1

Branch c1.

## c2

Branch c2.
`;

  const CASCADE_STEPS = [
    { id: "classify", title: "Classify" },
    { id: "branch-router", title: "Branch router" },
    { id: "safe", title: "Safe" },
    { id: "c1", title: "C1" },
    { id: "c2", title: "C2" },
  ];

  test("cascaded routing: a skipped router's own branch targets are skipped, never dispatched (peer review)", async () => {
    // Peer-review regression: branch-router is an UNSELECTED target of
    // classify → it is skipped without evaluating its route. Its targets
    // (c1, c2) must cascade into the skip set — the old code dispatched
    // units for safe, c1 AND c2. Note params carries no "branch": the
    // skipped router's input must never even be resolved.
    seedRun({ params: { pick: "right" }, steps: CASCADE_STEPS });
    const dispatched: string[] = [];
    const result = await runWorkflowSteps({
      target: RUN_ID,
      dispatcher: async (req) => {
        dispatched.push(req.nodeId);
        return { ok: true, text: "done" };
      },
      loadPlan: usePlan(CASCADE_WF),
    });

    expect(result.done).toBe(true);
    expect(dispatched).toEqual(["safe"]);
    const status = await getWorkflowStatus(RUN_ID);
    const byId = new Map(status.workflow.steps.map((s) => [s.id, s.status]));
    expect(byId.get("classify")).toBe("completed");
    expect(byId.get("branch-router")).toBe("skipped");
    expect(byId.get("safe")).toBe("completed");
    expect(byId.get("c1")).toBe("skipped");
    expect(byId.get("c2")).toBe("skipped");
  });

  test("cascaded routing survives resume: a journaled skipped router keeps its targets skipped", async () => {
    // Stop after branch-router was journaled as skipped (maxSteps: 2 covers
    // classify + safe — a route-SKIPPED step no longer consumes the step
    // budget), then resume with fresh in-memory bookkeeping:
    // seedJournaledRouteDecisions must cascade from the SKIPPED status (there
    // is no journaled decision to replay — the router never decided anything),
    // or the resume would dispatch c1 and c2.
    seedRun({ params: { pick: "right" }, steps: CASCADE_STEPS });
    const first = await runWorkflowSteps({
      target: RUN_ID,
      maxSteps: 2,
      dispatcher: async () => ({ ok: true, text: "done" }),
      loadPlan: usePlan(CASCADE_WF),
    });
    expect(first.executed.map((s) => s.stepId)).toEqual(["classify", "branch-router", "safe"]);
    expect(first.done).toBeUndefined(); // c1/c2 still pending — resume decides them

    const dispatched: string[] = [];
    const resumed = await runWorkflowSteps({
      target: RUN_ID,
      dispatcher: async (req) => {
        dispatched.push(req.nodeId);
        return { ok: true, text: "done" };
      },
      loadPlan: usePlan(CASCADE_WF),
    });
    expect(resumed.done).toBe(true);
    expect(dispatched).toEqual([]); // nothing left to dispatch — c1/c2 cascade-skip
    const status = await getWorkflowStatus(RUN_ID);
    const byId = new Map(status.workflow.steps.map((s) => [s.id, s.status]));
    expect(byId.get("c1")).toBe("skipped");
    expect(byId.get("c2")).toBe("skipped");
  });

  test("resume after a fan-out failure re-dispatches ONLY the incomplete unit (peer review)", async () => {
    // End-to-end confirmation of the documented resume contract: a failed
    // 6-item fan-out journals 6 attempts; after `workflow resume`, the
    // engine reuses the 5 completed rows and dispatches exactly one unit —
    // and the journal-seeded cap counts the reuses as zero new dispatches.
    const files = ["f0", "f1", "f2", "f3", "f4", "f5"];
    const firstInvocationNotice = {
      code: "conversation-prompt-composed",
      severity: "warning" as const,
      adapter: "codex",
      field: "conversation",
      message: "first invocation only",
    };
    seedRun({ params: { files }, steps: [{ id: "review", title: "Review files" }] });
    const failing = await runWorkflowSteps({
      target: RUN_ID,
      dispatcher: async (req) =>
        req.prompt.includes('fan-out list:\n"f3"')
          ? { ok: false, text: "", failureReason: "timeout", error: "timed out" }
          : { ok: true, text: "done", notices: [firstInvocationNotice] },
      loadPlan: usePlan(FAN_OUT_WF),
    });
    expect(failing.run.status).toBe("failed");
    expect(failing.notices).toEqual([firstInvocationNotice]);

    const { resumeWorkflowRun } = await import("../../../src/workflows/runtime/runs");
    await resumeWorkflowRun(RUN_ID);

    let dispatches = 0;
    const resumed = await runWorkflowSteps({
      target: RUN_ID,
      dispatcher: async () => {
        dispatches++;
        return { ok: true, text: "done" };
      },
      loadPlan: usePlan(FAN_OUT_WF),
    });
    expect(dispatches).toBe(1);
    expect(resumed.done).toBe(true);
    // The five reused rows intentionally contain no durable notices, and the
    // one live retry emitted none. Resume must not fabricate the prior call's
    // live-only diagnostic from result_json/evidence_json.
    expect(resumed.notices).toBeUndefined();
    expect(resumed.executed[0]!.notices).toBeUndefined();
  });

  test("maxSteps bounds the loop", async () => {
    seedRun({
      params: { flavor: "vanilla" },
      steps: [
        { id: "first", title: "First" },
        { id: "second", title: "Second" },
      ],
    });
    const result = await runWorkflowSteps({
      target: RUN_ID,
      maxSteps: 1,
      dispatcher: async () => ({ ok: true, text: "ok" }),
      loadPlan: usePlan(TWO_STEP_WF),
    });
    expect(result.executed).toHaveLength(1);
    const status = await getWorkflowStatus(RUN_ID);
    expect(status.run.status).toBe("active");
    expect(status.run.currentStepId).toBe("second");
  });
});
