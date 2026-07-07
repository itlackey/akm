// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { withWorkflowRunsRepo } from "../../src/storage/repositories/workflow-runs-repository";
import { closeWorkflowDatabase, openWorkflowDatabase } from "../../src/workflows/db";
import {
  executeStepPlan,
  llmFailureReasonFor,
  type UnitDispatchRequest,
  type UnitDispatchResult,
} from "../../src/workflows/exec/native-executor";
import { runWorkflowSteps } from "../../src/workflows/exec/run-workflow";
import { compileWorkflowProgram } from "../../src/workflows/ir/compile";
import type { WorkflowPlanGraph } from "../../src/workflows/ir/schema";
import { parseWorkflowProgram } from "../../src/workflows/program/parser";
import { PROGRAM_RETRY_REASONS } from "../../src/workflows/program/schema";
import { completeWorkflowStep, getWorkflowStatus } from "../../src/workflows/runtime/runs";
import { makeSandboxDir, withEnv, withMockedFetch, writeSandboxConfig } from "../_helpers/sandbox";

/**
 * Native executor over IR v2 (redesign addendum, R1): fan-out via `${{ … }}`
 * expressions through the scheduler, schema-validated structured output with
 * retry, the explicit failure policy (`on_error` / `retry`), per-unit
 * persistence, and the engine loop that advances the gated step spine
 * strictly through `completeWorkflowStep`.
 *
 * All dispatch goes through an injected fake dispatcher — no agent binaries,
 * no LLM. The workflow DB is a sandboxed tmp dir via AKM_DATA_DIR. Plans come
 * from YAML workflow-program sources (parseWorkflowProgram +
 * compileWorkflowProgram), the only orchestrated frontend after the P1
 * markdown grammar removal.
 */

let tmpDir = "";
let prevDataDir: string | undefined;

const RUN_ID = "44444444-4444-4444-8444-444444444444";

function seedRun(opts: { params?: Record<string, unknown>; steps: Array<{ id: string; title: string }> }): void {
  const db = openWorkflowDatabase(path.join(tmpDir, "workflow.db"));
  try {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO workflow_runs
         (id, workflow_ref, scope_key, workflow_entry_id, workflow_title, status,
          params_json, current_step_id, created_at, updated_at)
       VALUES (?, 'workflow:demo', 'dir:v1:demo', NULL, 'Demo', 'active', ?, ?, ?, ?)`,
    ).run(RUN_ID, JSON.stringify(opts.params ?? {}), opts.steps[0].id, now, now);
    opts.steps.forEach((step, i) => {
      db.prepare(
        `INSERT INTO workflow_run_steps
           (run_id, step_id, step_title, instructions, completion_json, sequence_index, status)
         VALUES (?, ?, ?, 'instructions', NULL, ?, 'pending')`,
      ).run(RUN_ID, step.id, step.title, i);
    });
  } finally {
    closeWorkflowDatabase(db);
  }
}

function plan(yamlText: string): WorkflowPlanGraph {
  const parsed = parseWorkflowProgram(yamlText, { path: "workflows/demo.yaml" });
  if (!parsed.ok) throw new Error(parsed.errors.map((e) => `${e.line}: ${e.message}`).join(" | "));
  const compiled = compileWorkflowProgram(parsed.program);
  if (!compiled.ok) throw new Error(compiled.errors.map((e) => `${e.line}: ${e.message}`).join(" | "));
  return compiled.plan;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-native-exec-"));
  prevDataDir = process.env.AKM_DATA_DIR;
  process.env.AKM_DATA_DIR = tmpDir;
});

afterEach(() => {
  if (prevDataDir === undefined) delete process.env.AKM_DATA_DIR;
  else process.env.AKM_DATA_DIR = prevDataDir;
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

const FAN_OUT_WF = `version: 1
name: Review
params:
  files: { type: array }
steps:
  - id: review
    title: Review files
    map:
      over: \${{ params.files }}
      concurrency: 4
      unit:
        instructions: Review \${{ item }} carefully.
`;

describe("executeStepPlan — fan-out", () => {
  test("dispatches one unit per item over ${{ params.files }}, resolves ${{ item }}, persists unit rows", async () => {
    seedRun({ params: { files: ["a.ts", "b.ts", "c.ts"] }, steps: [{ id: "review", title: "Review files" }] });
    const prompts: string[] = [];
    const dispatcher = async (req: UnitDispatchRequest): Promise<UnitDispatchResult> => {
      prompts.push(req.prompt);
      return { ok: true, text: `reviewed ${req.unitId}` };
    };

    const stepPlan = plan(FAN_OUT_WF).steps[0];
    const result = await executeStepPlan(stepPlan, {
      runId: RUN_ID,
      workflowRef: "workflow:demo",
      params: { files: ["a.ts", "b.ts", "c.ts"] },
      evidence: {},
      dispatcher,
    });

    expect(result.ok).toBe(true);
    expect(result.units).toHaveLength(3);
    expect(prompts.some((p) => p.includes("Review a.ts carefully."))).toBe(true);
    expect(prompts.every((p) => p.includes(RUN_ID))).toBe(true); // preamble carries the run id

    await withWorkflowRunsRepo((repo) => {
      const rows = repo.getUnitsForStep(RUN_ID, "review");
      expect(rows).toHaveLength(3);
      expect(rows.every((r) => r.status === "completed")).toBe(true);
      expect(rows.every((r) => r.node_id === "review.unit")).toBe(true);
      // Content-derived identity (R2): <node_id>:<sha256(canonicalJson(item))[:12]>,
      // pinned as literals so a scheme drift breaks this golden knowingly.
      expect(rows.map((r) => r.unit_id).sort()).toEqual([
        "review.unit:630647ca5751", // "b.ts"
        "review.unit:8b3148685648", // "a.ts"
        "review.unit:f31d8e9f8cb8", // "c.ts"
      ]);
    });
  });

  test("hostile item content is data: $-patterns and ${{ … }} in values insert verbatim, never re-scanned", async () => {
    // Single-pass proof at the engine level: templates are parsed once into
    // literal/reference segments; substituted CONTENT is data. An item that
    // itself looks like an expression must appear literally, and must never
    // resolve against params — the P1 re-scan injection class.
    const items = ["src/a$&b.ts", "Makefile uses $$(CC)", "${{ params.secret }}"];
    seedRun({ params: { files: items }, steps: [{ id: "review", title: "Review files" }] });
    const prompts: string[] = [];
    const stepPlan = plan(FAN_OUT_WF).steps[0];
    const result = await executeStepPlan(stepPlan, {
      runId: RUN_ID,
      workflowRef: "workflow:demo",
      params: { files: items, secret: "LEAKED-SECRET", note: "cost is $& today" },
      evidence: {},
      dispatcher: async (req) => {
        prompts.push(req.prompt);
        return { ok: true, text: "ok" };
      },
    });
    expect(result.ok).toBe(true);
    expect(prompts.some((p) => p.includes("Review src/a$&b.ts carefully."))).toBe(true);
    expect(prompts.some((p) => p.includes("Review Makefile uses $$(CC) carefully."))).toBe(true);
    // The expression-looking item is inserted literally — single pass, no re-scan.
    expect(prompts.some((p) => p.includes("Review ${{ params.secret }} carefully."))).toBe(true);
    expect(prompts.every((p) => !p.includes("Review LEAKED-SECRET carefully."))).toBe(true);
    // Preamble params JSON must also survive $-patterns un-mangled.
    expect(prompts.every((p) => p.includes("cost is $& today"))).toBe(true);
    expect(prompts.every((p) => !p.includes("{{PARAMS_JSON}}"))).toBe(true);
  });

  test("items can come from a prior step's output via ${{ steps.discover.output.files }}", async () => {
    seedRun({ steps: [{ id: "review", title: "Review files" }] });
    const EVIDENCE_WF = FAN_OUT_WF.replace("${{ params.files }}", "${{ steps.discover.output.files }}").replace(
      "steps:",
      `steps:
  - id: discover
    unit:
      instructions: Find files.`,
    );
    const dispatcher = async (): Promise<UnitDispatchResult> => ({ ok: true, text: "done" });
    const stepPlan = plan(EVIDENCE_WF).steps.find((s) => s.stepId === "review");
    if (!stepPlan) throw new Error("missing review step");
    const result = await executeStepPlan(stepPlan, {
      runId: RUN_ID,
      workflowRef: "workflow:demo",
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
    const TOSTRING_WF = FAN_OUT_WF.replace("${{ params.files }}", "${{ steps.prior.output.toString }}").replace(
      "steps:",
      `steps:
  - id: prior
    unit:
      instructions: Prior.`,
    );
    const stepPlan = plan(TOSTRING_WF).steps.find((s) => s.stepId === "review");
    if (!stepPlan) throw new Error("missing review step");
    const result = await executeStepPlan(stepPlan, {
      runId: RUN_ID,
      workflowRef: "workflow:demo",
      params: {},
      evidence: { prior: { unrelated: true } },
      dispatcher: async () => ({ ok: true, text: "must not run" }),
    });
    expect(result.ok).toBe(false);
    expect(result.summary).toContain("missing");
  });

  test("a non-array fan-out source fails the step with a clear error", async () => {
    seedRun({ params: { files: "not-a-list" }, steps: [{ id: "review", title: "Review files" }] });
    const stepPlan = plan(FAN_OUT_WF).steps[0];
    const result = await executeStepPlan(stepPlan, {
      runId: RUN_ID,
      workflowRef: "workflow:demo",
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
      req.prompt.includes("Review a")
        ? { ok: true, text: "fine" }
        : { ok: false, text: "", failureReason: "timeout", error: "timed out" };

    const stepPlan = plan(FAN_OUT_WF).steps[0];
    const result = await executeStepPlan(stepPlan, {
      runId: RUN_ID,
      workflowRef: "workflow:demo",
      params: { files: ["a", "b"] },
      evidence: {},
      dispatcher,
    });
    expect(result.ok).toBe(false);
    expect(result.units.filter((u) => !u.ok)).toHaveLength(1);
    await withWorkflowRunsRepo((repo) => {
      const failed = repo.getUnitsForStep(RUN_ID, "review").filter((r) => r.status === "failed");
      expect(failed).toHaveLength(1);
      expect(failed[0].failure_reason).toBe("timeout");
    });
  });
});

const SCHEMA_WF = `version: 1
name: Extract
steps:
  - id: extract
    title: Extract facts
    unit:
      instructions: Extract facts.
      output:
        type: object
        properties: { fact: { type: string } }
        required: [fact]
`;

describe("executeStepPlan — structured output", () => {
  test("valid JSON on first attempt is parsed and stored", async () => {
    seedRun({ steps: [{ id: "extract", title: "Extract facts" }] });
    const stepPlan = plan(SCHEMA_WF).steps[0];
    const result = await executeStepPlan(stepPlan, {
      runId: RUN_ID,
      workflowRef: "workflow:demo",
      params: {},
      evidence: {},
      dispatcher: async () => ({ ok: true, text: '{"fact": "bun is fast"}' }),
    });
    expect(result.ok).toBe(true);
    expect(result.units[0].result).toEqual({ fact: "bun is fast" });
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
    const stepPlan = plan(SCHEMA_WF).steps[0];
    const result = await executeStepPlan(stepPlan, {
      runId: RUN_ID,
      workflowRef: "workflow:demo",
      params: {},
      evidence: {},
      dispatcher,
    });
    expect(result.ok).toBe(true);
    expect(feedbacks[0]).toBeUndefined();
    expect(feedbacks[1]).toContain("fact");
    expect(result.units[0].result).toEqual({ fact: "fixed" });
  });

  test("persistent schema violation records a validation failure", async () => {
    seedRun({ steps: [{ id: "extract", title: "Extract facts" }] });
    const stepPlan = plan(SCHEMA_WF).steps[0];
    const result = await executeStepPlan(stepPlan, {
      runId: RUN_ID,
      workflowRef: "workflow:demo",
      params: {},
      evidence: {},
      dispatcher: async () => ({ ok: true, text: '{"nope": 1}' }),
    });
    expect(result.ok).toBe(false);
    expect(result.units[0].failureReason).toBe("validation_error");
  });
});

const VOTE_WF = `version: 1
name: Vote
params:
  attempts: { type: array }
steps:
  - id: judge
    title: Judge
    map:
      over: \${{ params.attempts }}
      reducer: vote
      unit:
        instructions: Judge attempt \${{ item }} (#\${{ item_index }}).
        output:
          type: object
          properties: { verdict: { type: string } }
          required: [verdict]
`;

describe("executeStepPlan — vote reducer", () => {
  test("majority verdict wins", async () => {
    seedRun({ params: { attempts: [1, 2, 3] }, steps: [{ id: "judge", title: "Judge" }] });
    let call = 0;
    const dispatcher = async (): Promise<UnitDispatchResult> => {
      call++;
      return { ok: true, text: call === 2 ? '{"verdict": "fail"}' : '{"verdict": "pass"}' };
    };
    const stepPlan = plan(VOTE_WF).steps[0];
    const result = await executeStepPlan(stepPlan, {
      runId: RUN_ID,
      workflowRef: "workflow:demo",
      params: { attempts: [1, 2, 3] },
      evidence: {},
      dispatcher,
      maxConcurrency: 1,
    });
    expect(result.ok).toBe(true);
    expect((result.evidence.vote as { winner: unknown }).winner).toEqual({ verdict: "pass" });
  });
});

describe("executeStepPlan — failure policy (IR v2)", () => {
  const CONTINUE_WF = `version: 1
name: Review
params:
  files: { type: array }
steps:
  - id: review
    title: Review files
    map:
      over: \${{ params.files }}
      unit:
        on_error: continue
        instructions: Review \${{ item }} carefully.
`;

  test("on_error: continue records unit failures without failing the step", async () => {
    seedRun({ params: { files: ["a", "b"] }, steps: [{ id: "review", title: "Review files" }] });
    const dispatcher = async (req: UnitDispatchRequest): Promise<UnitDispatchResult> =>
      req.prompt.includes("Review a")
        ? { ok: true, text: "fine" }
        : { ok: false, text: "", failureReason: "timeout", error: "timed out" };

    const stepPlan = plan(CONTINUE_WF).steps[0];
    const result = await executeStepPlan(stepPlan, {
      runId: RUN_ID,
      workflowRef: "workflow:demo",
      params: { files: ["a", "b"] },
      evidence: {},
      dispatcher,
    });
    expect(result.ok).toBe(true); // the step survives …
    expect(result.units.filter((u) => !u.ok)).toHaveLength(1); // … but the failure is recorded
    expect(result.summary).toContain("1 failed");
    expect(result.summary).toContain("on_error: continue");
    await withWorkflowRunsRepo((repo) => {
      const failed = repo.getUnitsForStep(RUN_ID, "review").filter((r) => r.status === "failed");
      expect(failed).toHaveLength(1);
      expect(failed[0].failure_reason).toBe("timeout");
    });
  });

  const RETRY_WF = `version: 1
name: Flaky
steps:
  - id: fetch
    title: Fetch
    unit:
      retry: { max: 2, on: [timeout] }
      instructions: Fetch the thing.
`;

  test("retry-on-timeout re-dispatches up to max, journaling each attempt under <unitId>~r<n>", async () => {
    seedRun({ steps: [{ id: "fetch", title: "Fetch" }] });
    let call = 0;
    const dispatcher = async (): Promise<UnitDispatchResult> => {
      call++;
      return call < 3
        ? { ok: false, text: "", failureReason: "timeout", error: "timed out" }
        : { ok: true, text: "finally" };
    };
    const stepPlan = plan(RETRY_WF).steps[0];
    const result = await executeStepPlan(stepPlan, {
      runId: RUN_ID,
      workflowRef: "workflow:demo",
      params: {},
      evidence: {},
      dispatcher,
    });
    expect(call).toBe(3);
    expect(result.ok).toBe(true);
    // The reduced outcome carries the CONTENT-derived base id — the `~r<n>` suffix
    // is journal-row bookkeeping only, kept off the durable step evidence so an
    // engine-driven and a report-driven run agree on evidence.units[].unitId (R4).
    expect(result.units[0].unitId).toBe("fetch:solo");
    // Every attempt still keeps its own journal ROW under the suffixed id —
    // nothing is clobbered, and attempt granularity is observable there.
    await withWorkflowRunsRepo((repo) => {
      const rows = repo.getUnitsForStep(RUN_ID, "fetch");
      const byId = new Map(rows.map((r) => [r.unit_id, r.status]));
      expect(byId.get("fetch:solo")).toBe("failed");
      expect(byId.get("fetch:solo~r1")).toBe("failed");
      expect(byId.get("fetch:solo~r2")).toBe("completed");
    });
  });

  test("retry does NOT fire for a failure reason outside retry.on", async () => {
    seedRun({ steps: [{ id: "fetch", title: "Fetch" }] });
    let call = 0;
    const dispatcher = async (): Promise<UnitDispatchResult> => {
      call++;
      return { ok: false, text: "", failureReason: "non_zero_exit", error: "exit 1" };
    };
    const stepPlan = plan(RETRY_WF).steps[0];
    const result = await executeStepPlan(stepPlan, {
      runId: RUN_ID,
      workflowRef: "workflow:demo",
      params: {},
      evidence: {},
      dispatcher,
    });
    expect(call).toBe(1);
    expect(result.ok).toBe(false);
    expect(result.units[0].failureReason).toBe("non_zero_exit");
  });

  test("a retried unit that already completed is reused on resume, not re-dispatched", async () => {
    seedRun({ steps: [{ id: "fetch", title: "Fetch" }] });
    let call = 0;
    const flaky = async (): Promise<UnitDispatchResult> => {
      call++;
      return call === 1
        ? { ok: false, text: "", failureReason: "timeout", error: "timed out" }
        : { ok: true, text: "finally" };
    };
    const stepPlan = plan(RETRY_WF).steps[0];
    const ctx = { runId: RUN_ID, workflowRef: "workflow:demo", params: {}, evidence: {} };
    const first = await executeStepPlan(stepPlan, { ...ctx, dispatcher: flaky });
    expect(first.ok).toBe(true);
    expect(call).toBe(2); // attempt 0 failed, ~r1 succeeded

    const second = await executeStepPlan(stepPlan, {
      ...ctx,
      dispatcher: async () => {
        throw new Error("must not re-dispatch");
      },
    });
    expect(second.ok).toBe(true);
    // Base id in the reduced outcome even though it was reused from the `~r1` row.
    expect(second.units[0].unitId).toBe("fetch:solo");
    expect(second.units[0].text).toBe("finally");
  });
});

describe("executeStepPlan — harness-native session id journaling (P2 peer review)", () => {
  test("a dispatcher-revealed sessionId is persisted on the unit row and rehydrated on reuse", async () => {
    // Peer-review regression: defaultUnitDispatcher extracts the harness
    // session id (e.g. codex `session_configured`), but it used to evaporate
    // inside dispatchUnit — never reaching workflow_run_units.session_id.
    seedRun({ steps: [{ id: "extract", title: "Extract facts" }] });
    const stepPlan = plan(SCHEMA_WF).steps[0];
    const ctx = { runId: RUN_ID, workflowRef: "workflow:demo", params: {}, evidence: {} };

    const first = await executeStepPlan(stepPlan, {
      ...ctx,
      dispatcher: async () => ({ ok: true, text: '{"fact": "bun is fast"}', sessionId: "codex-abc-123" }),
    });
    expect(first.ok).toBe(true);
    expect(first.units[0].sessionId).toBe("codex-abc-123");

    await withWorkflowRunsRepo((repo) => {
      const rows = repo.getUnitsForStep(RUN_ID, "extract");
      expect(rows).toHaveLength(1);
      expect(rows[0].session_id).toBe("codex-abc-123");
    });

    // Durable-row reuse rehydrates the journaled session id without re-dispatch.
    const second = await executeStepPlan(stepPlan, {
      ...ctx,
      dispatcher: async () => {
        throw new Error("must not re-dispatch");
      },
    });
    expect(second.ok).toBe(true);
    expect(second.units[0].sessionId).toBe("codex-abc-123");
  });

  test("a failed unit still journals the session id revealed before the failure", async () => {
    seedRun({ params: { files: ["a"] }, steps: [{ id: "review", title: "Review files" }] });
    const stepPlan = plan(FAN_OUT_WF).steps[0];
    const result = await executeStepPlan(stepPlan, {
      runId: RUN_ID,
      workflowRef: "workflow:demo",
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
      expect(rows[0].status).toBe("failed");
      expect(rows[0].session_id).toBe("sess-before-crash");
    });
  });

  test("units whose dispatch reveals no sessionId journal NULL", async () => {
    seedRun({ params: { files: ["a"] }, steps: [{ id: "review", title: "Review files" }] });
    const stepPlan = plan(FAN_OUT_WF).steps[0];
    await executeStepPlan(stepPlan, {
      runId: RUN_ID,
      workflowRef: "workflow:demo",
      params: { files: ["a"] },
      evidence: {},
      dispatcher: async () => ({ ok: true, text: "done" }),
    });
    await withWorkflowRunsRepo((repo) => {
      expect(repo.getUnitsForStep(RUN_ID, "review")[0].session_id).toBeNull();
    });
  });
});

describe("executeStepPlan — durable-row reuse (peer review)", () => {
  test("re-executing a step reuses completed units with the same input hash instead of re-dispatching", async () => {
    seedRun({ params: { files: ["a", "b"] }, steps: [{ id: "review", title: "Review files" }] });
    const stepPlan = plan(FAN_OUT_WF).steps[0];
    const ctx = {
      runId: RUN_ID,
      workflowRef: "workflow:demo",
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
    expect(second.units.map((u) => u.text)).toEqual([
      "run1 review.unit:ac8d8342bbb2", // "a"
      "run1 review.unit:c100f95c1913", // "b"
    ]);
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
    const stepPlan = plan(FAN_OUT_WF).steps[0];
    let dispatches = 0;
    const dispatcher = async () => {
      dispatches++;
      return { ok: true, text: "done" };
    };
    await executeStepPlan(stepPlan, {
      runId: RUN_ID,
      workflowRef: "workflow:demo",
      params: { files: ["a"] },
      evidence: {},
      dispatcher,
    });
    // Content-derived identity: a different item is a different unit id — it
    // never matches the journaled row, so it dispatches live (no divergence:
    // divergence is same-id-different-hash, covered in the R2 identity suite).
    await executeStepPlan(stepPlan, {
      runId: RUN_ID,
      workflowRef: "workflow:demo",
      params: { files: ["a-changed"] },
      evidence: {},
      dispatcher,
    });
    expect(dispatches).toBe(2);
  });
});

describe("executeStepPlan — content-derived unit identity (R2)", () => {
  // Fan-out over a PRIOR STEP's output so the item list can be reordered
  // between invocations without touching params (params are frozen per run
  // and appear in the unit preamble — changing them changes every input
  // hash, which is the replay-divergence case below, not the reorder case).
  const REORDER_WF = `version: 1
name: Review
steps:
  - id: discover
    unit:
      instructions: Find files.
  - id: review
    title: Review files
    map:
      over: \${{ steps.discover.output.files }}
      unit:
        instructions: Review \${{ item }} carefully.
`;

  test("identity survives item-list reordering: a reshuffled producer output reuses every journaled result", async () => {
    seedRun({ steps: [{ id: "review", title: "Review files" }] });
    const stepPlan = plan(REORDER_WF).steps.find((s) => s.stepId === "review");
    if (!stepPlan) throw new Error("missing review step");
    const ctx = { runId: RUN_ID, workflowRef: "workflow:demo", params: {} };

    let dispatches = 0;
    const first = await executeStepPlan(stepPlan, {
      ...ctx,
      evidence: { discover: { files: ["a", "b"] } },
      dispatcher: async (req) => {
        dispatches++;
        return { ok: true, text: `did ${req.unitId}` };
      },
    });
    expect(first.ok).toBe(true);
    expect(dispatches).toBe(2);

    // Same items, different order (the producer regenerated its list): the
    // positional scheme would re-dispatch BOTH units; content identity
    // reuses both, and the outcomes follow the NEW item order.
    const second = await executeStepPlan(stepPlan, {
      ...ctx,
      evidence: { discover: { files: ["b", "a"] } },
      dispatcher: async () => {
        throw new Error("must not re-dispatch");
      },
    });
    expect(second.ok).toBe(true);
    expect(second.units.map((u) => u.text)).toEqual([
      "did review.unit:c100f95c1913", // "b"
      "did review.unit:ac8d8342bbb2", // "a"
    ]);
    await withWorkflowRunsRepo((repo) => {
      expect(repo.getUnitsForStep(RUN_ID, "review")).toHaveLength(2); // no extra rows
    });
  });

  test("duplicate fan-out items fail the step before any dispatch, naming the duplicate", async () => {
    // Duplicates collide on content-derived identity — an authoring error
    // (the module doc documents it as such), caught deterministically.
    seedRun({ params: { files: ["a", "b", "a"] }, steps: [{ id: "review", title: "Review files" }] });
    const stepPlan = plan(FAN_OUT_WF).steps[0];
    let dispatches = 0;
    const result = await executeStepPlan(stepPlan, {
      runId: RUN_ID,
      workflowRef: "workflow:demo",
      params: { files: ["a", "b", "a"] },
      evidence: {},
      dispatcher: async () => {
        dispatches++;
        return { ok: true, text: "must not run" };
      },
    });
    expect(result.ok).toBe(false);
    expect(dispatches).toBe(0);
    expect(result.summary).toContain("duplicate items");
    expect(result.summary).toContain("indices 0 and 2");
    expect(result.summary).toContain('"a"');
    await withWorkflowRunsRepo((repo) => {
      expect(repo.getUnitsForStep(RUN_ID, "review")).toHaveLength(0); // nothing journaled
    });
  });

  const DIVERGENCE_WF = `version: 1
name: Review
params:
  files: { type: array }
steps:
  - id: review
    title: Review files
    map:
      over: \${{ params.files }}
      unit:
        on_error: continue
        instructions: Review \${{ item }} carefully.
`;

  test("replay divergence: a journaled COMPLETED row with matching id but different input_hash fails the step hard — even under on_error: continue", async () => {
    seedRun({ params: { files: ["a"] }, steps: [{ id: "review", title: "Review files" }] });
    const stepPlan = plan(DIVERGENCE_WF).steps[0];
    let dispatches = 0;
    const dispatcher = async (req: UnitDispatchRequest): Promise<UnitDispatchResult> => {
      dispatches++;
      return { ok: true, text: `did ${req.unitId}` };
    };

    const first = await executeStepPlan(stepPlan, {
      runId: RUN_ID,
      workflowRef: "workflow:demo",
      params: { files: ["a"], note: "v1" },
      evidence: {},
      dispatcher,
    });
    expect(first.ok).toBe(true);
    expect(dispatches).toBe(1);

    // Same item ⇒ same content-derived unit id, but a different params blob
    // changes the unit preamble ⇒ different input hash. Under a frozen plan
    // this cannot happen legitimately (params are frozen with the run), so
    // it must fail LOUDLY — never silently re-dispatch — and on_error:
    // continue must NOT downgrade it to a tolerated unit failure.
    const second = await executeStepPlan(stepPlan, {
      runId: RUN_ID,
      workflowRef: "workflow:demo",
      params: { files: ["a"], note: "v2-tampered" },
      evidence: {},
      dispatcher,
    });
    expect(second.ok).toBe(false);
    expect(dispatches).toBe(1); // no re-dispatch
    expect(second.summary).toContain(
      'replay divergence: unit "review.unit:ac8d8342bbb2" was journaled with different inputs',
    );

    // The journaled row is untouched — the divergent invocation wrote nothing.
    await withWorkflowRunsRepo((repo) => {
      const rows = repo.getUnitsForStep(RUN_ID, "review");
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe("completed");
    });
  });

  test("pre-release R1 positional-id rows never match and are ignored: the step re-runs cleanly on top of them", async () => {
    // R1 journals used positional ids (`review.unit[0]`). No back-compat
    // shim: the row never matches a content-derived id, never diverges, and
    // never crashes resume — the unit simply dispatches fresh.
    seedRun({ params: { files: ["a"] }, steps: [{ id: "review", title: "Review files" }] });
    await withWorkflowRunsRepo((repo) => {
      repo.insertUnit({
        runId: RUN_ID,
        unitId: "review.unit[0]",
        stepId: "review",
        nodeId: "review.unit",
        parentUnitId: "review.map",
        phase: null,
        runner: "llm",
        model: null,
        inputHash: "r1-era-hash",
        startedAt: new Date().toISOString(),
      });
      repo.finishUnit({
        runId: RUN_ID,
        unitId: "review.unit[0]",
        status: "completed",
        resultJson: JSON.stringify("r1 result"),
        tokens: null,
        failureReason: null,
        finishedAt: new Date().toISOString(),
      });
    });

    const stepPlan = plan(FAN_OUT_WF).steps[0];
    let dispatches = 0;
    const result = await executeStepPlan(stepPlan, {
      runId: RUN_ID,
      workflowRef: "workflow:demo",
      params: { files: ["a"] },
      evidence: {},
      dispatcher: async () => {
        dispatches++;
        return { ok: true, text: "fresh" };
      },
    });
    expect(result.ok).toBe(true);
    expect(dispatches).toBe(1);
    expect(result.units[0].unitId).toBe("review.unit:ac8d8342bbb2");
    expect(result.units[0].text).toBe("fresh");
    await withWorkflowRunsRepo((repo) => {
      const byId = new Map(repo.getUnitsForStep(RUN_ID, "review").map((r) => [r.unit_id, r.status]));
      expect(byId.get("review.unit[0]")).toBe("completed"); // the old row is left alone
      expect(byId.get("review.unit:ac8d8342bbb2")).toBe("completed");
    });
  });
});

describe("executeStepPlan — lifetime unit cap counts actual dispatches only (peer review R1)", () => {
  test("durable-row reuse is free: a journal-heavy resume near the cap reuses instead of tripping the pre-batch check", async () => {
    // Peer-review regression: the old pre-batch check (`journaled +
    // items.length > cap`) plus reuse-counted-as-dispatch made any
    // partially-completed fan-out with > ~cap/2 journaled units impossible
    // to resume. Now only real dispatches consume the cap.
    const { LIFETIME_UNIT_CAP } = await import("../../src/workflows/exec/scheduler");
    const files = Array.from({ length: 20 }, (_, i) => `f${i}.ts`);
    seedRun({ params: { files }, steps: [{ id: "review", title: "Review files" }] });
    const stepPlan = plan(FAN_OUT_WF).steps[0];
    const ctx = { runId: RUN_ID, workflowRef: "workflow:demo", params: { files }, evidence: {} };

    // First pass: 19 units complete, one fails → 20 journaled attempt rows.
    const first = await executeStepPlan(stepPlan, {
      ...ctx,
      dispatcher: async (req) =>
        req.prompt.includes("Review f7.ts")
          ? { ok: false, text: "", failureReason: "timeout", error: "timed out" }
          : { ok: true, text: `done ${req.unitId}` },
    });
    expect(first.ok).toBe(false);
    expect(first.unitsDispatched).toBe(20);

    // Resume with the journal seeded close to the cap (journaled + items
    // would blow past it): 19 reuses are free, exactly ONE unit dispatches.
    let dispatches = 0;
    const second = await executeStepPlan(stepPlan, {
      ...ctx,
      unitsDispatched: LIFETIME_UNIT_CAP - 10,
      dispatcher: async (req) => {
        dispatches++;
        return { ok: true, text: `retried ${req.unitId}` };
      },
    });
    expect(second.ok).toBe(true);
    expect(dispatches).toBe(1);
    expect(second.unitsDispatched).toBe(LIFETIME_UNIT_CAP - 10 + 1);
  });

  test("the cap still bites per dispatch: over-cap work fails the step after dispatching only the remaining budget", async () => {
    const { LIFETIME_UNIT_CAP } = await import("../../src/workflows/exec/scheduler");
    const files = ["a", "b", "c", "d", "e"];
    seedRun({ params: { files }, steps: [{ id: "review", title: "Review files" }] });
    const stepPlan = plan(FAN_OUT_WF).steps[0];
    let dispatches = 0;
    const result = await executeStepPlan(stepPlan, {
      runId: RUN_ID,
      workflowRef: "workflow:demo",
      params: { files },
      evidence: {},
      unitsDispatched: LIFETIME_UNIT_CAP - 2,
      maxConcurrency: 1,
      dispatcher: async () => {
        dispatches++;
        return { ok: true, text: "ok" };
      },
    });
    expect(dispatches).toBe(2); // only the budget that was left
    expect(result.ok).toBe(false);
    expect(result.summary).toContain("lifetime unit cap");
    expect(result.unitsDispatched).toBe(LIFETIME_UNIT_CAP);
  });
});

describe("step output promotion — ${{ steps.<id>.output }} addresses real results (peer review R1)", () => {
  const DOCS_SHAPE_WF = `version: 1
name: Review
steps:
  - id: discover
    title: Discover
    unit:
      instructions: List files.
      output:
        type: object
        properties: { files: { type: array, items: { type: string } } }
        required: [files]
  - id: review
    title: Review
    map:
      over: \${{ steps.discover.output.files }}
      unit:
        instructions: Review \${{ item }}.
  - id: summarize
    title: Summarize
    unit:
      instructions: "All: \${{ steps.review.output }} First: \${{ steps.review.output[0] }}"
`;

  test("the documented addressing works end-to-end: solo result feeds map.over, collect array feeds a later unit", async () => {
    // The flagship docs example shape (docs/features/workflows.md): a solo
    // unit's structured result is the step output — NOT the internal
    // evidence envelope {units, itemCount} — and a collect fan-out's output
    // is the array of per-item results in item order.
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
      loadPlan: async () => plan(DOCS_SHAPE_WF),
    });

    expect(result.done).toBe(true);
    expect(result.executed.map((s) => s.stepId)).toEqual(["discover", "review", "summarize"]);
    // map.over resolved the solo unit's structured result — one unit per file.
    expect(prompts.filter((p) => p.includes("Review a.ts.") || p.includes("Review b.ts.")).length).toBe(2);
    // The collect artifact is the per-item value array (canonical JSON in
    // templates); [0] addresses the first item's result.
    const summarizePrompt = prompts[prompts.length - 1];
    expect(summarizePrompt).toContain('All: ["verdict:review.unit:8b3148685648","verdict:review.unit:630647ca5751"]');
    expect(summarizePrompt).toContain("First: verdict:review.unit:8b3148685648");
  });

  const VOTE_ROUTE_WF = `version: 1
name: VoteRoute
params:
  attempts: { type: array }
steps:
  - id: judge
    title: Judge
    map:
      over: \${{ params.attempts }}
      reducer: vote
      unit:
        instructions: Judge \${{ item }}.
        output:
          type: object
          properties: { verdict: { type: string } }
          required: [verdict]
  - id: triage
    title: Triage
    route:
      input: \${{ steps.judge.output.verdict }}
      when: { pass: ship, fail: rework }
  - id: ship
    title: Ship
    unit:
      instructions: Ship it.
  - id: rework
    title: Rework
    unit:
      instructions: Rework it.
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
      loadPlan: async () => plan(VOTE_ROUTE_WF),
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
  const TWO_STEP_WF = `version: 1
name: Demo
params:
  flavor: { type: string }
steps:
  - id: first
    title: First
    unit:
      instructions: Do first.
  - id: second
    title: Second
    unit:
      instructions: Do second with \${{ params.flavor }}.
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
    const result = await runWorkflowSteps({
      target: RUN_ID,
      dispatcher: async (req) => {
        prompts.push(req.prompt);
        return { ok: true, text: `did ${req.nodeId}` };
      },
      loadPlan: async () => plan(TWO_STEP_WF),
    });

    expect(result.executed.map((s) => s.stepId)).toEqual(["first", "second"]);
    expect(result.done).toBe(true);
    expect(prompts[1]).toContain("vanilla");

    const status = await getWorkflowStatus(RUN_ID);
    expect(status.run.status).toBe("completed");
    expect(status.workflow.steps.every((s) => s.status === "completed")).toBe(true);
    // Evidence carries the unit outcomes for downstream steps/consumers.
    expect(status.workflow.steps[0].evidence?.units).toBeDefined();
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
      loadPlan: async () => plan(TWO_STEP_WF),
    });

    expect(result.executed).toHaveLength(1);
    expect(result.executed[0].ok).toBe(false);
    expect(result.done).toBeUndefined();
    const status = await getWorkflowStatus(RUN_ID);
    expect(status.run.status).toBe("failed");
  });

  test("refuses a non-active run BEFORE dispatching any unit (peer review #2)", async () => {
    seedRun({ steps: [{ id: "first", title: "First" }] });
    const db = openWorkflowDatabase(path.join(tmpDir, "workflow.db"));
    try {
      db.prepare("UPDATE workflow_runs SET status = 'failed' WHERE id = ?").run(RUN_ID);
    } finally {
      closeWorkflowDatabase(db);
    }
    let dispatches = 0;
    await expect(
      runWorkflowSteps({
        target: RUN_ID,
        dispatcher: async () => {
          dispatches++;
          return { ok: true, text: "must not run" };
        },
        loadPlan: async () => plan(TWO_STEP_WF),
      }),
    ).rejects.toThrow(/failed and cannot be executed/);
    expect(dispatches).toBe(0);
  });

  test("asserts reserved dependsOn edges before dispatching (peer review #6)", async () => {
    // No frontend emits dependsOn today, but a frozen plan may carry the
    // reserved edges — the engine still honors them as an ordering contract.
    seedRun({
      params: { flavor: "vanilla" },
      steps: [
        { id: "first", title: "First" },
        { id: "second", title: "Second" },
      ],
    });
    const outOfOrder = plan(TWO_STEP_WF);
    outOfOrder.steps[0] = { ...outOfOrder.steps[0], dependsOn: ["second"] };
    let dispatches = 0;
    await expect(
      runWorkflowSteps({
        target: RUN_ID,
        dispatcher: async () => {
          dispatches++;
          return { ok: true, text: "must not run" };
        },
        loadPlan: async () => outOfOrder,
      }),
    ).rejects.toThrow(/depends on step "second"/);
    expect(dispatches).toBe(0);
  });

  test("the lifetime unit cap is seeded from the run's journal (peer review #4)", async () => {
    seedRun({ params: { flavor: "vanilla" }, steps: [{ id: "first", title: "First" }] });
    const { LIFETIME_UNIT_CAP } = await import("../../src/workflows/exec/scheduler");
    await withWorkflowRunsRepo((repo) => {
      for (let i = 0; i < LIFETIME_UNIT_CAP; i++) {
        repo.insertUnit({
          runId: RUN_ID,
          unitId: `prior[${i}]`,
          stepId: "warm-up",
          nodeId: "warm-up.unit",
          parentUnitId: null,
          phase: null,
          runner: null,
          model: null,
          inputHash: null,
          startedAt: new Date().toISOString(),
        });
      }
    });
    const result = await runWorkflowSteps({
      target: RUN_ID,
      dispatcher: async () => ({ ok: true, text: "should be blocked by the cap" }),
      loadPlan: async () => plan(TWO_STEP_WF),
    });
    expect(result.executed[0].ok).toBe(false);
    expect(result.executed[0].summary).toContain("lifetime unit cap");
    expect(result.run.status).toBe("failed");
  });

  const ROUTED_WF = `version: 1
name: Router
steps:
  - id: classify
    title: Classify
    unit:
      instructions: Classify.
      output:
        type: object
        properties: { kind: { type: string } }
        required: [kind]
  - id: triage
    title: Triage
    route:
      input: \${{ steps.classify.output.kind }}
      when: { bug: fix-bug, feature: build-feature }
  - id: fix-bug
    title: Fix bug
    unit:
      instructions: Fix it.
  - id: build-feature
    title: Build feature
    unit:
      instructions: Build it.
  - id: wrap-up
    title: Wrap up
    unit:
      instructions: Wrap up.
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
      loadPlan: async () => plan(ROUTED_WF),
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
      input: "${{ steps.classify.output.kind }}",
      value: "bug",
      selected: "fix-bug",
    });
  });

  test("routing: falls back to default, and an unroutable value fails the step", async () => {
    const DEFAULTED_WF = `version: 1
name: Router
steps:
  - id: classify
    title: Classify
    unit:
      instructions: Classify.
      output:
        type: object
        properties: { kind: { type: string } }
        required: [kind]
  - id: triage
    title: Triage
    route:
      input: \${{ steps.classify.output.kind }}
      when: { bug: fix-bug }
      default: manual-triage
  - id: fix-bug
    title: Fix bug
    unit:
      instructions: Fix it.
  - id: manual-triage
    title: Manual triage
    unit:
      instructions: Triage it.
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
      loadPlan: async () => plan(DEFAULTED_WF),
    });
    expect(result.done).toBe(true);
    const status = await getWorkflowStatus(RUN_ID);
    const byId = new Map(status.workflow.steps.map((s) => [s.id, s]));
    expect(byId.get("fix-bug")?.status).toBe("skipped");
    expect(byId.get("manual-triage")?.status).toBe("completed");

    // Unroutable: no matching branch and no default → the route step fails.
    const NO_DEFAULT_WF = DEFAULTED_WF.replace("      default: manual-triage\n", "").replace(
      /^ {2}- id: manual-triage[\s\S]*$/m,
      "",
    );
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
      loadPlan: async () => plan(NO_DEFAULT_WF),
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
      loadPlan: async () => plan(ROUTED_WF),
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
      loadPlan: async () => plan(ROUTED_WF),
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
      loadPlan: async () => plan(ROUTED_WF),
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
      loadPlan: async () => plan(ROUTED_WF),
    });
    // Deterministic re-derivation from the frozen plan + journaled evidence:
    // classify's journaled output still says "bug", so fix-bug runs.
    expect(resumed.done).toBe(true);
    expect(resumedNodes).toEqual(["fix-bug", "wrap-up"]);
  });

  test("resume fails loudly when a completed route step's decision is unrecoverable (never runs every branch)", async () => {
    seedRun({ steps: ROUTED_STEPS });
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
        loadPlan: async () => plan(ROUTED_WF),
      }),
    ).rejects.toThrow(/route step "triage" with no journaled route/);
    expect(dispatches).toBe(0);
  });

  const CASCADE_WF = `version: 1
name: Cascade
params:
  pick: { type: string }
steps:
  - id: classify
    title: Classify
    route:
      input: \${{ params.pick }}
      when: { left: branch-router, right: safe }
  - id: branch-router
    title: Branch router
    route:
      input: \${{ params.branch }}
      when: { m: c1, n: c2 }
  - id: safe
    title: Safe
    unit:
      instructions: Safe path.
  - id: c1
    title: C1
    unit:
      instructions: Branch c1.
  - id: c2
    title: C2
    unit:
      instructions: Branch c2.
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
      loadPlan: async () => plan(CASCADE_WF),
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
    // Stop right after branch-router was journaled as skipped, then resume
    // with fresh in-memory bookkeeping: seedJournaledRouteDecisions must
    // cascade from the SKIPPED status (there is no journaled decision to
    // replay — the router never decided anything).
    seedRun({ params: { pick: "right" }, steps: CASCADE_STEPS });
    const first = await runWorkflowSteps({
      target: RUN_ID,
      maxSteps: 2,
      dispatcher: async () => ({ ok: true, text: "done" }),
      loadPlan: async () => plan(CASCADE_WF),
    });
    expect(first.executed.map((s) => s.stepId)).toEqual(["classify", "branch-router"]);

    const dispatched: string[] = [];
    const resumed = await runWorkflowSteps({
      target: RUN_ID,
      dispatcher: async (req) => {
        dispatched.push(req.nodeId);
        return { ok: true, text: "done" };
      },
      loadPlan: async () => plan(CASCADE_WF),
    });
    expect(resumed.done).toBe(true);
    expect(dispatched).toEqual(["safe"]);
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
    seedRun({ params: { files }, steps: [{ id: "review", title: "Review files" }] });
    const failing = await runWorkflowSteps({
      target: RUN_ID,
      dispatcher: async (req) =>
        req.prompt.includes("Review f3")
          ? { ok: false, text: "", failureReason: "timeout", error: "timed out" }
          : { ok: true, text: "done" },
      loadPlan: async () => plan(FAN_OUT_WF),
    });
    expect(failing.run.status).toBe("failed");

    const { resumeWorkflowRun } = await import("../../src/workflows/runtime/runs");
    await resumeWorkflowRun(RUN_ID);

    let dispatches = 0;
    const resumed = await runWorkflowSteps({
      target: RUN_ID,
      dispatcher: async () => {
        dispatches++;
        return { ok: true, text: "done" };
      },
      loadPlan: async () => plan(FAN_OUT_WF),
    });
    expect(dispatches).toBe(1);
    expect(resumed.done).toBe(true);
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
      loadPlan: async () => plan(TWO_STEP_WF),
    });
    expect(result.executed).toHaveLength(1);
    const status = await getWorkflowStatus(RUN_ID);
    expect(status.run.status).toBe("active");
    expect(status.run.currentStepId).toBe("second");
  });
});

describe("defaultUnitDispatcher — llm failures map into the retry taxonomy (peer review)", () => {
  test("llmFailureReasonFor maps every LlmCallErrorCode to a reason retry.on accepts", () => {
    expect(llmFailureReasonFor("timeout")).toBe("timeout");
    expect(llmFailureReasonFor("rate_limited")).toBe("llm_rate_limit");
    expect(llmFailureReasonFor("parse_error")).toBe("parse_error");
    expect(llmFailureReasonFor("provider_html_error")).toBe("parse_error");
    expect(llmFailureReasonFor("network_error")).toBe("spawn_failed");
    expect(llmFailureReasonFor("provider_error")).toBe("spawn_failed");
    // Closed loop with the program parser: every mapped value is a reason the
    // parser accepts in `retry.on` — an out-of-taxonomy value ("llm_error")
    // would make the declared failure policy dead for the whole llm runner.
    const codes = [
      "timeout",
      "rate_limited",
      "parse_error",
      "provider_html_error",
      "network_error",
      "provider_error",
    ] as const;
    for (const code of codes) {
      expect(PROGRAM_RETRY_REASONS).toContain(llmFailureReasonFor(code));
    }
  });

  const LLM_RETRY_WF = `version: 1
name: Flaky
defaults:
  runner: llm
steps:
  - id: fetch
    title: Fetch
    unit:
      retry: { max: 1, on: [llm_rate_limit] }
      instructions: Fetch the thing.
`;

  test("an HTTP 429 journals llm_rate_limit and `retry: { on: [llm_rate_limit] }` re-dispatches", async () => {
    seedRun({ steps: [{ id: "fetch", title: "Fetch" }] });
    const stepPlan = plan(LLM_RETRY_WF).steps[0];

    const cfgDir = makeSandboxDir("akm-llm-cfg");
    let calls = 0;
    try {
      await withEnv({ XDG_CONFIG_HOME: cfgDir.dir }, async () => {
        writeSandboxConfig({
          profiles: { llm: { default: { endpoint: "http://localhost:1/v1/chat/completions", model: "test" } } },
        });
        await withMockedFetch(
          async () => {
            // NO injected dispatcher: the default llm dispatch path is under test.
            const result = await executeStepPlan(stepPlan, {
              runId: RUN_ID,
              workflowRef: "workflow:demo",
              params: {},
              evidence: {},
            });
            expect(result.ok).toBe(true);
            expect(calls).toBe(2); // 429, then success — the retry actually fired
            // Reduced outcome carries the content-derived base id; the retry
            // attempt's `~r1` suffix stays on the journal row (R4 evidence parity).
            expect(result.units[0].unitId).toBe("fetch:solo");
          },
          () => {
            calls++;
            return calls === 1
              ? new Response("rate limited", { status: 429 })
              : new Response(JSON.stringify({ choices: [{ message: { content: "finally" } }] }), {
                  status: 200,
                  headers: { "content-type": "application/json" },
                });
          },
        );
      });
    } finally {
      cfgDir.cleanup();
    }

    // The journal speaks the persisted failure_reason taxonomy, not "llm_error".
    await withWorkflowRunsRepo((repo) => {
      const byId = new Map(repo.getUnitsForStep(RUN_ID, "fetch").map((r) => [r.unit_id, r]));
      expect(byId.get("fetch:solo")?.status).toBe("failed");
      expect(byId.get("fetch:solo")?.failure_reason).toBe("llm_rate_limit");
      expect(byId.get("fetch:solo~r1")?.status).toBe("completed");
    });
  });
});
