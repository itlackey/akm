// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * MULTI-PROCESS crash-window resume for a CHILD-composing parent (spec
 * docs/plans/specs/p3b-child-executor.md §5.2-§5.3, rows C-01…C-04). A real
 * `bun` driver is SIGKILLed at a precise durable window around child
 * publication/execution, and a fresh process converges the run exactly once —
 * the CHILD-level analogue of tests/integration/workflow-crash-windows.test.ts,
 * using its exact SIGKILL technique and the SAME
 * tests/integration/_helpers/workflow-crossproc.ts helper, UNCHANGED (spec
 * §5.2: the CHILD's own units dispatch through the identical fake-dispatcher
 * seam the parent's own leaf units would, since the child drive forwards the
 * SAME injected `dispatcher` down into its own `runWorkflowSteps` call — spec
 * row A-33 — so `dispatchCount(markerDir, <childUnitId>)` already counts them
 * with no helper change).
 *
 * RED phase: the child executor (`src/workflows/exec/child-workflow.ts`,
 * reached from the ONE dispatch seam in `native-executor.ts`) is not wired
 * yet, so a composing step's unit currently fails closed
 * (`WORKFLOW_CHILD_EXECUTION_UNSUPPORTED`) rather than driving a child run —
 * every scenario below fails today for that reason. This file references only
 * already-existing, already-typed APIs (repository accessors P3a shipped:
 * `childRunsOf`, `publishChildWorkflowRun`, `getRunById`, `getUnit`; the
 * existing `runWorkflowSteps`/`startWorkflowRun`/`resumeWorkflowRun` engine
 * entry points; `computeChildInvocationKey`, `computeStepWorkList`,
 * `frozenStepRows`, `canonicalPlanJson`/`computePlanHash`), so no
 * `@ts-expect-error` directive is needed anywhere in it — Implement makes
 * these assertions true by wiring the seam, not by changing any type this
 * file touches.
 *
 * Windows (mirroring workflow-crash-windows.test.ts's Window A/B naming,
 * shifted one level down to the CHILD):
 *
 *   CW-1 (C-01) — "the child row is published, before the child's own unit is
 *   well underway": kill as soon as the child row appears. Best-effort (no
 *   production hook exists between "publish" and "drive" to hold on
 *   precisely), so the held child unit MAY already be mid-dispatch by the
 *   time the kill lands — the assertions below (exactly one child row,
 *   exactly one `workflow_started` event, eventual convergence) hold
 *   regardless of exactly which sub-window the kill actually landed in.
 *
 *   CW-2 (C-02) — "a child unit row is `running`": held reliably via
 *   `CHAOS_HOLD_MATCH` on the child's own leaf unit's prompt, exactly like
 *   the top-level suite's Window A. Resume re-dispatches that ONE child unit
 *   exactly once and both runs complete.
 *
 *   CW-3 (C-03) — "the child is `completed`, the parent's composing unit row
 *   is not yet finalized": the child's held unit is released and the test
 *   races to kill the instant the CHILD's own run row flips to `completed` —
 *   before the PARENT's own unit-finalization write can land. Best-effort for
 *   the same reason as CW-1; even a slightly late kill (both fully done)
 *   still proves the invariant under test (resume dispatches ZERO child
 *   units), since a fully-converged run resumes as a pure no-op too.
 *
 * C-04 — two-parent-process contention on the SAME child. The parent's own
 * run lock already prevents two engines driving one PARENT (run-lock.test.ts),
 * so this is the CHILD-row analogue one level down — pre-publish the child
 * exactly as the engine will independently derive it, plant its OWN run lock
 * as held by another live process, then let a genuinely unheld, real engine
 * invocation drive the parent and observe the busy refusal. No subprocess is
 * needed for this one: the CONTRACT under test is CHILD-lock arbitration, not
 * process survival.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { getStateDbPath, openStateDatabase } from "../../../src/core/state-db";
import { readStateEvents } from "../../../src/storage/repositories/events-repository";
import {
  type PublishChildWorkflowRunInput,
  type WorkflowRunRow,
  WorkflowRunsRepository,
  withWorkflowRunsRepo,
} from "../../../src/storage/repositories/workflow-runs-repository";
import { computeChildInvocationKey } from "../../../src/workflows/exec/child-invocation";
import type { UnitDispatchResult } from "../../../src/workflows/exec/native-executor";
import { runWorkflowSteps } from "../../../src/workflows/exec/run-workflow";
import { computeStepWorkList } from "../../../src/workflows/exec/step-work";
import { canonicalPlanJson, computePlanHash } from "../../../src/workflows/ir/plan-hash";
import { decodeWorkflowPlanV4 } from "../../../src/workflows/ir/schema-v4";
import { frozenStepRows } from "../../../src/workflows/runtime/run-plan";
import { getWorkflowStatus, resumeWorkflowRun, startWorkflowRun } from "../../../src/workflows/runtime/runs";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeWorkflowTestConfig } from "../../_helpers/sandbox";
import { plantRunLock } from "../../_helpers/workflow";
import {
  bunAvailable,
  dispatchCount,
  holdStartExists,
  pollUntil,
  type RunnerChild,
  spawnRunner,
  unitIds,
  writeProgram,
} from "../_helpers/workflow-crossproc";

const BUN = bunAvailable();

let storage: IsolatedAkmStorage;
let markerDir: string;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  writeWorkflowTestConfig();
  markerDir = path.join(storage.root, "markers");
  fs.mkdirSync(markerDir, { recursive: true });
});

afterEach(() => storage.cleanup());

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** The child leaf: one plain unit whose prompt is distinctive enough for CHAOS_HOLD_MATCH to isolate. */
const CHILD_LEAF_WF = [
  "---",
  "type: workflow",
  "defaults: { engine: test-agent }",
  "steps:",
  "  - id: work",
  "---",
  "",
  "## work",
  "",
  "Do the child work now.",
  "",
].join("\n");

/** A GitHub-shaped parent (composition requires it — B-N4) with one composing step. */
function writeComposingParent(stashDir: string, name: string, childRef: string): void {
  const file = path.join(stashDir, "workflows", `${name}.yml`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    [
      `name: ${name}`,
      "on:",
      "  workflow_dispatch:",
      "jobs:",
      "  main:",
      "    runs-on: [self-hosted]",
      "    steps:",
      "      - id: dispatch",
      `        uses: ${childRef}`,
      "",
    ].join("\n"),
    "utf8",
  );
}

async function firstChildOf(parentRunId: string): Promise<string | undefined> {
  const children = await withWorkflowRunsRepo((repo) => repo.childRunsOf(parentRunId));
  return children[0]?.id;
}

/**
 * Wait for the parent's child row to appear, or for the crasher process to
 * exit first — whichever happens sooner. RED phase: today the composing
 * unit is handed to the plain injected fake dispatcher exactly like any
 * other unit (nothing at the dispatch seam yet routes a `child-workflow`
 * target away from it — spec §3.2), so the run completes trivially and the
 * process exits long before any child row is ever published. This fails
 * fast with a clear message instead of waiting out `pollUntil`'s own
 * timeout for a row that will never appear via today's path.
 */
async function waitForChildOrExit(parentRunId: string, crasher: RunnerChild, label: string): Promise<void> {
  const published = pollUntil(async () => (await firstChildOf(parentRunId)) !== undefined, { label });
  published.catch(() => {}); // a late timeout after we've already raced past it below is not a test failure
  const outcome = await Promise.race([
    published.then((): "published" => "published"),
    crasher.done().then((): "exited" => "exited"),
  ]);
  if (outcome === "exited") {
    throw new Error(
      `the crasher process exited before ${label} — expected until the child executor seam is wired ` +
        "(src/workflows/exec/child-workflow.ts): today's composing unit dispatches trivially instead of publishing a child",
    );
  }
}

describe.skipIf(!BUN)("multi-process crash windows around a composing child (C-01…C-03)", () => {
  test("CW-1 (C-01): SIGKILL as soon as the child row is published → resume finds it by invocation_key, no duplicate child, no duplicate workflow_started event", async () => {
    writeProgram(storage.stashDir, "cw1-leaf", CHILD_LEAF_WF);
    writeComposingParent(storage.stashDir, "cw1-parent", "workflows/cw1-leaf");
    const started = await startWorkflowRun("workflows/cw1-parent", {});
    expect(started.run.planIrVersion).toBe(5);
    const parentRunId = started.run.id;

    // Held on the child's own unit so the crasher can never race past this
    // window to full completion before the kill lands (see file header).
    const crasher = spawnRunner({
      CHAOS_RUN_ID: parentRunId,
      CHAOS_MARKER_DIR: markerDir,
      CHAOS_HOLD_MATCH: "Do the child work now",
    });
    await waitForChildOrExit(parentRunId, crasher, "the child row is published");
    crasher.kill("SIGKILL");
    await crasher.done();

    const childrenAtCrash = await withWorkflowRunsRepo((repo) => repo.childRunsOf(parentRunId));
    expect(childrenAtCrash).toHaveLength(1);
    const childRunId = childrenAtCrash[0]!.id;

    const resume = spawnRunner({ CHAOS_RUN_ID: parentRunId, CHAOS_MARKER_DIR: markerDir });
    expect(await resume.done()).toBe(0);

    const status = await getWorkflowStatus(parentRunId);
    expect(status.run.status).toBe("completed");

    const finalChildren = await withWorkflowRunsRepo((repo) => repo.childRunsOf(parentRunId));
    expect(finalChildren).toHaveLength(1);
    expect(finalChildren[0]?.id).toBe(childRunId);
    expect((await withWorkflowRunsRepo((repo) => repo.getRunById(childRunId)))?.status).toBe("completed");

    // The test's own name promises "no duplicate workflow_started event" —
    // childRunsOf(parent).length === 1 alone is satisfied by the unique
    // index on invocation_key and says nothing about the event append, so
    // read the events table directly (the readStateEvents technique already
    // used at tests/integration/workflows/child-execution.test.ts:393 and
    // tests/integration/storage/child-run-publication.test.ts:281).
    const eventsDb = openStateDatabase(getStateDbPath());
    let startedEventsForChild: number;
    try {
      startedEventsForChild = readStateEvents(eventsDb, { type: "workflow_started" }).events.filter(
        (event) => event.metadata?.runId === childRunId,
      ).length;
    } finally {
      eventsDb.close();
    }
    expect(startedEventsForChild).toBe(1);
  }, 45_000);

  test("CW-2 (C-02): SIGKILL mid-child-unit-dispatch → both runs resumable; resume re-dispatches ONLY the interrupted child unit, once", async () => {
    writeProgram(storage.stashDir, "cw2-leaf", CHILD_LEAF_WF);
    writeComposingParent(storage.stashDir, "cw2-parent", "workflows/cw2-leaf");
    const started = await startWorkflowRun("workflows/cw2-parent", {});
    const parentRunId = started.run.id;

    const crasher = spawnRunner({
      CHAOS_RUN_ID: parentRunId,
      CHAOS_MARKER_DIR: markerDir,
      CHAOS_HOLD_MATCH: "Do the child work now",
    });
    await waitForChildOrExit(parentRunId, crasher, "the child row is published");
    const childRunId = (await firstChildOf(parentRunId))!;
    const [childUnitId] = await unitIds(childRunId, {});
    await pollUntil(() => holdStartExists(markerDir, childUnitId!), { label: "the child's own unit is dispatching" });

    // Durable state at the kill point: the child's unit row is `running`,
    // dispatched exactly once so far — mirrors the top-level Window A's own
    // mid-row assertion, one level down.
    const midRow = await withWorkflowRunsRepo((repo) => repo.getUnit(childRunId, childUnitId!));
    expect(midRow?.status).toBe("running");
    expect(dispatchCount(markerDir, childUnitId!)).toBe(1);

    crasher.kill("SIGKILL");
    await crasher.done();

    const resume = spawnRunner({ CHAOS_RUN_ID: parentRunId, CHAOS_MARKER_DIR: markerDir });
    expect(await resume.done()).toBe(0);

    const status = await getWorkflowStatus(parentRunId);
    expect(status.run.status).toBe("completed");
    expect((await withWorkflowRunsRepo((repo) => repo.getRunById(childRunId)))?.status).toBe("completed");
    // Dispatched twice total (killed invocation + the single resume
    // invocation) but reclaims the same durable attempt in place — the
    // identical "stable 1-based attempt ordinal despite two dispatches"
    // contract the top-level Window A pins.
    expect(dispatchCount(markerDir, childUnitId!)).toBe(2);
    const finalRow = await withWorkflowRunsRepo((repo) => repo.getUnit(childRunId, childUnitId!));
    expect(finalRow?.status).toBe("completed");
    expect(finalRow?.attempts).toBe(1);

    // No duplicate child was ever published across the crash + resume.
    const children = await withWorkflowRunsRepo((repo) => repo.childRunsOf(parentRunId));
    expect(children).toHaveLength(1);
  }, 45_000);

  test("CW-3 (C-03): SIGKILL after the child completes but before the parent's composing unit finalizes → resume completes the parent WITHOUT re-running the child", async () => {
    const releaseFile = path.join(storage.root, "cw3-release");
    writeProgram(storage.stashDir, "cw3-leaf", CHILD_LEAF_WF);
    writeComposingParent(storage.stashDir, "cw3-parent", "workflows/cw3-leaf");
    const started = await startWorkflowRun("workflows/cw3-parent", {});
    const parentRunId = started.run.id;

    const crasher = spawnRunner({
      CHAOS_RUN_ID: parentRunId,
      CHAOS_MARKER_DIR: markerDir,
      CHAOS_HOLD_MATCH: "Do the child work now",
      CHAOS_RELEASE_FILE: releaseFile,
    });
    await waitForChildOrExit(parentRunId, crasher, "the child row is published");
    const childRunId = (await firstChildOf(parentRunId))!;
    const [childUnitId] = await unitIds(childRunId, {});
    await pollUntil(() => holdStartExists(markerDir, childUnitId!), { label: "the child's own unit is dispatching" });

    // Release the hold, then race to kill the instant the CHILD flips to
    // `completed` — before the PARENT's own composing-unit journal write can
    // land (see file header for why this is inherently best-effort).
    fs.writeFileSync(releaseFile, "go");
    await pollUntil(
      async () => (await withWorkflowRunsRepo((repo) => repo.getRunById(childRunId)))?.status === "completed",
      { label: "the child run completes", intervalMs: 5 },
    );
    crasher.kill("SIGKILL");
    await crasher.done();

    const dispatchCountAtCrash = dispatchCount(markerDir, childUnitId!);

    const resume = spawnRunner({ CHAOS_RUN_ID: parentRunId, CHAOS_MARKER_DIR: markerDir });
    expect(await resume.done()).toBe(0);

    const status = await getWorkflowStatus(parentRunId);
    expect(status.run.status).toBe("completed");
    // The child was already terminal at the crash point — resume must not
    // dispatch ANY of its units again, regardless of exactly how close the
    // kill landed to the parent's own finalization write.
    expect(dispatchCount(markerDir, childUnitId!)).toBe(dispatchCountAtCrash);

    const finalChildren = await withWorkflowRunsRepo((repo) => repo.childRunsOf(parentRunId));
    expect(finalChildren).toHaveLength(1);
    expect(finalChildren[0]?.id).toBe(childRunId);
  }, 45_000);
});

// ── C-04: two-parent-process contention on one child ────────────────────────

/** Wait for `file` to exist, polling via Atomics.wait so no macrotask/timer scheduling is involved (mirrors tests/integration/storage/child-run-publication.test.ts's own C-09 helper). */
function waitForFile(file: string, timeoutMs = 8_000): void {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(file) && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
  if (!fs.existsSync(file)) throw new Error(`Timed out waiting for ${file}`);
}

/**
 * A worker script that opens its OWN bun:sqlite connection to the SAME
 * state.db file and calls the real, production `publishChildWorkflowRun` —
 * the tests/integration/storage/child-run-publication.test.ts C-09
 * technique, duplicated here per this repo's test-file self-containment
 * convention (that file exports nothing). Mirrors openStateDatabase's own
 * busy_timeout so a genuinely concurrent BEGIN IMMEDIATE blocks and retries
 * instead of failing outright — see that file's header for why a bare
 * file-polling handshake alone would NOT force a genuine overlap.
 */
function buildConcurrentPublisherWorkerScript(options: {
  databaseModulePath: string;
  repositoryModulePath: string;
  dbPath: string;
  readyFile: string;
  resultFile: string;
  input: PublishChildWorkflowRunInput;
}): string {
  return `
import { openDatabase } from ${JSON.stringify(options.databaseModulePath)};
import { WorkflowRunsRepository } from ${JSON.stringify(options.repositoryModulePath)};
import { writeFileSync } from "node:fs";

const db = openDatabase(${JSON.stringify(options.dbPath)});
try {
  db.exec("PRAGMA busy_timeout = 30000");
  const repo = new WorkflowRunsRepository(db);
  writeFileSync(${JSON.stringify(options.readyFile)}, "ready");
  const row = repo.publishChildWorkflowRun(${JSON.stringify(options.input)});
  writeFileSync(${JSON.stringify(options.resultFile)}, JSON.stringify({ ok: true, id: row.id }));
} catch (error) {
  writeFileSync(
    ${JSON.stringify(options.resultFile)},
    JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }),
  );
} finally {
  db.close();
}
`;
}

describe("two-parent-process contention on one child (C-04)", () => {
  test("two genuinely concurrent publishers racing the identical (parentRunId, invocationKey) converge on one child row, one workflow_started event, and the same returned id (the SELECT-else-INSERT race half; B-N16)", async () => {
    writeProgram(storage.stashDir, "c04-race-leaf", CHILD_LEAF_WF);
    writeComposingParent(storage.stashDir, "c04-race-parent", "workflows/c04-race-leaf");
    const started = await startWorkflowRun("workflows/c04-race-parent", {});
    const parentRunId = started.run.id;

    // Derive exactly what the engine's own dispatch seam independently
    // derives for the composing unit (spec §3.3 steps 1-3) — the SAME
    // (parentRunId, invocationKey) pair two genuinely concurrent processes
    // reaching this composing step would each compute on their own, with no
    // coordination between them.
    const parentRow = await withWorkflowRunsRepo((repo) => repo.getRunById(parentRunId));
    const plan = decodeWorkflowPlanV4(JSON.parse(parentRow?.plan_json ?? "null"));
    const composingStep = plan.steps[0]!;
    const root = composingStep.root;
    if (!root) throw new Error("composing step must have a root");
    const target = root.kind === "map" ? root.template.frozenTarget : root.frozenTarget;
    if (target.kind !== "child-workflow") throw new Error(`expected a child-workflow target, got ${target.kind}`);

    const work = computeStepWorkList(composingStep, { runId: parentRunId, params: {}, stepOutputs: {} });
    if (!work.ok) throw new Error(work.error);
    const composingUnit = work.list.units[0]!;

    const invocationKey = computeChildInvocationKey({
      parentRunId,
      parentUnitId: composingUnit.journalBaseId,
      unitInputHash: composingUnit.inputHash,
    });

    const now = new Date().toISOString();
    const mainCandidateId = "c0400000-0000-4000-8000-000000000201";
    const workerCandidateId = "c0400000-0000-4000-8000-000000000202";
    const buildPublishInput = (childRunId: string): PublishChildWorkflowRunInput => ({
      parentRunId,
      spawnedByUnitId: composingUnit.journalBaseId,
      invocationKey,
      run: {
        id: childRunId,
        workflowRef: target.ref,
        scopeKey: parentRow?.scope_key ?? null,
        workflowEntryId: null,
        workflowTitle: target.frozenPlan.title,
        paramsJson: "{}",
        currentStepId: target.frozenPlan.steps[0]?.stepId ?? null,
        createdAt: now,
        updatedAt: now,
        agentHarness: parentRow?.agent_harness ?? null,
        agentSessionId: parentRow?.agent_session_id ?? null,
      },
      steps: frozenStepRows(target.frozenPlan).map((step) => ({ runId: childRunId, ...step })),
      planJson: canonicalPlanJson(target.frozenPlan),
      planHash: target.planHash,
    });

    const dbPath = getStateDbPath();
    const mainDb = openStateDatabase(dbPath);
    try {
      const mainRepo = new WorkflowRunsRepository(mainDb);

      const readyFile = path.join(storage.root, "c04-race-ready");
      const resultFile = path.join(storage.root, "c04-race-result.json");
      const workerScript = path.join(storage.root, "c04-race-worker.mts");
      fs.writeFileSync(
        workerScript,
        buildConcurrentPublisherWorkerScript({
          databaseModulePath: path.resolve(import.meta.dir, "../../../src/storage/database.ts"),
          repositoryModulePath: path.resolve(
            import.meta.dir,
            "../../../src/storage/repositories/workflow-runs-repository.ts",
          ),
          dbPath,
          readyFile,
          resultFile,
          input: buildPublishInput(workerCandidateId),
        }),
        "utf8",
      );

      // Force a GENUINE overlap rather than racing on file-poll timing alone
      // (the child-run-publication.test.ts C-09 technique, reused verbatim):
      // take the write lock on a raw transaction BEFORE the worker can
      // possibly attempt its own publish, so the worker's own BEGIN
      // IMMEDIATE (inside its publishChildWorkflowRun call) is guaranteed to
      // block against a real reserved lock — never a pre-decided sequential
      // read. Release, then immediately race main's OWN publish attempt for
      // the identical (parentRunId, invocationKey) pair.
      mainDb.exec("BEGIN IMMEDIATE");

      const worker = new Worker(pathToFileURL(workerScript));
      let workerError = "";
      const workerExit = new Promise<number>((resolve) => {
        worker.once("exit", (code) => resolve(code));
        worker.once("error", (error) => {
          workerError = error.message;
        });
      });

      // Confirm the worker's own connection is open and it has reached (or
      // is immediately about to reach) its own publish call, which must now
      // be blocked against the lock just taken above.
      waitForFile(readyFile);
      // Deterministic pause: give the worker's blocked BEGIN IMMEDIATE time
      // to actually register against the held lock before releasing it —
      // same margin as the C-09 precedent.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
      mainDb.exec("COMMIT");

      let mainThrew: unknown;
      let mainRow: WorkflowRunRow | undefined;
      try {
        mainRow = mainRepo.publishChildWorkflowRun(buildPublishInput(mainCandidateId));
      } catch (error) {
        mainThrew = error;
      }

      const exitCode = await Promise.race([
        workerExit,
        new Promise<number>((_resolve, reject) =>
          setTimeout(() => reject(new Error("concurrent child publisher timed out")), 15_000),
        ),
      ]);
      expect(workerError).toBe("");
      expect(exitCode).toBe(0);
      const workerResult = JSON.parse(fs.readFileSync(resultFile, "utf8")) as {
        ok: boolean;
        id?: string;
        error?: string;
      };

      // Neither publisher throws, and neither surfaces the other's
      // unique-index conflict directly — the SELECT-else-INSERT race
      // resolves cleanly to one committed winner.
      expect(mainThrew).toBeUndefined();
      expect(workerResult.ok).toBe(true);
      if (!mainRow) throw new Error("expected the main publisher to return a row");

      // Both publishers agree on exactly one winner, whichever candidate id it is.
      expect([mainCandidateId, workerCandidateId]).toContain(mainRow.id);
      expect(workerResult.id).toBe(mainRow.id);

      const children = mainRepo.childRunsOf(parentRunId);
      expect(children).toHaveLength(1);
      expect(children[0]?.id).toBe(mainRow.id);

      const startedEventsForChild = readStateEvents(mainDb, { type: "workflow_started" }).events.filter(
        (event) => event.metadata?.runId === mainRow.id,
      ).length;
      expect(startedEventsForChild).toBe(1);
    } finally {
      mainDb.close();
    }
  }, 20_000);

  test("a live foreign lock on the pre-published child refuses the parent's real drive up front; a later resume (foreign lock released) converges on the SAME child", async () => {
    writeProgram(storage.stashDir, "c04-leaf", CHILD_LEAF_WF);
    writeComposingParent(storage.stashDir, "c04-parent", "workflows/c04-leaf");
    const started = await startWorkflowRun("workflows/c04-parent", {});
    const parentRunId = started.run.id;

    // Compute exactly what the engine's own dispatch seam will independently
    // derive for the composing unit (spec §3.3 steps 1-2), then pre-publish +
    // pre-lock the child directly — one level down at the CHILD row.
    const parentRow = await withWorkflowRunsRepo((repo) => repo.getRunById(parentRunId));
    const plan = decodeWorkflowPlanV4(JSON.parse(parentRow?.plan_json ?? "null"));
    const composingStep = plan.steps[0]!;
    const root = composingStep.root;
    if (!root) throw new Error("composing step must have a root");
    const target = root.kind === "map" ? root.template.frozenTarget : root.frozenTarget;
    if (target.kind !== "child-workflow") throw new Error(`expected a child-workflow target, got ${target.kind}`);

    const work = computeStepWorkList(composingStep, { runId: parentRunId, params: {}, stepOutputs: {} });
    if (!work.ok) throw new Error(work.error);
    const composingUnit = work.list.units[0]!;

    const invocationKey = computeChildInvocationKey({
      parentRunId,
      parentUnitId: composingUnit.journalBaseId,
      unitInputHash: composingUnit.inputHash,
    });

    const now = new Date().toISOString();
    const childRunId = "c0400000-0000-4000-8000-000000000001";
    const seeded = await withWorkflowRunsRepo((repo) =>
      repo.publishChildWorkflowRun({
        parentRunId,
        spawnedByUnitId: composingUnit.journalBaseId,
        invocationKey,
        run: {
          id: childRunId,
          workflowRef: target.ref,
          scopeKey: parentRow?.scope_key ?? null,
          workflowEntryId: null,
          workflowTitle: target.frozenPlan.title,
          paramsJson: "{}",
          currentStepId: target.frozenPlan.steps[0]?.stepId ?? null,
          createdAt: now,
          updatedAt: now,
          agentHarness: parentRow?.agent_harness ?? null,
          agentSessionId: parentRow?.agent_session_id ?? null,
        },
        steps: frozenStepRows(target.frozenPlan).map((step) => ({ runId: childRunId, ...step })),
        planJson: canonicalPlanJson(target.frozenPlan),
        planHash: target.planHash,
      }),
    );
    expect(seeded.id).toBe(childRunId);
    expect(computePlanHash(target.frozenPlan)).toBe(target.planHash);

    // Another live process already holds the child's own run lock.
    const releaseForeignLock = plantRunLock(childRunId);

    // The parent's own (real, unheld) drive now reaches the composing step,
    // idempotently re-finds the pre-seeded child (never a second child row,
    // never a second workflow_started event), and must be refused the
    // child's lock rather than stealing it or double-driving.
    const dispatchedFirstAttempt = new Set<string>();
    const result = await runWorkflowSteps({
      target: parentRunId,
      summaryJudge: null,
      dispatcher: async (): Promise<UnitDispatchResult> => {
        dispatchedFirstAttempt.add("leaf-unit-was-dispatched");
        return { ok: true, text: "leaf work" };
      },
    });
    expect(result.run.status).toBe("failed");
    const composingReport = result.executed.find((e) => e.stepId === "dispatch");
    expect(composingReport?.ok).toBe(false);
    expect(composingReport?.summary).toContain(`pid ${process.pid}`);
    // The lock refusal happens before any child unit ever reaches the
    // dispatcher — the busy child is never driven.
    expect(dispatchedFirstAttempt.size).toBe(0);

    const composingRow = await withWorkflowRunsRepo((repo) => repo.getUnit(parentRunId, composingUnit.journalBaseId));
    expect(composingRow?.failure_reason).toBe("child_workflow_busy");

    // Exactly one child row exists — the loser never published a second one.
    const childrenAfterBusy = await withWorkflowRunsRepo((repo) => repo.childRunsOf(parentRunId));
    expect(childrenAfterBusy).toHaveLength(1);
    expect(childrenAfterBusy[0]?.id).toBe(childRunId);

    // Release the foreign lock and resume: the SAME child converges, this
    // time driven for real.
    releaseForeignLock();
    await resumeWorkflowRun(parentRunId);
    const finalResult = await runWorkflowSteps({
      target: parentRunId,
      summaryJudge: null,
      dispatcher: async (): Promise<UnitDispatchResult> => ({ ok: true, text: "leaf work" }),
    });
    expect(finalResult.run.status).toBe("completed");

    const finalChildren = await withWorkflowRunsRepo((repo) => repo.childRunsOf(parentRunId));
    expect(finalChildren).toHaveLength(1);
    expect(finalChildren[0]?.id).toBe(childRunId);
    expect(finalChildren[0]?.status).toBe("completed");
  });
});
