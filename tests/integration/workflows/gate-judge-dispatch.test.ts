// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import path from "node:path";
import type { AkmConfig } from "../../../src/core/config/config";
import { openStateDatabase } from "../../../src/core/state-db";
import { withWorkflowRunsRepo } from "../../../src/storage/repositories/workflow-runs-repository";
import type { UnitDispatchRequest, UnitDispatchResult } from "../../../src/workflows/exec/native-executor";
import { runWorkflowSteps } from "../../../src/workflows/exec/run-workflow";
import { computeStepWorkList, recoverGateFeedback } from "../../../src/workflows/exec/step-work";
import { compileResolveFreezeWorkflow } from "../../../src/workflows/ir/freeze";
import type { WorkflowPlanGraph } from "../../../src/workflows/ir/schema";
import { parseWorkflow } from "../../../src/workflows/parser";
import { getWorkflowStatus, resumeWorkflowRun } from "../../../src/workflows/runtime/runs";
import { sandboxEnvDir } from "../../_helpers/sandbox";
import { storeFrozenWorkflowPlan } from "../../_helpers/workflow";

/**
 * The gate judge is a real dispatch, held to the same two contracts every unit
 * dispatch is held to. Before this suite it was held to neither:
 *
 *   1. **Redaction.** A judge response IS journaled — `journalGateEvaluationFinish`
 *      writes the parsed verdict into the gate row's `result_json`, and a judge
 *      failure's message becomes the blocked step's notes. The judge path used to
 *      pass no `sensitiveValues` and skip `redactUnitOutcome` entirely, so it was
 *      the ONE dispatch path that wrote to the journal without the scrub.
 *   2. **Identity.** The dispatch request used to carry the literal placeholders
 *      `runId/stepId/unitId/nodeId = "gate"`, so per-dispatch telemetry, harness
 *      session-id capture, and harness-side correlation were wrong for every
 *      judge call and identical across all of them.
 *
 * Everything the recent gate work established must survive: fail-closed verdicts,
 * a thrown/malformed judge blocking resumably WITHOUT consuming a gate loop, and
 * journaled-replay determinism (resume reuses units instead of re-dispatching).
 *
 * The fixture uses a real AGENT judge engine (`codex`) so the judge goes through
 * the injected {@link UnitDispatcher} seam, while the UNIT engine
 * (`opencode-sdk`) has an EMPTY `envPassthrough`. That asymmetry is the point:
 * the only path that can know the judge's secret is the judge's own
 * sensitive-value collection.
 */

const JUDGE_CONFIG = {
  configVersion: "0.9.0",
  semanticSearchMode: "off",
  engines: {
    "test-agent": { kind: "agent", platform: "opencode-sdk" },
    "test-llm": { kind: "llm", endpoint: "http://localhost:1/v1/chat/completions", model: "test-model" },
    // `codex` passes OPENAI_API_KEY through to its child and that name is NOT on
    // the redaction allowlist, so its value is a genuine dispatch secret.
    "judge-agent": { kind: "agent", platform: "codex" },
  },
  defaults: { engine: "test-agent", llmEngine: "test-llm" },
  workflow: { judgeEngine: "judge-agent" },
} as const satisfies AkmConfig;

/** The judge engine's passthrough credential — the secret under test. */
const SECRET_ENV = "OPENAI_API_KEY";
const SECRET = "sk-live-gate-judge-must-never-be-journaled";

let tmpDir = "";
let cleanupSandbox: (() => void) | undefined;
let prevSecret: string | undefined;

const RUN_ID = "77777777-7777-4777-8777-777777777777";

const GATED_WF = `---
type: workflow
steps:
  - id: work
    gate: { max_loops: 1 }
---

## work

Do the work.

### gate

the work is thorough
`;

const LOOPED_WF = `---
type: workflow
steps:
  - id: work
    gate: { max_loops: 2 }
---

## work

Do the work.

### gate

the work is thorough
`;

function freezeWithAgentJudge(markdown: string): WorkflowPlanGraph {
  const parsed = parseWorkflow(markdown, { path: "workflows/demo.md" });
  if (!parsed.ok) throw new Error(parsed.errors.map((e) => `${e.line}: ${e.message}`).join(" | "));
  return compileResolveFreezeWorkflow(
    {
      ref: "workflows/demo",
      path: "workflows/demo.md",
      sourcePath: "/tmp",
      title: "demo",
      steps: [],
      document: parsed.document,
    },
    JUDGE_CONFIG,
  ).plan;
}

function seedRun(): void {
  const db = openStateDatabase(path.join(tmpDir, "state.db"));
  try {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO workflow_runs
         (id, workflow_ref, scope_key, workflow_entry_id, workflow_title, status,
          params_json, current_step_id, created_at, updated_at)
       VALUES (?, 'workflows/demo', 'dir:v1:demo', NULL, 'Demo', 'active', '{}', 'work', ?, ?)`,
    ).run(RUN_ID, now, now);
    db.prepare(
      `INSERT INTO workflow_run_steps
         (run_id, step_id, step_title, instructions, completion_json, sequence_index, status)
       VALUES (?, 'work', 'work', 'instructions', ?, 0, 'pending')`,
    ).run(RUN_ID, JSON.stringify(["the work is thorough"]));
  } finally {
    db.close();
  }
}

function usePlan(markdown: string): () => Promise<WorkflowPlanGraph> {
  const frozen = freezeWithAgentJudge(markdown);
  const db = openStateDatabase(path.join(tmpDir, "state.db"));
  try {
    storeFrozenWorkflowPlan(db, RUN_ID, frozen);
  } finally {
    db.close();
  }
  return async () => frozen;
}

/** True for a gate-judge dispatch: the gate's node id is `<stepId>.gate`. */
function isGateDispatch(req: UnitDispatchRequest): boolean {
  return req.nodeId === "work.gate";
}

beforeEach(() => {
  // `sandboxEnvDir` owns the mkdtemp + AKM_DATA_DIR save/restore so this file
  // stays clean under the test-isolation lint (no raw mkdtempSync + AKM env
  // assignment here). The judge credential is a plain process env var, snapshot
  // and restored below.
  const sandbox = sandboxEnvDir("akm-gate-judge-", "AKM_DATA_DIR");
  tmpDir = sandbox.dir;
  cleanupSandbox = sandbox.cleanup;
  prevSecret = process.env[SECRET_ENV];
  process.env[SECRET_ENV] = SECRET;
});

afterEach(() => {
  if (prevSecret === undefined) delete process.env[SECRET_ENV];
  else process.env[SECRET_ENV] = prevSecret;
  cleanupSandbox?.();
  cleanupSandbox = undefined;
});

/** Every string the run journaled, so a leak anywhere in durable state is caught. */
async function journaledText(): Promise<string> {
  const units = await withWorkflowRunsRepo((repo) => repo.getUnitsForRun(RUN_ID));
  const status = await getWorkflowStatus(RUN_ID);
  return JSON.stringify({ units, status });
}

// ── 1. Redaction: the judge response is scrubbed before it is journaled ──────

describe("gate judge redaction — a judge response never journals a dispatch secret verbatim", () => {
  test("an echoed passthrough secret is journaled REDACTED in the gate row's verdict", async () => {
    seedRun();
    const loadPlan = usePlan(GATED_WF);
    const result = await runWorkflowSteps({
      target: RUN_ID,
      loadPlan,
      dispatcher: async (req): Promise<UnitDispatchResult> =>
        isGateDispatch(req)
          ? {
              ok: true,
              // The judge echoes a secret it saw in its own environment.
              text: JSON.stringify({
                complete: false,
                missing: [`the work is thorough (auth used ${SECRET})`],
                feedback: `Redo it; the run authenticated with ${SECRET}.`,
              }),
            }
          : { ok: true, text: "did the work" },
    });

    // Fail-closed: an honest rejection with no loop budget left exhausts the gate.
    expect(result.gateRejection?.stepId).toBe("work");
    expect(result.judgeFailure).toBeUndefined();

    // The verdict IS journaled — and it is journaled redacted.
    const gate = await withWorkflowRunsRepo((repo) =>
      repo.getUnitsForStep(RUN_ID, "work").find((r) => r.unit_id === "work.gate:l1"),
    );
    expect(gate?.status).toBe("completed");
    const verdict = JSON.parse(gate?.result_json ?? "null");
    expect(verdict.complete).toBe(false);
    expect(gate?.result_json).not.toContain(SECRET);
    expect(gate?.result_json).toContain("[REDACTED]");
    expect(verdict.feedback).toBe("Redo it; the run authenticated with [REDACTED].");
    expect(verdict.missing).toEqual(["the work is thorough (auth used [REDACTED])"]);

    // …and the live rejection surfaced to the caller matches the journaled one
    // byte for byte, so a resume cannot rebuild a different artifact.
    expect(result.gateRejection?.feedback).toBe(verdict.feedback);
    expect(result.gateRejection?.missing).toEqual(verdict.missing);

    // Nothing anywhere in durable run state carries the secret.
    expect(await journaledText()).not.toContain(SECRET);
  });

  test("a FAILED judge dispatch's error is redacted before it becomes the blocked step's notes", async () => {
    seedRun();
    const loadPlan = usePlan(GATED_WF);
    const result = await runWorkflowSteps({
      target: RUN_ID,
      loadPlan,
      dispatcher: async (req): Promise<UnitDispatchResult> =>
        isGateDispatch(req)
          ? { ok: false, text: "", failureReason: "spawn_failed", error: `codex rejected key ${SECRET}` }
          : { ok: true, text: "did the work" },
    });

    // Verifier INFRASTRUCTURE failure, never an honest rejection.
    expect(result.judgeFailure?.stepId).toBe("work");
    expect(result.gateRejection).toBeUndefined();
    expect(result.judgeFailure?.message).toContain("[REDACTED]");
    expect(result.judgeFailure?.message).not.toContain(SECRET);
    expect(await journaledText()).not.toContain(SECRET);
  });

  test("the sensitive-value set travels ON the dispatch request, exactly as for a unit", async () => {
    seedRun();
    const loadPlan = usePlan(GATED_WF);
    let gateRequest: UnitDispatchRequest | undefined;
    await runWorkflowSteps({
      target: RUN_ID,
      loadPlan,
      dispatcher: async (req): Promise<UnitDispatchResult> => {
        if (isGateDispatch(req)) {
          gateRequest = req;
          return { ok: true, text: '{"complete": true, "missing": []}' };
        }
        return { ok: true, text: "did the work" };
      },
    });
    expect(gateRequest?.sensitiveValues).toContain(SECRET);
  });
});

// ── Replay determinism: redaction changes no hashed preimage ────────────────

describe("gate judge redaction is replay-deterministic — the recovered feedback rebuilds the same hash", () => {
  test("loop 2 threads the REDACTED feedback, and a journal replay recomputes the identical input hash", async () => {
    seedRun();
    const frozen = freezeWithAgentJudge(LOOPED_WF);
    const loadPlan = usePlan(LOOPED_WF);
    const workPrompts: string[] = [];
    let judged = 0;
    const result = await runWorkflowSteps({
      target: RUN_ID,
      loadPlan,
      dispatcher: async (req): Promise<UnitDispatchResult> => {
        if (isGateDispatch(req)) {
          judged++;
          return judged === 1
            ? {
                ok: true,
                text: JSON.stringify({
                  complete: false,
                  missing: ["the work is thorough"],
                  feedback: `Retry; the last attempt used ${SECRET}.`,
                }),
              }
            : { ok: true, text: '{"complete": true, "missing": []}' };
        }
        workPrompts.push(req.prompt);
        return { ok: true, text: `did ${req.unitId}` };
      },
    });

    expect(result.done).toBe(true);
    expect(workPrompts).toHaveLength(2);
    // Loop 2's LIVE prompt carries the redacted feedback — the secret never
    // round-trips back out through the next loop's dispatch either.
    expect(workPrompts[1]).toContain("Retry; the last attempt used [REDACTED].");
    expect(workPrompts[1]).not.toContain(SECRET);

    // The cardinal rule: what a resume rebuilds from the journal must hash
    // IDENTICALLY to what the live run dispatched. Recover the feedback the way
    // the engine does (`recoverGateFeedback` over the journaled rows), recompute
    // loop 2's work list, and compare against the journaled `~l2` row's hash.
    const rows = await withWorkflowRunsRepo((repo) => repo.getUnitsForRun(RUN_ID));
    const recovered = recoverGateFeedback(rows, "work", 2);
    expect(recovered?.feedback).toBe("Retry; the last attempt used [REDACTED].");
    expect(JSON.stringify(recovered)).not.toContain(SECRET);

    const replayed = computeStepWorkList(frozen.steps[0]!, {
      runId: RUN_ID,
      params: {},
      stepOutputs: {},
      gateLoop: 2,
      ...(recovered ? { gateFeedback: recovered } : {}),
      engines: frozen.execution?.engines,
    });
    if (!replayed.ok) throw new Error(replayed.error);
    const unit = replayed.list.units[0]!;
    if (!unit.resolved.ok) throw new Error(unit.resolved.error);
    const journaled = rows.find((r) => r.unit_id === unit.journalBaseId);
    expect(unit.journalBaseId).toBe("work:solo~l2");
    expect(journaled?.input_hash).toBe(unit.resolved.inputHash);
    // …and loop 2's hash still differs from loop 1's, so the loop really did
    // re-dispatch rather than reuse the rejected attempt's row.
    expect(journaled?.input_hash).not.toBe(rows.find((r) => r.unit_id === "work:solo")?.input_hash);
  });
});

// ── 2. Identity: the dispatch and the journaled gate row describe one thing ──

describe("gate judge identity — the dispatch names the REAL run/step and gate node/unit ids", () => {
  test("loop 1: the request ids equal the journaled gate row's ids", async () => {
    seedRun();
    const loadPlan = usePlan(GATED_WF);
    const gateRequests: UnitDispatchRequest[] = [];
    await runWorkflowSteps({
      target: RUN_ID,
      loadPlan,
      dispatcher: async (req): Promise<UnitDispatchResult> => {
        if (isGateDispatch(req)) {
          gateRequests.push(req);
          return { ok: true, text: '{"complete": true, "missing": []}' };
        }
        return { ok: true, text: "did the work" };
      },
    });

    expect(gateRequests).toHaveLength(1);
    const req = gateRequests[0]!;
    // The pre-fix synthetic identity is gone.
    expect(req.runId).not.toBe("gate");
    expect(req.runId).toBe(RUN_ID);
    expect(req.stepId).toBe("work");
    expect(req.nodeId).toBe("work.gate");
    expect(req.unitId).toBe("work.gate:l1");

    // …and the journal agrees, field for field.
    await withWorkflowRunsRepo((repo) => {
      const row = repo.getUnitsForStep(RUN_ID, "work").find((r) => r.unit_id === req.unitId);
      expect(row).toBeDefined();
      expect(row?.run_id).toBe(req.runId);
      expect(row?.step_id).toBe(req.stepId);
      expect(row?.node_id).toBe(req.nodeId);
    });
  });

  test("loop 2: the request's unit id follows the gate loop (<stepId>.gate:l<loop>)", async () => {
    seedRun();
    const loadPlan = usePlan(LOOPED_WF);
    const gateRequests: UnitDispatchRequest[] = [];
    let judged = 0;
    const result = await runWorkflowSteps({
      target: RUN_ID,
      loadPlan,
      dispatcher: async (req): Promise<UnitDispatchResult> => {
        if (isGateDispatch(req)) {
          gateRequests.push(req);
          judged++;
          return judged === 1
            ? {
                ok: true,
                text: '{"complete": false, "missing": ["the work is thorough"], "feedback": "Add the analysis."}',
              }
            : { ok: true, text: '{"complete": true, "missing": []}' };
        }
        return { ok: true, text: `did ${req.unitId}` };
      },
    });

    expect(result.done).toBe(true);
    expect(gateRequests.map((r) => r.unitId)).toEqual(["work.gate:l1", "work.gate:l2"]);
    expect(new Set(gateRequests.map((r) => r.nodeId))).toEqual(new Set(["work.gate"]));
    expect(new Set(gateRequests.map((r) => r.runId))).toEqual(new Set([RUN_ID]));

    await withWorkflowRunsRepo((repo) => {
      const gateIds = repo
        .getUnitsForStep(RUN_ID, "work")
        .filter((r) => r.node_id === "work.gate")
        .map((r) => r.unit_id)
        .sort();
      expect(gateIds).toEqual(gateRequests.map((r) => r.unitId).sort());
    });
  });

  test("the judge dispatch declares NO env bindings — a gate judge has no env surface", async () => {
    // `IrGateNode.judge` is an `IrInvocation` (engine/model/timeoutMs/llm); `env:`
    // exists only on `IrUnitNode`, and the v3 decoder rejects unknown invocation
    // keys — so there is nothing authored to thread, and the step's unit env is
    // scoped to the WORK, not to the verifier. Credentials still reach a judge
    // through its engine's `credential` / `envPassthrough`, which is exactly what
    // the sensitive-value assertions above prove.
    seedRun();
    const loadPlan = usePlan(GATED_WF);
    let gateRequest: UnitDispatchRequest | undefined;
    await runWorkflowSteps({
      target: RUN_ID,
      loadPlan,
      dispatcher: async (req): Promise<UnitDispatchResult> => {
        if (isGateDispatch(req)) {
          gateRequest = req;
          return { ok: true, text: '{"complete": true, "missing": []}' };
        }
        return { ok: true, text: "did the work" };
      },
    });
    expect(gateRequest).toBeDefined();
    expect(gateRequest?.env).toBeUndefined();
  });
});

// ── 3 + 4. Fail-closed, no loop consumed, and journaled-replay determinism ───

describe("frozen judge outage — fail-closed, no gate loop consumed, units reused on resume", () => {
  /** Drive the looped workflow once with a broken judge dispatch, then recover. */
  async function outageThenRecovery(brokenGate: () => UnitDispatchResult, expectedCause: string): Promise<void> {
    seedRun();
    const loadPlan = usePlan(LOOPED_WF);
    const workPrompts: string[] = [];
    const dispatcher = async (req: UnitDispatchRequest): Promise<UnitDispatchResult> => {
      if (isGateDispatch(req)) return brokenGate();
      workPrompts.push(req.prompt);
      return { ok: true, text: `did ${req.unitId}` };
    };

    const failed = await runWorkflowSteps({ target: RUN_ID, loadPlan, dispatcher });

    // ONE dispatch of the work unit — the outage did NOT re-run the subgraph.
    expect(workPrompts).toHaveLength(1);
    expect(workPrompts[0]).not.toContain("Completion-gate feedback");
    // Never a rejection; the run blocks for resume.
    expect(failed.done).toBeUndefined();
    expect(failed.gateRejection).toBeUndefined();
    expect(failed.judgeFailure?.stepId).toBe("work");
    expect(failed.judgeFailure?.message).toContain(expectedCause);
    expect(failed.judgeFailure?.message).toContain(`akm workflow resume ${RUN_ID}`);
    expect(failed.run.status).toBe("blocked");

    // The errored gate row journals NO verdict, so `activeGateLoop` /
    // `recoverGateFeedback` cannot mistake a judge outage for a rejection.
    await withWorkflowRunsRepo((repo) => {
      const gate = repo.getUnitsForStep(RUN_ID, "work").find((r) => r.unit_id === "work.gate:l1");
      expect(gate?.status).toBe("failed");
      expect(gate?.result_json).toBeNull();
    });

    // Resume with a HEALTHY judge: same loop 1, journaled unit reused.
    await resumeWorkflowRun(RUN_ID);
    const gateRequests: UnitDispatchRequest[] = [];
    const recovered = await runWorkflowSteps({
      target: RUN_ID,
      loadPlan,
      dispatcher: async (req): Promise<UnitDispatchResult> => {
        if (isGateDispatch(req)) {
          gateRequests.push(req);
          return { ok: true, text: '{"complete": true, "missing": []}' };
        }
        workPrompts.push(req.prompt);
        return { ok: true, text: `did ${req.unitId}` };
      },
    });

    expect(recovered.done).toBe(true);
    // Still ONE work dispatch, ever: resume reused the journaled unit row.
    expect(workPrompts).toHaveLength(1);
    // The gate re-evaluated at the SAME loop — the outage consumed no loop.
    expect(gateRequests.map((r) => r.unitId)).toEqual(["work.gate:l1"]);
    await withWorkflowRunsRepo((repo) => {
      const rows = repo.getUnitsForStep(RUN_ID, "work");
      // No `~l2` unit rows and no `gate:l2` row.
      expect(rows.map((r) => r.unit_id).sort()).toEqual(["work.gate:l1", "work:solo"]);
      const gate = rows.find((r) => r.unit_id === "work.gate:l1");
      expect(gate?.status).toBe("completed");
      expect(JSON.parse(gate?.result_json ?? "null")).toEqual({ complete: true, missing: [] });
    });
    const status = await getWorkflowStatus(RUN_ID);
    expect(status.run.status).toBe("completed");
  }

  test("a THROWING judge dispatch blocks resumably and consumes no gate loop", async () => {
    await outageThenRecovery(
      () => ({ ok: false, text: "", failureReason: "spawn_failed", error: "codex endpoint unreachable" }),
      "the verification judge failed (codex endpoint unreachable)",
    );
  });

  test("a MALFORMED judge verdict is infrastructure failure, not an honest rejection", async () => {
    await outageThenRecovery(
      () => ({ ok: true, text: "certainly! here is my verdict: it looks great" }),
      "malformed verdict",
    );
  });
});
